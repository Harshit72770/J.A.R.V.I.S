/**
 * J.A.R.V.I.S — Browser Control Tool
 * ===================================
 * The Node equivalent of the requested tools/browser_control.py.
 * Controlled functions (and only these — see ACTIONS):
 *   newTab(url) · googleSearch(query) · back() · forward()
 *   refresh() · current() · closeTab()
 *
 * Implementation: puppeteer-core driving the Chrome/Edge already installed
 * on this machine — free, open source, no API key, 100% local. One visible
 * browser window is launched lazily and kept alive for the lifetime of the
 * bridge, so tabs and history persist between voice commands.
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

const ACTIONS = [
  'newTab',
  'googleSearch',
  'back',
  'forward',
  'refresh',
  'current',
  'closeTab',
];

const NAV_TIMEOUT = 15000;
const MAX_QUERY = 200;
const MAX_URL = 2048;

let puppeteer = null; // null = not tried yet, false = could not load
let browserPromise = null;
let lastPage = null;

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

function loadPuppeteer() {
  if (puppeteer !== null) return puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch (e) {
    puppeteer = false;
  }
  return puppeteer;
}

// One shared window per bridge process → §12 browser persistence.
async function ensureBrowser() {
  const pp = loadPuppeteer();
  if (!pp) return null;
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.isConnected()) return b;
    } catch (e) {
      /* fall through → relaunch */
    }
    browserPromise = null;
  }
  const exe = findBrowserExe();
  if (!exe) return null;
  browserPromise = pp.launch({
    executablePath: exe,
    headless: false,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--window-size=1280,860',
    ],
  });
  try {
    return await browserPromise;
  } catch (e) {
    browserPromise = null;
    return null;
  }
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

// The tab the next navigation command applies to (most recently opened).
async function livePage() {
  const b = await ensureBrowser();
  if (!b) return { error: 'unavailable' };
  if (lastPage && !lastPage.isClosed()) return { browser: b, page: lastPage };
  const pages = await b.pages();
  if (pages.length) {
    lastPage = pages[pages.length - 1];
    return { browser: b, page: lastPage };
  }
  return { error: 'notabs' }; // window closed → handled per action
}

async function newTab(target) {
  const url = validateUrl(target);
  if (!url) {
    // Invalid URL: never fall back to another opener either — safety first.
    return { ok: false, error: 'That is not a valid http/https link.' };
  }
  const b = await ensureBrowser();
  if (!b) {
    return {
      ok: false,
      fallback: true,
      error: 'No controllable browser is available (install Chrome or Edge).',
    };
  }
  let page;
  try {
    page = await b.newPage();
  } catch (e) {
    return { ok: false, fallback: true, error: 'Could not open a new tab.' };
  }
  lastPage = page;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  } catch (e) {
    return {
      ok: false,
      error: 'That website did not load — it may be unreachable right now.',
      opened: url,
    };
  }
  let title = '';
  try {
    title = await page.title();
  } catch (e) {
    /* title is informational only */
  }
  return { ok: true, opened: url, title, via: 'jarvis-browser' };
}

async function googleSearch(queryRaw) {
  const q = String(queryRaw || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY);
  if (!q) return { ok: false, error: 'The search query was empty.' };
  return newTab(
    `https://www.google.com/search?q=${encodeURIComponent(q)}`
  );
}

async function historyStep(delta) {
  const lp = await livePage();
  if (lp.error) {
    return {
      ok: false,
      fallback: true,
      error: 'The controlled browser window is not open.',
    };
  }
  const before = lp.page.url();
  try {
    if (delta < 0) await lp.page.goBack({ timeout: 8000 });
    else await lp.page.goForward({ timeout: 8000 });
  } catch (e) {
    /* cross-origin/abort noise — decided below by comparing URLs */
  }
  const after = lp.page.url();
  if (after === before) {
    return {
      ok: false,
      error:
        delta < 0
          ? 'There is no previous page in this tab.'
          : 'There is no next page in this tab.',
    };
  }
  return { ok: true, url: after };
}

async function refresh() {
  const lp = await livePage();
  if (lp.error) {
    return {
      ok: false,
      fallback: true,
      error: 'The controlled browser window is not open.',
    };
  }
  try {
    await lp.page.reload({ timeout: NAV_TIMEOUT });
    return { ok: true, url: lp.page.url() };
  } catch (e) {
    return { ok: false, error: 'The page could not be reloaded.' };
  }
}

async function current() {
  const lp = await livePage();
  if (lp.error) {
    return {
      ok: false,
      fallback: true,
      error: 'The controlled browser window is not open.',
    };
  }
  let title = '';
  try {
    title = await lp.page.title();
  } catch (e) {
    /* ignore */
  }
  return { ok: true, url: lp.page.url(), title };
}

async function closeTab() {
  const b = await ensureBrowser();
  if (!b) {
    return {
      ok: false,
      fallback: true,
      error: 'The controlled browser window is not open.',
    };
  }
  const lp = await livePage();
  if (lp.error) {
    return { ok: false, error: 'The controlled browser window is not open.' };
  }
  const pages = await b.pages();
  if (pages.length <= 1) {
    return { ok: false, error: 'That is the only open tab.' };
  }
  await lp.page.close();
  try {
    const remaining = await b.pages();
    lastPage = remaining.length ? remaining[remaining.length - 1] : null;
  } catch (e) {
    lastPage = null;
  }
  return { ok: true };
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

module.exports = { exec, ACTIONS };
