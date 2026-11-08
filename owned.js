/**
 * Remembers which apps this project started.
 *
 * A run can end without cleaning up (crash, reboot, closed window), and the
 * user must never be left with automation windows on their screen. The marker
 * files let the next run recognise and close those leftovers.
 *
 * Markers live next to the scripts and are deleted as soon as the app is gone.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const FILES = {
  opera: path.join(__dirname, '.opera-owned'),
  bnet: path.join(__dirname, '.bnet-owned'),
  epic: path.join(__dirname, '.epic-owned'),
};

/** @param {'opera'|'bnet'|'epic'} which @param {boolean} [on] */
function mark(which, on = true) {
  const file = FILES[which];
  if (!file) return;
  try {
    if (on) fs.writeFileSync(file, new Date().toISOString() + '\n');
    else fs.rmSync(file, { force: true });
  } catch {}
}

/** @param {'opera'|'bnet'|'epic'} which */
function isOwned(which) {
  return !!FILES[which] && fs.existsSync(FILES[which]);
}

/**
 * True when the running Opera GX carries the exact flag set this project uses.
 * That is how an instance left behind by an older version (no marker file) is
 * recognised as ours, without touching a browser the user started themselves -
 * even if they added --remote-debugging-port=9222 to their shortcut.
 */
function operaHasOurFlags() {
  try {
    const r = spawnSync('powershell', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='opera.exe'\" | " +
      "Where-Object { $_.CommandLine -notmatch '--type=' } | " +
      "Select-Object -First 1 -ExpandProperty CommandLine",
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true });

    const cmd = (r.stdout || '').trim();
    return /--remote-debugging-port=9222\b/.test(cmd)
      && /--remote-allow-origins=\*/.test(cmd)
      && /--no-first-run/.test(cmd)
      && /--restore-last-session/.test(cmd);
  } catch {
    return false;
  }
}

module.exports = { mark, isOwned, operaHasOurFlags };
