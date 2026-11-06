// tests/env.mjs — suite-side shim over lib/env.js.
//
// The loader itself lives in lib/env.js so scripts and tests cannot drift apart.
// loadEnv() fills process.env in place and is safe to call twice.
//
// Precedence: process.env > .env.test (only when TEST_ENV=1) > .env.local > .env
// Values are never printed.

import { loadEnv as loadEnvShared } from '../lib/env.js';

export {
  parseDotEnvText,
  applyDotEnvEntries,
  envFileNames,
  readEnvFile,
  checkNotProduction,
  sameSupabaseUrl,
} from '../lib/env.js';

export function loadEnv(opts) {
  return loadEnvShared(opts);
}
