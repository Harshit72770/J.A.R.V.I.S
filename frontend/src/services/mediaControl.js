/**
 * Laptop media control — system volume and screen brightness.
 *
 * A browser can never touch system audio or the panel backlight, so every
 * change is executed by the desktop bridge (POST /media), which talks to a
 * resident PowerShell worker (bridge/media-worker.ps1) over Core Audio + WMI.
 *
 * This module also owns the shared UI state: the System Controls panel
 * subscribes here, so the percentages on screen update the instant a command
 * reply lands — no polling, no delay.
 */

const BRIDGE_URL = 'http://127.0.0.1:4777';

// Last known hardware state; null = not read yet (shows "—").
let state = { volume: null, muted: null, brightness: null };
const listeners = new Set();

export const getMediaState = () => state;

/** Subscribe to state changes; returns the unsubscribe function. */
export function subscribeMedia(listener) {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

/** Merge a bridge reply into the store and notify subscribers. */
export function applyMediaState(next) {
  if (!next) return;
  const merged = {
    volume:
      typeof next.volume === 'number' ? next.volume : state.volume,
    muted: typeof next.muted === 'boolean' ? next.muted : state.muted,
    brightness:
      typeof next.brightness === 'number'
        ? next.brightness
        : state.brightness,
  };
  if (
    merged.volume === state.volume &&
    merged.muted === state.muted &&
    merged.brightness === state.brightness
  ) {
    return;
  }
  state = merged;
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (e) {
      /* a bad subscriber must not break the rest */
    }
  });
}

/**
 * Run one media command through the bridge.
 * @param {'volume'|'brightness'} device
 * @param {'get'|'up'|'down'|'set'|'mute'|'unmute'|'toggle'} action
 * @param {number} [value] 0-100, only for action='set'
 * @returns {Promise<{ok:boolean, volume:number|null, muted:boolean|null,
 *                    brightness:number|null, error:string|null}>}
 */
export async function mediaCommand(device, action, value) {
  const controller = new AbortController();
  // First call wakes the PowerShell worker (~2s), later ones reply in ms.
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${BRIDGE_URL}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device, action, value }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = await res.json();
    if (json && json.ok) applyMediaState(json);
    return json && typeof json.ok === 'boolean'
      ? json
      : { ok: false, error: 'Desktop Bridge sent an unreadable reply.' };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      error:
        'Desktop Bridge offline — media control needs it (npm run bridge), then retry.',
    };
  }
}

/**
 * Fire-and-forget state refresh (also picks up volume changed outside JARVIS,
 * e.g. with the laptop's Fn keys). Never throws, never blocks the caller.
 */
export function refreshMediaState() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  fetch(`${BRIDGE_URL}/media`, { signal: controller.signal })
    .then((res) => res.json())
    .then((json) => {
      if (json && json.ok) applyMediaState(json);
    })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}
