import React, { useEffect, useRef, useState } from 'react';
import './ScreenVision.css';
import {
  getScreenVisionState,
  getScreenVisionStream,
  subscribeScreenVision,
  startScreenVision,
  stopScreenVision,
} from '../services/screenVision';

/**
 * SCREEN VISION — the bottom-left master switch.
 *
 * ON  : opens Chrome's screen-share picker (only a click can grant that),
 *       shows a live preview and lets voice commands read/explain the screen.
 * OFF : stops every capture track — Jarvis can no longer see anything.
 *
 * The component only mirrors the capture service; the MediaStream itself
 * lives there so React re-renders can never leak or duplicate it.
 */
const ScreenVision = () => {
  const [state, setState] = useState(() => getScreenVisionState());
  const videoRef = useRef(null);

  useEffect(() => subscribeScreenVision(setState), []);

  // Let other fixed panels dodge us (the digital clock docks bottom-left on
  // narrow windows and would otherwise sit on top of this switch).
  useEffect(() => {
    document.body.classList.toggle('sv-panel-live', state.live);
    return () => document.body.classList.remove('sv-panel-live');
  }, [state.live]);

  // Attach/detach the live stream to the preview <video> imperatively.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const next = state.live ? getScreenVisionStream() : null;
    if (v.srcObject !== next) v.srcObject = next;
    if (next) v.play().catch(() => {});
  }, [state.live]);

  // Safety: never keep the screen shared if the HUD unmounts.
  useEffect(() => () => stopScreenVision(), []);

  const live = state.live;
  const starting = state.starting;

  const handleToggle = async () => {
    if (live || starting) {
      stopScreenVision();
      return;
    }
    try {
      await startScreenVision();
    } catch (e) {
      /* state.error already carries the reason for the hint line */
    }
  };

  const hint = live
    ? 'Say: "read the screen" / "explain this screen"'
    : starting
    ? 'Waiting for screen-share permission…'
    : state.error || 'Switch ON to let Jarvis see your screen';

  return (
    <div
      className={`screen-vision-panel${live ? ' is-live' : ''}${
        !live && state.error ? ' has-error' : ''
      }`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={live}
        aria-label="Screen vision"
        className="sv-switch"
        onClick={handleToggle}
        title={
          live
            ? 'Screen vision ON — click to stop Jarvis seeing your screen'
            : 'Allow Jarvis to see your screen'
        }
      >
        <span className="sv-led" aria-hidden="true" />
        <span className="sv-title">SCREEN VISION</span>
        <span className="sv-state">{live ? 'ON' : starting ? '···' : 'OFF'}</span>
      </button>

      {live && (
        <div className="sv-preview" aria-hidden="true">
          <video ref={videoRef} autoPlay muted playsInline />
          <span className="sv-preview-tag">
            <i className="sv-preview-dot" /> LIVE
          </span>
        </div>
      )}

      <p className="sv-hint">{hint}</p>
    </div>
  );
};

export default ScreenVision;
