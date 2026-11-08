/**
 * Redeems a Battle.net code through the installed Battle.net desktop app.
 *
 * Why: the user is always signed in to the app, so we never depend on the
 * website session (which expires constantly). The app is CEF/Chromium, so we
 * drive its embedded "Redeem a code" window over CDP instead of Playwright.
 *
 * Notes learned the hard way:
 *  - Playwright refuses to attach to CEF, hence ./cdp.js.
 *  - Page.navigate hangs CEF (it once killed the app); use `location.href = ...`.
 *  - /json/close and Page.close are ignored for this webview, so the window is
 *    never closed - it is reset back to the form instead.
 *  - Cancel navigates the window to the shop home instead of closing it.
 *
 * Usage:  node bnet-redeem.js CODE
 */
const { targets, attachTo } = require('./cdp');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 9223;

/** The redeem form. Navigating the window here always restores the input. */
const FORM_URL = 'https://eu.checkout.battle.net/shop/en-us/checkout/key-claim';

/** Any window of the in-app shop can be reused for redeeming. */
const SHOP_TARGET_RE = /(checkout\.battle\.net\/shop\/|shop\.battle\.net\/)/i;

async function appTargets() {
  return targets(PORT).catch(() => null);
}

/** Picks the redeem/shop window, preferring one already on checkout. */
function pickTarget(list) {
  if (!list) return null;
  const shop = list.filter(t => SHOP_TARGET_RE.test(t.url || ''));
  return shop.find(t => /checkout\.battle\.net/i.test(t.url)) || shop[0] || null;
}

/** Opens the redeem window from the app's profile menu. */
async function openRedeemWindow() {
  const { session } = await attachTo(PORT, t => t.url.startsWith('resources://home'));
  try {
    await session.eval(`(() => {
      const btn = document.querySelector('#DropdownMenu_2_button');
      if (btn) btn.click();
    })()`);
    await sleep(1200);
    const r = await session.eval(`(() => {
      const item = document.querySelector('#DropdownMenu_2_11');
      if (!item) return 'no Redeem Code item';
      item.click();
      return 'opened';
    })()`);
    if (r !== 'opened') throw new Error(r);
  } finally {
    session.close();
  }
  await sleep(5000);
}

/** Reads what the redeem window currently shows. */
async function readState(session) {
  return session.eval(`(() => ({
    url: location.href,
    hasInput: !!document.querySelector('#enter-code-input'),
    hasConfirm: !!document.querySelector('.confirm-button'),
    text: (document.body ? document.body.innerText : '').replace(/\\n{2,}/g, '\\n').slice(0, 800),
  }))()`);
}

/**
 * Navigates the window back to the empty redeem form.
 * Works from the success page, the "already claimed" page, a stale
 * confirmation page and the shop home (after Cancel).
 */
async function resetToForm(session) {
  await session.eval(`location.href = ${JSON.stringify(FORM_URL)}`).catch(() => {});
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const s = await readState(session).catch(() => null);
    if (s && s.hasInput) return true;
  }
  return false;
}

async function waitForResult(session) {
  let last = '';
  for (let i = 0; i < 24; i++) {
    await sleep(1500);
    const s = await session.eval(`(() => ({
      url: location.href,
      text: (document.body ? document.body.innerText : '').replace(/\\n{2,}/g, '\\n').slice(0, 1200),
    }))()`);
    if (s.text !== last) {
      last = s.text;
      if (/success|redeemed|added to your account|now own|invalid|already|couldn't|could not|not valid|expired|error/i.test(s.text)) {
        return s;
      }
    }
  }
  return session.eval(`(() => ({
    url: location.href,
    text: (document.body ? document.body.innerText : '').replace(/\\n{2,}/g, '\\n').slice(0, 1200),
  }))()`);
}

function classify(text, url) {
  const t = text.replace(/\s+/g, ' ');
  if (/\/login|login\.battle\.net/i.test(url)) {
    return { status: 'login_required', message: 'Battle.net app is not signed in' };
  }
  if (/already (been )?(claimed|redeemed)|already own|already in your/i.test(t)) {
    return { status: 'already', message: 'already claimed before' };
  }
  if (/invalid|not valid|doesn't exist|could not be found|expired|not available in your region|region/i.test(t)) {
    return { status: 'invalid', message: t.slice(0, 220) };
  }
  if (/success|has been added|added to your account|you now own|redeemed|thank you|check your email/i.test(t)) {
    return { status: 'ok', message: t.slice(0, 220) };
  }
  return { status: 'unknown', message: t.slice(0, 300) };
}

/** The confirm URL embeds the code (base64). Used to confirm the right one. */
function codeInConfirmUrl(url) {
  const m = String(url || '').match(/(?:confirm-key-claim|key-lookup|purchase-details\/key-claim)\/([^/?#]+)/);
  if (!m) return null;
  try {
    const raw = Buffer.from(decodeURIComponent(m[1]), 'base64').toString('utf8');
    const found = raw.match(/[A-Z0-9]{4,}-[A-Z0-9]{4,}-[A-Z0-9]{4,}-[A-Z0-9]{4,}-[A-Z0-9]{4,}/i);
    return found ? found[0].toUpperCase() : null;
  } catch { return null; }
}

async function clickConfirm(session) {
  return session.eval(`(() => {
    const b = document.querySelector('.confirm-button');
    if (!b) return false;
    b.click();
    return true;
  })()`);
}

/**
 * Hides the in-app shop panel again (the app keeps the webview alive but shows
 * the home screen) so the app looks untouched after we are done.
 */
async function hideShopPanel() {
  const { session } = await attachTo(PORT, t => t.url.startsWith('resources://home'));
  try {
    await session.eval(`(() => {
      const b = [...document.querySelectorAll('.main-nav-item')]
        .find(x => /^home$/i.test((x.innerText || '').trim()));
      if (b) b.click();
    })()`);
  } finally {
    session.close();
  }
}

/**
 * @returns {Promise<{status:'ok'|'already'|'invalid'|'login_required'|'error'|'unknown', message:string}>}
 */
async function redeemViaApp(code) {
  const list = await appTargets();
  if (!list) {
    return { status: 'error', message: `Battle.net app is not reachable on port ${PORT}` };
  }

  let target = pickTarget(list);
  if (!target) {
    await openRedeemWindow();
    target = pickTarget(await appTargets());
  }
  if (!target) return { status: 'error', message: 'redeem window did not open' };

  const { session } = await attachTo(PORT, t => t.id === target.id);
  let result;
  try {
    let state = await readState(session);

    // Resume an interrupted run that is already asking to confirm this code.
    if (state.hasConfirm && codeInConfirmUrl(state.url) === code) {
      if (!(await clickConfirm(session))) {
        result = { status: 'error', message: 'confirm button not clickable' };
      } else {
        const res = await waitForResult(session);
        result = classify(res.text, res.url);
      }
    } else {
      // Any other screen (success page, "already claimed", shop home, stale
      // confirm page, ...) is reset back to the empty form first.
      if (!state.hasInput) {
        if (!(await resetToForm(session))) {
          result = { status: 'error', message: 'could not open the redeem form from ' + state.url };
        }
      }

      if (!result) {
        const set = await session.eval(`(() => {
          const el = document.querySelector('#enter-code-input');
          if (!el) return '';
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, ${JSON.stringify(code)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.focus();
          return el.value;
        })()`);

        if (!set) {
          result = { status: 'error', message: 'could not fill the code field' };
        } else {
          await sleep(600);
          const submitted = await session.eval(`(() => {
            const b = document.querySelector('#enter-key-submit');
            if (!b) return 'no-submit';
            if (b.disabled) return 'disabled';
            b.click();
            return 'ok';
          })()`);

          if (submitted !== 'ok') {
            result = { status: 'error', message: 'submit failed: ' + submitted };
          } else {
            // step 1: the app asks to confirm the product (skipped for bad codes)
            await sleep(4000);
            const mid = await readState(session);

            if (mid.hasConfirm) {
              await clickConfirm(session);
              const res = await waitForResult(session);
              result = classify(res.text, res.url);
            } else if (/invalid|already|error|could not|not valid/i.test(mid.text)) {
              result = classify(mid.text, mid.url);
            } else {
              const res = await waitForResult(session);
              result = classify(res.text, res.url);
            }
          }
        }
      }
    }

    // Leave the window on an empty form so the next run starts instantly,
    // then hide the panel so the app looks like the user left it.
    await resetToForm(session).catch(() => {});
  } finally {
    session.close();
  }

  await hideShopPanel().catch(() => {});
  return result;
}

module.exports = { redeemViaApp, PORT, FORM_URL };

if (require.main === module) {
  const code = (process.argv[2] || '').trim().toUpperCase();
  if (!code) { console.error('usage: node bnet-redeem.js CODE'); process.exit(2); }
  redeemViaApp(code).then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.status === 'ok' || r.status === 'already' ? 0 : 1);
  }).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
