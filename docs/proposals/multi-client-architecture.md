# Multi-client architecture decision

**Decision:** Architecture A — one shared deployment serves every client.
Architecture B remains an escape hatch, not a parallel platform to maintain.
The product is not launched and currently has no real clients, so the tenant
seam should be established before the first paying onboarding.

## Decision record

### Context

The build currently produces one client's static site from `clients/<slug>.json`.
The database already has business-scoped leads, chats, events, and review tokens.
Onboarding may reach roughly 100 clients per week; manual project, domain, and
row creation cannot be the operating model.

### Decision

Use one Vercel project, one Supabase database, and one Telegram bot. A public
request's normalized `Host` selects the business through a unique `site_host`.
The server never accepts a body slug, business id, forwarded host, query value,
or cookie as a tenant selector. Unknown and malformed hosts fail closed. Review
lookups must include both the token and the host-selected `business_id`.

Daily self-check and digest jobs process all active businesses by default and
accept an optional single-business filter. The bot keeps its existing rule: a
chat binding alone selects the business, and one Telegram account belongs to one
business.

### Security boundary

The shared service-role key bypasses RLS and gives **no hard tenant isolation**.
Application scoping and two-tenant tests are necessary but cannot contain a query
bug with database-enforced certainty. If that boundary becomes insufficient,
introduce deny-by-default tenant RLS policies and tenant-scoped credentials (or
separate databases); do not claim the shared key provides isolation.

### Scale and operations

- **Preview/test hosts:** map an explicit preview or loopback host to a canonical
  `site_host` only outside production. Test data and credentials stay in the TEST
  project. Production ignores this mapping and requires the real Host.
- **Build time:** building every client's full site on every commit grows roughly
  linearly with client count and will eventually exceed build limits. Keep shared
  assets static, generate only changed sites, and move toward request-time
  rendering from database settings with cached shared templates. Measure build
  duration and output size as fixtures are added; do not wait for 100 clients.
- **Automated onboarding:** an operator-only control plane must create the
  business row and normalized `site_host`, attach/verify the domain through the
  host provider API, configure sender/review settings, and run smoke checks.
  Manual SQL and dashboard steps do not scale to about 100 clients/week. Domain
  failure leaves the business inactive; no public fallback tenant is allowed.
- **Configuration as data:** move per-client copy, domains, brand assets, sender,
  phone/postal rules, legal links, and retention settings from
  `clients/<slug>.json` into business-scoped database records and versioned asset
  storage. Shared code stays in this repo. Migration must be staged and validated,
  not a big-bang rewrite. Secrets remain provider credentials, not website data.
- **Jobs and email:** load the business settings for each item; never retain one
  tenant's config in module-level state. Keep per-business idempotency and counts.
- **Verification:** test two tenants, wrong-Host review tokens, forged body and
  forwarding fields, unknown/malformed hosts, preview mapping, chat binding,
  inactive clients, and daily-job filtering before real onboarding.

## Architecture B — escape hatch

A client needing a genuinely custom UI, an SEO remedy incompatible with shared
routing, or stronger isolation can receive a separate project built from the
same repository and shared packages. Its environment selects one business; the
central bot webhook remains singular. Do not fork business logic or create a
second client-specific code path. Separate projects sharing the service-role key
still do not provide hard database isolation; stronger isolation needs the RLS /
credential work above or a separate database.

## Consequences and open owner decisions

A minimizes operational duplication and supports automated high-volume
onboarding, but requires disciplined host routing, data-driven settings, and
build/render measurement. B remains available without redesigning those seams.

The owner still must choose Vercel Pro or another commercially compliant host
and obtain legal review of retention, deletion promises, privacy/terms, and
contract text before taking payment.
