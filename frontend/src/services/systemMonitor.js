/**
 * Dashboard data client — real system telemetry + real activity from the
 * desktop bridge (GET /stats, GET /activity).
 *
 * FREE (spec §13): talks only to the local bridge — no API key, no paid
 * service, no downloads. Never throws: a failed poll resolves to null so the
 * Dashboard can render OFFLINE / "N/A" instead of crashing the app (§11).
 */

const BRIDGE_URL = 'http://127.0.0.1:4777';

async function getJson(path, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE_URL}${path}`, {
      signal: controller.signal,
    });
    const json = await res.json();
    return json && json.ok !== false ? json : null;
  } catch (e) {
    // Bridge offline / timeout / invalid JSON → caller shows OFFLINE.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Real CPU/RAM/GPU/battery/disk/network snapshot, or null when offline. */
export const fetchSystemStats = () => getJson('/stats');

/** Last ~10 real bridge actions + session counters, or null when offline. */
export const fetchDashboardActivity = () => getJson('/activity');
