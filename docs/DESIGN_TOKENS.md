# Design tokens

One file is the source of truth: `design-tokens.json` at the repository root.

Two generated consumers are committed so the site and the emails work without a
build step:

| Consumer | File | Written by |
|---|---|---|
| Site CSS custom properties | `assets/css/tokens.generated.css` | `npm run tokens` |
| Email numeric values | `lib/design-tokens.generated.json` | `npm run tokens` |

`assets/css/styles.css` imports the generated CSS first. The landing page, the
estimate modal, the no-JS form and the API result page read `var(--box-radius)`
and the named radius variables. The review page and every email builder import
the generated JSON; mail clients do not support CSS custom properties, so the
numbers are injected as plain strings at build time.

Current values (do not change them in this round):

| Token | Value | Used for |
|---|---|---|
| `radius.box` | `12px` | buttons, cards, fields, modal, menu close, DEV panel |
| `radius.image` | `24px` | standalone images and review cards (2×) |
| `radius.section` | `48px` | CTA section (4×) |
| `radius.arrowSquare` | `7px` | white square inside a primary button |
| `radius.noJs` | `4px` | no-JS form button |
| `radius.apiCard` | `8px` | no-JS result page card |
| `radius.reviewCard` / `reviewControl` | `10px` / `8px` | review page card and controls |
| `radius.email.*` | `10/8/6/0px` | email card, buttons, notes and mobile card |

To change a value: edit `design-tokens.json`, run `npm run tokens`, run `npm run
build`, then update any test that pins the old number. `tests/design-tokens.test.mjs`
fails if a numeric `border-radius` appears in a painted file outside the token
file, and `MD14`–`MD16` check the sitewide coverage.
