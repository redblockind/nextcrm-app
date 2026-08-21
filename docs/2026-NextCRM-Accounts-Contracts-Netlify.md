# 2026 NextCRM Rebuild — Accounts / Contracts ingestion on Netlify

> **Status:** Plan / implementation spec. Nothing in this document has been built yet.
> **Audience:** the operator doing the rebuild, and the AI agents assisting.
> **Supersedes (for the new install):** `2026_disaster_recovery_nextcrm.md`, which describes
> the *current* fork and its 14-file customization delta. That document stays valid for the
> old site until it is retired.

---

## 0. Executive summary

You are doing four things at once. They are separable, and the order matters:

| # | Change | Why it is on this list |
| - | ------ | ---------------------- |
| 1 | New repo, freshly forked from upstream | The current fork's delta spans ~14 shared files; every upstream update is a merge negotiation |
| 2 | Neon → **Netlify DB** | One vendor, one dashboard, automatic deploy-preview branching |
| 3 | Empty database | No migration archaeology, no `migrate resolve --rolled-back` hack |
| 4 | New ingestion model: buyer → **Account**, transaction → **Contract**, shipment → **Activity** | Matches how the business actually works; the old `crm_Targets` model was a marketing-list shape |

**The single most valuable decision in this document** is not any of the four above. It is the
structural rule that makes #1 stick:

> **Custom code goes in directories upstream does not use. It never edits a file upstream owns.**

Concretely: your ingestion endpoints become **Netlify Functions** under `netlify/functions/`,
your custom tables are created by **Netlify DB migrations** under `netlify/database/migrations/`,
and `prisma/schema.prisma`, `package.json`, `app/`, `lib/`, and `actions/` are left **byte-identical
to upstream**. Merging upstream becomes `git merge upstream/main` with, in the normal case, zero
conflicts.

The current fork's delta is ~14 shared files plus 3 Prisma migrations plus 3 schema patches.
The new delta is **two files, both additive** (`netlify.toml`, which upstream does not have, and
optionally a 4-line patch to two Prisma connection files — see §4.2).

**On the idempotency table: yes, build it.** Details and design in §6. Short version — your old
ingestion was accidentally idempotent because it upserted a person keyed on email; replaying an
event just rewrote the same row. The new model is *not*, because a Contract is a per-transaction
record: a replayed `checkout.session.completed` produces a second Contract and double-counts
revenue. Stripe guarantees at-least-once delivery and retries any non-2xx for up to three days,
so duplicate deliveries are routine, not exceptional.

---

## 1. How to start from scratch

### 1.1 Fork or fresh clone?

Both work. The deciding question is **does the repo need to be private?**

| | GitHub fork | Clone → push to new repo |
| - | ----------- | ------------------------ |
| Upstream tracking | Built in: "Sync fork" button, `gh repo sync`, compare views | Manual: `git remote add upstream …` |
| Can be private | **No** — GitHub forks of a public repo cannot be made private | **Yes** |
| Contribute back upstream | One click to open a PR | Possible but awkward |
| Git mechanics | Identical | Identical |

**Recommendation:** if the repo can be public, **fork `pdovhomilja/nextcrm-app`**. The upstream
relationship is the whole point of this exercise, and the fork makes it a first-class thing GitHub
helps you with rather than something you have to remember.

If it must be private, clone and push to a new private repo, then immediately:

```bash
git remote add upstream https://github.com/pdovhomilja/nextcrm-app.git
git fetch upstream
```

Either way — **create a brand-new repository. Do not reset the existing one.** The current site
must keep running while you build the new one, and you will want the old repo readable for
reference (the Lambda contracts, the field mappings, the `restore-customizations.sh` manifest).

Suggested name: `nextcrm-rb2` or similar — something that makes it obvious in the GitHub UI which
of the two is the live one.

### 1.2 The zero-drift contract

This is the part to actually enforce. Write it into the new repo's `AGENTS.md` on day one so that
every agent session inherits it.

**Rule 1 — Additive directories only.** All custom code lives in paths upstream does not use:

```
netlify/functions/          ← ingestion endpoints, scheduled jobs   (upstream: does not exist)
netlify/database/migrations/← custom table DDL                       (upstream: does not exist)
netlify.toml                ← build + function config                (upstream: does not exist)
docs/rb/                    ← your docs                              (upstream: does not exist)
```

**Rule 2 — Custom database objects are namespaced and unowned by Prisma.** Every table you add is
prefixed `rb_` and is created by a Netlify migration, not by `prisma/schema.prisma`. Prisma never
learns these tables exist. See §4.3 for why this is safe and the one caveat.

**Rule 3 — No new npm dependencies.** Everything the ingestion functions need is already in
upstream's `package.json`: `pg` (8.x), `@types/pg`, and `zod` (4.x). Adding a dependency means
editing `package.json` and regenerating `pnpm-lock.yaml`, and the lockfile is the single most
conflict-prone file in any fork. Avoid it.

**Rule 4 — Every unavoidable upstream-file edit is logged.** One file, `docs/rb/UPSTREAM-DELTA.md`,
lists each edit with the file, the reason, and the exact diff. If the list ever exceeds five
entries, stop and redesign — you are drifting again.

**Rule 5 — Sync on a cadence, not on demand.** Once a month, or whenever upstream cuts a release:

```bash
git fetch upstream
git switch -c sync/upstream-$(date +%Y%m%d) dev
git merge upstream/main
# conflicts should be zero; if not, the delta log in Rule 4 tells you what to expect
git push origin HEAD          # deploy preview builds against a branched DB copy
```

### 1.3 What from the old fork to deliberately leave behind

| Old customization | Verdict |
| ----------------- | ------- |
| `crm_Targets` Stripe/post-purchase columns (10 fields) + its migration | **Drop.** Targets was the wrong home for buyers. Accounts + Contracts replaces it. |
| `crm_Contacts` RB columns (13 fields) + implied migration | **Drop** unless §5.4 (do buyers also get a Contact?) says otherwise, and even then use `rb_external_refs`. |
| `crm_campaign_steps.content_html` + migration | **Drop.** Campaign email now lives in Listmonk. |
| `/api/crm/targets/ingest`, `/api/crm/contacts/ingest` | **Replace** with the Netlify Functions in §7. |
| Amazon Connect import fields + scripts | **Drop** unless still in use. |
| `inngest/functions/campaigns/post-purchase-batch.ts` | **Drop.** Already marked deprecated/non-functional. |
| `migrate resolve --rolled-back 20260415164939_invoices_module` in the build script | **Drop.** It was a one-time reconciliation for a database that no longer exists. On an empty DB, upstream's plain build script is correct — **so `package.json` needs no edit at all.** |
| `lib/prisma.ts` / `prisma.config.ts` Neon fallback chain | **Keep, inverted.** See §4.2 — it is the only code edit worth making, and it is 4 lines. |
| Netlify Blobs storage swap (14 files: `lib/storage.ts`, uploaders, invoice PDF, document delete, MCP tool, thumbnails…) | **Defer — do not re-apply.** See §1.4. This is the biggest single simplification available to you. |

### 1.4 The file-storage decision (the 14-file question)

The Blobs swap is, by file count, 80% of the current fork's merge burden. Three options:

- **(a) Point upstream's S3 client at an S3-compatible bucket — zero code changes.**
  Upstream's `lib/minio.ts` is a plain `@aws-sdk/client-s3` `S3Client` with `forcePathStyle: true`.
  Set `MINIO_ENDPOINT` / `MINIO_BUCKET` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` /
  `NEXT_PUBLIC_MINIO_ENDPOINT` to a bucket and it works untouched. **Cloudflare R2 or DigitalOcean
  Spaces are the safest targets** because they fully support path-style addressing; AWS S3 works
  today but has path-style flagged as deprecated.
- **(b) Re-apply the Netlify Blobs swap.** Platform-native, no extra vendor, no keys — but it is
  14 shared files of permanent merge surface, and it is the reason updating hurts today.
- **(c) Defer.** Document upload, invoice PDFs, and thumbnails are **not on the critical path for
  Accounts/Contracts ingestion.** Ship the ingestion first with storage unconfigured; those
  features simply error until you configure them.

**Recommendation: (c) now, (a) later.** You already run AWS Lambdas, so a bucket is a five-minute
task when you get there — and it keeps the "zero shared-file edits" property intact.

---

## 2. Target architecture

```
                Stripe                       Carrier / fulfilment
                  │                                   │
                  ▼ webhook (signed)                  ▼
        ┌───────────────────────┐          ┌───────────────────────┐
        │  AWS Lambda           │          │  AWS Lambda           │
        │  verifies signature,  │          │  normalises tracking  │
        │  normalises payload   │          │  events               │
        └──────────┬────────────┘          └──────────┬────────────┘
                   │ POST + Bearer nxtc__…            │
                   │ + Idempotency-Key: evt_…         │
                   ▼                                  ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  Netlify site: nextcrm-netlify-deployment                        │
   │                                                                  │
   │  netlify/functions/ingest-transaction.mts   ← YOURS, additive    │
   │  netlify/functions/ingest-shipment.mts      ← YOURS, additive    │
   │  netlify/functions/ingest-health.mts        ← YOURS, additive    │
   │  netlify/functions/ingest-retention.mts     ← YOURS, scheduled   │
   │                                                                  │
   │  Next.js app (upstream, unmodified) ── Prisma ──┐                │
   └──────────────────────────────────────────┬──────┼────────────────┘
                                              │      │
                                              ▼      ▼
                              ┌────────────────────────────────────┐
                              │  Netlify DB (managed Postgres)     │
                              │                                    │
                              │  crm_* , Users, Invoices, …        │
                              │      owned by Prisma migrations    │
                              │  rb_ingest_events, rb_external_refs│
                              │      owned by Netlify migrations   │
                              └────────────────────────────────────┘
```

The two function families and the Next.js app share one database and one schema, but **own
disjoint sets of tables**. That disjointness is what lets two migration engines coexist.

### 2.1 Why Netlify Functions rather than Next.js API routes

You have used `app/api/crm/*/ingest/route.ts` until now. Moving to functions is the change that
delivers your stated top priority.

| | Netlify Function (`netlify/functions/`) | Next.js route (`app/api/…`) |
| - | --------------------------------------- | --------------------------- |
| Upstream merge surface | **Zero** — upstream has no such directory | Low but nonzero; upstream reorganises `app/api` periodically |
| DB access | `pg` `Pool` (already a dependency) or one transaction of raw SQL | Prisma client, fully typed |
| Transactional control | Full — one `BEGIN…COMMIT` across ledger + business rows | Full, via `prismadb.$transaction` |
| Type safety against `crm_*` | **None** — hand-written SQL | Full |
| Cold start | Small, standalone bundle | Rides the Next.js server bundle |
| Cost | Hand-written SQL must track upstream column changes | Couples your code to upstream's file layout |

**Recommendation: Netlify Functions.** The cost — hand-written SQL — is smaller than it looks:
the columns you touch on `crm_Accounts` and `crm_Contracts` have been stable since the initial
migration and are load-bearing for the entire app, so upstream renaming them would be a
project-wide breaking change. §11.3 specifies a deploy-preview smoke test that catches it anyway.

### 2.2 Routing note — verify this on the first deploy preview

A function declaring `config.path = "/api/ingest/v1/transaction"` should win over the Next.js
catch-all, because Netlify resolves function paths before handing the request to the Next.js
runtime handler. **Confirm this empirically on the first deploy preview before pointing the
Lambdas at it.** If it does not resolve, two guaranteed-safe fallbacks:

1. Drop the `/api` prefix: `config.path = "/ingest/v1/transaction"` — Next.js has no route there.
2. Use the default function URL: `/.netlify/functions/ingest-transaction` — always works.

Keep the Lambda's base URL in a single environment variable so a change is a Lambda config edit,
not a code edit.

---

## 3. Prerequisites and decisions to confirm

These are yours to decide; the plan below assumes the **Recommended** column. If any differ, the
affected sections are noted.

| # | Decision | Options | Recommended | Affects |
| - | -------- | ------- | ----------- | ------- |
| D1 | Repo visibility | public fork / private clone | Public fork | §1.1 |
| D2 | Ingestion code location | Netlify Functions / Next.js routes | **Functions** | §2.1, §7 |
| D3 | Do buyers also get a `crm_Contacts` record? | Account only / Account + Contact | **Account + Contact** for named individuals; see §5.4 | §5.4, §7.2 |
| D4 | Contract natural key | checkout session id / payment intent id | **Checkout session id**, with PI recorded as a second ref | §5.3, §6.4 |
| D5 | File storage | defer / S3-compatible / Blobs | **Defer** | §1.4 |
| D6 | Endpoint auth | DB-backed `nxtc__` token / shared-secret HMAC | **`nxtc__` token**, HMAC optional second factor | §8 |
| D7 | Prisma connection patch | 4-line patch / set `DATABASE_URL` and lose preview DB branching | **Patch** | §4.2 |

---

## 4. Database: Neon → Netlify DB

### 4.1 What Netlify DB gives you

Netlify DB is managed Postgres (Neon-backed), provisioned on first connection. It injects two
connection strings automatically — you never set them by hand:

- `NETLIFY_DATABASE_URL` — **pooled** (PgBouncer). Use for application runtime.
- `NETLIFY_DATABASE_URL_UNPOOLED` — **direct**. Use for migrations.

> **This distinction is not cosmetic.** `prisma migrate deploy` opens advisory locks and runs DDL
> in a session that PgBouncer's transaction-pooling mode will break. Migrations must use the
> unpooled URL. This is the most common way a Prisma-on-pooled-Postgres setup fails, and it fails
> intermittently, which makes it miserable to debug.

Production deploys hit the main database. **Deploy previews get their own database branch seeded
from production** — automatic, nothing to configure. That is a meaningful upgrade over the current
setup, where a preview would happily write to live Neon.

### 4.2 Making Prisma find it (D7)

Upstream's `lib/prisma.ts` and `prisma.config.ts` read `DATABASE_URL` only. Two ways to bridge:

**Option A — set `DATABASE_URL` in the Netlify UI to the Netlify DB connection string.**
Zero code changes. **Cost: you lose deploy-preview database branching**, because a hardcoded value
cannot follow the dynamically-created preview branch. Every preview then writes to production.
For a CRM holding real customer records, that is not acceptable.

**Option B — a 4-line precedence patch (recommended).**

`lib/prisma.ts` (runtime — prefer pooled):

```ts
const connectionString =
  process.env.NETLIFY_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "";
```

`prisma.config.ts` (CLI and migrations — prefer unpooled):

```ts
url:
  process.env.NETLIFY_DATABASE_URL_UNPOOLED ??
  process.env.DATABASE_URL ??
  "",
```

Note the ordering is **inverted** from your current fork, which puts `DATABASE_URL` first. Netlify
first is what makes preview branching work. Both files also keep the `?? ""` fallback so
`npx prisma format` / `validate` work locally with no database configured.

This is the entire upstream-file delta. Record it in `docs/rb/UPSTREAM-DELTA.md`. Both files are
small and upstream changes them rarely, so future merge conflicts here will be trivial.

### 4.3 Two migration engines, one database

| Engine | Owns | Runs when | Files |
| ------ | ---- | --------- | ----- |
| **Prisma** | `crm_*`, `Users`, `Invoices`, `Currency`, Better Auth tables — everything upstream | Build time, via `prisma migrate deploy` in the build script | `prisma/migrations/` |
| **Netlify** | `rb_*` only | Immediately before publish | `netlify/database/migrations/` |

Why this is safe:

- `prisma migrate deploy` applies only the migrations listed in `prisma/migrations/`. It does not
  diff the live schema and it **never drops tables it does not know about.** Your `rb_*` tables are
  invisible to it and survive every deploy.
- The `rb_*` tables declare **no foreign keys into `crm_*` tables** (see §6.2). That is deliberate:
  it removes any ordering dependency between the two engines, so it does not matter that Prisma
  runs at build time and Netlify runs at publish time.

**The one caveat — never run `prisma migrate dev` against this database.** Unlike `deploy`,
`migrate dev` diffs the live schema against `schema.prisma` and will generate `DROP TABLE`
statements for the `rb_*` tables it does not recognise. Your current workflow already never uses a
local database, so this is a discipline note rather than a change. Put it in `AGENTS.md`.

Related hazard, inherited from the current setup and worth knowing: **Prisma migrations are applied
during the build, so they land even if the deploy later fails to publish.** A failed Netlify
migration blocks publishing but does not roll back Prisma's DDL. Take a Netlify DB restore point
before any deploy that changes `prisma/migrations/`.

### 4.4 A note on the Netlify DB skill's Drizzle recommendation

Netlify's `netlify-database` skill recommends Drizzle ORM. That is the right default for a
greenfield project. It is **not** right here: NextCRM is ~90 Prisma models with a long migration
history, and converting it would be exactly the kind of deep customization you are trying to
eliminate. Netlify DB is plain Postgres, and Prisma connects to it like any other Postgres.

The `rb_*` tables use raw SQL migrations and the `pg` driver — no ORM, no new dependency. This
matches the skill's documented "native driver" path.

---

## 5. Data model: buyer → Account, transaction → Contract, shipment → Activity

### 5.1 Buyer → `crm_Accounts`

| Source (Stripe) | Column | Note |
| --------------- | ------ | ---- |
| company name, else `"First Last"` | `name` **NOT NULL** | Fall back to the email local-part if both are absent |
| `customer.email` | `email` | |
| `customer.phone` | `office_phone` | |
| `address.*` | `billing_street/city/state/postal_code/country` | |
| `shipping.address.*` | `shipping_street/city/state/postal_code/country` | |
| — | `type` | `'Customer'` (DB default) |
| — | `status` | `'Active'` — override the `'Inactive'` default |
| — | `company_id`, `vat` | Leave alone; **do not** repurpose `company_id` for the Stripe id |
| — | `createdBy` | Service-user UUID from `RB_INGEST_SERVICE_USER_ID` |

**Two raw-SQL gotchas, confirmed against `prisma/migrations/0_init/migration.sql`:**

1. `"id" UUID NOT NULL` — **no database default.** Prisma generates UUIDs client-side. Raw inserts
   must supply `gen_random_uuid()` explicitly.
2. `"__v" INTEGER NOT NULL` — **no default** on `crm_Accounts` and `crm_Contracts` (unlike
   `crm_Leads`, which defaults to 0). Raw inserts must pass `0`.

Miss either and the insert fails with a not-null violation that reads as a mystery.

The Stripe customer id does **not** go in a column on `crm_Accounts`. It goes in `rb_external_refs`
(§6.2). That is what keeps `prisma/schema.prisma` untouched.

### 5.2 Is an Account the right home for an individual buyer?

In NextCRM's data model an Account is a company and a Contact is a person. Recording an individual
consumer as an Account is a deliberate reinterpretation: "Account = the counterparty I transact
with." This works, and it is the right call given that Contracts hang off Accounts and not
Contacts — but two consequences are worth accepting up front:

- Account-level UI reads as company-oriented (annual revenue, employees, industry, VAT). Those
  fields simply stay empty for consumer buyers.
- Reporting that assumes "Accounts ≈ companies" will now count individuals. Use `crm_Accounts.type`
  or a tag convention to distinguish B2B from B2C if that matters downstream.

### 5.3 Transaction → `crm_Contracts`

| Source | Column | Note |
| ------ | ------ | ---- |
| `"Order " + order_ref` or a line-item summary | `title` **NOT NULL** | |
| `amount_total` ÷ currency exponent | `value` `DECIMAL(18,2)` **NOT NULL** | Lambda sends **integer minor units**; the function divides. Never send floats. |
| `currency` upper-cased | `currency` `VARCHAR(3)` | **FK to `Currency(code)`** — see the warning below |
| — | `status` | `'SIGNED'` — the enum is only `NOTSTARTED \| INPROGRESS \| SIGNED`, and a completed purchase is a signed contract |
| completion timestamp | `startDate` | |
| resolved Account | `account` | |
| — | `type` | `'stripe_order'` (free-text) |
| — | `id`, `"__v"` | Same two gotchas as §5.1 |

> **Currency FK warning.** `crm_Contracts.currency` has a foreign key to `Currency(code)`, and
> upstream's migration seeds only **EUR, USD, CZK**. A `GBP` or `CAD` order will fail the insert.
> Two mitigations, apply both: seed the currencies you actually transact in during bootstrap
> (§10, Phase 3), *and* have the function safety-net with
> `INSERT INTO "Currency" (code, name, symbol, "isEnabled", "isDefault", "createdAt", "updatedAt")
> VALUES (…, true, false, now(), now()) ON CONFLICT (code) DO NOTHING` before inserting the
> Contract. The FK is `ON DELETE SET NULL` and the column is nullable, so leaving it NULL is also
> survivable — but then the value loses its unit, which is worse.
>
> Also note **zero-decimal currencies** (JPY, KRW): `amount_total` is already the major unit, so
> do not divide by 100. Keep the exponent table in the Lambda or the function, not in both.

**Line items → `crm_ContractLineItems`** (optional; include if you want per-SKU reporting). This
table is stricter: `createdBy UUID NOT NULL`, `currency VARCHAR(3) NOT NULL`, and `updatedAt` is
Prisma-managed (`@updatedAt`), which means it is **not** populated by the database — raw SQL must
set it explicitly.

### 5.4 Should there also be a Contact? (D3)

Recommended: **yes, for named individuals** — create one `crm_Contacts` row linked to the Account
via `accountsIDs`. Reasons: the Account page's Contacts tab is where a human looks for "who is this
person," and email/campaign tooling in the app operates on Contacts, not Accounts.

Keep it minimal — `first_name`, `last_name` (NOT NULL), `email`, `mobile_phone`, `accountsIDs`,
`account`, `createdBy` — and dedupe it through `rb_external_refs` on the same Stripe customer id.
Skip it for purely corporate purchases with no named buyer. Note `crm_Contacts.id` has no DB
default either.

### 5.5 Shipment → `crm_Activities` + `crm_ActivityLinks`

`crm_Activity_Type` is a Postgres enum with exactly four values: `call | meeting | note | email`.
There is no shipment type, and adding one means editing `prisma/schema.prisma` — the thing we are
avoiding. Use `note` and put the semantics in the payload:

```
type        = 'note'
title       = 'Shipment in transit — UPS 1Z999AA10123456784'
description = human-readable summary
date        = the carrier event timestamp
status      = 'completed' for delivered/returned/exception, else 'scheduled'
metadata    = { kind: 'shipment', carrier, tracking_number, tracking_url,
                status, shipped_at, estimated_delivery, delivered_at, raw: {…} }
```

`metadata` is `JSONB`, so it is queryable — a shipment report is a
`WHERE metadata->>'kind' = 'shipment'` away.

Then link it. `crm_ActivityLinks.entityType` uses the vocabulary defined in
`actions/crm/activities/create-activity.ts`: `account | contact | lead | opportunity | contract`.
Insert **two** rows — one `contract` link and one `account` link — so the shipment shows on both
timelines in the existing UI with no front-end work.

`crm_Activities.id` and `crm_ActivityLinks.id` **do** have `DEFAULT gen_random_uuid()`, unlike the
CRM core tables. Inconsistent, but in your favour here.

**One Activity per status transition, not one per shipment.** Activities are an append-only
timeline; that is the whole point of the entity. Dedupe on `(tracking_number, status)` so a repeated
"in_transit" poll does not add a row.

---

## 6. Idempotency — the recommendation, and the design

### 6.1 Yes, and here is the specific reasoning

Whoever advised you was right, and the reason is sharper than "webhooks can duplicate":

1. **Stripe's delivery guarantee is at-least-once.** Any non-2xx response triggers retries with
   exponential backoff for up to three days in live mode. A timeout at second 11 of a request that
   actually committed at second 9 produces a duplicate. This is a normal Tuesday.
2. **Your old design was accidentally immune.** `/api/crm/targets/ingest` upserted keyed on email:
   replaying an event rewrote the same row. Nothing broke, so the problem never surfaced.
3. **The new design is not.** A Contract is a per-transaction record with no natural unique
   constraint. Replay it and you get two Contracts for one order, and every revenue number is
   wrong. Worse, it is silent — nothing errors.
4. **Your Lambdas add a second retry layer.** Async invocations and SQS-triggered Lambdas retry
   independently of Stripe. Two retry layers multiply.
5. **Duplicates can arrive concurrently**, which is why the mechanism must be a database
   constraint, not an application-level "check then write." A `SELECT` followed by an `INSERT` has
   a race window; a unique index does not.
6. **A ledger is also your operational record.** When someone asks "did order 1043 make it into the
   CRM?", the answer is one query rather than an archaeology expedition through Stripe's dashboard
   and your Netlify logs.

The counter-argument — "just make the write itself idempotent with a unique constraint on the
Contract" — is worth taking seriously, and it is *part* of the answer (§6.2's `rb_external_refs`
does exactly that). But it does not cover: distinguishing "already done" from "in flight,"
returning the original IDs on replay, recording *why* an event failed, or handling events that
touch several tables. Build both. They are complementary, not alternatives.

### 6.2 Schema — two tables, both `rb_`-prefixed

`netlify/database/migrations/20260821120000_create-rb-ingest-tables.sql`:

```sql
-- Idempotency ledger + audit trail for all external ingestion.
CREATE TABLE IF NOT EXISTS rb_ingest_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text        NOT NULL,           -- 'stripe' | 'shipping' | …
  event_id      text        NOT NULL,           -- Stripe evt_… or carrier event id
  event_type    text,                           -- 'checkout.session.completed'
  status        text        NOT NULL DEFAULT 'in_progress',
  request_hash  text        NOT NULL,           -- sha256 of the canonical body
  payload       jsonb,                          -- as received; the replay source of truth
  result        jsonb,                          -- {account_id, contract_id, …}
  error         text,
  attempts      integer     NOT NULL DEFAULT 1,
  claimed_at    timestamptz NOT NULL DEFAULT now(),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  CONSTRAINT rb_ingest_events_key UNIQUE (source, event_id),
  CONSTRAINT rb_ingest_events_status_chk
    CHECK (status IN ('in_progress', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS rb_ingest_events_status_claimed_idx
  ON rb_ingest_events (status, claimed_at);
CREATE INDEX IF NOT EXISTS rb_ingest_events_first_seen_idx
  ON rb_ingest_events (first_seen_at DESC);

-- Stable mapping from external system identifiers to NextCRM entity UUIDs.
-- Deliberately has NO foreign keys into crm_* tables: that independence is what
-- lets the Prisma and Netlify migration runners coexist without ordering rules.
CREATE TABLE IF NOT EXISTS rb_external_refs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system        text NOT NULL,                  -- 'stripe'
  external_kind text NOT NULL,                  -- 'customer'|'checkout_session'|'payment_intent'|'shipment_status'
  external_id   text NOT NULL,
  entity_type   text NOT NULL,                  -- 'account'|'contact'|'contract'|'activity'
  entity_id     uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rb_external_refs_key UNIQUE (system, external_kind, external_id)
);

CREATE INDEX IF NOT EXISTS rb_external_refs_entity_idx
  ON rb_external_refs (entity_type, entity_id);
```

`rb_external_refs` earns its keep three times over: it is the Account dedupe key, the Contract
duplicate guard, and the shipment→Contract resolver — one table, one unique index, no changes to
any upstream table.

### 6.3 The claim — one statement, race-free

```sql
WITH prev AS (
  SELECT status, result, request_hash
  FROM rb_ingest_events
  WHERE source = $1 AND event_id = $2
)
INSERT INTO rb_ingest_events (source, event_id, event_type, request_hash, payload)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (source, event_id) DO UPDATE SET
  attempts     = rb_ingest_events.attempts + 1,
  last_seen_at = now(),
  status       = CASE
                   WHEN rb_ingest_events.status = 'failed' THEN 'in_progress'
                   WHEN rb_ingest_events.status = 'in_progress'
                        AND rb_ingest_events.claimed_at < now() - interval '5 minutes'
                     THEN 'in_progress'
                   ELSE rb_ingest_events.status
                 END,
  claimed_at   = CASE
                   WHEN rb_ingest_events.status = 'failed'
                     OR (rb_ingest_events.status = 'in_progress'
                         AND rb_ingest_events.claimed_at < now() - interval '5 minutes')
                     THEN now()
                   ELSE rb_ingest_events.claimed_at
                 END
RETURNING
  id,
  status,
  (SELECT status       FROM prev) AS prev_status,   -- NULL ⇒ this call created the row
  (SELECT result       FROM prev) AS prev_result,
  (SELECT request_hash FROM prev) AS prev_hash;
```

The `prev` CTE reads the pre-statement snapshot, so `prev_status IS NULL` cleanly means "we are the
first." No `xmax` tricks, no second round-trip.

### 6.4 Control flow

```
BEGIN;
  ── claim (§6.3) ────────────────────────────────────────────────────────────
  prev_status IS NULL            → we own it, proceed
  prev_status = 'succeeded'      → ROLLBACK; 200 { idempotent_replay: true, ...prev_result }
  prev_status = 'failed'         → reclaimed, proceed (transient failures deserve a retry)
  prev_status = 'in_progress'
        and claim was stale      → reclaimed, proceed
        and claim is fresh       → ROLLBACK; 409 + Retry-After: 30

  prev_hash present and ≠ request_hash
                                 → ROLLBACK; 422. Same event id, different body is a real bug
                                   upstream — surface it loudly rather than silently picking one.

  ── the work, same transaction ──────────────────────────────────────────────
  ensure Currency row exists                       (ON CONFLICT DO NOTHING)
  resolve or create Account                        (via rb_external_refs, then email fallback)
  resolve or create Contact                        (D3)
  insert Contract  (+ line items)
  insert rb_external_refs rows for customer / session / payment_intent
  UPDATE rb_ingest_events
     SET status='succeeded', result=$…, completed_at=now()
   WHERE id = <claim id>;
COMMIT;
```

**Everything in one transaction is the crux.** The ledger row and the business rows commit together
or not at all, so "marked done but nothing written" and "written but not marked" are both
structurally impossible.

A pleasant consequence worth understanding: because the claim `INSERT` is inside the transaction, a
genuinely concurrent duplicate delivery **blocks on the unique index** until the first transaction
resolves, then re-evaluates and sees `succeeded`. Postgres serialises the race for you. The
`in_progress` state is therefore mostly an observability aid — but keep it, because it is what makes
a crashed function visible in a dashboard, and it is what you need if the work ever grows large
enough to split across transactions.

**On failure:** `ROLLBACK`, then mark the failure on a *separate* connection —

```sql
INSERT INTO rb_ingest_events (source, event_id, event_type, request_hash, payload, status, error, completed_at)
VALUES ($1,$2,$3,$4,$5,'failed',$6, now())
ON CONFLICT (source, event_id) DO UPDATE
  SET status = 'failed', error = EXCLUDED.error, last_seen_at = now();
```

— otherwise the rollback erases the evidence along with the work. This is the only place a second
connection is warranted.

### 6.5 Status codes, and why each one

| Situation | Status | Does Stripe/Lambda retry? | Rationale |
| --------- | ------ | ------------------------- | --------- |
| Created | `201` | no | |
| Replay of a success | `200` | no | Return the **original** IDs, not a bare "seen" — the caller may need them |
| Concurrent delivery in flight | `409` + `Retry-After: 30` | yes | Let the other transaction finish |
| Malformed body / missing key | `400` | no | Retrying will not fix a broken payload |
| Bad or revoked token | `401` | no | |
| Same event id, different body | `422` | no | Signals a bug in the Lambda; needs a human |
| Semantic failure (unknown currency, missing service user) | `422` | no | Recorded as `failed` with the payload, replayable by hand |
| Unexpected error | `500` | yes | Genuinely transient; the ledger makes the retry safe |

The design principle: **retry only what a retry can fix.** Everything else is recorded with its
payload so it can be replayed deliberately once the cause is fixed.

### 6.6 Retention

`rb_ingest_events.payload` holds customer PII, so it is not something to keep forever by default.
A scheduled Netlify Function (`config.schedule = "17 4 * * *"`) prunes:

- `status = 'succeeded'` older than **90 days** → delete (the Account/Contract/Activity rows are the
  durable record; `rb_external_refs` keeps the mapping permanently)
- `status = 'failed'` older than **1 year** → delete
- `status = 'in_progress'` older than **1 day** → mark `failed` with `error = 'abandoned'`

Adjust the windows to your data-retention policy. Off-by-one hour on the cron; nothing here needs
to run at midnight.

---

## 7. Endpoint specifications (the Lambda contract)

Freeze these before refactoring the Lambdas. Version the path (`/v1/`) so a future shape change is
additive.

### 7.1 Common

**Headers**

```
Authorization:   Bearer nxtc__<48 hex chars>
Idempotency-Key: evt_1Abc…            ← REQUIRED; the Stripe event id
Content-Type:    application/json
```

If `Idempotency-Key` is absent, fall back to `body.event_id`; if both are absent, **reject with
400**. Never synthesise a key — a synthesised key defeats the entire mechanism.

**Amounts** are integers in the currency's minor unit. **Timestamps** are ISO-8601 UTC.
**Currency codes** are ISO-4217, case-insensitive on the wire, upper-cased on write.

### 7.2 `POST /api/ingest/v1/transaction`

```jsonc
{
  "source": "stripe",
  "event_id": "evt_1AbcDEF…",
  "event_type": "checkout.session.completed",
  "occurred_at": "2026-08-21T14:03:11Z",

  "buyer": {
    "stripe_customer_id": "cus_ABC123",     // primary dedupe key
    "email": "buyer@example.com",           // fallback dedupe key
    "company_name": "Acme Trading Ltd",     // null for B2C
    "first_name": "Jane",
    "last_name": "Doe",
    "phone": "+1-555-0100",
    "is_b2b": true,
    "billing":  { "street": "…", "city": "…", "state": "…", "postal_code": "…", "country": "US" },
    "shipping": { "street": "…", "city": "…", "state": "…", "postal_code": "…", "country": "US" }
  },

  "transaction": {
    "external_id": "cs_test_a1b2c3",        // checkout session id — the Contract's natural key (D4)
    "external_kind": "checkout_session",
    "payment_intent_id": "pi_1Xyz…",        // recorded as a second ref
    "order_ref": "1043",
    "amount_total": 129900,                 // integer minor units
    "currency": "usd",
    "completed_at": "2026-08-21T14:03:05Z",
    "description": "Order #1043",
    "line_items": [
      { "sku": "WID-100", "name": "Widget", "quantity": 2,
        "unit_amount": 49950, "amount_total": 99900 }
    ],
    "metadata": { "channel": "web" }
  }
}
```

**Response `201` / `200`**

```jsonc
{
  "ok": true,
  "idempotent_replay": false,
  "event_id": "evt_1AbcDEF…",
  "account":  { "id": "…uuid…", "created": true },
  "contact":  { "id": "…uuid…", "created": true },   // omitted if D3 = Account only
  "contract": { "id": "…uuid…", "created": true }
}
```

**Errors:** `{ "ok": false, "error": { "code": "…", "message": "…", "event_id": "…" } }`
with the codes from §6.5. Validate the body with `zod` (already a dependency) and return the
first validation failure as `error.message` — the Lambda's logs are where this gets debugged.

### 7.3 `POST /api/ingest/v1/shipment`

```jsonc
{
  "source": "shipping",
  "event_id": "shp_1Abc…",                  // stable per carrier status transition
  "occurred_at": "2026-08-23T09:14:00Z",

  "reference": {
    "transaction_external_id": "cs_test_a1b2c3",  // preferred: resolves via rb_external_refs
    "payment_intent_id": "pi_1Xyz…",              // fallback
    "stripe_customer_id": "cus_ABC123"            // last resort: links to the Account only
  },

  "shipment": {
    "carrier": "UPS",
    "tracking_number": "1Z999AA10123456784",
    "tracking_url": "https://www.ups.com/track?tracknum=1Z999AA10123456784",
    "status": "in_transit",                 // label_created|in_transit|out_for_delivery|delivered|exception|returned
    "shipped_at": "2026-08-22T18:00:00Z",
    "estimated_delivery": "2026-08-25",
    "delivered_at": null,
    "items": [{ "sku": "WID-100", "quantity": 2 }]
  }
}
```

Behaviour: resolve Contract and Account through `rb_external_refs`; insert one `crm_Activities`
row (§5.5) plus two `crm_ActivityLinks` rows; record
`rb_external_refs(system='shipping', external_kind='shipment_status',
external_id='<tracking_number>:<status>')` so a repeated poll of the same status is a no-op.
Same ledger, same status codes.

**If the reference does not resolve** — the shipment event beat the transaction event, which
happens — return `409` + `Retry-After: 300` and record `status='failed'`,
`error='unresolved_reference'`. The Lambda retries; the retention job surfaces anything still
unresolved after a day.

### 7.4 `GET /api/ingest/v1/health`

Token-protected. Returns `{ ok, db: "up", rb_tables: true, service_user: true, now }`.
Have the Lambda deployment pipeline call it before cutover — it catches a missing service user or
an unapplied migration in one request instead of at the first live order.

---

## 8. Authentication (D6)

**Primary: DB-backed `nxtc__` bearer tokens.** Reuse upstream's `ApiToken` table exactly as your
current endpoints do — SHA-256 the presented token, look up `"ApiToken"."tokenHash"`, reject if
`revokedAt IS NOT NULL` or `expiresAt < now()`. Tokens are minted and revoked from the NextCRM UI,
which means rotating a Lambda credential is a UI action and not a redeploy.

Reimplement the ~15 lines of hash-and-lookup in the function rather than importing
`lib/api-tokens.ts` — importing app code from a Netlify Function drags in the Prisma client and its
build step. The hash is a plain `crypto.createHash("sha256").update(raw).digest("hex")`; the token
prefix is `nxtc__`.

Bootstrap ordering matters here: an empty database has no users, so no tokens. Sequence is
create admin user → create service user → mint token → configure Lambda. Covered in §10, Phase 3.

**Optional second factor: HMAC over the raw body.** Set `RB_INGEST_HMAC_SECRET` on both sides, have
the Lambda send `X-RB-Signature: sha256=<hex>` over the exact bytes, and verify with
`crypto.timingSafeEqual`. Worth adding if these endpoints ever face the open internet without a WAF;
skip it for v1 if the token is well-managed.

**Always do:** rate-limit by token (a simple counter in `rb_ingest_events` per minute is enough),
log every rejected request with the token *prefix* only, and cap request body size (~256 KB).

---

## 9. Configuration

### 9.1 `netlify.toml` — new file, pure addition

```toml
[build]
  command = "pnpm build"

[build.environment]
  NODE_VERSION = "22"

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"
  external_node_modules = ["pg"]
```

`external_node_modules = ["pg"]` keeps esbuild from trying to bundle `pg`'s optional native
`pg-native` path, which is a well-known bundling failure. Note the repo's `.nvmrc` says `20` while
the build environment reports Node 22 — pinning it here removes the ambiguity.

### 9.2 Environment variables (names only)

**Injected automatically by Netlify DB — do not set by hand:**
`NETLIFY_DATABASE_URL`, `NETLIFY_DATABASE_URL_UNPOOLED`

**Required:**

| Variable | Purpose |
| -------- | ------- |
| `BETTER_AUTH_SECRET` | Session signing |
| `BETTER_AUTH_URL` | Must match the deployed origin |
| `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_APP_DOMAIN`, `NEXT_PUBLIC_APP_NAME` | App identity |
| `RB_INGEST_SERVICE_USER_ID` | UUID stamped as `createdBy` on ingested rows — makes machine-created records distinguishable in audit views |
| `RB_INGEST_DEFAULT_CURRENCY` | Fallback when a payload omits currency |

**Optional / feature-gated:** `RB_INGEST_HMAC_SECRET`; `RESEND_API_KEY` + `RESEND_FROM_EMAIL`;
`GOOGLE_ID` + `GOOGLE_SECRET`; the `INNGEST_*` family; `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
`FIRECRAWL_API_KEY`; the `MINIO_*` family once §1.4 option (a) is adopted.

**Deliberately absent:** no `DATABASE_URL` (§4.2 option B makes it unnecessary), no Stripe keys —
all Stripe logic stays in the Lambda, and NextCRM never sees a Stripe secret. That property is
worth preserving.

---

## 10. Implementation plan

Each phase ends in a verifiable state. Do not start the next until the current one is green.

### Phase 0 — Decide (30 min)
Answer D1–D7 in §3. Record the answers at the top of `docs/rb/UPSTREAM-DELTA.md` in the new repo.

### Phase 1 — Repo and site (1–2 h)
1. Fork or clone upstream (§1.1); add the `upstream` remote; create the `dev` branch.
2. Copy in `AGENTS.md` with the §1.2 zero-drift contract as section 1, and this document as
   `docs/2026-NextCRM-Accounts-Contracts-Netlify.md`.
3. Create a **new** Netlify site from the new repo. Leave the current site running.
4. Add `netlify.toml` (§9.1).
5. Set the required environment variables (§9.2) — deliberately *not* `DATABASE_URL`.

**Done when:** the site exists and a build starts.

### Phase 2 — First green deploy on an empty Netlify DB (1–2 h)
1. Apply the §4.2 option B patch to `lib/prisma.ts` and `prisma.config.ts`; log it in
   `UPSTREAM-DELTA.md`.
2. Push `dev`. The build runs `prisma generate && prisma migrate deploy && next build`, which
   applies the **entire upstream migration history** to the empty database.
3. Watch for the pooled-vs-unpooled failure mode (§4.1) — it is the likeliest failure here, and it
   presents as an intermittent advisory-lock or prepared-statement error, not as a clear message.

**Done when:** the deploy publishes and the login page renders.
**Do not proceed with a red build.** Every later phase assumes upstream's schema is fully applied.

### Phase 3 — Bootstrap the empty database (1 h)
1. Register the admin user through the app UI; promote to admin (upstream's `AppRole` enum).
2. Create a second user — `Ingestion Service` — and record its UUID as
   `RB_INGEST_SERVICE_USER_ID`.
3. Mint an API token in the UI for that service user. Store it in the Lambda's secret store.
   **Never in the repo, never in a Netlify build log.**
4. Seed the currencies you actually transact in beyond EUR/USD/CZK (§5.3).
5. Seed `crm_Industry_Type`, `crm_Contact_Types` etc. from `prisma/initial-data/` if the app needs
   them.

**Done when:** `curl` with the token reaches an authenticated endpoint.

### Phase 4 — Custom tables (30 min)
1. Write `netlify/database/migrations/20260821120000_create-rb-ingest-tables.sql` (§6.2 verbatim).
2. Push to a branch; Netlify applies it to the preview branch database before publish.
3. Verify with `netlify db status` and
   `netlify db connect --query "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'rb_%'"`.

**Done when:** both tables exist on the preview branch. Never run this DDL by hand — the migration
file is the only path.

### Phase 5 — `ingest-transaction` (1 day)
`netlify/functions/ingest-transaction.mts`. Suggested internal layout — keep helpers in the same
file or in `netlify/functions/_lib/` (the leading underscore keeps Netlify from treating it as a
function):

```
_lib/db.mts          pg Pool singleton on NETLIFY_DATABASE_URL, withTransaction()
_lib/auth.mts        bearer nxtc__ verification against "ApiToken"
_lib/ledger.mts      claim() / succeed() / fail()  (§6.3, §6.4)
_lib/refs.mts        rb_external_refs read/write
_lib/crm.mts         upsertAccount / upsertContact / insertContract / insertLineItems
                     ← the two raw-SQL gotchas from §5.1 live here
```

Verify §2.2 routing on the first deploy preview before writing much more.

**Done when:** a synthetic order creates one Account and one Contract, and **posting the identical
body five times still yields exactly one of each**, with calls 2–5 returning `200
idempotent_replay: true` and the same UUIDs.

### Phase 6 — `ingest-shipment` (half day)
As §7.3. Reuses everything in `_lib/`.

**Done when:** a shipment event appears on both the Contract and the Account timelines in the app
UI, and two `in_transit` polls produce one Activity.

### Phase 7 — health + retention (2 h)
`ingest-health.mts` (§7.4) and `ingest-retention.mts` (§6.6, `config.schedule`).

### Phase 8 — Lambda cutover (half day)
1. Point the Lambdas at the **deploy preview** URL first and replay a handful of real historical
   Stripe events. The preview writes to a branched database, so this is free.
2. Reconcile: every replayed event has a `succeeded` ledger row and the expected entities.
3. Repoint at production. Keep the old site and its Neon database **read-only but alive** for at
   least one full billing cycle.

### Phase 9 — Documentation and handover (2 h)
Write `docs/rb/RUNBOOK.md`: how to replay a failed event from `rb_ingest_events.payload`, how to
rotate the token, how to add a currency, how to run the monthly upstream sync (§1.2 Rule 5).

---

## 11. Verification

### 11.1 Idempotency — the test that matters
Post the same body 5× sequentially and 5× concurrently. Expect exactly one Account, one Contract,
one ledger row with `attempts = 10`, and identical UUIDs in every response. The concurrent half is
the real test: it exercises the unique-index serialisation described in §6.4.

### 11.2 Failure modes to exercise deliberately
Unknown currency · missing `Idempotency-Key` · same key with a mutated body (expect `422`) ·
revoked token · shipment referencing an unknown transaction · a deliberate mid-transaction crash
(confirm the rollback leaves no partial Account) · a >256 KB body.

### 11.3 Upstream-drift smoke test
A single `netlify db connect --query` in CI asserting that the columns the raw SQL depends on still
exist:

```sql
SELECT count(*) FROM information_schema.columns
WHERE table_name = 'crm_Contracts'
  AND column_name IN ('id','__v','title','value','currency','status','startDate','account','createdBy');
```

Expect 9. This is the mitigation for §2.1's one real cost, and it turns a silent runtime failure
into a build-time one.

### 11.4 Monthly upstream sync check
After each `git merge upstream/main`: conflicts should be zero; `git diff upstream/main --stat`
should list only additive paths plus the two files in `UPSTREAM-DELTA.md`; run 11.3.

---

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Pooled URL used for migrations | High | Build fails intermittently and confusingly | §4.2 — unpooled in `prisma.config.ts`, pooled in `lib/prisma.ts` |
| `crm_Accounts."__v"` / `"id"` not-null violations | High on first attempt | Every insert fails | §5.1 — both are supplied explicitly in `_lib/crm.mts` |
| Currency FK rejects a live order | Medium | That order does not land | §5.3 — seed ahead + `ON CONFLICT DO NOTHING` safety net |
| `/api/*` function routing loses to Next.js | Medium | Endpoints 404 | §2.2 — verify on the first preview; two fallbacks ready |
| `prisma migrate dev` drops `rb_*` tables | Low | Data loss | §4.3 — prohibited in `AGENTS.md`; no local DB workflow exists |
| Upstream renames a `crm_*` column | Low | Ingestion breaks silently | §11.3 smoke test |
| Function timeout during a large order | Low | Stripe retries; ledger makes it safe | Keep the handler lean; move enrichment to a background function |
| Drift returns as one-off edits accumulate | Medium | Back where you started | §1.2 Rule 4 — five-entry cap on `UPSTREAM-DELTA.md` |

---

## 13. Rollback

- **Before Phase 8** — nothing is live. Delete the site, keep the repo.
- **After Phase 8** — repoint the Lambdas at the old endpoints. The old site and Neon database are
  still running (that is why Phase 8 keeps them alive) and nothing in the new stack has written to
  them.
- **A bad migration** — take a Netlify DB restore point before every deploy that touches
  `prisma/migrations/` or `netlify/database/migrations/`. Reverting code does **not** undo applied
  DDL; only the restore point does. This is unchanged from the current setup and is the one place
  where "just redeploy the last good commit" is wrong.
- **A bad ingestion run** — `rb_ingest_events.payload` holds every body as received. Delete the
  bad Contracts, delete the corresponding ledger rows, replay from the stored payloads.

---

## 14. Appendix — quick reference

**Upstream:** `https://github.com/pdovhomilja/nextcrm-app`
**Current site:** `nextcrm-netlify-deployment` (Netlify), Neon database — keep running through Phase 8
**Branching:** work on `dev`, PR `dev → main`, `release-please` manages versions on `main`

**Files that will exist in the new repo but not upstream:**

```
netlify.toml
netlify/functions/ingest-transaction.mts
netlify/functions/ingest-shipment.mts
netlify/functions/ingest-health.mts
netlify/functions/ingest-retention.mts
netlify/functions/_lib/{db,auth,ledger,refs,crm}.mts
netlify/database/migrations/20260821120000_create-rb-ingest-tables.sql
docs/rb/UPSTREAM-DELTA.md
docs/rb/RUNBOOK.md
docs/2026-NextCRM-Accounts-Contracts-Netlify.md
```

**Files edited relative to upstream — the entire delta:**

```
lib/prisma.ts        4 lines  (connection precedence — §4.2)
prisma.config.ts     4 lines  (connection precedence — §4.2)
AGENTS.md            replaced (project instructions, not upstream code)
```

**Serialization reminder (from `AGENTS.md` §3):** the Netlify Functions return plain JSON and never
cross the React Server Action boundary, so `serializeDecimals()` does not apply to them. It still
applies to any *app-side* server action or Server Component you write that returns a Prisma object
containing a `Decimal` — `crm_Contracts.value` is `Decimal(18,2)`, so anything in the app that
surfaces a Contract must go through it.
