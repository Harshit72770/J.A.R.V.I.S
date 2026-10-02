/**
 * J.A.R.V.I.S Dashboard Monitor
 * =============================
 * Real system + activity telemetry behind GET /stats and GET /activity.
 *
 * Rules this module keeps (dashboard spec 2, 5, 7, 11):
 *  - REAL values only: CPU/RAM come from Node's os APIs, battery/disk/GPU/
 *    network from cached PowerShell (WMI / perf counters / nvidia-smi).
 *    Anything unavailable resolves to null and the UI shows "N/A" — never a
 *    demo, random or placeholder number.
 *  - Lazy + cached: PowerShell probes run at most once per TTL, so polling
 *    the dashboard costs one process spawn every 5-15 s, not one per request.
 *  - Never throws: a missing battery, GPU or perf counter is a normal result;
 *    a monitoring failure must never break a bridge request (spec 11).
 *  - Activity is an in-memory ring of ACTUAL bridge requests (open/search/
 *    browser/music/media/AI) plus real success/error counters — no fake
 *    entries are ever generated (spec 5).
 *
 * FREE (spec 13): zero npm dependencies, no API key, local OS only.
 */

const os = require('os');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const STARTED_AT = Date.now();
const GB = 1024 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round1 = (n) => Math.round(n * 10) / 10;

// ── CPU: busy%% from os.cpus() deltas between two reads ─────────────────────
// Windows has no cheap CPU counter in pure Node, so each /stats poll measures
// the delta since the previous poll (~2 s window) — real busy time, no deps.
let lastCpu = null;

function readCpu() {
  const cpus = os.cpus();
  let total = 0;
  let idle = 0;
  for (const c of cpus) {
    const t = (c && c.times) || {};
    total +=
      (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
    idle += t.idle || 0;
  }
  return { total, idle };
}

function cpuBetween(prev, cur) {
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (!Number.isFinite(dTotal) || dTotal <= 0) return null;
  const busy = ((dTotal - dIdle) / dTotal) * 100;
  return Math.max(0, Math.min(100, round1(busy)));
}

async function cpuPercent() {
  const prev = lastCpu;
  if (!prev) {
    // First read: establish a short baseline so the very first reply is real.
    const first = readCpu();
    await sleep(600);
    const cur = readCpu();
    lastCpu = cur;
    return cpuBetween(first, cur);
  }
  const cur = readCpu();
  lastCpu = cur;
  return cpuBetween(prev, cur);
}

// ── Cached async probes ─────────────────────────────────────────────────────
const cache = new Map();

function cached(key, ttlMs, producer) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) {
    return hit.val && typeof hit.val.then === 'function'
      ? hit.val
      : Promise.resolve(hit.val);
  }
  let val;
  try {
    val = producer();
  } catch (e) {
    val = Promise.resolve(null);
  }
  if (!val || typeof val.then !== 'function') val = Promise.resolve(val);
  val.catch(() => null); // a rejected probe must never surface as an error
  cache.set(key, { at: now, val });
  return val;
}

// One PowerShell spawn serves battery + disk + network (TTL 10 s).
function ps(script, timeoutMs) {
  return new Promise((resolve) => {
    if (!IS_WIN) {
      resolve('');
      return;
    }
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : String(stdout || ''))
    );
  });
}

const SYSINFO_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$b=Get-CimInstance Win32_Battery | Select-Object -First 1",
  "if($b){Write-Output ('BATTERY|'+[string]$b.EstimatedChargeRemaining+'|'+[string]$b.BatteryStatus)}",
  "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {Write-Output ('DISK|'+$_.DeviceID+'|'+[int]($_.Size/1GB)+'|'+[int]($_.FreeSpace/1GB))}",
  "$n=Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {$_.Status -eq 'Up'} | Select-Object -First 1",
  "if($n){Write-Output ('NET|UP|'+$n.Name)}else{Write-Output 'NET|DOWN|'}",
].join('\n');

function netFromInterfaces() {
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      const addrs = ifs[name] || [];
      for (const a of addrs) {
        const v4 = a.family === 'IPv4' || a.family === 4;
        if (!a.internal && v4) {
          return { connected: true, interface: name, ip: a.address || null };
        }
      }
    }
    return { connected: false, interface: null, ip: null };
  } catch (e) {
    return { connected: false, interface: null, ip: null };
  }
}

async function sysInfoProbe() {
  const res = { battery: null, disk: [], net: null };
  const text = await ps(SYSINFO_SCRIPT, 8000);
    const lines = String(text || '').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split('|');
      if (parts[0] === 'BATTERY') {
        const pct = Number(parts[1]);
        const status = Number(parts[2]);
        if (Number.isFinite(pct)) {
          const charging = [6, 7, 8, 9].indexOf(status) !== -1;
          const state =
            charging
              ? 'Charging'
              : status === 1
              ? 'Discharging'
              : status === 3
              ? 'Fully charged'
              : status === 2
              ? 'Plugged in'
              : 'Unknown';
          res.battery = { percent: pct, charging, state };
        }
      } else if (parts[0] === 'DISK') {
        const totalGB = Number(parts[2]);
        const freeGB = Number(parts[3]);
        if (Number.isFinite(totalGB) && totalGB > 0) {
          const usedGB = totalGB - freeGB;
          res.disk.push({
            drive: String(parts[1] || '').replace(':', ''),
            totalGB,
            freeGB,
            usedGB,
            percent: round1((usedGB / totalGB) * 100),
          });
        }
      } else if (parts[0] === 'NET') {
        res.net = {
          connected: parts[1] === 'UP',
          interface: parts[2] || null,
          ip: null,
        };
      }
    }
  return res;
}

// ── GPU: nvidia-smi when present, else WMI identity + perf-counter usage ───
let smiPath; // undefined = unchecked, null = not installed

function nvidiaSmiPath() {
  if (smiPath !== undefined) return smiPath;
  smiPath = null;
  try {
    const candidates = [
      process.env.ProgramW6432 &&
        path.join(
          process.env.ProgramW6432,
          'NVIDIA Corporation',
          'NVSMI',
          'nvidia-smi.exe'
        ),
      process.env.ProgramFiles &&
        path.join(
          process.env.ProgramFiles,
          'NVIDIA Corporation',
          'NVSMI',
          'nvidia-smi.exe'
        ),
      process.env.SystemRoot &&
        path.join(process.env.SystemRoot, 'System32', 'nvidia-smi.exe'),
    ].filter(Boolean);
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        smiPath = c;
        break;
      }
    }
  } catch (e) {
    smiPath = null;
  }
  return smiPath;
}

async function gpuInfoProbe() {
  if (!IS_WIN) return null;
  const smi = nvidiaSmiPath();
    if (smi) {
      const out = await ps(
        `& '${smi.replace(/'/g, "''")}' --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits`,
        4000
      );
      const line = String(out || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)[0];
      if (line) {
        const cols = line.split(',').map((s) => s.trim());
        if (cols.length >= 4) {
          const util = Number(cols[1]);
          const memUsed = Number(cols[2]);
          const memTotal = Number(cols[3]);
          return {
            name: cols[0] || null,
            percent: Number.isFinite(util) ? util : null,
            vramUsedGB:
              Number.isFinite(memUsed) && memUsed >= 0
                ? round1(memUsed / 1024)
                : null,
            vramGB:
              Number.isFinite(memTotal) && memTotal > 0
                ? round1(memTotal / 1024)
                : null,
            source: 'nvidia-smi',
          };
        }
      }
    }
    // Fallback: adapter identity from WMI, busiest GPU engine %% from the
    // Windows performance counters (real, and null when unavailable). The
    // 3D-engine pattern returns the same load with far fewer instances
    // (measured 1.8s vs 5.9s); the full pattern is the safety net.
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$g=Get-CimInstance Win32_VideoController | Where-Object {$_.Name -notlike '*Remote*' -and $_.Name -notlike '*Basic*'} | Select-Object -First 1",
      "$n=if($g){$g.Name}else{''}",
      "$u=''",
      "$c=Get-Counter '\\GPU Engine(pid_*_engtype_3D)\\Utilization Percentage' -ErrorAction SilentlyContinue",
      "if(-not $c){$c=Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue}",
      "if($c){$m=($c.CounterSamples | Measure-Object -Property CookedValue -Maximum).Maximum; if($null -ne $m){$u=[string][int][Math]::Round($m,0)}}",
      "Write-Output ('GPU|'+$n+'|'+$u)",
    ].join('\n');
    const out = await ps(script, 15000);
    const line = String(out || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.indexOf('GPU|') === 0)[0];
    if (!line) return null;
    const cols = line.split('|');
    const util = Number(cols[2]);
    return {
      name: cols[1] || null,
      percent: Number.isFinite(util)
        ? Math.max(0, Math.min(100, util))
        : null,
      vramUsedGB: null,
      vramGB: null,
      source: 'perf-counter',
    };
}

// ── Ollama probe: a real TCP connect to the local Ollama port ──────────────
function probePort(port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch (e) {
        /* ignore */
      }
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try {
      sock.connect(port, '127.0.0.1');
    } catch (e) {
      finish(false);
    }
  });
}

function ollamaOnline() {
  return cached('ollama', 5000, () => probePort(11434, 500)).then(
    (v) => Boolean(v)
  );
}

// ── Background refresher: the slow probes stay OFF the request path ────────
// /stats must reply in milliseconds (the dashboard polls every 2 s), so the
// PowerShell probes run in their own lazy loop and /stats only reads the
// freshest snapshot. Started on the first /stats call, and the loop stops
// itself 45 s after the last poll — no orphan timers while nobody watches.
const SYS_TTL = 10000;
const GPU_TTL = 5000;
const IDLE_STOP_MS = 45000;

let sysVal = null;
let gpuVal = null;
let lastPollAt = 0;
let sysLoopRunning = false;
let gpuLoopRunning = false;

async function runSysLoop() {
  sysLoopRunning = true;
  try {
    for (;;) {
      try {
        const v = await sysInfoProbe();
        if (v) sysVal = v;
      } catch (e) {
        /* keep the last good snapshot */
      }
      if (Date.now() - lastPollAt >= IDLE_STOP_MS) break;
      await sleep(SYS_TTL);
      if (Date.now() - lastPollAt >= IDLE_STOP_MS) break;
    }
  } finally {
    sysLoopRunning = false;
  }
}

async function runGpuLoop() {
  gpuLoopRunning = true;
  try {
    for (;;) {
      if (!IS_WIN) break;
      try {
        const v = await gpuInfoProbe();
        if (v || !gpuVal) gpuVal = v;
      } catch (e) {
        /* keep the last good snapshot */
      }
      if (Date.now() - lastPollAt >= IDLE_STOP_MS) break;
      await sleep(GPU_TTL);
      if (Date.now() - lastPollAt >= IDLE_STOP_MS) break;
    }
  } finally {
    gpuLoopRunning = false;
  }
}

function startRefreshers() {
  if (!sysLoopRunning) runSysLoop();
  if (!gpuLoopRunning && IS_WIN) runGpuLoop();
}

// ── GET /stats payload ─────────────────────────────────────────────────────
async function getStats() {
  lastPollAt = Date.now();
  startRefreshers();
  const cpu = await cpuPercent();
  const ollama = await ollamaOnline();
  const sys = sysVal || { battery: null, disk: [], net: null };
  const gpu = gpuVal;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  let cores = 0;
  let model = null;
  try {
    const list = os.cpus();
    cores = list.length;
    model = list[0] && list[0].model ? String(list[0].model).trim() : null;
  } catch (e) {
    /* keep defaults */
  }
  const netInfo = sys.net || netFromInterfaces();
  if (netInfo && !netInfo.ip) {
    const fallbackIp = netFromInterfaces();
    if (fallbackIp.connected) netInfo.ip = fallbackIp.ip;
  }
  return {
    ok: true,
    t: Date.now(),
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    cpu: { percent: cpu, cores, model },
    ram: {
      totalGB: round1(totalMem / GB),
      usedGB: round1(usedMem / GB),
      freeGB: round1(freeMem / GB),
      percent: totalMem > 0 ? round1((usedMem / totalMem) * 100) : null,
    },
    gpu,
    battery: sys.battery,
    disk: sys.disk,
    net: netInfo,
    services: { ollama: Boolean(ollama) },
  };
}

// ── Activity ring + real counters (spec 5, 7) ──────────────────────────────
const ACTIVITY_CAP = 40;
const activity = []; // newest first
const counters = { total: 0, ok: 0, error: 0 };
const lastByKey = new Map(); // dedupe windows for bursty kinds (ai)

function logActivity(entry) {
  try {
    const e = entry || {};
    const now = Date.now();
    const key = e.dedupeKey || e.kind || 'action';
    if (e.dedupeMs > 0) {
      const last = lastByKey.get(key) || 0;
      if (now - last < e.dedupeMs) return;
      lastByKey.set(key, now);
    }
    counters.total += 1;
    if (e.ok === false) counters.error += 1;
    else counters.ok += 1;
    activity.unshift({
      t: now,
      kind: String(e.kind || 'action'),
      label: String(e.label || 'Action'),
      detail: String(e.detail || '').slice(0, 140),
      ok: e.ok !== false,
    });
    if (activity.length > ACTIVITY_CAP) activity.length = ACTIVITY_CAP;
  } catch (err) {
    // Logging must never break the request it is logging.
  }
}

/**
 * Real AI traffic: the bridge is the only path to the LLM, so a completed
 * /groq request IS the user command (model + last user text as description).
 * bodyBuffer may be a multi-MB vision payload — parse only small JSON bodies.
 */
function logAi(status, bodyBuffer, errorMsg) {
  try {
    const ok = Number(status) < 400;
    let detail = '';
    if (ok && bodyBuffer && bodyBuffer.length) {
      if (bodyBuffer.length > 512 * 1024) {
        detail = 'Screen vision request';
      } else {
        try {
          const parsed = JSON.parse(String(bodyBuffer));
          const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
          let lastUser = '';
          for (let i = msgs.length - 1; i >= 0; i -= 1) {
            const m = msgs[i];
            if (m && m.role === 'user') {
              lastUser = m.content;
              break;
            }
          }
          let text = '';
          if (typeof lastUser === 'string') {
            text = lastUser;
          } else if (Array.isArray(lastUser)) {
            const part = lastUser.find(
              (p) => p && typeof p.text === 'string'
            );
            text = part ? part.text : 'Screen vision request';
          }
          text = String(text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 90);
          detail = [parsed.model || '', text].filter(Boolean).join(' · ');
        } catch (parseErr) {
          detail = 'Chat completion';
        }
      }
    }
    logActivity({
      kind: 'ai',
      label: ok ? 'User command (AI)' : 'AI request failed',
      detail: detail || (ok ? '' : String(errorMsg || `HTTP ${status}`)),
      ok,
      dedupeKey: 'ai',
      dedupeMs: 1500,
    });
  } catch (err) {
    // never throw
  }
}

function getActivity() {
  return {
    ok: true,
    entries: activity.slice(0, 10),
    stats: {
      total: counters.total,
      ok: counters.ok,
      error: counters.error,
      since: STARTED_AT,
    },
  };
}

module.exports = { getStats, getActivity, logActivity, logAi };
