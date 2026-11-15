# Whop subscription billing notes for Alder

Public Whop documentation was read on **2026-11-15**. This note is for a hosted subscription service billed in USD, where Alder needs to connect a Whop payment to one internal business and enforce access from canonical billing state. The API shapes below are documentation-derived; no account, API, or CLI was accessed.

## 1. Authentication

Whop distinguishes an **Account API key**, which acts as one account, from an **App API key**, which acts as an app across accounts that install it. For Alder selling its own subscription, the Account API key is the documented fit. API keys are bearer secrets: send `Authorization: Bearer <key>` to `https://api.whop.com/api/v1`, keep it in server-side environment storage, and never put it in browser code, mobile code, or a repository. Keys carry granted permissions; use a production custom permission set instead of the Admin role used for the sandbox quickstart. [S1, S2, S3]

Whop also documents account-scoped user tokens, account access tokens, iframe user tokens, and OAuth tokens. These serve user/app experiences and are not a reason to expose the account API key. A server can mint an account-scoped user token with `scoped_actions`; the token inherits every permission of its minting credential if that list is omitted, so an explicit narrower list is required. Docs say such tokens expire after one hour by default, with a three-hour maximum. App installation permissions and endpoint permissions are separate checks. [S2, S5]

Relevant documented create permissions include `access_pass:create` for products, `plan:create` for variants, and `checkout_configuration:create` for checkout configurations. The individual endpoint reference lists its required permission; grant only the set the server needs. Exact read permission names for all membership/payment fields should be confirmed from the selected endpoint version before implementation. [S6, S7, S9, S11, S13]

## 2. Products, plans, checkout, and metadata

The current API separates a product from a purchasable variant (the API calls variants `plans` in several IDs and permissions). A recurring monthly USD variant is modeled with `billing_type: "renewal"`, `billing_period: 30` days, `currency: "usd"`, and `renewal_price` in major units. `initial_price` is the first charge; set it equal to the monthly price for an ordinary paid first month, or to zero for a free first period. `trial_period_days` is the optional free trial length before the first recurring charge. Paid fiat variants have a documented minimum of 1.00 in the variant currency. A 30-day period is what the docs use for monthly billing; the reviewed source does not promise calendar-month alignment. [S6, S7, S8]

Example variant body, with IDs and amount illustrative:

```json
{
  "product_id": "prod_…",
  "title": "Alder monthly",
  "billing_type": "renewal",
  "billing_period": 30,
  "currency": "usd",
  "initial_price": 500,
  "renewal_price": 500,
  "trial_period_days": null
}
```

For checkout, the Current API has `POST /api/v1/checkout_configurations`. A successful create returns a `purchase_url` to send to the customer. The configuration supports `metadata`, described as custom key/value data copied to the resulting payment and membership. A unique configuration per customer/business can therefore carry an Alder business key such as `alder_business_id`; keep this an internal opaque ID and validate it server-side. [S8, S9, S10]

**The exact existing-plan request key is inconsistent in the captured reference.** The create operation’s TypeScript sample passes `account_id` and `plan_id`; its schema example shows `account_id` and `variant_id`; its request body also documents an inline `variant` object and says that object is mutually exclusive with `variant_id`. Do not guess which identifier name the deployed endpoint accepts. Confirm the current OpenAPI schema or a sandbox request before implementing. The documented metadata behavior and returned `purchase_url` are consistent across the object/reference pages. [S8, S9]

The checkout configuration also has `mode` (`payment` or `setup`); setup mode saves payment details without charging. It may set a redirect URL and payment method overrides. The reviewed pages do not document a per-customer email-prefill field on the create request; treat that as unconfirmed. [S8, S9]

Whop also has a dashboard checkout-link flow for free, one-time, recurring, or split-payment products. The captured API reference does not show a supported dynamic template parameter for injecting a different business ID into an already-created link. Use per-business configuration metadata, and verify metadata propagation in a sandbox webhook and membership read before relying on it. [S10, S8, S11, S13]

## 3. Webhooks

### Event names

The current create-webhook schema lists these payment events:

- `payment.authorized`, `payment.canceled`, `payment.created`, `payment.succeeded`, `payment.failed`, `payment.pending`, `payment.requires_action`.
- Related billing events: `dispute.created`, `dispute.updated`, `dispute_alert.created`, `refund.created`, `refund.updated`.
- The same schema also lists `shipping_address.changed`, which is not a subscription entitlement event.

The same create schema lists membership lifecycle events `membership.activated`, `membership.deactivated`, `membership.trial_ending_soon`, `membership.updated`, and `membership.cancel_at_period_end_changed`. It lists invoice events `invoice.created`, `invoice.marked_uncollectible`, `invoice.paid`, `invoice.past_due`, and `invoice.voided`; these are linked as legacy invoice resources. The docs do **not** list a `payment.past_due` or `membership.past_due` event. A subscription charge failure is described through `payment.failed` plus a membership status change. [S15, S16]

There is a schema inconsistency to resolve: the create request's `events` list omits `membership.went_valid`, `membership.went_invalid`, `membership.metadata_updated`, and `membership.experience_claimed`, while a later webhook response enum includes them. That response enum also includes `app_membership.went_valid`, `app_membership.went_invalid`, `app_membership.cancel_at_period_end_changed`, and `app_payment.created`, `app_payment.succeeded`, `app_payment.failed`, `app_payment.pending`, and `app_payment.requires_action`. The event guide’s catalog lists `membership.activated`, `membership.trial_ending_soon`, and `membership.updated`, but not every event in the create schema. Treat the request schema as the documented selectable set for an account webhook; confirm the exact lifecycle events against the current version before relying on any `went_*` event. [S15, S16, S17]

The docs show `payment.succeeded` for successful initial and recurring charges, and `payment.failed` for a failed renewal. They do not name a separate renewal-success event. A membership can be active/trialing/past_due and carries its current period; use the payment event to trigger reconciliation, not as a substitute for that period. [S15, S11, S13, S18]

### Envelope, fields, signature, delivery

Webhook envelope fields include `id` (also the `webhook-id` header), `type`, `api_version`, `api_version_date`, `timestamp`, account ID, and `data`, which is the full event resource. For webhook pins before 2026-08-14 and unpinned webhooks, the account field is `company_id`; later pinned payloads use `account_id`. `data` follows the webhook's pinned API version. The current resource payloads include payment and membership IDs, status and metadata; the fields Alder needs are listed in §4. [S15, S16, S17]

Whop follows Standard Webhooks. Headers are `webhook-id`, `webhook-timestamp`, and `webhook-signature` (plus content type). The signature is HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`, using the one-time `ws_…` webhook secret. The signature is base64 and appears as `v1,<signature>`. Verify the unmodified raw request bytes and compare in constant time; reject timestamps more than five minutes from current time. Prefer the official SDK `unwrapWebhook` helper, which verifies and parses. Parsing/normalizing JSON before verification breaks the signature. [S15]

Return a 2xx within five seconds. Whop guarantees at-least-once delivery, not exactly once; retries reuse the same `webhook-id`, so store it under a unique constraint and ignore repeats. Delivery order is not guaranteed. Whop retries for about 71 hours: 12 retries, with delays of 30 seconds, 2 minutes, 8 minutes, 30 minutes, 1 hour, 3 hours, 6 hours, then every 12 hours. It warns by email after a full day of failures; after 72 hours and at least 10 failed deliveries it disables the endpoint. Events during the disabled period are not replayed automatically; re-read API state after recovery. Delivery records are retained for 30 days. [S15, S17]

Register either in Developer → Webhooks in the dashboard or with `POST /api/v1/webhooks`. The create body includes the public `url`, subscribed `events`, and optional `api_version_date`, `resource_id`, `title`, `enabled`, and `child_resource_events`. The response returns `webhook_secret` once; save it immediately. The API reference exposes delivery logs and replay operations as well. [S15, S16, S17]

## 4. Reading canonical state

Use `GET /api/v1/memberships/{id}` to retrieve a membership from its `mem_` ID. The Memberships API also lists memberships. Use `GET /api/v1/payments/{id}` for a payment, and the Payments API has a list endpoint. Payment objects include a `membership_id` relationship; however, the exact list filter for retrieving all payments for one membership was not confirmed from the captured list reference. [S11, S12, S13, S14]

For entitlement, membership fields to persist/reconcile include `id`, `status`, `user_id`, `member_id`, `product_id`, `metadata`, `billing_period_days`, `current_period_start`, `current_period_end`, `expires_at`, `cancel_at_period_end`, `canceled_at`, and `most_recent_action` plus its timestamp. `current_period_end` is when a renewing membership renews, or when a non-renewing one expires; it is null for a non-expiring one-time purchase. `expires_at` is for a fixed expiration, not ordinary renewals. `status` includes at least `active`, `trialing`, and `past_due`; validate the full current enum before coding. [S11, S12]

Payment fields useful for audit/reconciliation include payment `id`, `membership_id`, `member_id`, `user_id`, `plan_id`/variant, `status`, `amount`, `currency`, `billing_reason`, `created_at`, `decline_code`, `failure_message`, `recovery_url` (when authentication is required), `dispute_created_at`, `presentment_refunded_amount`, and `metadata`. Amounts are decimal strings in major units in the resource schema. Read permissions can make fields such as customer email or metadata null; do not interpret an omitted permission-gated field as “no customer/metadata.” For an off-session 3DS request, docs say to send `data.recovery_url` to the customer; it does not itself charge the customer. [S13, S14, S15]

## 5. Failed payments and dunning

Whop says a failed subscription charge moves the subscription to **Past due**, sends the customer an email asking them to update payment details, and automatically retries over a five-day period. Access while past due depends on the seller’s checkout setting. If the payment is still failing after five days, Whop automatically cancels the subscription. A successful retry restores Whop access automatically. The page does not give the exact attempt times/count or a configurable dunning schedule. [S18]

For Alder’s independent 7-day grace rule, do not assume Whop’s five-day retry period matches Alder access. On `payment.failed`, re-read the membership, record the failed-payment time, and apply Alder’s own `grace_until`; after that, re-read again before suspending. Do not drop service at the first failure if current paid time remains. Also reconcile `membership.updated`, `payment.succeeded`, and any cancellation event because retries and membership transitions can arrive out of order. [S15, S18, S11]

## 6. Sandbox and test mode

Whop has separate sandbox and production dashboards, API bases, accounts, keys, products, checkout pages, and webhooks. Sandbox API: `https://sandbox-api.whop.com/api/v1`; dashboard/checkout: `https://sandbox.whop.com`. Set the SDK environment to Sandbox. Sandbox payments do not move real money, and sandbox webhooks can be registered and tested separately. [S3, S19]

The documented test card `4242 4242 4242 4242` succeeds with any future expiry and any 3-digit CVC. `4000 0000 0000 0002` declines; `4000 0000 0000 0341` accepts setup but declines later off-session charges. Sandbox has documented limitations and does not reproduce every live payment method/flow; consult its limitations before interpreting a missing event as a production behavior. [S3, S19]

## 7. Seller payouts, fees, and tax

Payout choices vary by seller country; the docs say bank, mobile-wallet, and crypto payout coverage spans 200+ countries, but do not identify what an Egyptian seller will see. A payout bank must accept the payout currency; Whop says it does not automatically convert USD proceeds into the seller’s local currency before payout. PayPal payout is only available when the buyer originally paid with PayPal. Coinbase payout requires a Coinbase wallet and the buyer to have paid with crypto; the payout guide says crypto payouts require a one-time pricing plan, so that route does not fit a recurring-card subscription. The fee page names Bitcoin and Ethereum as examples but does not specify available payout networks/chains. Country-specific payout minimums and a generic settlement calendar were not found in the pages captured. [S20, S21]

Published payout fees include next-day ACH to US banks: $2.50; instant bank deposit/RTP where supported: 4% + $2.50; crypto: 5% + $1.00; Venmo (US recipients): 5% + $2.50; bank wire: $23; international local bank: varies by country. The fees page says bank wire typically takes 1–2 business days in the US, international local timing varies, and same-day payout availability depends on the route. It does not give the international bank minimum or Egyptian schedule. [S21]

Base card rate is 2.7% + $0.30 for domestic cards, with +1.5% for international cards and +1% if currency conversion applies; Latin American pricing differs. Other listed fees include ACH debit at 1.5% capped at $5, 3DS at $0.03/transaction, Radar at $0.07/transaction, and $15 per dispute/chargeback. Optional Revenue Optimization fees stack on top: Orchestration 0.8%, Billing 0.5%, and tax/remittance 0.5% when the seller remits or 2% when Whop remits (both only when enabled and tax is collected). Seller Terms reserve the right to update fees. The real total therefore depends on card origin, FX, enabled services, and payout method. [S21, S23]

For **direct checkout-link/site sales**, Whop documents three tax modes:

- **Whop collects tax, seller remits:** Whop calculates/collects where the seller has tax registrations; the tax proceeds are included in payout and the seller registers/files/remits. Listed at +0.5% only when tax is collected.
- **Whop collects and remits:** Whop handles calculation, collection, remittance, and filing in its current coverage area (the docs describe US, EU, and UK coverage). Seller remains responsible outside that coverage. Listed at +2% only when tax is collected.
- **Seller handles tax:** Whop does not calculate/collect/remit for direct sales; seller handles registrations, collection, returns and remittance. No Whop tax fee listed.

Marketplace purchases are described separately: Whop handles tax in jurisdictions covered by its registrations. A seller outside the US selling to US businesses should not assume all tax obligations transfer; Whop’s scope depends on the direct-sale mode, current coverage, taxability/product classification, and registrations. Obtain tax advice for the actual service and buyer jurisdictions. [S22, S23, S21]

Whop’s payout pages say risk reviews can delay withdrawals, and Seller Terms allow reserves up to 100% of funds, payment suspension, or termination for reasons including new-account/no-history status, elevated disputes/refunds, unusual activity, policy or compliance indicators, missing documents, and product/fulfillment risk. [S20, S23]

## 8. Acceptable use: hosted software plus setup service

The Seller Terms make the seller responsible for lawful products, compliance with the Prohibited Products and Services Policy, accurate price and service descriptions, disclosed access period/duration/delivery method, product delivery, customer support, and the seller’s business operations. They describe Whop as merchant of record for card-network and settlement purposes while saying the seller remains the supplier. [S23]

The reviewed Seller Terms do **not** explicitly approve or prohibit a hosted roofing SaaS subscription bundled with onboarding/setup services. The referenced Prohibited Products and Services Policy was not fetched within the request budget, so category eligibility, service-vs-digital-product treatment, and any restrictions on setup labor remain unverified. Do not represent the offer as cleared until Whop confirms that exact description in writing. [S23]

## 9. Whop CLI and AI-agent risk

The official documentation confirms a `whop` CLI. It lists 74 command groups across commerce, payments, money movement, ads, analytics, integrations, developer settings, and authentication. Install methods documented include the npm package `@whop/cli`, platform installer, and Homebrew. Sign-in supports browser OAuth or a supplied API key; headless use can set `WHOP_API_KEY`. [S24]

The CLI documentation says it has **no sandbox/test mode**: commands run against production. Many can create resources or move money; state-changing commands ask for confirmation, and `whop send --dry-run` previews that particular payment action. The platform supports permissioned API keys/custom permission sets, so a least-privilege key is possible in principle; I found no CLI-specific scope flag or guarantee that each command group can be separately disabled. Never hand an AI agent an Admin or broadly permissioned production key. Prefer no CLI credential; if unavoidable, use a revocable custom-role key with only the exact required API permissions and review every planned command. [S2, S3, S24]

The overview links a separate Commands reference for every individual subcommand, but that page was not fetched. This note lists the documented command groups rather than claiming a complete subcommand inventory. [S24]

## 10. Rate limits and API versioning

The Current API base is `https://api.whop.com/api/v1`. Pin request/response shapes with `Api-Version-Date`. New API keys use the latest released version; an unpinned existing key uses the original `2025-01-01` model; an unsupported date returns HTTP 400. Webhook `api_version_date` pins its payload too. Pin a dated version in Alder and review the changelog before changing it. [S1, S4, S15]

I did not find a numeric REST rate limit, burst policy, or `Retry-After` contract in the API overview/versioning pages captured. Treat the rate limit as **unconfirmed**; handle `429` conservatively with bounded backoff and ask Whop for the account-specific limit. [S1, S4]

## Design notes for Alder

- Create one stable monthly plan and one checkout configuration per internal customer/business. Attach the internal business identifier as checkout `metadata`; store the returned checkout configuration ID and `purchase_url` against the business. Do not trust a browser-provided tenant identifier or webhook metadata alone: match checkout ID, Whop membership/payment IDs, and the locally stored business binding.
- Subscribe to the supported account webhook events for `payment.succeeded`, `payment.failed`, `membership.activated`, `membership.deactivated`, `membership.updated`, `membership.trial_ending_soon`, `membership.cancel_at_period_end_changed`, `dispute.created`/`updated`, `dispute_alert.created`, and `refund.created`/`updated`. Add invoice events only if the chosen collection mode actually uses invoices. First resolve the docs mismatch around `membership.went_valid`/`went_invalid` and the exact accepted event list.
- Verify the raw-body Standard Webhooks signature before reading payload fields. Insert the `webhook-id` under a unique constraint, acknowledge duplicates with 2xx, and queue state reconciliation so the endpoint responds under five seconds. Never assume delivery order; older state must not overwrite a later canonical read.
- On successful payment or a relevant membership event, fetch `GET /memberships/{id}` and set `paid_until` from canonical `current_period_end` (or `expires_at` for fixed-expiry products). Clear the Alder grace marker only after canonical state confirms the paid/trialing period. For a zero-cost trial, use canonical membership status/period, not a guessed payment.
- On `payment.failed`, `membership.updated`/`deactivated`, cancellation, refund, dispute, or `payment.requires_action`, re-fetch membership and payment as relevant. A failed payment starts Alder’s own seven-day grace without shortening already-paid time. Cancel-at-period-end should preserve access through `current_period_end`; immediate cancellation and refund/dispute require an explicit Alder policy after canonical-state review. Do not let one refund/dispute event automatically erase a subscription period if it is partial or unresolved.
- Store provider account ID, checkout configuration ID, membership ID, payment IDs, plan/product IDs, member/user IDs, status, billing reason, amount/currency, current period start/end, expiration, cancellation state, metadata business ID, event ID/type/timestamp/API version, and the signature verification result. Keep event payload retention minimal and avoid storing unnecessary customer PII.
- Reconcile periodically through the membership/payment APIs, especially after webhook delivery outages: Whop documents automatic webhook disablement and says missed events while disabled are not delivered later.

## Not confirmed

1. The exact `plan_id` versus `variant_id` field for an existing plan in checkout-configuration creation; the docs disagree.
2. Which membership events are selectable/actually emitted for the pinned API version (`activated/deactivated` vs `went_valid/went_invalid`), and whether a successful renewal always emits `membership.updated` in addition to `payment.succeeded`.
3. Exact payment-list filters for fetching all payments for a single membership; endpoint reference and object relationship were captured, but the list filter was not confirmed.
4. Numeric REST API rate/burst limits and `Retry-After` behavior.
5. Exact subscription retry attempt count/timestamps and whether seller-controlled dunning settings exist; source only says retries over five days and email prompts.
6. Exact Egypt payout instruments, payout minimums, schedule, how payout fees vary in Egypt, and the supported crypto networks/chains; generic country-specific docs do not settle this.
7. Hosted roofing SaaS plus onboarding/setup service acceptance under the referenced Prohibited Products and Services Policy.
8. Full individual CLI subcommand inventory and CLI-specific permission controls; only the 74 command groups and key-based authentication were captured.
9. The exact permissions required to read every desired customer/payment/membership field under Alder’s final key role.

## Sources

All sources below were public pages read on **2026-11-15**. Matching source markdown is saved under `_debug/whop-docs/` using the local filename shown.

| ID | Local source | URL | Read |
|---|---|---|---|
| S1 | `api-overview.md` | https://docs.whop.com/api-reference/overview | 2026-11-15 |
| S2 | `auth-scoping.md` | https://docs.whop.com/developer/guides/auth-scoping | 2026-11-15 |
| S3 | `quickstart.md` | https://docs.whop.com/developer/quickstart | 2026-11-15 |
| S4 | `api-versioning.md` | https://docs.whop.com/developer/api/versioning | 2026-11-15 |
| S5 | `app-permissions.md` | https://docs.whop.com/developer/guides/permissions | 2026-11-15 |
| S6 | `create-product.md` | https://docs.whop.com/api-reference/products/create-product | 2026-11-15 |
| S7 | `create-variant.md` | https://docs.whop.com/api-reference/variants/create-variant.md | 2026-11-15 |
| S8 | `checkout-configuration.md` | https://docs.whop.com/api-reference/checkout-configurations/checkout-configuration | 2026-11-15 |
| S9 | `create-checkout-configuration.md` | https://docs.whop.com/api-reference/checkout-configurations/create-a-checkout-configuration.md | 2026-11-15 |
| S10 | `create-checkout-link.md` | https://docs.whop.com/payments/create-checkout-link | 2026-11-15 |
| S11 | `membership-object.md` | https://docs.whop.com/api-reference/memberships/membership | 2026-11-15 |
| S12 | `retrieve-membership.md` | https://docs.whop.com/api-reference/memberships/retrieve-membership | 2026-11-15 |
| S13 | `payment-object.md` | https://docs.whop.com/api-reference/payments/payment | 2026-11-15 |
| S14 | `list-payments.md` | https://docs.whop.com/api-reference/payments/list-payments.md | 2026-11-15 |
| S15 | `webhooks-guide.md` | https://docs.whop.com/developer/guides/webhooks | 2026-11-15 |
| S16 | `create-webhook.md` | https://docs.whop.com/api-reference/webhooks/create-webhook | 2026-11-15 |
| S17 | `webhook-object.md` | https://docs.whop.com/api-reference/webhooks/webhook | 2026-11-15 |
| S18 | `failed-payments.md` | https://docs.whop.com/payments-and-billing/payment-issues/troubleshoot-failed-payments.md | 2026-11-15 |
| S19 | `sandbox.md` | https://docs.whop.com/developer/guides/sandbox | 2026-11-15 |
| S20 | `payout-methods.md` | https://docs.whop.com/manage-your-business/manage-payouts/payout-methods | 2026-11-15 |
| S21 | `fees.md` | https://docs.whop.com/fees | 2026-11-15 |
| S22 | `tax-modes.md` | https://docs.whop.com/payments-and-billing/fees/taxes | 2026-11-15 |
| S23 | `seller-terms.md` | https://whop.com/seller-terms/ | 2026-11-15 |
| S24 | `cli-overview.md` | https://docs.whop.com/cli/overview | 2026-11-15 |
