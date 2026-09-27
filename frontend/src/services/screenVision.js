/**
 * Screen Vision — consent-gated screen capture for J.A.R.V.I.S.
 *
 * Privacy model (the whole point of the bottom-left SCREEN VISION switch):
 *   - Nothing is captured until the user flips the switch ON. Flipping it
 *     calls getDisplayMedia, which Chrome only allows from a real click and
 *     always covers with its own "Share this screen" picker.
 *   - Flipping OFF (or Chrome's own Stop sharing bar, or the source window
 *     closing) stops every track immediately — no frame is kept anywhere.
 *   - A frame is encoded to JPEG only at the moment the user asks for it
 *     ("read the screen" / "explain this screen"), then handed to the caller.
 *   - The MediaStream lives here, not in React state, so re-renders can never
 *     duplicate, restart or leak the capture.
 *
 * The component subscribes for status; nothing else should hold references.
 */

let stream = null;
let videoEl = null;
let status = 'off'; // 'off' | 'starting' | 'live'
let lastError = null;
const listeners = new Set();

const snapshot = () => ({
  status,
  live: status === 'live',
  starting: status === 'starting',
  error: lastError,
  supported: !!(
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    navigator.mediaDevices.getDisplayMedia
  ),
});

const emit = () => {
  const snap = snapshot();
  listeners.forEach((fn) => {
    try {
      fn(snap);
    } catch (e) {
      /* a broken listener must never break capture */
    }
  });
};

/** Current status: { status, live, starting, error, supported }. */
export const getScreenVisionState = snapshot;

/** Subscribe to status changes; fires immediately with the current state. */
export const subscribeScreenVision = (listener) => {
  listeners.add(listener);
  try {
    listener(snapshot());
  } catch (e) {
    /* noop */
  }
  return () => listeners.delete(listener);
};

/**
 * Turn vision ON. Must be called from a user gesture (the switch click) —
 * the browser rejects getDisplayMedia without one, by design.
 */
export async function startScreenVision() {
  if (!snapshot().supported) {
    lastError =
      'Screen capture needs Chrome or Edge — this browser has no getDisplayMedia.';
    status = 'off';
    emit();
    throw new Error(lastError);
  }
  if (status === 'live') return true;

  status = 'starting';
  lastError = null;
  emit();

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 10, max: 15 } },
      audio: false,
    });
  } catch (err) {
    status = 'off';
    lastError =
      err && err.name === 'NotAllowedError'
        ? 'Screen share cancelled — SCREEN VISION stays OFF.'
        : `Screen share failed: ${(err && err.message) || 'unknown error'}`;
    emit();
    throw err;
  }

  // Hidden <video> that renders the capture so frames can be drawn to a
  // canvas on demand. Kept in module scope, never in React state.
  videoEl = document.createElement('video');
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.autoplay = true;
  videoEl.srcObject = stream;

  // Wait (bounded) for dimensions so the first grab is never a blank frame.
  await new Promise((resolve) => {
    if (videoEl.readyState >= 1) return resolve();
    videoEl.addEventListener('loadedmetadata', resolve, { once: true });
    setTimeout(resolve, 1500);
  });
  try {
    await videoEl.play();
  } catch (e) {
    /* muted autoplay is always allowed */
  }

  const track = stream.getVideoTracks()[0];
  if (track) {
    // The user pressed Chrome's "Stop sharing" bar, or the source closed.
    track.addEventListener('ended', () => stopScreenVision());
  }

  status = 'live';
  lastError = null;
  emit();
  return true;
}

/** Turn vision OFF and release every track immediately. */
export function stopScreenVision() {
  if (stream) {
    stream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch (e) {
        /* noop */
      }
    });
  }
  if (videoEl) {
    try {
      videoEl.srcObject = null;
    } catch (e) {
      /* noop */
    }
  }
  stream = null;
  videoEl = null;
  if (status !== 'off') {
    status = 'off';
    emit();
  }
}

export const isScreenVisionLive = () =>
  status === 'live' && !!stream && stream.active && !!videoEl;

/** The live MediaStream (for the component's preview), or null. */
export const getScreenVisionStream = () => stream;

/**
 * Encode the current frame as a JPEG data URL (downscaled to maxWidth so a
 * 4K screenshot never bloats the request). Throws when vision is not live.
 */
export function grabScreenFrame(options = {}) {
  if (!isScreenVisionLive()) throw new Error('Screen vision is OFF.');
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) {
    throw new Error('Screen frame is not ready yet — try again in a second.');
  }

  const maxWidth = options.maxWidth || 1600;
  const scale = Math.min(1, maxWidth / vw);
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', options.quality || 0.85);
  // Release the offscreen buffer right away — screenshots are big.
  canvas.width = 1;
  canvas.height = 1;
  return dataUrl;
}
