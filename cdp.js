/**
 * Minimal Chrome DevTools Protocol client (no Playwright).
 * Needed because the Battle.net desktop app is CEF and Playwright refuses
 * to attach to it ("Browser context management is not supported").
 */

const http = require('http');

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

async function targets(port) {
  return httpJson(`http://127.0.0.1:${port}/json/list`);
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: v => { clearTimeout(t); resolve(v); },
        reject: e => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates an expression in the page and returns its JSON value. */
  async eval(expression, timeoutMs = 30000) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, timeoutMs);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result ? r.result.value : undefined;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

/** Attaches to one CDP target (page/webview). */
function attach(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(t);
      const s = new Session(ws);
      s.send('Runtime.enable').then(() => resolve(s)).catch(reject);
    });
    ws.addEventListener('error', e => {
      clearTimeout(t);
      reject(new Error('ws error: ' + (e.message || 'unknown')));
    });
  });
}

/** Finds a target by predicate and attaches to it. */
async function attachTo(port, predicate, { retries = 20, delayMs = 500 } = {}) {
  for (let i = 0; i < retries; i++) {
    const list = await targets(port).catch(() => []);
    const t = list.find(predicate);
    if (t && t.webSocketDebuggerUrl) return { session: await attach(t.webSocketDebuggerUrl), target: t };
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('target not found');
}

/**
 * Closes one target (tab/window) by id.
 * Works for Chrome/Opera; the Battle.net CEF app ignores it, so its redeem
 * window has to be navigated back to a usable page instead.
 */
function closeTarget(port, id) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/json/close/${id}`, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => resolve(d.trim()));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(5000, () => { req.destroy(); resolve(''); });
  });
}

module.exports = { targets, attach, attachTo, closeTarget };
