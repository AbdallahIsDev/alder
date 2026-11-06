#!/usr/bin/env node
// tests/delete-scripts.test.mjs — Gate X (destructive tooling).
//
// These scripts delete rows. They are only ever exercised against a dedicated
// test project: a run with TEST_ENV=1 AND a .env.test file present. Without
// that, the suite prints one SKIP line and exits 0 — it must never point the
// deletion scripts at production.
//
// What it proves (when it runs):
//   X1  dry run reports counts and deletes nothing
//   X2  --yes without --confirm is refused
//   X3  delete-lead removes the lead and its child rows, and nothing else
//   X4  offboard-business removes one business and leaves the others alone

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAS_TEST_ENV = String(process.env.TEST_ENV || '') === '1' && fs.existsSync(path.join(ROOT, '.env.test'));

let failed = 0, total = 0;
const line = (ok, id, what, d) => {
  total++; if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(id).padEnd(4)}${String(what).padEnd(50)}${d ? '  ' + String(d).replace(/\s+/g, ' ').slice(0, 96) : ''}`);
};

if (!HAS_TEST_ENV) {
  console.log('SKIP  X1-X4  no .env.test with TEST_ENV=1 — the deletion scripts are never run against production.');
  process.exit(0);
}

loadEnv();
const { createClient } = await import('@supabase/supabase-js');
const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const RUN = Math.random().toString(36).slice(2, 8);
const SLUG = `zz-del-${RUN}`;

const script = (name, args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', name), ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 60000, env: { ...process.env, TEST_ENV: '1' },
});

async function seedBusiness() {
  const { data, error } = await svc.from('businesses').insert({
    slug: SLUG, name: 'Delete Fixture', owner_email: 'owner@delete-fixture.example.com',
    google_review_url: 'https://g.page/r/delete-fixture', timezone: 'America/Chicago', status: 'demo',
  }).select('id').single();
  if (error) throw error;
  return data.id;
}
async function seedLead(businessId) {
  const { data, error } = await svc.from('leads').insert({
    business_id: businessId, name: 'Delete Fixture', phone: '+15155550199', email: 'del@example.com',
    zip: '50265', service: 'repair', home: 'house', timing: 'asap', roof_age: 'Not sure',
    insurance_claim: false, notes: null, status: 'open', idempotency_key: `${SLUG}-${Math.random().toString(36).slice(2, 10)}`,
  }).select('id').single();
  if (error) throw error;
  await svc.from('lead_events').insert({ lead_id: data.id, kind: 'created', meta: {} });
  return data.id;
}

try {
  const bizId = await seedBusiness();
  const leadId = await seedLead(bizId);

  /* X1: dry run deletes nothing */
  {
    const r = script('delete-lead.mjs', [leadId]);
    const still = await svc.from('leads').select('id').eq('id', leadId);
    line(r.status === 0 && /dry run/.test(r.stdout) && (still.data || []).length === 1,
      'X1', 'delete-lead dry run deletes nothing', `exit=${r.status} rows=${(still.data || []).length}`);
  }

  /* X2: --yes without --confirm is refused */
  {
    const r = script('delete-lead.mjs', [leadId, '--yes']);
    const still = await svc.from('leads').select('id').eq('id', leadId);
    line(r.status === 1 && /refusing/.test(r.stdout) && (still.data || []).length === 1,
      'X2', 'delete-lead refuses --yes without --confirm', `exit=${r.status}`);
  }

  /* X3: real run removes the lead, its events, and leaves the business alone */
  {
    const r = script('delete-lead.mjs', [leadId, '--yes', '--confirm', leadId]);
    const lead = await svc.from('leads').select('id').eq('id', leadId);
    const events = await svc.from('lead_events').select('id').eq('lead_id', leadId);
    const biz = await svc.from('businesses').select('id').eq('id', bizId);
    line(r.status === 0 && (lead.data || []).length === 0 && (events.data || []).length === 0
      && (biz.data || []).length === 1,
      'X3', 'delete-lead removes the lead and its events only',
      `exit=${r.status} lead=${(lead.data || []).length} events=${(events.data || []).length} biz=${(biz.data || []).length}`);
  }

  /* X4: offboard removes one business and leaves the others */
  {
    const other = await seedBusiness().catch(() => null);
    const before = (await svc.from('businesses').select('id')).data || [];
    const r = script('offboard-business.mjs', [SLUG, '--yes', '--confirm', SLUG]);
    const after = (await svc.from('businesses').select('id')).data || [];
    const gone = !after.some((b) => b.id === bizId);
    line(r.status === 0 && gone && after.length === before.length - 1,
      'X4', 'offboard-business removes one business only',
      `exit=${r.status} gone=${gone} before=${before.length} after=${after.length}`);
    if (other) await svc.from('businesses').delete().eq('id', other);
  }
} catch (e) {
  line(false, 'X0', 'delete-scripts suite threw', e.message);
} finally {
  await svc.from('businesses').delete().eq('slug', SLUG);
}

console.log('');
console.log(`${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
