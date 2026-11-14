/**
 * GX Rewards -> Overwatch : claim daily reward + redeem on Battle.net
 *
 * Runs against the real Opera GX (via CDP) so the existing login cookies are used.
 * Designed to be idempotent: safe to run every 30 minutes.
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { notify } = require('./notify');
const { targets } = require('./cdp');
const { redeemViaApp } = require('./bnet-redeem');
const owned = require('./owned');
const windows = require('./windows');

/** First existing candidate path (so the folder works on any Windows user). */
function firstExisting(candidates) {
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return candidates.filter(Boolean)[0] || '';
}

const CFG = {
  gpId: '2d51beb7-a45e-4a94-90ef-1852021963f6',
  gpAlias: 'alias:overwatch-campaign',
  cdp: 'http://127.0.0.1:9222',
  opera: firstExisting([
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Opera GX', 'opera.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Opera GX', 'opera.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Opera GX', 'opera.exe'),
    'C:\\Program Files\\Opera GX\\opera.exe',
    'C:\\Program Files (x86)\\Opera GX\\opera.exe',
  ]),
  profile: path.join(process.env.APPDATA, 'Opera Software', 'Opera GX Stable'),
  campaignUrl: 'https://gx.me/gx/en-GB/campaigns/overwatch-campaign/?popup=1',
  dir: __dirname,
};

// The Battle.net desktop app stays signed in, so codes are redeemed inside it.
const BNET = {
  exe: firstExisting([
    'C:\\Program Files (x86)\\Battle.net\\Battle.net.exe',
    'C:\\Program Files\\Battle.net\\Battle.net.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Battle.net', 'Battle.net.exe'),
  ]),
  port: 9223,
};

const LEDGER = path.join(CFG.dir, 'ledger.json');
const LOGDIR = path.join(CFG.dir, 'logs');
// Present while the app runs on a hidden desktop launched for game-time runs.
const HIDDEN_MARKER = path.join(CFG.dir, '.bnet-hidden');
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const NO_POWER = process.argv.includes('--no-power');
const KEEP_OPEN = process.argv.includes('--keep-open');
// Redeem codes that are already in the ledger without opening Opera at all.
const REDEEM_ONLY = process.argv.includes('--redeem-only');
// Never try to restore an expired GX session on our own.
const NO_RELOGIN = process.argv.includes('--no-relogin');

// True when this run started (or restarted) the app itself. Apps this run
// launched are always closed afterwards, even if Windows focused them - the
// "user is using it" exception only applies to apps that were already open.
let operaLaunched = false;
let bnetLaunched = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * The GX API returns nextUnlockAt = "server now + a few hundred ms" when the
 * reward gate is OPEN (the server clock runs slightly ahead of this machine).
 * Comparing strictly with > therefore reports "still locked" forever.
 * Anything within this window is treated as unlocked.
 */
const UNLOCK_TOLERANCE_MS = 2 * 60 * 1000;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOGDIR, { recursive: true });
    fs.appendFileSync(path.join(LOGDIR, `${new Date().toISOString().slice(0, 10)}.log`), line + '\n');
  } catch {}
}

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); }
  catch { return { rewards: {}, nextUnlockAt: null, lastCheck: 0, done: false }; }
}
function saveLedger(l) {
  fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2));
}

/* ---------------- Opera GX / CDP ---------------- */

async function cdpUp() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 3000);
    const r = await fetch(CFG.cdp + '/json/version', { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

function operaRunning() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq opera.exe', '/NH'], { encoding: 'utf8' });
  return /opera\.exe/i.test(r.stdout || '');
}

/**
 * Moves the automation's windows to the second monitor. Best effort only:
 * a placement failure must never fail the run.
 */
function placeWindow(proc, column, count, opts = {}) {
  const r = windows.placeAutomationWindow(proc, column, count, opts);
  if (r && r.ok) {
    log(`${proc} window(s) moved to the second screen${opts.minimize ? ' (minimized for now)' : ''}: ${r.count}`);
  } else {
    log(`could not move the ${proc} window (${r ? r.reason : 'no output'})`);
  }
  return r;
}

function launchOpera() {
  const rect = windows.automationRect(0, 2);
  const args = [
    '--remote-debugging-port=9222',
    '--remote-allow-origins=*',
    `--user-data-dir=${CFG.profile}`,
    '--restore-last-session',
    '--no-first-run',
  ];
  if (rect) {
    // first guess; the Win32 placement below has the final word, because
    // --restore-last-session can override these flags
    args.push(
      `--window-position=${rect.left},${rect.top}`,
      `--window-size=${rect.width},${rect.height}`,
    );
  }

  log('launching Opera GX with remote debugging (second screen)');
  spawn(CFG.opera, args, { detached: true, stdio: 'ignore' }).unref();
  owned.mark('opera', true);
  operaLaunched = true;

  // get the restored window off the first screen straight away
  placeWindow('opera', 0, 2, { waitSeconds: 20, minimize: true });
}

async function ensureBrowser() {
  if (await cdpUp()) {
    if (!owned.isOwned('opera') && owned.operaHasOurFlags()) {
      log('note: Opera GX was left running by an earlier run - it will be closed afterwards');
      owned.mark('opera', true);
    }
    placeWindow('opera', 0, 2, { waitSeconds: 5 });
    return { killed: false, launched: false };
  }

  // marker without a running debug port = the browser is gone
  if (owned.isOwned('opera')) owned.mark('opera', false);

  let killed = false;
  if (operaRunning()) {
    log('Opera GX is running without the debug port; restarting it (session will be restored)');
    spawnSync('taskkill', ['/IM', 'opera.exe'], { encoding: 'utf8' });
    await sleep(6000);
    if (operaRunning()) spawnSync('taskkill', ['/IM', 'opera.exe', '/F'], { encoding: 'utf8' });
    await sleep(2000);
    killed = true;
  }

  launchOpera();
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    if (await cdpUp()) {
      placeWindow('opera', 0, 2, { waitSeconds: 10 });
      return { killed, launched: true };
    }
  }
  throw new Error('Opera GX did not open the debugging port (9222)');
}

/* ---------------- GX Rewards ---------------- */

async function gxPage(ctx) {
  let p = ctx.pages().find(x => x.url().includes('gx.me/gx/'));
  if (!p) {
    p = await ctx.newPage();
    await p.goto(CFG.campaignUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
  }
  return p;
}

/**
 * Restores an expired GX session without a human, when possible.
 *
 * The sign-out page asks for the Terms checkbox and a Cloudflare Turnstile
 * token, then "Log in with Battle.net". The Battle.net session usually still
 * lives in the Opera GX profile, so pressing "Log in" completes the SSO by
 * itself. Nothing is typed and no credential is stored: if Battle.net asks for
 * a password or a 2FA code, the attempt stops and a human is needed.
 *
 * Returns 'ok' | 'needs-user' | 'no-form' | 'no-button' | 'no-token'.
 */
async function attemptGxLogin(ctx, page) {
  const bodyText = () => page.evaluate(() => document.body.innerText || '').catch(() => '');

  if (!page.url().includes('gx.me/gx/')) {
    await page.goto(CFG.campaignUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(5000);
  }

  // already signed in? (the sign-out page always shows the SSO prompt)
  const signOutPage = (t) => /log in with battle\.net/i.test(t);
  if (!signOutPage(await bodyText())) return 'ok';

  // 1) the Terms checkbox must be ticked before "Log in" does anything
  const tickTerms = async () => page.evaluate(() => {
    const cb = document.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) cb.click();
  });

  // 2) Cloudflare Turnstile: the non-interactive token can take a couple of
  //    minutes, especially on a fresh profile - reload once and wait again.
  const readToken = () => page.evaluate(() =>
    (document.querySelector('[name="cf-turnstile-response"]') || {}).value || '');
  const waitToken = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const t = await readToken();
      if (t) return t;
      await sleep(2000);
    }
    return '';
  };

  let token = '';
  for (let round = 1; round <= 2 && !token; round++) {
    const hasBox = await page.evaluate(() => !!document.querySelector('input[type="checkbox"]'));
    if (!hasBox) return 'no-form';
    await tickTerms();
    token = await waitToken(100 * 1000);
    if (!token && round === 1) {
      log('GX login: the Cloudflare challenge is slow; reloading the page once');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(6000);
    }
  }
  if (!token) {
    log('GX login: the Cloudflare challenge did not clear by itself');
    return 'no-token';
  }

  // 3) press "Log in" and let the Battle.net SSO finish
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll('button, a, [role="button"]')]
      .find(x => /^log\s*in$/i.test((x.innerText || '').trim()) && (x.offsetWidth || x.offsetHeight));
    if (!el) return false;
    el.click();
    return true;
  });
  if (!clicked) return 'no-button';

  for (let i = 0; i < 25; i++) {
    await sleep(3000);

    // a password / 2FA form anywhere means only the account owner can continue
    const needsHuman = await Promise.all(ctx.pages().map(p =>
      p.evaluate(() => document.querySelectorAll('input[type="password"]').length > 0).catch(() => false),
    ));
    if (needsHuman.some(Boolean)) {
      log('GX login: Battle.net is asking for a password or 2FA code');
      return 'needs-user';
    }

    if (!signOutPage(await bodyText())) return 'ok';
  }
  return 'needs-user';
}

async function fetchState(page) {
  const txt = await page.evaluate(async (url) => {
    const r = await fetch(url, { credentials: 'include' });
    return r.text();
  }, `https://api.gx.me/me/rewards/game-passes/${CFG.gpAlias}`);
  const j = JSON.parse(txt);
  if (!j || !j.data) {
    const code = (j && j.errors && j.errors[0] && j.errors[0].code) || null;
    const err = new Error(code === 'sign_in_required'
      ? 'GX session expired (sign_in_required)'
      : 'bad state payload: ' + txt.slice(0, 200));
    if (code) err.code = code;
    throw err;
  }
  return j.data;
}

/** GX API error code from a claim response body, or null. */
function apiErrorCode(body) {
  try { return JSON.parse(body).errors[0].code || null; } catch { return null; }
}

/**
 * fetchState that treats a signed-out GX session as a normal state instead of
 * a crash: returns { state: null, loginRequired: true } in that case.
 */
async function safeFetchState(page) {
  try {
    return { state: await fetchState(page), loginRequired: false };
  } catch (err) {
    if (err && err.code === 'sign_in_required') return { state: null, loginRequired: true };
    throw err;
  }
}

async function postClaim(page) {
  return page.evaluate(async (gp) => {
    const r = await fetch(`https://api.gx.me/me/rewards/game-passes/${gp}/claim-reward`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    return { status: r.status, body: await r.text() };
  }, CFG.gpId);
}

/** An authenticated answer proves the session works: drop the reminder throttle. */
function sessionHealthy(ledger) {
  if (ledger.lastGxLoginNotice) {
    delete ledger.lastGxLoginNotice;
    log('GX session is healthy again; login reminder reset');
  }
}

/**
 * One claim attempt.
 *   { outcome: 'ok' }     - reward claimed (post-claim state refreshed if possible)
 *   { outcome: 'locked' } - the gate is not open yet
 *   { outcome: 'login' }  - the GX session expired; the caller may sign in and retry
 */
async function claimRewardOnce(page, ledger) {
  const claim = await postClaim(page);
  log(`claim response: ${claim.status} ${claim.body.slice(0, 300)}`);

  if (claim.status === 200) {
    await sleep(3000);
    const after = await safeFetchState(page);
    if (after.state) {
      ledger.nextUnlockAt = after.state.nextUnlockAt || null;
      syncLedger(after.state, ledger);
    }
    sessionHealthy(ledger);
    return { outcome: 'ok', loginAfter: !after.state };
  }

  const errCode = apiErrorCode(claim.body);
  if (errCode === 'reward_not_available') {
    await sleep(3000);
    const again = await safeFetchState(page);
    if (again.state) {
      ledger.nextUnlockAt = again.state.nextUnlockAt || ledger.nextUnlockAt;
      log(`still locked; next unlock ${ledger.nextUnlockAt}`);
    }
    sessionHealthy(ledger);
    return { outcome: 'locked' };
  }

  if (errCode === 'sign_in_required' || claim.status === 401) return { outcome: 'login' };
  throw new Error(`claim failed: ${claim.status} ${claim.body}`);
}

/** Add any claimed reward that is missing from the ledger, and refresh codes that arrived late. */
function syncLedger(state, ledger) {
  let added = 0;
  for (const r of state.rewards) {
    if (!r.hasBeenClaimed) continue;
    const info = rewardInfo(r);
    const entry = ledger.rewards[info.id];
    if (!entry) {
      ledger.rewards[info.id] = {
        ordinal: info.ordinal,
        title: info.title,
        type: info.type,
        code: info.code,
        claimedAt: new Date().toISOString(),
        redeem: null,
        note: 'found already claimed (not by this script)',
      };
      added++;
    } else if (!entry.code && info.code) {
      entry.code = info.code;
      entry.note = 'code arrived late';
    }
  }
  return added;
}

/** Rewards with a code that still need a successful redemption. */
function pendingRedeems(ledger) {
  return Object.values(ledger.rewards).filter(e => {
    if (!e.code) return false;
    if (!e.redeem) return true;
    // login_required means the code was never submitted - must be retried.
    // dry-run is not a real attempt either.
    return ['error', 'unknown', 'login_required', 'dry-run'].includes(e.redeem.status);
  });
}

function rewardInfo(r) {
  const item = (r.rewardItems || [])[0] || {};
  const offer = item.offerCodeReward || {};
  return {
    id: r.rewardId,
    ordinal: r.ordinal,
    title: (r.title && r.title.value) || `Reward ${r.ordinal + 1}`,
    type: (r.description && r.description.value) || '',
    code: offer.codeValue || null,
    claimStatus: offer.claimStatus || null,
  };
}

/* ---------------- Battle.net redeem ---------------- */

function bnetRunning() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Battle.net.exe', '/NH'], { encoding: 'utf8' });
  return /Battle\.net\.exe/i.test(r.stdout || '');
}

// Blizzard games the user may be playing when a run starts. While one of them
// is open the Battle.net app is treated as untouchable: it is only used when it
// is already listening on the debug port, it is never closed afterwards, and
// the PC is never sent back to sleep (that would kill the match).
const BLIZZARD_GAMES = [
  'Overwatch.exe',
  'HeroesOfTheStorm.exe',
  'Wow.exe',
  'WowClassic.exe',
  'Diablo IV.exe',
  'Diablo III64.exe',
  'Destiny2.exe',
  'Hearthstone.exe',
  'SC2_x64.exe',
  'SC2.exe',
  'Warcraft III.exe',
  'COD.exe',
];

/** Name of the Blizzard game running right now (without .exe), or null. */
function blizzardGameRunning() {
  try {
    const r = spawnSync('tasklist', ['/NH'], { encoding: 'utf8', timeout: 20000 });
    const out = (r.stdout || '').toLowerCase();
    for (const exe of BLIZZARD_GAMES) {
      if (out.includes(exe.toLowerCase())) return exe.replace(/\.exe$/i, '');
    }
  } catch {}
  return null;
}

/** Idle seconds of the logged-in user, or 0 when unknown. */
function userIdleSeconds() {
  const info = sysInfo();
  return info && typeof info.idleSeconds === 'number' ? info.idleSeconds : 0;
}

/**
 * Makes sure the Battle.net app is running with its debug port so we can drive
 * the in-app "Redeem Code" window.
 *
 * An app that was started normally has no debug port, so it cannot be driven.
 * Restarting it is the only way in, and while the user is playing a game that
 * restart would briefly take the focus. So during a game the app is started on
 * a private desktop with no visible window (see launch-bnet-hidden.ps1): the
 * game keeps the foreground the whole time and nothing appears on any screen.
 */
async function ensureBattleNetApp() {
  // A marker left behind by a killed launcher would make later runs believe the
  // app is invisible when it is not.
  if (fs.existsSync(HIDDEN_MARKER) && !bnetRunning()) {
    log('clearing a stale hidden-desktop marker (Battle.net is not running)');
    fs.rmSync(HIDDEN_MARKER, { force: true });
  }

  const up = await targets(BNET.port).catch(() => null);
  if (up && up.some(t => t.url.startsWith('resources://home'))) {
    if (!owned.isOwned('bnet')) {
      log('note: Battle.net was left running by an earlier run - it will be closed afterwards');
      owned.mark('bnet', true);
    }
    if (!fs.existsSync(HIDDEN_MARKER)) placeWindow('Battle.net', 1, 2, { waitSeconds: 3 });
    return { ok: true };
  }

  if (!fs.existsSync(BNET.exe)) return { ok: false, message: 'Battle.net is not installed' };

  if (bnetRunning()) {
    // The app is open but was started without the debug port, so it cannot be
    // driven. The user asked for redemption to happen inside their app instead
    // of the website, so we restart it with the port - even while they play.
    const idle = userIdleSeconds();
    log(`restarting Battle.net with the debug port (user idle ${idle}s)`);
    spawnSync('taskkill', ['/IM', 'Battle.net.exe'], { encoding: 'utf8' });
    await sleep(6000);
    if (bnetRunning()) {
      spawnSync('taskkill', ['/IM', 'Battle.net.exe', '/F'], { encoding: 'utf8' });
      await sleep(4000);
    }
  }

  const game = blizzardGameRunning();
  if (game) {
    // Hidden desktop: a normal window would activate itself for a second when
    // it is created, which can throw the game out of fullscreen. This way the
    // app stays completely invisible and the game never loses the focus.
    log(`launching Battle.net on a hidden desktop (${game} is running)`);
    // wscript -> hidden PowerShell: the launcher must outlive this run's
    // console, otherwise the desktop (and the app) would die with it
    spawn('wscript.exe', [
      '//nologo',
      path.join(CFG.dir, 'run-hidden-ps.vbs'),
      path.join(CFG.dir, 'launch-bnet-hidden.ps1'),
    ], { windowsHide: true, stdio: 'ignore' }).unref();
    owned.mark('bnet', true);
    bnetLaunched = true;

    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      const list = await targets(BNET.port).catch(() => null);
      if (list && list.some(t => t.url.startsWith('resources://home'))) {
        await sleep(4000); // let the profile menu finish loading
        return { ok: true };
      }
    }
    return { ok: false, message: 'Battle.net did not open the debug port (hidden desktop)' };
  }

  log(`launching the Battle.net app with remote debugging`);
  spawn(BNET.exe, [`--remote-debugging-port=${BNET.port}`], { detached: true, stdio: 'ignore' }).unref();
  owned.mark('bnet', true);
  bnetLaunched = true;

  // the launcher window must not appear over the user's game while it boots
  placeWindow('Battle.net', 1, 2, { waitSeconds: 30, minimize: true });

  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const list = await targets(BNET.port).catch(() => null);
    if (list && list.some(t => t.url.startsWith('resources://home'))) {
      placeWindow('Battle.net', 1, 2, { waitSeconds: 10 });
      await sleep(4000); // let the profile menu finish loading
      return { ok: true };
    }
  }
  return { ok: false, message: 'Battle.net did not open the debug port' };
}

async function redeem(code) {
  if (DRY) return { status: 'dry-run', message: 'not submitted' };

  // The desktop app is the only path: it stays signed in on this PC, while the
  // website session expires constantly. Codes are typed into the app's own
  // "Redeem a code" window, never into a browser tab.
  const app = await ensureBattleNetApp();
  if (!app.ok) {
    log(`Battle.net app unavailable: ${app.message}`);
    return { status: 'error', message: app.message };
  }

  const r = await redeemViaApp(code).catch(e => ({ status: 'error', message: e.message }));
  if (r.status === 'error') log(`app redeem failed (${String(r.message).slice(0, 120)})`);
  return r;
}

/* ---------------- notifications ---------------- */

// channels are configured in config.json (ntfy / telegram / discord + desktop toast)

/* ---------------- power / cleanup ---------------- */

function sysInfo() {
  try {
    const r = spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(CFG.dir, 'sysinfo.ps1'),
    ], { encoding: 'utf8', timeout: 40000 });
    return JSON.parse((r.stdout || '').trim());
  } catch { return null; }
}

async function closeOpera() {
  if (!operaRunning()) { owned.mark('opera', false); return false; }
  log('closing Opera GX (this task opened it)');
  spawnSync('taskkill', ['/IM', 'opera.exe'], { encoding: 'utf8' });
  await sleep(6000);
  if (operaRunning()) {
    spawnSync('taskkill', ['/IM', 'opera.exe', '/F'], { encoding: 'utf8' });
    await sleep(2000);
  }
  const gone = !operaRunning();
  if (gone) owned.mark('opera', false);
  else log('Opera GX is still running');
  return gone;
}

async function closeBattleNet() {
  if (!bnetRunning()) { owned.mark('bnet', false); fs.rmSync(HIDDEN_MARKER, { force: true }); return false; }
  log('closing the Battle.net app (this task opened it)');
  spawnSync('taskkill', ['/IM', 'Battle.net.exe'], { encoding: 'utf8' });
  await sleep(5000);
  if (bnetRunning()) {
    spawnSync('taskkill', ['/IM', 'Battle.net.exe', '/F'], { encoding: 'utf8' });
    await sleep(3000);
  }
  const gone = !bnetRunning();
  if (gone) { owned.mark('bnet', false); fs.rmSync(HIDDEN_MARKER, { force: true }); }
  else log('Battle.net is still running');
  return gone;
}

function sleepPC() {
  log('putting the PC back to sleep (woken by this task, nobody is using it)');
  try {
    spawn('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) { log('sleep failed: ' + e.message); }
}

/**
 * Cleanup policy:
 *  - always close the apps this project opened, even when the user is at the PC
 *    (they never asked for those windows)
 *  - except an app the user is actively using right now (foreground window)
 *  - put the PC back to sleep only if this task woke it and nobody is using it
 */
async function cleanup() {
  const info = sysInfo();
  const fakeIdle = process.env.GXR_FAKE_IDLE ? parseInt(process.env.GXR_FAKE_IDLE, 10) : null;
  const idle = fakeIdle !== null ? fakeIdle
    : (info && typeof info.idleSeconds === 'number' ? info.idleSeconds : 0);
  const resumedRecently = !!(info && info.lastResumeUtc &&
    Date.now() - Date.parse(info.lastResumeUtc) < 15 * 60 * 1000);
  const timerWake = /Type:\s*Timer/i.test((info && info.lastWake) || '');
  const userActive = idle < 120;

  log(`system: idle=${idle}s resumedRecently=${resumedRecently} timerWake=${timerWake}`);

  const fg = userActive ? windows.foregroundProcess() : null;
  if (userActive) log(`foreground app: ${fg || 'unknown'}`);

  // A match must never be interrupted: closing the app can drop the game's
  // launcher session, and sleeping would freeze the PC mid-game.
  const game = blizzardGameRunning();
  if (game) log(`${game} is running - not sleeping`);

  if (KEEP_OPEN) {
    log('[keep-open] leaving the windows this run opened');
  } else {
    if (owned.isOwned('opera')) {
      if (fg === 'opera' && !operaLaunched) log('Opera GX is in the foreground (in use) - leaving it open');
      else await closeOpera();
    }
    if (owned.isOwned('bnet')) {
      const hidden = fs.existsSync(HIDDEN_MARKER);
      if (game && !hidden) {
        // Kill it mid-match and the launcher session goes with it, so only put
        // it back in the tray; the next run will close it properly.
        log('leaving Battle.net open while a game is running (minimized, closed on a later run)');
        placeWindow('Battle.net', 1, 2, { waitSeconds: 5, minimize: true });
      } else if (fg === 'battle.net' && !bnetLaunched && !hidden) {
        log('Battle.net is in the foreground (in use) - leaving it open');
      } else {
        // incl. a hidden-desktop instance: an invisible app would otherwise
        // stay running where the user cannot see or use it
        await closeBattleNet();
      }
    }
  }

  // never sleep while a match is in progress (already logged above)
  if (game) return;

  if (userActive) {
    log('user is active - not sleeping');
    return;
  }

  if (NO_POWER) {
    log('[no-power] would put the PC back to sleep');
    return;
  }

  if (resumedRecently && timerWake) sleepPC();
}

/* ---------------- main ---------------- */

/** Redeems up to 3 pending codes inside the Battle.net app. */
async function redeemPending(ledger, result, justClaimed = false) {
  const pending = pendingRedeems(ledger).slice(0, 3);
  for (const e of pending) {
    log(`redeeming ${e.code} ("${e.title}") on Battle.net...`);
    const rr = await redeem(e.code);
    e.redeem = { ...rr, at: new Date().toISOString() };
    saveLedger(ledger);
    log(`redeem result: ${rr.status} - ${rr.message}`);
    result.redeemed.push(`${e.title}: ${rr.status}`);
    if (justClaimed) result.claimed.push(`${e.ordinal + 1}. ${e.title}`);
    await sleep(2000);
  }
  return pending.length;
}

async function main() {
  const ledger = loadLedger();
  const now = Date.now();

  // No GX work: only retry codes already sitting in the ledger (no Opera).
  if (REDEEM_ONLY) {
    const result = { action: 'idle', claimed: [], redeemed: [] };
    const n = await redeemPending(ledger, result);
    if (!n) { log('redeem-only: nothing pending'); return result; }
    result.action = result.redeemed.length ? 'claimed' : 'idle';
    return result;
  }

  if (ledger.done) { log('all rewards already claimed; nothing to do'); return { action: 'done' }; }

  const next = ledger.nextUnlockAt ? Date.parse(ledger.nextUnlockAt) : 0;
  const stale = now - (ledger.lastCheck || 0) > 24 * 3600 * 1000;
  if (!FORCE && next - now > UNLOCK_TOLERANCE_MS && !stale) {
    log(`idle: next reward unlocks at ${ledger.nextUnlockAt}`);
    return { action: 'skip' };
  }

  // single-instance guard
  const lockFile = path.join(CFG.dir, 'run.lock');
  try {
    const st = fs.statSync(lockFile);
    if (Date.now() - st.mtimeMs < 10 * 60 * 1000) {
      log('another run is in progress; exiting');
      return { action: 'skip' };
    }
  } catch {}
  fs.writeFileSync(lockFile, String(process.pid));

  const boot = await ensureBrowser();
  if (boot.killed) {
    log('note: a running Opera GX instance was restarted');
    operaLaunched = true;
  }
  const browser = await chromium.connectOverCDP(CFG.cdp);
  const ctx = browser.contexts()[0];

  const result = { action: 'idle', claimed: [], redeemed: [] };
  try {
    const page = await gxPage(ctx);

    const first = await safeFetchState(page);
    let state = first.state;
    let loginRequired = first.loginRequired;

    // A signed-out GX session is recoverable: try the saved Battle.net session
    // first, and only fall back to asking you when that cannot work.
    if (loginRequired && !NO_RELOGIN) {
      log('GX session expired; trying to sign in with the saved Battle.net session...');
      const relogin = await attemptGxLogin(ctx, page);
      if (relogin === 'ok') {
        const retry = await safeFetchState(page);
        state = retry.state;
        loginRequired = retry.loginRequired;
        if (!loginRequired) log('signed in again automatically');
      } else {
        log(`GX login attempt: ${relogin}`);
      }
    }
    if (loginRequired) {
      result.loginRequired = true;
      log('GX session still signed out: sign in once at https://gx.me inside Opera GX');
    }

    // 2) claim today's reward when the gate is open
    let justClaimed = false;

    if (state) {
      ledger.lastCheck = now;
      ledger.nextUnlockAt = state.nextUnlockAt || null;

      // 1) reconcile: pick up rewards claimed outside this script, or codes that arrived late
      const adopted = syncLedger(state, ledger);
      if (adopted) log(`found ${adopted} previously claimed reward(s) not tracked yet`);
      saveLedger(ledger);

      const unclaimed = state.rewards.filter(r => !r.hasBeenClaimed);

      if (!unclaimed.length) {
        log('all 24 rewards are claimed.');
        ledger.done = true;
      } else {
        const unlockAt = state.nextUnlockAt ? Date.parse(state.nextUnlockAt) : 0;
        if (unlockAt - Date.now() > UNLOCK_TOLERANCE_MS && !FORCE) {
          log(`not unlocked yet: next reward at ${state.nextUnlockAt}`);
        } else {
          log('claiming the next reward...');
          let outcome = await claimRewardOnce(page, ledger);

          // the session died mid-run: sign in again with the saved Battle.net
          // session and retry the claim once
          if (outcome.outcome === 'login' && !NO_RELOGIN) {
            log('GX session expired while claiming; trying to sign in again...');
            const relogin = await attemptGxLogin(ctx, page);
            if (relogin === 'ok') {
              log('signed in again; retrying the claim...');
              outcome = await claimRewardOnce(page, ledger);
            } else {
              log(`GX login attempt: ${relogin}`);
            }
          }

          if (outcome.outcome === 'ok') {
            justClaimed = true;
            if (outcome.loginAfter) {
              loginRequired = true;
              result.loginRequired = true;
              log('GX session expired right after claiming: sign in once at https://gx.me inside Opera GX');
            }
          } else if (outcome.outcome === 'login') {
            loginRequired = true;
            result.loginRequired = true;
            log('GX session still signed out: sign in once at https://gx.me inside Opera GX');
          }
        }
      }
      saveLedger(ledger);
    }

    // 3) redeem anything pending - codes already in the ledger do not need a GX session
    const pendingCount = pendingRedeems(ledger).length;
    if (!pendingCount) {
      if (justClaimed) log('claim ok, but the code has not been issued yet (will retry next run)');
      if (loginRequired) return { ...result, action: 'login-required' };
      return { action: justClaimed ? 'claimed-no-code' : (ledger.done ? 'done' : 'skip') };
    }

    await redeemPending(ledger, result, justClaimed);

    if (loginRequired && !result.claimed.length && !result.redeemed.length) {
      return { ...result, action: 'login-required' };
    }
    result.action = result.claimed.length || result.redeemed.length ? 'claimed' : (ledger.done ? 'done' : 'skip');
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

const releaseLock = () => { try { fs.unlinkSync(path.join(CFG.dir, 'run.lock')); } catch {} };

const TASK_NAME = 'GX Rewards - Overwatch Daily';

function removeScheduledTask() {
  const r = spawnSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { encoding: 'utf8' });
  log(`scheduled task removal: ${(r.stdout || r.stderr || '').trim()}`);
}

/**
 * Moves the single task trigger to the next expected unlock moment.
 * One wake per day instead of waking the PC every 30 minutes.
 */
function scheduleNext(when) {
  if (!when) return;
  const iso = new Date(when).toISOString();
  const ps = [
    "$ErrorActionPreference='Stop';",
    `$t = New-ScheduledTaskTrigger -Once -At ([datetime]::Parse('${iso}').ToLocalTime());`,
    `Set-ScheduledTask -TaskName '${TASK_NAME}' -Trigger $t | Out-Null;`,
    `(Get-ScheduledTask -TaskName '${TASK_NAME}').Triggers[0].StartBoundary`,
  ].join(' ');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  if (r.status === 0) log(`next scheduled run: ${out || iso}`);
  else log(`failed to reschedule: ${(r.stderr || '').trim().slice(0, 300)}`);
}

function computeNextRun(ledger, res) {
  const now = Date.now();
  if (res && res.action === 'done') return null;
  const next = ledger.nextUnlockAt ? Date.parse(ledger.nextUnlockAt) : 0;
  let when = next - now > UNLOCK_TOLERANCE_MS ? next + 2 * 60 * 1000 : now + 30 * 60 * 1000;
  // never sleep more than 24h, never less than 5 minutes
  when = Math.min(when, now + 24 * 3600 * 1000);
  when = Math.max(when, now + 5 * 60 * 1000);
  return when;
}

/**
 * Reminds the user that the GX session expired, at most once every 12 hours,
 * so a signed-out session never turns into an alert every 30 minutes.
 */
async function notifyGxLoginNeeded() {
  const led = loadLedger();
  const last = led.lastGxLoginNotice ? Date.parse(led.lastGxLoginNotice) : 0;
  if (Date.now() - last < 12 * 3600 * 1000) {
    log('GX login reminder already sent in the last 12h; not notifying again');
    return;
  }
  await notify(
    'GX Rewards: GX login needed',
    'The GX session in Opera GX expired. Sign in once at https://gx.me with the same Battle.net account linked to Overwatch - the script then claims the next reward on its own.',
    'high',
  );
  led.lastGxLoginNotice = new Date().toISOString();
  saveLedger(led);
}

async function finish() {
  let res = null;
  try {
    res = await main();

    if (REDEEM_ONLY) {
      if (res && res.redeemed.length) {
        await notify('GX Rewards: code redeemed', `Battle.net: ${res.redeemed.join(', ')}`);
      }
    } else if (res && res.action === 'login-required') {
      await notifyGxLoginNeeded();
    } else if (res && res.action === 'claimed') {
      await notify(
        'GX Rewards: reward claimed',
        `Claimed: ${res.claimed.join(', ') || '-'}\nBattle.net: ${res.redeemed.join(', ') || '-'}`,
      );
    } else if (res && res.action === 'claimed-no-code') {
      await notify('GX Rewards: code pending', 'Reward claimed, but Battle.net code is not issued yet. Will retry.');
    } else if (res && res.action === 'done') {
      await notify('GX Rewards: ALL DONE', 'All 24 Overwatch rewards have been claimed. Automation stopped.');
      removeScheduledTask();
    }

    // the GX session was already reported as expired, but the run still redeemed
    if (res && res.loginRequired && res.action !== 'login-required') await notifyGxLoginNeeded();

    // a code is stuck because Battle.net wants a manual login: remind at most twice a day
    const led = loadLedger();
    const needsLogin = Object.values(led.rewards).some(
      e => e.redeem && e.redeem.status === 'login_required'
    );
    if (needsLogin) {
      const last = led.lastLoginNotice ? Date.parse(led.lastLoginNotice) : 0;
      if (Date.now() - last > 12 * 3600 * 1000) {
        await notify(
          'GX Rewards: Battle.net login needed',
          'A reward code is waiting. Sign in once to the Battle.net app (or to account.battle.net in Opera GX) - the script redeems it on the next run.',
          'high',
        );
        led.lastLoginNotice = new Date().toISOString();
        saveLedger(led);
      }
    }
  } catch (err) {
    log('ERROR: ' + (err && err.stack ? err.stack : err));
    await notify('GX Rewards: ERROR', String(err.message || err).slice(0, 180), 'high');
    res = { action: 'error' };
  }

  const ledger = loadLedger();
  const when = computeNextRun(ledger, res);
  if (when) scheduleNext(when);
  else removeScheduledTask();

  // free resources / restore the machine state
  await cleanup();

  releaseLock();
  process.exit(res && res.action === 'error' ? 1 : 0);
}

finish();


