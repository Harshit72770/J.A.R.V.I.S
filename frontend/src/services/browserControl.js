/**
 * Browser control client + short-term contexts.
 *
 * Browser actions run in J.A.R.V.I.S's controlled browser window through the
 * desktop bridge (POST /browser → bridge/browser-control.js, a whitelist of
 * controlled functions — no arbitrary shell or page JS). Ordinary link opens
 * (YouTube, "open google", websites) still go through the plain bridge
 * /open path — no Google automation anywhere except an explicit
 * "search google for X", where the bridge DETECTS CAPTCHA and stops
 * gracefully (never solves, bypasses, or retries it).
 *
 * TWO SEPARATE CONTEXTS — never mixed (spec):
 *   browser context: active_browser · active_tab · active_site ·
 *                    last_browser_action
 *   web-search context: last_search_query · last_search_results ·
 *                    last_search_source   (results capped at 10)
 */

const BRIDGE_URL = 'http://127.0.0.1:4777';
const MAX_SEARCH_RESULTS = 10;

// ── Browser context (what window/tab/site is active) ────────────────────────
let browserState = {
  active_browser: null, // 'jarvis-browser' | 'chrome' | 'hud-tab' | …
  active_tab: null, // URL of the most recent tab we opened/acted on
  active_site: null, // 'youtube' | 'google' | <hostname> — context for follow-ups
  last_browser_action: null,
};
const browserListeners = new Set();

// ── Web-search context (what was searched — web or YouTube) ─────────────────
let searchState = {
  last_search_query: '',
  last_search_results: [], // [{title,url,snippet,source}] capped
  last_search_source: null, // provider name | 'google' | 'youtube' | …
};
const searchListeners = new Set();

export const getBrowserContext = () => browserState;
export const getSearchContext = () => searchState;

/** Subscribe to browser-context changes; returns the unsubscribe function. */
export function subscribeBrowserContext(listener) {
  browserListeners.add(listener);
  listener(browserState);
  return () => browserListeners.delete(listener);
}

/** Subscribe to web-search-context changes; returns the unsubscribe function. */
export function subscribeSearchContext(listener) {
  searchListeners.add(listener);
  listener(searchState);
  return () => searchListeners.delete(listener);
}

function notify(set, next) {
  set.forEach((fn) => {
    try {
      fn(next);
    } catch (e) {
      /* a bad subscriber must not break the rest */
    }
  });
}

// youtube.com / youtu.be → 'youtube'; google.* → 'google'; else hostname.
function siteOf(url) {
  try {
    let s = String(url || '').trim();
    if (s && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`; // bare host
    const host = new URL(s).hostname.replace(/^www\./, '');
    if (/(^|\.)youtube\.com$/.test(host) || /(^|\.)youtu\.be$/.test(host)) {
      return 'youtube';
    }
    if (/(^|\.)google\.[a-z.]+$/.test(host)) return 'google';
    return host;
  } catch (e) {
    return null;
  }
}

// Watch/shorts/live/youtu.be links only — these are what the music tool
// plays in place instead of opening a second tab.
const isYoutubeVideoUrl = (u) =>
  /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?|shorts\/|live\/)|youtu\.be\/)/i.test(
    String(u || '')
  );

const browserLabel = (via) =>
  via === 'jarvis-browser'
    ? 'jarvis-browser'
    : via === 'tab'
    ? 'hud-tab'
    : via || 'chrome';

/** Record a browser action (updates active_tab/active_site when a URL applies). */
export function recordBrowserAction(action, url, via) {
  browserState = {
    ...browserState,
    ...(url
      ? { active_tab: String(url).slice(0, 2048), active_site: siteOf(url) }
      : {}),
    ...(via ? { active_browser: browserLabel(via) } : {}),
    last_browser_action: action,
  };
  notify(browserListeners, browserState);
}

/** Record the most recently opened URL (browser context only). */
export function recordBrowserOpen(url, via) {
  recordBrowserAction('open', url, via);
}

/**
 * Record a WEB-SEARCH (not browser) — search context only, never touches
 * browser state (spec: do not mix the two).
 */
export function recordSearchContext(query, results, source) {
  searchState = {
    last_search_query: String(query || '').slice(0, 200),
    last_search_results: (Array.isArray(results) ? results : []).slice(
      0,
      MAX_SEARCH_RESULTS
    ),
    last_search_source: source || null,
  };
  notify(searchListeners, searchState);
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
    recordBrowserAction('newTab', r.opened, 'jarvis-browser');
    return r;
  }
  if (r.fallback) {
    const plain = await plainOpen(url);
    if (plain.ok) recordBrowserAction('newTab', plain.opened, plain.via);
    return plain;
  }
  return r;
}

/**
 * Quiet context retrieval via the web_search tool (HTTP only — NEVER a
 * Google browser search) so follow-ups like "open the first result" work.
 */
async function quietContextSearch(q, source) {
  try {
    const { searchWeb, searchYouTube } = await import('./webSearch.js');
    const s = source === 'youtube' ? await searchYouTube(q) : await searchWeb(q);
    recordSearchContext(q, s.ok ? s.results : [], s.ok ? s.provider : source);
  } catch (e) {
    recordSearchContext(q, [], source);
  }
}

/**
 * Lazily (re)load stored search results when the context holds only the
 * query (e.g. "search for Arijit Singh" while YouTube was active).
 */
async function resolveSearchResults() {
  if (searchState.last_search_results.length) {
    return searchState.last_search_results;
  }
  const q = searchState.last_search_query;
  if (!q) return [];
  try {
    const { searchWeb, searchYouTube } = await import('./webSearch.js');
    const s =
      searchState.last_search_source === 'youtube'
        ? await searchYouTube(q)
        : await searchWeb(q);
    if (s.ok && s.results.length) {
      recordSearchContext(q, s.results, s.provider || searchState.last_search_source);
      return s.results;
    }
  } catch (e) {
    /* fall through → empty */
  }
  return [];
}

/**
 * "Search Google for X" — EXPLICIT Google searches only. Runs in the
 * controlled window; if Google serves a CAPTCHA the bridge returns
 * {captcha:true} and we STOP GRACEFULLY (no retry, no second tab, no
 * context recording). Context for follow-ups comes from the free
 * web_search tool, not from Google automation.
 */
export async function googleSearch(query) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { ok: false, error: 'The search query was empty.' };
  const r = await post('googleSearch', { query: q });
  if (r.ok) recordBrowserAction('googleSearch', r.opened, 'jarvis-browser');
  // Context comes from the web_search tool (never Google) — recorded even
  // when Google refused or challenged us, so follow-ups like "open the
  // first link" work right after an explicit Google search.
  await quietContextSearch(q, null);
  if (r.ok) return r;
  if (r.captcha) return r; // ← detected: tell the user, do NOT retry
  if (r.fallback) {
    // Controlled window unavailable → plain Google tab (no automation at all).
    const plain = await plainOpen(
      `https://www.google.com/search?q=${encodeURIComponent(q)}`
    );
    if (plain.ok) recordBrowserAction('googleSearch', plain.opened, plain.via);
    return plain;
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
        if (r.ok) recordBrowserAction(a, r.url || null);
        return r;
      }
      case 'current': {
        const r = await post('current');
        if (r.ok) recordBrowserAction('current', r.url || null);
        return r;
      }

      case 'closeTab': {
        const r = await post('closeTab');
        if (r.ok) {
          // Which tab is now active? (keeps active_tab honest after closing)
          const now = await post('current');
          recordBrowserAction('closeTab', now.ok ? now.url : null);
        }
        return r;
      }

      case 'newTab': {
        if (!action.url) return { ok: false, error: 'No URL to open.' };
        return await openInNewTab(action.url);
      }

      case 'openResult': {
        const results = await resolveSearchResults();
        if (!results.length) {
          return {
            ok: false,
            error: searchState.last_search_query
              ? 'I could not retrieve recent search results — run a search again, Sir.'
              : 'I do not have recent search results — run a search first, Sir.',
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
        // YouTube videos play IN PLACE through the music tool: the existing
        // YouTube tab is reused → one window, one tab, one audio stream
        // (§11/§17), and the Music Player picks the track up immediately.
        if (isYoutubeVideoUrl(pick.url)) {
          try {
            const { musicCommand } = await import('./musicPlayer.js');
            const r = await musicCommand({
              action: 'playUrl',
              url: pick.url,
              queue: results,
              index,
            });
            if (r.ok) {
              recordBrowserAction('openResult', pick.url, 'jarvis-browser');
              return { ...r, result: pick };
            }
            if (!r.fallback) return r; // real failure — report, no extra tab
          } catch (e) {
            /* fall through to the ordinary opener */
          }
        }
        const r = await openInNewTab(pick.url);
        if (r.ok) recordBrowserAction('openResult', r.opened);
        return r.ok ? { ...r, result: pick } : r;
      }

      case 'openOfficial': {
        const target = String(action.target || searchState.last_search_query || '')
          .trim()
          .slice(0, 200);
        if (!target) {
          return { ok: false, error: 'Tell me which website to find, Sir.' };
        }
        // 1) Already have results for this target? Pick the official domain.
        let pick = null;
        if (
          !action.target ||
          searchState.last_search_query
            .toLowerCase()
            .includes(target.toLowerCase())
        ) {
          pick = pickOfficialResult(
            searchState.last_search_results,
            target,
            searchState.last_search_query
          );
        }
        // 2) Not found → search for it (do NOT guess the URL), then pick.
        if (!pick) {
          const { searchWeb } = await import('./webSearch.js');
          const queries = [target, `${target} official website`];
          for (const q of queries) {
            const s = await searchWeb(q);
            if (s.ok && s.results.length) {
              recordSearchContext(q, s.results, s.provider);
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
        if (r.ok) recordBrowserAction('openOfficial', r.opened);
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
