# Manual testing with three accounts

Three Telegram accounts, three roles. A is the operator and is never bound to a
business. B owns `alder-demo`. C owns `second-demo`. Every step below is one
action and the exact result to expect.

| Account | Role | How it is set up |
| --- | --- | --- |
| **A** | operator only | A sends `/id` in a private chat with the bot. Put that number in `OPERATOR_CHAT_ID` and redeploy. The operator chat must never be bound to a business |
| **B** | owner of `alder-demo` | A sends `/code alder-demo`, A forwards the **last** of the two messages to B, B taps the link and presses **Start** |
| **C** | owner of `second-demo` | A sends `/code second-demo`, A forwards the **last** of the two messages to C, C taps the link and presses **Start** |

`OPERATOR_CHAT_ID` is read on every request, so a redeploy is enough. The three
accounts can belong to the same person as long as they are three separate
Telegram accounts in three separate private chats with the bot.

Two rules that prevent most mistakes:

- **Never press a client's link from A.** Opening a link is how a phone joins a
  business. The bot refuses, but the refusal exists to catch the mistake.
- **One account belongs to one business at a time.** `business_chats.tg_chat_id`
  is unique. Moving an account needs the operator to remove it first
  (`/phones <slug>`, then **Remove**).

## The script

| # | Do this | Expect exactly this |
| --- | --- | --- |
| 1 | A sends `/id` | A's chat id, and the line telling A to put it in `OPERATOR_CHAT_ID`. No business name, no slug |
| 2 | A sends `/businesses` | One block per business: name, status, phone count. `Alder Roofing · Demo · 1 phone` and `Second Demo Roofing · Demo · 1 phone` after step 6. No lead details |
| 3 | A sends `/code alder-demo` | **Two** messages. The first names `alder-demo` and says the code expires in 24 hours. The second is the forwardable one: a `t.me/...?start=` link, the code, and no slug |
| 4 | A forwards the **second** message to B; B taps the link and presses Start | B is connected: "You're all set. New requests will appear here." |
| 5 | B sends `/leads` | `Recent requests` and only `alder-demo`'s leads, five per page, one numbered **Open** button each, **Older** only when there are more than five. Each row is name, job type, phone, then status and age |
| 6 | A sends `/code second-demo`, forwards the **second** message to C, C taps and presses Start | C is connected with the same "You're all set" message |
| 7 | C sends `/leads` | Only `second-demo`'s leads. Never one of B's |
| 8 | B sends `/code second-demo` | Nothing is minted. A non-operator gets the plain-text hint ("I only respond to commands…"), so the command leaves no trace |
| 9 | B sends `/invite` | **Two** messages. The first is exactly "Forward the next message to the person you want to add. Do not tap it yourself." The second is the forwardable invite with a `t.me/...?start=` link and a code |
| 10 | A sends `/invite` | A is the operator, so A gets `Which business?` and one button per business. Tapping `alder-demo` shows the same two messages for that business |
| 11 | B sends `/recipients` | One line per phone, `Phone 1 · you (main)` for B, and `Pending invites: N.` |
| 12 | B sends `/remove_lead` | `Which request do you want to remove?`, five per page, numbered buttons and no phone numbers |
| 13 | B taps a number, then **Remove** | "Removed." The list shrinks. A second tap on the same number says "That request is no longer here." |
| 14 | B taps **Older** when there is no older page | A toast "No older requests." The message and its buttons stay exactly as they were. Nothing is replaced by an empty list |
| 15 | B deletes a lead in `/remove_lead`, then taps **Older** on an older message | Same toast. The message is never emptied, so B is never left with a screen and no buttons |
| 16 | C sends `/invite` and `/recipients` | C is the main phone of `second-demo`, so both work. Neither ever lists a phone or a lead from `alder-demo` |
| 17 | B pastes the code A minted for `second-demo` | Exactly one sentence: "This chat is already connected to a business, so that code was not used." B does not move, and A can still use that code for C |
| 18 | C pastes the code A minted for `alder-demo` | The same one sentence. C does not move, and the code still works for B |
| 19 | B taps a `second-demo` link while already connected | The same one sentence. The code is not consumed |
| 20 | B pastes a wrong, expired or already-used code | "That code didn't work. It may have expired or been used. Ask for a new one." One answer for all three |
| 21 | B pastes a valid code with spaces or hyphens, in lower case | It binds. Case and separators do not matter |
| 22 | A sends a lead for `alder-demo` (see below) | Only B gets the alert. C gets nothing. A gets no lead content |
| 23 | A sends a lead for `second-demo` | Only C gets the alert. B gets nothing |
| 24 | B opens the alert and taps **Mark contacted**, then **Job completed**, then **Send request** | The review email goes to the address on that lead, and the page it links to carries `alder-demo`'s name and `alder-demo`'s Google link |
| 25 | C does the same on a `second-demo` lead | The page carries `second-demo`'s name and its Google link, never Alder's |
| 26 | A sends `/leads` | "This is the operator chat. Pick a business with /phones or /code. Lead lists are on the owner phones." The operator never sees a lead list |
| 27 | A sends `/phones alder-demo` | `Phone 1 · main phone` for the oldest phone, the others listed, one **Remove** button each |
| 28 | B sends `/invite` a fourth time in one hour | "Too many invites this hour. Try again later." Nothing is minted |
| 29 | B deletes the bot chat, searches the bot and presses Start | "You're all set" again. The binding is keyed by chat id, so it survives |
| 30 | B blocks the bot, then a lead arrives for `alder-demo` | The lead is stored, the owner email still goes out, and A gets one "blocked" notice for that business |
| 31 | B unblocks the bot and presses Start | The bot answers again and the next lead reaches B |
| 32 | Trigger `/api/digest` with the cron secret | B gets `alder-demo`'s counts and C gets `second-demo`'s. Counts only: no name, phone, email or note |

## Isolation checklist

Run these after the script above. Each one is a sentence you can check without
reading the database.

- A lead submitted for `alder-demo` reaches B and only B; a lead for `second-demo`
  reaches C and only C.
- `/leads`, `/recipients` and `/remove_lead` show only the caller's own business,
  whatever is typed.
- An invite minted for one business never joins the other: B pasting
  `second-demo`'s code and C pasting `alder-demo`'s code are both refused, and
  both codes stay usable.
- The daily digest and every email name the right business and go to the right
  owner.
- A review link opens the page of the business whose lead it belongs to, with
  that business's Google link.
- The operator sees counts per business and never a lead's name, phone, email or
  note.

## Sending a test lead

Both businesses accept a labelled test lead through the real endpoint:

```
node scripts/send-test-lead.mjs alder-demo  --email you@example.com --phone 5155550100 --yes
node scripts/send-test-lead.mjs second-demo --email you@example.com --phone 5155550100 --yes
```

The email and phone are required: the auto-reply goes to that address, and a
placeholder would mail a stranger. The lead is labelled `Test Lead N`.

## Cleaning up without SQL

```
node scripts/sweep-demo-leads.mjs alder-demo                # dry run: ids and counts
node scripts/sweep-demo-leads.mjs alder-demo  --yes --confirm alder-demo
node scripts/sweep-demo-leads.mjs second-demo --yes --confirm second-demo
```

The sweep removes only labelled test rows: `manual-test-…` keys from the script
above, and `canary-…` rows. It keeps anything with a review token, because a
customer may be holding that link.

To remove one specific lead (the one you marked done in step 24, for example):

```
node scripts/delete-lead.mjs <lead-id>                       # counts only
node scripts/delete-lead.mjs <lead-id> --yes --confirm <lead-id>
```

Both scripts print counts and table names only, never a name, phone or email.
