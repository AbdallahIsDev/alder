# Telegram bot audit

Scope: business-owner and operator Telegram UX in the code at `56bcd5c`
(refreshed 2026-11-17; the first version of this audit was written at `1d2c748`
and described a lead list that no longer exists). Telegram API facts come only
from the saved Bot API snapshots under the ignored `_debug/telegram-docs/`, current
through **Bot API 10.4**.

---

## 1. What the bot does today

| Area | What the code does | Assessment |
|---|---|---|
| Formatting | `sendMessage` / `editMessageText` with plain text plus explicit `entities` (`lib/tg.js:33`, `api/tg.js:183`, `:259`, `:279`). No `parse_mode` anywhere. | Deliberate. C40 (`tests/webhook.test.mjs:1075-1086`) fails on a `parse_mode` in any send or edit payload, not just `sendMessage`. |
| Inline buttons | `callback_data` only, with `style: primary / success / danger` (e.g. `lib/content.js:476`, `:1221`, `:1243`). | Supported by the API. Callbacks are anchored-regex validated; no lead text and no tenant ever rides in callback data. |
| Business boundary | `getChatBinding(chatId)` selects `business_id` from `business_chats` (`lib/db.js:903`); `tg_chat_id` is unique (`supabase/migrations/0001_init.sql:25-29`); every lead read, transition and delete is scoped by id **and** `business_id` (`lib/db.js:524`). | Preserve. C7/C8/C8b, OP28/OP43 cover isolation, forged and malformed callbacks. |
| Persistent keyboard | `persistentKeyboard()` sets `is_persistent: true` with one row (`lib/content.js:1321`). Owner `Invite` `Leads` (`:1290`), staff `Leads` (`:1292`), operator `Invite` `Businesses` (`:1294`), a switched-off business `Status` (`lib/service-status.js:32`). | Built. A message carries one `reply_markup`, so a screen with inline buttons cannot also carry it; the keyboard is attached by `replyRole` on every plain reply instead. |
| Owner command menu | Six commands — `leads`, `invite`, `recipients`, `remove_lead`, `status`, `help` — in the default scope (`scripts/tg-commands.mjs:39-46`). | Correct. Not a keyboard: this is Telegram's own `/` menu. |
| Operator command menu | `businesses`, `invite`, `help`, `id`, scoped to `OPERATOR_CHAT_ID` with `BotCommandScopeChat` (`scripts/tg-commands.mjs:53-58`, `:120`). | Good role separation. OP33 covers the replies; no test asserts the scopes themselves. |
| `/leads` | ONE message, five leads a page (`api/tg.js:415`). Text rows `1. Name` / `service · phone` / `status · age` (`lib/content.js:461`). Under it one row of number buttons and at most one navigation row — only the ends that lead somewhere (`lib/content.js:1168`, `:1178`). A number edits the same message into the detail (`api/tg.js:1652`). | The in-place flow is done. Buttons are still numbers. |
| `/remove_lead` | A separate browser, five a page, numbers, a confirmation, then delete (`api/tg.js:472`, `Q:` / `E:` / `rm:`). Cancel returns to the page it came from. | Works, but duplicates the list surface: browsing and removing are two different commands. |
| Update types | Webhook subscribes to `message`, `callback_query`, `my_chat_member` (`lib/tg.js:100`). | Enough for today. A new update type needs `scripts/tg-webhook.mjs set` again. |
| Not used | Rich Messages, Mini Apps, Telegram Business connections, managed bots, Stars, `date_time`, `expandable_blockquote`, `copy_text`, `disabled`, `icon_custom_emoji_id`. | None is needed for the current workflow. See §3–§5. |

---

## 2. What is left to change

Only three things, in order of value:

| Change | Impact / effort / risk | Fallback | Tests |
|---|---|---|---|
| **Label the lead buttons** `name · service · age` instead of `1..5`, keeping the number in the text row so the mapping stays obvious. | Medium / low / medium — long names need truncation, and the label must not become the identifier. | A client that renders a long label badly still shows the number in the text above. | Callback data stays within 64 bytes; first/last page; long names; stale taps; cross-business attempts. |
| **Merge `/remove_lead` into the detail** — open the same browser in removal mode, or add a Remove button to the detail, so there is one surface for browsing, acting and deleting. | Medium / medium / medium — a destructive action inside a browsing flow. | Keep the current separate command as a shortcut for one release. | Remove → confirm → cancel returns to the same page; deleting the last row on a page; repeated taps; owner-only. |
| **`copy_text` on the phone** — only if an owner asks for it. | Low / low / low. | The number is already tappable in the text (`lib/content.js:1235`). | The button exists only on an authorized detail. |

Two recommendations from the first audit are **closed on purpose**, not pending:

- **Disabled paging ends.** The code omits an end that leads nowhere instead of
  rendering it disabled (`lib/content.js:1178`). Same outcome, no dead button, and
  no dependency on client support for `disabled`.
- **A button-icon abstraction.** It exists — `BUTTON_ICONS` is an empty frozen
  table and `iconLabel()` returns the bare label (`lib/content.js:1261-1282`) —
  and is deliberately unused, because custom emoji needs a Premium bot owner.

---

## 3. Rich Messages and the no-`parse_mode` rule

Compatible, if the bot uses the structured form. The saved reference defines
`sendRichMessage` with a required `rich_message: InputRichMessage`, and
`InputRichMessage` requires exactly one of `html`, `markdown`, or `blocks`.

Choose `blocks: Array<InputRichBlock>` with typed `RichText` values. Do **not** use
the `html` or `markdown` alternatives, and do not add `parse_mode`. The received
`RichMessage` carries `blocks` and an optional `is_rtl`; `sendRichMessage` can also
take `reply_markup`. `RichMessageButton` supports `text`, `style`, `url`,
`callback_data`, `web_app`, `login_url`, `switch_inline_query`,
`switch_inline_query_current_chat`, `switch_inline_query_chosen_chat`, `copy_text`
and `disabled`, with styles `danger`, `success`, `primary`, `link` (`link` only for
callback buttons).

**Not worth adopting yet.** A lead card is six short fields; blocks would add a
request wrapper, a typed builder and a client-compatibility question to save
nothing. Revisit if a message ever needs a table or a collapsible section.

---

## 4. Premium and paid features (documented for later)

| Feature | Who needs Premium | How to keep the door open |
|---|---|---|
| Custom emoji in button icons (`icon_custom_emoji_id`) and custom-emoji entities | The **bot owner** — the account that owns the bot, not the business owner. End users do not need it to receive the button. | `BUTTON_ICONS` plus `iconLabel()` already return an optional icon with a plain-text fallback. Fill the table when a subscription exists; ids never go in callback data. |
| `KeyboardButtonRequestUsers.user_is_premium` | Nobody; it filters end users. | Not needed for onboarding. If used, it is a selection filter, never authorization. |
| Managed bot secondary usernames (`agent`, `ai`, `app`, `game`) | The user **creating** the managed bot. | Only relevant if client-owned bots become a product. That needs token storage per business; do not replace the shared token path. |
| Stars for digital goods | No Premium requirement stated. | Digital sales inside Telegram must use Stars (`XTR`). The subscription is billed outside Telegram, so this does not apply. |
| Paid broadcasts | Paid from the bot balance (0.1 Star/message, 10,000 Stars minimum). | Not needed: alerts go to a small bound set. |

---

## 5. Not useful now

| Feature | Why not |
|---|---|
| Mini Apps / Web Apps | The owner's actions fit in one message. A Web App adds `initData` validation and tenant-state work with no demonstrated need. If added: verify raw `initData` server-side (HMAC over the data-check string with the `WebAppData` key, then `auth_date`), never `initDataUnsafe`. |
| Telegram Business connections | `BusinessConnection` and the `business_message` family are for a bot acting on a business's own account. This product is an inbox for bound phone chats; `business_chats` stays the only tenant selector. |
| Managed bots | `getManagedBotToken` and friends would give each client their own bot at the cost of one secret and one webhook per business. No current need. |
| `date_time`, `expandable_blockquote` | Lead alerts are short operational fields, not schedules or long quotations. |
| Stars, payments, paid broadcast | The service sells a subscription outside Telegram. |
| Inline mode, Games, Passport, stickers | Nothing in the triage or onboarding flow needs them. |

---

## 6. Guardrails

- Tenant identity comes only from `business_chats.tg_chat_id`. The operator chat is
  a separate private-chat role, never a binding.
- Callback regexes stay anchored, and every lead lookup, update and delete stays
  scoped by `id` **and** `business_id`.
- C40's no-`parse_mode` rule covers every send and edit method, not only
  `sendMessage`. Adding an API must not weaken it.
- A new update type needs `scripts/tg-webhook.mjs set` again; `info` must show it in
  `allowed_updates` or the handler never fires.
- The saved docs do not state minimum client versions for `is_persistent`,
  `copy_text`, button styles or Rich Messages. Check a real iPhone, Android and
  Desktop before shipping any of them broadly.

## 7. Open questions

- Do owners prefer named lead buttons over numbers, given long customer names?
- Is deleting a lead common enough to deserve a button in the detail, or is a
  separate command better because it is harder to hit by accident?
- What is the real lead volume per business? Offset paging with an `id` tie-breaker
  (`lib/db.js:425-426`) is fine at five rows a page; keyset paging stays deferred
  until drift is observed.

## 8. Sources

`_debug/telegram-docs/`: `bot-api.md`, `recent-changes.md`,
`api-changelog.md`, `api-changelog-6.3-to-10.4.md`, `bots-features.md`,
`bots-webapps.md`, `bots-payments.md`, `bots-payments-stars.md`, and the
per-section split under `api-sections/` (including `10-rich-messages.md`). All
local and gitignored; this report is the committed summary.
