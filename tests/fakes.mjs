// tests/fakes.mjs — local stand-ins for the Telegram and Resend REST APIs.
// Loopback only. Records every request, and can be switched between ok / 4xx / 5xx / hang.

import http from 'node:http';

function start(name) {
  const state = { mode: 'ok', status: 200, hangMs: 2500, hangStatus: 200, hangUsed: false, requests: [], all: [], idempotency: new Map() };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let idem = null;
    let replay = false;
    const send = (code, obj) => {
      if (idem && !replay) { idem.response = { code, obj }; idem.pending = false; }
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.url === '/__control' && req.method === 'POST') {
      try {
        const c = JSON.parse(raw || '{}');
        if (c.mode !== undefined) {
          state.mode = String(c.mode); state.hangUsed = false; state.calls = 0; state.edits = {};
          state.hangStatus = Number(c.hangStatus || 200);
        }
        if (c.nth !== undefined) state.nth = Number(c.nth);
        if (c.status !== undefined) state.status = Number(c.status);
        // Digest scenarios reuse the same business/day idempotency key. Clear
        // stored responses only when that test explicitly asks for isolation.
        if (c.clearIdempotency === true) state.idempotency.clear();
        if (c.hangMs !== undefined) state.hangMs = Number(c.hangMs);
        // Per-chat control, for the fan-out and per-phone failure tests. A null
        // clears the seat; anything else is compared as a string to chat_id.
        if ('hangChat' in c) state.hangChat = c.hangChat == null ? null : String(c.hangChat);
        if ('failChat' in c) state.failChat = c.failChat == null ? null : String(c.failChat);
        if ('failChats' in c) state.failChats = Array.isArray(c.failChats) ? c.failChats.map(String) : [];
      } catch {}
      return send(200, { ok: true, mode: state.mode });
    }
    if (req.url === '/__requests' && req.method === 'GET') {
      return send(200, { count: state.requests.length, requests: state.requests });
    }
    // /__all survives /__reset: a suite-wide record, used to prove no payload
    // ever carried a forbidden field.
    if (req.url === '/__all' && req.method === 'GET') {
      return send(200, { count: state.all.length, requests: state.all });
    }
    if (req.url === '/__reset' && req.method === 'POST') {
      // Clear the request log only. Mode is owned by /__control so tests can set a
      // failure mode and then reset the log without losing it.
      state.requests = [];
      state.hangUsed = false;
      return send(200, { ok: true });
    }

    let parsed = null;
    try { parsed = JSON.parse(raw || '{}'); } catch {}
    const entry = { method: req.method, path: req.url, headers: req.headers, body: parsed, raw, at: Date.now() };
    state.requests.push(entry);
    state.all.push(entry);

    /* Resend's three documented idempotency behaviours. A true replay returns
       the original status/body without another send; an in-flight original gives
       concurrent 409; different bytes under the same key give invalid 409.
       ASSUMPTION: this fake also stores and replays 5xx responses; Resend's docs
       do not say whether failed requests are stored. */
    if (name === 'resend' && req.url === '/emails') {
      const key = req.headers['idempotency-key'];
      if (key) {
        const previous = state.idempotency.get(key);
        if (previous && previous.raw !== raw) {
          return send(409, { statusCode: 409, name: 'invalid_idempotent_request', message: 'fake payload mismatch' });
        }
        if (previous && previous.pending) {
          return send(409, { statusCode: 409, name: 'concurrent_idempotent_requests', message: 'fake concurrent request' });
        }
        if (previous && previous.response) {
          replay = true;
          return send(previous.response.code, previous.response.obj);
        }
        idem = { raw, pending: true, response: null };
        state.idempotency.set(key, idem);
      }
    }

    /* Telegram refuses an edit that changes nothing. The bot has to treat that
       400 as success, so the fake has to be able to produce it: remember the
       last text + keyboard per message and refuse an identical one while the
       'not_modified' mode is on. */
    state.edits = state.edits || {};
    if (name === 'tg' && parsed && /editMessageText$/.test(req.url) && parsed.message_id != null) {
      const key = String(parsed.message_id);
      const sig = JSON.stringify([parsed.text, parsed.reply_markup || null]);
      if (state.mode === 'not_modified' && state.edits[key] === sig) {
        return send(400, { ok: false, error_code: 400, description: 'Bad Request: message is not modified' });
      }
      state.edits[key] = sig;
    }

    let mode = state.mode;
    if (mode === '400_if_keyboard') mode = parsed && parsed.reply_markup ? '400' : 'ok';
    if (mode === 'not_modified') mode = 'ok';
    if (mode === 'hang_once') mode = state.hangUsed ? 'ok' : 'hang';
    // fail_nth: fail exactly the nth request after the last control call.
    if (mode === 'fail_nth') { state.calls = (state.calls || 0) + 1; mode = state.calls === Number(state.nth || 1) ? '500' : 'ok'; }
    if (mode === 'hang' && state.mode === 'hang_once') state.hangUsed = true;
    /* One chat can be singled out without touching the others: the fan-out test
       needs four phones answering and one that never does. */
    if (parsed && state.hangChat != null && String(parsed.chat_id) === state.hangChat) mode = 'hang';
    if (parsed && state.failChat != null && String(parsed.chat_id) === state.failChat) mode = '503';
    if (parsed && Array.isArray(state.failChats) && state.failChats.includes(String(parsed.chat_id))) mode = '503';

    if (mode === 'hang') {
      const code = state.hangStatus;
      const body = name === 'tg'
        ? (code < 400 ? { ok: true, result: { message_id: 1 } } : { ok: false, error_code: code, description: 'fake rejection' })
        : (code < 400 ? { id: 'fake-id' } : { statusCode: code, message: 'fake rejection', name: 'fake_error' });
      setTimeout(() => { try { send(code, body); } catch {} }, state.hangMs);
      return;
    }
    if (name === 'resend' && (mode === 'concurrent' || mode === 'invalid')) {
      return send(409, {
        statusCode: 409,
        name: mode === 'concurrent' ? 'concurrent_idempotent_requests' : 'invalid_idempotent_request',
        message: 'fake idempotency error',
      });
    }
    if (mode === 'ok') return send(state.status, name === 'tg' ? { ok: true, result: { message_id: 1 } } : { id: 'fake-id' });
    const code = Number(mode) || 500;
    return send(code, name === 'tg'
      ? { ok: false, error_code: code, description: 'fake rejection' }
      : { statusCode: code, message: 'fake rejection', name: 'fake_error' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}`;
      resolve({
        name, server, url, state,
        async control(cfg) {
          const r = await fetch(url + '/__control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
          return r.json();
        },
        async requests() {
          const r = await fetch(url + '/__requests');
          return (await r.json()).requests;
        },
        async reset() {
          await fetch(url + '/__reset', { method: 'POST' });
        },
      });
    });
  });
}

export async function startFakes() {
  const tg = await start('tg');
  const resend = await start('resend');
  return {
    tg, resend,
    async stop() {
      await Promise.all([tg, resend].map((f) => new Promise((r) => f.server.close(r))));
    },
  };
}
