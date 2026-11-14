# Telegram Leads widget: implementation notes

Source: saved Bot API and HTML widget snapshots in `_debug/telegram-docs/widgets/`. This is a read-only demo plan for a business owner in the bot's private chat. It does not add application code.

## Bot API requests

Use JSON POST bodies. The HTML is fixed/static; row data arrives separately in `chat_data`.

### `sendWidget`

```json
{
  "chat_id": "<bound private chat id>",
  "html": "<static HTML document below>",
  "caption": "Alder leads · Open the bot to review estimates.",
  "allow_queries": true,
  "chat_data": "{\"p\":0,\"rows\":[],\"older\":false}"
}
```

Omit `width` and `height` for automatic width and content height. `html` and `chat_data` are separate fields; never interpolate a lead value into HTML or JavaScript. The `chat_id` comes from the current `business_chats` binding, not the widget request.

### `answerWidgetQuery`

```json
{
  "widget_query_id": "<update.widget_query.id>",
  "data": "Page loaded"
}
```

`data` is optional, up to 1024 UTF-8 bytes, and reaches only the widget that made the request. It does not update the displayed list.

### `editMessageWidgetData`

```json
{
  "chat_id": "<update.widget_query.chat.id>",
  "message_id": 123,
  "chat_data": "{\"p\":1,\"rows\":[...],\"older\":true}"
}
```

For this private-chat demo, use the query's `chat.id` and `message_id`; both must be present. `chat_data` replaces the per-message state (0–1024 UTF-8 bytes). Omit `public_data`: it is shared/public state. Omitted state fields remain unchanged; an empty string clears a field. An edit returns `True`, counts against message-sending limits, and causes `chatDataChanged` in the open widget.

### Update subscription

Add exact entry `"widget_query"` to `allowed_updates`. Example list (preserve existing required entries):

```json
{"allowed_updates":["message","callback_query","widget_query"]}
```

`shared_widget_query` is a separate update for forwarded shared widgets; it is unnecessary for this private, non-shared demo.

## Widget-side API and trust boundary

- `TelegramWidget.chatData` and `TelegramWidget.publicData` are `string | null`, read-only. Parse `chatData` as JSON and render its fields. `TelegramWidget.viewer` identifies the current viewer; `chatType`, `isPreview`, `colorScheme`, and `themeParams` expose presentation/context. Listen for `themeChanged` if theme is read dynamically. For this demo, only the bot writes `chat_data`; do not use `public_data` for lead data.
- Register `TelegramWidget.onEvent('chatDataChanged', render)` and redraw from the new `chatData`. For shared data the corresponding event is `publicDataChanged`; shared state is out of scope here.
- `TelegramWidget.request(data)` sends 1–64 UTF-8 bytes to the bot and returns a promise resolving to `{result: string | null}`. Call it synchronously in a visible button's tap handler. Only one request may be in flight for a widget. Send `page:<n>` with a bounded decimal page number; server validates the anchored grammar `^page:(0|[1-9][0-9]{0,2})$`.
- `viewer` is available when queries are allowed, but the server must authenticate from Telegram's update. Use `update.widget_query.from.id` only as sender identity, and re-fetch the `business_chats` binding from `update.widget_query.chat.id` on every request. Require a private chat and an existing eligible owner binding. Scope every read by the freshly resolved `business_id`; never trust page data, `chat_data`, or a lead ID as tenant authority.
- `chat`, `message_id`, `from`, `data`, and query ID arrive in `Update.widget_query`. Inline messages omit `chat` and `message_id`; production widget sending is currently private-chat only. Reject contexts missing the expected private chat/message origin.
- `TelegramWidget.wallet` is optional and may be `null`; no wallet is needed. The widget has no `sendMessage`, network access, keyboard, or editable `<input>` controls. Its only bot channel is `request()`.
- On request failure, display `error.code`; do not assume the server action succeeded. The widget remains read-only: page taps fetch another page, with no status/delete actions.

## Format, CSS, and sizing

- One HTML document or fragment with inline `<style>` and `<script>`. QuickJS ES2023 sandbox. External script/style/font/image loads and all network APIs are disabled. Use static markup and `textContent` for data; no dynamic `innerHTML`.
- Maximum HTML is 32,768 UTF-8 bytes and 4,096 bytes after zlib level-9 compression. No NUL. `chat_data` and `public_data` each cap at 1024 UTF-8 bytes; request data caps at 64 bytes.
- Supported CSS includes block/inline, flex, grid and tables; common box/paint; 2D transforms; text and RTL; transitions/keyframes; custom properties; `touch-action`; and media queries for width, orientation, color scheme, and reduced motion. It is filtered: `vh`, scrolling overflow, sticky positioning, external URLs/fonts, 3D transforms, form-state selectors, and several modern CSS features are unsupported. Use the published theme variables: `--tg-theme-bg-color`, `--tg-theme-text-color`, `--tg-theme-hint-color`, `--tg-theme-link-color`, `--tg-theme-button-color`, `--tg-theme-button-text-color`, `--tg-theme-secondary-bg-color`, `--tg-theme-accent-text-color`, `--tg-theme-subtitle-text-color`, `--tg-theme-destructive-text-color`, and `--tg-theme-section-separator-color`. `color-scheme: light dark` follows the chat theme. Do not hard-code contrast-sensitive colors.
- Bubble width clamps to 200–600 CSS px (phones commonly 320–430 px). Automatic content height clamps to 50–600 px; overflow is clipped, with no inner scroll or fullscreen. Keep the five-row view below about 560 px at 320 px width. Omit both sizing fields for auto layout.
- Always send a plain-text caption; clients without widget support show unsupported media with the caption. In production, widgets are private-chat only, protected from forwarding, and cannot be copied.

## Minimal working HTML example

This example uses only fixed markup plus server-provided state. It builds the list with DOM nodes and `textContent`; it does not insert lead data as HTML. The “Older” button asks for the next page; the server answers the query and pushes the new state with `editMessageWidgetData`.

```html
<section><h3>Alder leads</h3><ol id="rows"></ol><p id="info"></p><button id="older">Older</button></section>
<style>
:root{color-scheme:light dark}body{margin:0;color:var(--tg-theme-text-color);font:var(--tg-text-font-size,15px)/1.35 system-ui,sans-serif}li{margin:.45em 0}small,p{color:var(--tg-theme-hint-color)}button{width:100%;padding:.65em;border:0;border-radius:.6em;background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color)}
</style>
<script>
const T=window.TelegramWidget,R=document.querySelector('#rows'),I=document.querySelector('#info'),B=document.querySelector('#older');let busy=false;
function state(){try{return JSON.parse(T.chatData||'null')}catch{return null}}
function draw(){const s=state();R.replaceChildren();if(!s||!Array.isArray(s.rows)){I.textContent='No leads';B.disabled=true;return}for(const x of s.rows.slice(0,5)){const li=document.createElement('li'),n=document.createElement('strong'),m=document.createElement('small');n.textContent=String(x.n||'New lead');m.textContent=String(x.s||'new')+' · '+String(x.d||'');li.append(n,m);R.append(li)}I.textContent=s.rows.length+' leads';B.disabled=busy||!s.older}
T.onEvent('chatDataChanged',draw);
B.addEventListener('click',()=>{const s=state();if(busy||!s||!s.older||!Number.isSafeInteger(s.p)||s.p>=99)return;busy=true;draw();T.request('page:'+(s.p+1)).then(a=>{if(a.result)I.textContent=String(a.result)},e=>{I.textContent='Could not load ('+e.code+')'}).finally(()=>{busy=false;draw()})});draw();
</script>
```

## State byte budget

`chat_data` is capped at 1024 **UTF-8 bytes**, not characters. A measured five-row JSON example is **984 bytes** with these list caps: UUID `id` 36 bytes; `n` name 48 bytes (24 Arabic characters at 2 bytes each); `a` area 24 bytes (12 Arabic characters); `s` one-character status; `d` 10-byte date; `note` 24 bytes (12 Arabic characters). Wrapper is `{p,rows,older}`. This leaves 40 bytes of headroom, so do not add fields without remeasuring.

Long notes do not belong in each list row. Truncate them to 24 UTF-8 bytes in the list, using a byte-aware truncator that does not split a code point. Show the full selected lead in a separate detail state; a measured compact JSON shape with a 512-byte note, 64-byte name, 32-byte phone, 128-byte email, 48-byte area, UUID, status and date is 910 bytes. Consider lower caps if actual names/notes include four-byte emoji or more metadata. Enforce the 1024-byte cap before calling `sendWidget` or an edit; never cut UTF-8 by JavaScript character index.

## Rate limits, deadline, and errors

- Telegram allows at most 5 widget queries per user per bot per 5 seconds. One request can be in flight per widget; a second returns `BUSY`. A tap allows one request, called synchronously in that tap handler.
- `answerWidgetQuery` must arrive within 15 seconds; the query ID is valid for 15 seconds. Answer data may be 0–1024 bytes. Answer promptly, bound database work, and return state separately through `editMessageWidgetData`.
- Handle `NOT_ALLOWED` (queries disabled, preview/unsupported context), `BUSY`, `RATE_LIMITED`, `TIMEOUT`, `FAILED`, and `INVALID_ANSWER`. Request payload outside 1–64 UTF-8 bytes throws `TypeError`; oversized answer is rejected. A missing/invalid query origin must fail closed in the handler.
- A widget task running beyond 500 ms can be stopped. Keep this demo's rendering synchronous and small. `editMessageWidgetData` also counts against the bot's normal send limits.

## Unverified

- Telegram's saved guide does not publish minimum client build numbers or a complete rollout table. Device rendering still needs an owner check.
- The full cryptographic verification procedure for the separate wallet `sign_data` query type is not in these snapshots; this read-only Leads demo does not use it.
- The current task's `getMe` identified `getleadalerts_bot`, but this checkout has no configured production bot username to compare. Do not send the smoke widget until the owner confirms that identity is not the production bot.
