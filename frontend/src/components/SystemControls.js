import React, { useEffect, useState } from 'react';
import './SystemControls.css';
import {
  getMediaState,
  subscribeMedia,
  refreshMediaState,
} from '../services/mediaControl';

// ─── SYSTEM CONTROLS — top-right live readout ───────────────────────────────
// Shows current system volume and screen brightness. mediaControl owns the
// shared store: every bridge reply is applied there, so these percentages
// move the instant a voice/text command (or an Fn-key change picked up by
// the background refresh) lands — no polling loop.
function SystemControls() {
  const [state, setState] = useState(getMediaState());

  useEffect(() => subscribeMedia(setState), []);

  useEffect(() => {
    refreshMediaState();
  }, []);

  const vol = state.volume;
  const bri = state.brightness;

  return (
    <aside className="system-controls" aria-label="System controls">
      <div className="sc-head">
        <span className="sc-head-led" />
        SYSTEM CONTROLS
      </div>

      <div className="sc-row">
        <span className="sc-icon">🔊</span>
        <span className="sc-label">Volume:</span>
        <span className="sc-value">{vol === null ? '—' : `${vol}%`}</span>
        {state.muted ? <span className="sc-muted">MUTED</span> : null}
      </div>
      <div className="sc-bar">
        <div className="sc-fill" style={{ width: `${vol || 0}%` }} />
      </div>

      <div className="sc-row">
        <span className="sc-icon">☀️</span>
        <span className="sc-label">Brightness:</span>
        <span className="sc-value">{bri === null ? '—' : `${bri}%`}</span>
      </div>
      <div className="sc-bar">
        <div
          className="sc-fill sc-fill-bri"
          style={{ width: `${bri || 0}%` }}
        />
      </div>
    </aside>
  );
}

export default SystemControls;
