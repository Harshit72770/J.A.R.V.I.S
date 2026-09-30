/**
 * Browser control client + short-term browser/search context.
 *
 * Browser actions run in J.A.R.V.I.S's controlled browser window through the
 * desktop bridge (POST /browser → bridge/browser-control.js, a whitelist of
 * controlled functions — no arbitrary shell or page JS).
 *
 * This module also owns the SHORT-TERM context that makes follow-ups work:
 *   last_search_query   "search google for NIT Raipur"
 *   last_search_results   → "open the first result"
 *   last_opened_url       → last tab J.A.R.V.I.S opened
 *   last_browser_action   → what happened most recently
 * Bounded on purpose (10 results, nothing else kept) — no unlimited history.
 */

const BRIDGE_URL = 'http://127.0.0.1:4777';
const MAX_SEARCH_RESULTS = 10;

let state = {
  last_search_query: '',
  last_search_results: [],
  last_opened_url: '',
  last_browser_action: null,
};
const listeners = new Set();

export const getBrowserContext = () => state;

/** Subscribe to context changes; returns the unsubscribe function. */
export function subscribeBrowserContext(listener) {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

function commit(patch) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (e) {
      /* a bad subscriber must not break the rest */
    }
  });
}

/** Remember a search (and its results) so follow-up commands can use them. */
export function recordBrowserSearch(query, results) {
  commit({
    last_search_query: String(query || '').slice(0, 200),
    last_search_results: (Array.isArray(results) ? results : []).slice(
      0,
      MAX_SEARCH_RESULTS
    ),
    last_browser_action: 'search',
  });
}

/** Remember the most recently opened URL. */
export function recordBrowserOpen(url) {
  commit({
    last_opened_url: String(url || ''),
    last_browser_action: 'open',
  });
}

// ─── Bridge transport (never throws) ────────────────────────────────────────
async function post(action, payload = {}) {
  const controller = new AbortController();
  // First command may launch the browser window — allow a little extra time.
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(`${BRIDGE_URL}/browser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
      signal: controller.signal,
    });
    const json = await res.json();
    return json && typeof json.ok === 'boolean'
      ? json
      : { ok: false, error: 'Desktop Bridge sent an unreadable reply.' };
  } catch (e) {
    return {
      ok: false,
      fallback: true,
      error:
        e && e.name === 'AbortError'
          ? 'The browser did not respond in time.'
          : 'Desktop Bridge offline — start bridge\\bridge-start.bat (or run: npm run bridge), then retry.',
    };
  } finally {
    clearTimeout(timer);
  }
}

// Last resort when the controlled window is unavailable: the same link
// opener the project already uses (bridge → default Chrome, else new tab).
async function plainOpen(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `${BRIDGE_URL}/open?kind=url&target=${encodeURIComponent(url)}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    const json = await res.json();
    if (json && json.ok) {
      return { ok: true, opened: url, via: json.via || 'default-browser' };
    }
  } catch (e) {
    /* fall through to window.open */
  }
  try {
    const win = window.open(url, '_blank');
    if (win) return { ok: true, opened: url, via: 'tab' };
  } catch (e) {
    /* popup blocked */
  }
  return {
    ok: false,
    error:
      'Could not open a new tab — start the desktop bridge (npm run bridge) and retry.',
  };
}

/** Open a URL in a new tab (controlled window first, plain tab as fallback). */
async function openInNewTab(url) {
  const r = await post('newTab', { url });
  if (r.ok) {
    recordBrowserOpen(r.opened);
    return r;
  }
  if (r.fallback) return plainOpen(url);
  return r;
}

/**
 * "Search Google for X" — opens the Google search in the controlled window
 * AND quietly retrieves organic results so "open the first result" works on
 * the next command (context only; the search itself never fails because of
 * the context lookup).
 */
export async function googleSearch(query) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { ok: false, error: 'The search query was empty.' };
  const r = await post('googleSearch', { query: q });
  if (r.ok) recordBrowserOpen(r.opened);
  try {
    const { searchWeb } = await import('./webSearch.js');
    const s = await searchWeb(q);
    recordBrowserSearch(q, s.ok ? s.results : []);
  } catch (e) {
    recordBrowserSearch(q, []);
  }
  if (!r.ok && r.fallback) {
    // Controlled window unavailable → plain Google tab (old behaviour).
    return plainOpen(
      `https://www.google.com/search?q=${encodeURIComponent(q)}`
    );
  }
  return r;
}

// ─── Official-site picker (§9: never guess a URL — pick from real results) ──
const OFFICIAL_BAD =
  /wikipedia\.org|wikidata|youtube\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|reddit\.com|shiksha|collegedunia|careers360|collegepravesh|ambitionbox|\blog\b|news/i;
const STOP_TOKENS = [
  'the',
  'official',
  'website',
  'site',
  'page',
  'www',
  'and',
  'for',
  'of',
  'ki',
];

function pickOfficialResult(results, target, lastQuery) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return null;
  const q = String(lastQuery || target || '').toLowerCase();
  const tokens = q
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP_TOKENS.includes(t));
  let best = null;
  let bestScore = -Infinity;
  for (const r of list) {
    if (!r || !r.url) continue;
    let host = '';
    try {
      host = new URL(r.url).hostname.replace(/^www\./, '');
    } catch (e) {
      continue;
    }
    let score = 0;
    if (OFFICIAL_BAD.test(host)) score -= 6;
    if (/\.(?:gov|edu|org|ac)$|\.(?:gov|edu|ac)\./.test(host)) score += 2;
    for (const t of tokens) {
      if (host.includes(t)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore > 0 ? best : null;
}

// ─── Voice-facing action dispatcher ─────────────────────────────────────────
/**
 * Execute one {type:'browser'} local action. Never throws.
 * Actions: back · forward · refresh · current · closeTab ·
 *          newTab · openResult · openOfficial
 */
export async function executeBrowserAction(action) {
  try {
    const a = action && action.action;
    switch (a) {
      case 'back':
      case 'forward':
      case 'refresh': {
        const r = await post(a);
        if (r.ok) commit({ last_browser_action: a });
        return r;
      }
      case 'current':
        return await post('current');

      case 'closeTab': {
        const r = await post('closeTab');
        if (r.ok) commit({ last_browser_action: 'closeTab' });
        return r;
      }

      case 'newTab': {
        if (!action.url) return { ok: false, error: 'No URL to open.' };
        return await openInNewTab(action.url);
      }

      case 'openResult': {
        const ctx = state;
        const results = ctx.last_search_results || [];
        if (!results.length) {
          return {
            ok: false,
            error:
              'I do not have recent search results — run a search first, Sir.',
          };
        }
        let index = action.index;
        if (index === 'last') index = results.length;
        index = Number(index);
        if (!Number.isInteger(index) || index < 1 || index > results.length) {
          return {
            ok: false,
            error: `That search returned ${results.length} result${
              results.length === 1 ? '' : 's'
            } — I can open 1 to ${results.length}.`,
          };
        }
        const pick = results[index - 1];
        const r = await openInNewTab(pick.url);
        if (r.ok) commit({ last_browser_action: 'openResult' });
        return r.ok ? { ...r, result: pick } : r;
      }

      case 'openOfficial': {
        const ctx = state;
        const target = String(action.target || ctx.last_search_query || '')
          .trim()
          .slice(0, 200);
        if (!target) {
          return { ok: false, error: 'Tell me which website to find, Sir.' };
        }
        // 1) Already have results for this target? Pick the official domain.
        let pick = null;
        if (
          !action.target ||
          ctx.last_search_query.toLowerCase().includes(target.toLowerCase())
        ) {
          pick = pickOfficialResult(
            ctx.last_search_results,
            target,
            ctx.last_search_query
          );
        }
        // 2) Not found → search for it (do NOT guess the URL), then pick.
        if (!pick) {
          const { searchWeb } = await import('./webSearch.js');
          const queries = [target, `${target} official website`];
          for (const q of queries) {
            const s = await searchWeb(q);
            if (s.ok && s.results.length) {
              recordBrowserSearch(q, s.results);
              pick = pickOfficialResult(s.results, q, q);
              if (pick) break;
            }
          }
        }
        if (!pick) {
          return {
            ok: false,
            error: `I could not find an official website for ${target}.`,
          };
        }
        const r = await openInNewTab(pick.url);
        if (r.ok) commit({ last_browser_action: 'openOfficial' });
        return r.ok ? { ...r, result: pick, official: pick } : r;
      }

      default:
        return { ok: false, error: `Unknown browser action: ${action}.` };
    }
  } catch (e) {
    return {
      ok: false,
      error: `Browser control failed: ${(e && e.message) || e}`,
    };
  }
}
