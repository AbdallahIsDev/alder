#!/usr/bin/env node
// scripts/tg-commands.mjs — set or inspect the bot's menu buttons.
//
//   npm run tg:commands        # set [[leads, help]]
//   npm run tg:commands:info   # print only the command names
//
// Prints only command names (set: both commands; info: names from getMyCommands).
// Never prints the bot token, a URL, or a response body. Env loading is lib/env.js,
// the same loader the tests and the other scripts use.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

/* Env loading is lib/env.js — one loader for scripts and tests. */
import { loadEnv, parseDotEnvText, applyDotEnvEntries } from '../lib/env.js';

export { parseDotEnvText, applyDotEnvEntries };

export function loadDotEnvFiles({ env = process.env, root = ROOT, files = ['.env.local', '.env'] } = {}) {
  return loadEnv({ env, root, files, testEnv: false }).env;
}

import { BOT_DESCRIPTION, BOT_SHORT_DESCRIPTION } from '../lib/content.js';

/* The default menu every private chat sees: owner commands only. /id exists but
   is deliberately not listed — it is a recovery tool, not a feature. */
export const COMMANDS = [
  { command: 'leads', description: 'Your latest requests' },
  { command: 'invite', description: 'Connect another phone' },
  { command: 'recipients', description: 'Who receives alerts' },
  { command: 'help', description: 'How this works' },
];

/* Registered only for the operator chat, as a chat-scoped menu. */
export const OPERATOR_COMMANDS = [
  { command: 'code', description: 'Invite code for a business' },
  { command: 'phones', description: 'Connected phones for a business' },
  { command: 'businesses', description: 'Every business and its phones' },
  { command: 'id', description: "This chat's id" },
  { command: 'operator', description: 'Operator help' },
];

export const DESCRIPTION = BOT_DESCRIPTION;
export const SHORT_DESCRIPTION = BOT_SHORT_DESCRIPTION;

function fail(msg) {
  console.error('tg:commands: ' + msg);
  process.exit(1);
}

async function main() {
  loadDotEnvFiles({ env: process.env, root: ROOT });
  if (!process.env.TELEGRAM_BOT_TOKEN) fail('missing env: TELEGRAM_BOT_TOKEN');

  const cmd = process.argv[2];
  if (cmd !== 'set' && cmd !== 'info') fail('usage: node scripts/tg-commands.mjs set|info');

  let setMyCommands, getMyCommands, setMyDescription, setMyShortDescription;
  try {
    ({ setMyCommands, getMyCommands, setMyDescription, setMyShortDescription } = await import('../lib/tg.js'));
  } catch { fail('tg_not_configured'); }

  if (cmd === 'set') {
    let r;
    try { r = await setMyCommands(COMMANDS); } catch { fail('tg_not_configured'); }
    if (!r || !r.ok) fail('setMyCommands failed status=' + (r && r.status !== undefined ? r.status : 'timeout'));
    try { r = await setMyDescription(DESCRIPTION); } catch { fail('tg_not_configured'); }
    if (!r || !r.ok) fail('setMyDescription failed status=' + (r && r.status !== undefined ? r.status : 'timeout'));
    try { r = await setMyShortDescription(SHORT_DESCRIPTION); } catch { fail('tg_not_configured'); }
    if (!r || !r.ok) fail('setMyShortDescription failed status=' + (r && r.status !== undefined ? r.status : 'timeout'));

    // The extra commands are registered for ONE chat, as a scoped menu. Without
    // OPERATOR_CHAT_ID there is no chat to scope them to, and a global menu
    // would advertise them to every client.
    const op = String(process.env.OPERATOR_CHAT_ID || '').trim();
    if (!op) {
      console.log('operator menu skipped: OPERATOR_CHAT_ID is not set');
    } else if (!/^-?\d+$/.test(op)) {
      console.log('operator menu skipped: OPERATOR_CHAT_ID is not a numeric chat id');
    } else {
      let r2;
      try {
        r2 = await setMyCommands(OPERATOR_COMMANDS, { scope: { type: 'chat', chat_id: Number(op) } });
      } catch { fail('tg_not_configured'); }
      if (!r2 || !r2.ok) fail('setMyCommands(operator scope) failed status=' + (r2 && r2.status !== undefined ? r2.status : 'timeout'));
    }

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
