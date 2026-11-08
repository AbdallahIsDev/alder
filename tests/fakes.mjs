// tests/fakes.mjs — local stand-ins for the Telegram and Resend REST APIs.
// Loopback only. Records every request, and can be switched between ok / 4xx / 5xx / hang.

import http from 'node:http';

function start(name) {
  const state = { mode: 'ok', status: 200, hangMs: 2500, hangUsed: false, requests: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.url === '/__control' && req.method === 'POST') {
      try {
        const c = JSON.parse(raw || '{}');
        if (c.mode !== undefined) { state.mode = String(c.mode); state.hangUsed = false; state.calls = 0; }
        if (c.nth !== undefined) state.nth = Number(c.nth);
        if (c.status !== undefined) state.status = Number(c.status);
        if (c.hangMs !== undefined) state.hangMs = Number(c.hangMs);
      } catch {}
      return send(200, { ok: true, mode: state.mode });
    }
    if (req.url === '/__requests' && req.method === 'GET') {
      return send(200, { count: state.requests.length, requests: state.requests });
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

    let mode = state.mode;
    if (mode === '400_if_keyboard') mode = parsed && parsed.reply_markup ? '400' : 'ok';
    if (mode === 'hang_once') mode = state.hangUsed ? 'ok' : 'hang';
    // fail_nth: fail exactly the nth request after the last control call.
    if (mode === 'fail_nth') { state.calls = (state.calls || 0) + 1; mode = state.calls === Number(state.nth || 1) ? '500' : 'ok'; }
    if (mode === 'hang' && state.mode === 'hang_once') state.hangUsed = true;

    if (mode === 'hang') {
      setTimeout(() => { try { send(200, { ok: true }); } catch {} }, state.hangMs);
      return;
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
