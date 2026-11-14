#!/usr/bin/env node
// scripts/tg-commands.mjs — set or inspect the bot's menu buttons.
//
//   npm run tg:commands        # publish both menus
//   npm run tg:commands:info   # print what Telegram has now, per menu
//
// Two menus. The DEFAULT one (COMMANDS) is what every private chat sees. The
// OPERATOR one (OPERATOR_COMMANDS) is registered for one chat only, the chat
// in OPERATOR_CHAT_ID, and replaces the default menu there. Telegram keeps a
// menu until it is set again, so a deploy that changes a list changes nothing
// on a phone until this script has run; and when OPERATOR_CHAT_ID is not set
// where the script runs (this shell, .env.local or .env), the operator chat
// KEEPS ITS OLD MENU. The script says so in capitals rather than quietly.
//
// Prints only command names and fixed words. Never prints the bot token, a
// chat id, a URL, or a response body. Env loading is lib/env.js,
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
  { command: 'remove_lead', description: 'Remove a request' },
  { command: 'help', description: 'How this works' },
];

/* Registered only for the operator chat, as a chat-scoped menu: exactly these
   four, in this order. /operator still answers as an alias of /help and is
   not listed. /code and /phones are gone, and the owner's /leads,
   /recipients and /remove_lead were never operator commands: typed in the
   operator chat, each gets the one line that points to /help. */
export const OPERATOR_COMMANDS = [
  { command: 'businesses', description: 'Businesses: phones, leads, suspend' },
  { command: 'invite', description: 'Invite or replace a phone' },
  { command: 'help', description: 'Operator commands' },
  { command: 'id', description: "This chat's ID" },
];

/** "/a, /b, /c": how a menu is printed. */
export const menuLine = (commands) => (commands || []).filter((c) => c && c.command).map((c) => '/' + c.command).join(', ') || '(empty)';

/** The operator chat this script can address, or the fixed reason it cannot.
 *  The id itself is never printed. */
export function operatorScope(env = process.env) {
  const op = String(env.OPERATOR_CHAT_ID || '').trim();
  if (!op) return { reason: 'OPERATOR_CHAT_ID is not set' };
  if (!/^-?\d+$/.test(op)) return { reason: 'OPERATOR_CHAT_ID is not a numeric chat id' };
  return { scope: { type: 'chat', chat_id: Number(op) } };
}

/** What is printed when the operator menu could not be addressed. */
export function operatorSkippedLines(reason) {
  return [
    `OPERATOR MENU NOT UPDATED: ${reason}.`,
    'The operator chat keeps the menu it had before (it may still list old commands).',
    'Put OPERATOR_CHAT_ID in .env.local (the operator chat sends /id to the bot to learn it), then run this again.',
  ];
}

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

    // The operator commands are registered for ONE chat, as a scoped menu.
    // Without OPERATOR_CHAT_ID there is no chat to scope them to, and a
    // global menu would advertise them to every client.
    const target = operatorScope();
    console.log('default menu (every private chat): ' + menuLine(COMMANDS));
    if (!target.scope) {
      for (const l of operatorSkippedLines(target.reason)) console.log(l);
    } else {
      let r2;
      try {
        r2 = await setMyCommands(OPERATOR_COMMANDS, { scope: target.scope });
      } catch { fail('tg_not_configured'); }
      if (!r2 || !r2.ok) fail('setMyCommands(operator scope) failed status=' + (r2 && r2.status !== undefined ? r2.status : 'timeout'));
      console.log('operator menu (operator chat only): ' + menuLine(OPERATOR_COMMANDS));
      console.log('If the operator chat still shows the old list, close and reopen that chat in Telegram.');
    }
  } else {
    let r;
    try { r = await getMyCommands(); } catch { fail('tg_not_configured'); }
    if (!r || !r.ok) fail('getMyCommands failed status=' + (r && r.status !== undefined ? r.status : 'timeout'));
    console.log('default menu (every private chat): ' + menuLine(Array.isArray(r.result) ? r.result : []));
    const target = operatorScope();
    if (!target.scope) {
      console.log(`operator menu: not read (${target.reason})`);
    } else {
      let r2;
      try { r2 = await getMyCommands({ scope: target.scope }); } catch { fail('tg_not_configured'); }
      if (!r2 || !r2.ok) fail('getMyCommands(operator scope) failed status=' + (r2 && r2.status !== undefined ? r2.status : 'timeout'));
      const live = Array.isArray(r2.result) ? r2.result : [];
      // An empty chat-scoped list means none was ever set: that chat shows the default menu.
      console.log('operator menu (operator chat only): ' + (live.length ? menuLine(live) : '(none set: the operator chat shows the default menu)'));
      const want = menuLine(OPERATOR_COMMANDS);
      console.log(menuLine(live) === want ? 'operator menu is up to date' : 'OPERATOR MENU IS OUT OF DATE: run npm run tg:commands (expected ' + want + ')');
    }
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === path.resolve(SELF)) {
  main().catch(() => fail('tg_not_configured'));
}
