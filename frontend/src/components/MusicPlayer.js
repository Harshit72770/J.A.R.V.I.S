import React, { useEffect, useState } from 'react';
import './MusicPlayer.css';
import {
  getMusicState,
  subscribeMusic,
  refreshMusicState,
  musicCommand,
} from '../services/musicPlayer';

// ─── MUSIC PLAYER — compact panel directly below System Controls ────────────
// One source of truth: services/musicPlayer.js mirrors the bridge's GET/POST
// /music replies, and the BRIDGE always reads the real <video> element of the
// open YouTube watch page — so pausing in the YouTube tab flips this panel to
// paused too, and a song that ends advances the queue (spec §8, §10).
// Every visible control is implemented (spec §9) — nothing decorative.
const fmt = (totalSeconds) => {
  const t = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

function MusicPlayer() {
  const [state, setState] = useState(getMusicState());

  // Subscribe → the store starts its single bounded 1s poll while a track
  // is loaded, and stops it when the player goes idle (spec §11).
  useEffect(() => subscribeMusic(setState), []);
  // Pick up a video that is already playing (e.g. after an F5).
  useEffect(() => {
    refreshMusicState();
  }, []);

  const track = state.currentTrack;
  const pct =
    state.duration > 0
      ? Math.max(0, Math.min(100, (state.currentTime / state.duration) * 100))
      : 0;
  const canPrev = state.queueIndex > 0;
  const canNext =
    state.queueIndex >= 0 && state.queueIndex < state.queueLength - 1;

  const act = (action, extra) => {
    musicCommand({ action, ...extra }); // store applies the bridge reply
  };

  const seekFromClick = (e) => {
    if (!track || !state.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width)
    );
    act('seekTo', { seconds: Math.round(ratio * state.duration) });
  };

  return (
    <aside className="music-player" aria-label="Music player">
      <div className="sc-head">
        <span className="sc-head-led mp-led" />
        {track ? 'NOW PLAYING' : 'MUSIC PLAYER'}
      </div>

      {!track ? (
        <div className="mp-empty">🎵 No music playing</div>
      ) : (
        <>
          <div className="mp-track">
            {track.thumbnail ? (
              <img
                className="mp-thumb"
                src={track.thumbnail}
                alt=""
                draggable={false}
              />
            ) : (
              <div className="mp-thumb mp-thumb-ph">🎵</div>
            )}
            <div className="mp-meta">
              <div className="mp-title" title={track.title}>
                {track.title}
              </div>
              <div className="mp-channel">{track.channel || 'YouTube'}</div>
            </div>
          </div>

          <div
            className="mp-progress"
            onClick={seekFromClick}
            title="Click to seek"
          >
            <div className="mp-progress-fill" style={{ width: `${pct}%` }} />
            <span
              className="mp-progress-knob"
              style={{ left: `calc(${pct}% - 3px)` }}
            />
          </div>
          <div className="mp-times">
            <span>{fmt(state.currentTime)}</span>
            <span>{fmt(state.duration)}</span>
          </div>

          <div className="mp-controls">
            <button
              type="button"
              className="mp-btn"
              disabled={!canPrev}
              onClick={() => act('previous')}
              aria-label="Previous song"
              title="Previous song"
            >
              ⏮
            </button>
            <button
              type="button"
              className="mp-btn mp-btn-seek"
              onClick={() => act('seekBy', { seconds: -10 })}
              aria-label="Back 10 seconds"
              title="Back 10 seconds"
            >
              ↶10
            </button>
            <button
              type="button"
              className="mp-btn mp-play"
              onClick={() => act(state.isPlaying ? 'pause' : 'resume')}
              aria-label={state.isPlaying ? 'Pause' : 'Play'}
              title={state.isPlaying ? 'Pause' : 'Play'}
            >
              {state.isPlaying ? '⏸' : '▶'}
            </button>
            <button
              type="button"
              className="mp-btn mp-btn-seek"
              onClick={() => act('seekBy', { seconds: 10 })}
              aria-label="Forward 10 seconds"
              title="Forward 10 seconds"
            >
              10↷
            </button>
            <button
              type="button"
              className="mp-btn"
              disabled={!canNext}
              onClick={() => act('next')}
              aria-label="Next song"
              title="Next song"
            >
              ⏭
            </button>
          </div>

          {state.autoplayBlocked ? (
            <div className="mp-note">▶ Autoplay blocked — press ▶ to start</div>
          ) : null}
        </>
      )}

      {state.error ? <div className="mp-error">⚠ {state.error}</div> : null}
    </aside>
  );
}

export default MusicPlayer;
