# Manual testing with three accounts

Three Telegram accounts, because two cannot show tenancy or the owner role:

| Account | Role | Setup |
| --- | --- | --- |
| **A** | operator | `/id` in a private chat with the bot; put that number in `OPERATOR_CHAT_ID` |
| **B** | owner of `alder-demo` | operator sends `/code alder-demo`, B taps the link and presses Start |
| **C** | owner of `second-demo` | operator sends `/code second-demo`, C taps and presses Start |

Set `OPERATOR_CHAT_ID` before anything else, then restart the deployment (the
value is read per invocation, so a redeploy is enough).

## The table

| # | Do this | Expect |
| --- | --- | --- |
| 1 | B sends `/leads` | only alder-demo's leads; one **Open** button each, **Older** only when there are more than 8 |
| 2 | B taps **Open** on a lead | a new message with that lead's current card and the buttons for its state |
| 3 | C sends `/leads` | only second-demo's leads; never one of B's |
| 4 | B sends `/code second-demo` | the plain-text hint. Operator commands leave no trace for a client |
| 5 | A sends `/code alder-demo` | a forwardable message with a `t.me/...?start=` link, the plain code and the expiry |
| 6 | C taps a link minted for alder-demo | C joins alder-demo (the code is not bound to a person, only to a business) — remove C with `/phones alder-demo` afterwards |
| 7 | A sends `/phones alder-demo` | `Phone 1 · main phone` for the oldest, then the others, one Remove button each |
| 8 | A taps Remove on a phone, then confirms | the phone is gone; if it was the last one, the message says nobody will receive alerts |
| 9 | B (second phone) sends `/invite` or `/recipients` | "Only the main phone can do this." |
| 10 | B (owner) sends `/invite`, C uses the code | C joins B's business; B still owns it (oldest phone) |
| 11 | B removes itself from `/recipients` while another phone remains | the oldest remaining phone becomes the main phone |
| 12 | B deletes the chat in Telegram, then searches the bot and presses Start | "You're all set" — the binding is keyed by chat id, so it survives |
| 13 | B blocks the bot, then a lead arrives | the lead is stored, the owner email still goes, and A gets one "blocked" notice |
| 14 | C pastes a wrong, expired or already-used code into the chat | "That code didn't work. It may have expired or been used." — one answer for all three |
| 15 | C pastes a valid code with spaces or hyphens | it binds |
| 16 | B taps **Mark contacted** on an old card after C already did | "Already updated." and the card refreshes to the current state |
| 17 | A lead arrives for a business with no phone | A gets one plain notice with no buttons; no alert with buttons is ever sent to an unbound chat |
| 18 | A sends `/businesses` | slug, status and phone count for every business |
| 19 | `node scripts/send-test-lead.mjs alder-demo --email <you> --phone <a real number> --yes` | one labelled "Test Lead 1" lead; B gets the alert; the auto-reply goes to that address once `MAIL_REDIRECT_TO` is off |
| 20 | `node scripts/preview-send.mjs --to <A's chat id> --yes --email <you>` | every preview text in A's chat, each prefixed `PREVIEW`, and five preview emails |

## After testing

```
node scripts/sweep-demo-leads.mjs alder-demo            # dry run: ids and counts
node scripts/sweep-demo-leads.mjs alder-demo --yes --confirm alder-demo
```

The sweep keeps anything with a `review_token` (a customer may hold that link)
and anything whose key is a page-minted UUID, so only the labelled test rows go.
