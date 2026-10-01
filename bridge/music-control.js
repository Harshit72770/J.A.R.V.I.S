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
 * SESSION-REUSE implementation (no puppeteer, no CDP, no second Chrome):
 *  - Chrome already running → we NEVER launch another Chrome process or
 *    window. Commands reuse the running session through shared primitives
 *    from browser-control.js (chrome.exe <url> goes through Chrome's own
 *    singleton handshake; every read/write goes through the resident
 *    Windows UI Automation worker, bridge/ui-worker.ps1).
 *  - YouTube tab priority (§17): (1) the tracked watch tab we already know
 *    is navigated in place — "play another song" reuses the very same tab;
 *    (2) any other existing YouTube tab (even unselected) is found via the
 *    tab strips and reused; (3) only when NO suitable YouTube tab exists do
 *    we open ONE new tab — and if Chrome isn't running at all, that single
 *    `chrome.exe <url>` starts it once. A duplicate window is structurally
 *    impossible. GET /music never launches anything (reads only).
 *  - SINGLE SOURCE OF TRUTH = the real player of the open YouTube watch
 *    page, read through UIA: seek slider (position/duration), tab-audio
 *    flag + exact player button (playing/paused), tab title. UIA slider
 *    values update on seek/pause/state-change events but do NOT tick during
 *    playback, so playback position is projected bridge-side: re-anchor on
 *    real events, wall-clock projection in between, clamped to duration.
 *    Unselected tabs are strip-only reads (title + audio) — projection keeps
 *    their position alive without ever touching the page.
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

const session = browserControl.session;

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

// The tab we are driving + the projection anchor for its position. Identity
// (vid/title) doubles as the UIA hint set; pos/measured/at/play flag drive
// the wall-clock position projection between real slider events.
let anchor = {
  vid: '',
  title: '',
  duration: 0,
  pos: 0,
  measured: null,
  at: 0,
  playing: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function vidFromUrl(u) {
  const s = String(u || '');
  const m =
    s.match(/[?&]v=([\w-]{11})/) ||
    s.match(/youtu\.be\/([\w-]{11})/) ||
    s.match(/\/(?:shorts|live)\/([\w-]{11})/);
  return m ? m[1] : null;
}

const hints = () => ({
  hintVideoId: anchor.vid || '',
  hintTitle: anchor.title || '',
});

// The tab-audio flag is the live signal; the exact player button ("Pause
// (k)" is showing ⇒ currently playing) covers its short title-update lag.
const isPlayingOf = (t) =>
  !!t.audio || /^Pause/.test(String(t.button || ''));

// ── Reading the session (UIA worker) ────────────────────────────────────────
// { chrome:true, track } — track = tracked > selected-playing > selected
// watch; { chrome:false } — no browser running; { unavailable:true } —
// worker dead/timeout. NEVER launches anything (GET /music safety).
async function readSession(h = {}) {
  try {
    const r = await session.uiOp('state', {
      hintTitle: h.hintTitle || '',
      hintVideoId: h.hintVideoId || '',
    });
    if (!r || !r.ok) return { unavailable: true };
    if (!r.chrome) return { chrome: false };
    const t = r.track || r.playing || r.watch || null;
    return { chrome: true, track: t && t.found !== false ? t : null };
  } catch (e) {
    return { unavailable: true };
  }
}

const resolveVid = (t) => (t && t.url ? vidFromUrl(t.url) : anchor.vid || null);

// ── State assembly ──────────────────────────────────────────────────────────
// Re-anchors on real slider events (seek / pause / resume / state change),
// projects wall-clock time between them while the audio flag says playing,
// and clamps to duration. Returns the st shape buildState() has always
// consumed — the frontend wire contract does not change.
function buildTrackState(t, vid, now) {
  const durRaw = Number(t.duration) > 0 ? Number(t.duration) : 0;
  const measured =
    t.selected && typeof t.position === 'number' ? Number(t.position) : null;
  const playing = isPlayingOf(t);

  if (anchor.vid !== vid) {
    anchor = {
      vid,
      title: t.title || anchor.title,
      duration: durRaw,
      pos: measured != null ? measured : 0,
      measured,
      at: now,
      playing,
    };
  } else {
    const flip = playing !== anchor.playing;
    if (flip) {
      // pause/resume/state-change: the slider is real at this moment
      anchor.pos = measured != null ? measured : anchor.pos;
      anchor.at = now;
    } else if (!playing && measured != null) {
      anchor.pos = measured; // paused slider is accurate
      anchor.at = now;
    } else if (
      playing &&
      measured != null &&
      (anchor.measured == null || Math.abs(measured - anchor.measured) > 0.75)
    ) {
      anchor.pos = measured; // seek (or event) moved the slider for real
      anchor.at = now;
    }
    // playing && (measured unchanged or null — unselected tab): leave
    // pos/at alone so the wall-clock projection keeps ticking.
    anchor.measured = measured;
    anchor.playing = playing;
    if (durRaw > 0) anchor.duration = durRaw;
    if (t.title) anchor.title = t.title;
  }

  let pos;
  if (playing) {
    pos = anchor.pos + (now - anchor.at) / 1000;
    if (anchor.duration > 0) pos = Math.min(pos, anchor.duration);
  } else {
    pos = anchor.pos;
  }
  if (pos < 0) pos = 0;

  const q = musicState.queue.find((x) => x.videoId === vid) || null;
  const btn = String(t.button || '');
  const ended =
    !playing &&
    ((anchor.duration > 0 && pos >= anchor.duration - 2) ||
      /^Replay/.test(btn));
  return {
    videoId: vid,
    currentTime: pos,
    duration: anchor.duration,
    paused: !playing,
    ended,
    title: t.title || (q && q.title) || 'YouTube video',
    channel: (q && q.channel) || '',
    thumbnail:
      (q && q.thumbnail) || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
    // internal signals (ignored by buildState)
    _isPlaying: playing,
    _selected: !!t.selected,
    _button: btn,
  };
}

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
  const r = await readSession(hints());
  const t = r.track;
  if (!t) return idleState();
  const vid = resolveVid(t);
  if (!vid) return idleState();
  const st = buildTrackState(t, vid, Date.now());
  syncQueueIndex(vid);
  if (
    t.selected &&
    !st._isPlaying &&
    st.ended &&
    musicState.queueIndex >= 0 &&
    musicState.queueIndex + 1 < musicState.queue.length
  ) {
    return playAt(musicState.queueIndex + 1); // next song in the queue
  }
  return buildState(st);
}

// ── Opening a video in the EXISTING session ────────────────────────────────
// Priority: (1) the tracked tab we already know — navigate it in place;
// (2) any existing YouTube tab, even unselected (findYoutube selects it);
// (3) ONE new tab via the singleton (starts Chrome once if not running).
async function openVideo(rawUrl) {
  const safeUrl = sanitizeVideoUrl(rawUrl);
  if (!safeUrl) return { ok: false, error: 'That is not a valid YouTube video link.' };
  if (!session.hasBrowserExe()) {
    return {
      ok: false,
      fallback: true,
      error: 'No controllable browser is available (install Chrome or Edge).',
    };
  }

  // (1) reuse the tracked tab — same tab for every next song
  if (anchor.vid || anchor.title) {
    let nav = null;
    try {
      nav = await session.uiOp('navOmnibox', { url: safeUrl, ...hints() });
    } catch (e) {
      nav = null;
    }
    if (nav && nav.ok) return { ok: true, opened: safeUrl };
    // notrack (tab gone) / nowindow (Chrome closed) / transient nav failure
    // all fall through — the next step re-resolves a tab.
  }

  // (2) any existing YouTube tab (selected tab URL first, else the strips)
  let fy = null;
  try {
    fy = await session.uiOp('findYoutube', {});
  } catch (e) {
    fy = null;
  }
  if (fy && fy.ok && fy.found && fy.hwnd) {
    let nav = null;
    try {
      nav = await session.uiOp('navOmnibox', { url: safeUrl, hwnd: fy.hwnd });
    } catch (e) {
      nav = null;
    }
    if (nav && nav.ok) return { ok: true, opened: safeUrl, reused: true };
    // fall through to a fresh tab if this one could not be navigated
  }

  // Abnormal path (both reuses failed): make sure nothing is still playing
  // before a second tab could produce a second audio stream.
  try {
    const rr = await readSession({});
    const t = rr.track; // no hints → playing/watch only
    const tv = t ? vidFromUrl(t.url) : null;
    if (t && tv && isPlayingOf(t)) {
      anchor.vid = tv;
      anchor.title = t.title || anchor.title;
      await pressPlayer('pause');
    }
  } catch (e) {
    /* best effort */
  }

  // (3) no suitable tab → ONE new tab (existing session, or one launch)
  const opened = session.openExternal(safeUrl);
  if (!opened.ok) return opened;
  const seen = await session.findUrl(safeUrl, {}, 6000);
  if (!seen.found) {
    return {
      ok: false,
      fallback: false,
      error: 'That video did not load — it may be unavailable right now.',
      opened: safeUrl,
    };
  }
  return { ok: true, opened: safeUrl };
}

async function waitTrack(vid, titleHint, ms = VIDEO_WAIT_MS) {
  const deadline = Date.now() + ms;
  let last = null;
  for (;;) {
    const r = await readSession({ hintVideoId: vid, hintTitle: titleHint || '' });
    const t = r.track;
    if (t) {
      const tv = t.url ? vidFromUrl(t.url) : vid;
      if (tv === vid) {
        last = t;
        // URL id appears instantly; duration means the seek slider (player
        // metadata) has actually loaded.
        if (t.duration > 0 && t.title) return t;
      }
    }
    if (Date.now() > deadline) return last; // best effort after timeout
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }
}

async function waitAndBuild(vid, titleHint, extra = {}) {
  const t = await waitTrack(vid, titleHint);
  if (!t) {
    return {
      ok: false,
      error: 'The video did not start playing — it may be unavailable.',
    };
  }
  const st = buildTrackState(t, vid, Date.now());
  syncQueueIndex(vid);
  const autoplayBlocked = !st._isPlaying && st.currentTime < 1;
  return buildState(st, { autoplayBlocked, ...extra });
}

// ── Player button control (direction-safe) ──────────────────────────────────
// invoke first (exact anchored button name, checked against `expect` so a
// race can never press the wrong direction), keyboard toggle as fallback.
async function pressPlayer(want /* 'pause' | 'play' */) {
  const base = { hintVideoId: anchor.vid || '', hintTitle: anchor.title || '' };
  const expect = want === 'pause' ? '^Pause' : '^(Play|Replay)';
  let r = null;
  try {
    r = await session.uiOp('player', { mode: 'invoke', expect, ...base });
  } catch (e) {
    r = null;
  }
  if (r && r.ok) return { acted: true };
  if (r && r.code === 'wrongdirection') return { acted: false, flipped: true };
  try {
    r = await session.uiOp('player', { mode: 'key', key: 'k', ...base });
  } catch (e) {
    return { acted: false, error: true };
  }
  if (r && r.ok) return { acted: true };
  return { acted: false, code: r ? r.code : 'dead' };
}

// Verify (and re-press while needed) until the player is really paused.
// Fresh videos get the full 8-check window (the player re-issues play()
// ~1-2s after our pause); ordinary pauses confirm on the first clean read.
async function runPause(fresh) {
  const checks = fresh ? 8 : 2;
  let workerDead = false;
  let lastPlaying = true;
  const p0 = await pressPlayer('pause');
  if (p0.error) workerDead = true;
  for (let i = 0; i < checks && !workerDead; i++) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(400);
    // eslint-disable-next-line no-await-in-loop
    const rr = await readSession(hints());
    if (rr.unavailable) {
      workerDead = true;
      break;
    }
    if (!rr.track) continue;
    const vid = resolveVid(rr.track);
    if (!vid) continue;
    const st = buildTrackState(rr.track, vid, Date.now());
    lastPlaying = st._isPlaying;
    if (!lastPlaying) {
      if (!fresh) break; // ordinary pause: first clean confirmation
      continue; // fresh: keep guarding the whole startup window
    }
    await pressPlayer('pause'); // just read "playing" → direction is known
  }
  if (workerDead) return { ok: false, error: 'The video could not be paused.' };
  if (lastPlaying) {
    // settle once more (startup re-play fight) before declaring failure
    await pressPlayer('pause');
    await sleep(500);
    const rr = await readSession(hints());
    if (rr.unavailable) {
      return { ok: false, error: 'The video could not be paused.' };
    }
    if (rr.track) {
      const vid = resolveVid(rr.track);
      if (vid) lastPlaying = buildTrackState(rr.track, vid, Date.now())._isPlaying;
    }
    if (lastPlaying) return { ok: false, error: 'The video could not be paused.' };
  }
  return { ok: true };
}

// ── Queue navigation (unchanged semantics, session-mode open) ───────────────
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
  const nav = await openVideo(pick.url);
  if (!nav.ok) return nav;
  return waitAndBuild(pick.videoId, pick.title);
}

async function playUrl(rawUrl, queueRaw, indexRaw) {
  const url = sanitizeVideoUrl(rawUrl);
  if (!url) return { ok: false, error: 'That is not a valid YouTube video link.' };
  let titleHint = '';
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
      const qi = at >= 0 ? at : idx;
      if (qi >= 0 && queue[qi]) titleHint = queue[qi].title;
    }
  }
  const nav = await openVideo(url);
  if (!nav.ok) return nav;
  return waitAndBuild(vidFromUrl(url), titleHint);
}

async function playAt(i) {
  const item = musicState.queue[i];
  if (!item) return { ok: false, error: 'That song is not in the queue.' };
  musicState.queueIndex = i;
  const nav = await openVideo(item.url);
  if (!nav.ok) return nav;
  return waitAndBuild(item.videoId || vidFromUrl(item.url), item.title);
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

// ── Direct player controls ──────────────────────────────────────────────────
async function requireTrack() {
  if (!session.hasBrowserExe()) {
    return {
      ok: false,
      fallback: true,
      error: 'No controllable browser is available (install Chrome or Edge).',
    };
  }
  const r = await readSession(hints());
  if (r.unavailable) {
    return {
      ok: false,
      fallback: true,
      error: 'No controllable browser is available (install Chrome or Edge).',
    };
  }
  const t = r.track;
  const vid = t ? resolveVid(t) : null;
  if (!t || !vid) return { ok: false, error: 'No YouTube video is currently open.' };
  const st = buildTrackState(t, vid, Date.now());
  return { ok: true, t, st };
}

async function pause() {
  const need = await requireTrack();
  if (!need.ok) return need;
  if (!need.st._isPlaying) return stateFromPage();
  const r = await runPause(need.st.currentTime < 5);
  if (!r.ok) return r;
  return stateFromPage();
}

async function resume() {
  const need = await requireTrack();
  if (!need.ok) return need;
  if (need.st._isPlaying) return stateFromPage();
  const fresh = need.st.currentTime < 5;
  const checks = fresh ? 8 : 2;
  let workerDead = false;
  let last = need.st;
  const p0 = await pressPlayer('play');
  if (p0.error) workerDead = true;
  for (let i = 0; i < checks && !workerDead; i++) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(400);
    // eslint-disable-next-line no-await-in-loop
    const rr = await readSession(hints());
    if (rr.unavailable) {
      workerDead = true;
      break;
    }
    if (!rr.track) continue;
    const vid = resolveVid(rr.track);
    if (!vid) continue;
    last = buildTrackState(rr.track, vid, Date.now());
    if (last._isPlaying) {
      if (!fresh) break;
      continue;
    }
    await pressPlayer('play');
  }
  if (workerDead) return { ok: false, error: 'The video could not be resumed.' };
  if (last._isPlaying) return stateFromPage();
  // Never started: a loaded player at position 0 that refuses to start is
  // the autoplay restriction — tell the user, never force it.
  if (last.duration > 0 && last.currentTime < 1) {
    return {
      ok: false,
      error: 'Autoplay is blocked — press play in the browser window.',
    };
  }
  return { ok: false, error: 'The video could not be resumed.' };
}

async function stop() {
  const need = await requireTrack();
  if (!need.ok) return need;
  if (need.st._isPlaying) await pressPlayer('pause'); // best effort
  try {
    // Navigating away releases the stream and returns the player to idle —
    // the queue is kept, so "next" still works after a stop. The home tab
    // it leaves behind is the tab the next "play" reuses (§17).
    await session.uiOp('navOmnibox', {
      url: 'https://www.youtube.com/',
      ...hints(),
    });
  } catch (e) {
    /* the pause above is already "stopped" enough */
  }
  anchor.vid = '';
  anchor.title = '';
  return idleState();
}

async function seekBy(deltaRaw) {
  const delta = Number(deltaRaw);
  if (!Number.isFinite(delta) || delta === 0) {
    return { ok: false, error: 'Tell me how many seconds to move (±10).' };
  }
  const need = await requireTrack();
  if (!need.ok) return need;
  const d = Math.max(-3600, Math.min(3600, delta));
  const fwd = d > 0;
  const n = Math.floor(Math.abs(d) / 10);
  const rem = Math.abs(d) - n * 10;
  const arrow = fwd ? '{RIGHT}' : '{LEFT}'; // ±5s
  let keys = (fwd ? 'l' : 'j').repeat(n); // ±10s each
  if (rem >= 5 || n === 0) keys += arrow; // remainder, or one arrow if tiny
  if (!keys) keys = arrow;
  let r = null;
  try {
    r = await session.uiOp('player', { mode: 'key', key: keys, ...hints() });
  } catch (e) {
    r = null;
  }
  if (!r || !r.ok) {
    if (r && (r.code === 'notrack' || r.code === 'nowindow')) {
      return { ok: false, error: 'No YouTube video is currently open.' };
    }
    return { ok: false, error: 'Could not move the playback position.' };
  }
  // one settle beat: n ±10 keys dispatch fast but the seek event that
  // refreshes the slider needs a moment for large deltas
  await sleep(Math.min(3000, 400 + n * 10));
  const rr = await readSession(hints());
  if (rr.unavailable) {
    return { ok: false, error: 'Could not move the playback position.' };
  }
  if (!rr.track) return { ok: false, error: 'No YouTube video is currently open.' };
  return stateFromPage();
}

async function seekTo(secondsRaw) {
  const target = Number(secondsRaw);
  if (!Number.isFinite(target) || target < 0) {
    return { ok: false, error: 'That position is not valid.' };
  }
  const need = await requireTrack();
  if (!need.ok) return need;
  const vid = anchor.vid;
  const wasPaused = !need.st._isPlaying;
  let t = target;
  if (need.st.duration > 0) t = Math.min(t, need.st.duration);
  const url = watchUrlOf(vid) + (t > 0 ? `&t=${Math.round(t)}s` : '');
  let r = null;
  try {
    r = await session.uiOp('navOmnibox', { url, hintVideoId: vid, hintTitle: anchor.title || '' });
  } catch (e) {
    r = null;
  }
  if (!r || !r.ok) {
    if (r && r.code === 'notrack') {
      return { ok: false, error: 'No YouTube video is currently open.' };
    }
    return { ok: false, error: 'Could not move the playback position.' };
  }
  const got = await waitTrack(vid, anchor.title);
  if (!got) return { ok: false, error: 'Could not move the playback position.' };
  if (wasPaused) {
    // The reload autoplays — restore the paused state the user had.
    const rr = await readSession({ hintVideoId: vid, hintTitle: anchor.title || '' });
    if (rr.track) {
      const tv = resolveVid(rr.track);
      const s2 = tv ? buildTrackState(rr.track, tv, Date.now()) : null;
      if (s2 && s2._isPlaying) await runPause(s2.currentTime < 5);
    }
  }
  return stateFromPage();
}

// ── Dispatch (whitelist only, never throws, serialized) ─────────────────────
// One command at a time: a state poll can never race against a page that a
// concurrent "play" is still navigating (prevents phantom idle frames).
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
