/**
 * Notification channels: ntfy.sh (default), Telegram, Discord + desktop toast.
 * Configured from config.json next to this file.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

async function post(url, opts, timeoutMs = 15000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: c.signal });
    return { ok: r.ok, status: r.status, text: (await r.text()).slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, text: e.message };
  } finally {
    clearTimeout(t);
  }
}

async function sendNtfy(cfg, title, message, priority = 'default') {
  if (!cfg || cfg.enabled === false || !cfg.topic) return null;
  const server = (cfg.server || 'https://ntfy.sh').replace(/\/+$/, '');
  const tags = priority === 'high' ? ['warning'] : ['white_check_mark'];
  const isAscii = (s) => /^[\x20-\x7E]*$/.test(String(s));

  // HTTP headers must be ASCII, so any non-English title/message is published
  // as JSON instead (ntfy's JSON API accepts full UTF-8).
  if (!isAscii(title) || !isAscii(message)) {
    const levels = { min: 1, low: 2, default: 3, high: 4, urgent: 5, max: 5 };
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;
    return post(`${server}/`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        topic: cfg.topic,
        title,
        message,
        priority: levels[priority] || 3,
        tags,
      }),
    });
  }

  const headers = {
    'Title': title,
    'Priority': priority,
    'Tags': tags.join(','),
  };
  if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;
  return post(`${server}/${cfg.topic}`, { method: 'POST', headers, body: message });
}

async function sendTelegram(cfg, title, message) {
  if (!cfg || !cfg.enabled || !cfg.botToken || !cfg.chatId) return null;
  const text = `<b>${title}</b>\n${message}`;
  return post(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
}

async function sendDiscord(cfg, title, message) {
  if (!cfg || !cfg.enabled || !cfg.webhookUrl) return null;
  return post(cfg.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `**${title}**\n${message}` }),
  });
}

function desktopToast(title, message) {
  const esc = s => String(s).replace(/'/g, "''");
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    '$n = New-Object System.Windows.Forms.NotifyIcon;',
    '$n.Icon = [System.Drawing.SystemIcons]::Information;',
    '$n.Visible = $true;',
    `$n.ShowBalloonTip(12000, '${esc(title)}', '${esc(message)}', [System.Windows.Forms.ToolTipIcon]::Info);`,
    'Start-Sleep -Seconds 6; $n.Dispose();',
  ].join(' ');
  try {
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

/**
 * Sends on every enabled channel. Never throws.
 * @returns {Promise<Array<{channel:string, ok:boolean, info:string}>>}
 */
async function notify(title, message, priority = 'default') {
  const cfg = loadConfig();
  const results = [];

  desktopToast(title, message);

  const jobs = [
    ['ntfy', () => sendNtfy(cfg.ntfy, title, message, priority)],
    ['telegram', () => sendTelegram(cfg.telegram, title, message)],
    ['discord', () => sendDiscord(cfg.discord, title, message)],
  ];

  for (const [name, fn] of jobs) {
    try {
      const r = await fn();
      if (r) results.push({ channel: name, ok: r.ok, info: `${r.status} ${r.text}` });
    } catch (e) {
      results.push({ channel: name, ok: false, info: e.message });
    }
  }
  return results;
}

module.exports = { notify, loadConfig };

// CLI: node notify.js "Title" "Message"
if (require.main === module) {
  const [, , t = 'GX Rewards', m = 'test notification'] = process.argv;
  notify(t, m).then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  });
}
