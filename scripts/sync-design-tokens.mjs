#!/usr/bin/env node
// scripts/sync-design-tokens.mjs — generate the two consumers of design-tokens.json.
//
// Site: assets/css/tokens.generated.css holds CSS custom properties.
// Email: lib/design-tokens.generated.json holds the same numbers as plain strings,
// because most mail clients do not support CSS variables.
// The JSON file is the only source the email builders read at runtime; nothing
// imports design-tokens.json from a request path.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'design-tokens.json'), 'utf8'));

const css = `/* Generated from design-tokens.json by scripts/sync-design-tokens.mjs. Do not edit. */
:root {
  --box-radius: ${tokens.radius.box};
  --radius-box: ${tokens.radius.box};
  --radius-image: ${tokens.radius.image};
  --radius-section: ${tokens.radius.section};
  --radius-arrow: ${tokens.radius.arrowSquare};
  --radius-nojs: ${tokens.radius.noJs};
  --radius-api-card: ${tokens.radius.apiCard};
  --radius-review-card: ${tokens.radius.reviewCard};
  --radius-review-control: ${tokens.radius.reviewControl};
  --border-hairline: ${tokens.border.hairline};
  --border-control: ${tokens.border.control};
  --border-focus-ring: ${tokens.border.focusRing};
  --color-white: ${tokens.color.white};
  --color-ink: ${tokens.color.ink};
  --color-cream: ${tokens.color.cream};
  --color-accent: ${tokens.color.accent};
  --color-muted: ${tokens.color.muted};
  --font-display: ${tokens.font.display};
  --font-body: ${tokens.font.body};
  --size-button: ${tokens.size.buttonHeight};
  --size-button-header: ${tokens.size.headerButtonHeight};
  --size-modal-close: ${tokens.size.modalClose};
  --size-field: ${tokens.size.fieldHeight};
  --space-pad: ${tokens.space.pad};
  --space-gap: ${tokens.space.gap};
}
`;

fs.writeFileSync(path.join(ROOT, 'assets', 'css', 'tokens.generated.css'), css);
fs.writeFileSync(path.join(ROOT, 'lib', 'design-tokens.generated.json'), JSON.stringify(tokens, null, 2) + '\n');
console.log('design tokens: css + email JSON generated');
