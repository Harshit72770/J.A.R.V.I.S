/**
 * Music player client + shared state — the mediaControl store pattern.
 *
 * The Music Player component subscribes here; every bridge reply (POST /music
 * command or GET /music poll) is merged into this ONE store, so the panel can
 * never drift from the real YouTube player — the bridge always reads the
 * actual <video> element's time/state (spec §8, §10).
 *
 * Polling is bounded (spec §11): a single 1s tick exists ONLY while a track
 * is loaded AND the component is mounted. Idle → no polling at all. Every
 * request has a timeout and never throws, so a failed music command can never
 * crash J.A.R.V.I.S (spec §12).
 *
 * FREE (spec §13): this module talks only to the local desktop bridge — no
 * API key, no paid service, no downloads.
 */

const BRIDGE_URL = 'http://127.0.0.1:4777';
const POLL_MS = 1000;

let state = {
  currentTrack: null, // {videoId,title,channel,thumbnail,url,durationSeconds}
  videoId: null,
  title: '',
  channel: '',
  thumbnail: '',
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  queue: [],
  queueIndex: -1,
  queueLength: 0,
  lastQuery: '',
  autoplayBlocked: false,
  error: null, // last command failure — cleared by the next successful command
};
const listeners = new Set();
let pollTimer = null;

export const getMusicState = () => state;

function notify() {
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (e) {
      /* a bad subscriber must not break the rest */
    }
  });
}

// Fields the bridge owns. `error` is deliberately NOT here: a command error
// stays on screen until the next command, never wiped by the next poll.
const STATE_KEYS = [
  'currentTrack',
  'videoId',
  'title',
  'channel',
  'thumbnail',
  'isPlaying',
  'currentTime',
  'duration',
  'queue',
  'queueIndex',
  'queueLength',
  'lastQuery',
  'autoplayBlocked',
];

export function applyMusicState(next) {
  if (!next || typeof next !== 'object') return;
  const merged = { ...state };
  let changed = false;
  for (const key of STATE_KEYS) {
    if (next[key] !== undefined && next[key] !== state[key]) {
      merged[key] = next[key];
      changed = true;
    }
  }
  if (!changed) return;
  state = merged;
  notify();
  syncPolling();
}

function setCommandError(error) {
  if (state.error === error) return;
  state = { ...state, error };
  notify();
}

// One controlled interval: only while something is loaded and someone is
// looking. Stops itself the moment the track clears (spec §11 — no
// uncontrolled polling loops).
function syncPolling() {
  const need = listeners.size > 0 && !!state.currentTrack;
  if (need && !pollTimer) {
    pollTimer = setInterval(refreshMusicState, POLL_MS);
  } else if (!need && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Subscribe to player-state changes; returns the unsubscribe function. */
export function subscribeMusic(listener) {
  listeners.add(listener);
  listener(state);
  syncPolling();
  return () => {
    listeners.delete(listener);
    syncPolling();
  };
}

/**
 * Fire-and-forget state refresh — never throws, never blocks the caller.
 * Also picks up a video that started playing outside the HUD (the bridge
 * reads the real watch page, so the panel syncs either way).
 */
export function refreshMusicState() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  fetch(`${BRIDGE_URL}/music`, { signal: controller.signal })
    .then((res) => res.json())
    .then((json) => {
      if (json && json.ok) applyMusicState(json);
    })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

/**
 * Run one controlled music command (whitelist only — play · playUrl ·
 * playIndex · pause · resume · stop · seekBy · seekTo · next · previous).
 *
 * @param {{action:string,target?:string,url?:string,index?:number,
 *          seconds?:number,queue?:Array}} action
 * @returns {Promise<{ok:boolean, fallback?:boolean, error?:string, ...}>}
 *          `fallback: true` = automation unavailable → the caller may use
 *          the plain link opener (classic behaviour) instead.
 */
export async function musicCommand(action) {
  const body = { action: (action && action.action) || '' };
  if (action && action.target) {
    body.query = String(action.target).slice(0, 200);
  }
  if (action && action.url) body.url = String(action.url).slice(0, 2048);
  if (action && action.index !== undefined) body.index = action.index;
  if (action && typeof action.seconds === 'number') {
    body.seconds = action.seconds;
  }
  if (action && Array.isArray(action.queue)) {
    body.queue = action.queue.slice(0, 10); // §7: capped short-term state
  }

  const controller = new AbortController();
  // First play may launch the browser window — allow extra time.
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${BRIDGE_URL}/music`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = await res.json();
    if (json && json.ok) {
      setCommandError(null);
      applyMusicState(json);
      return json;
    }
    const err = (json && json.error) || 'The music command failed.';
    // Real failures show a small error line; "automation unavailable" is
    // spoken by the HUD instead (the caller falls back to the plain opener).
    if (!json || !json.fallback) setCommandError(err);
    return json && typeof json.ok === 'boolean'
      ? json
      : { ok: false, error: err };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      fallback: true,
      error:
        e && e.name === 'AbortError'
          ? 'The music command timed out.'
          : 'Desktop Bridge offline — start bridge\\bridge-start.bat (or run: npm run bridge), then retry.',
    };
  }
}
