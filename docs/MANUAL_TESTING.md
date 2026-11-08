# Manual testing with two accounts

Two Telegram accounts are enough. A is the operator and the manager of
`alder-demo`; B manages `second-demo`. Tenancy is still visible in both
directions, and the owner rule is visible when B temporarily joins A's business
and becomes a staff phone there.

| Account | Role | Setup |
| --- | --- | --- |
| **A** | operator + manager of `alder-demo` | send `/id` in a private chat with the bot, put that number in `OPERATOR_CHAT_ID`, then restart the deployment |
| **B** | manager of `second-demo` | A sends `/code second-demo`; B taps the link and presses Start |

`OPERATOR_CHAT_ID` is read on every invocation, so a redeploy is enough. The
operator chat does not have to belong to a business, and in this setup it also
does not have to be a separate person.

**Never press a client's link from the operator account.** The bot refuses, but
the refusal exists to catch a mistake: opening a link is how a phone joins a
business. If the operator is already bound, the bot says so and the code stays
valid for the client; if the operator chat is not bound yet, the bot says "This
is the operator chat. Send the link to the client, do not open it yourself." and
does not claim the code. Either way, the code is still there for the client.

The client message itself is plain text with entities: the four words "connect
your lead alerts" carry the link, and the code sits on its own last line. There
is no visible URL, so a screenshot of the message does not leak the link.

**Known limitation.** One account can belong to one business at a time, because
`business_chats.tg_chat_id` is unique. A multi-business owner is a proposal that
needs a schema change (a join table or a nullable business per chat); it is not
applied. That is why the cross-business steps below move B temporarily and move
B back.

**Before the operator work is merged**, the old `/api/selfcheck` still sends its
owner message to every bound chat of a business, so B may receive A's business
summary during this test. That stops when `ops-audience` is deployed.

## The table

| # | Do this | Expect |
| --- | --- | --- |
| 1 | A sends `/id` | the chat id, and the `OPERATOR_CHAT_ID` instruction. No slug, no business name |
| 2 | A sends `/leads` | only `alder-demo`'s leads; one **Open** button each, **Older** only past 8 |
| 3 | B sends `/leads` | only `second-demo`'s leads; never one of A's |
| 4 | B sends `/code alder-demo` | the plain-text hint. Operator commands leave no trace for a manager |
| 5 | A sends `/code alder-demo` | **two** messages: a short line naming the slug and the expiry, then the forwardable text with a `t.me/...?start=` link and no slug |
| 6 | A sends `/phones alder-demo` | `Phone 1 · main phone` for the oldest, then the others, one Remove button each |
| 7 | A sends `/invite` three times | the third reply lists three invites with their expiry and no codes, plus **Cancel old invites and make a new one** |
| 8 | A taps that button | the old invites stop working, exactly one new invite arrives; a second tap within a minute says they were already cancelled and mints nothing |
| 9 | A forwards the new invite to B; B taps it and presses Start | B joins `alder-demo` as a staff phone. This is the temporary move |
| 10 | B sends `/invite` and `/recipients` | "Only the main phone can do this." Nothing is minted or removed |
| 11 | A sends `/recipients` | both phones, B marked as a normal phone, and one `Pending invites: N.` line |
| 12 | A removes B, then sends `/phones alder-demo` | B is gone; the oldest remaining phone is still `Phone 1 · main phone` |
| 13 | A sends `/code second-demo`, B taps it | B is back on `second-demo`, and `/leads` shows only that business again |
| 14 | B pastes a code minted for `alder-demo` | "This phone is already connected to a business. The code was not used." B does not move, and A can still use that code for someone else |
| 14b | A (operator, already bound to `alder-demo`) presses a client link | the operator wording: "This chat is already connected to a business. The code was not used and is still valid for the client." No client advice, and the code still works for B |
| 14c | A fresh operator chat (not bound) presses a client link | "This is the operator chat. Send the link to the client, do not open it yourself." The code is not claimed |
| 15 | B pastes a wrong, expired or already-used code | "That code didn't work. It may have expired or been used." One answer for all three |
| 16 | B pastes a valid code with spaces or hyphens | it binds; case does not matter |
| 17 | B deletes the chat in Telegram, then searches the bot and presses Start | "You're all set". The binding is keyed by chat id, so it survives |
| 18 | B blocks the bot, then a lead arrives for `second-demo` | the lead is stored, the owner email still goes, and A gets one "blocked" notice per business per day |
| 19 | B unblocks the bot and presses Start | the bot answers again; the next lead reaches B |
| 20 | A sends a lead to a business with no phone | A gets one plain notice with no buttons. No alert with buttons is ever sent to an unbound chat |
| 21 | A sends `/businesses` | slug, status and phone count for every business |
| 22 | `node scripts/send-test-lead.mjs alder-demo --email <you> --phone <a real number> --yes` | one labelled "Test Lead 1" lead; A gets the alert; the auto-reply goes to that address once `MAIL_REDIRECT_TO` is off |
| 23 | `node scripts/preview-send.mjs --to <A's chat id> --yes --email <you>` | every preview text in A's chat, each prefixed `PREVIEW`, and five preview emails |

## After testing

```
node scripts/sweep-demo-leads.mjs alder-demo            # dry run: ids and counts
node scripts/sweep-demo-leads.mjs alder-demo --yes --confirm alder-demo
```

The sweep keeps anything with a `review_token` (a customer may hold that link)
and anything whose key is a page-minted UUID, so only the labelled test rows go.
