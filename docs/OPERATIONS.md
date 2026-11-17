# Operations runbook

What to do when a business joins, leaves, adds a phone, or something breaks.
Every command and env name here was checked against the code in this repo.
No secret values appear anywhere in this document — names only.

Related: `docs/ONBOARDING.md` (the long version of step 1), `docs/TEST_PROJECT.md`
(pointing the suite at a separate Supabase project), `SESSION_HANDOFF.md`
(state, decisions and why).

---

## 0. Add a client page

Every client value comes from one file: `clients/<slug>.json`. It holds a `biz`
object with the same keys the page template defines, and an optional `copy` object
for the text blocks that were moved out of the page.

1. Copy `clients/alder.json` to `clients/<slug>.json` and change the values. The
   slug is a file name: lowercase letters, digits and hyphens, starting with a
   letter or digit. Anything else is refused before the file is read.
2. Build it: `npm run build -- --client <slug>` or `CLIENT=<slug> npm run build`.
   The default is `alder`.
3. The build refuses, with one line, if the file is missing, is not valid JSON, is
   missing a key, or carries a key the template does not know. It never writes a
   half-built page.

`clients/example.json` is a sample with fake values. It exists so the second-client
test has something to build.

Three more top-level keys:

- `domain` — the public address, `https://host` with no trailing slash. `robots.txt`
  and `sitemap.xml` are generated from it, so no client inherits another's address.
- `lastmod` — `YYYY-MM-DD` for the sitemap.
- `sender` — optional. The address this client's email comes from. When it is
  absent the deployment's `MAIL_FROM` is used, which is Alder's case.

A `copy` key that no token uses is a build error naming the key, so a typo cannot
sit in the file looking like it works.

The `copy` object holds the visible text, keyed by section and number (`services1`,
`faq3`, `reviews2`). Order follows the page. A block that contains a tag — the hero
heading has a line break, the services heading has a highlighted span — is split
into `…A`, `…B`, `…C` around the tag instead of being stored as HTML, because token
values are HTML-escaped.

## 1. Onboard a business

The full walkthrough is `docs/ONBOARDING.md`. The short version:

1. **Create the row** in `public.businesses` (Supabase SQL editor, service role):
   `slug`, `name`, `status` (`active` or `demo`), `timezone`, `owner_email`,
   `google_review_url`. Never insert from a browser — the anon key cannot.
2. **Mint a code**: `npm run bind -- <slug>`. It prints the business name, a
   single-use 12-character code, the 24 h expiry and a `https://t.me/<bot>?start=<code>`
   deep link.
3. **The roofer sends `/start <code>`** to the bot (or opens the deep link).
   The webhook claims the code once and writes one `business_chats` row.
4. **Send a test lead** through the site's modal with a real phone number, then check
   `/api/health`: `last_24h.created` and `last_24h.tg_sent` should both be at least 1.
5. **Mail settings**: `MAIL_FROM` must be an address on a domain verified in Resend,
   and `MAIL_REDIRECT_TO` must be **absent** in production (see §7).
6. **Commands**: after the first deploy that adds or renames a command, run
   `npm run tg:commands` once (see §7).

A business with `status` `paused` (shown as Suspended) or `churned` (shown as
Terminated) gets no lead alert, no digest and no self-check message: those only
target `demo` and `active` rows, and `getActiveBusinessBySlug` refuses to serve
its page. The only messages it gets are the lifecycle notices of section 3b.

## 2. Offboard a business, or delete one lead

Both scripts are **dry runs by default**: they print per-table counts and delete
nothing. Deleting needs `--yes` **and** `--confirm <same slug or id>`, and they refuse
to touch the database named in `.env` unless `--i-know-this-is-prod` is also passed.

```bash
npm run offboard -- alder-demo                                  # counts only
npm run offboard -- alder-demo --yes --confirm alder-demo --i-know-this-is-prod
npm run delete:lead -- 3f2a1c9e-…                               # counts only
npm run delete:lead -- 3f2a1c9e-… --yes --confirm 3f2a1c9e-… --i-know-this-is-prod
```

Deletion order (children first, so a part-way failure is visible):

1. `public.lead_events`, `public.review_feedback`, `private.lead_financials`
2. `public.leads`
3. `public.business_chats`
4. `public.bind_codes`
5. `public.businesses`

`leads.business_id` has **no** `on delete cascade`, so removing a business by hand
would fail while its leads exist — that is why the order above matters. Every
statement filters by `business_id` or the slug's id; no other business is touched, and
the offboard dry run prints how many other businesses exist before and after.

Test debris from the suites can be swept with `scripts/sweep-demo-leads.mjs` (also a
dry run; `--before`, `--include-suite`, `--include-nojs`). It never touches a lead that
has a `review_token`.

## 2b. The operator and the owner

Two roles, and they never mix.

- **The operator** is you. One private chat: `OPERATOR_CHAT_ID`, falling back to
  `TELEGRAM_CHAT_ID` when the newer variable is unset. `OPERATOR_EMAIL` is the
  email fallback for the daily alarm. Operator-only content — the redirect
  warning, aggregate numbers, business slugs, "no phone connected" — goes only
  there, whatever a business's status is. A `demo` business is a lifecycle
  state, not an audience.
- **The owner phone** is the oldest connected phone of a business. It is the only
  one that may `/invite` or remove a phone. Every phone keeps alerts, the alert
  buttons and `/leads`.

Operator commands work only in the operator chat, and there are four:
`/businesses`, `/invite`, `/help` and `/id` (`/operator` still answers as an
alias of `/help`). The operator keyboard is one row, `Invite` then
`Businesses`. Anything else typed there, including the retired `/code` and
`/phones` and the owner's `/leads`, `/recipients` and `/remove_lead`, gets one
line that points to `/help`. A button labelled `Code` or `Phones` on a
keyboard the chat was sent earlier still opens the invite list and the
business list. A client who types an operator command gets the same reply as
for any unknown text, so the commands are not discoverable. `/id` works in
every private chat: it is how you learn `OPERATOR_CHAT_ID` without a
third-party bot.

Register the menus with `npm run tg:commands` (owner commands as the default
menu, the operator commands as a chat-scoped menu). Telegram keeps a menu
until it is set again, so run it after every deploy that changes either list:
a deploy alone changes nothing on a phone. The script prints both lists:

```
default menu (every private chat): /leads, /invite, /recipients, /remove_lead, /status, /help
operator menu (operator chat only): /businesses, /invite, /help, /id
```

It needs `TELEGRAM_BOT_TOKEN` and a numeric `OPERATOR_CHAT_ID` where it runs
(the shell, `.env.local` or `.env`). Without `OPERATOR_CHAT_ID` it sets the
default menu only and prints `OPERATOR MENU NOT UPDATED: …`; the operator chat
then keeps whatever menu it had, old commands included. `npm run
tg:commands:info` prints both live menus and either `operator menu is up to
date` or `OPERATOR MENU IS OUT OF DATE`. If the chat still shows the old list
after a successful run, close and reopen it in Telegram.

## 3. Add or remove a phone

**Add (client).** The main phone sends `/invite`. The bot mints one single-use
code for **that chat's business** and replies with a tappable deep link
(`https://t.me/<bot>?start=<code>`) plus the plain code. The second phone taps the
link and presses Start; it becomes a second `business_chats` row and receives every
alert from then on. If `getMe()` is unavailable the message falls back to
`/start <code>` with real line breaks and the function logs `bot_username_unavailable`.

**A bind code is a key.** It is single-use, expires 24 hours after it is minted, and
whoever holds it can attach their Telegram account to the business's alerts. Never
put one in a screenshot, a public chat, a ticket or a shared document — send it to the
one person who needs it, in a private message. If a code may have leaked, do not wait
for it to expire: mint a new one and remove the unexpected phone with `/recipients`
(or ask the operator to). `npm run bind -- <slug>` mints a code from the command line
with the same rules.

Caps (env-overridable, `RECIPIENTS_MAX` / `INVITES_MAX`):

- 5 bound phones per business, 3 unused live invites per business;
- `/invite` itself is limited to 5 per chat per hour and fails closed (no reply).

**Add (operator).** `/invite` in the operator chat opens a list of the served
businesses (five a page, a number button per row, Newer / Older only where
they lead somewhere). A number, **Invite** on a business's screen and
`/invite <slug>` follow the same rules, read from the database on every tap:

- **No phone connected.** One invite is created and shown as two messages. The
  browser message becomes `Code for <slug>: <code>`, `Expires in 24 hours. The
  next message is for the client — forward it as it is.`, with **Back**. The
  next message is new and is the only one to forward: "Tap here to connect
  your lead alerts on Telegram, then press Start." (the link is under the
  words, no address is visible), the fallback line, and the code on its own
  line. It names no business and holds nothing meant for you. If it cannot be
  sent, the first message says so and repeats the code.
- **A phone is connected.** Nothing is created. The message becomes
  `<Name> · Already connected · N phone(s)` with **Replace phone** and
  **Back**. Adding a phone to a connected business is the owner's own
  `/invite`; the operator has no button for it.
- **Suspended.** One line, `<Name> is suspended. Reactivate it first.`, and
  **Back**.

The code is the same single-use, 24-hour code; a new one cancels that
business's older unused ones (the first message says how many); the limit is
10 per business per hour.

**Replace phone (operator).** For a client who lost the phone, changed number
or handed the business over. **Replace phone** asks first and says what
happens; **Cancel** goes back. **Confirm replace** does this, in this order:

1. creates the new invite. If that fails (the hourly limit, the database) the
   screen says so and **no phone is removed**;
2. expires every other unused invite of that business, so an old link is dead;
3. removes every phone of that business in one statement;
4. sends each removed phone one message, "Your access to lead alerts for this
   business was ended by support.", which also takes its keyboard away. A
   message that cannot be delivered is counted and blocks nothing;
5. shows the two invite messages; the first also says `N phones removed`.

The business status does not change. Until the new phone connects, Telegram
alerts are off; leads are still saved and emailed. The first phone to use the
new invite is the main phone. A removed phone is an unconnected chat: the bot
answers it "This chat isn't connected yet." and its old buttons do nothing. A
second **Confirm replace** answers "Already replaced." and changes nothing.

**Lost or stolen phone.** The owner removes it: `/recipients`, Remove on that
row, confirm. The code that phone held is already used; the owner mints a new
one with `/invite` for the replacement. If the phone may still have the chat
open, remove it first — the binding is the authorisation. The operator does
not remove a single phone. If the lost phone IS the owner phone, or the only
one, use **Replace phone** (above): it removes every phone of the business and
gives you a new invite for the client. To stop everything at once instead,
Suspend the business (below).

**The business browser (operator).** `/businesses` is one message that is
edited in place: five businesses a page as `Name · Status · N phones`, a
number button per row, and Newer / Older only where they lead somewhere. A
number opens the business:

```
Alder Roofing
Demo · alder-demo

Telegram: Connected
Phone 1 · main phone
Phone 2 (Van)

Leads: 7 total · 3 in the last 30 days
Last lead: 2d ago
Billing: not tracked
```

The status is Demo, Active, Suspended (`paused` in the database) or Terminated
(`churned` in the database). `Telegram: Not connected` has
no phone lines under it. The lead numbers come from two queries (a count
with the newest `created_at`, and a count since 30 days ago): the only lead
column read for this screen is that one timestamp, and `Last lead` is left
out when there are none. The last line is the billing line (see **3b.
Billing and the service lifecycle**). Under it: **Suspend** and **Leads**,
then **Extend 30 days** and **Invite**, then **Terminate**, then **Back**. For
a suspended business: **Reactivate** and **Leads**, then **Extend 30 days**
and **Terminate**, then **Back**, and a `Held leads: N` line when leads came
in meanwhile. For a terminated business: **Reactivate** and **Leads**, then
**Extend 30 days**, then **Back**.

**What the operator can see of a lead.** **Leads** is read-only and minimal:
every row and every card shows only the service, the status and the age of the
lead. The customer's name, phone, email, address, ZIP, notes and any other
free text are never shown in the operator chat and are not read from the
database for it. The allowed fields are one constant, `OPERATOR_LEAD_FIELDS`
in `lib/content.js`; showing the name later is one word added there.

**Suspend (operator).** Switches one business off, after one confirmation.
The status is set to `paused` in one statement; then every connected phone
gets the suspension notice ("Your service has been suspended by support", the
`/status` hint and the **Contact support** link) with its keyboard reduced to
one button, **Status**, and the owner email address gets the same words.
A notice or an email that fails is counted ("1 notice failed"), alerts this
chat, and never undoes the suspension. Nothing is deleted: phones, invites,
leads and events stay as they are. While a business is suspended:

- the website form keeps accepting requests and **holds** them: each one is
  stored complete with `held_at` set, the visitor is told the request was
  saved and to call, and gets no auto-reply;
- the owner gets one short notice per held lead with no detail of it (at most
  20 an hour) and one count-only email a day; no lead alert, no lead email;
- every phone keeps `/status` and the **Status** button; every other command,
  keyboard press and button answers with the reason and the support link and
  shows no data (`/id` still answers); free text gets that answer at most
  three times an hour;
- no new phone can connect: the invite is handed back unused and works again
  after reactivation;
- review links of that site answer 404; the daily digest and the daily
  self-check skip the business.

A second tap on Suspend changes nothing and tells nobody. A request that was
already past the tenant check when the status changed is still delivered.

**Terminate (operator).** One confirmation, from an active or a suspended
business. The status is set to `churned`; the owner is told; the website form
answers "not available" (HTTP 410) and stores nothing; the phones keep
`/status` only. **Nothing is deleted**: Extend or Reactivate puts the business
back exactly as it was. Deleting a business is the offboard script (section
2), never a button.

**Reactivate (operator).** One tap on a suspended or terminated business sets
the status to `active` (a business that was `demo` before comes back as
`active`, not `demo`) and tells every connected phone "Your service is active
again." with its own keyboard and the number of leads that were held. Those
leads are ordinary leads from that moment: `/leads` shows them. Reactivating
is not paying: it does not change `paid_until`, so a business whose paid
period is over is suspended again by the next daily runs. Use **Extend 30
days** when the customer has paid.

If the phone list cannot be read when you press Suspend, Terminate or
Reactivate, nothing changes and a toast says so. Press it again.

Buttons of messages sent before Suspend existed (the old Terminate and Confirm
terminate, which deleted data; the old `/phones` and Remove Phone screens) answer "That screen expired. Here
is the current screen." and change nothing. A button of the old `/code` picker
follows the invite rules above, as a pick from the first page of the list.

## 3b. Billing and the service lifecycle

Billing is a date, not a payment system. Money arrives outside this system
(bank transfer, cash, a link you sent); you record it with one button. There
is no payment-provider code yet.

Every duration below is one constant in `lib/lifecycle-config.js`. Change it
there and the rules, the screens, the notices and the emails follow.

### The timeline

`D` is the business's `paid_until` (UTC). `paid_until` empty (NULL) means the
business is **not billed**: nothing in this section ever touches it. A `demo`
business is never enforced either.

| When | State | What works | Notice sent (once) |
|---|---|---|---|
| before D - 3 days | paid | everything | none |
| D - 3 days | due soon | everything | renewal reminder |
| D | grace (5 days) | everything | overdue notice |
| D + 4 days | grace, last day | everything | final warning |
| D + 5 days | **suspended** (10 days) | `/status` only; the form holds new leads | suspension notice |
| D + 10 days | suspended | the same | termination warning |
| D + 15 days | **terminated** | `/status` only; the form says "not available" | termination notice |
| D + 15 days, for 60 days | terminated, data kept | nothing | none |

Every notice goes to every connected phone and to the owner email. Each one
ends with a **Contact support** link in Telegram (the address is
`SUPPORT_TELEGRAM_URL`) and with "Reply to this email and we will help." in
email (Reply-To is `OPERATOR_EMAIL`).

**Nothing is deleted, ever, by this code.** "Terminated" is the status
`churned` and a flag; the business, its phones and its leads stay in the
database. The 60 days (`RETENTION_DAYS`) are a promise to the customer, kept
by hand: to delete a terminated business after that time, use the offboard
script in section 2. There is no purge job.

### The billing line

The business screen in `/businesses` says which state it is in:

```
Billing: not tracked                                  not billed
Paid until: Dec 14                                    paid
Paid until: Dec 14 · due in 3 days                    due soon
Overdue since Dec 14 · suspends Dec 19                grace
Overdue since Dec 14 · suspends today                 grace, last day
Suspended since Dec 19 · terminates Dec 29            suspended
Terminated Dec 29                                     terminated
Paid until: Dec 14 · not enforced                     a demo business
Billing: unavailable                                  migration 0006 not applied
```

A suspended or terminated business also shows `Held leads: N` when leads
arrived while it was off.

### Record a payment (Extend 30 days)

Make sure the status is `active` (a `demo` business is never enforced), open
the business in `/businesses`, press **Extend 30 days**, then **Confirm**.
The question shows the exact date (`Extend <Name> to Dec 14?`). 30 days are
added to `paid_until` when the business is still paid, and counted from now
when it is overdue or was never billed, so a late payment is not eaten by the
days already missed.

Confirm sets the date and clears the warning stage. If the business was
suspended or terminated, for non-payment or by hand, the button also switches
it back on: every phone is told, keyboards come back, and the leads held
meanwhile become visible (`Alder Roofing paid until Dec 14 · reactivated`).
The question says so before you confirm. To record a payment and keep a
business off, press Suspend again afterwards.

The date travels inside the Confirm button, so a double tap answers `Already
extended.` and changes nothing. To add 60 days, press Extend twice.

### Suspend, Terminate, Reactivate by hand

| Button | From | What it does |
|---|---|---|
| **Suspend** (asks first) | active | status `paused`; the owner is told "suspended by support" |
| **Terminate** (asks first) | active or suspended | status `churned`; the owner is told; nothing is deleted |
| **Reactivate** (one tap) | suspended or terminated | status `active`; the owner is told, with the count of held leads; `paid_until` is not changed |

A manual suspension has no countdown: it stays until you press Reactivate.
If you reactivate a business whose `paid_until` is more than 5 days in the
past, the next daily run suspends it again; press Extend instead.

If the phone list cannot be read at that moment, Suspend, Terminate and
Reactivate change nothing and say so: try again. Extend is different on
purpose. A recorded payment always switches the service back on; you get an
alert that one notice could not be delivered.

### What a suspended business sees

- **The bot.** Every phone keeps one command, `/status`, and one button,
  **Status**. Anything else is answered with the reason, the termination date
  and the support link. No lead data is shown.
- **The website form.** It still accepts requests. Each one is stored
  complete and marked held (`leads.held_at`). The visitor reads "Your request
  was saved, but this business can't respond through this form right now. For
  the fastest help, please call them directly." The visitor gets no
  auto-reply.
- **The owner.** One short Telegram notice per held lead, with no detail of
  the lead (at most 20 an hour per business), and one email per day with the
  count only.
- **After reactivation.** The held leads are ordinary leads: `/leads` shows
  them, the reactivation notice says how many there are.

### What a terminated business sees

`/status` only, as above. The website form answers "This business isn't
accepting requests through this form right now. Please call them directly."
(HTTP 410) and stores nothing. Extend or Reactivate puts everything back.

#### Options for the site itself

Only option 1 exists today. The current code is form-only: a terminated host
still serves the full landing page, and only the form answers "not available".
The other two options are recorded here for a later decision, not implemented.

1. **Keep serving the site (today).** No build work and no running cost, but
   the site keeps advertising a business that is not accepting work.
2. **A neutral holding page per terminated host.** Now that the API resolves
   the tenant from `Host`, this needs a per-host branch in whatever renders
   the page. The HTML render does not resolve a tenant yet, so that branch
   does not exist.
3. **Redirect the host to the operator's contact page.** One rule to add, but
   the client's SEO is lost because the old pages stop answering.

### The daily job

It runs once a day inside the daily self-check (the 09:00 UTC cron; no extra
cron job) and reads only businesses that have a `paid_until` and whose status
is active, suspended or terminated. Demo and unbilled businesses are never
read. A business you suspended or terminated by hand is read but never
switched on by the job.

- A warning may go out up to one hour early (a daily cron fires anywhere
  inside its hour). A suspension or a termination never happens early: it
  happens at the first daily run at or after the exact moment.
- A business gets at most one billing notice per UTC day. Running the job
  twice on one day sends and changes nothing the second time.
- A notice is recorded as sent only when it reached somebody, or when there
  was nobody to tell (no phone and no owner email). A notice that reached
  nobody is tried again the next day and you are alerted. A failed notice
  never delays a suspension or a termination.
- A business that paid while it was suspended for non-payment, but was not
  switched on (for example the date was set by SQL), is restored by the job.

When the run did something you get **one** Telegram message in the operator
chat (email when Telegram refuses it): who was suspended, terminated,
restored, warned, who could not be told, who is overdue and who is due soon.
Business names only.

To run it by hand: `curl -H "x-health-secret: $HEALTH_SECRET"
https://<host>/api/billing` (the answer is counts only).

### The notice log

Every owner notice is recorded in `public.business_events` (migration 0007):
one `expected` row before anything is sent, then one row per phone and per
email with `sent`, `failed` or `skipped`. The table holds fixed words only:
the notice type, the channel, an error class, the mail provider's message id.
No text, no address, no chat id.

- A send that fails alerts the operator chat at once: business name, notice
  type, channel, error class.
- Once a day, after the billing job, the self-check looks for a notice that
  was started and never finished (an `expected` row with nothing after it:
  the function was stopped half way, or the log could not be written). You
  get one message, `Owner notices with no recorded outcome`, with the business
  names and notice types. Open each business and check that the owner knows.

To read the log for one business:

```sql
select created_at, type, channel, status, error_class
from public.business_events
where business_id = (select id from public.businesses where slug = '<slug>')
order by created_at desc limit 50;
```

### Turn billing off for one business

```sql
update public.businesses
set paid_until = null, billing_warning_stage = 0, suspended_for_billing = false
where slug = '<slug>';
```

If the job had already suspended or terminated it, press **Reactivate**
afterwards.

### What stays manual until the payment-provider stage

Receiving the money; pressing Extend 30 days for each payment; choosing any
period other than 30 days (set `paid_until` by SQL); refunds and prices (the
system stores no amount); deleting a terminated business after the retention
period. The seam for a payment provider exists: `applyPayment()` in
`lib/billing-ops.js` is what the button calls and what a payment webhook will
call. Its contract is in the code: idempotent, never shortens a paid period,
clears the warning stage, restores a business that was off for non-payment.

### Payment-provider stage design notes

Not built. These are the decisions the webhook will be written against, so the
provider work does not have to invent them under time pressure. The reference
for the provider itself is `docs/WHOP.md`; the seam in the code is
`applyPayment()` in `lib/billing-ops.js`.

- **`paid_until` comes from the provider's period end**, not from the moment the
  webhook arrives. A delivery that is minutes or hours late must not shorten or
  extend what the customer paid for. When the payload carries no period end, the
  webhook does not guess: it logs and waits for the next delivery.
- **Idempotency is keyed by the provider's delivery id.** Store the id before
  acting on it, and treat a second delivery with the same id as a no-op that
  still answers 2xx. `applyPayment()` is already idempotent for the same period
  end, so a double tap and a double delivery reach the same state.
- **Answer 2xx within 5 seconds.** Do the minimum inside the request (verify the
  signature, record the delivery id, apply the payment) and let anything slower —
  email, the Telegram notice, the notice-log row — run after the response. A
  provider that waits too long retries, and a retry is harmless only because of
  the delivery id.
- **Deliveries repeat and can arrive out of order.** Never assume the newest
  event is the last one received. Every decision is made from the payload's own
  effective date, and the state on the row is compared to it, not to the order of
  arrival. A duplicate payment notice is not a second payment.
- **The provider's own cancellation does not terminate a business by itself.**
  It records the fact; Alder's clock decides the status. Grace, suspension and
  termination are the durations in `lib/lifecycle-config.js` and nothing in a
  webhook shortens them.
- **A refund means Terminate.** The business is `churned`, displayed as
  "Terminated", and the everyday flow is the one in §3b: the form answers 410 and
  stores nothing, the data stays for the retention window. Reason recorded as
  `manual`, because nobody was reached about money — the refund already happened.
- **A chargeback means suspend.** Money is contested, not returned: the service
  stops now (`status = 'paused'`, `suspended_for_billing = true`) and the held
  lead flow applies. It is a billing suspension, so the owner sees the
  "Renew to see them." sentence and can reactivate by paying again; if the
  chargeback stands, the operator terminates by hand.

### Migrations this needs

- `0006_business_billing.sql`: the billing columns. Without it the business
  screen says `Billing: unavailable`, Extend answers that billing is not
  available and the daily job skips itself.
- `0007_lifecycle.sql`: `leads.held_at` and `public.business_events`. Without
  it everything above still works, with two losses: a held lead is stored
  without its mark (so the held count reads 0), and the notice log and its
  daily audit are skipped. Apply both with `npm run db:apply`, or paste the
  files in the SQL editor in order.

**Remove.** `/recipients` lists every phone as "Recipient 1, 2, …" (or the stored
`business_chats.label` when set) with one **Remove** button each. Removing asks once;
the last remaining phone cannot be removed. A second tap on an already-removed row
answers "already removed" and changes nothing.

A chat belongs to exactly one business. Sending a code from a chat that is already
bound elsewhere answers "You're already connected" and leaves the binding alone;
the code stays unused. An unbound chat can also paste the code as plain text —
spaces, hyphens and case are ignored — and gets one identical answer for invalid,
expired, used and unknown codes.

**Delete chat vs Block.** Deleting the chat in Telegram removes it locally only:
the binding stays, and pressing Start again answers "You're all set". Blocking the
bot stops delivery; the next alert records `tg_failed` with status 403 and the
operator gets one notice per business per day. Telegram also sends
`my_chat_member` when the bot is blocked, which produces the same notice
immediately.

## 4. Reading the alerts

| Where | What it means | What to do |
|---|---|---|
| Alert check, `⚠️ Needs attention` / "N alerts could not be delivered" | `tg_failed` over 24 h for **that business** is non-zero | open `/api/health` and read `last_24h`; §5 |
| Alert check, "N alert emails to you did not go out" | `email_owner_failed` for that business | check Resend and the sender domain; §5 |
| Alert check, "N confirmation emails to a customer failed" | `autoreply_failed` for that business | the customer got no acknowledgement; §5 |
| Alert check, "N review requests to a customer failed" | `review_request_failed` for that business | the owner can retry from the bot; §5 |
| Alert check, "⚠️ Test mode is on …" | `MAIL_REDIRECT_TO` is set while `VERCEL_ENV=production` | remove it (§7). Demo businesses only — a client never sees this line |
| Digest section `⚠️ Needs attention` | the same four kinds, same 24 h window, for that business | same as above |
| `/api/health` → `mail_redirect_active: true` | `MAIL_REDIRECT_TO` is set, in **any** environment | if production, remove it |
| `/api/health` → `webhook_secret_set: false` | `TELEGRAM_WEBHOOK_SECRET` missing → `/api/tg` answers 503 | set it (§6) |
| `/api/health` → `salt_set: false` | `IP_HASH_SALT` missing → `/api/lead` answers 500 | set it (§6) |
| Log line `owner_alert_fallback` | both owner channels failed; at least one eligible channel got one retry, including owner email after a 5xx | check Telegram and Resend |
| Log line `autoreply_capped` | the business hit `AUTOREPLY_DAILY_CAP` (default 40) | expected on a flood; raise the cap or the plan |
| Log line `mail_redirect_active` | first send in production with a redirect configured | remove the redirect |
| Log line `lead_notify_claim_failed` / `lead_notify_release_failed` | the claim could not be read or cleared; notification proceeds without that claim, but delivery is not guaranteed | usually a Supabase blip; repeated lines mean the `rate_limits` table is unreachable |
| `tg_failed` with `meta.abandoned` | the notification round hit its 6 s deadline; N phones never answered and were left to their own 3 s timeout | phones are slow or many; see §4c |
| `email_owner_failed` with `meta.status: "timeout"` | Resend did not answer inside the 3 s send budget — **unknown**, not failed | no retry in that round; a same-lead replay retries email only if no `email_owner_sent` event exists (§4c) |

**Who receives what.** Every message carries only the counts of the business that
receives it. A business with status `demo` is the operator's own: it also gets the
redirect warning and, in a clearly separated last line, the setting name. A business
with status `active` is a client: it hears from us only when one of its own sends
failed, and it never sees operator text. Two businesses that share an owner email get
one message per business, even when two businesses share an inbox; suppressing the
second would hide that business's own counts. The responses report `sent`, `emailed`,
and failure/skip counts; there is no `deduped` response field.

`/api/health` and `/api/selfcheck` and `/api/digest` and `/api/billing` all answer **503 when
`HEALTH_SECRET` is unset**, even if `CRON_SECRET` is set. `/api/health` takes
`x-health-secret`; the other three also accept `Authorization: Bearer $CRON_SECRET`.
The daily billing job (section 3b) runs at the end of `/api/selfcheck`; `/api/billing`
runs the same job on its own and is not scheduled.

## 4b. Rate limits are fixed windows

`hit_rate_limit()` counts inside a fixed bucket (`floor(epoch / window)`), not a
sliding window. A burst that straddles a boundary can therefore get up to twice
the limit in that instant — 10 operator invites before the hour turns, 10 after.
That is accepted for the operator-only `/invite` because the
operator is trusted and the cap is there to stop a runaway loop, not an attacker.
The bind and invite paths use the same primitive; there the cap is one of several
guards, and the code itself is single-use.

## 4c. How one lead is announced

The order is fixed: **save first, notify second**, and nothing after the save can
change the HTTP response. Within that:

1. **The lead is stored**, then a best-effort per-lead claim is taken (`rate_limits`,
keyed by lead id). This is a fixed 10 s bucket, **not a hard lock or a 10 s
lifetime**. A claim may match for nearly 10 s or almost 0 s. For two overlapping
calls whose claim attempts are `d` seconds apart (`d < 10`), uniform bucket-edge
timing gives approximately `d / 10` chance that they land on opposite sides and
both win (100 ms → 1%; 1 s → 10%). The replay's post-claim recheck catches a
success already written to `lead_events`; it cannot catch another request that
has claimed but not yet written an outcome. The claim is released in `finally`
and fails open. A durable cross-bucket claim needs the proposed outbox/locking
work, not wording that implies certainty this primitive cannot provide.
2. **A replay announces only what is missing.** With no confirmed delivery it
   re-drives the notification from the stored row and writes a missing `created`
   event. If no `email_owner_sent` event exists, one owner-email attempt is allowed
   per replay. When Telegram delivered and all phones are confirmed, the replay sends
   email only. Telegram events record per-chat outcomes in `lead_events.meta` as
`chat_outcomes: [{ chat_hash, delivered }]`; `chat_hash` uses the existing
IP-hash salt and SHA-256 helper with a Telegram namespace. Raw chat ids are never
stored. If three phones succeeded and two failed, fallback and replay target only
those two; when owner email also failed, replay may retry that missing email once
with the same key. Same-round `missing_env` / `no_verified_sender` failures are not
retried immediately, but a later replay does retry after configuration is fixed;
`blocked_test_mode` stays suppressed because the test interlock is deliberate.
3. **Both channels run at once**, and Telegram fans out to every eligible bound
phone with `Promise.allSettled`. A 400 response to a message with a keyboard gets
one retry without buttons. Successful phones are excluded from a partial retry.
4. **One 6000 ms deadline covers the owner round**, shared by primary and fallback;
the per-send timeout is 3000 ms (`lib/outbound.js`). `api/lead.js` declares
`maxDuration: 30`, comfortably above that work and far below the owner's verified
300 s project setting (Fluid Compute, Hobby, iad1). There is no code evidence for
an `api/tg.js` override, so it has none. Every function entry keeps
`includeFiles`. A phone abandoned by the deadline is recorded with
`meta.abandoned`; its own request still has the 3 s timeout.

   **Worst-case configured server timeline for `POST /api/lead`:** request parsing
and validation (no explicit budget) → IP/business rate-limit RPCs (no explicit DB
deadline) → business lookup (no explicit DB deadline) → insert and duplicate
lookup concurrently (no explicit DB deadline) → `created` event and claim
(no explicit DB deadline) → post-claim replay recheck when applicable
(no explicit DB deadline) → primary owner email + Telegram (within the shared
6000 ms owner deadline) → eligible fallback within that same 6000 ms, not another
6000 ms → customer auto-reply (up to 3000 ms) → claim release (no explicit DB
deadline). Configured outbound work is therefore at most about **9 s**, but total
request time is **not strictly bounded in code** because Supabase calls have no
per-call deadline. The 30 s Vercel ceiling limits a hung invocation; it does not
promise a response by 30 s.
5. **Timeouts and Resend 5xx responses follow different retry rules.** A timeout
   may mean Resend accepted the email but its answer was lost, so it gets no retry
   in that round. When both owner channels fail, a Resend 5xx gets one fallback
   attempt with the same key and byte-identical payload; a replay can make at most
   one email attempt when no `email_owner_sent` event exists. Telegram's definite
   failures can receive one fallback attempt while less than 2000 ms of the owner
   round have elapsed. Resend `concurrent_idempotent_requests` is unknown and is
   not retried immediately. A payload-mismatch 409 is a fixed-key programming or
   configuration error, so an identical retry cannot repair it.
6. **One idempotency key per lead per channel.** Retryable primary and fallback
   owner emails have byte-identical subject, HTML, text, attachments and headers
   under `<leadId>:owner`. Within Resend's 24 h window, the same key and same payload
   returns the **original response without another send**. A 409
   `concurrent_idempotent_requests` means the original is still in progress (outcome
   unknown); a 409 `invalid_idempotent_request` means the key was reused with
   different content. Neither means delivered. Both are recorded as failures, with
   fixed log events `mail_idempotency_concurrent` or
   `mail_idempotency_payload_mismatch`.

    **ASSUMPTION — TEST FAKE ONLY:** `tests/fakes.mjs` stores and replays a 5xx
    response. Resend documents that same-key, same-payload replays return the
    original response without another send, but does not say whether 5xx responses
    are stored. The application retries once with the same key because an accepted
    request is protected by that idempotency behavior and a retry may recover an
    unaccepted alert. The retry uses the existing `email_owner_failed` event; no
    schema change is needed.

    | Resend's 5xx behavior | What the same-key retry does |
    |---|---|
    | Failure is stored and replayed | Returns the original 5xx; no new send. The alert may remain undelivered. |
    | Failure is not stored | Resend can process the same-key request again and deliver the alert. |

    The test fake's stored-5xx behavior remains an explicit assumption, not a
    verified Resend guarantee. The key/payload guarantee for an accepted request
    is documented; persistence of a failed response is not.

**Finding a lead that was stored but never announced** (the case the replay above
repairs):

```sql
select l.id, l.created_at
  from public.leads l
 where l.business_id = '<business-id>'
   and not exists (select 1 from public.lead_events e
                    where e.lead_id = l.id
                      and e.kind in ('tg_sent', 'email_owner_sent'));
```

Re-posting the same `idempotencyKey` to `/api/lead` is the supported repair: it
re-drives missing delivery and cannot store a second lead. For partial Telegram
delivery, use the per-chat hashes in recent `tg_failed` / `tg_sent` events rather
than assuming the SQL above finds the lead.

## 4d. The form on the visitor's phone

The modal posts to `/api/lead` with a **12000 ms abort timeout per attempt**. Keep
that number: configured outbound work is about 9 s, while 30 s would make a
visitor wait unnecessarily for a stuck database, whose calls have no explicit
deadline. A browser timeout does not cancel server work already underway. On **no
answer at all** (timeout, dropped connection, DNS) the form retries exactly once
after 700 ms under the same idempotency key, so the server cannot store a second
lead. An HTTP error is final: it shows field errors (400) or the generic panel
(5xx).

With `navigator.onLine === false` the form posts nothing and says "You're offline"
immediately. Pressing send twice within 30 s shows the "already sent" panel rather
than a failure, because the server dropped the duplicate on purpose. If the
visitor edited fields before that second press, those new values were **not**
sent, so the recap is hidden in this state instead of displaying them as received.

**Closing the form.** Three things close it: the **X** (32 px, with a 44 px
press area), **Escape**, and the **Close** button of the last panel. A click
or a tap on the dimmed area around the form does nothing, so nobody loses a
half-filled form by touching beside it. Closing with the X keeps the answers
until the page is left.

**The four service options** are the four services of the services section:
the form (and the no-JavaScript form) print the same client keys (`services3`,
`services5`, `services7`, `services9` in `clients/<slug>.json`), so the two
can never say different things. The short line under each option is
`footer9` to `footer12`. The stored values did not change (`replacement`,
`storm`, `repair`, `unsure`); the fourth is now shown to the visitor as "Free
roof inspection" and to the owner as "Roof inspection".

Two answers are neither "sent" nor "failed". A suspended business holds the
request (HTTP 200 with `held: true`): the visitor reads that it was saved and
that calling is faster. A terminated business accepts nothing (HTTP 410 with
`unavailable: true`): the visitor reads that the form is not available. Both
panels keep the **Call** button and promise no reply (section 3b).

### What the visitor sees

| Failure | Visitor | Owner | Operator |
|---|---|---|---|
| Save fails | HTTP 500 generic failure panel; no success recap | Nothing new | `lead_insert_failed`; no local buffer exists |
| Save succeeds, both owner alerts fail | HTTP 200 success panel: the request was stored | No alert unless a later same-key replay succeeds | Failure events and `owner_alert_fallback` when eligible; replay can repair missing delivery |
| Business is suspended | "Your request was saved." and the Call button; no recap, no auto-reply | A short notice with no details; a count by email once a day; the lead after reactivation | `Held leads: N` on the business screen |
| Business is terminated | "This form is not available." and the Call button; nothing stored | Nothing | Nothing |
| Browser is offline | Immediate "You're offline"; no POST | Nothing new from that attempt | No server event because no request reached it |
| Attempt times out, then visitor retries | One automatic retry after 700 ms with the same key; success or generic failure according to that answer | At most one stored lead; missing alerts may be re-driven | First attempt may still finish server-side; events reveal actual outcomes |

**A visitor can see a bot-decoy success without storage**: the honeypot and
under-2-second checks deliberately return `{ ok: true }` before insertion
(`api/lead.js:131-139`). For a genuine validated submission, success is returned
only after `insertLead` succeeds or finds the same stored idempotency key
(`api/lead.js:264-282`, `api/lead.js:321`, `api/lead.js:349`). Notification failure
never changes that stored-lead success into a failure.

## 5. Incident playbooks

**Telegram down, or the bot token revoked.**
Symptom: `last_24h.tg_failed` climbing, `tg_sent` flat, the owner gets the email
fallback instead (or `owner_alert_fallback` in the logs).
Check the token: `node scripts/tg-webhook.mjs info` prints `ok`, `status` and the
webhook **host** only. If Telegram rejects the token, create a new one in BotFather
(`/revoke`), then follow §6 for `TELEGRAM_BOT_TOKEN` and re-register the webhook.

**Webhook registration: `set` vs `info`.**
`node scripts/tg-webhook.mjs set https://<host>/api/tg` registers the URL, the
`TELEGRAM_WEBHOOK_SECRET` header, and `allowed_updates` = `message`,
`callback_query`, `my_chat_member`. It also sends `drop_pending_updates: true`:
Telegram discards everything it queued while the old registration was in place, so
a tap or a message sent during the switch is lost by design. Do not run it while
someone is mid-flow, and do not expect `/start` sent a minute earlier to arrive
afterwards. `delete` drops pending updates too.
`node scripts/tg-webhook.mjs info` prints the registered host, `status`,
`pending_update_count`, the last error Telegram saw, and the allowed updates it
actually has. If `my_chat_member` is missing from that list, the blocked-bot
notice never arrives; re-run `set`. Neither command is called by the tests: the
suite uses a loopback fake.

**Resend quota hit.**
Symptom: `email_owner_failed` / `autoreply_failed`, and Resend returns 429.
The free plan allows 100 emails a day. Each lead costs up to two: one owner alert
(never capped) and one auto-reply (capped by `AUTOREPLY_DAILY_CAP`, default 40), so
the worst case at the default is 80 a day. Options: raise the Resend plan, or lower
`AUTOREPLY_DAILY_CAP` — the owner alert is deliberately never capped, so the cap only
bounds the customer half.

**Supabase down or paused.**
Symptom: every endpoint 500s; `/api/health` returns 500 with `health_query_failed`;
`/api/lead` answers 500 and logs `lead_insert_failed`, so the customer sees the
failure — the lead is **not** stored, and there is no local buffer to replay.
Free Supabase projects pause after a period of inactivity — restore the project in the
dashboard, then confirm `/api/health` returns 200 and `last_24h.created` is sane.
Nothing in the app buffers leads while the database is unreachable.

**Webhook secret rotated, or Telegram starts returning 401.**
Every update is rejected until the registered secret matches. Set the new
`TELEGRAM_WEBHOOK_SECRET` in Vercel, redeploy, then re-register so Telegram starts
sending the new header:

```bash
node scripts/tg-webhook.mjs set https://<host>/api/tg
```

**Leaked secret.**
Rotate the specific secret (§6), redeploy, and check the endpoint that uses it. A
leaked `SUPABASE_SERVICE_ROLE_KEY` is the worst case: rotate it in Supabase first, then
Vercel, then redeploy — the old key stops working the moment it is rotated, so expect a
short outage until the new value is live.

## 6. Rotating a secret

Every secret lives in two places at most: the Vercel project env (Production, and
Preview if previews should work) and the local `.env` / `.env.local` used by the
scripts and the test suite. Rotate in this order: provider → Vercel → redeploy →
verify.

| Secret | Change it in | Also | Verify | Breaks in between |
|---|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather `/revoke`, then Vercel env | re-register the webhook: `node scripts/tg-webhook.mjs set https://<host>/api/tg` | `node scripts/tg-webhook.mjs info` → `ok=true`; send `/help` from a bound chat | every send fails with 401 until the redeploy; `tg_failed` climbs |
| `TELEGRAM_WEBHOOK_SECRET` | Vercel env (and local `.env` for the script) | re-register: `node scripts/tg-webhook.mjs set https://<host>/api/tg` | Telegram delivers again; `/api/health` → `webhook_secret_set: true` | `/api/tg` answers 401 to every update; Telegram retries for a while, then drops |
| `HEALTH_SECRET` | Vercel env | — | `curl -H "x-health-secret: …" /api/health` → 200 | 503 if unset, 401 if the caller still has the old value |
| `CRON_SECRET` | Vercel env | — | the next scheduled run returns 200 (check Vercel logs) | the cron bearer is refused; `/api/selfcheck` and `/api/digest` answer 401 |
| `IP_HASH_SALT` | Vercel env | — | `/api/health` → `salt_set: true`; submit one lead | `/api/lead` 500s while missing; after a change every rate-limit key is new, so counters reset (no data is lost) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → API keys, then Vercel | — | `/api/health` 200 | every function 500s until the redeploy |
| `SUPABASE_ANON_KEY` | Supabase dashboard, then Vercel if any surface uses it | — | `tests/db-wall.test.mjs` still proves the anon wall | nothing user-facing (no client code uses it) |
| `RESEND_API_KEY` | Resend dashboard, then Vercel | — | `node scripts/live-smoke.mjs --live` | every email fails with 401; Telegram keeps working |
| `DATABASE_URL` | Supabase (session pooler URI) → local `.env` only | — | `npm run db:apply` connects | the migration and delete scripts stop; the functions do not use it |

`node scripts/live-smoke.mjs --live` sends one real Telegram message and one real
email. It refuses to run while `.test-mode` exists or either `*_API_BASE` override is
set, so it cannot be pointed at a fake by accident.

## 6b. Pre-launch checklist additions

- `OPERATOR_CHAT_ID` is set, and `/id` in that chat returns the same number.
- `OPERATOR_EMAIL` is set, or you accept that the daily alarm has no fallback.
- Every business's `owner_email` is an address **we control**. Lead alerts, the
  self-check and the digest all send there; once `MAIL_REDIRECT_TO` is removed, a
  placeholder address emails a stranger. `example.com` is reserved (RFC 2606) and
  must never survive to production.
- `npm run tg:commands` has been run since the last command change.
- `review_links_invalid` in `/api/health` is `0` (every demo/active business has
  an `https://` Google review link on an allowed host).

The full list for the first paying customer is `docs/PRE_LAUNCH_CHECKLIST.md`.

## 7. Post-merge checklist

1. **Set every variable in both scopes.** Vercel → Project → Settings → Environment
   Variables: Production **and** Preview. A preview deployment with a missing
   `SUPABASE_URL` or `HEALTH_SECRET` fails exactly like production would.
2. **Remove `MAIL_REDIRECT_TO`** from Production, then confirm
   `/api/health` → `mail_redirect_active: false`.
3. **Run `npm run tg:commands`** after the first deploy that adds a command. The owner
   menu is `/leads`, `/invite`, `/recipients`, `/remove_lead`, `/status`, `/help`, and the
   operator chat's own menu is `/businesses`, `/invite`, `/help`, `/id`; the script also sets the bot
   description and short description. Run it after any deploy that changes either menu (the
   operator menu lost `/code` and `/phones`), from a shell that has `OPERATOR_CHAT_ID`: without
   it the operator chat keeps its old menu and the script says `OPERATOR MENU NOT UPDATED`.
   `npm run tg:commands:info` prints both live menus and whether the operator one is up to date.
4. **Re-register the webhook** if this deploy adds an update type the bot has never
   received: `node scripts/tg-webhook.mjs set https://<host>/api/tg`, then
   `node scripts/tg-webhook.mjs info`. The `set` call drops updates Telegram queued
   while the old registration was live, and `info` must show `my_chat_member` in
   `allowed_updates` or the blocked-bot notice is silently never sent.
5. **Enable the digest** with `DIGEST_ENABLED=1` (it is off by default), redeploy, then
   `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/digest` → the body
   has `"enabled": true`. The first message goes out at the next 13:00 UTC run; until
   then the endpoint is the only way to see it. Leave it unset to keep the digest off.
6. **Apply the migrations** (`npm run db:apply`, or the SQL editor) to the test
   project first, then to production: `0006_business_billing.sql` and
   `0007_lifecycle.sql`. The code runs without them (the business screen says
   `Billing: unavailable`, the daily billing job skips itself, a held lead is stored
   without its mark), so the order of deploy and migration does not matter. Nothing is
   billed until you press **Extend 30 days** for a business.
7. **Read `/api/health`** once after the deploy: `webhook_secret_set` and `salt_set`
   must both be `true`, and `last_hour.created` tells you whether leads are arriving.

## 8. Known limitations

- **The digest uses the UTC day.** A roofer in America/Chicago gets "yesterday evening
  to this evening" labelled with the UTC date. There is no per-business timezone
  arithmetic; doing it properly needs a `digest_hour` column and an hourly cron (Pro).
- **Each Hobby cron job can run at most once a day.** Both scheduled jobs are daily.
  A more frequent expression fails the deployment rather than silently skipping runs.
- **The self-check runs at 09:00 UTC daily.** Before throttling, every invocation
  could repeat the operator Telegram alarm, including cron retries and manual calls.
  Operator alerts now claim each distinct business/failure, no-phone problem, and
  production mail-redirect problem once per 24-hour rate-limit bucket. Claim errors
  fail open; if both operator channels fail, the claims are released for a retry.
  The shared rate-limit RPC uses fixed database-clock buckets, so calls across a
  bucket edge can be less than 24 hours apart.
- **Digest claim errors favor delivery over deduplication.** `/api/digest` proceeds
  when its per-business `hit_rate_limit` call errors; if that run delivers and a later
  run can claim, the owner may see a duplicate digest. A failed claim call does not
  suppress the send. If both delivery channels fail, the handler clears the claim so
  a same-day retry can try again; if that clear also fails, the claim may remain and
  the owner may get no retry that day.
- **Tests use a separate Supabase project.** A suite run requires `TEST_ENV=1` and
  `.env.test`, and the runner refuses the production URL before starting. It verifies
  the canary landed in the test database and checks that it is absent from production.
  No production backup/reset/restore is part of the test workflow. See
  `docs/TEST_PROJECT.md`.
- **WhatsApp is not supported.** Its Business API needs a business account, is paid,
  and only allows free-form messages inside a 24-hour window opened by the customer —
  a lead alert arrives outside that window, so it would need pre-approved templates.
  Telegram has none of those constraints.
- **No queue for alerts.** If both Telegram and email fail for a lead, the lead is
  still stored and both failures are recorded as events, and a replay of the same
  idempotency key re-drives the notification. Nothing retries **later** on its own:
  after the in-request attempt and one fallback there is no further try. The design
  for a durable outbox is in `docs/proposals/notification-outbox.md`.
- **The exit code of a failed cron is only in the logs.** A self-check or drain run
  that fails is visible in the Vercel log and nowhere else. The external check that
  would catch it is proposed in `docs/proposals/uptime-check.md`.
- **A shared inbox gets one message per business.** Two businesses with the same
  `owner_email` each get their own counts; neither is de-duplicated or merged, because
  suppressing one would hide that business's only warning.
- **Nothing deletes a terminated business.** The 60-day retention period
  (`RETENTION_DAYS`) is a number in the documents and in the customer's terms.
  No job counts it and no job deletes: after the period, run the offboard
  script by hand (section 2). Until then a terminated business can be put back
  with one button.
- **Lifecycle notices follow the daily cron.** A suspension or a termination
  happens at the first daily run at or after its exact moment, so up to a day
  late and never early. A notice that reached nobody is tried again a day
  later, not sooner.
- **A held-lead notice is capped, a held lead is not.** Above 20 held leads an
  hour for one business the phones get no further notice in that hour; every
  lead is still stored, and the count in `/status` and on the operator screen
  is exact.
- **The self-check is per business but its window is global.** Each message counts the
  last 24 h for that business only, so two messages can cover slightly different
  windows if the run takes long enough to cross a second boundary. At this size it does
  not happen; it would at hundreds of businesses.

## 9. Reviewing a branch and test-project isolation

**Review artefacts.** For a branch that merged another branch, the `.diff`
(`git diff origin/main...<branch>`) is the review artefact: it applies with
`git apply --check` to a fresh worktree of `main`. The `.patch`
(`git format-patch`) is best-effort — `git am` cannot replay a merge commit, so
it stops there. Use the diff to review, the patch only for a linear branch.

Every suite must run with `TEST_ENV=1` and `.env.test`; `tests/run.mjs` compares the
resolved Supabase URL with `.env` and refuses production before it starts. The runner
also uses a temporary canary to verify the function and runner use the same test
project. If the canary is found in production, it deletes only that random canary lead
and aborts before any suite runs. Tests do not back up, reset, or restore production
business rows or chat bindings. See `docs/TEST_PROJECT.md` for setup and failure
handling.

## 10. Vercel storage

**Why it grows.** Vercel builds a deployment for every push to every branch. Each
deployment keeps its own copy of the output, so the bill grows with pushes, not with
how many domains point at the site. This project's output is about 125 MB, and
110.9 MB of that is six hero video files; a 10 GB allowance is roughly 70
deployments at that size.

**Where to see it.** Dashboard → the team → **Usage** → *Deployment Storage*, with a
per-project breakdown. The deployment list shows what each one holds.

**Stop the previews at the source.** `vercel.json` now carries:

```json
"git": { "deploymentEnabled": { "*": false, "main": true } }
```

Every branch is skipped; `main` still builds. This is the same mechanism as the
dashboard **Ignored Build Step** (`[ "$VERCEL_GIT_COMMIT_REF" != "main" ]`) and it
replaces it: keep one, not two. Once this is live, delete the dashboard step.

**Delete what is already there.** Project Settings → **Deployment Retention**: set
preview deployments to expire after a few days (or keep the last N). The current
production deployment is never deleted by retention, and neither is the one a
custom domain is serving — only previews age out.

**Hobby is not for paying clients.** The Hobby plan is for non-commercial use; a
site that takes money needs Pro. Pro bills Deployment Storage beyond the included
allowance at $0.10 per GB-month. Custom domains per project: Hobby 50, Pro
unlimited (soft limit 100,000).
