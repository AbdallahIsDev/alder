# Email & alert system

How the lead-capture emails and Telegram alerts work, and how to change them.
No secrets, no pricing, no strategy — just the mechanics.

- **Brand tokens** — where they come from, and how to restyle every client.
- **Owner email** — the single design and its two buttons.
- **Customer emails** — auto-reply and review request.
- **Review rating page** — how the star + comment + Google redirect works now.
- **Telegram** — the three-step button flow, menu commands and button colours.
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

Both are 72 px high (2x the 36 px display size) with a transparent background.
Because they are single-colour versions, each works on any background the tokens
allow: `logo-on-dark` on the dark band, `logo-on-light` on white/light cards.

At email-render time, `lib/brand.js`'s `getBrand()` reads **only**
`lib/brand.generated.json` — never `index.html`. Font asset paths are prefixed
with `process.env.SITE_URL` (https, no trailing slash). If a future brand has
no logo, `logo` is `null` in the JSON and emails render the business name as a
text wordmark in the heading font instead.

**Logo delivery in email (CID, no hosted image):** the three emails reference
the logo as `<img src="cid:brand-logo" width="32" height="32" alt="">` — an
empty `alt`, because the business name is printed right next to it, with the
32 px space reserved in both attributes and style. `lib/mail.js` attaches the
PNG bytes as one `attachments` entry (`filename: 'logo.png'`,
`content_type: 'image/png'`, `content_id: 'brand-logo'`, base64 content) on
the single `/emails` send (the batch endpoint does not support attachments).
The bytes are bundled with the serverless function: `scripts/sync-brand.mjs`
writes the base64 of the on-dark PNG into `lib/brand.generated.json` as
`logo.onDarkB64`, and `lib/brand.js` passes it through. The function never
reads `assets/` at run time. The hosted PNG files in `assets/email/` stay
untouched and are used only by the preview gallery (which rewrites
`cid:brand-logo` to a data URI so the logo shows in a browser).

**One padding system:** header, body and footer cells all use `class="px"`
with 24 px horizontal padding (16 px at max-width 480 via the mobile rule).
Vertical: header 18 px top and bottom, body 24 px top and bottom, footer
8 px top and 24 px bottom. No other element inside the card adds horizontal
padding (the review email's heading, line and button share the body cell's
left edge; its button keeps its own 15 px 28 px padding).

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
| `colors.accentText` | text on `accent` (chosen for 4.5:1 contrast) |
| `colors.text` | primary text on white |
| `colors.muted` | secondary text on white (darkened to 4.5:1 on white if needed) |
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

`ownerEmail({ business, lead })` in `lib/content.js`. There is one design only — no variant parameter exists.

Layout (compact): a dark brand band with the logo, title "New estimate request",
subtitle, then a 4 px accent bar; then plain sections (no inner cards): a
"Customer" heading + Name/Phone/Email rows, one edge-to-edge divider row, a
"Job" heading + Service/Timing/Property/Roof age/Insurance claim/ZIP rows +
notes box, a 16 px spacer. Label width is 96, row padding 8 px. Header
padding is 16 px 20 px 14 px with logo height 32. The shell has one
`.outer`/`.card`/`.px` structure with a `@media (max-width:480px)` mobile
block, and exactly one bordered rounded container besides the buttons and
the notes box. **Buttons come after the Job section, before the footer**: two
half-width buttons, 2% spacer between them — "Call \<first name\>" (td = accent,
link text = accentText, `tel:` link) and "Email \<first name\>" (td = bg, link
text = onBg, mail link); with no email on the lead, one full-width Call button
in the accent colour. Colours are brand tokens only. The plain-text part
carries the same sections and labels, with the buttons as two "Call:"/"Email:"
lines after the Job section.

**Phone links** use `toTelHref()` in `lib/content.js`: 10 digits to `+1`, 11
digits starting with 1 to `+`, a leading `+` stays, anything else is the bare
digits. Display text is never altered.

## Customer emails

Both customer mails share the owner email's dark band but logo-only (no
title/subtitle), and their footers read "Sent by \<business name\>" (escaped) —
never "Lead Alerts". The owner email keeps "Sent by Lead Alerts".

- **Auto-reply** (`autoReply`): the customer's own confirmation. Copy and rules
  are unchanged: only the roofer's business name, no studio name, no time
  promise ("we'll be in touch about it", never "within 24 hours"), no AI claims.

- **Review request** (`reviewEmail`): one "Share your feedback" button linking
  to `/r/<token>` (plain URL, no star links and no star glyphs). No "private
  feedback" sentences, and no incentives, discounts, or promises of any kind.
  Legacy entry points (`?s=N`, `?go=1`, `/r/<token>/go`) land on the same
  rating page below.

## Review rating page

`reviewPage()` in `lib/content.js`, served by `api/review.js` on the same
`/r/<token>` route for plain, `?s=N`, `?go=1` and `/go` (all show the same
interactive rating page; `reviewLandingPage()` is the backwards-compatible
name for that same page).

How it works:

1. **A GET never writes anything** — no rows, no events, no alerts. Mail
    scanners open every link in the inbox, so a GET that recorded a click would
    register fake ones. Legacy `/r/<token>/go` links land here too (same
    rewrite) and now open the rating page instead of a 302.
2. The page shows five inline-SVG star buttons in
    `<div role="radiogroup" aria-label="Rating">`, each
    `role="radio" aria-label="N stars"` at least 44x44 px with
    `user-select:none`. Unselected stars are `fill:none stroke:#9AA0A6`;
    selected (this and lower) are `fill:#F4B400 stroke:#F4B400`. Arrow keys,
    pointer hover/focus and click all work.
3. Below the stars: a textarea (`maxlength=1000 rows=4`) labelled
    "Anything you'd like to tell \<business>? (optional)" with the helper
    "This note goes to \<business>. Your public review is written on Google
    next." "Continue to Google" is disabled until a star is chosen. A
    `<noscript>` link to the Google URL covers JS-off browsers.
4. On "Continue", the page POSTs `{stars, comment, go}` (keepalive; `stars`
    is the rating value stored as `rating`). A valid `stars` writes the
    rating (including the 2-or-lower owner-alert dedupe); `go=1` records
    `google_clicked` and a `review_clicked` event. The comment is stored via
    the server (never logged), shown only as plain text in the low-rating
    owner alert truncated to 300 chars. Then the page navigates to the
    Google URL regardless of whether the POST finished.
5. The Google URL comes only from the business row, never the query string,
    and must be `https` on exactly one of: `www.google.com`, `google.com`,
    `search.google.com`, `maps.google.com`, `g.page`, `maps.app.goo.gl`,
    `goo.gl`. Anything else (http, `javascript:`, look-alike domains) shows
    "Review link unavailable" and redirects nowhere; only a log code is
    emitted, never the URL.
6. Values are embedded as JSON with `<` escaped as `\u003c`. No `comgooglemaps://`
    style app schemes — a plain https redirect lets Google hand off to the Maps
    app or the browser on its own.
7. **Presentation:** no card — content sits directly on the page background
    with a 24 px gutter, max width 420 px, centred horizontally and vertically
    (`min-height:100vh` with a `100dvh` override). The title is 20 px with
    `text-wrap: balance`. Fonts mirror the landing page: `@font-face` for
    Geist and Inter from `/assets/fonts/` (`font-display: swap`) with a
    `preload` for the heading font, and the same favicon links as
    `index.html` (all same-origin; the CSP allows them).

## Telegram alerts

`renderAlert()` in `lib/content.js` renders one shared plain-text format —
one "Label: value" per line, blank lines between groups, phone kept tappable,
Yes/No capitalised, and a trailing status block that changes per step. The
status block is one fact per line, every line at most 26 characters, and the
customer's name and email never appear there:

- new: `🟡 Status: New`
- contacted: `🔵 Status: Contacted`
- confirm: `🔵 Status: Contacted` / `Send a review request?` /
  `They get a rating link.` (no email on file:
  `No email on file.` / `Can't send a request.`)
- done, review sent: `✅ Status: Done` / `✉️ Review request sent`
- done, no email: `✅ Status: Done` / `ℹ️ No email, none sent.`
- error: `❌ Status: Error` / `⚠️ Review email failed`

`parse_mode` is never set anywhere in the Telegram path.

**Phone formatting (`displayPhone`):** a value starting with `+` is shown
unchanged (never a second `+`); only a value without `+` and with exactly
10 digits gets `+1` (legacy rows), and 11 digits starting with 1 get `+`.
`toTelHref()` applies the same rule to `tel:` links.

The button flow (enforced by the conditional UPDATEs in `lib/db.js`, not only
the UI):

1. Fresh alert: one button **Mark contacted** (`c:`, style `primary`) — no way to email the
    customer from a lead nobody has called yet.
2. `c:` — alert re-renders `🔵 Status: Contacted` from the database (via the
    roofer-facing view only), one button **Job completed** (`d:`, style `primary`).
3. `d:` — asks: re-render with the confirm lines, two buttons **Send request**
    (`y:`, style `success`, or **Mark done** when the lead has no email) and
    **Cancel** (`n:`, style `danger`). On an open lead it is refused: "Mark
    this lead as contacted first."
4. `y:` — `contacted|quoted|won` to `done` in one conditional UPDATE (token filled
    only if null), one review email attempt, message ends with the outcome.
    On success: no buttons. On send failure: the error view with one **Try again**
    button (`r:`, style `primary`). A second `y:` changes nothing and sends nothing.
5. `n:` — back to the one-button contacted view, no DB change.
6. `r:` (Try again) — allowed only when the lead is `done` AND no review request
    was successfully sent (known from a `review_requested` row in
    `lead_events`; a `review_request_failed` row means it may be retried). It
    resends the review email with the existing token, never changes status,
    then re-renders done (sent) or error again. A second `r:` after a success
    changes nothing and sends nothing. `r:` on an open/contacted lead is
    refused with "Nothing to retry."

    **Retry idempotency key:** every review send uses a Resend idempotency key
    (`<leadId>:review` for the first send), and each `review_request_failed`
    event records `{ status, key }` for the attempt that failed. A retry after
    a timeout reuses the exact key of the timed-out attempt (it may have been
    delivered, so Resend must dedupe); a retry after any other failure uses a
    brand-new `<leadId>:review:r<count>` key (`count` = number of earlier
    failures), so a cached failure is never replayed and no new key can equal
    an earlier one.

Button colours use the Bot API `style` field (only `primary`, `success`,
`danger` exist). `callback_data`, labels and the flow are unchanged. Older
Telegram clients ignore the field.

Tenancy always comes from the chat binding. Forged callbacks from another
business change nothing; malformed `callback_data` is answered and ignored.

## Telegram bot copy and /leads format

**No multi-tenant wording:** every roofer-facing message reads as if this bot
belongs to this one business. The strings never say "another", "other roofer /
business", "roofers", "administrator", "provider", "move it", "shared" or
"multiple" (asserted in tests).

Copy (exact texts live in `lib/content.js`): after linking, the chat gets
"You\'re connected to {name}. ✅ …" with short instructions; `/help` shows
"How this works …" with the two commands; an already-connected chat sending
`/start` (with or without a code; the code is not consumed) gets "You\'re all
set. …"; anything from an unconnected chat (except a valid code) gets "This
chat isn\'t connected yet. …"; a bad/expired code gets "That setup link
isn\'t valid or has expired. …". Plain (non-command) text from a connected
chat gets "I only respond to commands. …", at most 3 per chat per hour
(`hitRateLimit('tghint:' + chatId, 3600, 3)`, fail closed: a limiter error
sends nothing; the text is never logged or stored). Stickers, photos, voice,
edited messages, `my_chat_member` and group/channel updates get no reply.

**/leads format** (`renderLeadList` in `lib/content.js`): plain text, one
title line "Recent requests", a blank line, then one three-line block per
lead with a blank line between leads (none after the last): name truncated to
28 chars, then "`Service label` · `phone`", then "`age` · `status`". No
numbering, no "—" character anywhere; " · " only as separators. Status uses
one shared map (`open 🟡 New`, `contacted 🔵 Contacted`, `quoted 🟣 Quoted`,
`won 🏆 Won`, `lost ⚪ Lost`, `done ✅ Done`; unknown statuses show the raw
word). Phones go through `displayPhone`.

**Bot profile descriptions:** `npm run tg:commands` (run once by the owner
after deploy) sets the two menu commands (`leads`, `help`) plus the bot
description (≤512 chars) and short description (≤120 chars) via
`setMyDescription` / `setMyShortDescription` in `lib/tg.js`;
`npm run tg:commands:info` prints the command names. The profile photo is
set manually in BotFather with `/setuserpic`.

## Telegram menu commands

The bot menu has exactly two entries (names only):

- `leads` — Show recent requests
- `help` — How this bot works

Set them with `npm run tg:commands` (calls `setMyCommands`) and print the
names with `npm run tg:commands:info` (calls `getMyCommands`).
`/help` in the chat replies with the same short text for linked and unlinked
chats and reveals no business data. `/leads` still returns no lead data for
unlinked chats.

## Phone validation and storage

Server (`api/lead.js`): numbers are validated with `libphonenumber-js/max`
(the **max** build checks real per-country patterns; the default/min build
only checks general length ranges and let through e.g. an 8-digit +20 mobile
that needs 10). Valid numbers are stored as E.164; invalid ones are a 400
that names the field (`{ ok: false, errors: { phone: ... } }`), and the
number is never logged. The modal maps each field error to that field's
message (phone: "Enter a valid phone number."), focuses the field and stays
on step 4; the generic "We couldn't send your request" panel is only for
network failures and 5xx.

Client (`index.html` modal): `build-static.js` derives, from the max
metadata, for each calling code the min/max national length across its
countries and inlines it as a compact JSON constant (`PHONE_CC`, ~2.5 KB
for 206 codes). North America (code `1`) is overridden to exactly `[10, 10]`.
After a leading `+`, the code is matched (1, then 2, then
3 digits; codes are prefix-free) and typing stops at calling-code digits
plus the max national length (so +20 allows at most 10 more digits). A
leading `00` is treated as `+`; one trunk `0` immediately after the calling
code may exceed the cap by one digit while typing and is removed again on
submit — the server retries once without that `0` when the number is not
valid as given, and stores only a valid E.164 (numbers where the `0` is
part of the number, like Italy, are valid as given and never stripped).
Without `+`, the business country is the default (US; `businesses` has no
country column). On submit, the national length must be between min and
max for a recognised code, else 8–15 digits. Sanitisation is unchanged:
digits, one leading `+`, spaces `( ) - .` only, `maxlength="20"`,
`type="tel"`, pasted text sanitised and truncated the same way.

## Env var names

The email and Telegram code reads these names (never values - do not copy
`.env` content into docs, tickets or screenshots):

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
`IP_HASH_SALT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`TELEGRAM_WEBHOOK_SECRET`, `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_REDIRECT_TO`,
`MAIL_REDIRECT_PREFIX` (set to `off` to remove the `[TEST for ...]` subject
prefix; recipients are still redirected to `MAIL_REDIRECT_TO`), `SITE_URL`,
`DATABASE_URL` (local migrations only).

## Running the tests

```powershell
node tests/run.mjs                          # all suites, one shared vercel dev
node tests/run.mjs tests/lead-api.test.mjs  # one suite
node tests/run.mjs --seed-check             # read-only: alder-demo == seed?
```

Suites that only call handlers in-process (`db-wall`, `notify`, `webhook`,
`brand`, `outbound`) never talk to `vercel dev`; suites that exercise real
HTTP (`lead-api`, `review`, `fallback`) need it. The runner starts **one**
dev server for the whole run when any selected suite needs HTTP, so with the
default list the in-process suites run alongside it and simply do not call
it; `vercel dev` and the canary are skipped only when every selected suite is
in-process (e.g. `node tests/run.mjs tests/webhook.test.mjs`). Per-suite
seconds and the total always print. Outbound HTTP uses a 3000 ms timeout in
production; the `OUTBOUND_TIMEOUT_MS=1000` override applies only when
`VERCEL_ENV` is unset or `development` (the runner sets it), and only an
integer 200–3000 is honoured. The suites read the production database — back
up and reset `alder-demo` first, and restore afterwards (see
`HANDOFF_alder_session.md`).

## Preview gallery

```powershell
node scripts/preview.mjs           # static files under _debug/previews/
node scripts/preview.mjs --serve   # also serve them at http://127.0.0.1:4173/
```

No env, no network (except the loopback server), no DB. The gallery shows the
owner email for the CLEAN, MINIMAL and STRESS leads at 640 px and 375 px widths
(with the logo visible: `cid:brand-logo` is rewritten to a data URI here only),
the auto-reply, the one-button review email ("Share your feedback"), the
rating pages (s1, s5, go, and the unavailable state), the six Telegram
states (new, contacted, confirm, done-sent, done-no-email, error), the
/leads list sample, and the bot copy messages, each with a caption. A
"Simulate dark mode" checkbox applies `invert(1) hue-rotate(180deg)` to the
iframes - a rough approximation of mail-app dark-mode inversion, not a real
dark mode.
