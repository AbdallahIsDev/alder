// lib/migrations.js — one source of truth for what `npm run db:apply` runs.
//
// Two jobs:
//   1. APPLY_ORDER is the only list the apply script reads, so a migration can never
//      be added to supabase/migrations/ and silently skipped.
//   2. migrationFiles() lets a test compare the directory against that list.
//
// seed.sql sits between 0001 and 0002 on purpose: the tables and the check
// constraints must exist before the rows, and the revokes/grants must come after.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATIONS_DIR = 'supabase/migrations';

/** Full apply order. Paths are repo-relative with forward slashes. */
export const APPLY_ORDER = [
  'supabase/migrations/0001_init.sql',
  'supabase/seed.sql',
  'supabase/migrations/0002_default_privileges.sql',
  'supabase/migrations/0003_service_role_grants.sql',
  'supabase/migrations/0004_lead_event_kinds.sql',
  'supabase/migrations/0005_business_site_host.sql',
];

/** Every .sql under supabase/migrations/, sorted, as repo-relative paths. */
export function migrationFiles(root = ROOT) {
  const dir = path.join(root, MIGRATIONS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => `${MIGRATIONS_DIR}/${f}`);
}

/** Migration files that exist but are not in APPLY_ORDER — must be empty. */
export function unlistedMigrations(root = ROOT) {
  const listed = new Set(APPLY_ORDER);
  return migrationFiles(root).filter((f) => !listed.has(f));
}

/** Entries in APPLY_ORDER with no file on disk — must be empty. */
export function missingApplyFiles(root = ROOT) {
  return APPLY_ORDER.filter((f) => !fs.existsSync(path.join(root, f)));
}
