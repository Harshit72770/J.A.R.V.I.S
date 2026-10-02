/**
 * JARVIS DASHBOARD — real-time monitoring page (route /dashboard).
 *
 * Data is REAL (spec §2, §5, §7):
 *  - CPU / RAM / GPU / battery / disk / network → desktop bridge GET /stats
 *    (Node os APIs + cached WMI/nvidia-smi probes — never random numbers).
 *  - Core service status → bridge probes + local capability checks; services
 *    that do not exist in this build show "N/A", never a fake ONLINE.
 *  - Recent activity + session statistics → GET /activity, the ring of actual
 *    bridge requests; empty state is the literal "No recent activity".
 *  - Now Playing → the SAME shared music store and commands the existing
 *    Music Player panel uses (services/musicPlayer.js) — no second music
 *    system (§10).
 *
 * Safety (§11): every interval/subscription is cleaned up on unmount, polls
 * are bounded and failure-tolerant, and a bridge outage only flips the header
 * to OFFLINE — it can never crash J.A.R.V.I.S or the Home page.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  subscribeMusic,
  musicCommand,
} from '../services/musicPlayer';
import {
  fetchSystemStats,
  fetchDashboardActivity,
} from '../services/systemMonitor';
import './Dashboard.css';

const STATS_MS = 2000; // system poll — also the chart sample rate
const ACTIVITY_MS = 5000; // activity poll — cheap, bridge-only
const HISTORY_MAX = 30; // 30 x 2s ≈ the last 60 seconds (§3)

const pad2 = (n) => String(n).padStart(2, '0');

const fmtClock = (d) =>
  `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

const fmtDate = (d) =>
  d.toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

const fmtLogTime = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

const fmtDuration = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) return null;
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
};

const fmtMMSS = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
};

const pct = (v, suffix = '%') =>
  typeof v === 'number' && Number.isFinite(v) ? `${v}${suffix}` : 'N/A';

const KIND_ICON = {
  open: '💻',
  search: '🌐',
  ytsearch: '▶',
  browser: '🌐',
  music: '▶',
  media: '🔊',
  ai: '🎤',
};

const iconFor = (entry) => {
  if (entry.kind === 'open') return entry.label === 'Link opened' ? '🌐' : '💻';
  return KIND_ICON[entry.kind] || '⚡';
};

/* ── Small card shell (glass panel, same language as SystemControls) ─────── */
const Card = ({ label, value, sub, children, warn }) => (
  <section className="dk-card">
    <div className="dk-card-head">
      <span>{label}</span>
      <i className="dk-led" />
    </div>
    <div className={`dk-card-value${warn ? ' is-na' : ''}`}>{value}</div>
    <div className="dk-card-sub">{sub}</div>
    {children}
  </section>
);

/* ── Tiny sparkline for the metric cards (last 60s of ONE series) ────────── */
const Spark = ({ values, color, height = 30 }) => {
  const W = 140;
  const pts = [];
  (values || []).forEach((v, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    const x =
      W - ((values.length - 1 - i) * W) / Math.max(1, HISTORY_MAX - 1);
    const y = height - (Math.max(0, Math.min(100, v)) / 100) * (height - 3) - 1.5;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  return (
    <svg
      className="dk-spark"
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="1.4"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

/* ── Main performance chart: CPU / RAM / GPU over ~60 seconds ────────────── */
const CHART_W = 1000;
const CHART_H = 200;

const seriesPoints = (values) => {
  const pts = [];
  (values || []).forEach((v, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    const x =
      CHART_W - ((values.length - 1 - i) * CHART_W) / Math.max(1, HISTORY_MAX - 1);
    const y =
      CHART_H - (Math.max(0, Math.min(100, v)) / 100) * (CHART_H - 12) - 6;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  return pts.join(' ');
};

const PerfChart = ({ history }) => {
  const cpu = seriesPoints(history.map((s) => s.cpu));
  const ram = seriesPoints(history.map((s) => s.ram));
  const gpu = seriesPoints(history.map((s) => s.gpu));
  return (
    <svg
      className="dk-chart"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Live CPU, RAM and GPU usage for the last 60 seconds"
    >
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1="0"
          x2={CHART_W}
          y1={CHART_H * f}
          y2={CHART_H * f}
          className="dk-grid"
        />
      ))}
      <line x1="0" x2={CHART_W} y1={CHART_H - 1} y2={CHART_H - 1} className="dk-grid dk-grid-base" />
      {gpu && <polyline points={gpu} className="dk-line-gpu" />}
      {ram && <polyline points={ram} className="dk-line-ram" />}
      {cpu && <polyline points={cpu} className="dk-line-cpu" />}
    </svg>
  );
};

/* ── Core status row state glyphs (spec §4) ──────────────────────────────── */
const STATE_GLYPH = {
  ONLINE: '🟢 ONLINE',
  STARTING: '🟡 STARTING',
  OFFLINE: '🔴 OFFLINE',
  'N/A': '⚪ N/A',
};

export default function Dashboard() {
  const [now, setNow] = useState(() => new Date());
  const [stats, setStats] = useState(null);
  const [online, setOnline] = useState(null); // null = starting (first poll)
  const [activity, setActivity] = useState(null);
  const [history, setHistory] = useState([]);
  const [music, setMusic] = useState(null);

  // Wall clock for the header — cleared on unmount.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // System stats: bounded poll, abort-guarded, ignored after unmount.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await fetchSystemStats();
      if (!alive) return;
      if (s) {
        setStats(s);
        setOnline(true);
        setHistory((prev) => {
          const next = [
            ...prev,
            {
              cpu: s.cpu ? s.cpu.percent : null,
              ram: s.ram ? s.ram.percent : null,
              gpu: s.gpu ? s.gpu.percent : null,
            },
          ];
          return next.length > HISTORY_MAX
            ? next.slice(next.length - HISTORY_MAX)
            : next;
        });
      } else {
        setOnline(false); // real outage → OFFLINE, last values stay visible
      }
    };
    tick();
    const id = setInterval(tick, STATS_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Recent activity + session counters — cleaned up on unmount.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const a = await fetchDashboardActivity();
      if (alive) setActivity(a);
    };
    tick();
    const id = setInterval(tick, ACTIVITY_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Shared music store — subscribeMusic immediately pushes current state and
  // returns the unsubscribe fn, so the store's own 1s poll stops with us.
  useEffect(() => subscribeMusic(setMusic), []);

  // Local voice capabilities — real browser feature checks (not guesses).
  const hasRecognition = useMemo(
    () =>
      typeof window !== 'undefined' &&
      Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    []
  );
  const hasTTS = useMemo(
    () => typeof window !== 'undefined' && 'speechSynthesis' in window,
    []
  );

  const starting = online === null;
  const bridgeOk = online === true;
  const statusText = starting ? 'STARTING' : bridgeOk ? 'ONLINE' : 'OFFLINE';
  const services = (stats && stats.services) || null;

  const cpu = (stats && stats.cpu) || null;
  const ram = (stats && stats.ram) || null;
  const gpu = (stats && stats.gpu) || null;
  const battery = (stats && stats.battery) || null;
  const disk = (stats && stats.disk) || [];
  const net = (stats && stats.net) || null;
  const mainDisk = disk.length > 0 ? disk[0] : null;

  const histOf = (key) => history.map((s) => s[key]);
  const session = stats ? fmtDuration(stats.uptimeSec) : null;

  // ── JARVIS CORE STATUS — every row is a real probe or an honest N/A ──────
  const aiBrainState = bridgeOk
    ? services && services.groqKeyPresent
      ? 'ONLINE'
      : 'OFFLINE'
    : starting
    ? 'STARTING'
    : 'OFFLINE';
  const ollamaState = bridgeOk
    ? services && services.ollama
      ? 'ONLINE'
      : 'OFFLINE'
    : starting
    ? 'STARTING'
    : 'N/A'; // bridge down → the local probe cannot run
  const bridgeBackedState = starting ? 'STARTING' : bridgeOk ? 'ONLINE' : 'OFFLINE';

  const coreRows = [
    { name: 'AI BRAIN — GROQ', state: aiBrainState, note: 'LLM via desktop bridge' },
    { name: 'OLLAMA (LOCAL)', state: ollamaState, note: 'TCP probe 127.0.0.1:11434' },
    { name: 'VOICE INPUT — WEB SPEECH', state: hasRecognition ? 'ONLINE' : 'OFFLINE', note: 'Chrome SpeechRecognition' },
    { name: 'VOICE OUTPUT — SPEECH SYNTH', state: hasTTS ? 'ONLINE' : 'OFFLINE', note: 'window.speechSynthesis' },
    { name: 'WAKE WORD', state: 'N/A', note: 'no wake-word service in this build' },
    { name: 'SPEAKER VERIFICATION', state: 'N/A', note: 'no verification service in this build' },
    { name: 'WEB SEARCH', state: bridgeBackedState, note: 'bridge /search (DuckDuckGo)' },
    { name: 'BROWSER CONTROL', state: bridgeBackedState, note: 'bridge /browser + UIA worker' },
    { name: 'YOUTUBE CONTROL', state: bridgeBackedState, note: 'bridge /music' },
    { name: 'MEMORY / SQLITE', state: 'N/A', note: 'no SQLite store in this build' },
  ];

  // ── NOW PLAYING — same store/commands as the existing Music Player ───────
  const hasTrack = Boolean(music && (music.videoId || music.title));
  const duration = music && Number.isFinite(music.duration) ? music.duration : 0;
  const current = music && Number.isFinite(music.currentTime) ? music.currentTime : 0;
  const progress = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const runMusic = (action, extra) => {
    musicCommand(extra ? { action, ...extra } : { action }); // never throws
  };

  // ── ACTIVITY + SESSION STATS — real ring, real counters ──────────────────
  const entries = (activity && activity.entries) || [];
  const aStats = (activity && activity.stats) || null;
  const aSession = aStats ? fmtDuration((Date.now() - aStats.since) / 1000) : null;

  return (
    <div className="dashboard">
      {/* ── §1 DASHBOARD HEADER ─────────────────────────────────────────── */}
      <header className="dk-header">
        <div className="dk-title">
          <span className="dk-title-mark">◈</span>
          JARVIS DASHBOARD
        </div>
        <div className="dk-header-right">
          <span className={`dk-status dk-status--${statusText.toLowerCase()}`}>
            <i className="dk-status-dot" />
            {statusText}
          </span>
          <span className="dk-header-time">{fmtClock(now)}</span>
          <span className="dk-header-date">{fmtDate(now)}</span>
          <span className="dk-header-session">
            SESSION <b>{session || '—'}</b>
          </span>
        </div>
      </header>

      {/* ── §2 SYSTEM OVERVIEW ──────────────────────────────────────────── */}
      <div className="dk-cards">
        <Card
          label="CPU"
          value={pct(cpu && cpu.percent)}
          warn={!cpu || cpu.percent === null}
          sub={
            cpu
              ? `${cpu.cores || '?'} cores${cpu.model ? ' · ' + cpu.model.replace(/\s+/g, ' ').slice(0, 28) : ''}`
              : 'System information N/A'
          }
        >
          <Spark values={histOf('cpu')} color="#00f0ff" />
        </Card>

        <Card
          label="RAM"
          value={pct(ram && ram.percent)}
          warn={!ram || ram.percent === null}
          sub={
            ram
              ? `${ram.usedGB} / ${ram.totalGB} GB used`
              : 'System information N/A'
          }
        >
          <Spark values={histOf('ram')} color="#a855f7" />
        </Card>

        <Card
          label="GPU"
          value={pct(gpu && gpu.percent)}
          warn={!gpu || gpu.percent === null}
          sub={
            gpu && gpu.name
              ? `${gpu.name}${gpu.vramGB ? ` · ${gpu.vramGB} GB` : ''}`
              : 'GPU information N/A'
          }
        >
          <Spark values={histOf('gpu')} color="#2eff8b" />
        </Card>

        <Card
          label="BATTERY"
          value={battery ? `${battery.percent}%` : 'N/A'}
          warn={!battery}
          sub={
            battery
              ? `${battery.state}${battery.charging ? ' ⚡' : ''}`
              : 'Battery information unavailable'
          }
        />

        <Card
          label="DISK"
          value={pct(mainDisk && mainDisk.percent)}
          warn={!mainDisk}
          sub={
            mainDisk
              ? `${mainDisk.drive}: ${mainDisk.usedGB} / ${mainDisk.totalGB} GB${
                  disk.length > 1 ? ` · ${disk.length} drives` : ''
                }`
              : 'Disk information N/A'
          }
        />

        <Card
          label="NETWORK"
          value={
            net
              ? net.connected
                ? 'ONLINE'
                : 'OFFLINE'
              : 'N/A'
          }
          warn={!net}
          sub={
            net && net.connected
              ? `${net.interface || 'Adapter'}${net.ip ? ' · ' + net.ip : ''}`
              : net
              ? 'No active adapter'
              : 'Network information N/A'
          }
        />
      </div>

      {/* ── §3 SYSTEM PERFORMANCE ───────────────────────────────────────── */}
      <section className="dk-panel">
        <div className="dk-panel-head">
          <span>SYSTEM PERFORMANCE</span>
          <span className="dk-panel-sub">LIVE CPU / RAM / GPU · LAST 60 SECONDS</span>
        </div>
        <div className="dk-chart-wrap">
          {history.length > 1 ? (
            <PerfChart history={history} />
          ) : (
            <div className="dk-empty">Collecting baseline…</div>
          )}
        </div>
        <div className="dk-legend">
          <span className="dk-legend-item dk-legend-cpu">
            CPU <b>{pct(cpu && cpu.percent)}</b>
          </span>
          <span className="dk-legend-item dk-legend-ram">
            RAM <b>{pct(ram && ram.percent)}</b>
          </span>
          <span className="dk-legend-item dk-legend-gpu">
            GPU <b>{pct(gpu && gpu.percent)}</b>
          </span>
          <span className="dk-legend-note">sampled every {STATS_MS} ms</span>
        </div>
      </section>

      {/* ── §4 JARVIS CORE STATUS  |  §6 NOW PLAYING ─────────────────────── */}
      <div className="dk-row">
        <section className="dk-panel">
          <div className="dk-panel-head">
            <span>JARVIS CORE STATUS</span>
            <span className="dk-panel-sub">LIVE SERVICE PROBES</span>
          </div>
          <div className="dk-core-list">
            {coreRows.map((row) => (
              <div className="dk-core-row" key={row.name}>
                <span className="dk-core-name">{row.name}</span>
                <span className="dk-core-note">{row.note}</span>
                <span
                  className={`dk-core-state dk-core-state--${row.state
                    .toLowerCase()
                    .replace(/[^a-z]/g, '')}`}
                >
                  {STATE_GLYPH[row.state]}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="dk-panel">
          <div className="dk-panel-head">
            <span>NOW PLAYING</span>
            <span className="dk-panel-sub">SHARED MUSIC PLAYER STATE</span>
          </div>
          {!hasTrack ? (
            <div className="dk-empty">No media playing</div>
          ) : (
            <div className="dk-np">
              <div className="dk-np-track">
                {music.thumbnail ? (
                  <img
                    className="dk-np-thumb"
                    src={music.thumbnail}
                    alt=""
                    onError={(e) => {
                      e.currentTarget.style.visibility = 'hidden';
                    }}
                  />
                ) : (
                  <div className="dk-np-thumb dk-np-thumb-ph">🎵</div>
                )}
                <div className="dk-np-meta">
                  <div className="dk-np-title">{music.title || 'Untitled'}</div>
                  <div className="dk-np-channel">{music.channel || '—'}</div>
                </div>
                <span className="dk-np-state">
                  {music.isPlaying ? '▶ PLAYING' : '⏸ PAUSED'}
                </span>
              </div>

              <div className="dk-np-progress">
                <div
                  className="dk-np-progress-fill"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="dk-np-times">
                <span>{fmtMMSS(current)}</span>
                <span>{fmtMMSS(duration)}</span>
              </div>

              <div className="dk-np-controls">
                <button
                  className="dk-np-btn"
                  onClick={() => runMusic('previous')}
                  title="Previous track"
                >
                  ⏮
                </button>
                <button
                  className="dk-np-btn dk-np-btn-seek"
                  onClick={() => runMusic('seekBy', { seconds: -10 })}
                  title="Seek -10 seconds"
                >
                  ↶10
                </button>
                <button
                  className="dk-np-btn dk-np-play"
                  onClick={() => runMusic(music.isPlaying ? 'pause' : 'resume')}
                  title={music.isPlaying ? 'Pause' : 'Resume'}
                >
                  {music.isPlaying ? '⏸' : '▶'}
                </button>
                <button
                  className="dk-np-btn dk-np-btn-seek"
                  onClick={() => runMusic('seekBy', { seconds: 10 })}
                  title="Seek +10 seconds"
                >
                  10↷
                </button>
                <button
                  className="dk-np-btn"
                  onClick={() => runMusic('next')}
                  title="Next track"
                >
                  ⏭
                </button>
              </div>

              {music.error && <div className="dk-np-error">{music.error}</div>}
            </div>
          )}
        </section>
      </div>

      {/* ── §5 RECENT ACTIVITY  |  §7 SESSION STATISTICS ─────────────────── */}
      <div className="dk-row">
        <section className="dk-panel">
          <div className="dk-panel-head">
            <span>RECENT ACTIVITY</span>
            <span className="dk-panel-sub">REAL BRIDGE ACTIONS · LAST 10</span>
          </div>
          {entries.length === 0 ? (
            <div className="dk-empty">No recent activity</div>
          ) : (
            <div className="dk-act-list">
              {entries.map((e, i) => (
                <div className="dk-act-row" key={`${e.t}-${i}`}>
                  <span className="dk-act-time">{fmtLogTime(e.t)}</span>
                  <span className="dk-act-icon">{iconFor(e)}</span>
                  <span className="dk-act-body">
                    <b>{e.label}</b>
                    {e.detail ? <em>{e.detail}</em> : null}
                  </span>
                  <span
                    className={`dk-act-state ${e.ok ? 'is-ok' : 'is-err'}`}
                    title={e.ok ? 'Success' : 'Error'}
                  >
                    {e.ok ? '✓' : '✗'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="dk-panel">
          <div className="dk-panel-head">
            <span>SESSION STATISTICS</span>
            <span className="dk-panel-sub">COUNTED FROM REAL TRAFFIC</span>
          </div>
          <div className="dk-stats-grid">
            <div className="dk-stat">
              <span>COMMANDS</span>
              <b>{aStats ? aStats.total : '—'}</b>
            </div>
            <div className="dk-stat">
              <span>SUCCESS</span>
              <b className="is-ok">{aStats ? aStats.ok : '—'}</b>
            </div>
            <div className="dk-stat">
              <span>ERRORS</span>
              <b className="is-err">{aStats ? aStats.error : '—'}</b>
            </div>
            <div className="dk-stat">
              <span>SESSION</span>
              <b>{aSession || '—'}</b>
            </div>
          </div>
          <p className="dk-foot">
            Counts every real request routed through the desktop bridge since
            it started — commands answered without the bridge are not counted.
          </p>
        </section>
      </div>
    </div>
  );
}
