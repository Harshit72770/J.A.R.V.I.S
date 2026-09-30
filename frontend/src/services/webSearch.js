/**
 * Web search client — research queries go through the desktop bridge
 * (GET /search), which runs the free keyless engines in bridge/web-search.js.
 *
 * The Groq key never touches this module: the bridge owns the key, and the
 * search itself needs none at all.
 *
 * Returns { ok: true, query, provider, results: [{title,url,snippet,source}] }
 * or     { ok: false, error } — never throws, so a failed search can be
 * spoken as a failure instead of crashing the pipeline.
 */

const BRIDGE_URL = 'http://127.0.0.1:4777';

export async function searchWeb(query) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'The search query was empty.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(
      `${BRIDGE_URL}/search?q=${encodeURIComponent(q)}`,
      { signal: controller.signal }
    );
    const json = await res.json();
    if (json && json.ok && Array.isArray(json.results)) {
      return {
        ok: true,
        query: json.query || q,
        provider: json.provider || '',
        results: json.results,
      };
    }
    return {
      ok: false,
      error: (json && json.error) || 'The web search failed.',
    };
  } catch (e) {
    return {
      ok: false,
      error:
        e && e.name === 'AbortError'
          ? 'The web search timed out.'
          : 'The Desktop Bridge is offline — web search needs it (npm run bridge), then retry.',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * YouTube search (contextual flow: YouTube is the active site).
 * Same shape as searchWeb, source 'youtube' — free, keyless, no Google.
 */
export async function searchYouTube(query) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'The search query was empty.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(
      `${BRIDGE_URL}/ytsearch?q=${encodeURIComponent(q)}`,
      { signal: controller.signal }
    );
    const json = await res.json();
    if (json && json.ok && Array.isArray(json.results)) {
      return {
        ok: true,
        query: json.query || q,
        provider: json.provider || 'youtube',
        results: json.results,
      };
    }
    return {
      ok: false,
      error: (json && json.error) || 'The YouTube search failed.',
    };
  } catch (e) {
    return {
      ok: false,
      error:
        e && e.name === 'AbortError'
          ? 'The YouTube search timed out.'
          : 'The Desktop Bridge is offline — YouTube search needs it (npm run bridge).',
    };
  } finally {
    clearTimeout(timer);
  }
}
