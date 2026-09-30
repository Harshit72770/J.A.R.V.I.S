/**
 * J.A.R.V.I.S — Web Search Tool (research)
 * ========================================
 * The Node equivalent of the requested tools/web_search.py.
 *
 *   searchWeb(query) →
 *     { query, provider, results: [{ title, url, snippet, source }] }
 *
 * Design rules:
 *  - FREE: every provider below is keyless — no API key, no quota, no cost,
 *    no subscription. Nothing here ever talks to a paid service.
 *  - ABSTRACT: engines live in the `providers` map and are chained by
 *    `providerChain()`, so the provider can be swapped or reordered later
 *    without touching callers (env SEARCH_PROVIDER pins the first choice).
 *  - HONEST: a failed or empty search THROWS — this tool never fabricates
 *    results and never answers from memory. Callers report the failure.
 *
 * Chain (first provider with results wins; 202/captcha responses count as
 * failures and fall through immediately):
 *   everyday queries : ddg-lite → ddg-html → bing-rss → gnews-rss
 *   news-like queries: ddg-lite → ddg-html → gnews-rss → bing-rss
 */

const https = require('https');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 9000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_QUERY = 200;
const MAX_RESULTS = 8;

// ─── HTTP ───────────────────────────────────────────────────────────────────
function fetchHtml(url, redirectLeft = 2) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, body) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(body);
    };
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'en-US,en;q=0.9',
        },
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          if (redirectLeft <= 0) {
            done(new Error('The search provider redirected too many times.'));
            return;
          }
          let next;
          try {
            next = new URL(res.headers.location, url).href;
          } catch (e) {
            done(new Error('The search provider sent a bad redirect.'));
            return;
          }
          fetchHtml(next, redirectLeft - 1).then(
            (b) => done(null, b),
            (e) => done(e)
          );
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          done(
            new Error(`The search provider returned HTTP ${res.statusCode}.`)
          );
          return;
        }
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > MAX_BYTES) {
            res.destroy();
            done(new Error('The search response was too large.'));
          }
        });
        res.on('end', () => done(null, body));
        res.on('error', (e) => done(e));
      }
    );
    req.on('error', (e) =>
      done(new Error(`Could not reach the search provider (${e.message}).`))
    );
    req.setTimeout(TIMEOUT_MS, () =>
      req.destroy(new Error('The search provider timed out.'))
    );
  });
}

// ─── Shared text / URL helpers ──────────────────────────────────────────────
const decodeEntities = (s) =>
  String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    )
    .replace(/&amp;/g, '&');

const stripTags = (s) =>
  decodeEntities(String(s || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const sourceOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
};

// DuckDuckGo wraps result links as //duckduckgo.com/l/?uddg=<encoded target>.
// Anything that is not http(s) after resolution is dropped.
function resolveHref(href) {
  const h = decodeEntities(String(href || '').trim());
  if (!h) return null;
  try {
    const u = new URL(h, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    const final = uddg ? new URL(uddg) : u;
    if (final.protocol !== 'http:' && final.protocol !== 'https:') return null;
    if (!final.hostname || /\s/.test(final.hostname)) return null;
    return final.href;
  } catch (e) {
    return null;
  }
}

// ─── DuckDuckGo HTML parsing (anchors + snippets zipped by position) ───────
function parseDdgResults(html) {
  const anchors = [];
  const aRe = /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(html))) {
    const url = resolveHref(m[1]);
    const title = stripTags(m[2]);
    if (!url || !title) continue;
    anchors.push({ pos: m.index, end: m.index + m[0].length, url, title });
  }

  const snippets = [];
  const sRe =
    /<(?:td|div|span|p|a)\b[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:td|div|span|p|a)>/gi;
  while ((m = sRe.exec(html))) {
    snippets.push({ pos: m.index, text: stripTags(m[1]) });
  }

  const results = [];
  const seen = new Set();
  for (let i = 0; i < anchors.length && results.length < MAX_RESULTS; i++) {
    const a = anchors[i];
    const host = sourceOf(a.url);
    if (host === 'duckduckgo.com') continue;
    if (seen.has(a.url)) continue;
    seen.add(a.url);
    const nextPos = i + 1 < anchors.length ? anchors[i + 1].pos : Infinity;
    const sn = snippets.find((s) => s.pos > a.end && s.pos < nextPos);
    results.push({
      title: a.title,
      url: a.url,
      snippet: sn ? sn.text : '',
      source: host,
    });
  }
  return results;
}

// ─── RSS parsing (Bing web search RSS + Google News RSS) ───────────────────
function parseRssResults(xml) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  const results = [];
  const seen = new Set();
  for (const item of items) {
    if (results.length >= MAX_RESULTS) break;
    const grab = (tag) => {
      const m = item.match(
        new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
      );
      if (!m) return '';
      return decodeEntities(
        m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '')
      ).trim();
    };
    const title = stripTags(grab('title'));
    let url = grab('link');
    // Google News links redirect to the publisher in the browser; prefer the
    // real article URL when the feed exposes one directly.
    const inlineLink = item.match(/<link[^>]*href="(https?:[^"]+)"/i);
    if (inlineLink) url = decodeEntities(inlineLink[1]);
    const snippet = stripTags(grab('description'));
    if (!title || !url) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    // <source url="https://publisher">Name</source> (Google News) beats the
    // news.google.com redirect host when present.
    const src = item.match(/<source[^>]*url="([^"]+)"/i);
    results.push({
      title,
      url,
      snippet,
      source: src ? sourceOf(src[1]) : sourceOf(url),
    });
  }
  return results;
}

// ─── Providers (free, keyless, replaceable) ─────────────────────────────────
const providers = {
  // https://lite.duckduckgo.com/lite/?q= — minimal HTML, no JS, no key.
  async 'ddg-lite'(query) {
    const html = await fetchHtml(
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
    );
    return parseDdgResults(html);
  },

  // https://html.duckduckgo.com/html/?q= — richer markup, also keyless.
  async 'ddg-html'(query) {
    const html = await fetchHtml(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    );
    return parseDdgResults(html);
  },

  // Bing's keyless RSS endpoint (web results, XML, always reachable).
  async 'bing-rss'(query) {
    const xml = await fetchHtml(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`
    );
    return parseRssResults(xml);
  },

  // Google News RSS — keyless; strongest for news / recency questions.
  async 'gnews-rss'(query) {
    const xml = await fetchHtml(
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`
    );
    return parseRssResults(xml);
  },
};

// Queries asking about fresh events → put the news engine first among the
// fallbacks (and Bing first for evergreen / tool-seeking queries).
const NEWSY =
  /\b(news|headlines|latest|today|tonight|recent|score|scores|result|results|won|winner|match|election|price|weather|update|updates)\b|इंटरनेट|ताजा|खबर/i;

/**
 * Search the web. Throws when every provider fails or returns nothing —
 * callers decide how to report it (the HUD says the search failed rather
 * than inventing an answer).
 *
 * Primary engines (DuckDuckGo family) are tried one by one for quality. If
 * they are unavailable (rate limit / outage), BOTH fallback engines are run
 * and their results merged: Bing is strong for evergreen queries, Google
 * News is entity-safe for current events — merging keeps either failure mode
 * from poisoning the answer.
 */
async function searchWeb(query) {
  const q = String(query || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY);
  if (!q) throw new Error('The search query was empty.');

  const envPick = process.env.SEARCH_PROVIDER;
  const primary = [envPick, 'ddg-lite', 'ddg-html'].filter(
    (name, i, arr) => providers[name] && arr.indexOf(name) === i
  );
  const fallback = NEWSY.test(q)
    ? ['gnews-rss', 'bing-rss']
    : ['bing-rss', 'gnews-rss'];

  let lastError = null;
  for (const name of primary) {
    try {
      const results = await providers[name](q);
      if (results.length) return { query: q, provider: name, results };
      lastError = new Error('The search provider returned no results.');
    } catch (e) {
      lastError = e;
    }
  }

  // Primary engines unavailable → merge the fallback engines.
  const merged = [];
  const seen = new Set();
  for (const name of fallback) {
    try {
      const results = await providers[name](q);
      for (const r of results) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        merged.push(r);
      }
      lastError = null;
    } catch (e) {
      lastError = e;
    }
    if (merged.length >= 12) break;
  }
  if (merged.length) {
    return {
      query: q,
      provider: fallback.join('+'),
      results: merged.slice(0, 12),
    };
  }
  throw lastError || new Error('Web search failed.');
}

/**
 * YouTube search (free, keyless) — supports the contextual YouTube flow:
 * "search for X" while YouTube is the active site → structured video results,
 * so "play the first result" can open the exact video without any Google
 * automation.
 *
 *   searchYouTube(query) → { query, provider: 'youtube', results: [...] }
 * Same {title,url,snippet,source} shape as searchWeb — plain HTTP fetch of
 * the public results page (no API key, no cost, no browser).
 */
const unescapeJson = (s) =>
  String(s || '')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003d/g, '=')
    .replace(/\\u0025/g, '%')
    .replace(/\\u002F/g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\\\/g, '\\');

// "3:24" → 204 seconds (null when unparseable / not given, e.g. livestreams).
const parseDurationSeconds = (text) => {
  const parts = String(text || '').split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums.reduce((total, n) => total * 60 + n, 0);
};

async function searchYouTube(query) {
  const q = String(query || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY);
  if (!q) throw new Error('The search query was empty.');
  const html = await fetchHtml(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=en&gl=IN`
  );
  const results = [];
  const seen = new Set();
  // Locate every videoRenderer block, then pull the fields the Music Player
  // needs (id · title · channel · thumbnail · duration) out of that block.
  const idRe = /"videoRenderer":\{"videoId":"([\w-]{11})"/g;
  const marks = [];
  let m;
  while ((m = idRe.exec(html))) marks.push({ id: m[1], start: m.index });
  for (let i = 0; i < marks.length && results.length < MAX_RESULTS; i++) {
    const { id, start } = marks[i];
    if (seen.has(id)) continue;
    const end =
      i + 1 < marks.length ? marks[i + 1].start : Math.min(html.length, start + 8000);
    const block = html.slice(start, end);
    const t = block.match(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/);
    const title = t ? unescapeJson(t[1]).trim() : '';
    if (!title) continue;
    seen.add(id);
    const c =
      block.match(/"ownerText":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/) ||
      block.match(/"longBylineText":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/);
    const th = block.match(/"thumbnail":\{"thumbnails":\[\{"url":"([^"]+)"/);
    const len = block.match(/"lengthText":\{"simpleText":"([^"]+)"/);
    const durationText = len ? unescapeJson(len[1]) : '';
    results.push({
      title,
      url: `https://www.youtube.com/watch?v=${id}`,
      snippet: '',
      source: 'youtube.com',
      videoId: id,
      channel: c ? unescapeJson(c[1]).trim() : '',
      thumbnail: th ? unescapeJson(th[1]) : '',
      durationText,
      durationSeconds: parseDurationSeconds(durationText),
    });
  }
  if (!results.length) throw new Error('YouTube returned no results.');
  return { query: q, provider: 'youtube', results };
}

module.exports = { searchWeb, searchYouTube, providers };
