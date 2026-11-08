/**
 * Window placement helpers.
 *
 * The automation must never interrupt whatever the user is doing, so every
 * window it opens (Opera GX, the Battle.net app) is moved to the SECOND monitor
 * without taking focus. On a single-monitor PC it is minimised instead.
 *
 * All of this is best-effort: a placement failure must never fail a run.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const DIR = __dirname;
let screenCache = null;

function runPs(file, args = [], timeoutMs = 60000) {
  try {
    const r = spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(DIR, file), ...args,
    ], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    const out = (r.stdout || '').trim();
    if (!out) return null;
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** Connected screens (bounds + work area in physical pixels). */
function screens() {
  if (!screenCache) {
    const j = runPs('displays.ps1', [], 30000);
    screenCache = (j && Array.isArray(j.screens)) ? j.screens : [];
  }
  return screenCache;
}

function toRect(s) {
  return { left: s.workLeft, top: s.workTop, width: s.workWidth, height: s.workHeight };
}

function primaryWorkArea() {
  const s = screens().find(x => x.primary) || screens()[0];
  return s ? toRect(s) : null;
}

/** Work area of the first non-primary monitor, or null on a single screen. */
function secondaryWorkArea() {
  const s = screens().find(x => !x.primary);
  return s ? toRect(s) : null;
}

/**
 * Rectangle for column `index` of `count` on the secondary monitor.
 * Null on a single-screen PC (there is nothing to move to).
 */
function automationRect(index, count) {
  const area = secondaryWorkArea();
  if (!area) return null;
  const n = Math.max(1, count);
  const w = Math.floor(area.width / n);
  return {
    left: area.left + index * w,
    top: area.top,
    width: index === n - 1 ? area.width - index * w : w,
    height: area.height,
  };
}

/**
 * Moves every top-level window of `proc` onto side-by-side column `index` of
 * `count` on the secondary monitor.
 *
 * @param {string} proc   process name, e.g. 'opera' or 'Battle.net'
 * @param {number} index  column index (0-based)
 * @param {number} count  number of columns
 * @param {{waitSeconds?:number,minimize?:boolean,pid?:number}} [opts]
 */
function placeAutomationWindow(proc, index, count, opts = {}) {
  const area = secondaryWorkArea();
  if (!area) {
    // one screen only -> stay out of the way entirely
    return place(proc, primaryWorkArea() || { left: 0, top: 0, width: 1280, height: 720 }, {
      waitSeconds: opts.waitSeconds,
      minimize: true,
      pid: opts.pid,
    });
  }

  return place(proc, automationRect(index, count), { waitSeconds: opts.waitSeconds, pid: opts.pid });
}

/**
 * @param {string} proc
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @param {{waitSeconds?:number,minimize?:boolean,pid?:number}} [opts]
 */
function place(proc, rect, opts = {}) {
  const waitSeconds = opts.waitSeconds == null ? 20 : opts.waitSeconds;
  const args = [];
  if (opts.pid) args.push('-ProcessId', String(opts.pid));
  else args.push('-ProcessName', proc);
  args.push(
    '-Left', String(Math.round(rect.left)),
    '-Top', String(Math.round(rect.top)),
    '-Width', String(Math.round(rect.width)),
    '-Height', String(Math.round(rect.height)),
    '-WaitSeconds', String(waitSeconds),
    '-Cascade', '28',
  );
  if (opts.minimize) args.push('-Minimize');
  return runPs('place-window.ps1', args, (waitSeconds + 25) * 1000);
}

/** Process name of the window that has the focus right now (null when unknown). */
function foregroundProcess() {
  const r = runPs('foreground.ps1', [], 15000);
  return (r && typeof r.process === 'string' && r.process) ? r.process.toLowerCase() : null;
}

module.exports = {
  screens,
  primaryWorkArea,
  secondaryWorkArea,
  automationRect,
  place,
  placeAutomationWindow,
  foregroundProcess,
};
