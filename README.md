# J.A.R.V.I.S

Voice-controlled assistant: a holographic React console (Groq LPU streaming +
Web Speech API) that can also **control your laptop by voice**.

## Run it

```bash
cd frontend
npm start            # → http://localhost:3000, and starts the desktop bridge too
```

`npm start` first launches `bridge/ensure-bridge.js`, which brings up the
desktop bridge on `127.0.0.1:4777` if it is not already running (it keeps
running on its own afterwards). You can also start it by hand with
`npm run bridge`, or by double-clicking `bridge\bridge-start.bat`.

To have it start by itself at every login (hidden, no window):

```bash
npm run bridge:startup        # install into the Windows Startup folder
npm run bridge:startup:off    # remove it again
```

The bridge must be running for `open notepad`, `open chrome`, `open my resume
file`, `open downloads` and every Google/YouTube search — Chrome blocks the
plain-tab fallback for voice commands (they carry no click). Only when the
bridge is down do web actions fall back to a new tab, which Chrome may block.
The console footer shows `🖥️ BRIDGE ONLINE` / `🖥️ BRIDGE OFFLINE`.

## Voice commands

| Say | Does |
| --- | --- |
| "open youtube" / "यूट्यूब खोलो" / "youtube kholo" | Opens YouTube in Chrome |
| "play <song> on youtube" / "<song> bajao" | YouTube search for that song |
| "search <anything>" / "google <anything>" / "<x> search karo" | Google results in a new tab |
| "search <x> on youtube" | YouTube search results |
| "open facebook" / "open github.com" / "open chatgpt on chrome" / "open facebook website" | Opens any website in Chrome (40+ known names + any domain) |
| "open notepad" / "open chrome" / "open spotify" | Launches the app (PATH → registry App Paths → Start Menu); falls back to its website if not installed |
| "open downloads" / "open my documents" / "open this pc" | Opens the folder |
| "open file resume.pdf" / "open budget.xlsx" | Finds it in Desktop/Documents/Downloads/… and opens it |
| "open C:\path\to\file.txt" | Opens that exact path |
| "what's the date" / "what day is it" / "aaj ki date kya hai" / "आज की तारीख बताओ" | Today's date + weekday, read from the system clock (never guessed) |
| "what time is it" / "time batao" | Current time |
| "who are you" / "what is your name" / "who created you" / "किसने बनाया तुम्हें" | "I am Jarvis — Harshit Gupta created me, your personal AI assistant" |
| "read the text" / "read my screen" / "read the messages on screen" / "स्क्रीन पढ़ो" | Reads aloud every text visible on your screen (exact transcription) |
| "explain this screen" / "what's on my screen" / "describe the image" / "look at my screen" | Explains what is on the screen, including any image |
| "can you see my screen" | Reports whether Screen Vision is on |
| "stop seeing my screen" / "turn off screen vision" | Turns Screen Vision off |
| "increase volume" / "volume up" / "वॉल्यूम बढ़ाओ" | System volume +5% (also unmutes) |
| "decrease volume" / "volume down" / "वॉल्यूम कम करो" | System volume −5% |
| "set volume to 50" / "50% volume" / "set volume to half" | Sets the exact percentage |
| "mute the volume" / "unmute the volume" / "mute karo" | Mutes / unmutes the speakers |
| "full volume" | Volume to 100% |
| "what is the volume" / "volume kitna hai" | Reports the current volume |
| "increase brightness" / "set brightness to 70" / "brightness down" | Screen backlight ±10% or to an exact % |
| "what is the brightness" | Reports the current brightness |
| "search the web for python tutorials" / "internet par search karo X" | **Web research** — searches first, then answers from the retrieved results with sources |
| "who is the current CEO of Microsoft" / "latest news about NVIDIA" / "price of gold today" / "who won today's match" / "what is the weather" | Recognised as *current-information* questions → answered from live web results, never from memory |
| "search for gold price" / "search cricket scores" / "look up X" / "X search karo" | Ordinary searches use the **web_search tool — no Chrome opens**; the reply comes from the results with sources |
| "search google for NIT Raipur" / "google X" | Google results in the **controlled browser window** — only when you *say* Google. If Google shows a CAPTCHA, Jarvis detects it and says *"Google is asking for human verification, so I can't continue the automated Google search."* and stops (never solves, bypasses or retries) |
| "search for Arijit Singh" *(while YouTube is the active site)* | Searches **inside YouTube** (keyless YouTube results — no Google involved) |
| "open the first result" / "play the first result" / "open result 2" / "open the last result" | Opens/plays that result of your previous search (web **or** YouTube) |
| "open the official website of NIT Raipur" / "open the official NIT Raipur website" | Searches first, picks the official domain from real results (never guesses a URL) |
| "go back" / "go forward" / "refresh the page" / "close this tab" | Browser history + tab control in the controlled window |
| "what is the current page" / "which page am i on" | Reads back the page title + URL |

Anything the matcher does not recognise goes to Groq as a normal chat reply.
Actions never round-trip through the model, so they answer instantly.

J.A.R.V.I.S's identity (name: Jarvis, creator: **Harshit Gupta**, personal AI
assistant) is also written into the system prompt, so every other phrasing of
"who are you" gets the same answer.

## Screen Vision (the bottom-left switch)

The **SCREEN VISION** panel in the bottom-left corner is the master switch for
letting Jarvis see your screen:

- **OFF (default)** — nothing is captured. "read the text" and friends reply
  that vision is off and ask you to flip the switch.
- **ON** — clicking the switch opens Chrome's own *Share this screen* picker.
  Only a click can grant that; a voice command can never turn vision on by
  itself (it will ask you to). Once live, a small preview shows exactly what
  Jarvis sees, and the read/explain commands above work.
- **OFF again** — the switch, "stop seeing my screen", Chrome's *Stop sharing*
  bar, or closing the tab stops every capture track immediately.

A frame is encoded only at the moment you ask for it — one screenshot per
command, sent through the local bridge to the multimodal model
(`qwen/qwen3.8-27b`) like any other chat, so the API key still never reaches
the browser.

## Laptop Media Control (volume + brightness)

Browsers can never touch system audio or the panel backlight, so these
commands run through the bridge: `POST /media` keeps a resident PowerShell
worker (`bridge/media-worker.ps1`) that talks to Windows Core Audio (volume,
mute) and WMI (`WmiSetBrightness`) directly. The interop compiles once on the
first command (~1s) and every command after that answers in milliseconds; the
worker stops itself after 2 minutes idle.

- Works from **voice and the text command box** alike — same matcher, same
  pipeline, reply spoken naturally: *"Volume set to 50%, Sir."* /
  *"Brightness increased to 70%, Sir."* (Hindi included).
- The **SYSTEM CONTROLS** panel in the top-right corner shows
  `🔊 Volume: 50%` and `☀️ Brightness: 70%` live. It updates the instant a
  command lands, and refreshes in the background on every prompt (so Fn-key
  changes show up too) — there is no polling loop.
- The panel also shows a `MUTED` badge while the speakers are muted, and thin
  progress bars under each value.
- Needs the bridge running (`npm start` auto-starts it); without it the
  commands say so instead of failing silently.

## Web Research + Browser Control

Two capabilities sit on top of the desktop bridge — both **free, keyless and
local** (no paid API, no recurring cost):

**Web research** — questions that need *current* information ("price of gold",
"latest NVIDIA news", "weather", "current CEO", "who won today's match", or an
explicit "search the web for X") search the web **first** (`GET /search` →
`bridge/web-search.js`), then the reply is generated only from the retrieved
results. The same tool answers ordinary **search commands** — "search for X",
"search X karo", "look up X" reply from the results with sources instead of
opening a browser tab. **Chrome is never opened for research**; only an
explicit "search google for X" / "google X" reaches a Google tab:

- The console logs `🔎 WEB SEARCH` with every source (title + URL) above the
  answer, and the reply opens with *"According to the latest information I
  found…"* with inline `[1] [2]` citations.
- Results are fed to the model as a bounded system message; it is instructed
  never to answer from training memory and to say plainly when the results
  don't contain the answer — it never fabricates.
- If the search fails (bridge down, network down, every provider down), the
  failure is **spoken** — *"the web search failed — I couldn't access the web"*
  — no model answer is invented, and listening continues.
- Providers are abstract (`providers` map in `bridge/web-search.js`): DuckDuckGo
  lite/html first, with Bing RSS + Google News RSS merged as free fallbacks —
  swap engines via `SEARCH_PROVIDER` without touching callers.

**Browser control** — J.A.R.V.I.S opens and drives its own browser window
(`POST /browser` → `bridge/browser-control.js`, `puppeteer-core` driving the
Chrome/Edge already installed — no bundled browser, no key):

- Controlled functions only: `newTab`, `googleSearch`, `back`, `forward`,
  `refresh`, `current`, `closeTab`. The LLM never executes shell commands,
  page JS, or arbitrary URLs — only these whitelisted actions.
- URL validation: only well-formed `http/https` links are opened
  (`javascript:`/`file:`/data URLs are refused, with no fallback opener).
- One window is launched lazily and kept alive for the bridge's lifetime, so
  tabs and history **persist between voice commands**.
- Follow-ups read **two separate bounded contexts** — browser state and
  web-search state are never mixed:
  - *browser context* — `active_browser`, `active_tab`, `active_site`,
    `last_browser_action` (which window/tab/site is active — `active_site`
    is what makes "search for X" search *inside* YouTube when YouTube is open),
  - *web-search context* — `last_search_query`, `last_search_results`,
    `last_search_source` (capped at 10 results): *search* → *open the first
    result* → *go back* → *refresh*.
- **CAPTCHA policy (explicit Google searches only):** when Google serves a
  reCAPTCHA / "unusual traffic" page, the bridge detects it (`/sorry/` URL or
  challenge markup) and stops gracefully — Jarvis speaks *"Google is asking for
  human verification, so I can't continue the automated Google search."* It
  never solves, bypasses, or retries Google, and no second tab is opened.
- **YouTube control stays separate:** "open YouTube" opens it in plain Chrome;
  with YouTube as the active site, "search for X" uses the keyless
  `GET /ytsearch` (results page in Chrome + stored context) and "play the
  first result" opens the stored first video — no Google search anywhere in
  that flow.
- "Open the official website of X" searches first and scores real results for
  the official domain (`.ac.in`, `.gov`, `.edu`, token match in the host;
  Wikipedia/SEO farms penalised) — it never guesses a URL. If nothing
  qualifies, it says so instead of opening something wrong.
- Failures (bridge offline, no window, no history) are reported — they never
  crash the pipeline, and the mic keeps listening.

## Groq API key (kept out of Git)

Your key lives in `.env` in the project folder — gitignored, so it is never
uploaded to GitHub:

```
GROQ_API_KEY=paste_your_groq_key_here
```

The browser never receives it. Chat goes `HUD → POST http://127.0.0.1:4777/groq
→ bridge attaches the key from .env → Groq`, and the streamed answer comes back
the same way. Nothing secret is in the frontend bundle, in localStorage, or in
this repository.

- `.env.example` documents the variable — copy it to `.env` on a new machine.
- The Settings panel's API-key box is gone (it used to store the key in
  browser storage; any old copy is cleared automatically when the HUD loads).
- Without the bridge, chat replies report "Desktop Bridge offline" instead of
  silently failing.
- `GET /health` returns `groqKeyPresent: true` when the key was found.

## Files

- `frontend/src/services/commandActions.js` — command matcher + executor
- `frontend/src/components/CommandTerminal.js` — recognition, barge-in,
  streaming TTS, action dispatch, 5s auto-close
- `frontend/src/components/VoicePlasma.js` — single shared mic + voice activity
- `frontend/src/components/DigitalClock.js` — top-left futuristic system clock
  (exact time + date, second-aligned tick)
- `frontend/src/services/screenVision.js` — consent-gated screen capture
  (`getDisplayMedia`, frame encoder, subscribe-able status)
- `frontend/src/components/ScreenVision.js` — bottom-left SCREEN VISION switch
  with live preview; turns the whole feature on/off
- `frontend/src/services/mediaControl.js` — media state store + `/media`
  bridge client (volume/brightness commands, shared UI state)
- `frontend/src/services/webSearch.js` — `/search` + `/ytsearch` bridge
  clients (research queries and YouTube context; returns
  `{title,url,snippet,source}[]` or an honest failure)
- `frontend/src/services/browserControl.js` — `/browser` bridge client with
  **split contexts** — browser store (`active_browser/active_tab/
  active_site/last_browser_action`) and web-search store
  (`last_search_query/results/source`) — plus the official-site picker and
  the voice-facing action dispatcher
- `frontend/src/components/SystemControls.js` — top-right SYSTEM CONTROLS
  readout (🔊 Volume / ☀️ Brightness, live percentages)
- `bridge/server.js` — zero-dependency local bridge on `127.0.0.1:4777`
  (`/health`, `/open?kind=url|app|file|folder|find&target=…`, `/groq` — the
  Groq proxy that attaches the API key from `.env` — `/media` for
  system volume/brightness, `/search` for web research, `/ytsearch` for
  YouTube context, and `/browser` for controlled browser actions)
- `bridge/web-search.js` — free keyless web search behind an abstract
  provider map (DuckDuckGo → Bing RSS / Google News RSS fallback chain) plus
  the keyless `searchYouTube()` results fetcher
- `bridge/browser-control.js` — controlled browser functions (whitelisted
  actions, `http/https` URL validation, CAPTCHA detection for explicit Google
  searches, persistent window via `puppeteer-core`)
- `bridge/package.json` — bridge dependencies (`puppeteer-core` only; free,
  no API key, drives the locally installed Chrome/Edge)
- `bridge/media-worker.ps1` — resident PowerShell worker (Core Audio + WMI)
  behind `/media`; spawned on demand, idle-exits after 2 minutes
- `bridge/ensure-bridge.js` — starts the bridge for `npm start` if it is down

## Troubleshooting

- **"Popup blocked"** — click the ⊙ icon in Chrome's address bar → *Always
  allow popups from localhost:3000*, or start the bridge (links then open
  through it, which Chrome never blocks).
- **"Desktop Bridge offline" / "open chrome" does nothing / searches do not
  open** — the bridge is not running: restart it with `npm start` (it
  auto-starts the bridge) or run `npm run bridge` from `frontend/`, then wait
  for `🖥️ BRIDGE ONLINE` in the footer. To stop the bridge: end the `node`
  process listening on port 4777.
- **Wrong language recognised** — the pills in the console header select the
  recognition language (default `hi-IN`).
