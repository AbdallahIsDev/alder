#!/usr/bin/env node
// scripts/tg-commands.mjs — set or inspect the bot's menu buttons.
//
//   npm run tg:commands        # set [[leads, help]]
//   npm run tg:commands:info   # print only the command names
//
// Prints only command names (set: both commands; info: names from getMyCommands).
// Never prints the bot token, a URL, or a response body. Env loading matches
// scripts/make-bind-code.mjs (process env, then .env.local, then .env), and
// `npm run` loads both files through --env-file-if-exists flags.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

/** Parse one .env text. Returns a fresh object; never prints values. */
export function parseDotEnvText(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function applyDotEnvEntries(env, entries) {
  for (const entry of entries || []) {
    const parsed = parseDotEnvText(entry && entry.text);
    for (const [k, v] of Object.entries(parsed)) {
      const cur = env[k];
      if (cur === undefined || cur === null || String(cur).length === 0) env[k] = v;
    }
  }
  return env;
}

export function loadDotEnvFiles({ env = process.env, root = ROOT, files = ['.env.local', '.env'] } = {}) {
  const entries = files.map((f) => {
    const p = path.join(root, f);
    let text = '';
    try { text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; } catch { text = ''; }
    return { file: f, text };
  });
  return applyDotEnvEntries(env, entries);
}

export const COMMANDS = [
  { command: 'leads', description: 'Show recent requests' },
  { command: 'help', description: 'How this bot works' },
];

function fail(msg) {
  console.error('tg:commands: ' + msg);
  process.exit(1);
}

async function main() {
  loadDotEnvFiles({ env: process.env, root: ROOT });
  if (!process.env.TELEGRAM_BOT_TOKEN) fail('missing env: TELEGRAM_BOT_TOKEN');

  const cmd = process.argv[2];
  if (cmd !== 'set' && cmd !== 'info') fail('usage: node scripts/tg-commands.mjs set|info');

  let setMyCommands, getMyCommands;
  try {
    ({ setMyCommands, getMyCommands } = await import('../lib/tg.js'));
  } catch { fail('tg_not_configured'); }

  if (cmd === 'set') {
    let r;
    try { r = await setMyCommands(COMMANDS); } catch { fail('tg_not_configured'); }
    if (!r || !r.ok) fail('setMyCommands failed status=' + (r && r.status !== undefined ? r.status : 'timeout'));
    for (const c of COMMANDS) console.log(c.command);
  } else {
    let r;
    try { r = await getMyCommands(); } catch { fail('tg_not_configured'); }
    if (!r || !r.ok) fail('getMyCommands failed status=' + (r && r.status !== undefined ? r.status : 'timeout'));
    const list = Array.isArray(r.result) ? r.result : [];
    for (const c of list) if (c && c.command) console.log(c.command);
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === path.resolve(SELF)) {
  main().catch(() => fail('tg_not_configured'));
}
