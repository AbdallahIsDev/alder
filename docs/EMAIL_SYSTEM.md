# Email & alert system

How the lead-capture emails and Telegram alerts work, and how to change them.
No secrets, no pricing, no strategy — just the mechanics.

- **Brand tokens** — where they come from, and how to restyle every client.
- **Owner email** — the single design and its two buttons.
- **Customer emails** — auto-reply and review request.
- **Review landing page** — how the Google redirect works now.
- **Telegram** — the three-step button flow.
- **Env var names** — what the code reads (never values).
- **Preview gallery** — how to eyeball everything.

---

## Where the brand tokens come from

The landing page is the single source of truth for colours, fonts and the logo.
`scripts/sync-brand.mjs` reads `index.html` once at build time (the `:root`
variables, the `@font-face` rules and the logo SVG), derives the email tokens,
and writes `lib/brand.generated.json`. `build-static.js` runs that sync on every
build, so it never goes stale: change the page, rebuild, emails follow.

Two logo PNGs are rendered from the page's logo SVG by `sharp`:

- `assets/email/logo-on-dark.png` — every fill replaced with the `onBg` colour
  (for dark bands).
- `assets/email/logo-on-light.png` — every fill replaced with the `text` colour
  (for light surfaces).

Both are 72 px high (2× the 36 px display size) with a transparent background.
Because they are single-colour versions, each works on any background the tokens
allow: `logo-on-dark` on the dark band, `logo-on-light` on white/light cards.

At email-render time, `lib/brand.js`'s `getBrand()` reads **only**
`lib/brand.generated.json` — never `index.html`. Asset paths are prefixed with
`process.env.SITE_URL` (https, no trailing slash). If a future brand has no
logo, `logo` is `null` in the JSON and emails render the business name as a text
wordmark in the heading font instead.

**To restyle a client:** edit the colours, fonts and logo in `index.html`'s
`:root` block (and the logo SVG), then run `npm run build`. That regenerates
`lib/brand.generated.json` and the two logo PNGs. No second edit anywhere else.

### Tokens

| Token | Meaning |
|---|---|
| `colors.canvas` | email page background (lightest neutral) |
| `colors.card` | the white card |
| `colors.bg` | the page's darkest brand surface (hero/nav band) |
| `colors.onBg` | text on `bg` |
| `colors.onBgMuted` | `onBg` blended 70% over `bg` |
| `colors.accent` | the page's primary button/CTA colour |
| `colors.accentText` | text on `accent` (chosen for ≥ 4.5:1 contrast) |
| `colors.text` | primary text on white |
| `colors.muted` | secondary text on white (darkened to ≥ 4.5:1 on white if needed) |
| `colors.border` | hairlines and card borders |
| `colors.tint` | light grey boxes (notes) |

| Fonts | Meaning |
|---|---|
| `fonts.heading` / `fonts.body` | family names used on the page |
| `fonts.headingStack` / `fonts.bodyStack` | `'Heading', Arial, Helvetica, sans-serif` etc. |
| `fonts.faces` | the webfont files that exist as `.woff2` in `assets/fonts/` (max 4) |

**Font caveat:** only the faces in `fonts.faces` are loaded. Gmail and Outlook
ignore web fonts entirely and render the Arial/Helvetica fallback; Apple Mail
loads them. Every styled rule therefore uses the full stack, so the layout looks
right in both worlds.

## Owner email

`ownerEmail({ business, lead })` in `lib/content.js`. There is one design only
(the former O1 "brand dark") — no variant parameter exists any more.

Layout: a dark brand band with the logo, title "New estimate request",
subtitle, then a 4 px accent bar; two cards ("Customer": Name/Phone/Email;
"Job": Service/Timing/Property/Roof age/Insurance claim/ZIP) separated by a
16 px spacer, with the notes box inside the Job card. **Buttons come after the
Job card, before the footer**: two half-width buttons, 2% spacer between them
— "Call \<first name\>" (td = accent, link text = accentText, `tel:` link) and
"Email \<first name\>" (td = bg, link text = onBg, mail link); with no email on
the lead, one full-width Call button in the accent colour. Colours are brand
tokens only. The plain-text part carries the same sections and labels, with the
buttons as two "Call:"/"Email:" lines after the Job section.

**Phone links** use `toTelHref()` in `lib/content.js`: 10 digits → `+1`, 11
digits starting with 1 → `+`, a leading `+` stays, anything else is the bare
digits. Display text is never altered.

## Customer emails

Both customer mails share the owner email's dark band but logo-only (no
title/subtitle), and their footers read "Sent by \<business name\>" (escaped) —
never "Lead Alerts". The owner email keeps "Sent by Lead Alerts".

- **Auto-reply** (`autoReply`): the customer's own confirmation. Copy and rules
  are unchanged: only the roofer's business name, no studio name, no time
  promise ("we'll be in touch about it", never "within 24 hours"), no AI claims.

- **Review request** (`reviewEmail`): five hollow-star TEXT links to
  `/r/<token>?s=1`…`?s=5` under the line "How did we do? Tap a star to rate
  your experience." The star is the text character ☆ with a variation selector
  so iOS shows the outline, not an emoji. No button, no "private feedback"
  sentences, and no incentives, discounts, or promises of any kind. The
  `?go=1` landing-page entry point (used by legacy `/r/<token>/go` links) is
  unchanged and serves the same landing page.

## Review landing page

`reviewLandingPage()` in `lib/content.js`, served by `api/review.js` on the same
`/r/<token>` route for `?s=N` and `?go=1`. The old page at plain `/r/<token>`
(and its behaviour) is unchanged for links already sent.

How it works:

1. **A GET never writes anything** — no rows, no events, no alerts. Mail
   scanners open every link in the inbox, so a GET that recorded a click would
   register fake ones. The legacy `/r/<token>/go` links from old emails land
   here too (same rewrite) and now open this page instead of a 302.
2. The page's JavaScript sends **one POST** (with `keepalive`) when the redirect
   starts. The handler splits the fields: a valid `stars` writes the rating
   (the existing POST path, including the ≤2 owner-alert dedupe); a `go=1`
   records `google_clicked` and a `review_clicked` event. A POST with neither
   writes nothing.
3. `?s=N` (N = 1..5, anything else behaves as `?go=1`) shows five stars that
   fill one by one every 90 ms (instantly with `prefers-reduced-motion`), then
   `location.replace(googleUrl)` at 1000 ms regardless of whether the POST
   finished. `?go=1` has no stars and redirects at ~150 ms.
4. A `<noscript>` meta refresh (1 s) covers JS-off browsers.
5. The Google URL comes only from the business row, never the query string,
   and must be `https` on exactly one of: `www.google.com`, `google.com`,
   `search.google.com`, `maps.google.com`, `g.page`, `maps.app.goo.gl`,
   `goo.gl`. Anything else (http, `javascript:`, look-alike domains) shows
   "Review link unavailable" and redirects nowhere; only a log code is emitted,
   never the URL.
6. Values are embedded as JSON with `<` escaped as `\u003c`. No `comgooglemaps://`
   style app schemes — a plain https redirect lets Google hand off to the Maps
   app or the browser on its own.

## Telegram alerts

`renderAlert()` in `lib/content.js` renders one shared plain-text format —
one "Label: value" per line, blank lines between groups, phone kept tappable
(`+1` form), Yes/No capitalised, and a trailing status block that changes per
step (`Status: New` / `Status: Contacted` / confirm question / Done with the
email outcome). `parse_mode` is never set anywhere in the Telegram path.

The button flow (enforced by the conditional UPDATEs in `lib/db.js`, not only
the UI):

1. Fresh alert: one button **Mark contacted** (`c:`) — no way to email the
   customer from a lead nobody has called yet.
2. `c:` → alert re-renders `Status: Contacted` from the database (via the
   roofer-facing view only), one button **Job completed** (`d:`).
3. `d:` → asks: re-render with the confirm line, two buttons **Yes, send review
   request** (`y:`) and **Cancel** (`n:`). On an open lead it is refused: "Mark
   this lead as contacted first."
4. `y:` → `contacted|quoted|won → done` in one conditional UPDATE (token filled
   only if null), exactly one review email, message ends with the outcome and
   no buttons. A second `y:` changes nothing and sends nothing.
5. `n:` → back to the one-button contacted view, no DB change.

Tenancy always comes from the chat binding. Forged callbacks from another
business change nothing; malformed `callback_data` is answered and ignored.

## Env var names

The email and Telegram code reads these names (never values — do not copy
`.env` content into docs, tickets or screenshots):

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
`IP_HASH_SALT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`TELEGRAM_WEBHOOK_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_REDIRECT_TO`,
`MAIL_REDIRECT_PREFIX` (demo recordings: set to `off` to drop the `[TEST for …]`
subject prefix; the recipient is still redirected), `SITE_URL`,
`DATABASE_URL` (local migrations only).

## Preview gallery

```powershell
node scripts/preview.mjs           # static files under _debug/previews/
node scripts/preview.mjs --serve   # also serve them at http://127.0.0.1:4173/
```

No env, no network (except the loopback server), no DB. The gallery shows the
owner email for the CLEAN, MINIMAL and STRESS leads at 640 px and 375 px widths,
the auto-reply, the five-star review email, the three landing pages (with the
unavailable state), and the four Telegram states, each with a caption. A
"Simulate dark mode" checkbox applies `invert(1) hue-rotate(180deg)` to the
iframes — a rough approximation of mail-app dark-mode inversion, not a real
dark mode.
