# NextCRM Email Marketing Workflow Analysis — V2

> **Purpose**: Reference guide for AI agents and humans working with the NextCRM email marketing system.
> **Version**: 2.0
> **Last validated**: 2026-06-20 (code re-audited against the live `dev` working tree)
> **Supersedes**: `docs/NextCRM_Email_Marketing_Workflow_Analysis.md` (V1, last validated 2026-05-29), retained as the historical record of the system *before* the in-app funnel automation was disabled.
> **Source**: Direct code analysis of the NextCRM codebase, with every behavioral claim verified against the current source (see Section 13, "Code-Analysis Verification").

---

## What changed since V1 (read this first)

V1 documented an **in-app, NextCRM-owned post-purchase email funnel**: incoming Stripe/website targets were auto-sorted into a `pending-{funnel}` target list, and a daily Inngest cron assembled them into a dated campaign and emailed them through Resend. That automation has now been **deliberately switched off**, and the responsibility for funnel scheduling and sending has moved **out of NextCRM and into Listmonk**.

Two — and only two — code edits implement this change (full diff and verification in Section 13):

1. **Automated funnel target-list creation is disabled** in the ingestion endpoint (`app/api/crm/targets/ingest/route.ts`). The endpoint still accepts the `target_list` field on every request, so the Stripe Lambda and website-form payloads need **no change**, but the value is no longer acted upon: no `pending-{funnel}` list is created, and no target is assigned to one.
2. **The daily post-purchase batch cron is unregistered** in the Inngest serve handler (`app/api/inngest/route.ts`). The cron function file is left in place but is no longer served, so its `0 9 * * *` schedule never fires.

Everything else is unchanged. Critically:

- **Contact ingestion still works exactly as before.** Targets continue to be created, de-duplicated by email, and updated in place. The Lambdas that feed contacts from Stripe and from website forms continue to function (assumed operational per the task brief).
- **NextCRM's native, user-driven campaign system is fully intact** — the campaign wizard, templates, send-now/scheduled/follow-up Inngest functions, and engagement tracking all remain. Only the *automated* post-purchase batch behavior was removed.
- **No database tables were dropped, no migrations were written, and the campaign/targets data model — which is part of upstream NextCRM, not a local invention — was not touched.**

### The new direction in one diagram

```
   Stripe (checkout.session.completed)        Website forms
            │  Lambda  (unchanged)                  │  (unchanged)
            └──────────────┬────────────────────────┘
                           ▼
   NextCRM  POST /api/crm/targets/ingest      ← KEEP: master intake (system of record)
                           │                     target_list still accepted, no longer acted upon
                           ▼
                     crm_Targets               ← KEEP: master list + Stripe/funnel columns
                           │
                           │  (funnel scheduling/sending now happens in Listmonk,
                           │   fed by a sync that is planned but not yet built — Section 10.2)
                           ▼
   Listmonk  lists + campaigns + automation    ← NEW home of the post-purchase mailout
                           │
   NextCRM native "Campaigns" UI               ← KEEP: manual, user-driven campaigns only
   (wizard, templates, Resend, tracking)          (no automated cron driving it)
```

**Why the change**: the in-app funnel was a fork-specific customization layered on top of stock NextCRM. Moving the funnel to Listmonk lets NextCRM stay close to its upstream shape (so it can absorb upstream updates with minimal merge friction) while keeping the one thing the business depends on — ingesting and mastering the contact list. See the migration discussion summarized in Section 12.6.

> **Status of the Listmonk side**: The *removal* of the in-app automation is done and is what this document describes. The *replacement* — pushing targets into Listmonk and re-establishing the post-purchase schedule there — is a planned next step, not yet implemented in this repository. Sections that describe Listmonk behavior are marked **(planned)**.

---

## Table of Contents

### Part I — Analysis

- [1. Data Model Overview](#1-data-model-overview)
- [1.1 Target Custom Fields](#11-target-custom-fields)
- [1.2 Data Migration Strategy](#12-data-migration-strategy)
- [1.3 Upstream-Native vs. Fork-Custom — What Is Actually Ours](#13-upstream-native-vs-fork-custom--what-is-actually-ours)
- [2. Assumption Validation](#2-assumption-validation)
- [3. Campaign System Architecture](#3-campaign-system-architecture)
- [4. Multi-Step Campaign Configuration](#4-multi-step-campaign-configuration)
- [5. Engagement Tracking and Action-Based Follow-Ups](#5-engagement-tracking-and-action-based-follow-ups)
- [6. Multi-Source Ingestion Design](#6-multi-source-ingestion-design)
- [6.1 The target_list Field (now accepted but inert)](#61-the-target_list-field-now-accepted-but-inert)
- [6.2 Root-Name-Driven Naming Convention (dormant)](#62-root-name-driven-naming-convention-dormant)
- [6.3 Unconditional Target Capture (unchanged and now the whole story)](#63-unconditional-target-capture-unchanged-and-now-the-whole-story)
- [6.4 Ingestion Sources](#64-ingestion-sources)
- [7. Known Limitations](#7-known-limitations)
- [8. Workarounds for Missing Features](#8-workarounds-for-missing-features)
- [9. Features Safe to Ignore for Email Marketing](#9-features-safe-to-ignore-for-email-marketing)

### Part II — Implementation

- [10. Recommended Email Marketing Workflow](#10-recommended-email-marketing-workflow)
- [10.1 Data Ingestion Methods](#101-data-ingestion-methods)
- [10.2 Post-Purchase Email Delivery — Moved to Listmonk](#102-post-purchase-email-delivery--moved-to-listmonk)
- [10.3 What the Disabled In-App Cron Used To Do (for reference)](#103-what-the-disabled-in-app-cron-used-to-do-for-reference)
- [10.4 NextCRM's Native (Manual) Campaign Path — Still Available](#104-nextcrms-native-manual-campaign-path--still-available)
- [10.5 Organize into Target Lists](#105-organize-into-target-lists)
- [10.6 Create Email Templates](#106-create-email-templates)
- [10.7 Monitor Engagement](#107-monitor-engagement)
- [10.8 Convert High-Value Targets to Contacts (Only When Needed)](#108-convert-high-value-targets-to-contacts-only-when-needed)
- [11. Key File References](#11-key-file-references)
- [12. Implementation Log](#12-implementation-log)
- [13. Code-Analysis Verification (V2)](#13-code-analysis-verification-v2)

---

# Part I — Analysis

---

## 1. Data Model Overview

```
                          ┌─────────────────┐
                          │  Data Ingestion  │
                          └────────┬────────┘
          ┌────────────────────────┼────────────────────────┐
          │                        │                         │
   CSV Import              Stripe Webhook             Website Forms
   (manual, web UI)        (automated via              (automated via
                            Lambda + API)               Lambda/handler + API)
          │                        │                         │
          │              ┌─────────┴──────────┐              │
          │              │ target_list param?  │              │
          │              │  (accepted, but     │              │
          │              │   NO LONGER acted   │              │
          │              │   upon — see §6.1)  │              │
          │              └─────────┬──────────┘              │
          │                        │                          │
          └────────────────────────┼────────────────────────┘
                                   v
                              Targets  (always captured — unconditional)
                                   │
                  ┌────────────────┴───────────────────┐
                  │                                     │
       Native Campaigns UI                   Listmonk sync (planned, §10.2)
       (manual, user-driven only —              → Listmonk owns the
        no automated cron)                        post-purchase funnel
                  │
            Email Sends (via Resend)
                  │
           Tracking: opens, clicks,
           bounces, unsubscribes
                  │
            [Manual Convert]
                  │
                  v
        Account + Contact --> Opportunities --> Contracts --> Invoices
        (Sales Pipeline - only when needed)
```

**Core design principle (unchanged)**: NextCRM treats **Targets** as the email marketing universe and **Contacts** as the sales relationship universe. These are deliberately separate systems. Campaigns operate exclusively on targets. The CRM pipeline (Accounts > Contacts > Opportunities > Contracts > Invoices) operates on contacts. The bridge is a manual, one-at-a-time conversion action.

**Multi-source ingestion principle (unchanged)**: The ingestion API at `/api/crm/targets/ingest` is source-agnostic. Any external system (Stripe Lambda, website-form handler, future integrations) can POST target data to the same endpoint. Every incoming target is **always persisted** — this "unconditional capture" behavior is now the *entire* behavior of the endpoint, because the optional list-routing layer that used to sit on top of it has been switched off (see Section 6).

**What changed at the model level**: Nothing structurally. The endpoint still writes the same `crm_Targets` rows with the same columns. The only difference is that it no longer also writes `crm_TargetLists` / `TargetsToTargetLists` rows for a `pending-{funnel}` list.

### 1.1 Target Custom Fields

The following optional fields exist on `crm_Targets` to carry Stripe-sourced and segmentation data. All are nullable additive columns (the migration is `ALTER TABLE ADD COLUMN ... DEFAULT NULL`), with zero risk to existing data. Existing code ignores columns it doesn't reference, so this is a safe additive change. These columns are **retained** — they are exactly the data a future Listmonk sync needs.

| Field | Type | Purpose |
|---|---|---|
| `stripe_customer_id` | `String?` | Dedup-merge key for Stripe webhook target ingestion. For returning customers the new ID is comma-merged into the existing value rather than overwritten. |
| `first_order_date` | `String?` | Records when the customer first ordered in Stripe. Historical reference only. |
| `last_order_date` | `String?` | Identifies repeat vs. one-time buyers for segmentation. |
| `last_order_id` | `String?` | Traceability back to Stripe for debugging or customer service. |
| `cumulative_order_count` | `String?` | First-time vs. repeat buyer segmentation. |
| `contact_origin` | `String?` | How the target was created: `"stripe_webhook"`, `"csv_import"`, `"manual"`, `"netlify_form"`. Defaults to `"stripe_webhook"` on the create path when not supplied. |
| `opt_in_time` | `String?` | Compliance — records when the customer opted in to communications. |
| `is_b2b` | `Boolean?` | B2B vs. B2C segmentation for different email content. |
| `b2b_discount_percent` | `String?` | Discount data carried forward from old CRM. |
| `is_temporary` | `Boolean?` | Flags test or temporary records. |

**Historical note on `created_on` vs. `first_order_date`**: V1's daily cron used the native `created_on` field (when the target row was created in NextCRM) — *not* `first_order_date` — to compute the ~7-day delay. That timing logic now lives outside NextCRM (in Listmonk), so the distinction is no longer load-bearing inside this codebase. It is preserved here because the columns still exist and a Listmonk sync may use `first_order_date`/`last_order_date` to drive Listmonk-side timing (see Section 10.2).

### 1.2 Data Migration Strategy

The original one-time data reconciliation (sync custom fields from the contacts table onto matching targets, then clear the contacts table for its intended CRM-sales purpose) is unchanged and historical. It is summarized here for completeness; it has no bearing on the current funnel change.

1. **Add custom fields** to `crm_Targets` (Section 1.1). Run migration.
2. **Sync script** (one-time): for each non-deleted contact, find matching target by email (case-insensitive); update on match, create on miss (the new Stripe customers), preserving list memberships.
3. **Verify**: count comparison and spot-check.
4. **Delete contacts**: clears the contacts table for the sales pipeline.

**Why not "delete everything and re-import"**: deleting targets would destroy existing target-list memberships; the sync approach is surgical and preserves associations.

### 1.3 Upstream-Native vs. Fork-Custom — What Is Actually Ours

A correction carried forward from the migration analysis, because it shapes every "should we delete this?" decision:

- **The Targets subsystem (`crm_Targets`, `crm_TargetLists`, `TargetsToTargetLists`, `crm_Target_Enrichment`, `crm_Target_Contact`) is part of upstream NextCRM.** It is not a fork invention. Targets are the upstream-modeled entry point where contacts can begin before converting to Accounts/Contacts.
- **The campaign tables (`crm_campaigns`, `crm_campaign_templates`, `crm_campaign_steps`, `crm_campaign_sends`, `CampaignToTargetLists`) are likewise upstream-native.**
- **What is genuinely fork-custom is small and additive**: the Stripe/funnel columns on `crm_Targets` (one migration), the ingestion routes (`targets/ingest`, `contacts/ingest`), the Amazon Connect import columns/scripts, and the now-disabled post-purchase Inngest cron + its glue.

Implication: the funnel change is implemented by **disabling fork-custom automation**, not by deleting upstream tables. This keeps the app upstream-mergeable and is why the two edits in this V2 are confined to two fork-specific files.

---

## 2. Assumption Validation

### 2.1 CSV Import Is Target-Only (Web UI) — CONFIRMED

| Import method | Scope | Location |
|---|---|---|
| Web CSV import | Targets only | `actions/crm/targets/import-targets.ts` |
| CLI script | Contacts (Amazon Connect CSV format) | `scripts/import/crm-contact-importer.ts` |

The web-based CSV import is exclusively for targets. The CLI contact importer has no web UI and expects a specific Amazon Connect format.

### 2.2 Campaigns Can Only Target Targets (via Target Lists) — CONFIRMED

- Campaign creation wizard Step 3 (Audience) only allows selection of target lists.
- The `CampaignToTargetLists` junction enforces this at the database level.
- `crm_campaign_sends` references `target_id` (not `contact_id`).
- There is no mechanism to send campaigns directly to contacts or leads.

### 2.3 Campaigns Support Send-Now, Scheduled, and Follow-Ups — CONFIRMED (and still wired)

The campaign system is built on **Inngest** and supports the modes below. After this V2 change, all three remain registered and functional — only the *automated post-purchase batch cron* was unregistered.

| Mode | Mechanism | Inngest function (still registered) |
|---|---|---|
| Immediate send | event `campaigns/send-now` | `campaignSendNow` |
| Scheduled send | `step.sleepUntil()` | `campaignScheduleSend` |
| Multi-step follow-ups | per-step delay + audience filter | `campaignProcessFollowUp`, `campaignSendStep` |

### 2.4 The Automated Post-Purchase Cron No Longer Runs — CONFIRMED (new in V2)

`postPurchaseBatchCron` is no longer in the Inngest `functions: [...]` array in `app/api/inngest/route.ts`, and its import is commented out. Inngest only schedules functions that are passed to `serve(...)`, so the `0 9 * * *` cron is never registered and never fires. The function file itself (`inngest/functions/campaigns/post-purchase-batch.ts`) still exists, intact but inert.

---

## 3. Campaign System Architecture

*(This section describes NextCRM's native campaign engine, which is upstream and remains fully present. None of it was removed by the V2 change.)*

### 3.1 Merge Tags

Templates support these merge tags, resolved at send time from target data:

`{{first_name}}`, `{{last_name}}`, `{{email}}`, `{{company}}`, `{{position}}`

### 3.2 Engagement Tracking

Tracked via Resend webhooks. Per-send fields: `opened_at`, `clicked_at`, `unsubscribed_at`.

| Metric | Tracked | Used for follow-up filtering |
|---|---|---|
| Opens | Yes | Yes (`non_openers` filter) |
| Clicks | Yes | **No** (analytics display only) |
| Deliveries | Yes | No |
| Bounces | Yes | No |
| Unsubscribes | Yes | Yes (always excluded from follow-ups) |

### 3.3 Unsubscribe Handling

- Every email includes a `List-Unsubscribe` header with a unique token.
- Clicking it marks the send record and excludes the target from future steps **in that campaign**.
- **There is no global unsubscribe list across campaigns.** Unsubscription is per-campaign only.

> **Forward-looking note**: once Listmonk owns sending, Listmonk becomes the authoritative consent/unsubscribe/bounce ledger. A consent feedback loop back into `crm_Targets` is part of the planned Listmonk integration (Section 10.2), not part of this V2 change.

### 3.4 Email Deduplication

When a target appears in multiple target lists assigned to the same campaign, the system deduplicates by email address at send time, preventing duplicate emails.

### 3.5 Target Contacts (Sub-Records) Clarification

The `crm_Target_Contact` table stores sub-records discovered during enrichment (e.g., C-level executives at a target company). These are research artifacts, **not** full CRM contacts. The "Add Contact" button on a target detail page creates one of these lightweight records (name, email, phone, LinkedIn only). This is unrelated to full CRM contacts under Sales > Contacts.

### 3.6 Target-to-Contact Conversion

- **Function**: `actions/crm/targets/convert-target.ts`
- **Behavior**: Atomically creates both an Account and a Contact from target data. Maps company fields to Account, personal fields to Contact.
- **Constraint**: Manual, one-at-a-time only. No bulk conversion. No auto-conversion based on campaign engagement.
- **UI location**: Target edit/update form (not main detail view).

---

## 4. Multi-Step Campaign Configuration

*(Native campaign engine — unchanged by V2. Relevant to manually-created campaigns.)*

### 4.1 Campaign Creation Wizard Steps

| Step | Name | Purpose |
|---|---|---|
| 1 | Details | Campaign name, description |
| 2 | Template | Email template selection |
| 3 | Audience | Target list selection |
| 4 | Schedule | Send timing + follow-up configuration |

### 4.2 Follow-Up Configuration

Follow-up steps are configured in **Step 4 (Schedule)**, implemented in `app/[locale]/(routes)/campaigns/new/components/Step4Schedule.tsx`.

The "+ Add follow-up" button adds a new step with these fields:

| Field | Description | Default |
|---|---|---|
| Delay (days) | Days after initial send | 3 (minimum: 1) |
| Send to | `"all"` or `"non_openers"` | All recipients |
| Template | Separate template per follow-up | Required |
| Subject | Separate subject per follow-up | Required |

- No hard limit on follow-up count.
- Each step gets an `order` number: 0 = initial send, 1 = first follow-up, etc.
- **Delays are relative to the initial send time**, not chained from the previous step.

### 4.3 Database Schema

Table: `crm_campaign_steps`. Fields: `order`, `template_id`, `subject`, `content_html`, `delay_days`, `send_to`.

---

## 5. Engagement Tracking and Action-Based Follow-Ups

*(Native campaign engine — unchanged by V2.)*

### 5.1 Available Follow-Up Filters

The `send_to` field accepts exactly two values:

| Value | Behavior |
|---|---|
| `"all"` | Send to every initial recipient (excluding unsubscribed) |
| `"non_openers"` | Send only to recipients where `opened_at IS NULL` |

### 5.2 Follow-Up Filtering Logic

File: `inngest/functions/campaigns/process-follow-up.ts`

```ts
const eligibleTargets = await step.run("filter-recipients", async () => {
  return prismadb.crm_campaign_sends.findMany({
    where: {
      step_id: step0.id,
      status: { in: ["sent", "delivered"] },
      unsubscribed_at: null,
      ...(followUpStep.send_to === "non_openers" ? { opened_at: null } : {}),
    },
  });
});
```

### 5.3 What Is NOT Available

| Desired filter | Status | Notes |
|---|---|---|
| Openers only | NOT AVAILABLE | Inverse of `non_openers` not implemented |
| Clickers / non-clickers | NOT AVAILABLE | `clicked_at` tracked but unused in filtering |
| Bounced exclusion | NOT AVAILABLE | Bounced recipients not explicitly excluded from follow-ups |
| Event-driven triggers | NOT AVAILABLE | No "send when someone clicks a link" or "send on page visit" |
| Conditional branching | NOT AVAILABLE | Steps are a linear sequence; no "if opened send A, else send B" |

### 5.4 Campaign System Classification

Best described as a **simple linear drip sequence with a single behavioral filter (non-openers)**. Suitable for time-based follow-up sequences and non-opener resends; not sufficient for behavioral flows, engagement segmentation, or event-triggered campaigns. This limitation is one of the reasons the funnel is moving to Listmonk, which is purpose-built for list-based broadcast and segmentation.

---

## 6. Multi-Source Ingestion Design

This section documents how targets from different sources arrive in NextCRM. **The most important V2 change is here**: the `target_list` routing layer is now inert.

### 6.1 The `target_list` Field (now accepted but inert)

The ingestion API at `/api/crm/targets/ingest` still accepts an optional `target_list` parameter in the request body, and still parses and validates it (single-object and batch forms both). **What it no longer does**: it no longer derives a `pending-{target_list}` list, no longer creates that list, and no longer assigns the target to it.

**Behavior today**:

- **When `target_list` is provided**: the value is read into an internal variable and then explicitly discarded (`void targetListRoot`). The target is created/updated exactly as if no list were specified. No `pending-*` list is touched.
- **When `target_list` is omitted**: identical outcome — the target is created/updated with no list assignment.

In other words, the two branches now converge: **the endpoint captures the target and stops there.** The `pendingListId` / `pendingListName` values that used to drive list assignment are hardcoded to `null`, so the list-assignment branches inside `processTarget` are unreachable.

**Why the field is still accepted rather than rejected**: this keeps the Lambda and website-form contracts unchanged. The Stripe Lambda still sends `target_list: "post-purchase"`; the endpoint accepts it without error and simply ignores it. No external system has to be redeployed. The `target_list` value is the natural input for the **Listmonk list mapping** (planned, Section 10.2) — the funnel signal is preserved on the wire even though NextCRM no longer acts on it internally.

**Request format examples (still valid payloads — `target_list` is accepted, just inert)**:

Single target with funnel hint (Stripe Lambda post-purchase):
```json
{
  "email": "buyer@example.com",
  "first_name": "Jane",
  "last_name": "Doe",
  "target_list": "post-purchase",
  "contact_origin": "stripe_webhook",
  "stripe_customer_id": "cus_abc123"
}
```

Website-form B2C newsletter signup:
```json
{
  "email": "subscriber@example.com",
  "first_name": "Alex",
  "last_name": "Smith",
  "target_list": "b2c-newsletter",
  "contact_origin": "netlify_form"
}
```

General capture (no funnel hint):
```json
{
  "email": "visitor@example.com",
  "first_name": "Pat",
  "last_name": "Jones",
  "contact_origin": "netlify_form"
}
```

Batch mode:
```json
{
  "target_list": "post-purchase",
  "targets": [
    { "email": "buyer1@example.com", "first_name": "Alice", "last_name": "A" },
    { "email": "buyer2@example.com", "first_name": "Bob", "last_name": "B" }
  ]
}
```

> **Note on `last_name` / `email`**: both are required and validated server-side (a 400 is returned if either is missing or blank). This is unchanged from V1.

### 6.2 Root-Name-Driven Naming Convention (dormant)

V1 described a **root name** convention (`pending-{root}`, `sent-{root}`, `{root}-batch-{date}`, campaign `{root} — {date}`, template `{root}`) that kept the whole in-app pipeline keyed off one human-readable string (e.g. `post-purchase`). That convention is now **dormant inside NextCRM**:

- The ingest route no longer creates `pending-{root}` lists.
- The cron that produced `{root}-batch-{date}` lists, `{root} — {date}` campaigns, and located the `{root}`-named template is unregistered and never runs.

The convention is documented here because (a) it still accurately describes the inert cron file should anyone re-enable it, and (b) the same root string (`post-purchase`, `b2c-newsletter`, …) is the natural key for the **Listmonk** list mapping going forward. The naming idea survives the migration; only its NextCRM-side execution stopped.

### 6.3 Unconditional Target Capture (unchanged and now the whole story)

**Unconditional target capture** — every target POSTed to the ingestion API is always created (or updated) in `crm_Targets`, regardless of any `target_list` value — was always the base behavior. After V2 it is the *only* behavior: the optional list-routing step that used to sit on top of it is gone.

This is precisely why disabling the funnel automation is safe for ingestion:

1. **No data loss**: every Stripe purchase and form submission is still persisted as a target, de-duplicated by email.
2. **Contract stability**: callers that send `target_list` are not broken; the field is accepted and ignored.
3. **Separation of concerns**: capturing *who* a target is (NextCRM's job) is now cleanly separated from *which email sequence* they receive (Listmonk's job).

**`contact_origin`**: still records provenance (`"stripe_webhook"`, `"netlify_form"`, `"csv_import"`, `"manual"`), defaulting to `"stripe_webhook"` on the create path when not supplied. It was never a routing trigger and still isn't.

**De-duplication and merge logic (unchanged)**: matching is by email, case-insensitive. A single existing match updates in place; more than one match returns a `conflict` result (HTTP 409) without guessing. When a `stripe_customer_id` is supplied for a returning customer, it is **comma-merged** into the existing value (never overwritten), so multi-purchase customers accumulate their Stripe IDs.

### 6.4 Ingestion Sources

The ingestion API remains source-agnostic. Any system that can POST JSON with a valid Bearer token can create targets.

#### Source 1: Stripe Webhook (via Lambda) — assumed operational

An external AWS Lambda listens for Stripe webhook events and POSTs customer data to `/api/crm/targets/ingest`, including `target_list: "post-purchase"` and `contact_origin: "stripe_webhook"`. **This Lambda is assumed to be functioning and feeding contacts, per the task brief.** Its payload is unchanged; the only difference is that the `target_list` hint is now ignored on the NextCRM side. Deduplication uses `stripe_customer_id` (comma-merged for returning customers).

#### Source 2: Website Forms — assumed operational

Website forms (e.g. via a Netlify Forms `submission-created` handler or a direct Lambda/webhook) POST submissions to `/api/crm/targets/ingest` with `contact_origin: "netlify_form"` and an optional `target_list`. **This path is assumed to be functioning and feeding contacts, per the task brief.** As with Stripe, any `target_list` value is accepted and ignored; the target is captured unconditionally.

#### Source 3: CSV Import (Manual)

The web CSV import (`actions/crm/targets/import-targets.ts`) creates targets directly, bypassing the ingestion API. CSV-imported targets are not auto-assigned to any list (this was true before and after V2). `contact_origin` is `"csv_import"`.

#### Adding Future Sources

1. Configure the external system to POST to `/api/crm/targets/ingest` with a Bearer token.
2. Set `contact_origin` to a descriptive value (e.g. `"shopify_webhook"`).
3. Optionally include `target_list` as a kebab-case funnel hint — useful as the future Listmonk list key, even though NextCRM currently ignores it.

---

## 7. Known Limitations

| Limitation | Impact | Notes |
|---|---|---|
| No global unsubscribe list (native) | Per-campaign unsubscribe only | To be owned by Listmonk going forward |
| No automated target-list routing at ingestion | The `target_list` hint is captured but not acted upon | Intentional after V2; routing/segmentation moves to Listmonk |
| No in-app event-triggered / post-purchase automation | The daily batch cron is disabled | Replaced by Listmonk-side scheduling (planned, §10.2) |
| No A/B testing (native) | No subject/content variant testing | Listmonk or external tooling |
| No "openers only" / click-based follow-up filter (native) | Limited behavioral targeting | Listmonk segmentation is the path forward |
| No bounce exclusion in native follow-ups | Bounced recipients not explicitly excluded | Listmonk owns bounce state going forward |

---

## 8. Workarounds for Missing Features

*(Native-system workarounds, still applicable to manually-created NextCRM campaigns. The strategic answer to most of these is now "use Listmonk for funnel/segmentation".)*

### 8.1 Manual Segmentation via Campaign Analytics

After sending, use the campaign detail page to view per-recipient engagement, then manually build new target lists and send a separate campaign. Labor-intensive but works without code changes.

### 8.2 Programmatic Segmentation via MCP Tools

`lib/mcp/tools/campaigns.ts` exposes campaign send data (including `clicked_at`) programmatically; an external script could filter by engagement and create new lists.

### 8.3 Code Enhancement: Extend `send_to` Options

Adding `"openers"`, `"clickers"`, `"non_clickers"` is contained: extend the `send_to` enum and the filter query in `process-follow-up.ts` (`opened_at IS NOT NULL`, `clicked_at IS NULL/NOT NULL`). No migration needed. Note this is a *native-engine* enhancement; the broader segmentation need is better served by Listmonk.

### 8.4 Global Unsubscribe Workaround

Maintain a "Do Not Email" target list and exclude it from all campaigns, or rely on the Resend suppression list. Long-term, Listmonk's consent ledger replaces this.

---

## 9. Features Safe to Ignore for Email Marketing

| Feature | Why it can be ignored |
|---|---|
| Leads | Inbound sales prospects, not outbound email marketing |
| Enrichment (Firecrawl + E2B) | B2B prospecting tool for researching companies |
| Target Contacts (sub-records) | Research artifacts from enrichment |
| Opportunities / Contracts / Invoices | Downstream sales pipeline; only relevant after target-to-contact conversion |

---

# Part II — Implementation

---

## 10. Recommended Email Marketing Workflow

The recommended workflow after V2: **NextCRM is the system of record and the master contact intake; Listmonk owns the email funnel (scheduling, segmentation, sending) going forward; NextCRM's native campaign UI remains available for manual, ad-hoc sends.**

### 10.1 Data Ingestion Methods

Unchanged. Three methods still exist:

- **Method A — Manual CSV Import (web UI)**: bulk/historical target import; not auto-listed.
- **Method B — Automated Stripe Webhook (Lambda → `/api/crm/targets/ingest`)**: real-time capture, de-duplicated by `stripe_customer_id`. Assumed operational.
- **Method C — Website Forms (handler → `/api/crm/targets/ingest`)**: real-time capture with `contact_origin: "netlify_form"`. Assumed operational.

All three still land targets in `crm_Targets`. None of them now auto-assign a `pending-{funnel}` list.

### 10.2 Post-Purchase Email Delivery — Moved to Listmonk

The post-purchase mailout is **no longer driven from inside NextCRM**. The daily batch cron that used to do it is disabled (Section 2.4, Section 10.3). The intended replacement lives in **Listmonk**:

- **NextCRM remains the master list.** Targets (with their Stripe/funnel columns) are the source of truth for *who exists* and *what they bought*.
- **Listmonk owns the send schedule and segmentation.** The conventional pattern is: one Listmonk list per funnel (`post-purchase` → "Post-Purchase Buyers"), with purchase/segmentation data carried in each subscriber's `attribs` so Listmonk SQL can time and target sends. Because Listmonk has no native drip engine, the post-purchase delay is reproduced either by a host-side scheduled SQL-segment campaign (single email) or an external orchestrator firing Listmonk transactional sends (multi-step sequence).
- **A NextCRM → Listmonk sync is the connecting seam — planned, not yet built.** The natural design is a thin, failure-isolated push (keyed on email) that mirrors each ingested target into Listmonk with the right list and `attribs`, plus a return path that pulls unsubscribe/bounce state back into `crm_Targets`. Credentials would be a dedicated Listmonk API token stored as Netlify environment variables (never in code, never logged).

> **(planned)** Everything in the two bullets above about Listmonk is the target architecture, not code that exists in this repository today. What exists *today* is the clean removal of the in-app automation, leaving ingestion intact and ready to feed such a sync.

### 10.3 What the Disabled In-App Cron Used To Do (for reference)

The cron file `inngest/functions/campaigns/post-purchase-batch.ts` is **still present but unregistered**, so it never runs. Its internal logic is documented here so that (a) anyone reading the dormant file understands it, and (b) the Listmonk replacement can mirror the intended semantics.

When it was registered, `postPurchaseBatchCron` ran on `0 9 * * *` (daily at 09:00 UTC) and, on each run, executed in order — bailing out early (dispatching nothing) if any precondition was unmet:

1. **Find the pending list** `pending-post-purchase`. If absent → exit (`no pending list found`).
2. **Find eligible targets** — members of that list whose native `created_on` is **7+ days** old. If none → exit.
3. **Filter out already-sent targets** by checking `crm_campaign_sends` for any campaign carrying the `post-purchase` marker tag (an internal idempotency marker the cron stamps on every dated campaign it creates).
4. **Select the template by name** — `crm_campaign_templates.findFirst({ where: { name: "post-purchase", deletedAt: null } })`. If no such template → exit (`no template named "post-purchase" found — create one first`).
5. **Create the dated batch list** `post-purchase-batch-{date}` and add the eligible targets.
6. **Create the campaign** `post-purchase — {date}`, tagged `[post-purchase]`, `template_id` set, single order-0 step.
7. **Create send records, mark `sending`, fan out** one `campaigns/send-step` event per recipient.
8. **Move processed targets** from `pending-post-purchase` to `sent-post-purchase`.

Two things this cron depended on are now both moot in practice: the `pending-post-purchase` list it read is **no longer being populated** by the ingest route (Section 6.1), and the cron itself is **no longer scheduled** (Section 2.4). Either change alone would stop the automated mailout; together they fully retire it.

> **To re-enable the in-app flow** (not recommended given the Listmonk direction): restore the `getOrCreateTargetList(...)` call in the ingest route (the helper is still defined there, kept for exactly this purpose) *and* re-add `postPurchaseBatchCron` to the Inngest `functions` array and uncomment its import. Both edits are clearly commented at their disable points.

### 10.4 NextCRM's Native (Manual) Campaign Path — Still Available

NextCRM's own "Campaigns" UI is upstream-native and untouched. A human can still:

1. Create a template in the campaign template editor (merge tags supported).
2. Organize targets into target lists (manually, or via the existing list-management UI).
3. Build a campaign through the 4-step wizard (Details → Template → Audience → Schedule), with optional multi-step follow-ups.
4. Send now or schedule; monitor opens/clicks/bounces/unsubscribes on the campaign detail page.

This path is driven entirely by explicit user actions — no cron, no automated trigger — which is exactly the "relatively plain campaign tool" behavior the app shipped with. A natural, optional future enhancement (raised but not built) is to surface Listmonk's campaigns inside this native screen via Listmonk's API, leaning on existing UI rather than adding custom machinery.

### 10.5 Organize into Target Lists

Create target lists by product line or buyer category and assign targets as needed; a target can belong to multiple lists. Note that, after V2, list assignment at ingestion is no longer automatic — lists are now organized manually in the CRM (or will be derived on the Listmonk side). Use kebab-case for consistency.

### 10.6 Create Email Templates

Use the campaign template editor; use merge tags for personalization; templates are reusable. For **manual** campaigns the template is chosen explicitly in wizard Step 2. The V1 "name a template `post-purchase` so the cron can find it" instruction is **no longer required**, because the cron that performed the name lookup is disabled. (If the in-app flow were ever re-enabled, the cron would again look up a template named `post-purchase`.)

### 10.7 Monitor Engagement

The campaign detail page shows sent/delivered counts and open/click/bounce rates, with per-recipient status. Reports > Campaigns provides aggregate analytics. This covers manually-sent native campaigns. Funnel/post-purchase analytics going forward live in Listmonk.

### 10.8 Convert High-Value Targets to Contacts (Only When Needed)

If a target becomes a genuine sales prospect, manually convert via the target edit form, which creates an Account + Contact for pipeline tracking. **Do not bulk-convert.**

---

## 11. Key File References

| Component | Path | V2 status |
|---|---|---|
| Target ingestion API (multi-source) | `app/api/crm/targets/ingest/route.ts` | **Modified** — `target_list` accepted but inert; no pending-list creation |
| Inngest serve handler (function registry) | `app/api/inngest/route.ts` | **Modified** — `postPurchaseBatchCron` unregistered |
| Post-purchase batch cron (Inngest) | `inngest/functions/campaigns/post-purchase-batch.ts` | Present but **inert** (unregistered) |
| `getOrCreateTargetList` helper | `app/api/crm/targets/ingest/route.ts` (≈ line 126) | Defined but **no longer called** (retained for re-enable) |
| Contact ingestion API (legacy) | `app/api/crm/contacts/ingest/route.ts` | Unchanged |
| CSV target import action | `actions/crm/targets/import-targets.ts` | Unchanged |
| Target creation / update / convert | `actions/crm/targets/{create,update,convert}-target.ts` | Unchanged |
| Campaign creation action | `actions/campaigns/create-campaign.ts` | Unchanged |
| Campaign wizard (Schedule/Follow-ups) | `app/[locale]/(routes)/campaigns/new/components/Step4Schedule.tsx` | Unchanged |
| Campaign detail / analytics | `app/[locale]/(routes)/campaigns/[campaignId]/components/CampaignDetail.tsx` | Unchanged |
| Inngest campaign functions (send-now/schedule/step/follow-up) | `inngest/functions/campaigns/*` | Unchanged, **still registered** |
| MCP campaign tools | `lib/mcp/tools/campaigns.ts` | Unchanged |
| Resend webhook handler | `app/api/campaigns/webhooks/resend/route.ts` | Unchanged |
| Targets schema (incl. Stripe columns) | `prisma/schema.prisma` (`crm_Targets`) | Unchanged |
| Stripe fields migration (targets) | `prisma/migrations/20260525000000_add_stripe_fields_to_targets/migration.sql` | Unchanged |
| Decimal serialization utility | `lib/serialize-decimals.ts` | Unchanged |

---

## 12. Implementation Log

*(Entries 12.1–12.5 are preserved verbatim in V1. They document the build-out of the in-app funnel and remain accurate as history. The current entry, 12.6, records the funnel's removal.)*

- **12.1** (2026-05-25) — Fix: 405 on `POST /api/crm/targets/ingest` (locale-wildcard redirect + missing `crm_Targets` migration). *See V1.*
- **12.2** (2026-05-25) — Enhancement: Target detail "Custom Fields" card + `updateTarget` field coverage. *See V1.*
- **12.3** (2026-05-28) — Multi-source ingestion: optional `target_list` field + root-name naming convention. *See V1.*
- **12.4** (2026-05-29) — Clarification: automation boundary; template-by-tag selection (later superseded). *See V1.*
- **12.5** (2026-05-29) — Change: template lookup switched from tag to root-name convention. *See V1.*

### 12.6 Change — In-App Funnel Automation Disabled; Funnel Moves to Listmonk

**Date**: 2026-06-20

**Context**: After evaluating whether to keep building the email funnel inside NextCRM versus adopting a dedicated platform, the decision was to use **Listmonk** as the email + funnel system and to wind the in-app funnel automation back out of NextCRM. The goal is to keep NextCRM close to its upstream ("virgin") shape so it can absorb upstream updates with minimal merge friction, while continuing to ingest targets from Stripe (via Lambda) and from website forms exactly as before. Targets and the campaign data model are upstream-native and were intentionally **not** deleted (see Section 1.3); the change is limited to disabling two pieces of fork-custom automation.

**Code changes** (two files, both fork-specific):

- `app/api/crm/targets/ingest/route.ts` — The automated `pending-{funnel}` target-list creation was disabled. The endpoint still parses and accepts the `target_list` field (so the Stripe Lambda and website-form payloads are unchanged), but `pendingListId`/`pendingListName` are now hardcoded to `null` and the parsed `targetListRoot` is explicitly discarded (`void targetListRoot`). As a result the list-assignment branches in `processTarget` are unreachable: targets are captured and de-duplicated exactly as before, but no `pending-*` list is created or assigned. The `getOrCreateTargetList` helper is left defined (and is now uncalled) so the behavior can be restored with a one-line change; the disable point carries an explanatory comment.
- `app/api/inngest/route.ts` — The daily post-purchase batch cron was unregistered. Its import is commented out and `postPurchaseBatchCron` was removed from the `serve({ functions: [...] })` array, so its `0 9 * * *` schedule is never registered and never fires. The function file `inngest/functions/campaigns/post-purchase-batch.ts` is left in place, inert, with a comment explaining why.

**What was intentionally left unchanged**:

- Contact ingestion (create / email-dedup / update-in-place / `stripe_customer_id` comma-merge) — fully intact.
- The Stripe/funnel columns on `crm_Targets` — retained; they are the data a future Listmonk sync needs.
- NextCRM's native campaign system — wizard, templates, and the event-driven Inngest functions (`campaignSendNow`, `campaignScheduleSend`, `campaignSendStep`, `campaignProcessFollowUp`) remain registered and functional for manual campaigns.
- No database tables were dropped and no migrations were written.

**Operator impact**: Stripe purchases and form submissions are still captured as targets. They are **no longer** auto-sorted into `pending-{funnel}` lists, and **no** automated post-purchase email is sent from NextCRM. Until the Listmonk sync (Section 10.2) is built, the post-purchase mailout is not running anywhere; the native NextCRM campaign UI remains available for manual sends in the interim.

**Doc changes**: Produced this V2 document. Reframed Sections 1, 6, 7, and 10 around the disabled automation and the Listmonk direction; added Section 1.3 (upstream-native vs. fork-custom), Section 2.4 (cron no longer runs), Section 10.2 (Listmonk replacement, planned), Section 10.3 (reference description of the now-dormant cron), and Section 13 (code-analysis verification). V1 is retained unchanged as the historical record.

---

## 13. Code-Analysis Verification (V2)

This section records the direct code analysis performed to confirm that every claim in this V2 document is truthful against the current source. Each claim below was checked against the live working tree on `dev`.

### 13.1 The two edits, exactly as committed

`git diff` against `main` shows changes confined to two source files (plus `deno.lock`, a lockfile):

```
 app/api/crm/targets/ingest/route.ts | 18 +++--
 app/api/inngest/route.ts            |  7 +-
```

**Ingest route — automated list creation disabled.** The previous block that built `pendingListName = pending-${targetListRoot}` and called `getOrCreateTargetList(...)` was replaced by:

```ts
// --- Automated funnel target-list creation: DISABLED ---
// ... (explanatory comment) ...
const pendingListId: string | null = null;
const pendingListName: string | null = null;
void targetListRoot;
```

**Inngest route — cron unregistered.** The import is commented out:

```ts
// import { postPurchaseBatchCron } from "@/inngest/functions/campaigns/post-purchase-batch";
```

and the registration is removed from the `functions` array:

```ts
// postPurchaseBatchCron,  // DISABLED — post-purchase scheduling moved to Listmonk
```

### 13.2 Claim-by-claim verification

| # | Claim in this document | How it was verified | Result |
|---|---|---|---|
| 1 | `target_list` is still accepted and parsed by the ingest route | `targetListRoot` is still assigned from `root.target_list` (single + batch paths) before being discarded | **Confirmed** |
| 2 | `target_list` no longer causes list creation/assignment | `pendingListId`/`pendingListName` are `const … = null`; `void targetListRoot` discards the value | **Confirmed** |
| 3 | The list-assignment branches in `processTarget` are unreachable | Both branches are guarded by `if (pendingListId)`, which is always `null`/falsy | **Confirmed** |
| 4 | Target capture / dedup / update-in-place is unchanged | `processTarget` still matches by case-insensitive email, returns `conflict` on >1 match, comma-merges `stripe_customer_id`, defaults `contact_origin` to `"stripe_webhook"` on create | **Confirmed** |
| 5 | `getOrCreateTargetList` is now dead code, retained | The function is still defined (~line 126); its only remaining mention is in the disable comment — no call site | **Confirmed** |
| 6 | The post-purchase cron is unregistered and never fires | `postPurchaseBatchCron` is absent from `serve({ functions: [...] })`; import commented out. Inngest only schedules functions passed to `serve` | **Confirmed** |
| 7 | The cron file still exists, inert | `inngest/functions/campaigns/post-purchase-batch.ts` is present (≈7 KB); still defines `CAMPAIGN_ROOT = "post-purchase"`, cron `0 9 * * *`, template lookup `name: CAMPAIGN_ROOT` | **Confirmed** |
| 8 | The other campaign Inngest functions remain registered | `campaignScheduleSend`, `campaignSendStep`, `campaignProcessFollowUp`, `campaignSendNow` are all still in the `functions` array | **Confirmed** |
| 9 | No tables dropped / no migrations written | The diff touches no files under `prisma/migrations/` and no `schema.prisma`; only the two route files (and `deno.lock`) changed | **Confirmed** |
| 10 | Stripe/funnel columns on `crm_Targets` retained | `STRING_FIELDS`/`BOOLEAN_FIELDS` in the ingest route still list all Stripe/funnel fields; the schema and its migration are untouched | **Confirmed** |
| 11 | Lambdas/forms need no payload change | The endpoint still validates and accepts `target_list` plus all Stripe fields; an unknown-field guard still permits `target_list` alongside `targets` in batch mode | **Confirmed** (consistent with the assumption that the Lambdas remain operational) |

### 13.3 Scope statement

The analysis confirms the change is **subtractive and contained**: two fork-specific files, no schema or migration changes, no removal of upstream-native tables or the native campaign engine. The ingestion contract is preserved on the wire, so the externally-hosted Stripe and website-form Lambdas continue to feed contacts without modification. The only externally-observable behavioral differences are (a) ingested targets are no longer auto-added to `pending-{funnel}` lists, and (b) the automated post-purchase email no longer sends from NextCRM. Both are intended, and both are reversible via the clearly-commented disable points should the Listmonk direction be abandoned.
