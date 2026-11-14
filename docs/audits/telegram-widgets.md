# Telegram HTML Widgets feasibility spike

**Scope:** read-only Bot API 10.4 spec review; no product code changed. Sources were fetched 2026-11-14 and saved under [`_debug/telegram-docs/widgets`](../../_debug/telegram-docs/widgets/README.md): [changelog extract](../../_debug/telegram-docs/widgets/api-changelog-widgets.md), [Bot API widget sections](../../_debug/telegram-docs/widgets/bot-api-widget-sections.md), and the complete 997-line [HTML widget guide extracts](../../_debug/telegram-docs/widgets/telegram-widgets-complete-guide.md) plus overlapping line windows. Conclusions below use those saved snapshots only.

## 1. API, HTML, and trust boundaries

`sendWidget` required parameters: `chat_id` (integer or string) and `html` (string). Optional parameters: `message_thread_id`, `width`, `height`, `public_data`, `chat_data`, `caption`, `parse_mode`, `caption_entities`, `show_caption_above_media`, `allow_queries`, `is_shared`, `disable_notification`, `protect_content`, `allow_paid_broadcast`, `message_effect_id`, `reply_parameters`, and `reply_markup`. In production, it currently sends only to private chats and automatically protects content from forwarding. It returns the sent `Message`.

`Widget` fields: optional `id` (shared-widget ID), optional `width`, optional `height`, required `html`, optional `public_data`, optional `chat_data`. Width is app-clamped to 200 px through message-bubble maximum; height to 50–600 px. Omitted/automatic dimensions let the widget use full bubble width and/or content height.

HTML is a standalone document or fragment with inline `<style>` and `<script>`. Maximum HTML is **32,768 UTF-8 bytes and 4,096 bytes after zlib level-9 compression**. No NUL byte. Runtime is QuickJS ES2023 with Telegram widget-profile filtering. External scripts/styles/fonts/images, network access, navigation, form inputs/selects/textareas, and keyboard input are unavailable; data-URL raster images and inline SVG are supported. CSS is a constrained profile (common layout, text, borders, colors/theme variables, transitions, selected 2D transforms and media queries); the widget guide snapshot records profile 1 details. Unsupported features are filtered. The widget has no inner scroll or fullscreen mode.

`Message.widget` is optional and holds widget information. It includes the widget class above. `Update.widget_query` carries normal widget requests; `Update.shared_widget_query` carries requests from forwarded shared widgets.

### Query identity and payload

`WidgetQuery` fields: `id`; `from: User`; optional `chat`; optional `message_id`; optional `inline_message_id`; `chat_instance`; optional `chat_type`; `type`; `data` (1–64 bytes); optional `widget_id`. Thus sender user ID is `from.id`; origin is `chat.id` plus `message_id` for a normal message widget. Inline queries instead use `inline_message_id` and have no `chat`/`message_id`. In the production private-chat flow, use the actual query `chat.id` and message ID; do not infer tenant from widget state or data.

`SharedWidgetQuery` includes only `id`, `from`, `type`, `data`, and `widget_id`; it supplies no chat/message origin. Forwarded shared widgets are test-server-only per the guide.

Query type variants:

- `data`: normal app payload; optional `wallet_card` may accompany it.
- `sign_data`: separate TON-wallet-signed type with `wallet` and JSON `sign_data`, signed for domain `bot<bot_id>`.
- `sent_transaction`: wallet and `msg_hash` for a transaction sent by that wallet.
- `WidgetQueryWallet`: `address`, decimal-string `amount`; optional hex `public_key`; optional base64 `state_init` (omitted iff public key omitted).

**Trust:** ordinary `data` is client-supplied and the spec does not say it is signed. Validate it as attacker-controlled input. `sign_data` is a distinct wallet-signature feature; the fetched widget reference says which domain is signed but does not specify a complete server-side signature-verification procedure. Do not treat presence of a wallet object as proof that any ordinary `data` is signed.

### Sending data and editing state

With `allow_queries: true`, widget JavaScript calls `TelegramWidget.request(data)`; request data must be 1–64 UTF-8 bytes. The bot receives the update and answers with `answerWidgetQuery(widget_query_id, data?)`. Answer data is at most 1024 bytes and goes only to the requesting widget. A query must be answered within **15 seconds**. It does not change widget state. Bot-owned widget state is `chat_data` (message-specific) and `public_data` (shared/public); each is at most 1024 bytes. Widget reads these values and change events, but cannot write them.

`editMessageWidgetData` edits widget data on a bot-sent/bot-mediated message. It takes either `chat_id` + `message_id`, or `inline_message_id`, plus optional `public_data` and/or `chat_data` (each 0–1024 bytes; empty string clears; omitted preserves). It returns `True`. State edits are pushed to the open widget; use this instead of `answerWidgetQuery` when the visible list/detail should change. It counts against bot message-sending limits. Shared-widget public data can be edited at most once per second. The companion `editSharedWidgetData(widget_id, public_data, cache_time?)` edits shared public state, also at most once per second.

For paging/filtering one message: each tap sends a small operation and page/filter token through `request`; the server authenticates and re-fetches current leads for the tenant, then writes only a bounded page into `chat_data` using `editMessageWidgetData`. The immutable HTML re-renders on `chatDataChanged`. A compact five-row page can fit within 1024 bytes if fields are selected/truncated, but this must be measured against real maximum-length form data. Paginate with a strict bounded cursor/page and filter enum; never accept an arbitrary SQL offset or tenant ID.

## 2. Cost, setup, availability

Fetched widget/API docs state no Premium subscription, widget fee, Stars charge, or BotFather setting for ordinary private-chat `sendWidget`. This is a statement about these docs, not a broader Telegram billing guarantee. `allow_paid_broadcast` is an unrelated generic method option. A TON wallet is optional: it is only involved if the widget asks for wallet data/signatures/transactions. Normal lead queries need none.

Guide names iOS, Android, macOS, Telegram Desktop and web clients as rendering the widget profile, but provides **no minimum client build/version numbers**. Production widgets can currently be sent only to private chats with the bot; groups, inline mode and forwards are test-server-only. Widget messages have protected content automatically, cannot be forwarded, and cannot be copied through `copyMessage`/`copyMessages`. Non-supporting clients show unsupported media with the caption, so always include a useful caption.

## 3. `editMessageWidgetData` for lead pages

The method changes bot-owned state for an existing widget message; it does not replace HTML. On a page tap, answer quickly, query the page from the database, then set new `chat_data` on the same `chat_id` + `message_id`. Keep each state <=1024 bytes and include only one page of selected fields. The widget receives a state-change event and re-renders in place. Filters use fixed enums (`open`, `contacted`, `done`); page/cursor values are bounded and revalidated server-side. Rapid edits share normal send limits, so debounce taps and avoid full refreshes per keystroke.

## 4. Update subscription

Add exact allowed update name **`widget_query`** to the configured webhook or `getUpdates` `allowed_updates` list. `shared_widget_query` is a separate name, needed only for forwarded shared-widget queries (not a production first slice). An explicit `allowed_updates` list must include the new name or queries are not delivered.

## 5. Alder constraints and request handling

- **No `parse_mode` rule:** HTML is the dedicated `html` parameter, not a message `parse_mode`. `parse_mode` in this API applies to the optional caption only; `caption_entities` can replace it. A no-`parse_mode` sending policy is compatible: keep the caption plain text/entities and send widget markup as `html`.
- **Tenant authorization:** for an owner widget in production private chat, use query `chat.id` to re-fetch the corresponding `business_chats` binding on every query; then check current owner/recipient role. Scope every lead read/update/delete to that resolved `business_id`. Never derive tenant from `from.id`, widget HTML, `chat_data`, `public_data`, or request `data` alone. Do not accept inline/shared widget contexts in the first slice because they do not provide the same private-chat binding origin.
- **Inputs:** parse the 1–64 byte `data` with anchored, allow-listed grammars. Example operations: `page:<bounded-int>:<enum-filter>`, `open:<validated-lead-id>`, `status:<validated-lead-id>:<enum>`, `delete:<validated-lead-id>:confirm|cancel`. Reject trailing bytes, unknown operations, oversized/non-ASCII forms, stale IDs, invalid transitions, and out-of-range pages. Re-fetch lead and current state before mutation; use conditional, business-scoped DB updates.
- **Public form data / HTML injection:** homeowner lead fields are untrusted. Keep HTML and inline JS static; send dynamic values as JSON in bot-written `chat_data`, then render them using text nodes/`textContent`. If any value is ever interpolated into markup, context-escape it first. Never create HTML or JS source from a lead value. Avoid putting lead content in `public_data` or shared widgets.
- **Latency:** the widget guide and API both require answer within 15 seconds; a query is valid for 15 seconds. User/bot rate is five queries per five seconds, one in flight per widget. Keep auth, scoped lookup and response bounded; answer promptly and make slow side effects happen after the answer when possible. `editMessageWidgetData` is a separate state write and counts against sending limits.

## 6. Design sketches

### Business owner

One private, non-shared widget message per bound owner chat. Caption: “Alder leads · Open the bot to review estimates.” First view shows five newest leads (name, area, date, status) with fixed `Open`, `Older`, `Newer`, and status-filter buttons; no free-text entry. `Open` shows one lead's contact and estimate details plus fixed status actions. Status changes have allowed transitions and refresh the same message. Delete opens a separate confirm/cancel state; confirm re-fetches binding and lead, then performs the existing scoped delete behavior. IDs in requests are opaque validated lead IDs; tenant never comes from them. Use `chat_data`, not public/shared state. Keep rendered page under 1024 bytes, cap long fields in display, and provide any omitted detail in additional bounded detail view.

### Operator

Separate private widget sent only to configured operator chat. Authenticate operator chat ID on each query. First screen shows small system/lead counts and a fixed business selector; selecting a business causes a fresh server-side lookup and a five-lead page, then same detail/status/delete-confirm flow. The selected business value is a selector, not authority: operator role is checked first and every tenant lookup is resolved on the server. No forwards/shared widget, no text search input, no public state. The operator view is distinct from business-owner binding; it uses the existing operator allowlist, never an owner binding as an operator credential.

### Recommendation and first slice

**Adopt later.** The in-message UI could make browsing faster, but the feature is new, production-only-private, uncopyable/unforwardable, has immutable HTML, a 1024-byte state cap, five-query/5-second rate limit and a strict 15-second response window. Exact client build support is not documented. Alder's existing Telegram lead workflow has tested scoped callbacks; replacing it adds a new security and support surface. Keep the current path until the owner confirms target clients and the smoke test.

Minimal first slice: one static owner widget, one five-row page, one detail view, `widget_query` subscription, binding re-fetch/role check on every query, allow-listed read-only paging/filter requests, `answerWidgetQuery` plus bounded `chat_data` refresh. No status changes, delete, inline/shared widget or operator actions in the first release. Add status and two-step delete only after tenant/race/error handling is proven; operator widget comes later.

## 7. Open questions / items not verified

- Telegram docs do not publish minimum app versions/builds or a support rollout matrix for the named client families. Real phone and desktop rendering still needs the owner's device check.
- The fetched widget reference does not provide the full cryptographic verification algorithm for `sign_data`; this spike does not need wallet signing.
- No widget-specific price, Premium prerequisite or BotFather switch is stated in the fetched pages. Confirm through Telegram if commercial terms or an account-specific setting matters before launch.
- Exact TEST bot client build/version rendering remains unverified. The smoke test did not reach rendering: Telegram returned `Unauthorized` to the one `sendWidget` request, so no widget was delivered.

## Optional TEST bot smoke test

`.env.test` had non-empty TEST bot token and private-chat settings. A throwaway script under ignored `_debug/` made one static `sendWidget` request (HTML: “Hello”; no dynamic data or queries). Telegram returned **`Unauthorized`**. No widget arrived. Once the TEST token is corrected, the owner should open the TEST bot's private chat on phone and desktop and check that the inline “Hello” widget and caption render, size correctly, and fall back to caption on any unsupported client. The project test suite was not run, per task instruction.
