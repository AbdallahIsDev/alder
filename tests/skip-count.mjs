// tests/skip-count.mjs — one place that decides what a skipped check looks like.
//
// A suite that cannot run a check prints `SKIP  <id>  <reason>` instead of a
// PASS, and the runner counts those lines in its summary. Counting them is the
// only way a "green" run can say how much it did not prove.

/** Number of SKIP lines in a block of suite output. */
export function countSkips(text) {
  return String(text || '').split(/\r?\n/).filter((l) => /^SKIP\b/.test(l)).length;
}

/** The exact line a suite prints for a check it is not running. */
export function skipLine(id, reason) {
  return `SKIP  ${String(id).padEnd(4)}${reason}`;
}
