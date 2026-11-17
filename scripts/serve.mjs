#!/usr/bin/env node
// scripts/serve.mjs — a static server for this repo, with no dependencies.
//
//   npm run serve            # http://127.0.0.1:8791/index.html
//   npm run serve -- 3000    # another port
//
// Same job as `python -m http.server 8791`, but it is in the toolchain: no
// Python on the machine, one command, and the same origin the page expects
// (a page opened as file:// has no working sessionStorage, no fetch and no
// viewport hints).
//
// Read-only and local-only on purpose: GET and HEAD, loopback host, no
// directory listing, no writes, and a resolved path must stay inside the repo
// root (so `..` and an absolute path cannot leave it). Never use it to serve
// anything but this folder.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8791);
const HOST = '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
};

const resolveInside = (urlPath) => {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const full = path.resolve(ROOT, '.' + (clean === '/' ? '/index.html' : clean));
  return full === ROOT || full.startsWith(ROOT + path.sep) ? full : null;
};

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed\n', { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
  }
  const file = resolveInside(req.url || '/');
  if (!file) return send(res, 403, 'Forbidden\n', { 'content-type': 'text/plain; charset=utf-8' });
  let stat;
  try {
    stat = await fsp.stat(file);
    if (stat.isDirectory()) stat = await fsp.stat(path.join(file, 'index.html'));
  } catch {
    return send(res, 404, 'Not found\n', { 'content-type': 'text/plain; charset=utf-8' });
  }
  const target = stat.isDirectory() ? path.join(file, 'index.html') : file;
  const type = TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-store' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`Alder: serving ${ROOT}`);
  console.log(`→ http://${HOST}:${PORT}/index.html`);
});

server.on('error', (e) => {
  console.error(e && e.code === 'EADDRINUSE' ? `port ${PORT} is already in use — pass another: npm run serve -- 3000` : String(e && e.message));
  process.exit(1);
});
