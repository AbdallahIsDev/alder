#!/usr/bin/env node
import { isOwnerEmailReplayRetryable } from '../lib/notify.js';
let total = 0, failed = 0;
const line = (ok, id, text) => { total++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${text}`); };
line(isOwnerEmailReplayRetryable('missing_env') && isOwnerEmailReplayRetryable('no_verified_sender'),
  'R1', 'later replay retries repairable configuration failures');
line(isOwnerEmailReplayRetryable(500) && isOwnerEmailReplayRetryable('timeout'),
  'R2', '5xx and unknown outcomes remain replay-retryable');
line(!isOwnerEmailReplayRetryable('blocked_test_mode'), 'R3', 'test interlock remains non-retryable');
console.log(`\n${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
