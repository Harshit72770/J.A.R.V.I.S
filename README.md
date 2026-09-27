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

Anything the matcher does not recognise goes to Groq as a normal chat reply.
Actions never round-trip through the model, so they answer instantly.

J.A.R.V.I.S's identity (name: Jarvis, creator: **Harshit Gupta**, personal AI
assistant) is also written into the system prompt, so every other phrasing of
"who are you" gets the same answer.

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
- `bridge/server.js` — zero-dependency local bridge on `127.0.0.1:4777`
  (`/health`, `/open?kind=url|app|file|folder|find&target=…`, `/groq` — the
  Groq proxy that attaches the API key from `.env`)
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
