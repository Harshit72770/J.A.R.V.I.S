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

// The exact sentence spoken when Google demands human verification. The
// bridge DETECTS the CAPTCHA page and returns this text — it is never
// solved, bypassed, or retried (architecture rule).
export const GOOGLE_CAPTCHA_MESSAGE =
  "Google is asking for human verification, so I can't continue the automated Google search.";

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
const SEARCH_PREP =
  'on|in|from|via|using|through|with|for|me|mein|par|में|पर';

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

// ─── Screen vision: read / explain / toggle the screen ──────────────────────
// "read the text", "read my screen", "explain what's on my screen" → a vision
// action. Gated by the SCREEN VISION switch (bottom-left): the browser only
// grants screen access from a real click, so voice can turn the feature OFF
// but can only ASK for permission to turn it ON — never pretend it happened.
const VISION_PREFIX =
  /^(?:(?:okay|ok|hey|hello|jarvis|जर्विस|please|plz|can you|could you|will you|just)\s+)+/i;

const VISION_OFF_RE =
  /^(?:stop|turn off|switch off|disable|hide|pause|kill|band|बंद)\b.*(?:see|seeing|watch|watching|look|looking|vision|screen)|^(?:don'?t|do not|never|मत)\s+(?:see|watch|look)\b|^(?:screen vision|screen access)\s+(?:off|band|बंद)/i;

const VISION_STATUS_RE =
  /^(?:are you|can you|do you|is it)\s+(?:seeing|watching|looking|see|look|watch)\b|^is\s+(?:the\s+)?screen vision\s+(?:on|off|live|active|working)\b|^(?:screen vision)\s+(?:on|off|live|active|working)\s*(?:hai|है)\s*$/i;

const VISION_ON_RE =
  /^(?:allow|enable|grant|start|turn on|switch on|give)\b.*(?:see|seeing|watch|watching|look|looking|vision|screen|display)|^(?:screen vision|screen access)\s+(?:on|चालू|शुरू)/i;

function matchVisionCommand(raw) {
  const rawLower = normalize(raw).toLowerCase();
  const s = rawLower
    .replace(VISION_PREFIX, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;

  // "screen" words (Hindi too) — desktop/window deliberately excluded so
  // "show me my desktop" still opens the folder, as it always did.
  const strongScreen = [
    'screen',
    'display',
    'monitor',
    'screenshot',
    'स्क्रीन',
    'मॉनिटर',
    'डिस्प्ले',
    'पर्दा',
    'पर्दे',
    'स्क्रीनशॉट',
  ].some((w) => hasWord(s, w));

  const imageWord = [
    'image',
    'images',
    'picture',
    'pictures',
    'photo',
    'photos',
    'diagram',
    'drawing',
    'इमेज',
    'तस्वीर',
    'फोटो',
    'चित्र',
  ].some((w) => hasWord(s, w));

  const seeingCtx =
    strongScreen || imageWord || /\b(?:my|your|this) screen\b/.test(s);

  // Status is matched against the RAW text: the politeness prefix ("can you")
  // is part of the question and must not be stripped before it is recognised.
  if (VISION_STATUS_RE.test(rawLower) && seeingCtx)
    return { type: 'vision', mode: 'status' };
  if (VISION_OFF_RE.test(s)) return { type: 'vision', mode: 'off' };
  if (VISION_ON_RE.test(s)) return { type: 'vision', mode: 'on' };

  // "what does my screen say" / "what does this image show"
  const whatDoes = s.match(
    /^(?:what does|what do|what's in|whats in)\s+(?:my|the|this|these|your)?\s*(screen|display|image|picture|photo|text|page|window)\s+(say|says|read|show|shows|contain|contains|look|looks)/
  );
  if (whatDoes) {
    const second = whatDoes[2];
    return {
      type: 'vision',
      mode: /^(?:say|says|read|contain)/.test(second) ? 'read' : 'explain',
    };
  }

  // ── READ: "read the text" / "read my screen" / "स्क्रीन पढ़ो" ──────────
  const readNoun = [
    'text',
    'texts',
    'word',
    'words',
    'writing',
    'note',
    'notes',
    'message',
    'messages',
    'paragraph',
    'page',
    'content',
    'list',
    'document',
    'documents',
    'टेक्स्ट',
    'शब्द',
    'लिखा',
    'नोट',
    'संदेश',
  ].some((w) => hasWord(s, w));
  const readIntent =
    hasWord(s, 'read') || /(पढ़ो|पढ़िए|पढ़िये|पढ़\s*दो|पढ़ना)/.test(s);
  const bareRead =
    /^(?:read|read it|read this|read that|read out|read aloud|read the screen|पढ़ो|पढ़िए|पढ़ दो)$/.test(
      s
    );
  if (readIntent && (bareRead || readNoun || strongScreen)) {
    return { type: 'vision', mode: 'read' };
  }

  // ── EXPLAIN: "explain this screen" / "what's on my screen" ─────────────
  const explainVerb =
    /^(?:explain|describe|visuali[sz]e|analy[sz]e|interpret|summar(?:i|iz)e|break down|tell me about|समझाओ|व्याख्या)/.test(
      s
    );
  const whatQuery =
    /^(?:what(?:'s|’s| is| are| was| were)|whats|what do you see|what can you see|what'?s there)/.test(
      s
    );
  const lookVerb = /^(?:look at|look|see|watch|inspect|check out)\b/.test(s);
  const specificImage =
    /\b(?:this|that|these|those|the|is|my)\s+(?:image|picture|photo|diagram|screenshot)\b/.test(
      s
    );

  if (explainVerb && (strongScreen || imageWord))
    return { type: 'vision', mode: 'explain' };
  if (whatQuery && (strongScreen || imageWord))
    return { type: 'vision', mode: 'explain' };
  if (/(?:क्या है|kya hai|क्या दिख)/.test(s) && strongScreen)
    return { type: 'vision', mode: 'explain' };
  if (lookVerb && (strongScreen || (imageWord && specificImage)))
    return { type: 'vision', mode: 'explain' };
  if (/^(?:show|show me|show us)\b/.test(s) && strongScreen)
    return { type: 'vision', mode: 'explain' };

  return null;
}

// ─── Media control matcher: system volume + screen brightness ──────────────
// Browsers cannot change either — these resolve to a {type:'media'} action
// that the bridge executes through its PowerShell media worker.

const VOL_WORDS = [
  'volume',
  'volum',
  'loudness',
  'aawaz',
  'aawaj',
  'avaz',
  'sound',
  'साउंड',
  'आवाज़',
  'आवाज',
  'वॉल्यूम',
  'वाल्यूम',
];
const BRI_WORDS = [
  'brightness',
  'bright',
  'roshni',
  'ब्राइटनेस',
  'रोशनी',
  'रोशन',
  'चमक',
  'प्रकाश',
];

// Devanagari has no ASCII word boundaries, so Hindi words use plain matches.
const MEDIA_UP_RE =
  /\b(?:increase|increased|raise|raised|up|higher|boost|badhao|badha\s+do|upar)\b|(?:बढ़ाओ|बढ़ा\s*दो|बढ़ाइए|बढ़ा\s*लो|ऊपर|ज़्यादा|ज्यादा)/;
const MEDIA_DOWN_RE =
  /\b(?:decrease|decrease|lower|lowered|down|reduce|reduced|less|kam|ghatao|ghata\s+do|niche)\b|(?:कम|घटाओ|घटा\s*दो|नीचे|कमी)/;
const MEDIA_GET_RE =
  /\b(?:what|what's|whats|how\s+much|current|status|level|kitna|kitni|kya|batao|batado|check)\b|(?:कितना|कितनी|क्या|बताओ|स्टेटस)/;

function matchMediaCommand(raw) {
  const s = normalize(raw)
    .toLowerCase()
    .replace(VISION_PREFIX, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;

  let isVolume = VOL_WORDS.some((w) => hasWord(s, w));
  const isBrightness = BRI_WORDS.some((w) => hasWord(s, w));
  if (!isVolume && !isBrightness) {
    // Bare "mute" / "mute karo" is almost always about the speakers.
    const muteWord = /\b(?:mute|unmute)\b/.test(s) || /म्यूट/.test(s);
    if (!muteWord) return null;
    isVolume = true;
  }
  const device = isVolume ? 'volume' : 'brightness';

  let m;

  // ── SET a percentage: "set volume to 50" / "brightness 70%" / "50 percent volume"
  m = s.match(
    /(?:set|change|make|put|adjust|करो|कर\s*दो|कर\s*लो|सेट)?\s*(?:the\s+|my\s+|mera\s+|mere\s+)?(?:volume|loudness|brightness|sound|वॉल्यूम|ब्राइटनेस|आवाज़|आवाज|चमक)\s*(?:to|on|at|par|पर|को)?\s*(\d{1,3})\s*(?:%|percent|प्रतिशत)?/
  );
  if (!m) {
    m = s.match(
      /(\d{1,3})\s*(?:%|percent|प्रतिशत)\s*(?:the\s+|my\s+)?(?:volume|loudness|brightness|sound|वॉल्यूम|ब्राइटनेस)/
    );
  }
  if (m) {
    const pct = Math.max(0, Math.min(100, parseInt(m[1], 10)));
    if (!Number.isNaN(pct)) {
      return { type: 'media', device, action: 'set', value: pct };
    }
  }
  if (/(?:set|change|करो|सेट)?\s*(?:the\s+)?(?:volume|brightness)\s*(?:to\s+)?(?:half|आधा|adha)/.test(s)) {
    return { type: 'media', device, action: 'set', value: 50 };
  }

  // ── MUTE / UNMUTE (volume only — displays have no mute) ──────────────
  if (device === 'volume') {
    if (/\bun\s?mute\b|mute\s+off|अनम्यूट|म्यूट\s+हटाओ/.test(s)) {
      return { type: 'media', device, action: 'unmute' };
    }
    if (/\bmute\b|\bsilence\b|म्यूट/.test(s)) {
      return { type: 'media', device, action: 'mute' };
    }
  }

  // ── REPORT: "what's the volume" / "brightness kitna hai" ─────────────
  if (MEDIA_GET_RE.test(s)) {
    return { type: 'media', device, action: 'get' };
  }

  // ── FULL / MAX → 100 ─────────────────────────────────────────────────
  if (
    /\b(?:full|maximum|max)\b|(?:पूरा|पूरी|फुल|फुली)/.test(s)
  ) {
    return { type: 'media', device, action: 'set', value: 100 };
  }

  // ── UP / DOWN (also unmutes on the way up, like the hardware keys) ───
  if (MEDIA_UP_RE.test(s)) return { type: 'media', device, action: 'up' };
  if (MEDIA_DOWN_RE.test(s)) return { type: 'media', device, action: 'down' };

  return null;
}

/**
 * Returns { type, target } for an utterance J.A.R.V.I.S can execute locally,
 * or null when the text should go to the language model instead.
 * type: say | youtube | ytSearch | google | web | site | app | folder |
 *       find | path | vision | media | browser | research | researchFail
 */

// ─── Current-information questions (web research) ───────────────────────────
// Matched LAST inside matchLocalCommand, so every local answer (date/time,
// identity, open, media …) keeps priority. English + Hinglish/Hindi markers.
const RESEARCH_PATTERNS = [
  /\b(?:latest|newest|recent|current)\b/i,
  /\bweather\b|\bmausam\b|मौसम/i,
  /\bnews\b|\bkhabar\b|खबर/i,
  /\b(?:who\s+won|winner\s+of|match\s+(?:result|score)|live\s+score|score(?:card)?\s+(?:today|now)?)\b/i,
  /\b(?:price\s+of|share\s+price|stock\s+price|gold\s+(?:price|rate)|exchange\s+rate|interest\s+rate|fuel\s+price|petrol\s+(?:price|rate)|diesel\s+(?:price|rate))\b/i,
  /\b(?:who\s+is|who's|who\s+was|who\s+are)\s+(?:the\s+)?(?:current\s+|present\s+|new\s+)?(?:ceo|chief\s+executive|prime\s+minister|president|governor|captain|head\s+coach)\b/i,
  /\b(?:today'?s|aaj\s+ka)\s+(?:match|news|price|score|result|khabar)\b/i,
  /\b(?:updates?|breaking)\s+(?:on|about|today)\b/i,
];

const isResearchQuestion = (text) =>
  RESEARCH_PATTERNS.some((re) => re.test(text));

const cleanOfficialTarget = (raw) =>
  String(raw || '')
    .trim()
    .replace(/['’]s$/i, '')
    .replace(/\s+(?:website|site|page)$/i, '')
    .trim();

// ─── Browser-control follow-up matcher ──────────────────────────────────────
// Context-free: execution (services/browserControl.js) resolves indices and
// targets against the stored short-term context (last search results/query).
function matchBrowserCommand(raw) {
  const text = String(raw || '')
    .replace(
      /^(?:okay\s+|ok\s+|hey\s+|jarvis\s+|please\s+|plz\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+)*/i,
      ''
    )
    .trim();
  if (!text) return null;
  let m;

  // ── Tab history: "go back" / "take me back" / "go forward" ──────────────
  m = text.match(
    /^(?:(?:go|move|take)(?:\s+us|\s+me)?\s+)?(back(?:wards?|ward)?|forward|forth)(?:\s+to\s+(?:the\s+)?(?:previous|last|next|earlier)\s+(?:page|tab))?$/i
  );
  if (m) {
    const dir = m[1].toLowerCase();
    return { type: 'browser', action: /^back/.test(dir) ? 'back' : 'forward' };
  }
  if (/^(?:pich(?:e|he)\s+jao|पीछे\s+जाओ)$/i.test(text)) {
    return { type: 'browser', action: 'back' };
  }
  if (/^(?:aage\s+jao|आगे\s+जाओ)$/i.test(text)) {
    return { type: 'browser', action: 'forward' };
  }

  // ── Refresh ─────────────────────────────────────────────────────────────
  if (
    /^(?:refresh|reload)(?:\s+(?:the\s+)?(?:page|tab|screen|site))?$|^(?:the\s+)?(?:page|tab)\s+(?:refresh|reload)(?:\s+करो)?$|^पेज\s+रिफ्रेश(?:\s+करो)?$/i.test(
      text
    )
  ) {
    return { type: 'browser', action: 'refresh' };
  }

  // ── Close tab ───────────────────────────────────────────────────────────
  if (
    /^close\s+(?:this|the|current)?\s*(?:tab|window)$|^tab\s+band\s+karo$|^टैब\s+बंद\s+करो$/i.test(
      text
    )
  ) {
    return { type: 'browser', action: 'closeTab' };
  }

  // ── What page am I on ───────────────────────────────────────────────────
  if (
    /^(?:what(?:'s|\s+is)\s+(?:the\s+)?(?:current|this)?\s*(?:page|tab|website|site)(?:\s+(?:url|address))?|which\s+page\s+am\s+i\s+on|current\s+page(?:\s+kya\s+hai)?)$/i.test(
      text
    )
  ) {
    return { type: 'browser', action: 'current' };
  }

  // ── Open/play Nth result of the previous search ─────────────────────────
  // "open the first result|link" / "play this first song|video" resolve the
  // stored web/YouTube search context. Optional trailing "of the …" noise
  // ("open the first link of the website") is ignored.
  m = text.match(
    /^(?:open|play|show)\s+(?:(?:this|the)\s+)?(first|second|third|fourth|fifth|last|(\d+)(?:st|nd|rd|th)?)\s+(?:result|link|song|video|track|page|option)(?:\s+(?:of|from)\s+(?:the\s+)?(?:search|results?|page|website|list))?$/i
  );
  if (m) {
    const ordinal = {
      first: 1,
      second: 2,
      third: 3,
      fourth: 4,
      fifth: 5,
      last: 'last',
    };
    const key = m[1].toLowerCase();
    return {
      type: 'browser',
      action: 'openResult',
      index: ordinal[key] !== undefined ? ordinal[key] : parseInt(m[2], 10),
    };
  }
  m = text.match(
    /^(?:open|play|show)\s+(?:result|link|song|video|track)\s+(?:number\s+)?(\d+)$/i
  );
  if (m) {
    return { type: 'browser', action: 'openResult', index: parseInt(m[1], 10) };
  }
  m = text.match(
    /^(pehla|dusra|teesra|chautha|paanchva|last)\s+(?:result|link|gaana|song)\s+(?:kholo|open\s+karo|chalao)$/i
  );
  if (m) {
    const ordinal = {
      pehla: 1,
      dusra: 2,
      teesra: 3,
      chautha: 4,
      paanchva: 5,
      last: 'last',
    };
    return {
      type: 'browser',
      action: 'openResult',
      index: ordinal[m[1].toLowerCase()],
    };
  }

  // ── Official website (§9: search + pick, never guess the URL) ───────────
  m = text.match(
    /^open\s+(?:the\s+)?official\s+(?:website|site|page)(?:\s+(?:of|for)\s+(.+))?$/i
  );
  if (m) {
    return { type: 'browser', action: 'openOfficial', target: cleanOfficialTarget(m[1]) };
  }
  m = text.match(/^open\s+(?:the\s+)?official\s+(.+?)\s+(?:website|site|page)$/i);
  if (m) {
    return { type: 'browser', action: 'openOfficial', target: cleanOfficialTarget(m[1]) };
  }
  m = text.match(/^open\s+(?:the\s+)?(.+?)\s+official\s+(?:website|site|page)$/i);
  if (m) {
    return { type: 'browser', action: 'openOfficial', target: cleanOfficialTarget(m[1]) };
  }
  m = text.match(/^(.+?)\s+ki\s+official\s+(?:website|site)$/i);
  if (m) {
    return { type: 'browser', action: 'openOfficial', target: cleanOfficialTarget(m[1]) };
  }

  return null;
}

// ctx (optional): { activeSite } — the active browser site ('youtube' | …)
// enables contextual follow-ups ("search for X" while YouTube is open).
// Harness/default calls omit it → context-free behaviour is unchanged.
export function matchLocalCommand(raw, ctx = {}) {
  const text = normalize(raw);
  if (!text) return null;

  // ── 0) SCREEN VISION: read / explain / toggle what is on my screen ─────
  const visionAction = matchVisionCommand(text);
  if (visionAction) return visionAction;

  // ── 0b) MEDIA: system volume + screen brightness ───────────────────────
  const mediaAction = matchMediaCommand(text);
  if (mediaAction) return mediaAction;

  // ── 0c) BROWSER CONTROL: tabs, history, search-result follow-ups ───────
  const browserAction = matchBrowserCommand(text);
  if (browserAction) return browserAction;

  // ── 0d) WEB RESEARCH (explicit): "search the web for X" ────────────────
  // Spec §8 distinction: "search google for X" opens a Google tab (step 2),
  // while "search the web for X" is RESEARCH — search first, then answer
  // from the retrieved results (TEST 8).
  let r;
  r = text.match(
    /^(?:okay\s+|ok\s+|hey\s+|jarvis\s+|please\s+|plz\s+)?(?:can\s+you\s+|could\s+you\s+|please\s+|do\s+(?:a\s+)?)?search\s+(?:the\s+)?(?:web|internet|online|world\s+wide\s+web)\s+(?:for|about|on|up|regarding|around)\s+(.+)$/i
  );
  if (r) return { type: 'research', query: r[1].trim() };
  // Hinglish / Hindi: "internet par search karo X" · "web search karo X"
  r = text.match(
    /^(?:please\s+|jarvis\s+)?(?:web|online|internet|इंटरनेट)\s*(?:पर|par)?\s*(?:search|sarch|सर्च)\s*(?:karo|kar\s+do|do|करो|कर\s+दो)?\s+(?:for\s+|about\s+)?(.+)$/i
  );
  if (r && r[1] && r[1].trim()) return { type: 'research', query: r[1].trim() };

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

  // ── 2) SEARCH → the free web_search tool by default (NO Chrome), the
  //       Google tab only when Google is said explicitly, YouTube when
  //       that site is the active one ─────────────────────────────────────
  m = text.match(
    /^(?:okay\s+|ok\s+|hey\s+|please\s+|plz\s+|jarvis\s+)?(google\s+search|search\s+on\s+google|search\s+in\s+google|search|google|look\s+up|look\s+for|find\s+out)\s+(?:for\s+|about\s+|up\s+|me\s+|on\s+google\s+|on\s+the\s+web\s+)?(.+)$/i
  );
  if (m) {
    const verb = (m[1] || '').toLowerCase();
    let q = m[2].trim();
    if (/\s+(?:on|in|from)\s+(?:youtube|youtu\.be|yt)\s*$/i.test(q)) {
      // "search X on youtube" is a YouTube search, not a Google one
      q = stripYoutube(
        q.replace(/\s+(?:on|in|from)\s+(?:youtube|youtu\.be|yt)\s*$/i, '')
      );
      if (!isEmptyQuery(q)) return { type: 'ytSearch', target: q };
    } else {
      // Google ONLY when the user says it (verb "google" / "search on
      // google", or browser words wrapped around the query).
      const explicitGoogle =
        /google/i.test(verb) || SUFFIX_NOISE.test(q) || PREFIX_NOISE.test(q);
      const cleaned = cleanSearchQuery(q);
      if (!isEmptyQuery(cleaned)) {
        // YouTube is the active site → search INSIDE YouTube (no Google).
        if (ctx.activeSite === 'youtube' && !explicitGoogle) {
          return { type: 'ytSearch', target: cleaned };
        }
        if (explicitGoogle) return { type: 'google', target: cleaned };
        // Ordinary "search for X" → the free web_search tool (no Chrome).
        return { type: 'research', query: cleaned };
      }
      // The words were only browser instructions ("search on chrome") →
      // open Google itself instead of searching for that phrase.
      if (cleaned !== q) return { type: 'web' };
      // Bare filler ("search karo") — let the later rules / model handle it.
    }
  } else {
    // "<query> search karo / google karo / सर्च करो"
    m = text.match(
      /^(.+?)\s+(?:ko\s+|को\s+)?(search|सर्च|google|गूगल)\s*(?:karo|kardo|kar\s+do|करो|कर\s+दो|करना)$/i
    );
    if (m && !isEmptyQuery(m[1].trim())) {
      const q = m[1].trim();
      // "X google karo" names Google explicitly; plain "X search karo" does not.
      const explicitGoogle =
        /^(?:google|गूगल)$/i.test((m[2] || '').trim()) ||
        SUFFIX_NOISE.test(q) ||
        PREFIX_NOISE.test(q);
      const cleaned = cleanSearchQuery(q);
      if (!isEmptyQuery(cleaned)) {
        if (ctx.activeSite === 'youtube' && !explicitGoogle) {
          return { type: 'ytSearch', target: cleaned };
        }
        if (explicitGoogle) return { type: 'google', target: cleaned };
        return { type: 'research', query: cleaned };
      }
      if (cleaned !== q) return { type: 'web' };
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

  // ── 7) WEB RESEARCH (current information) ──────────────────────────────
  // Only reached when steps 0-6 matched nothing — so local answers (facts,
  // opens, media …) always win, and open-ended chat still goes to the model.
  if (isResearchQuestion(text)) return { type: 'research', query: text };

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
  // A failed web search is reported by the HUD (spoken failure, no model
  // answer invented) — nothing to execute either.
  if (action.type === 'researchFail') {
    return { ok: false, error: action.error || 'Web search failed.' };
  }
  // Screen vision owns its own pipeline (live frame + streaming reply) and
  // must never be dispatched to the bridge.
  if (action.type === 'vision') {
    return { ok: false, error: 'Screen vision runs in the HUD, not the bridge.' };
  }

  // ── System volume / brightness ────────────────────────────────────────
  // Executed by the bridge's resident media worker (PowerShell + Core Audio
  // / WMI); its reply carries fresh hardware state, which mediaCommand
  // applies to the shared UI store before resolving.
  if (action.type === 'media') {
    try {
      const { mediaCommand } = await import('./mediaControl.js');
      return await mediaCommand(action.device, action.action, action.value);
    } catch (e) {
      return { ok: false, error: 'Media control module failed to load.' };
    }
  }

  // ── Browser control (back/forward/refresh/results/official sites) ──────
  // Executed by the bridge's controlled browser window; resolves follow-up
  // context (last search results) itself. Never throws.
  if (action.type === 'browser') {
    try {
      const { executeBrowserAction } = await import('./browserControl.js');
      return await executeBrowserAction(action);
    } catch (e) {
      return { ok: false, error: 'Browser control module failed to load.' };
    }
  }

  const online = await checkBridge(true);

  // "search google for X" prefers J.A.R.V.I.S's controlled browser window
  // (keeps the tab, history and follow-ups like "open the first result"
  // working); when the controlled window is unavailable, fall back to the
  // classic plain Google tab below — same behaviour as before.
  if (action.type === 'google' && online) {
    try {
      const { googleSearch } = await import('./browserControl.js');
      const r = await googleSearch(action.target);
      // ok → done; a definitive failure (not "automation unavailable") →
      // report it instead of silently opening a second tab.
      if (r.ok || !r.fallback) return r;
    } catch (e) {
      /* fall through to the classic Google tab */
    }
  }

  const link = linkUrlFor(action);
  if (link) {
    const r = await openLink(link, online);
    if (r.ok) {
      try {
        const { recordSearchContext, recordBrowserOpen } = await import(
          './browserControl.js'
        );
        // "search for X" while YouTube is active → remember the query so
        // "play the first result" can resolve it later (results are
        // fetched lazily by the browser context, not here).
        if (action.type === 'ytSearch') {
          recordSearchContext(action.target, [], 'youtube');
        }
        // Browser context (separate store): active_tab / active_site.
        if (r.opened) recordBrowserOpen(r.opened, r.via);
      } catch (e) {
        /* context recording must never fail the command */
      }
    }
    return r;
  }

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
    case 'vision':
      return {
        pending: '👁 SCREEN VISION // capturing a frame…',
        done: '✅ SCREEN VISION // screen analyzed',
        speak: isHindi
          ? 'स्क्रीन देख रहा हूँ, सर।'
          : 'Looking at your screen, Sir.',
        failSpeak: isHindi
          ? 'माफ़ कीजिए सर, स्क्रीन नहीं देख पाया।'
          : 'Sorry Sir, I could not look at the screen.',
      };
    case 'media':
      // The spoken copy is replaced by describeMediaResult once the bridge
      // replies with the real percentages; this is only the pending line.
      return {
        pending:
          action.device === 'volume'
            ? '🔊 MEDIA // adjusting system volume…'
            : '☀️ MEDIA // adjusting screen brightness…',
        done:
          action.device === 'volume'
            ? '🔊 MEDIA // volume updated'
            : '☀️ MEDIA // brightness updated',
        speak: isHindi ? 'बदल रहा हूँ, सर।' : 'Adjusting, Sir.',
        failSpeak: isHindi
          ? 'माफ़ कीजिए सर, यह बदल नहीं पाया।'
          : 'Sorry Sir, I could not change that.',
      };
    case 'browser':
      // Replaced by describeBrowserResult once the bridge replies; this is
      // only the pending line + generic failure voice.
      return {
        pending: `🌐 BROWSER // ${browserActionLabel(action)}`,
        done: '✅ BROWSER // action completed',
        speak: isHindi ? 'ब्राउज़र में कर रहा हूँ, सर।' : 'Working on it, Sir.',
        failSpeak: isHindi
          ? 'माफ़ कीजिए सर, यह ब्राउज़र कमांड नहीं हो पाया।'
          : 'Sorry Sir, that browser command did not work.',
      };
    case 'researchFail':
      return {
        pending: '🔎 WEB SEARCH // querying search providers…',
        done: '⚠ WEB SEARCH FAILED // could not reach any search provider',
        speak: '',
        failSpeak: isHindi
          ? 'क्षमा करें सर, अभी वेब सर्च नहीं हो पाया — इंटरनेट तक पहुँच नहीं पाई।'
          : "Sorry Sir, the web search failed — I couldn't access the web right now.",
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

/**
 * Result-aware copy for media actions — unlike describeAction, this runs
 * AFTER the bridge replies, so it speaks the real percentages:
 *   "Volume set to 50%, Sir." / "Brightness increased to 70%, Sir."
 */
export function describeMediaResult(action, result, isHindi) {
  const failed = isHindi
    ? 'माफ़ कीजिए सर, यह बदल नहीं पाया।'
    : 'Sorry Sir, I could not change that.';
  if (!result || !result.ok) {
    return {
      ok: false,
      done: `⚠ ACTION FAILED // ${
        result && result.error ? result.error : 'no reply from the Desktop Bridge'
      }`,
      speak: failed,
    };
  }

  const v = typeof result.volume === 'number' ? result.volume : null;
  const b = typeof result.brightness === 'number' ? result.brightness : null;
  const pct = (n) => (n === null ? null : n);
  const level = (n) => (n === null ? '' : ` ${n}%`);

  if (action.device === 'brightness') {
    const n = pct(b);
    switch (action.action) {
      case 'set':
        return {
          ok: true,
          done: `☀️ MEDIA // Brightness${level(n)}`,
          speak:
            n === null
              ? isHindi
                ? 'ब्राइटनेस बदल दी, सर।'
                : 'Brightness updated, Sir.'
              : isHindi
              ? `ब्राइटनेस ${n} परसेंट पर सेट कर दिया, सर।`
              : `Brightness set to ${n}%, Sir.`,
        };
      case 'up':
        return {
          ok: true,
          done: `☀️ MEDIA // Brightness${level(n)}`,
          speak:
            n === null
              ? isHindi
                ? 'ब्राइटनेस बढ़ा दी, सर।'
                : 'Brightness increased, Sir.'
              : isHindi
              ? `ब्राइटनेस बढ़ाकर ${n} परसेंट कर दिया, सर।`
              : `Brightness increased to ${n}%, Sir.`,
        };
      case 'down':
        return {
          ok: true,
          done: `☀️ MEDIA // Brightness${level(n)}`,
          speak:
            n === null
              ? isHindi
                ? 'ब्राइटनेस घटा दी, सर।'
                : 'Brightness decreased, Sir.'
              : isHindi
              ? `ब्राइटनेस घटाकर ${n} परसेंट कर दिया, सर।`
              : `Brightness decreased to ${n}%, Sir.`,
        };
      default:
        return {
          ok: true,
          done: `☀️ MEDIA // Brightness${level(n)}`,
          speak:
            n === null
              ? isHindi
                ? 'ब्राइटनेस की जानकारी नहीं मिली, सर।'
                : 'I could not read the brightness, Sir.'
              : isHindi
              ? `ब्राइटनेस ${n} परसेंट है, सर।`
              : `Brightness is ${n} percent, Sir.`,
        };
    }
  }

  const n = pct(v);
  switch (action.action) {
    case 'set':
      return {
        ok: true,
        done: `🔊 MEDIA // Volume${level(n)}`,
        speak:
          n === null
            ? isHindi
              ? 'वॉल्यूम बदल दिया, सर।'
              : 'Volume updated, Sir.'
            : isHindi
            ? `वॉल्यूम ${n} परसेंट पर सेट कर दिया, सर।`
            : `Volume set to ${n}%, Sir.`,
      };
    case 'up':
      return {
        ok: true,
        done: `🔊 MEDIA // Volume${level(n)}`,
        speak:
          n === null
            ? isHindi
              ? 'वॉल्यूम बढ़ा दिया, सर।'
              : 'Volume increased, Sir.'
            : isHindi
            ? `वॉल्यूम बढ़ाकर ${n} परसेंट कर दिया, सर।`
            : `Volume increased to ${n}%, Sir.`,
      };
    case 'down':
      return {
        ok: true,
        done: `🔊 MEDIA // Volume${level(n)}`,
        speak:
          n === null
            ? isHindi
              ? 'वॉल्यूम घटा दिया, सर।'
              : 'Volume decreased, Sir.'
            : isHindi
            ? `वॉल्यूम घटाकर ${n} परसेंट कर दिया, सर।`
            : `Volume decreased to ${n}%, Sir.`,
      };
    case 'mute':
      return {
        ok: true,
        done: '🔊 MEDIA // Muted',
        speak: isHindi ? 'वॉल्यूम म्यूट कर दिया, सर।' : 'Volume muted, Sir.',
      };
    case 'unmute':
      return {
        ok: true,
        done: `🔊 MEDIA // Unmuted${level(n)}`,
        speak: isHindi ? 'वॉल्यूम चालू कर दिया, सर।' : 'Volume unmuted, Sir.',
      };
    default:
      return {
        ok: true,
        done: `🔊 MEDIA // Volume${level(n)}${result.muted ? ' (muted)' : ''}`,
        speak:
          n === null
            ? isHindi
              ? 'वॉल्यूम की जानकारी नहीं मिली, सर।'
              : 'I could not read the volume, Sir.'
            : isHindi
            ? `वॉल्यूम ${n} परसेंट है, सर।`
            : `Volume is ${n} percent${
                result.muted ? ' and it is muted' : ''
              }, Sir.`,
      };
  }
}

/** Short pending-line description for a browser action. */
function browserActionLabel(action) {
  switch (action.action) {
    case 'back':
      return 'going back…';
    case 'forward':
      return 'going forward…';
    case 'refresh':
      return 'refreshing the page…';
    case 'closeTab':
      return 'closing the tab…';
    case 'current':
      return 'reading the current page…';
    case 'newTab':
      return `opening ${action.url || 'a new tab'}…`;
    case 'openResult':
      return `opening result #${action.index}…`;
    case 'openOfficial':
      return `finding the official website${
        action.target ? ` of ${action.target}` : ''
      }…`;
    default:
      return 'working…';
  }
}

/**
 * Result-aware copy for browser actions — runs AFTER the bridge replies, so
 * it speaks what actually happened ("Went back, Sir." / "Opened the official
 * website, Sir.") and the specific reason when it did not.
 */
export function describeBrowserResult(action, result, isHindi) {
  const fail = (error) => {
    const err =
      result && result.error ? result.error : 'no reply from the Desktop Bridge';
    let speak;
    if (/previous page/i.test(err)) {
      speak = isHindi
        ? 'इस टैब में पीछे कोई पेज नहीं है, सर।'
        : 'There is no previous page in this tab, Sir.';
    } else if (/next page/i.test(err)) {
      speak = isHindi
        ? 'इस टैब में आगे कोई पेज नहीं है, सर।'
        : 'There is no next page in this tab, Sir.';
    } else if (/only open tab/i.test(err)) {
      speak = isHindi
        ? 'यही एकमात्र खुला टैब है, सर।'
        : 'That is the only open tab, Sir.';
    } else if (/official website/i.test(err)) {
      speak = isHindi
        ? 'माफ़ कीजिए सर, आधिकारिक वेबसाइट नहीं मिली।'
        : 'Sorry Sir, I could not find an official website.';
    } else if (/search results|run a search first/i.test(err)) {
      speak = isHindi
        ? 'पहले कोई सर्च करें, सर।'
        : 'Please run a search first, Sir.';
    } else if (/not a valid http/i.test(err)) {
      speak = isHindi
        ? 'माफ़ कीजिए सर, यह लिंक मान्य नहीं है।'
        : 'Sorry Sir, that is not a valid link.';
    } else if (/offline|bridge/i.test(err)) {
      speak = isHindi
        ? 'डेस्कटॉप ब्रिज ऑफ़लाइन है, सर।'
        : 'The desktop bridge is offline, Sir.';
    } else {
      speak = isHindi
        ? 'माफ़ कीजिए सर, यह ब्राउज़र कमांड नहीं हो पाया।'
        : 'Sorry Sir, that browser command did not work.';
    }
    return { ok: false, done: `⚠ ACTION FAILED // ${err}`, speak };
  };

  if (!result || !result.ok) return fail(result && result.error);

  const done = (text) => ({ ok: true, done: text });
  switch (action.action) {
    case 'back':
      return {
        ok: true,
        done: '✅ BROWSER // went back',
        speak: isHindi ? 'पीछे चला गया, सर।' : 'Went back, Sir.',
      };
    case 'forward':
      return {
        ok: true,
        done: '✅ BROWSER // went forward',
        speak: isHindi ? 'आगे चला गया, सर।' : 'Went forward, Sir.',
      };
    case 'refresh':
      return {
        ok: true,
        done: `✅ BROWSER // page refreshed${result.url ? ` — ${result.url}` : ''}`,
        speak: isHindi ? 'पेज रिफ्रेश कर दिया, सर।' : 'Page refreshed, Sir.',
      };
    case 'closeTab':
      return {
        ok: true,
        done: '✅ BROWSER // tab closed',
        speak: isHindi ? 'टैब बंद कर दिया, सर।' : 'Closed the tab, Sir.',
      };
    case 'current': {
      const title = (result.title || '').trim();
      const url = (result.url || '').trim();
      return {
        ok: true,
        done: `✅ BROWSER // ${title || url || 'unknown'}${
          url ? ` — ${url}` : ''
        }`,
        speak: title
          ? isHindi
            ? `आप ${title} पर हैं, सर।`
            : `You are on ${title}, Sir.`
          : url
          ? `You are on ${url}, Sir.`
          : 'I could not read the page, Sir.',
      };
    }
    case 'newTab': {
      const label = hostOf(result.opened || action.url);
      return {
        ok: true,
        done: `✅ BROWSER // opened ${label}${result.title ? ` — ${result.title}` : ''}`,
        speak: isHindi ? `${label} खोल दिया, सर।` : `Opened ${label}, Sir.`,
      };
    }
    case 'openResult': {
      const pick = result.result;
      const n = action.index;
      const ordinal =
        n === 'last'
          ? 'last'
          : `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
      return {
        ok: true,
        done: `✅ BROWSER // [${ordinal} result] ${pick ? pick.title : ''}${
          pick ? ` — ${pick.url}` : ''
        }`,
        speak: isHindi
          ? `${ordinal} नतीजा खोल दिया, सर।`
          : `Opened the ${ordinal} result, Sir.`,
      };
    }
    case 'openOfficial': {
      const pick = result.official || result.result;
      const label = pick ? hostOf(pick.url) : 'the official website';
      return {
        ok: true,
        done: `✅ BROWSER // official site opened — ${label}${
          pick && pick.url ? ` — ${pick.url}` : ''
        }`,
        speak: isHindi
          ? `${action.target || ''} की आधिकारिक वेबसाइट खोल दी, सर।`.replace(
              '  ',
              ' '
            )
          : `Opened the official website, Sir.`,
      };
    }
    default:
      return done('✅ BROWSER // done');
  }
}
