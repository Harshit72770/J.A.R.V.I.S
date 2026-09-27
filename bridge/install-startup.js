/**
 * J.A.R.V.I.S Desktop Bridge — Windows Startup installer
 * =======================================================
 *   Install : node bridge/install-startup.js        (or: npm run bridge:startup)
 *   Remove  : node bridge/install-startup.js --remove (or: npm run bridge:startup:off)
 *
 * Writes a hidden launcher into the user's Startup folder:
 *   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\JARVIS-bridge.vbs
 *
 * It starts bridge\server.js at every login with NO window, so the HUD always
 * finds the bridge online and voice commands can open apps, files and tabs.
 * The bridge listens on 127.0.0.1 only — nothing on the network can reach it.
 */

const fs = require('fs');
const path = require('path');

const STARTUP_DIR = path.join(
  process.env.APPDATA || '',
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup'
);
const LAUNCHER = path.join(STARTUP_DIR, 'JARVIS-bridge.vbs');
const BRIDGE = path.join(__dirname, 'server.js');
const removing = process.argv.includes('--remove');

// A path inside a VBS string literal: backslashes kept, quotes doubled.
const vbsString = (value) => `"${String(value).replace(/"/g, '""')}"`;

if (removing) {
  if (fs.existsSync(LAUNCHER)) {
    fs.unlinkSync(LAUNCHER);
    console.log('[jarvis] Startup launcher removed — the bridge will no longer start at login.');
  } else {
    console.log('[jarvis] Nothing to remove — no Startup launcher found.');
  }
  process.exit(0);
}

if (!process.env.APPDATA) {
  console.error('[jarvis] APPDATA is not set — cannot find the Startup folder.');
  process.exit(1);
}
if (!fs.existsSync(BRIDGE)) {
  console.error('[jarvis] Bridge not found at ' + BRIDGE);
  process.exit(1);
}

fs.mkdirSync(STARTUP_DIR, { recursive: true });

const script = [
  "' J.A.R.V.I.S Desktop Bridge - started automatically at every login.",
  "' Created by bridge/install-startup.js. Remove with:",
  "'   node bridge/install-startup.js --remove",
  'Option Explicit',
  'Dim shell, command',
  'Set shell = CreateObject("WScript.Shell")',
  `' ${vbsString(path.basename(process.execPath))} + ${vbsString(BRIDGE)}`,
  // WshShell.Run does its own command-line parsing: both paths must carry
  // their own quotes or "C:\Program Files\..." is read as "C:\Program".
  `command = ${vbsString(`"${process.execPath}"`)} & " " & ${vbsString(
    `"${BRIDGE}"`
  )}`,
  "' 0 = hidden window, False = do not wait for it to exit",
  'shell.Run command, 0, False',
  '',
]
  .join('\r\n')
  // Windows Script Host reads .vbs as ANSI: keep the file pure ASCII so no
  // path or comment can ever be mis-decoded.
  .replace(/[^\x00-\x7F]/g, '-');

fs.writeFileSync(LAUNCHER, script, 'utf8');

console.log('[jarvis] Installed: ' + LAUNCHER);
console.log('[jarvis] The bridge now starts by itself at every login (hidden, no window).');
console.log('[jarvis] Remove it with: node bridge/install-startup.js --remove');
