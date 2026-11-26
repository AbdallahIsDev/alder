// lib/design-tokens.js — one version-safe way to read the generated token JSON.
//
// Import attributes (`with { type: 'json' }`) are not available on every Node
// version Vercel may select. `createRequire` reads JSON on every supported
// Node release, including the ones that only know the old assert syntax.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tokens = require('./design-tokens.generated.json');

export default tokens;
