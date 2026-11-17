# Whop: payments, payouts and integration reference

Whop is the payment provider for Alder's monthly subscription. This file is the
single reference: what Whop charges, what it does and does not take responsibility
for, what it forbids, how its API models a subscription, and how that maps onto the
billing code in this repository.

Every statement below comes from Whop's own pages, read on **2026-11-15/16**. Where
a page was ambiguous or the owner's dashboard disagreed with the docs, the
disagreement is written down instead of being resolved by guessing. Section 9
lists the sources; the raw pages live in the ignored `.firecrawl/` folder.

Nothing here is legal or tax advice.

---

## 1. What is being sold

Alder sells a hosted service to roofing companies: a landing page with a lead form,
plus lead alerts by email and Telegram, with initial setup included, at USD 499 per
month. That shape decides almost everything below:

- It is a **recurring card subscription**, not a one-time sale. Whop's checkout and
  membership model covers this natively.
- The **buyer is a business**, usually in the United States.
- The **seller is in Egypt**, which limits payout instruments.
- Alder is the **supplier**; Whop is the payment layer (see section 4).

---

## 2. Account, verification and payouts

### 2.1 Enabling withdrawals

1. Dashboard → **Balances** → **Set up Whop Payments**.
2. Choose the country of the bank account, then complete KYC (details, bank link, ID).
3. Add a payout method and choose a schedule: instant, daily or weekly.

Two different verifications exist and they are not interchangeable: **business
verification** and **individual (personal) verification**. Payouts stay `Inactive`
until the individual one is done, even when the business is already verified. This
is exactly what the owner hit on 2026-11-16: the business was verified, the personal
account was not, so `Payouts: Inactive` and `Bank deposits: Inactive` and no
Withdraw button anywhere.

The **Payment methods** screen under personal account settings is unrelated: it
lists cards the account *pays with* as a buyer. An empty page there is normal.

### 2.2 Payout methods and published fees

Whop pays to bank accounts, mobile wallets and crypto wallets in 200+ countries;
which methods appear depends on the payout country. Standard payouts take up to five
business days; instant routes take minutes and can draw on funds that have not fully
settled. Whop may hold a withdrawal for compliance review, and then the instant
option is not offered.

| Method | Fee | Notes |
|---|---|---|
| Next-day ACH (US banks) | $2.50 | US only |
| Instant bank deposit (RTP) | 4% + $2.50 | where supported |
| Crypto | 5% + $1.00 | see the two conditions below |
| Venmo | 5% + $2.50 | US recipients only |
| Bank wire | $23.00 (docs) | 1–2 business days in the US |
| International local bank | varies by country | |

**Two conditions that decide whether crypto is usable.** PayPal payouts require the
customer to have paid with PayPal. Coinbase payouts require a Coinbase wallet *and*
the customer to have paid with crypto, on a **one-time** plan — so that route does
not fit a recurring card subscription. The generic crypto payout option (5% + $1)
is a separate route and is not tied to those two conditions; the docs do not name
its networks or chains.

### 2.3 Egypt, as the owner's dashboard actually shows it

Recorded from the owner's Whop dashboard on 2026-11-16, with Egypt selected:

| Method | Fee shown | Arrival |
|---|---|---|
| Bank wire | $26.12 per transfer | not shown |
| USDT on Tron (TRC20) | est. $5.00 | "Tomorrow" |
| Bitcoin / Ethereum | 5% + $1.00 | — |

The dashboard's wire fee ($26.12) does not match the documentation's $23.00. Trust
the dashboard; it is the number the account is actually charged.

At $499 a month, USDT TRC20 at a flat $5 is roughly 1% and beats the wire by a wide
margin; the 5% + $1 crypto rate on Bitcoin would be about $26. Whether the $5 is
flat per withdrawal or an estimate is not stated — the dashboard labels it "Est.",
so confirm on the first real withdrawal.

Not confirmed for Egypt: the minimum withdrawal amount, the reserve Whop may place
on a new account, and the exact local bank list. Withdraw a small amount first.

### 2.4 Reserves

A reserve is money Whop holds back from payout for a period. It is not a fee; it
returns automatically.

- Whop may reserve **up to 100% of funds** and hold for **up to 180 days**.
- It is more likely on a **new account with no sales history**, with elevated
  disputes or refunds, with unresolved Resolution Center cases, or where delivery
  happens long after payment.
- Two shapes: a **rolling reserve** (a percentage of each sale, released per sale as
  it ages) and a **fixed-amount reserve** (one lump sum, one release date).
- A reserve can shrink or disappear as the account's record improves.

For Alder this is the main cash-flow risk of the first months: the first sale can be
paid out in part or not at all until the account has history.

---

## 3. What a transaction costs

| Item | Fee |
|---|---|
| Domestic card | 2.7% + $0.30 |
| International card | +1.5% |
| Currency conversion | +1% |
| ACH debit | 1.5%, capped at $5 |
| Financing (BNPL) | 15% (20% for ClarityPay No Interest) |
| 3DS authentication | $0.03 per transaction |
| Radar (fraud) | $0.07 per transaction |
| Dispute / chargeback | $15.00 |
| Early dispute alert (RDR/Ethoca) | $29.00 |
| ACH return / dispute | $10 / $25 |
| SEPA return / dispute | €7.50 / €20 |

Optional services, charged only when enabled, and they stack:

| Service | Fee |
|---|---|
| Orchestration | 0.8% |
| Billing (invoices, retries) | 0.5% |
| Tax, seller remits | 0.5% (only when tax is collected) |
| Tax, Whop remits | 2% (only when tax is collected) |

### 3.1 Worked example at $499

| Case | Processing | Payout | Net before tax service |
|---|---|---|---|
| US card, USDT TRC20 | 2.7% + $0.30 = $13.77 | $5.00 | **$480.23** |
| Non-US card (+1.5%) | $21.26 | $5.00 | $472.74 |
| US card, bank wire | $13.77 | $26.12 | $459.11 |

With the tax service enabled and Whop remitting, subtract another 2% ($9.98).
All of it is charged per transaction, so the real total depends on where the card
was issued and which services are switched on.

---

## 4. Merchant of record, tax, refunds

Whop is merchant of record **for card-network rules and payment settlement only**.
For everything else — VAT and sales tax, consumer protection, content licensing —
**the seller is the supplier**. The receipt names the seller as supplier; the card
statement names Whop as processor.

That has three consequences worth stating plainly:

1. **Refunds and chargebacks are the seller's.** Whop processes a reversal on
   instruction, but the decision and the cost are Alder's, including $15 per
   chargeback and any negative balance (which accrues 1.5% a month until paid).
2. **Tax is the seller's**, unless the tax service is enabled.
3. **Whop may suspend or terminate at any time** in its sole discretion, and may
   withhold payouts during investigation — typically 90 days, up to 120–180.

### 4.1 Tax modes

| Mode | What Whop does | Fee |
|---|---|---|
| Whop collects and remits | Calculates, collects, remits and files in supported jurisdictions | 2% |
| Whop calculates, seller remits | Adds tax at checkout, pays it out to the seller, who files | 0.5% |
| Seller handles tax | Nothing | none |

"Whop collects and remits" covers **18 US states, the UK and the EU**. Outside that,
the seller is on its own regardless of mode. A US-facing service sold from Egypt
should get local tax advice; the mode does not remove the obligation, it only moves
who files.

---

## 5. What may and may not be sold

Whop's Prohibited Products and Services Policy bans a long list, and separately says
some categories may be allowed **with prior written approval**.

Relevant to Alder:

- **Not prohibited by name:** hosted software (SaaS) and agency/done-for-you work
  both have dedicated Whop guides, and lead generation is described as a normal
  agency activity.
- **Prohibited and adjacent to this market:** outbound telemarketing, inbound
  teleservices, and in-person sales at residences. Alder does not do any of these —
  it delivers a form and alerts — but a service that *sold* roofing leads by phone
  would be in trouble.
- **Prohibited:** "lifetime access" offers. Any offer must state its access period.
  A monthly subscription states it by construction, but the marketing copy must not
  imply permanence.
- **Prohibited:** data-scraping tools and fake engagement. Not applicable.
- **Restricted, needs approval:** the policy names no list, only that some categories
  require it.

There is **no explicit ruling** for "hosted website + lead alerts + onboarding, sold
as a monthly subscription". The honest position is: nothing forbids it, nothing
approves it in writing. Treat acceptance as unconfirmed until Whop says so in
response to the actual product description, and keep the first payout small.

---

## 6. API integration

### 6.1 Authentication

- Base URL: `https://api.whop.com/api/v1`. Sandbox: `https://sandbox-api.whop.com/api/v1`.
- An **Account API key** acts as one account and is the right shape here. Send it as
  `Authorization: Bearer <key>`; keep it in Vercel environment variables only.
- Keys carry permissions. Use a **custom permission set**, never the Admin role the
  quickstart uses. Documented create permissions include `access_pass:create`
  (products), `plan:create` (variants) and `checkout_configuration:create`.
- The official `whop` CLI has **no sandbox**: commands run against production and
  some move money. Never give an agent an Admin key.

### 6.2 Products and plans

A product is separate from a purchasable variant (the API calls variants `plans` in
several IDs). A monthly USD subscription:

```json
{
  "product_id": "prod_…",
  "title": "Alder monthly",
  "billing_type": "renewal",
  "billing_period": 30,
  "currency": "usd",
  "initial_price": 499,
  "renewal_price": 499,
  "trial_period_days": null
}
```

`billing_period` is in days; the docs use 30 for monthly and do not promise calendar
alignment. `initial_price` is the first charge.

### 6.3 Checkout

`POST /api/v1/checkout_configurations` returns a `purchase_url` to send the customer.
The configuration accepts `metadata`, which Whop copies onto the resulting payment
and membership — that is where Alder's internal business id belongs, so a payment can
be tied back to one tenant. It also has `mode` (`payment` or `setup`), where `setup`
saves a card without charging.

**Unresolved:** the create request's samples disagree on whether an existing plan is
passed as `plan_id` or `variant_id`. Confirm against the live schema before coding.

### 6.4 Webhooks

Whop follows the Standard Webhooks spec.

- Headers: `webhook-id`, `webhook-timestamp`, `webhook-signature`.
- Signature: HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`, base64,
  prefixed `v1,`. Verify the **raw bytes** before parsing, compare in constant time,
  reject timestamps more than five minutes off.
- Respond 2xx within **five seconds**. Delivery is **at least once**, retries reuse
  the same `webhook-id`, and order is not guaranteed. Store the id under a unique
  constraint and ignore repeats.
- Retries: 12 attempts over about 71 hours (30 s, 2 min, 8 min, 30 min, 1 h, 3 h,
  6 h, then every 12 h). After 72 hours and at least 10 failures the endpoint is
  **disabled**, and events from the disabled period are **not replayed**.

Selectable events include:

- Payments: `payment.succeeded`, `payment.failed`, `payment.pending`,
  `payment.requires_action`, `payment.created`, `payment.authorized`,
  `payment.canceled`.
- Membership: `membership.activated`, `membership.deactivated`, `membership.updated`,
  `membership.trial_ending_soon`, `membership.cancel_at_period_end_changed`.
- Money back: `refund.created`, `refund.updated`, `dispute.created`,
  `dispute.updated`, `dispute_alert.created`.
- Invoices (legacy): `invoice.paid`, `invoice.past_due`, `invoice.created`,
  `invoice.voided`, `invoice.marked_uncollectible`.

There is **no** `payment.past_due` or `membership.past_due` event; a failed renewal
arrives as `payment.failed` plus a membership status change. The docs also disagree
with themselves about whether `membership.went_valid` / `went_invalid` are selectable
— treat those as unconfirmed.

The `webhook_secret` (`ws_…`) is returned **once**, at creation. Save it immediately.

### 6.5 Reading the canonical state

`GET /api/v1/memberships/{mem_…}` returns the subscription. The fields that matter:

| Field | Meaning |
|---|---|
| `status` | at least `active`, `trialing`, `past_due` |
| `current_period_end` | when a renewing membership renews, or when a non-renewing one expires |
| `expires_at` | fixed expiry, not ordinary renewals |
| `cancel_at_period_end` | access continues until the period ends |
| `metadata` | whatever was set at checkout |
| `user_id`, `member_id`, `product_id` | identities |

`GET /api/v1/payments/{id}` returns a payment, including `membership_id`, `status`,
`amount` (decimal string, major units), `billing_reason`, `decline_code`,
`failure_message`, `recovery_url` and `dispute_created_at`.

A permission-gated field can come back `null`. That means "not readable with this
key", not "no value".

### 6.6 Failed payments

A failed renewal moves the subscription to **Past due**, emails the customer, and
Whop retries over **five days**. Access during that window depends on the seller's
checkout setting. If it is still failing after five days, Whop **cancels** the
subscription. A successful retry restores access automatically.

The page does not document the exact retry times or a configurable dunning schedule.

### 6.7 Sandbox

Separate dashboard, API base, keys, products and webhooks. Test cards:
`4242 4242 4242 4242` succeeds, `4000 0000 0000 0002` declines,
`4000 0000 0000 0341` passes setup and fails later off-session charges.
Sandbox does not reproduce every live payment method.

### 6.8 Versioning and limits

Pin request and response shapes with `Api-Version-Date`; an unsupported date is a
400. Webhooks pin their payload with `api_version_date` too.

**Unconfirmed:** a numeric REST rate limit, burst policy, or `Retry-After` contract.
Handle `429` with bounded backoff and ask Whop for the account-specific number.

---

## 7. How this maps onto Alder's billing code

Alder already enforces billing locally: `businesses.paid_until`, a grace period, a
daily job, and an operator **Extend 30 days** that calls `applyPayment()` in
`lib/billing-ops.js`. Whop does not replace that — it feeds it.

| Whop | Alder |
|---|---|
| `current_period_end` | `paid_until` (UTC) |
| `status: active` / `trialing` | paid |
| `payment.failed` | the start of grace, not an immediate cut-off |
| `membership.deactivated`, cancellation | keep access to `current_period_end` |
| `refund.created` / `dispute.created` | do not erase a paid period automatically |
| `metadata.alder_business_id` | the tenant to update |

The webhook handler must:

1. Verify the raw-body signature, then insert `webhook-id` under a unique constraint
   and answer 2xx fast.
2. Re-read the membership from the API rather than trusting the payload alone.
3. Call the **same** `applyPayment(businessId, paidUntil, source)` the button uses, so
   there is one code path for money arriving.
4. Never shorten an already-paid period, and be safe to call twice.

A useful coincidence: Alder's grace is **5 days** and Whop retries for **5 days**, so
both end at the same moment. Alder's suspension then lasts 10 more days before
termination at `paid_until + 15`. That means a customer whose card fails is not cut
off by Alder before Whop has finished trying.

Because Whop disables a failing endpoint after 72 hours and does not replay, a
periodic reconcile (read every active membership, compare `current_period_end` to
`paid_until`) is not optional.

---

## 8. Not confirmed

1. Whether Whop accepts this exact product (hosted site + alerts + setup) — no
   written approval or prohibition exists for the bundle.
2. `plan_id` vs `variant_id` in checkout-configuration creation.
3. Whether `membership.went_valid` / `went_invalid` are selectable.
4. Numeric API rate limits and `Retry-After`.
5. Exact dunning schedule beyond "five days, then cancel".
6. Egypt: minimum withdrawal, reserve size for a new account, local bank options,
   whether the $5 USDT fee is flat.
7. The exact permissions needed to read every membership and payment field.

---

## 9. Sources

Read 2026-11-15/16. Raw markdown kept in the ignored `.firecrawl/` folder and, for
the API pages, in `_debug/whop-docs/`. That folder also holds
`whop-integration-notes.md`, the longer evidence note (per-fact source IDs S1–S24)
this file was condensed from.

| Page | URL |
|---|---|
| Fees | https://docs.whop.com/fees |
| Payout methods | https://docs.whop.com/manage-your-business/manage-payouts/payout-methods |
| Set up payouts | https://docs.whop.com/manage-your-business/manage-payouts/set-up-payouts |
| Reserves | https://docs.whop.com/trust-and-safety/account-health/reserves |
| SaaS model | https://docs.whop.com/supported-business-models/saas |
| Agency model | https://docs.whop.com/supported-business-models/agency-services |
| Prohibited products | https://whop.com/prohibited-products-and-services |
| Seller terms | https://whop.com/seller-terms |
| API overview | https://docs.whop.com/api-reference/overview |
| Webhooks guide | https://docs.whop.com/developer/guides/webhooks |
| Membership object | https://docs.whop.com/api-reference/memberships/membership |
| Failed payments | https://docs.whop.com/payments-and-billing/payment-issues/troubleshoot-failed-payments |
| Sandbox | https://docs.whop.com/developer/guides/sandbox |
