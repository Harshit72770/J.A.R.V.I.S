/**
 * Starts the J.A.R.V.I.S Desktop Bridge if it is not already running.
 * =========================================================================
 * `npm start` runs this first, so the HUD never comes up while the bridge is
 * offline — offline is what breaks "open chrome" and every Google search
 * (voice commands carry no user gesture, so Chrome blocks the fallback tab).
 *
 * The bridge is spawned DETACHED, so it keeps running after this script — and
 * after `npm start` — exits. Stop it with Task Manager (node, port 4777) or by
 * running `npm run bridge` in a window and pressing Ctrl+C there.
 *
 * Always exits 0: a bridge problem must not stop the frontend from starting.
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4777;
const BRIDGE = path.join(__dirname, 'server.js');

const probe = () =>
  new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/health', timeout: 700 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve(body.includes('"ok":true')));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  try {
    if (await probe()) {
      console.log(
        '[jarvis] Desktop Bridge already running on port ' + PORT + '.'
      );
      return;
    }

    let child;
    try {
      child = spawn(process.execPath, [BRIDGE], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => {
        console.warn(
          '[jarvis] Could not start the Desktop Bridge — laptop control will be unavailable.'
        );
      });
      child.unref();
    } catch (e) {
      console.warn('[jarvis] Could not start the Desktop Bridge:', e.message);
      return;
    }

    for (let i = 0; i < 20; i += 1) {
      await sleep(250);
      if (await probe()) {
        console.log(
          '[jarvis] Desktop Bridge started on port ' +
            PORT +
            ' — apps, files and searches are controllable by voice.'
        );
        return;
      }
    }

    console.warn(
      '[jarvis] Desktop Bridge did not come up. Voice actions that control the laptop ' +
        'will show "Bridge offline" — start it manually with: npm run bridge'
    );
  } catch (e) {
    // Never block the frontend from starting because of the bridge.
    console.warn('[jarvis] ensure-bridge:', e && e.message);
  }
})();
