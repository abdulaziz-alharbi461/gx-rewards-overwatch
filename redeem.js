/**
 * Manual helper: redeem one code right now, inside the Battle.net app.
 *
 *   node redeem.js CODE
 *
 * Kept as a short alias - the real work happens in bnet-redeem.js (the app is
 * always signed in, so this never depends on the website session).
 */
const { redeemViaApp } = require('./bnet-redeem');

const code = (process.argv[2] || '').trim().toUpperCase();
if (!code) {
  console.error('usage: node redeem.js CODE');
  process.exit(2);
}

redeemViaApp(code).then(r => {
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.status === 'ok' || r.status === 'already' ? 0 : 1);
}).catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
