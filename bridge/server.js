/**
 * J.A.R.V.I.S Desktop Bridge
 * ===========================
 * A tiny, zero-dependency local server that lets the J.A.R.V.I.S web HUD
 * control this computer: open apps, files, folders and browser tabs.
 *
 * Start : double-click  bridge\bridge-start.bat   (or run `npm run bridge`)
 * Stop  : close the window / Ctrl+C
 * Scope : 127.0.0.1 only — never reachable from other machines.
 *
 * Endpoints:
 *   GET /health
 *   GET /open?kind=url|app|file|folder|find&target=<value>
 *   GET /search?q=<query>                 → free web research (DuckDuckGo)
 *   GET /ytsearch?q=<query>               → free YouTube results (context)
 *   POST /browser {action, url?, query?}  → controlled browser functions
 *   GET /music                            → real YouTube player state
 *   POST /music {action, ...}             → controlled music tool functions
 *
 * Launching rules that matter on Windows:
 *  - Never wait for a program to exit (notepad.exe runs for hours).
 *  - Never let `cmd start` run something that does not exist: it throws up a
 *    modal "Windows cannot find…" dialog and blocks the request forever.
 *    So every target is resolved first (PATH → App Paths → Start Menu).
 */

const http = require('http');
const https = require('https');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Free web research + controlled browser (both zero-dependency Node — the
// browser tool drives the user's own Chrome session via a UIA worker).
const { searchWeb, searchYouTube } = require('./web-search.js');
const browserControl = require('./browser-control.js');
const musicControl = require('./music-control.js');

const PORT = 4777;
const HOST = '127.0.0.1';
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── Shell safety ───────────────────────────────────────────────────────────
// Only meaningful for the few calls that go through `cmd /c start`; everything
// else is spawned with an argument array (no shell involved at all).
const stripShellMeta = (value) =>
  String(value || '')
    .replace(/[&|<>^%"`\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

const isHttpUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
};

const ok = (payload) => ({ ok: true, ...payload });
const fail = (error) => ({ ok: false, error });

const exists = (p) => {
  try {
    return !!p && fs.existsSync(p);
  } catch (e) {
    return false;
  }
};

const isDirectory = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
};

// Console utility we DO wait for (reg query): its output is the answer, and
// it never hands its pipes to a GUI child process.
const run = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: 10000 },
      (error, stdout, stderr) => {
        resolve({ error, out: `${stdout || ''}${stderr || ''}` });
      }
    );
  });

// Start a program and answer as soon as it exists. We deliberately do not
// wait for its exit code — a GUI app stays alive for as long as it is open.
const launch = (file, args = []) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
      resolve({ error: e });
      return;
    }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(safety);
      resolve({ error });
    };
    const safety = setTimeout(() => finish(null), 5000);
    child.once('spawn', () => finish(null));
    child.once('error', (err) => finish(err));
  });

// ─── Finding programs ───────────────────────────────────────────────────────
const PATH_DIRS = String(process.env.PATH || '')
  .split(path.delimiter)
  .filter(Boolean);
const PATHEXT = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
  .split(';')
  .filter(Boolean);

function findOnPath(name) {
  const hasExt = /\.(exe|com|bat|cmd)$/i.test(name);
  const exts = hasExt ? [''] : PATHEXT;
  for (const dir of PATH_DIRS) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

// App Paths registry — covers installed programs that are not on PATH
// (winword, excel, msedge, …).
async function findAppPathRegistry(name) {
  if (!IS_WIN) return null;
  const exe = /\.(exe|com|bat|cmd)$/i.test(name) ? name : `${name}.exe`;
  const keys = [
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
  ];
  for (const key of keys) {
    // eslint-disable-next-line no-await-in-loop
    const r = await run('reg.exe', ['query', key, '/ve']);
    if (r.error) continue;
    const m = r.out.match(/REG_SZ\s+(.+?)\s*$/im);
    if (m) {
      const target = m[1].trim().replace(/^"|"$/g, '');
      if (exists(target)) return target;
    }
  }
  return null;
}

const START_MENU_DIRS = [
  process.env.APPDATA &&
    path.join(
      process.env.APPDATA,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs'
    ),
  process.env.ProgramData &&
    path.join(
      process.env.ProgramData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs'
    ),
].filter((d) => d && exists(d));

// Start Menu shortcuts — this is how Spotify/VS Code/any installed app that
// is neither on PATH nor in App Paths still opens by name.
function findStartMenuShortcut(name) {
  const query = name.toLowerCase().replace(/\.[a-z0-9]+$/, '');
  if (!query) return null;
  let best = null;
  let bestScore = 0;

  const walk = (dir, depth) => {
    if (depth > 5 || bestScore >= 100) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!/\.lnk$/i.test(entry.name)) continue;
      const base = entry.name.replace(/\.lnk$/i, '').toLowerCase();
      let score = 0;
      if (base === query) score = 100;
      else if (base.startsWith(query)) score = 80;
      else if (base.includes(query)) score = 55;
      if (score > bestScore) {
        bestScore = score;
        best = full;
      }
    }
  };

  START_MENU_DIRS.forEach((dir) => walk(dir, 0));
  return best;
}

// PATH → App Paths → Start Menu, returning something `launch` can run.
async function resolveApp(name) {
  const clean = stripShellMeta(name);
  if (!clean) return null;

  if (/[\\/]/.test(clean) && exists(clean)) {
    return exists(clean) && isDirectory(clean)
      ? { opener: IS_WIN ? 'explorer.exe' : IS_MAC ? 'open' : 'xdg-open', args: [clean] }
      : { opener: 'cmd.exe', args: ['/c', 'start', '', clean] };
  }

  const onPath = findOnPath(clean);
  if (onPath) return { opener: onPath, args: [] };

  const registered = await findAppPathRegistry(clean);
  if (registered) return { opener: registered, args: [] };

  const shortcut = findStartMenuShortcut(clean);
  if (shortcut) return { opener: 'cmd.exe', args: ['/c', 'start', '', shortcut] };

  return null;
}

function findChrome() {
  const roots = [
    process.env.LOCALAPPDATA,
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
  ].filter(Boolean);
  return (
    roots
      .map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      .find((p) => exists(p)) || null
  );
}

// ─── Openers ────────────────────────────────────────────────────────────────
async function openUrl(target) {
  if (!isHttpUrl(target)) return fail('Only http/https links can be opened.');
  const url = new URL(target).href;

  // Prefer Chrome explicitly — that is the browser J.A.R.V.I.S runs in.
  if (IS_WIN) {
    const chrome = findChrome();
    if (chrome) {
      const r = await launch(chrome, [url]);
      if (!r.error) return ok({ opened: url, via: 'chrome' });
    }
    // explorer understands URLs and, unlike `cmd start`, does not interpret
    // & or ? as shell syntax.
    const r = await launch('explorer.exe', [url]);
    if (!r.error) return ok({ opened: url, via: 'default-browser' });
    return fail('Could not open that link.');
  }

  const r = await launch(IS_MAC ? 'open' : 'xdg-open', [url]);
  return r.error ? fail('Could not open that link.') : ok({ opened: url });
}

async function openApp(target) {
  const name = stripShellMeta(target);
  if (!name) return fail('App name was empty.');

  const resolved = await resolveApp(name);
  if (!resolved) {
    return fail(`"${name}" was not found on this laptop.`);
  }
  const r = await launch(resolved.opener, resolved.args);
  if (r.error) return fail(`"${name}" could not be opened.`);
  return ok({ opened: name, via: 'resolved' });
}

const SHELL_FOLDERS = {
  'this pc': 'shell:MyComputerFolder',
  'my computer': 'shell:MyComputerFolder',
  computer: 'shell:MyComputerFolder',
  'recycle bin': 'shell:RecycleBinFolder',
  'control panel': 'shell:ControlPanelFolder',
  settings: 'ms-settings:',
  'windows settings': 'ms-settings:',
};

async function openFolder(target) {
  const key = stripShellMeta(target).toLowerCase();
  const shellTarget = SHELL_FOLDERS[key];
  const opener = IS_WIN ? 'explorer.exe' : IS_MAC ? 'open' : 'xdg-open';

  if (shellTarget) {
    const r = await launch(opener, [shellTarget]);
    return r.error ? fail(`Could not open ${target}.`) : ok({ opened: target });
  }

  const resolved = resolveExistingPath(target);
  if (!resolved) return fail(`Folder not found: ${target}`);
  const r = await launch(opener, [resolved]);
  return r.error ? fail(`Could not open ${target}.`) : ok({ opened: resolved });
}

async function openFile(target) {
  const resolved = resolveExistingPath(target);
  if (!resolved) return fail(`File not found: ${target}`);
  if (isDirectory(resolved)) return openFolder(resolved);

  if (IS_WIN) {
    const r = await launch('cmd.exe', ['/c', 'start', '', resolved]);
    return r.error
      ? fail(`Could not open ${resolved}`)
      : ok({ opened: resolved, via: 'default-app' });
  }
  const r = await launch(IS_MAC ? 'open' : 'xdg-open', [resolved]);
  return r.error
    ? fail(`Could not open ${resolved}`)
    : ok({ opened: resolved });
}

function resolveExistingPath(target) {
  const raw = String(target || '').trim();
  if (!raw) return null;
  const candidates = [
    raw,
    /^(home|user folder)$/i.test(raw) ? os.homedir() : null,
    path.join(os.homedir(), raw),
    path.join(os.homedir(), 'Desktop', raw),
    path.join(os.homedir(), 'Documents', raw),
    path.join(os.homedir(), 'Downloads', raw),
    path.join(os.homedir(), 'Pictures', raw),
    path.join(os.homedir(), 'Music', raw),
    path.join(os.homedir(), 'Videos', raw),
  ].filter(Boolean);
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}

// ─── "Open <file>" by name: search the usual folders ────────────────────────
const SEARCH_ROOTS = ['Desktop', 'Downloads', 'Documents', 'Pictures', 'Music', 'Videos']
  .map((d) => path.join(os.homedir(), d))
  .filter((p) => isDirectory(p));

const SKIP_DIRS = /^(appdata|node_modules|\.git|__pycache__|cache|\.cache)/i;

// Words people add around a filename that are not part of its name.
const NOISE_WORDS = new Set([
  'file',
  'files',
  'document',
  'documents',
  'my',
  'the',
  'open',
  'ka',
  'ki',
  'wala',
  'vala',
  'folder',
  'फ़ाइल',
  'फाइल',
  'डॉक्यूमेंट',
  'मेरा',
  'मेरी',
  'का',
  'की',
  'खोलो',
]);

function findBestMatch(query) {
  const q = String(query || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!q) return null;
  const qNoExt = q.replace(/\.[a-z0-9]+$/, '');
  const tokens = qNoExt
    .split(' ')
    .filter((t) => t.length >= 2 && !NOISE_WORDS.has(t));
  const effective = (tokens.length ? tokens.join(' ') : qNoExt).trim();
  if (!effective) return null;

  let best = null;
  let scanned = 0;
  const queue = SEARCH_ROOTS.map((dir) => ({ dir, depth: 0 }));

  while (queue.length && scanned < 8000) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      scanned += 1;
      if (scanned > 8000) break;
      const full = path.join(current.dir, entry.name);

      if (entry.isDirectory()) {
        if (
          current.depth < 4 &&
          !SKIP_DIRS.test(entry.name) &&
          !SKIP_DIRS.test(full)
        ) {
          queue.push({ dir: full, depth: current.depth + 1 });
        }
        continue;
      }

      const name = entry.name.toLowerCase();
      let score = 0;
      if (name === effective || name === qNoExt) score = 100;
      else if (name.startsWith(effective) || name.startsWith(qNoExt)) score = 85;
      else if (name.includes(effective)) score = 65;
      else if (tokens.length > 1 && tokens.every((t) => name.includes(t))) {
        // Multi-word names must contain EVERY word — opening the wrong file
        // is worse than reporting "not found".
        score = 75;
      }

      if (score > 0 && (!best || score > best.score)) {
        best = { path: full, name: entry.name, score };
      }
      if (best && best.score >= 100) return best;
    }
  }
  return best;
}

async function openBySearch(target) {
  const match = findBestMatch(target);
  if (!match) return fail(`No file matching "${target}" was found in your folders.`);
  const opened = await openFile(match.path);
  if (!opened.ok) return opened;
  return ok({ opened: match.path, matched: match.name, via: 'search' });
}

// ─── Groq proxy ─────────────────────────────────────────────────────────────
// The browser NEVER talks to Groq and never sees the API key. The HUD posts
// to POST /groq; this bridge attaches the key from the local .env file and
// streams Groq's answer straight back. That is what keeps the key out of the
// frontend bundle, out of localStorage and out of the Git repository.
const ENV_FILE = path.join(__dirname, '..', '.env');

// Minimal .env reader (KEY=value, # comments, optional quotes) — zero deps.
function loadEnvFile(file) {
  const out = {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch (e) {
    // No .env yet — environment variables still work.
  }
  return out;
}

// Read per request, so editing .env takes effect without a restart.
const groqKey = () => {
  const fromFile = loadEnvFile(ENV_FILE).GROQ_API_KEY || '';
  return process.env.GROQ_API_KEY || fromFile;
};

// Screenshots ride along base64-encoded, so vision requests are a few MB —
// allow that while still rejecting anything absurd.
const MAX_GROQ_BODY = 8 * 1024 * 1024;

function groqProxy(req, res, send) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  let upstream = null;

  const abortUpstream = () => {
    if (upstream && !upstream.destroyed) upstream.destroy();
  };
  // Client went away (barge-in / closed tab) — stop paying for the stream.
  res.on('close', abortUpstream);
  req.on('error', abortUpstream);

  req.on('data', (chunk) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > MAX_GROQ_BODY) {
      tooLarge = true;
      send(413, fail('Request body too large.'));
      abortUpstream();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (tooLarge) return;

    const key = groqKey();
    if (!key) {
      send(
        500,
        fail(
          'No Groq API key found — add GROQ_API_KEY=<your key> to the .env file in the project folder.'
        )
      );
      return;
    }

    const body = Buffer.concat(chunks);
    upstream = https.request(
      {
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'Content-Length': body.length,
        },
        timeout: 90000,
      },
      (up) => {
        // Pipe the response as-is: SSE (stream:true) or plain JSON.
        res.writeHead(up.statusCode || 502, {
          'Content-Type':
            up.headers['content-type'] || 'application/octet-stream',
          'Cache-Control': 'no-cache, no-transform',
          ...CORS,
        });
        up.pipe(res);
      }
    );

    upstream.on('timeout', () =>
      upstream.destroy(new Error('Groq request timed out.'))
    );
    upstream.on('error', (err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(502, fail(`Groq request failed: ${err.message}`));
    });
    upstream.end(body);
  });
}

// ─── Media worker: system volume + screen brightness ─────────────────────────
// Browsers cannot touch system audio or the panel backlight, so those commands
// run in a resident PowerShell worker (bridge/media-worker.ps1). It compiles
// the Core Audio interop once (~1.5s, first command only) and then answers in
// milliseconds; the bridge stops it after 2 minutes idle so it never sits in
// RAM doing nothing.
const MEDIA_IDLE_MS = 2 * 60 * 1000;
const MEDIA_TIMEOUT_MS = 10000;
let mediaWorker = null;
let mediaIdleTimer = null;
let mediaSeq = 1;
let mediaBuffer = '';
const mediaWaiters = new Map();

const stopMediaWorker = () => {
  if (mediaIdleTimer) {
    clearTimeout(mediaIdleTimer);
    mediaIdleTimer = null;
  }
  mediaBuffer = '';
  const waiters = [...mediaWaiters.values()];
  mediaWaiters.clear();
  waiters.forEach((w) => {
    clearTimeout(w.timer);
    w.reject(new Error('Media worker stopped.'));
  });
  if (mediaWorker) {
    try {
      mediaWorker.kill();
    } catch (e) {
      /* noop */
    }
    mediaWorker = null;
  }
};

const armMediaIdle = () => {
  if (mediaIdleTimer) clearTimeout(mediaIdleTimer);
  mediaIdleTimer = setTimeout(stopMediaWorker, MEDIA_IDLE_MS);
};

const ensureMediaWorker = () => {
  if (mediaWorker) {
    armMediaIdle();
    return mediaWorker;
  }
  if (!IS_WIN) throw new Error('Media control needs Windows.');

  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'media-worker.ps1'),
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  mediaWorker = child;
  mediaBuffer = '';
  armMediaIdle();

  child.on('error', () => {
    if (mediaWorker === child) stopMediaWorker();
  });
  child.on('exit', () => {
    if (mediaWorker !== child) return;
    mediaWorker = null;
    mediaBuffer = '';
    const waiters = [...mediaWaiters.values()];
    mediaWaiters.clear();
    waiters.forEach((w) => {
      clearTimeout(w.timer);
      w.reject(new Error('Media worker exited.'));
    });
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    mediaBuffer += chunk;
    let idx;
    while ((idx = mediaBuffer.indexOf('\n')) >= 0) {
      const line = mediaBuffer.slice(0, idx).trim();
      mediaBuffer = mediaBuffer.slice(idx + 1);
      if (!line) continue;
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        continue; // non-JSON noise — the real reply is a JSON line
      }
      const waiter = mediaWaiters.get(msg.id);
      if (!waiter) continue;
      mediaWaiters.delete(msg.id);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  });
  // Compile noise lands on stderr — real failures come back as JSON replies.
  child.stderr.on('data', () => {});

  return child;
};

// Send one command to the worker; resolves with its JSON reply.
const mediaRequest = (command) =>
  new Promise((resolve, reject) => {
    let child;
    try {
      child = ensureMediaWorker();
    } catch (e) {
      reject(e);
      return;
    }
    const id = mediaSeq++;
    const timer = setTimeout(() => {
      mediaWaiters.delete(id);
      stopMediaWorker(); // hung worker = broken worker, respawn next time
      reject(new Error('Media control timed out.'));
    }, MEDIA_TIMEOUT_MS);
    mediaWaiters.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(JSON.stringify({ id, ...command }) + '\n');
    } catch (e) {
      mediaWaiters.delete(id);
      clearTimeout(timer);
      stopMediaWorker();
      reject(e);
    }
    armMediaIdle();
  });

// ─── HTTP server ────────────────────────────────────────────────────────────
// Reads a small JSON body. Resolves the parsed object, false for invalid
// JSON, or null when the body exceeded the cap. Never throws.
function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      if (body.length + chunk.length > maxBytes) {
        tooLarge = true;
        req.destroy();
        resolve(null);
        return;
      }
      body += chunk;
    });
    req.on('error', () => resolve(null));
    req.on('end', () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        resolve(false);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const send = (status, payload) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS,
    });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname === '/health') {
    send(200, {
      ok: true,
      app: 'J.A.R.V.I.S Desktop Bridge',
      platform: process.platform,
      // Presence only — the key itself never leaves this process.
      groqKeyPresent: Boolean(groqKey()),
    });
    return;
  }

  if (url.pathname === '/open') {
    const kind = url.searchParams.get('kind') || '';
    const target = url.searchParams.get('target') || '';
    console.log(`[${new Date().toLocaleTimeString()}] ${kind} -> ${target}`);

    let result;
    switch (kind) {
      case 'url':
        result = await openUrl(target);
        break;
      case 'app':
        result = await openApp(target);
        break;
      case 'file':
        result = await openFile(target);
        break;
      case 'folder':
        result = await openFolder(target);
        break;
      case 'find':
        result = await openBySearch(target);
        break;
      default:
        result = fail(`Unknown action "${kind}".`);
    }
    send(result.ok ? 200 : 400, result);
    return;
  }

  // Groq chat proxy — the only path to the LLM, key attached server-side.
  if (url.pathname === '/groq') {
    if (req.method !== 'POST') {
      send(405, fail('Use POST /groq with a JSON body.'));
      return;
    }
    groqProxy(req, res, send);
    return;
  }

  // ── Laptop media control: system volume + screen brightness ────────────
  // GET  /media                 → current { volume, muted, brightness }
  // POST /media {device, action, value?} → change it, reply with fresh state
  if (url.pathname === '/media') {
    const respond = (promise) => {
      promise
        .then((msg) => {
          send(msg.ok ? 200 : 400, {
            ok: !!msg.ok,
            volume: typeof msg.volume === 'number' ? msg.volume : null,
            muted: typeof msg.muted === 'boolean' ? msg.muted : null,
            brightness:
              typeof msg.brightness === 'number' ? msg.brightness : null,
            error: msg.error || null,
          });
        })
        .catch((err) => send(500, { ok: false, error: err.message }));
    };

    if (req.method === 'GET') {
      respond(mediaRequest({ device: 'volume', action: 'get' }));
      return;
    }
    if (req.method !== 'POST') {
      send(
        405,
        fail('Use GET /media or POST /media {device, action, value}.')
      );
      return;
    }

    let body = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        tooLarge = true;
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('error', () => {});
    req.on('end', () => {
      if (tooLarge) {
        send(413, fail('Request body too large.'));
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(body || '{}');
      } catch (e) {
        send(400, fail('Invalid JSON body.'));
        return;
      }
      const device = String(parsed.device || '');
      const action = String(parsed.action || '');
      if (device !== 'volume' && device !== 'brightness') {
        send(400, fail("device must be 'volume' or 'brightness'."));
        return;
      }
      const allowed = ['get', 'up', 'down', 'set', 'mute', 'unmute', 'toggle'];
      if (!allowed.includes(action)) {
        send(400, fail(`action must be one of: ${allowed.join(', ')}.`));
        return;
      }
      const value =
        parsed.value === undefined || parsed.value === null
          ? null
          : Number(parsed.value);
      if (action === 'set' && !Number.isFinite(value)) {
        send(400, fail('set needs a numeric value (0-100).'));
        return;
      }
      respond(
        mediaRequest({
          device,
          action,
          value: Number.isFinite(value) ? Math.round(value) : null,
        })
      );
    });
    return;
  }

  // ── WEB RESEARCH: free, keyless search → {title,url,snippet,source}[] ──
  if (url.pathname === '/search') {
    const q = (url.searchParams.get('q') || '').trim();
    console.log(`[${new Date().toLocaleTimeString()}] search -> ${q}`);
    if (!q) {
      send(400, fail('Missing query (?q=<query>).'));
      return;
    }
    try {
      const result = await searchWeb(q);
      send(200, { ok: true, ...result });
    } catch (e) {
      // Honest failure — the HUD tells the user the search failed instead of
      // the model answering from training memory.
      send(200, { ok: false, error: (e && e.message) || 'Web search failed.' });
    }
    return;
  }

  // ── YOUTUBE SEARCH: free keyless results for the contextual YT flow ────
  if (url.pathname === '/ytsearch') {
    const q = (url.searchParams.get('q') || '').trim();
    console.log(`[${new Date().toLocaleTimeString()}] ytsearch -> ${q}`);
    if (!q) {
      send(400, fail('Missing query (?q=<query>).'));
      return;
    }
    try {
      const result = await searchYouTube(q);
      send(200, { ok: true, ...result });
    } catch (e) {
      send(200, { ok: false, error: (e && e.message) || 'YouTube search failed.' });
    }
    return;
  }

  // ── BROWSER CONTROL: whitelisted actions only, never throws ────────────
  if (url.pathname === '/browser') {
    if (req.method !== 'POST') {
      send(405, fail('Use POST /browser with JSON {action, url?, query?}.'));
      return;
    }
    const parsed = await readJsonBody(req);
    if (parsed === null) {
      send(413, fail('Request body too large.'));
      return;
    }
    if (parsed === false) {
      send(400, fail('Invalid JSON body.'));
      return;
    }
    const action = String(parsed.action || '');
    if (!browserControl.ACTIONS.includes(action)) {
      send(
        400,
        fail(`action must be one of: ${browserControl.ACTIONS.join(', ')}.`)
      );
      return;
    }
    console.log(
      `[${new Date().toLocaleTimeString()}] browser -> ${action}`
    );
    const result = await browserControl.exec(action, {
      url: parsed.url,
      query: parsed.query,
    });
    send(200, result);
    return;
  }

  // ── MUSIC CONTROL: one controlled YouTube player (music-control.js) ──────
  // GET  /music              → real player state — reads the actual <video>
  //                            of the open watch page (never launches Chrome)
  // POST /music {action, …}  → whitelisted music functions only
  if (url.pathname === '/music') {
    if (req.method === 'GET') {
      musicControl
        .exec('getState', {})
        .then((result) => send(200, result))
        .catch((err) => send(500, fail(err.message)));
      return;
    }
    if (req.method !== 'POST') {
      send(405, fail('Use GET /music or POST /music {action, ...}.'));
      return;
    }
    const parsed = await readJsonBody(req);
    if (parsed === null) {
      send(413, fail('Request body too large.'));
      return;
    }
    if (parsed === false) {
      send(400, fail('Invalid JSON body.'));
      return;
    }
    const action = String(parsed.action || '');
    if (!musicControl.ACTIONS.includes(action)) {
      send(400, fail(`action must be one of: ${musicControl.ACTIONS.join(', ')}.`));
      return;
    }
    if (action !== 'getState') {
      console.log(
        `[${new Date().toLocaleTimeString()}] music -> ${action}${
          parsed.query ? ` ${String(parsed.query).slice(0, 60)}` : ''
        }`
      );
    }
    const result = await musicControl.exec(action, {
      query: parsed.query,
      url: parsed.url,
      index: parsed.index,
      seconds: parsed.seconds,
      queue: Array.isArray(parsed.queue) ? parsed.queue.slice(0, 10) : undefined,
    });
    send(200, result);
    return;
  }

  send(404, { ok: false, error: 'Unknown endpoint.' });
});

server.listen(PORT, HOST, () => {
  console.log('──────────────────────────────────────────────');
  console.log('  J.A.R.V.I.S Desktop Bridge is ONLINE');
  console.log(`  http://${HOST}:${PORT}`);
  console.log('  Open apps, files, folders and links by voice.');
  console.log(
    groqKey()
      ? '  Groq key: loaded from .env — used here only, never sent to the browser.'
      : '  Groq key: NOT FOUND — create .env with GROQ_API_KEY=... at the project root.'
  );
  console.log('  Keep this window open. Close it to stop.');
  console.log('──────────────────────────────────────────────');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use — the bridge is probably already running.`
    );
  } else {
    console.error('Bridge error:', err.message);
  }
  process.exit(1);
});
