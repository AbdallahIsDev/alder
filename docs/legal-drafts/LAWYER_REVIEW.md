# DRAFT FOR LAWYER REVIEW

Internal index of review flags and proposed clauses. Not legal advice. Not for
customers. A lawyer who knows the law of the place where the owner and the
customers do business must review and adapt this before any customer signs.

Use it with `terms-of-service.md`, `privacy-notice.md` and
`data-processing-summary.md` in this folder. Those drafts say what the code
does; this file marks what the code does not decide. Every **[REVIEW FLAG]**
is a blank for the owner and the lawyer, not a promise already made.

Facts below come from `docs/OPERATIONS.md` (sections 2, 3, 3b and 8),
`docs/WHOP.md`, `SESSION_HANDOFF.md` section 7, and the constants in
`lib/lifecycle-config.js`. No secret values and no lead data appear here.

## 1. Leads captured while a service is suspended

**Fact.** "Suspended" can be triggered by late payment or by the operator. The
website form still accepts requests. Each request is stored in full and marked
with `leads.held_at`. The visitor is told it was saved and is asked to call;
no confirmation email is sent. The owner gets one short Telegram notice per
held lead with no name, phone or other detail (at most 20 an hour), and one
email a day with the count only. The operator's own screens show counts only.
On Reactivate or on **Extend 30 days**, every held lead becomes an ordinary
lead, the owner's `/leads` list shows it, and the notice says how many were
released. Nothing is deleted at any step.

**Proposed clause.** "If your service is suspended, our form still accepts
requests. We save each request but hide its details from you until the service
is active again. We tell you only how many arrived, without names, phone
numbers or notes. Visitors are told to call you instead of waiting for a
reply. When the service is restored, every held request appears in your
request list."

**[REVIEW FLAG]** Is saving a request with no reply acceptable, and for how
long? What happens to held leads if the service is never restored? Does the
visitor notice say enough about the delay? Is the count-only notice enough for
the business, or must it get the contact details at once?

## 2. What a suspended or terminated site shows

**Fact.** Today the whole landing page is still served in both states. Only
the form changes. While suspended, the form holds the request (section 1).
When terminated, the form answers "not available" (HTTP 410) and stores
nothing; the visitor is told to call. `docs/OPERATIONS.md` section 3b,
"Options for the site itself", lists three choices: (1) keep serving the
site, which is the only one built today; (2) a neutral holding page per
terminated host, which is **not built** — the HTML render does not resolve a
tenant yet; (3) redirect the host to the operator's contact page, which loses
the client's SEO. `SESSION_HANDOFF.md` section 7, fact 11, records the same
limitation.

**Proposed clause.** "While your service is suspended, your website stays
online and the form still accepts requests, which we hold. If your service is
terminated, your website stays online but the form stops accepting requests
and tells visitors to call you. We do not replace your website with a holding
page."

**[REVIEW FLAG]** The owner must choose one of the three options before the
first customer pays; the clause above states option 1. Is a site that keeps
advertising a business which is not taking work misleading? If option 2 or 3
is chosen later, who builds it, and how much notice is the business given?

## 3. Retention and export after termination

**Fact.** The retention period is 60 days (`RETENTION_DAYS`). Nothing in the
code deletes a business, its phones or its leads: termination is a status
change, not a deletion. The 60 days are a promise kept by hand. There is no
purge job. A copy is a database query a person runs by hand — there is no
export button. Deleting a business after the period is a manual run of the
offboard script; deleting one lead is a separate manual script.

**Proposed clause.** "We keep your data for 60 days after your service ends.
During that time you can ask us for a copy or ask us to delete it, and we do
this by hand. After 60 days we may delete it. We do not delete anything
automatically."

**[REVIEW FLAG]** "May delete" or "will delete"? What does the copy contain,
in what format, and within how many days of the request? Does asking for
deletion before 60 days end the service as well? Is a manual-only service
acceptable to promise in a customer contract?

## 4. Refund and chargeback

**Fact.** There is no payment integration and no amount stored anywhere in
the code. A refund rule is therefore a blank, not a behaviour. `WHOP.md`
section 4 says the seller, not Whop, decides refunds and chargebacks and bears
the $15 chargeback fee. `docs/OPERATIONS.md` section 3b has unbuilt design
notes only: a refund would mean termination, and a chargeback would mean
suspension until resolved. `terms-of-service.md` section 8 still carries an
empty refund bracket.

**Proposed clause.** "If you stop the service before the end of a paid period,
[refund rule for the unused days: for the owner and lawyer]. If a payment is
charged back, we may suspend the service while the matter is resolved
[decision needed]. Fees charged by the payment provider are [who bears them]."

**[REVIEW FLAG]** Owner and lawyer decision. Do not promise an automatic
refund or an automatic chargeback action: neither exists in the code. Decide
the formula, who pays the chargeback fee, and whether a contested payment
suspends access. Align this clause with the section 8 bracket in
`terms-of-service.md`.

## 5. A late payment starts a fresh 30 days

**Fact.** Recording a payment calls `applyPayment()`. The new `paid_until` is
`max(paid_until, now) + 30 days`: from the old end date if the business is
still paid, from the current date if it is overdue or has never been billed.
A paid period is never shortened. A second tap answers "Already extended."
and changes nothing. The operator records each payment by hand.

**Proposed clause.** "If you pay after the due date, a new 30-day period
starts on the day we record your payment. If you pay before your current
period ends, the new period starts when the current one ends, so you lose no
days. We never shorten a period you have already paid for."

**[REVIEW FLAG]** "The day we record" is not the day the customer sent the
money; is that wording fair, and should a bank delay count? Dates in the
system are UTC — does the contract need to say so? How are part-months and
short/long months handled?

## 6. Auto-renewal and cancellation disclosure

**Fact.** The code does not auto-charge and does not renew anything. There is
no payment-provider code; a payment is a date the operator enters with
**Extend 30 days**. A provider is only a roadmap item (`SESSION_HANDOFF.md`
section 9). `terms-of-service.md` section 2 says the customer pays in advance,
and section 8 says the customer can stop by telling us in writing.

**Proposed clause.** "The service does not renew itself and does not charge
you automatically. Each 30-day period is paid in advance. You can end the
service at any time by telling us in writing. [If automatic renewal is
introduced, the disclosure, the renewal date and the cancellation steps go
here, before the first live payment.]"

**[REVIEW FLAG]** Owner and lawyer decision: whether to turn on auto-renewal
at all, and if so what disclosure is legally required, how the customer
cancels, and how much notice is needed. The clause above must not survive a
decision to auto-charge; the wording would then be false.

## What is fact / what is a decision

| Topic | Code-backed fact | Blank for owner / lawyer |
|---|---|---|
| Held leads | form stores with `held_at`; count-only notices; released on Reactivate or Extend | how long leads may be held; disclosure to the visitor; what if never restored |
| Site when off | full landing page still served; form holds when suspended, is unavailable when terminated; holding page not built | which of the three site options applies; misleading-advertising risk; notice before a change |
| Retention and export | 60 days; no purge job; export is a manual database query; deletion is a manual script | "may" vs "will" delete; export format and deadline; manual-only promise |
| Refund and chargeback | no payments and no amounts in code | refund formula; chargeback action and who pays the fee |
| Late payment | `max(paid_until, now) + 30 days`; a paid period never shortens | "recorded" vs "paid" day; UTC vs local date; part-months |
| Auto-renewal and cancellation | no auto-charge, no provider code | whether to auto-renew; disclosure text; cancellation route and notice |
