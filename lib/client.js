// lib/client.js — the client file this deployment serves.
//
// The build bakes one client into the page. The server needs the same file for
// the few values that are not in the page: today, the optional sender address.
// One deployment serves one client, so the file is chosen by CLIENT (default
// "alder"), exactly as build-static.js chooses it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The parsed client file, or null when it is missing or unreadable. */
export function clientConfig(slug = process.env.CLIENT || 'alder') {
  const safe = String(slug || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(safe)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'clients', safe + '.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The sender to use, in one place so the precedence is testable.
 * A client that names a sender wins; otherwise the deployment's MAIL_FROM; an
 * empty result means "use the built-in default", which is what the caller does.
 */
export function resolveSender({ clientSender, envFrom } = {}) {
  const c = String(clientSender || '').trim();
  if (c) return c;
  const e = String(envFrom || '').trim();
  return e || null;
}

/** The sender this deployment's client file names, or '' when it names none. */
export function clientSender(slug) {
  const file = clientConfig(slug);
  return file && typeof file.sender === 'string' ? file.sender.trim() : '';
}
