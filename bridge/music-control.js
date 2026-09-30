/**
 * J.A.R.V.I.S — Music Control Tool
 * =================================
 * The controlled music tool (spec §5) — a whitelist of music functions and
 * nothing else:
 *
 *   play {query} · playIndex {index} · playUrl {url, queue?, index?} ·
 *   pause · resume · stop · seekBy {seconds} · seekTo {seconds} ·
 *   next · previous · getState
 *
 * Implementation rules (spec):
 *  - REUSES the existing browser-control system: this module drives the very
 *    same puppeteer window (shared primitives from browser-control.js) —
 *    no second automation system is ever created. An open YouTube tab is
 *    reused; a new tab is opened only when none exists (§17).
 *  - SINGLE SOURCE OF TRUTH = the real <video> element of the open YouTube
 *    watch page. Every reply reads the actual player state (time, duration,
 *    playing/paused/ended), so the HUD can never drift from the video (§10).
 *  - Queue state (last query, results, current index) lives here, capped —
 *    never unbounded (§7).
 *  - FREE (§13): search comes from the existing keyless searchYouTube()
 *    fetcher — no API key, no quota, no downloads, no paid service. No
 *    YouTube audio/video is ever downloaded.
 *  - SAFE (§5): the LLM can only pick whitelisted actions over HTTP; no
 *    user-supplied string ever reaches eval() or a shell, and the page
 *    scripts below are fixed constants inside this file.
 *  - NEVER THROWS (§12): every function resolves to { ok, ... } — a YouTube
 *    failure shows a small error and J.A.R.V.I.S keeps running.
 */

const { searchYouTube } = require('./web-search.js');
const browserControl = require('./browser-control.js');

const ACTIONS = [
  'play',
  'playIndex',
  'playUrl',
  'pause',
  'resume',
  'stop',
  'seekBy',
  'seekTo',
  'next',
  'previous',
  'getState',
];

const MAX_QUEUE = 10; // §7: short-term state only
const MAX_QUERY = 200;
// Prefer a real-length video over an obvious short/clip when picking the
// "most relevant result"; falls back to the first result when none qualify.
const MIN_SONG_SECONDS = 30;
const VIDEO_WAIT_MS = 8000;

// ── Queue state (server-side, single owner) ─────────────────────────────────
let musicState = { lastQuery: '', queue: [], queueIndex: -1 };

const isYoutubeHost = (hostname) =>
  /(?:^|\.)youtube\.com$/.test(hostname) || /(?:^|\.)youtu\.be$/.test(hostname);

// Only youtube watch/shorts/live/youtu.be links are ever navigated to.
function sanitizeVideoUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!isYoutubeHost(u.hostname.replace(/^www\./, ''))) return null;
    const isWatch =
      u.hostname.includes('youtu.be') ||
      u.pathname === '/watch' ||
      /^\/(?:shorts|live)\/[\w-]{11}$/.test(u.pathname);
    if (!isWatch) return null;
    return u.href;
  } catch (e) {
    return null;
  }
}

const watchUrlOf = (videoId) =>
  `https://www.youtube.com/watch?v=${videoId}`;

// ── Fixed page scripts (constants — never user-supplied) ────────────────────
// Read the REAL player: HTML5 <video> time/state + ytInitialPlayerResponse
// metadata (title/channel/thumbnail) with DOM fallbacks.
async function readPlayer(page) {
  try {
    return await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      const details =
        (window.ytInitialPlayerResponse || {}).videoDetails || null;
      const heading =
        document.querySelector('h1.ytd-watch-metadata') ||
        document.querySelector('ytd-video-primary-info-renderer h1');
      const id = (location.search.match(/[?&]v=([\w-]{11})/) || [])[1] || null;
      return {
        videoId: id,
        currentTime: v.currentTime || 0,
        duration:
          Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0,
        paused: !!v.paused,
        ended: !!v.ended,
        title:
          (heading && heading.innerText ? heading.innerText.trim() : '') ||
          (details && details.title) ||
          document.title.replace(/\s*[-–]\s*YouTube$/, ''),
        channel:
          (details && details.author) ||
          ((document.querySelector('ytd-channel-name a') || {}).textContent ||
            ''
          ).trim(),
        thumbnail:
          (details &&
            details.thumbnail &&
            details.thumbnail.thumbnails &&
            details.thumbnail.thumbnails[
              details.thumbnail.thumbnails.length - 1
            ].url) ||
          v.poster ||
          '',
      };
    });
  } catch (e) {
    return null; // navigation in flight / page gone — caller decides
  }
}

async function waitForVideo(page, ms = VIDEO_WAIT_MS) {
  const deadline = Date.now() + ms;
  let last = null;
  for (;;) {
    const st = await readPlayer(page);
    if (st && st.videoId) {
      last = st;
      // URL id appears instantly; duration/title mean the player metadata
      // (author, thumbnail, length) has actually loaded.
      if (st.duration > 0 && st.title) return st;
    }
    if (Date.now() > deadline) return last; // best effort after timeout
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ── Finding the page that holds the player ──────────────────────────────────
// Returns { page } for the YouTube watch tab (preferring the one actually
// playing), or { error } — NEVER launches a browser on its own.
async function musicPage() {
  const b = await browserControl.internals.peekBrowser();
  if (!b) return { error: 'unavailable' };
  let pages = [];
  try {
    pages = await b.pages();
  } catch (e) {
    return { error: 'unavailable' };
  }
  const active = browserControl.internals.getActivePage();
  const candidates = [];
  for (const p of pages) {
    try {
      if (p.isClosed()) continue;
      const u = new URL(p.url());
      const host = u.hostname.replace(/^www\./, '');
      if (!isYoutubeHost(host)) continue;
      const isWatch =
        u.pathname === '/watch' ||
        /^\/(?:shorts|live)\/[\w-]{11}$/.test(u.pathname) ||
        /(^|\.)youtu\.be$/.test(host);
      if (isWatch) candidates.push(p);
    } catch (e) {
      /* about:blank etc. — not a candidate */
    }
  }
  if (!candidates.length) return { error: 'nowatch' };
  const ordered = active
    ? [active, ...candidates.filter((p) => p !== active)].filter((p) =>
        candidates.includes(p)
      )
    : candidates;
  // Prefer a page that is actually playing (covers manual opens too).
  for (const p of ordered) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const playing = await p.evaluate(() => {
        const v = document.querySelector('video');
        return !!v && !v.paused && !v.ended;
      });
      if (playing) return { page: p };
    } catch (e) {
      /* try next */
    }
  }
  return { page: ordered[0] };
}

// Reuse an existing YouTube tab when one exists (§17), else ONE new tab.
async function openWatch(url) {
  const safeUrl = sanitizeVideoUrl(url);
  if (!safeUrl) return { ok: false, error: 'That is not a valid YouTube video link.' };
  const b = await browserControl.internals.ensureBrowser();
  if (!b) {
    return {
      ok: false,
      fallback: true,
      error: 'No controllable browser is available (install Chrome or Edge).',
    };
  }
  let page = null;
  try {
    const pages = await b.pages();
    const ytTabs = [];
    for (const p of pages) {
      try {
        if (p.isClosed()) continue;
        const u = new URL(p.url());
        if (isYoutubeHost(u.hostname.replace(/^www\./, ''))) ytTabs.push(p);
      } catch (e) {
        /* skip */
      }
    }
    const active = browserControl.internals.getActivePage();
    page =
      active && ytTabs.includes(active)
        ? active
        : ytTabs.length
        ? ytTabs[ytTabs.length - 1]
        : await b.newPage(); // no YouTube tab yet → open exactly one
  } catch (e) {
    return { ok: false, fallback: true, error: 'Could not open a browser tab.' };
  }
  browserControl.internals.setActivePage(page);
  try {
    await page.goto(safeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: browserControl.internals.NAV_TIMEOUT,
    });
    try {
      await page.bringToFront();
    } catch (e) {
      /* focus is cosmetic only */
    }
  } catch (e) {
    return {
      ok: false,
      fallback: false,
      error: 'That video did not load — it may be unavailable right now.',
      opened: safeUrl,
    };
  }
  return { ok: true, page, opened: safeUrl };
}

// ── State assembly ──────────────────────────────────────────────────────────
function trackFrom(st) {
  if (!st || !st.videoId) return null;
  return {
    videoId: st.videoId,
    title: st.title || 'YouTube video',
    channel: st.channel || '',
    thumbnail: st.thumbnail || '',
    url: watchUrlOf(st.videoId),
    durationSeconds: Math.round(st.duration || 0),
  };
}

function buildState(st, extra = {}) {
  const queue = musicState.queue;
  const queueIndex = musicState.queueIndex;
  const track = trackFrom(st);
  return {
    ok: true,
    currentTrack: track,
    videoId: track ? track.videoId : null,
    title: track ? track.title : '',
    channel: track ? track.channel : '',
    thumbnail: track ? track.thumbnail : '',
    isPlaying: !!(st && !st.paused && !st.ended),
    currentTime: st ? Math.round(st.currentTime || 0) : 0,
    duration: st ? Math.round(st.duration || 0) : 0,
    queue,
    queueIndex,
    queueLength: queue.length,
    lastQuery: musicState.lastQuery,
    autoplayBlocked: false,
    ...extra,
  };
}

const idleState = (extra = {}) =>
  buildState(null, extra);

// Keep queueIndex honest when the open video came from somewhere else
// (manual open, plain tab, another search) — never fake an index.
function syncQueueIndex(videoId) {
  if (!videoId) {
    musicState.queueIndex = -1;
    return;
  }
  const at = musicState.queue.findIndex((x) => x.videoId === videoId);
  musicState.queueIndex = at; // -1 when this video is not in our queue
}

// Read the real player and build the reply. Auto-advances on song end (§8)
// when the finished video belongs to the queue — one bounded navigation.
async function stateFromPage() {
  const found = await musicPage();
  if (found.error || !found.page) return idleState();
  browserControl.internals.setActivePage(found.page);
  const st = await readPlayer(found.page);
  if (!st || !st.videoId) return idleState();
  syncQueueIndex(st.videoId);
  if (
    st.ended &&
    musicState.queueIndex >= 0 &&
    musicState.queueIndex + 1 < musicState.queue.length
  ) {
    return playAt(musicState.queueIndex + 1); // next song in the queue
  }
  return buildState(st);
}

// ── Navigation helpers ──────────────────────────────────────────────────────
async function waitAndBuild(page, extra = {}) {
  const st = await waitForVideo(page);
  if (!st) {
    return {
      ok: false,
      error: 'The video did not start playing — it may be unavailable.',
    };
  }
  syncQueueIndex(st.videoId);
  const autoplayBlocked = !!st.paused && st.currentTime < 1;
  return buildState(st, { autoplayBlocked, ...extra });
}

async function play(queryRaw) {
  const q = String(queryRaw || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY);
  if (!q) return { ok: false, error: 'The song name was empty.' };
  let search;
  try {
    search = await searchYouTube(q); // existing free keyless tool
  } catch (e) {
    return {
      ok: false,
      error: `YouTube search failed — ${(e && e.message) || 'no results'}.`,
    };
  }
  const results = (search.results || [])
    .filter((r) => r && r.videoId && sanitizeVideoUrl(r.url))
    .slice(0, MAX_QUEUE);
  if (!results.length) {
    return { ok: false, error: 'YouTube returned no results for that.' };
  }
  const pick =
    results.find(
      (r) => r.durationSeconds == null || r.durationSeconds >= MIN_SONG_SECONDS
    ) || results[0];
  musicState = {
    lastQuery: q,
    queue: results,
    queueIndex: results.indexOf(pick),
  };
  const nav = await openWatch(pick.url);
  if (!nav.ok) return nav;
  return waitAndBuild(nav.page);
}

async function playUrl(rawUrl, queueRaw, indexRaw) {
  const url = sanitizeVideoUrl(rawUrl);
  if (!url) return { ok: false, error: 'That is not a valid YouTube video link.' };
  // Optional queue hand-off (from "play the first/second result") — sanitized
  // link-by-link, YouTube video links only, capped at MAX_QUEUE (§7).
  if (Array.isArray(queueRaw) && queueRaw.length) {
    const queue = [];
    for (const item of queueRaw) {
      const clean = item && sanitizeVideoUrl(item.url);
      if (!clean) continue;
      const idHit =
        clean.match(/[?&]v=([\w-]{11})/) ||
        clean.match(/youtu\.be\/([\w-]{11})/) ||
        clean.match(/\/(?:shorts|live)\/([\w-]{11})/);
      queue.push({
        videoId: item.videoId || (idHit ? idHit[1] : ''),
        title: String(item.title || '').slice(0, 200),
        channel: String(item.channel || '').slice(0, 120),
        thumbnail: String(item.thumbnail || '').slice(0, 500),
        url: clean,
      });
      if (queue.length >= MAX_QUEUE) break;
    }
    if (queue.length) {
      let idx = Number(indexRaw);
      idx = Number.isInteger(idx) && idx >= 1 && idx <= queue.length ? idx - 1 : -1;
      const activeId =
        url.match(/[?&]v=([\w-]{11})/) ||
        url.match(/youtu\.be\/([\w-]{11})/) ||
        url.match(/\/(?:shorts|live)\/([\w-]{11})/);
      const at = activeId ? queue.findIndex((x) => x.videoId === activeId[1]) : -1;
      musicState = {
        lastQuery: musicState.lastQuery,
        queue,
        queueIndex: at >= 0 ? at : idx,
      };
    }
  }
  const nav = await openWatch(url);
  if (!nav.ok) return nav;
  return waitAndBuild(nav.page);
}

async function playAt(i) {
  const item = musicState.queue[i];
  if (!item) return { ok: false, error: 'That song is not in the queue.' };
  musicState.queueIndex = i;
  const nav = await openWatch(item.url);
  if (!nav.ok) return nav;
  return waitAndBuild(nav.page);
}

async function next() {
  if (!musicState.queue.length) {
    return { ok: false, error: 'There is no song queue yet — play something first.' };
  }
  if (musicState.queueIndex + 1 >= musicState.queue.length) {
    return { ok: false, error: 'That was the last song in the queue.' };
  }
  return playAt(musicState.queueIndex + 1);
}

async function previous() {
  if (!musicState.queue.length) {
    return { ok: false, error: 'There is no song queue yet — play something first.' };
  }
  if (musicState.queueIndex <= 0) {
    return { ok: false, error: 'There is no previous song before this one.' };
  }
  return playAt(musicState.queueIndex - 1);
}

// ── Direct player controls (fixed scripts, real <video> only) ───────────────
async function requirePlayer() {
  const found = await musicPage();
  if (found.error || !found.page) {
    if (found.error === 'unavailable') {
      return {
        ok: false,
        fallback: true,
        error: 'No controllable browser is available (install Chrome or Edge).',
      };
    }
    return { ok: false, error: 'No YouTube video is currently open.' };
  }
  browserControl.internals.setActivePage(found.page);
  return { ok: true, page: found.page };
}

async function pause() {
  const need = await requirePlayer();
  if (!need.ok) return need;
  const page = need.page;
  try {
    const info = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      v.pause();
      return { t: v.currentTime || 0 };
    });
    if (!info) return { ok: false, error: 'No YouTube video is currently open.' };
    // Startup race: during the first seconds of a playback session the
    // player re-issues its own play() (buffer/quality events) ~1-2s AFTER
    // our pause, silently resuming. So for a freshly started video keep
    // verifying (and re-pausing) for ~3.2s — bounded, 8 checks. An
    // ordinary pause (video already running for a while) gets a single
    // 400ms confirmation and answers immediately.
    const checks = info.t < 5 ? 8 : 2;
    for (let i = 0; i < checks; i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 400));
      // eslint-disable-next-line no-await-in-loop
      const playing = await page.evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return false;
        if (!v.paused && !v.ended) {
          v.pause();
          return true;
        }
        return false;
      });
      // Fresh startup: run the WHOLE window (the fight can start after
      // ~1-2s of clean pauses). Ordinary pauses: done at the first clean
      // confirmation.
      if (!playing && info.t >= 5) break;
    }
  } catch (e) {
    return { ok: false, error: 'The video could not be paused.' };
  }
  return stateFromPage();
}

async function resume() {
  const need = await requirePlayer();
  if (!need.ok) return need;
  let outcome;
  try {
    outcome = await need.page.evaluate(async () => {
      const v = document.querySelector('video');
      if (!v) return { ok: false, why: 'novideo' };
      try {
        await v.play();
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          why: e && e.name === 'NotAllowedError' ? 'blocked' : 'failed',
        };
      }
    });
  } catch (e) {
    return { ok: false, error: 'The video could not be resumed.' };
  }
  if (!outcome || !outcome.ok) {
    if (outcome && outcome.why === 'blocked') {
      // Autoplay restriction (§3/§12): tell the user, never force it.
      return {
        ok: false,
        error: 'Autoplay is blocked — press play in the browser window.',
      };
    }
    return { ok: false, error: 'The video could not be resumed.' };
  }
  return stateFromPage();
}

async function stop() {
  const need = await requirePlayer();
  if (!need.ok) return need;
  try {
    await need.page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) v.pause();
    });
  } catch (e) {
    /* leaving the page stops the audio anyway */
  }
  try {
    // Navigating away releases the stream and returns the player to idle —
    // the queue is kept, so "next" still works after a stop.
    await need.page.goto('https://www.youtube.com/', {
      waitUntil: 'domcontentloaded',
      timeout: browserControl.internals.NAV_TIMEOUT,
    });
  } catch (e) {
    /* paused state above is already "stopped" enough */
  }
  return idleState();
}

async function seekBy(deltaRaw) {
  const delta = Number(deltaRaw);
  if (!Number.isFinite(delta) || delta === 0) {
    return { ok: false, error: 'Tell me how many seconds to move (±10).' };
  }
  const need = await requirePlayer();
  if (!need.ok) return need;
  let r;
  try {
    r = await need.page.evaluate((d) => {
      const v = document.querySelector('video');
      if (!v) return null;
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      const target = (v.currentTime || 0) + d;
      v.currentTime = dur > 0 ? Math.max(0, Math.min(dur, target)) : Math.max(0, target);
      return true;
    }, Math.max(-3600, Math.min(3600, delta)));
  } catch (e) {
    return { ok: false, error: 'Could not move the playback position.' };
  }
  if (r === null) return { ok: false, error: 'No YouTube video is currently open.' };
  return stateFromPage();
}

async function seekTo(secondsRaw) {
  const target = Number(secondsRaw);
  if (!Number.isFinite(target) || target < 0) {
    return { ok: false, error: 'That position is not valid.' };
  }
  const need = await requirePlayer();
  if (!need.ok) return need;
  let r;
  try {
    r = await need.page.evaluate((t) => {
      const v = document.querySelector('video');
      if (!v) return null;
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      v.currentTime = dur > 0 ? Math.min(dur, t) : t;
      return true;
    }, target);
  } catch (e) {
    return { ok: false, error: 'Could not move the playback position.' };
  }
  if (r === null) return { ok: false, error: 'No YouTube video is currently open.' };
  return stateFromPage();
}

// ── Dispatch (whitelist only, never throws, serialized) ─────────────────────
// One command at a time: a state poll can never evaluate against a page that
// a concurrent "play" is still navigating (prevents phantom idle frames).
function dispatch(action, args = {}) {
  try {
    switch (action) {
      case 'play':
        return play(args.query);
      case 'playIndex': {
        const idx = Number(args.index);
        if (!Number.isInteger(idx) || idx < 1 || idx > musicState.queue.length) {
          return Promise.resolve({
            ok: false,
            error: musicState.queue.length
              ? `The queue has ${musicState.queue.length} songs — pick 1 to ${musicState.queue.length}.`
              : 'There is no song queue yet — play something first.',
          });
        }
        return playAt(idx - 1);
      }
      case 'playUrl':
        return playUrl(args.url, args.queue, args.index);
      case 'pause':
        return pause();
      case 'resume':
        return resume();
      case 'stop':
        return stop();
      case 'seekBy':
        return seekBy(args.seconds);
      case 'seekTo':
        return seekTo(args.seconds);
      case 'next':
        return next();
      case 'previous':
        return previous();
      case 'getState':
        return stateFromPage();
      default:
        return Promise.resolve({ ok: false, error: `Unknown music action: ${action}.` });
    }
  } catch (e) {
    return Promise.resolve({
      ok: false,
      error: `Music control failed: ${(e && e.message) || e}`,
    });
  }
}

let chain = Promise.resolve();

/** Run one whitelisted music action. Never throws. */
function exec(action, args = {}) {
  if (!ACTIONS.includes(action)) {
    return Promise.resolve({
      ok: false,
      error: `action must be one of: ${ACTIONS.join(', ')}.`,
    });
  }
  const run = chain.then(() => dispatch(action, args), () => dispatch(action, args));
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

module.exports = { exec, ACTIONS };
