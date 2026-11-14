# Manual testing with three accounts

Three Telegram accounts, three roles. A is the operator and is never bound to a
business. B owns `alder-demo`. C owns `second-demo`. Every step below is one
action and the exact result to expect.

| Account | Role | How it is set up |
| --- | --- | --- |
| **A** | operator only | A sends `/id` in a private chat with the bot. Put that number in `OPERATOR_CHAT_ID` and redeploy. The operator chat must never be bound to a business |
| **B** | owner of `alder-demo` | A sends `/invite`, taps the number of `Alder Roofing`, forwards the **second** message (the new one) to B, B taps the link and presses **Start** |
| **C** | owner of `second-demo` | A sends `/invite`, taps the number of `Second Demo Roofing`, forwards the **second** message (the new one) to C, C taps the link and presses **Start** |

`OPERATOR_CHAT_ID` is read on every request, so a redeploy is enough. After the
deploy run `npm run tg:commands` (with `OPERATOR_CHAT_ID` in that shell or in
`.env.local`): it sets A's command menu to `/businesses`, `/invite`, `/help`,
`/id` and prints both menus. If it prints `OPERATOR MENU NOT UPDATED`, A keeps
the old menu. The three
accounts can belong to the same person as long as they are three separate
Telegram accounts in three separate private chats with the bot.

Two rules that prevent most mistakes:

- **Never press a client's link from A.** Opening a link is how a phone joins a
  business. The bot refuses, but the refusal exists to catch the mistake.
- **One account belongs to one business at a time.** `business_chats.tg_chat_id`
  is unique. Moving an account needs it removed first: the owner removes it in
  `/recipients`. Suspend does not remove a phone; it stops the business and
  keeps every binding.

## The script

| # | Do this | Expect exactly this |
| --- | --- | --- |
| 1 | A sends `/id` | A's chat id, and the line telling A to put it in `OPERATOR_CHAT_ID`. No business name, no slug |
| 2 | A sends `/businesses` | **One** message titled `Businesses`, up to five numbered rows a page, sorted by name: `1. Alder Roofing · Demo · 1 phone` and `Second Demo Roofing · Demo · 1 phone` after step 6. Under the text one row of number buttons that match the rows, then at most one navigation row (**Older** alone on the first page, **Newer** and **Older** in the middle, **Newer** alone on the last, none when everything fits). No lead details on this screen |
| 2a | A taps a number | The **same** message becomes that business: the name, `Demo · alder-demo`, a blank line, `Telegram: Connected` with `Phone 1 · main phone` under it (or `Telegram: Not connected` and no phone line), a blank line, `Leads: N total · N in the last 30 days` and `Last lead: 2d ago` (no `Last lead` line when there are none). No `Requests:` line. Buttons: **Suspend** (red) and **Leads** on the first row, **Invite** and **Back** on the second. **Back** returns to the same page of the list |
| 3 | A sends `/invite` (or presses **Invite** on the keyboard) | **One** message, `Invite: pick a business`, the served businesses five a page as `1. Alder Roofing · Demo`, a number button per row, **Older** / **Newer** only where they lead somewhere. A taps the number of `Alder Roofing` (no phone connected yet): the **same** message becomes `Code for alder-demo: <code>` (tap the code to copy it), then `Expires in 24 hours. The next message is for the client — forward it as it is.`, with **Back** to the same page of the list. A **second, new** message follows: "Tap here to connect your lead alerts on Telegram, then press Start." where `connect your lead alerts` is the link (no address is visible), the fallback line, and the same code on its own line. It names no business |
| 4 | A forwards the second message to B; B taps the link and presses Start | B is connected: "You're all set. New requests will appear here." |
| 5 | B sends `/leads` | `Recent requests` and only `alder-demo`'s leads, five per page. Under the text, one row of number buttons (`1` to `5`) that match the numbers in the text, then at most one navigation row: **Older** alone on the first page, **Newer** and **Older** side by side in the middle, **Newer** alone on the last page, no row at all when everything fits on one page. Each text row is name, job type, phone, then status and age. Tapping a number opens that lead in the same message with its status button and **Back** |
| 6 | A sends `/invite second-demo`, forwards the **second** of the two messages to C, C taps and presses Start | The shortcut gives the same two messages, both new: the first names `second-demo` and has **Back** to the list, the second is the forwardable one with no slug. C is connected with the same "You're all set" message |
| 6a | A sends `/invite`, taps the number of `Alder Roofing` again (B is connected now); then the same through `/invite alder-demo` and through **Invite** on the business's screen | Each time: `Alder Roofing · Already connected · 1 phone` with **Replace phone** (red) and **Back**. No code, no second message, nothing created |
| 6b | A taps **Replace phone**, then **Cancel** | The question: "Replace the phone of Alder Roofing? The 1 current phone stops receiving alerts and loses access immediately, and a new invite is created. Alerts on Telegram stay off until the new phone connects; new leads are still saved and emailed." with **Confirm replace** (red) and **Cancel** side by side. **Cancel** returns to `Already connected`. B is still connected |
| 6c | A taps **Replace phone**, then **Confirm replace** | B receives exactly "Your access to lead alerts for this business was ended by support." and B's keyboard disappears. A's message becomes `Code for alder-demo: <code>` and `Expires in 24 hours. 1 phone removed. The next message is for the client — forward it as it is.`, and the forwardable message follows. Tapping **Confirm replace** on an older copy of the question answers "Already replaced." and changes nothing |
| 6d | B sends `/leads`, then taps a button of an old alert | "This chat isn't connected yet." and "Not found.": B has no access. A forwards the new second message to B (or to a fourth account); it connects and is the main phone (it can `/invite`). Do this before step 7 so B is connected again |
| 7 | C sends `/leads` | Only `second-demo`'s leads. Never one of B's |
| 8 | B sends `/businesses`, then `/code second-demo` | Nothing is shown and nothing is minted. A non-operator gets the plain-text hint ("I only respond to commands…"), so the commands leave no trace |
| 9 | B sends `/invite` | **Two** messages. The first is exactly "Forward the next message to the person you want to add. Do not tap it yourself." The second is the forwardable invite with a `t.me/...?start=` link and a code |
| 10 | A sends `/help` | `Operator commands` and four lines: `/businesses`, `/invite [slug]`, `/help`, `/id`. A's command menu (the `/` button) lists the same four and nothing else |
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
| 26 | A sends `/leads`, `/recipients`, `/remove_lead`, `/code alder-demo`, `/phones` | Each gets exactly "This is the operator chat. Send /help for the commands." No list, no picker, no code |
| 27 | A presses **Businesses** on the keyboard | The same `Businesses` message as step 2. There is no **Remove** button for a phone; a single phone is removed by the owner in `/recipients` |
| 27a | A opens `alder-demo` in `/businesses` and taps **Leads** | The same message becomes `Alder Roofing`, `Leads` and the five newest as `1. Repair · New · 2d ago`: service, status and age only. A number shows `Alder Roofing`, `Lead`, `Service:`, `Status:`, `Received:` with **Back** only. No name, phone, email, address or note anywhere, and no Mark contacted, Job completed or Remove. Nothing A taps here changes a lead |
| 27b | A opens `second-demo` and taps **Suspend** | A question: "Suspend Second Demo Roofing? Telegram alerts, emails and the website form stop for this business. Data is kept and you can reactivate at any time." **Confirm suspend** (red) and **Cancel**. **Cancel** returns to the business; C still gets alerts |
| 27c | A taps **Suspend**, then **Confirm suspend** | C gets "Your service has been suspended. Contact support if this is a mistake." and C's bottom keyboard disappears. The owner email address of `second-demo` gets one plain email with the same sentence. A's message becomes `Second Demo Roofing suspended · 0 notices failed` with **Back**; the business screen now reads `Suspended · second-demo` with **Reactivate**, **Leads** and **Back** |
| 27d | C sends `/leads`, presses a keyboard button, then taps a button on an old alert | "This service is suspended. Contact support." for the command and the press, and the same words as a toast for the tap. No lead, no list, no phone list is shown |
| 27e | A sends a lead for `second-demo` | The request is refused with 404 and nothing is stored: no Telegram alert, no owner email, no auto-reply, no notice to A. `/businesses` shows `Second Demo Roofing · Suspended · 1 phone`: the phone is still bound |
| 27f | A opens an older message and taps **Confirm suspend** on `second-demo` again; A sends `/invite second-demo` | A toast "Already suspended." and nothing is sent to anyone. The invite is refused: "Second Demo Roofing is suspended. Reactivate it first." |
| 27g | A opens `second-demo` and taps **Reactivate** | C gets "Your service is active again." with C's own keyboard back. A's message becomes `Second Demo Roofing reactivated`; the status is now `Active` (not `Demo`). C's `/leads` works, a new lead for `second-demo` is stored and alerts C, with no new invite and no re-onboarding |
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
- The operator's list, alarms and notices carry counts per business and never a
  lead's name, phone, email or note. `/businesses` → a business → **Leads**
  shows the service, the status and the age of each lead and nothing else.
- A suspended business gets nothing and shows nothing: no lead is stored, no
  alert or email is sent, and its phones get one neutral line.

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
