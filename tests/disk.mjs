// tests/disk.mjs — the free-space floor for a suite run.
//
// A full run writes a 124 MB build root and a 124 MB scratch build. When the
// volume is full those fail with ENOSPC inside a suite, which looks like a test
// failure and is not one. Measured 2026-11-09: that is exactly how B2 failed once.
//
// The floor can be raised for a test (DISK_MIN_BYTES) and never lowered: the
// effective minimum is max(2 GB, the env value). A guard that a variable can
// switch off is not a guard.

import fs from 'node:fs';

export const DISK_FLOOR_BYTES = 2 * 1024 ** 3;

/** Free bytes on the volume holding `dir`. Throws if the platform cannot say. */
export function freeBytes(dir) {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** { ok, freeGb, floorGb, detail } — detail never contains a path. */
export function diskGate(free, floor = DISK_FLOOR_BYTES) {
  const freeGb = (free / 1024 ** 3).toFixed(1);
  const floorGb = (floor / 1024 ** 3).toFixed(1);
  return {
    ok: free >= floor,
    freeGb,
    floorGb,
    detail: `free space is ${freeGb} GB, under the ${floorGb} GB minimum`,
  };
}

/** The floor, optionally raised by DISK_MIN_BYTES, never lowered. */
export function floorFromEnv(env = process.env) {
  const raised = Number(env.DISK_MIN_BYTES);
  return Number.isFinite(raised) && raised > DISK_FLOOR_BYTES ? raised : DISK_FLOOR_BYTES;
}
