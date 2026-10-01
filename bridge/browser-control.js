/**
 * J.A.R.V.I.S — Browser Control Tool
 * ===================================
 * Controlled functions (and only these — see ACTIONS):
 *   newTab(url) · googleSearch(query) · back() · forward()
 *   refresh() · current() · closeTab()
 *
 * SESSION-REUSE implementation (no puppeteer, no CDP, no debug port):
 *  - Chrome already running  → we NEVER launch a second Chrome process or
 *    window. `chrome.exe <url>` goes through Chrome's singleton, which
 *    forwards the URL into the EXISTING session as a new tab of the current
 *    window. A duplicate window is structurally impossible.
 *  - Chrome not running      → a plain `chrome.exe <url>` starts it once
 *    (normal singleton launch, default profile).
 *  - Every read/back/forward/reload/close runs through a resident Windows
 *    UI Automation worker (bridge/ui-worker.ps1): JSON-lines protocol with
 *    the same lifecycle as media-worker.ps1 — spawned on demand, killed
 *    after 2 minutes idle, replies matched by request id.
 *
 * Because we drive the user's real, logged-in profile session, music and
 * navigation work against their own tabs (fixes the googlevideo 403 a fresh
 * puppeteer profile always got).
 *
 * Safety (no unrestricted shell / browser execution):
 *  - only well-formed http/https URLs are ever opened (validated, capped);
 *  - exec() dispatches a fixed whitelist — nothing else is reachable;
 *  - no user-supplied string ever reaches a shell or an eval.
 *
 * Every function resolves to { ok, ... } and NEVER throws: a browser or
 * search failure must not crash the bridge or J.A.R.V.I.S.
 * `fallback: true` means "automation unavailable" — the caller may retry
 * through the ordinary link opener.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ACTIONS = [
  'newTab',
  'googleSearch',
  'back',
  'forward',
  'refresh',
  'current',
  'closeTab',
];

const MAX_QUERY = 200;
const MAX_URL = 2048;

// The exact sentence spoken when Google demands human verification.
// Detection only — we never solve, bypass or retry a CAPTCHA.
const CAPTCHA_MESSAGE =
  "Google is asking for human verification, so I can't continue the automated Google search.";

const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch (e) {
    return false;
  }
};

function findBrowserExe() {
  const roots = [
    process.env.LOCALAPPDATA,
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
  ].filter(Boolean);
  const candidates = [];
  for (const r of roots) {
    candidates.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return candidates.find(exists) || null;
}

// http/https only, no whitespace, length-capped — never javascript:/data:/file:
function validateUrl(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > MAX_URL) return null;
  if (/\s/.test(s)) return null;
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return u.href;
}

// ── Open a URL in the user's OWN Chrome session ────────────────────────────
// chrome.exe <url> is Chrome's own singleton handshake: if a session is
// already running the URL is handed to it (new tab, same window) and this
// short-lived process exits; if none is running this one *is* the session.
// We never pass --user-data-dir or --remote-debugging-port, so we can never
// end up next to the user's window — there is only ever one session.
function openExternal(url) {
  const exe = findBrowserExe();
  if (!exe) {
    return {
      ok: false,
      fallback: true,
      error: 'No controllable browser is available (install Chrome or Edge).',
    };
  }
  try {
    const child = spawn(exe, [url], {
      stdio: 'ignore',
      windowsHide: false,
      detached: true,
    });
    child.on('error', () => {}); // spawn failure surfaces via findUrl timeout
    try {
      child.unref();
    } catch (e) {
      /* noop */
    }
    return { ok: true, opened: url };
  } catch (e) {
    return { ok: false, fallback: true, error: 'Could not open a browser tab.' };
  }
}

// ── UI Automation worker lifecycle (media-worker pattern) ──────────────────
const UI_IDLE_MS = 2 * 60 * 1000;
const UI_TIMEOUT_MS = 15000;
let uiWorker = null;
let uiIdleTimer = null;
let uiSeq = 1;
let uiBuffer = '';
const uiWaiters = new Map();

const stopUiWorker = () => {
  if (uiIdleTimer) {
    clearTimeout(uiIdleTimer);
    uiIdleTimer = null;
  }
  uiBuffer = '';
  const waiters = [...uiWaiters.values()];
  uiWaiters.clear();
  waiters.forEach((w) => {
    clearTimeout(w.timer);
    w.reject(new Error('UI worker stopped.'));
  });
  if (uiWorker) {
    try {
      uiWorker.kill();
    } catch (e) {
      /* noop */
    }
    uiWorker = null;
  }
};

const armUiIdle = () => {
  if (uiIdleTimer) clearTimeout(uiIdleTimer);
  uiIdleTimer = setTimeout(stopUiWorker, UI_IDLE_MS);
};

const ensureUiWorker = () => {
  if (uiWorker) {
    armUiIdle();
    return uiWorker;
  }
  if (process.platform !== 'win32') {
    throw new Error('Browser control needs Windows.');
  }

  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'ui-worker.ps1'),
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  uiWorker = child;
  uiBuffer = '';
  armUiIdle();

  child.on('error', () => {
    if (uiWorker === child) stopUiWorker();
  });
  child.on('exit', () => {
    if (uiWorker !== child) return;
    uiWorker = null;
    uiBuffer = '';
    const waiters = [...uiWaiters.values()];
    uiWaiters.clear();
    waiters.forEach((w) => {
      clearTimeout(w.timer);
      w.reject(new Error('UI worker exited.'));
    });
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    uiBuffer += chunk;
    let idx;
    while ((idx = uiBuffer.indexOf('\n')) >= 0) {
      const line = uiBuffer.slice(0, idx).trim();
      uiBuffer = uiBuffer.slice(idx + 1);
      if (!line) continue;
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        continue; // non-JSON noise — the real reply is a JSON line
      }
      const waiter = uiWaiters.get(msg.id);
      if (!waiter) continue;
      uiWaiters.delete(msg.id);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  });
  // Compile noise lands on stderr — real failures come back as JSON replies.
  child.stderr.on('data', () => {});

  return child;
};

/**
 * Send one op to the UI worker. Rejects on timeout / worker death — callers
 * map that to the same failure strings the old implementation used.
 */
function uiOp(op, args = {}, timeoutMs = UI_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = ensureUiWorker();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const id = uiSeq++;
    const timer = setTimeout(() => {
      uiWaiters.delete(id);
      reject(new Error('UI worker timed out.'));
    }, timeoutMs);
    uiWaiters.set(id, { resolve, reject, timer });
    armUiIdle();
    try {
      child.stdin.write(
        JSON.stringify({ id, op, ...args }) + '\n',
        'utf8'
      );
    } catch (e) {
      uiWaiters.delete(id);
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

// ── Confirm a URL actually landed in the session ───────────────────────────
// Polls the worker's findUrl (reads every Chrome window's address bar) until
// the URL shows up or the deadline passes. `captcha:true` also scans for a
// Google /sorry/ redirect — detection only, never solved or retried.
async function findUrl(url, opts = {}, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let r = null;
    try {
      r = await uiOp('findUrl', { url, captchaSearch: !!opts.captcha });
    } catch (e) {
      r = null;
    }
    if (r && r.ok) {
      if (r.captcha) return { found: false, captcha: true, title: r.title || '', hwnd: r.hwnd };
      if (r.found) return { found: true, captcha: false, title: r.title || '', hwnd: r.hwnd };
    }
    if (Date.now() >= deadline) {
      return { found: false, captcha: false, title: '', hwnd: null };
    }
    await new Promise((res) => setTimeout(res, 300));
  }
}

// ── ACTIONS ────────────────────────────────────────────────────────────────
async function newTab(target) {
  const url = validateUrl(target);
  if (!url) {
    // Invalid URL: never fall back to another opener either — safety first.
    return { ok: false, error: 'That is not a valid http/https link.' };
  }
  const opened = openExternal(url);
  if (!opened.ok) return opened; // no browser / spawn failure → caller may fall back
  const seen = await findUrl(url, {}, 6000);
  if (!seen.found) {
    return {
      ok: false,
      error: 'That website did not load — it may be unreachable right now.',
      opened: url,
    };
  }
  return { ok: true, opened: url, title: seen.title || '', via: 'jarvis-browser' };
}

async function googleSearch(queryRaw) {
  const q = String(queryRaw || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY);
  if (!q) return { ok: false, error: 'The search query was empty.' };
  const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  const opened = openExternal(url);
  if (!opened.ok) return opened;
  const seen = await findUrl(url, { captcha: true }, 7000);
  // ── CAPTCHA: detect and STOP GRACEFULLY ────────────────────────────────
  // Google sometimes flags automated traffic with a reCAPTCHA/"unusual
  // traffic" page. We do NOT solve it, bypass it, or retry — we tell the
  // user and stop (the tab is left open so the human can act).
  if (seen.captcha) {
    return {
      ok: false,
      captcha: true,
      fallback: false, // ← must NOT fall back to another Google tab (retry)
      error: CAPTCHA_MESSAGE,
      opened: url,
    };
  }
  if (!seen.found) {
    return {
      ok: false,
      error: 'That website did not load — it may be unreachable right now.',
      opened: url,
    };
  }
  return { ok: true, opened: url, title: seen.title || '', via: 'jarvis-browser' };
}

const NO_WINDOW = 'The controlled browser window is not open.';

async function historyStep(delta) {
  let r = null;
  try {
    r = await uiOp('toolbar', { action: delta < 0 ? 'back' : 'forward' });
  } catch (e) {
    r = null;
  }
  if (!r || !r.ok) {
    if (r && (r.code === 'disabled' || r.code === 'nobutton')) {
      return {
        ok: false,
        error:
          delta < 0
            ? 'There is no previous page in this tab.'
            : 'There is no next page in this tab.',
      };
    }
    return { ok: false, fallback: true, error: NO_WINDOW };
  }
  if (r.moved === false) {
    return {
      ok: false,
      error:
        delta < 0
          ? 'There is no previous page in this tab.'
          : 'There is no next page in this tab.',
    };
  }
  return { ok: true, url: r.url || '' };
}

async function refresh() {
  let r = null;
  try {
    r = await uiOp('toolbar', { action: 'reload' });
  } catch (e) {
    r = null;
  }
  if (r && r.ok) return { ok: true, url: r.url || '' };
  if (r && (r.code === 'disabled' || r.code === 'nobutton')) {
    return { ok: false, error: 'The page could not be reloaded.' };
  }
  return { ok: false, fallback: true, error: NO_WINDOW };
}

async function current() {
  let r = null;
  try {
    r = await uiOp('toolbar', { action: 'current' });
  } catch (e) {
    r = null;
  }
  if (!r || !r.ok) return { ok: false, fallback: true, error: NO_WINDOW };
  return { ok: true, url: r.url || '', title: r.title || '' };
}

async function closeTab() {
  let r = null;
  try {
    r = await uiOp('toolbar', { action: 'close' });
  } catch (e) {
    r = null;
  }
  if (r && r.ok) return { ok: true };
  if (r && r.code === 'onlytab') return { ok: false, error: 'That is the only open tab.' };
  if (r && (r.code === 'nowindow' || r.code === 'notab')) {
    return { ok: false, fallback: true, error: NO_WINDOW };
  }
  if (r && (r.code === 'nobutton' || r.code === 'invokefail')) {
    return { ok: false, error: 'That tab could not be closed.' };
  }
  return { ok: false, fallback: true, error: NO_WINDOW };
}

/**
 * Run one whitelisted browser action. Never throws.
 */
async function exec(action, args = {}) {
  try {
    switch (action) {
      case 'newTab':
        return await newTab(args.url);
      case 'googleSearch':
        return await googleSearch(args.query);
      case 'back':
        return await historyStep(-1);
      case 'forward':
        return await historyStep(1);
      case 'refresh':
        return await refresh();
      case 'current':
        return await current();
      case 'closeTab':
        return await closeTab();
      default:
        return { ok: false, error: `Unknown browser action: ${action}.` };
    }
  } catch (e) {
    return {
      ok: false,
      fallback: true,
      error: `Browser control failed: ${(e && e.message) || e}`,
    };
  }
}

// ── Shared session API for bridge/music-control.js ─────────────────────────
// The music tool drives THIS SAME user session (one browser, one player, one
// audio stream — never a second Chrome). It reaches only these primitives;
// the HTTP whitelist (ACTIONS) stays unchanged. Note: uiOp/findUrl never
// launch anything — a state read with no Chrome running simply reports
// chrome:false (GET /music must never pop a window open by itself).
const session = {
  openExternal, // (url) → {ok, opened} | {ok:false, fallback, error}
  findUrl,      // async (url, {captcha}) → {found, captcha, title, hwnd}
  uiOp,         // async (op, args, timeoutMs) → worker reply (throws on death/timeout)
  hasBrowserExe: () => !!findBrowserExe(),
  CAPTCHA_MESSAGE,
};

module.exports = { exec, ACTIONS, session };
