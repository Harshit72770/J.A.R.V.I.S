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
- `frontend/src/components/SystemControls.js` — top-right SYSTEM CONTROLS
  readout (🔊 Volume / ☀️ Brightness, live percentages)
- `bridge/server.js` — zero-dependency local bridge on `127.0.0.1:4777`
  (`/health`, `/open?kind=url|app|file|folder|find&target=…`, `/groq` — the
  Groq proxy that attaches the API key from `.env` — and `/media` for
  system volume/brightness)
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
