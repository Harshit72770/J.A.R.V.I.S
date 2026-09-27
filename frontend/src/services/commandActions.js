/**
 * Local command router for J.A.R.V.I.S.
 *
 * "open youtube", "search X", "play X on youtube", "open notepad",
 * "open my resume file" are executed directly — no LLM round-trip — so voice
 * control feels instant. Anything this matcher does not recognise falls
 * through to the normal Groq stream.
 *
 * Browser links can be opened by the browser itself. Apps, files and folders
 * need the desktop bridge (bridge/server.js) listening on 127.0.0.1:4777;
 * without it, only the link actions remain available.
 */

const BRIDGE_URL = 'http://127.0.0.1:4777';

const YOUTUBE_HOME = 'https://www.youtube.com/';
const GOOGLE_HOME = 'https://www.google.com/';
const ytSearchUrl = (q) =>
  `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
const googleUrl = (q) =>
  `https://www.google.com/search?q=${encodeURIComponent(q)}`;

// ─── Websites openable by name ──────────────────────────────────────────────
// "open facebook" / "open chatgpt on chrome" → straight to the site.
const KNOWN_SITES = {
  facebook: 'https://www.facebook.com/',
  fb: 'https://www.facebook.com/',
  instagram: 'https://www.instagram.com/',
  twitter: 'https://twitter.com/',
  x: 'https://x.com/',
  linkedin: 'https://www.linkedin.com/',
  reddit: 'https://www.reddit.com/',
  github: 'https://github.com/',
  gitlab: 'https://gitlab.com/',
  netflix: 'https://www.netflix.com/',
  'prime video': 'https://www.primevideo.com/',
  'amazon prime': 'https://www.primevideo.com/',
  hotstar: 'https://www.hotstar.com/',
  zee5: 'https://www.zee5.com/',
  'jiocinema': 'https://www.jiocinema.com/',
  chatgpt: 'https://chatgpt.com/',
  'chat gpt': 'https://chatgpt.com/',
  openai: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/',
  gmail: 'https://mail.google.com/',
  maps: 'https://maps.google.com/',
  'google maps': 'https://maps.google.com/',
  translate: 'https://translate.google.com/',
  'google translate': 'https://translate.google.com/',
  drive: 'https://drive.google.com/',
  'google drive': 'https://drive.google.com/',
  'google photos': 'https://photos.google.com/',
  'youtube music': 'https://music.youtube.com/',
  stackoverflow: 'https://stackoverflow.com/',
  'stack overflow': 'https://stackoverflow.com/',
  amazon: 'https://www.amazon.in/',
  flipkart: 'https://www.flipkart.com/',
  swiggy: 'https://www.swiggy.com/',
  zomato: 'https://www.zomato.com/',
  irctc: 'https://www.irctc.co.in/',
  wikipedia: 'https://www.wikipedia.org/',
  medium: 'https://medium.com/',
  quora: 'https://www.quora.com/',
  pinterest: 'https://www.pinterest.com/',
  spotify: 'https://open.spotify.com/',
  whatsapp: 'https://web.whatsapp.com/',
  'whatsapp web': 'https://web.whatsapp.com/',
  discord: 'https://discord.com/app',
  slack: 'https://app.slack.com/',
  zoom: 'https://zoom.us/',
  telegram: 'https://web.telegram.org/',
  steam: 'https://store.steampowered.com/',
  outlook: 'https://outlook.live.com/mail/',
  onedrive: 'https://onedrive.live.com/',
  notion: 'https://www.notion.so/',
  figma: 'https://www.figma.com/',
  canva: 'https://www.canva.com/',
  duolingo: 'https://www.duolingo.com/',
  coursera: 'https://www.coursera.org/',
  udemy: 'https://www.udemy.com/',
  'play store': 'https://play.google.com/',
  'chrome web store': 'https://chromewebstore.google.com/',
};

// These have a real desktop app: try the app first, fall back to the website
// when it is not installed (see runLocalCommand).
const PREFER_APPS = new Set([
  'spotify',
  'whatsapp',
  'discord',
  'slack',
  'zoom',
  'telegram',
  'steam',
  'outlook',
  'onedrive',
  'notion',
  'figma',
  'canva',
  'duolingo',
  'coursera',
  'udemy',
]);

// ─── Instant facts: date, day, time, identity ───────────────────────────────
// Answered locally on purpose — a language model does not reliably know the
// current date, and these must never be wrong.
const DATE_TRIGGERS = [
  "what's the date",
  'what is the date',
  'whats the date',
  'what date is it',
  "today's date",
  'today date',
  'date today',
  'current date',
  'correct date',
  'what day is it',
  'which day is it',
  'what day is today',
  "today's day",
  'tell me the date',
  'tell me date',
  'show me the date',
  'date and day',
  'day and date',
  'aaj ki date',
  'aaj kya date',
  'aaj date',
  'aaj ki tarikh',
  'aaj tareekh',
  'aaj ka din',
  'aaj din kya',
  'kaun sa din hai',
  'konsa din hai',
  'kaunsa din hai',
  'date batao',
  'date bata do',
  'tarikh batao',
  'tareekh batao',
  'din batao',
  'आज की तारीख',
  'आज क्या तारीख',
  'आज कौन सा दिन',
  'आज क्या दिन',
  'आज दिन क्या',
  'तारीख बताओ',
  'दिन बताओ',
];

const TIME_TRIGGERS = [
  "what's the time",
  'what is the time',
  'whats the time',
  'what time is it',
  'current time',
  'time now',
  'time batao',
  'time bata do',
  'kitne baje hain',
  'kitne baje',
  'samay kya hai',
  'aaj kya time hai',
  'समय क्या है',
  'कितने बजे',
  'टाइम बताओ',
  'समय बताओ',
];

const IDENTITY_TRIGGERS = [
  'who are you',
  'who are u',
  'what is your name',
  'whats your name',
  'what is your personality',
  'who created you',
  'who made you',
  'who built you',
  'who is your creator',
  'who developed you',
  'introduce yourself',
  'your name please',
  'about yourself',
  'tum kaun ho',
  'aap kaun ho',
  'tumhara naam kya hai',
  'aapka naam kya hai',
  'naam kya hai',
  'kisne banaya',
  'kisne banaya tumhe',
  'kis aap ne banaya',
  'तुम कौन हो',
  'आप कौन हो',
  'तुम्हारा नाम क्या है',
  'आपका नाम क्या है',
  'किसने बनाया',
  'किसने बनाया तुम्हें',
];

// Substring match with Unicode word edges, so "date" never matches "update"
// and Devanagari triggers work (\b is ASCII-only and useless there).
const hasTriggers = (text, triggers) =>
  triggers.some((trigger) =>
    new RegExp(
      `(?:^|[^\\p{L}\\p{N}])${escapeRe(trigger)}(?:[^\\p{L}\\p{N}]|$)`,
      'iu'
    ).test(text)
  );

// "facebook.com", "www.github.com", "https://x.com" — but never "mr. x".
const looksLikeUrl = (value) =>
  /^(https?:\/\/|www\.)/i.test(value) ||
  /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s]*)?$/i.test(value);

// "facebook.com" → "https://facebook.com/" (URL.href also adds the slash).
const normalizeUrl = (value) => {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(withScheme).href;
  } catch (e) {
    return withScheme;
  }
};

const hostOf = (value) => {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch (e) {
    return value;
  }
};

// ─── Browser wording around a query is instruction, not query text ──────────
// "search for bhutan travel on chrome" must search *bhutan travel*, and
// "chrome me search karo" (no topic) must open Google instead of searching
// for the words "chrome me".
const BROWSER_WORDS =
  'google\\s+chrome|chrome|google|browser|edge|internet|web';
const SEARCH_PREP = 'on|in|from|via|using|through|with|me|mein|par|में|पर';

const SUFFIX_NOISE = new RegExp(
  `\\s+(?:${SEARCH_PREP})\\s+(?:the\\s+)?(?:${BROWSER_WORDS})\\s*$`,
  'i'
);
const PREFIX_NOISE = new RegExp(
  `^(?:${BROWSER_WORDS})\\s+(?:${SEARCH_PREP})\\s+`,
  'i'
);
const ONLY_BROWSER = new RegExp(
  `^(?:(?:${SEARCH_PREP})\\s+)?(?:the\\s+)?(?:${BROWSER_WORDS})(?:\\s+(?:${SEARCH_PREP}))?$`,
  'i'
);

const cleanSearchQuery = (raw) => {
  let q = String(raw || '').trim().replace(SUFFIX_NOISE, '').trim();
  q = q.replace(PREFIX_NOISE, '').trim();
  return ONLY_BROWSER.test(q) ? '' : q;
};

// ─── Bridge health ──────────────────────────────────────────────────────────
let bridgeState = { checkedAt: 0, online: false };

export const isBridgeOnline = () => bridgeState.online;

export async function checkBridge(force = false) {
  const now = Date.now();
  if (!force && now - bridgeState.checkedAt < 15000) return bridgeState.online;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${BRIDGE_URL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = await res.json();
    bridgeState = { checkedAt: now, online: !!json.ok };
  } catch (e) {
    bridgeState = { checkedAt: now, online: false };
  }
  return bridgeState.online;
}

async function bridgeOpen(kind, target) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `${BRIDGE_URL}/open?kind=${encodeURIComponent(
        kind
      )}&target=${encodeURIComponent(target)}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    const json = await res.json();
    bridgeState = { checkedAt: Date.now(), online: true };
    return json && typeof json.ok === 'boolean'
      ? json
      : { ok: false, error: 'Desktop Bridge sent an unreadable reply.' };
  } catch (e) {
    bridgeState = { checkedAt: Date.now(), online: false };
    return {
      ok: false,
      error:
        'Desktop Bridge stopped responding — restart it (bridge\\bridge-start.bat).',
    };
  }
}

// ─── Text helpers ───────────────────────────────────────────────────────────
const normalize = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,;]+$/g, '')
    .trim();

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Word match that also works for Devanagari: JS \b is ASCII-word based, so
// "यूट्यूब" between spaces would never match a \b pattern.
const hasWord = (text, word) =>
  new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRe(word)}(?:[^\\p{L}\\p{N}]|$)`,
    'iu'
  ).test(text);

const mentionsYoutube = (text) =>
  hasWord(text, 'youtube') ||
  hasWord(text, 'youtu.be') ||
  hasWord(text, 'यूट्यूब') ||
  hasWord(text, 'यू ट्यूब');

// Queries that mean "just play something" rather than a real search term.
const FILLER =
  /^(music|songs?|gaana|gaane|song\s*vague|गाना|गाने|सॉन्ग|म्यूज़िक|संगीत|karo|kardo|करो|कर\s*दो|करना|please|hey|ok|okay)$/i;
const isEmptyQuery = (q) => !q || FILLER.test(String(q).trim());

// Remove "youtube" (and the dangling connector left behind) from a query.
const stripYoutube = (q) => {
  let out = String(q || '').trim();
  out = out.replace(
    /(?:^|\s)(?:youtube|youtu\.be|यूट्यूब|यू\s*ट्यूब)(?=\s|$)/gi,
    ' '
  );
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(/\s+(?:on|in|from|pe|par|via|se|पर|पे)$/i, '');
  out = out.replace(/^(?:on|in|from|pe|par|पर|पे)\s+/i, '');
  return out.replace(/\s+/g, ' ').trim();
};

// Verb + space, with optional politeness prefix. Captured groups come after.
const OPEN_VERB_SRC =
  '^(?:okay\\s+|ok\\s+|hey\\s+|please\\s+|plz\\s+|jarvis\\s+|जर्विस\\s+)?' +
  '(?:open|launch|start\\s+up|start|run|go\\s+to|visit|bring\\s+up|show\\s+me|show|' +
  'kholo|khol\\s+do|खोलो|खोल\\s+दो|चालू\\s+करो|dikhao|दिखाओ)\\s+';
const OPEN_VERB = new RegExp(OPEN_VERB_SRC, 'i');
const OPEN_CAPTURE = new RegExp(OPEN_VERB_SRC + '(.+)$', 'i');

// Folder / system places the bridge understands.
const FOLDER_ALIASES = {
  downloads: 'Downloads',
  download: 'Downloads',
  documents: 'Documents',
  'my documents': 'Documents',
  desktop: 'Desktop',
  'my desktop': 'Desktop',
  pictures: 'Pictures',
  photos: 'Pictures',
  images: 'Pictures',
  videos: 'Videos',
  'my videos': 'Videos',
  movies: 'Videos',
  music: 'Music',
  'my music': 'Music',
  'this pc': 'this pc',
  'my computer': 'this pc',
  computer: 'this pc',
  pc: 'this pc',
  'recycle bin': 'recycle bin',
  'control panel': 'control panel',
  settings: 'settings',
  'windows settings': 'settings',
  home: 'home',
  'home folder': 'home',
  'user folder': 'home',
  files: 'home',
  'my files': 'home',
};

const FILE_EXT =
  /\.(pdf|docx?|xlsx?|pptx?|txt|csv|rtf|odt|png|jpe?g|gif|bmp|svg|webp|tiff?|mp3|wav|m4a|flac|opus|aac|mp4|mkv|mov|avi|wmv|webm|zip|rar|7z|tar|gz|exe|msi|bat|ps1|py|ipynb|js|jsx|ts|tsx|json|html|css|md|log|ini|cfg|xml|java|cpp|c|h|cs|sln|apk|iso|docm|xlsm|url|lnk)$/i;

const hasPathSeparator = (value) =>
  /[\\/]/.test(value) || /^[a-z]:/i.test(value);

/**
 * Turn the noun half of an utterance ("notepad", "my downloads",
 * "resume.pdf", "youtube") into an executable action.
 */
function classifyOpenTarget(target) {
  if (!target) return null;

  // "chrome me youtube kholo" — the browser word says *where*, not *what*.
  target = target.replace(PREFIX_NOISE, '').trim();
  if (!target) return null;

  // "open youtube" / "youtube kholo" / "यूट्यूब खोलो"
  if (
    /^(?:the\s+|my\s+)?(?:youtube|youtu\.be|यूट्यूब|यू\s+ट्यूब)$/i.test(
      target.trim()
    )
  ) {
    return { type: 'youtube' };
  }

  // ── Websites ──────────────────────────────────────────────────────────
  // "open facebook.com" / "open facebook website" / "open chatgpt on chrome"
  let base = target
    .replace(/^(?:the\s+|my\s+|an?\s+|any\s+|मेरा\s+|मेरी\s+)/i, '')
    .trim();
  let webIntent = false;

  const onBrowser = base.match(
    /^(.+?)\s+(?:on|in|from)\s+(?:chrome|google(?:\s+chrome)?|browser|edge|internet|the\s+web)$/i
  );
  if (onBrowser) {
    base = onBrowser[1].trim();
    webIntent = true;
  }
  const siteSuffix = base.match(
    /^(.+?)\s+(?:website|site|web\s*page|webpage|वेबसाइट|साइट)$/i
  );
  if (siteSuffix) {
    base = siteSuffix[1].trim();
    webIntent = true;
  }

  if (looksLikeUrl(base)) {
    const url = normalizeUrl(base);
    return { type: 'site', target: url, label: hostOf(url) };
  }

  const siteUrl = KNOWN_SITES[base.toLowerCase()] || null;
  if (siteUrl && !PREFER_APPS.has(base.toLowerCase())) {
    return { type: 'site', target: siteUrl, label: base };
  }
  if (webIntent && siteUrl) {
    return { type: 'site', target: siteUrl, label: base };
  }
  if (webIntent) {
    // "open X on google" where X is not a known website → search for it
    return { type: 'google', target: base };
  }

  const lower = base.toLowerCase();

  const folder =
    FOLDER_ALIASES[lower] ||
    FOLDER_ALIASES[
      lower.replace(/\s+(?:folder|directory|ka\s+folder|डायरेक्टरी)$/i, '').trim()
    ];
  if (folder) return { type: 'folder', target: folder };

  // "open google" → the search page itself, not an app named Google
  if (/^(?:google|internet|the\s+internet|web|browser|गूगल|ब्राउज़र)$/i.test(lower)) {
    return { type: 'web' };
  }

  // Bare "open my file" — nothing to look for, let the model reply
  if (/^(?:files?|documents?|फ़ाइल|फाइल|डॉक्यूमेंट)$/i.test(lower)) return null;

  // Explicit "open file <name>" / "open document <name>"
  const fileless = target
    .replace(
      /^(?:the\s+|my\s+|a\s+|any\s+)?(?:file|document|फ़ाइल|फाइल|डॉक्यूमेंट)\s+(?:named\s+|called\s+|titled\s+)?/i,
      ''
    )
    .trim();

  if (fileless !== target) {
    if (!fileless) return null;
    return {
      type: hasPathSeparator(fileless) ? 'path' : 'find',
      target: fileless,
    };
  }

  if (hasPathSeparator(target) || FILE_EXT.test(target)) {
    return {
      type: hasPathSeparator(target) ? 'path' : 'find',
      target,
    };
  }

  // Installed app — with its website kept as a fallback for when the app is
  // not installed (siteUrl only exists for names that have a website).
  return { type: 'app', target: base, siteUrl: siteUrl || undefined };
}

/**
 * Returns { type, target } for an utterance J.A.R.V.I.S can execute locally,
 * or null when the text should go to the language model instead.
 * type: say | youtube | ytSearch | google | web | site | app | folder |
 *       find | path
 */
export function matchLocalCommand(raw) {
  const text = normalize(raw);
  if (!text) return null;

  let m;

  // ── 1) PLAY → YouTube ──────────────────────────────────────────────────
  m = text.match(
    /^(?:okay\s+|ok\s+|hey\s+|please\s+|plz\s+|jarvis\s+)?play\s+(?:me\s+|some\s+|the\s+|a\s+|up\s+|it\s+|my\s+)?(.+)$/i
  );
  if (m) {
    const q = stripYoutube(m[1]);
    return { type: 'ytSearch', target: isEmptyQuery(q) ? 'music' : q };
  }

  // Hindi / Hinglish: "<song> bajao", "gaana chalao", "play karo"
  m = text.match(
    /^(?:(.+?)\s+)?(?:बजाओ|बजा\s*दो|चलाओ|चला\s*दो|प्ले\s*करो|bajao|baja\s+do|chalao|chala\s+do|play\s+karo)$/i
  );
  if (m) {
    const q = stripYoutube(m[1] || '');
    return { type: 'ytSearch', target: isEmptyQuery(q) ? 'music' : q };
  }

  // ── 2) SEARCH → Google (YouTube when specified) ────────────────────────
  m = text.match(
    /^(?:okay\s+|ok\s+|hey\s+|please\s+|plz\s+|jarvis\s+)?(?:google\s+search|search\s+on\s+google|search\s+in\s+google|search|google|look\s+up|look\s+for|find\s+out)\s+(?:for\s+|about\s+|up\s+|me\s+|on\s+google\s+|on\s+the\s+web\s+)?(.+)$/i
  );
  if (m) {
    let q = m[1].trim();
    if (/\s+(?:on|in|from)\s+(?:youtube|youtu\.be|yt)\s*$/i.test(q)) {
      // "search X on youtube" is a YouTube search, not a Google one
      q = stripYoutube(
        q.replace(/\s+(?:on|in|from)\s+(?:youtube|youtu\.be|yt)\s*$/i, '')
      );
      if (!isEmptyQuery(q)) return { type: 'ytSearch', target: q };
    } else {
      const cleaned = cleanSearchQuery(q);
      if (!isEmptyQuery(cleaned)) return { type: 'google', target: cleaned };
      // The words were only browser instructions ("search on chrome") →
      // open Google itself instead of searching for that phrase.
      if (cleaned !== q) return { type: 'web' };
      // Bare filler ("search karo") — let the later rules / model handle it.
    }
  } else {
    // "<query> search karo / google karo / सर्च करो"
    m = text.match(
      /^(.+?)\s+(?:ko\s+|को\s+)?(?:search|सर्च|google|गूगल)\s*(?:karo|kardo|kar\s+do|करो|कर\s+दो|करना)$/i
    );
    if (m && !isEmptyQuery(m[1].trim())) {
      const raw = m[1].trim();
      const cleaned = cleanSearchQuery(raw);
      if (!isEmptyQuery(cleaned)) return { type: 'google', target: cleaned };
      if (cleaned !== raw) return { type: 'web' };
    }
  }

  // ── 3) INSTANT FACTS: date / day / time / identity ─────────────────────
  // Answered from the machine clock or fixed copy — never handed to the model,
  // because a model cannot know today's date and must not guess it.
  const lowerText = text.toLowerCase();
  const isDateOfSomething =
    /(?:of\s+birth|birthday|\bdob\b|release\s+date|effective\s+date|जन्म|तिथि)/i.test(
      text
    );
  const askingOwnName =
    /(?:my|mera|mere|मेरा|मेरे)\s+(?:naam|name|नाम)/i.test(text);
  if (!isDateOfSomething) {
    if (!askingOwnName && hasTriggers(lowerText, IDENTITY_TRIGGERS)) {
      return { type: 'say', intent: 'identity' };
    }
    if (hasTriggers(lowerText, DATE_TRIGGERS)) {
      return { type: 'say', intent: 'date' };
    }
    if (hasTriggers(lowerText, TIME_TRIGGERS)) {
      return { type: 'say', intent: 'time' };
    }
  }

  // ── 4) OPEN YOUTUBE ────────────────────────────────────────────────────
  // "open youtube and play X" / "open youtube and search X"
  m = text.match(
    /(?:open|launch|start|kholo|खोलो|खोल\s+दो|go\s+to)\s+(?:the\s+|my\s+)?(?:youtube|youtu\.be|यूट्यूब|यू\s+ट्यूब)[\s,]*(?:and\s+|then\s+)?(?:play|search|look\s+up)\s+(.+)$/i
  );
  if (m) {
    const q = stripYoutube(m[1]);
    return { type: 'ytSearch', target: isEmptyQuery(q) ? 'music' : q };
  }

  if (mentionsYoutube(text)) {
    if (OPEN_VERB.test(text)) {
      // "open youtube.com/watch?…" is a website, not the YouTube homepage
      const bare = text.replace(OPEN_VERB, '').trim();
      if (!looksLikeUrl(bare)) return { type: 'youtube' };
    } else if (/^(?:youtube|youtu\.be|यूट्यूब|यू\s+ट्यूब)$/i.test(text)) {
      return { type: 'youtube' };
    }
  }

  // ── 5) "open chrome and search X" / "open chrome and play X" ────────────
  // The search already lands in Chrome, so one action satisfies both halves.
  m = text.match(
    /^(?:okay\s+|ok\s+|hey\s+|please\s+|jarvis\s+)?(?:open|launch|start|kholo|खोलो|खोल\s+दो)\s+(?:the\s+)?(?:google\s+chrome|chrome|browser|edge|internet)\s+(?:and|then|,)\s+(search|google|find|look\s+up|play)\s+(?:for\s+|me\s+|को\s+)?(.+)$/i
  );
  if (m) {
    const verb = m[1].toLowerCase();
    const q = stripYoutube(m[2].trim());
    if (verb === 'play') {
      return { type: 'ytSearch', target: isEmptyQuery(q) ? 'music' : q };
    }
    const cleaned = cleanSearchQuery(q);
    if (!isEmptyQuery(cleaned)) return { type: 'google', target: cleaned };
    return { type: 'web' };
  }

  // ── 6) OPEN <website | folder | file | app> ────────────────────────────
  // Works verb-first ("open notepad") and object-first ("notepad kholo",
  // "यूट्यूब खोलो") — object-first is how Hindi speakers usually phrase it.
  m = text.match(OPEN_CAPTURE);
  let openTarget = m ? m[1].trim() : '';
  if (!openTarget) {
    const objectFirst = text.match(
      /^(.+?)\s+(?:kholo|khol\s+do|खोलो|खोल\s+दो|चालू\s+करो|शुरू\s+करो|dikhao|दिखाओ|open\s+karo|ओपन\s+करो)$/i
    );
    if (objectFirst) openTarget = objectFirst[1].trim();
  }
  if (openTarget) return classifyOpenTarget(openTarget);

  return null;
}

// ─── Execution ──────────────────────────────────────────────────────────────
const OFFLINE_ERROR =
  'Desktop Bridge offline — double-click bridge\\bridge-start.bat (or run: npm run bridge), then retry.';

// Open a link: through the bridge when it is up (Chrome never blocks that),
// otherwise a plain new tab — which Chrome may block for voice commands.
const openLink = async (url, online) => {
  if (online) return bridgeOpen('url', url);
  try {
    const win = window.open(url, '_blank');
    if (win) return { ok: true, opened: url, via: 'tab' };
    return {
      ok: false,
      error:
        'Popup blocked — click the ⊙ icon in the address bar, choose "Always allow popups from localhost:3000", then retry. Running the desktop bridge (npm run bridge) avoids this completely.',
    };
  } catch (e) {
    return {
      ok: false,
      error:
        'Could not open a new tab — start the desktop bridge (npm run bridge) and retry.',
    };
  }
};

const linkUrlFor = (action) => {
  switch (action.type) {
    case 'youtube':
      return YOUTUBE_HOME;
    case 'web':
      return GOOGLE_HOME;
    case 'ytSearch':
      return ytSearchUrl(action.target);
    case 'google':
      return googleUrl(action.target);
    case 'site':
      return action.target;
    default:
      return null;
  }
};

export async function runLocalCommand(action) {
  // Date / day / time / identity are fixed local copy — nothing to execute,
  // and no reason to wait on the bridge.
  if (action.type === 'say') return { ok: true };

  const online = await checkBridge(true);

  const link = linkUrlFor(action);
  if (link) return openLink(link, online);

  if (action.type === 'app') {
    if (online) {
      const res = await bridgeOpen('app', action.target);
      if (res.ok) return res;
      // Multi-word targets are usually a file ("tax return"), not an app.
      if (/\s/.test(action.target)) {
        const alt = await bridgeOpen('find', action.target);
        if (alt.ok) return alt;
      }
      // Not installed → open its website instead of a dead end.
      if (action.siteUrl) return openLink(action.siteUrl, online);
      return res;
    }
    if (action.siteUrl) return openLink(action.siteUrl, online);
    return { ok: false, error: OFFLINE_ERROR };
  }

  if (!online) return { ok: false, error: OFFLINE_ERROR };
  return bridgeOpen(
    action.type === 'path' ? 'file' : action.type,
    action.target
  );
}

// ─── Log + voice copy ───────────────────────────────────────────────────────
export function describeAction(action, isHindi, langCode) {
  const name = action.target;
  const failed = isHindi
    ? 'माफ़ कीजिए सर, नहीं खुल पाया।'
    : 'Sorry Sir, I could not open that.';
  const locale = langCode || (isHindi ? 'hi-IN' : 'en-US');

  // ── Fixed copy: identity, date, day, time (never guessed) ────────────
  if (action.type === 'say') {
    const now = new Date();
    if (action.intent === 'identity') {
      return {
        pending: '🤖 IDENTITY // Jarvis • personal AI assistant',
        done: '🤖 IDENTITY // Jarvis • Creator: Harshit Gupta • Personal AI assistant',
        speak: isHindi
          ? 'मेरा नाम जार्विस है। हर्षित गुप्ता ने मुझे बनाया है, और मैं आपका व्यक्तिगत एआई असिस्टेंट हूँ, सर।'
          : 'My name is Jarvis. Harshit Gupta created me — I am your personal AI assistant, Sir.',
        failSpeak: failed,
      };
    }
    if (action.intent === 'time') {
      const t = now.toLocaleTimeString(locale, {
        hour: 'numeric',
        minute: '2-digit',
      });
      return {
        pending: '🕐 TIME // reading system clock…',
        done: `🕐 TIME // ${t}`,
        speak: isHindi ? `अभी समय ${t} है, सर।` : `The time is ${t}, Sir.`,
        failSpeak: failed,
      };
    }
    const d = now.toLocaleDateString(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    return {
      pending: '📅 DATE // reading system clock…',
      done: `📅 DATE // ${d}`,
      speak: isHindi ? `आज ${d} है, सर।` : `Today is ${d}, Sir.`,
      failSpeak: failed,
    };
  }

  switch (action.type) {
    case 'youtube':
      return {
        pending: '⚡ ACTION // Opening YouTube → https://www.youtube.com',
        done: '✅ ACTION // YouTube opened in Chrome',
        speak: isHindi ? 'यूट्यूब खोल रहा हूँ, सर।' : 'Opening YouTube, Sir.',
        failSpeak: failed,
      };
    case 'ytSearch':
      return {
        pending: `⚡ ACTION // YouTube search "${name}"`,
        done: `✅ ACTION // YouTube results for "${name}"`,
        speak: isHindi
          ? `यूट्यूब पर ${name} चला रहा हूँ, सर।`
          : `Playing ${name} on YouTube, Sir.`,
        failSpeak: failed,
      };
    case 'google':
      return {
        pending: `⚡ ACTION // Google search "${name}"`,
        done: `✅ ACTION // Google results for "${name}"`,
        speak: isHindi
          ? `गूगल पर ${name} खोज रहा हूँ, सर।`
          : `Searching Google for ${name}, Sir.`,
        failSpeak: failed,
      };
    case 'web':
      return {
        pending: '⚡ ACTION // Opening Google → https://www.google.com',
        done: '✅ ACTION // Google opened in Chrome',
        speak: isHindi ? 'गूगल खोल रहा हूँ, सर।' : 'Opening Google, Sir.',
        failSpeak: failed,
      };
    case 'app':
      return {
        pending: `⚡ ACTION // Launching application: ${name}`,
        done: `✅ ACTION // Opened ${name}`,
        speak: isHindi
          ? `${name} खोल रहा हूँ, सर।`
          : `Opening ${name}, Sir.`,
        failSpeak: failed,
      };
    case 'site':
      return {
        pending: `⚡ ACTION // Opening website → ${name}`,
        done: '✅ ACTION // Website opened',
        speak: isHindi
          ? `${action.label || hostOf(name)} खोल रहा हूँ, सर।`
          : `Opening ${action.label || hostOf(name)}, Sir.`,
        failSpeak: failed,
      };
    case 'folder':
      return {
        pending: `⚡ ACTION // Opening folder: ${name}`,
        done: '✅ ACTION // Folder opened',
        speak: isHindi ? 'फ़ोल्डर खोल रहा हूँ, सर।' : 'Opening the folder, Sir.',
        failSpeak: failed,
      };
    case 'find':
    case 'path':
      return {
        pending: `⚡ ACTION // Finding and opening: ${name}`,
        done: '✅ ACTION // File opened',
        speak: isHindi ? 'फ़ाइल खोल रहा हूँ, सर।' : 'Opening your file, Sir.',
        failSpeak: failed,
      };
    default:
      return {
        pending: `⚡ ACTION // ${name}`,
        done: '✅ ACTION // Done',
        speak: isHindi ? 'कर रहा हूँ, सर।' : 'Done, Sir.',
        failSpeak: failed,
      };
  }
}
