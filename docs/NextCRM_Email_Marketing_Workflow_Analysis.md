# NextCRM Email Marketing Workflow Analysis

> **Purpose**: Reference guide for AI agents and humans working with the NextCRM email marketing system.
> **Last validated**: 2026-05-29
> **Source**: Code analysis of the NextCRM codebase (multiple agent runs consolidated).

---

## Table of Contents

### Part I — Analysis

- [1. Data Model Overview](#1-data-model-overview)
- [1.1 Target Custom Fields](#11-target-custom-fields)
- [1.2 Data Migration Strategy](#12-data-migration-strategy)
- [2. Assumption Validation](#2-assumption-validation)
- [3. Campaign System Architecture](#3-campaign-system-architecture)
- [4. Multi-Step Campaign Configuration](#4-multi-step-campaign-configuration)
- [5. Engagement Tracking and Action-Based Follow-Ups](#5-engagement-tracking-and-action-based-follow-ups)
- [6. Multi-Source Ingestion Design](#6-multi-source-ingestion-design)
- [6.1 The target_list Field](#61-the-target_list-field)
- [6.2 Root-Name-Driven Naming Convention](#62-root-name-driven-naming-convention)
- [6.3 Unconditional Target Capture](#63-unconditional-target-capture)
- [6.4 Ingestion Sources](#64-ingestion-sources)
- [7. Known Limitations](#7-known-limitations)
- [8. Workarounds for Missing Features](#8-workarounds-for-missing-features)
- [9. Features Safe to Ignore for Email Marketing](#9-features-safe-to-ignore-for-email-marketing)

### Part II — Implementation

- [10. Recommended Email Marketing Workflow](#10-recommended-email-marketing-workflow)
- [10.1 Data Ingestion Methods](#101-data-ingestion-methods)
- [10.2 Automating Post-Purchase Email Delivery](#102-automating-post-purchase-email-delivery)
- [10.2.0 Automation Boundary — What Is Automatic vs. What Is Manual](#1020-automation-boundary--what-is-automatic-vs-what-is-manual)
- [10.3 Double-Send Prevention](#103-double-send-prevention)
- [10.4 Testing the Automation](#104-testing-the-automation)
- [10.5 Organize into Target Lists](#105-organize-into-target-lists)
- [10.6 Create Email Templates](#106-create-email-templates)
- [10.7 Build Multi-Step Campaigns](#107-build-multi-step-campaigns)
- [10.8 Monitor Engagement](#108-monitor-engagement)
- [10.9 Convert High-Value Targets to Contacts (Only When Needed)](#109-convert-high-value-targets-to-contacts-only-when-needed)
- [11. Key File References](#11-key-file-references)
- [12. Implementation Log](#12-implementation-log)
- [12.1 Fix: 405 Error on POST /api/crm/targets/ingest](#121-fix-405-error-on-post-apicrmtargetsingest)
- [12.2 Enhancement: Target Detail View — Custom Fields Card](#122-enhancement-target-detail-view--custom-fields-card)
- [12.3 Multi-Source Ingestion — target_list Field and Naming Convention](#123-multi-source-ingestion--target_list-field-and-naming-convention)
- [12.4 Clarification — Automation Boundary and Template-Tag Selection](#124-clarification--automation-boundary-and-template-tag-selection)
- [12.5 Change — Template Lookup Switched from Tag to Root-Name Convention](#125-change--template-lookup-switched-from-tag-to-root-name-convention)

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
   CSV Import              Stripe Webhook             Netlify Forms
   (manual)                (automated via              (automated via
                            Lambda + API)               form submission
                                                        + webhook/API)
          │                        │                         │
          │              ┌─────────┴──────────┐              │
          │              │ target_list param?  │              │
          │              └────┬──────────┬────┘              │
          │                   │          │                    │
          │              yes: assign   no: capture           │
          │              to pending    only (no list)        │
          │              list                                │
          └────────────────────────┼────────────────────────┘
                                   v
                              Targets
                                   │
                           Target Lists ──── Campaigns ──── Email Sends (via Resend)
                                                                  │
                                                           Tracking: opens,
                                                           clicks, bounces,
                                                           unsubscribes
                                   │
                            [Manual Convert]
                                   │
                                   v
                        Account + Contact --> Opportunities --> Contracts --> Invoices
                        (Sales Pipeline - only when needed)
```

**Core design principle**: NextCRM treats **Targets** as the email marketing universe and **Contacts** as the sales relationship universe. These are deliberately separate systems. Campaigns operate exclusively on targets. The CRM pipeline (Accounts > Contacts > Opportunities > Contracts > Invoices) operates on contacts. The bridge is a manual, one-at-a-time conversion action.

**Multi-source ingestion principle**: The ingestion API at `/api/crm/targets/ingest` is source-agnostic. Any external system (Stripe Lambda, Netlify Forms webhook, future integrations) can POST target data to the same endpoint. The optional `target_list` parameter controls whether the target is assigned to a pending list for automated campaign processing, or simply captured into the target database without list assignment. This means every incoming target is always persisted — list routing is an optional layer on top of unconditional capture.

### 1.1 Target Custom Fields

The following optional fields are added to `crm_Targets` to support the automated post-purchase workflow. All are nullable — the Prisma migration is `ALTER TABLE ADD COLUMN ... DEFAULT NULL` with zero risk to existing data. Existing code (campaigns, enrichment, UI, list management) ignores columns it doesn't reference, so this is a safe additive change.

| Field | Type | Purpose |
|---|---|---|
| `stripe_customer_id` | `String?` | Dedup key for Stripe webhook target ingestion. Prevents duplicate targets for returning customers. |
| `first_order_date` | `String?` | Records when the customer first ordered in Stripe. Historical reference only — **not** used for automation timing (see design decision below). |
| `last_order_date` | `String?` | Identifies repeat vs. one-time buyers for segmentation. |
| `last_order_id` | `String?` | Traceability back to Stripe for debugging or customer service. |
| `cumulative_order_count` | `String?` | First-time vs. repeat buyer segmentation. |
| `contact_origin` | `String?` | How the target was created: `"stripe_webhook"`, `"csv_import"`, `"manual"`, `"netlify_form"`. Accumulates multiple values if a target is ingested from more than one source. |
| `opt_in_time` | `String?` | Compliance — records when the customer opted in to communications. |
| `is_b2b` | `Boolean?` | B2B vs. B2C segmentation for different email content. |
| `b2b_discount_percent` | `String?` | Discount data carried forward from old CRM. |
| `is_temporary` | `Boolean?` | Flags test or temporary records. Least critical field; kept for parity with contacts. |

**Design decision — `created_on` vs. `first_order_date` for the 7-day delay**: The daily cron uses the native `created_on` field (when the target record was created in NextCRM) rather than `first_order_date` (the Stripe purchase date). Rationale: `created_on` is a native NextCRM field set automatically at record creation and is the appropriate timestamp for CRM-side automation logic. `first_order_date` is retained purely as a historical reference — it records when the customer actually placed their first Stripe order, which may differ from when they were ingested into NextCRM. Using a Stripe-sourced field to drive NextCRM automation would couple the CRM's internal logic to an external system's data.

### 1.2 Data Migration Strategy

Initial data state: contacts table has the full customer list (CSV import from old CRM + 2 new Stripe customers). Targets table has the same CSV import but without custom field values and without the 2 Stripe customers.

**Approach: "Add fields → sync from contacts → delete contacts"**

1. **Add custom fields** to `crm_Targets` schema (Section 1.1). Run migration.
2. **Sync script** (one-time): For each non-deleted contact, find matching target by email (case-insensitive). If match: update target with custom field values. If no match (the 2 Stripe customers): create new target, add to relevant target list. Map contact `city` → target `city`, contact `country` → target `country`. Drop `state` (no equivalent target field, not needed for email marketing).
3. **Verify**: Count comparison (non-deleted contacts = non-deleted targets). Spot-check custom field values.
4. **Delete all contacts**: Clears the contacts table for its intended CRM sales pipeline purpose.

**Why not "delete everything and re-import"**: Deleting targets would destroy existing target list memberships. The sync approach preserves all list associations and is more surgical.

---

## 2. Assumption Validation

### 2.1 CSV Import Is Target-Only (Web UI)

**Status**: CONFIRMED

| Import method | Scope | Location |
|---|---|---|
| Web CSV import | Targets only | `actions/crm/targets/import-targets.ts` |
| CLI script | Contacts (Amazon Connect CSV format) | `scripts/import/crm-contact-importer.ts` |

The web-based CSV import is exclusively for targets. The CLI contact importer has no web UI and expects a specific Amazon Connect format.

### 2.2 Campaigns Can Only Target Targets (via Target Lists)

**Status**: CONFIRMED

- Campaign creation wizard Step 3 (Audience) only allows selection of target lists.
- Database enforces this via the `CampaignToTargetLists` junction table.
- `crm_campaign_sends` references `target_id` (not `contact_id`).
- There is no mechanism to send campaigns directly to contacts or leads.

### 2.3 Campaigns Support Send-Now, Scheduled, and Follow-Ups

**Status**: CONFIRMED

The campaign system is built on **Inngest** (event-driven task orchestration) and supports:

| Mode | Mechanism | Details |
|---|---|---|
| Immediate send | Inngest event `campaigns/send-now` | Fans out individual emails via Resend |
| Scheduled send | `step.sleepUntil()` in Inngest function | Campaign can be paused before firing |
| Multi-step follow-ups | Campaign steps with configurable delay | Each step has its own delay, template, subject, and audience filter |

---

## 3. Campaign System Architecture

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
- Each step gets an `order` number: 0 = initial send, 1 = first follow-up, 2 = second, etc.
- **Delays are relative to the initial send time**, not chained from the previous step.

### 4.3 Database Schema

Table: `crm_campaign_steps` (defined in `prisma/schema.prisma`, lines 337-356)

Fields: `order`, `template_id`, `subject`, `content_html`, `delay_days`, `send_to`

---

## 5. Engagement Tracking and Action-Based Follow-Ups

### 5.1 Available Follow-Up Filters

The `send_to` field accepts exactly two values:

| Value | Behavior |
|---|---|
| `"all"` | Send to every initial recipient (excluding unsubscribed) |
| `"non_openers"` | Send only to recipients where `opened_at IS NULL` |

### 5.2 Follow-Up Filtering Logic

File: `inngest/functions/campaigns/process-follow-up.ts` (lines 37-46)

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

Best described as a **simple linear drip sequence with a single behavioral filter (non-openers)**.

**Suitable for**:
- Re-sending to people who missed the first email (non-openers resend after X days)
- Time-based follow-up sequences where everyone gets the same emails on the same schedule

**Not sufficient for**:
- Behavioral email flows (different paths based on opens/clicks/purchases)
- Engagement-based segmentation (targeting clickers vs. non-clickers)
- Event-triggered campaigns (send on purchase, send on signup, etc.)

---

## 6. Multi-Source Ingestion Design

This section documents the design decisions for how targets from different ingestion sources (Stripe purchases, Netlify Forms signups, future integrations) are segregated into meaningful target lists and routed through appropriate campaign workflows.

### 6.1 The `target_list` Field

The ingestion API at `/api/crm/targets/ingest` accepts an optional `target_list` parameter in the request body. This parameter controls whether the ingested target is assigned to a pending list for automated campaign processing.

**Behavior when `target_list` is provided**: The system derives a pending list name using the pattern `pending-{target_list}` and either creates that list (if it doesn't exist) or finds the existing list. The target is then added to this pending list. For example, if `target_list` is `"post-purchase"`, the target is added to the `pending-post-purchase` list.

**Behavior when `target_list` is omitted**: The target is created (or updated if a matching email/stripe_customer_id already exists) in the targets database but is **not** assigned to any pending list. This is the "unconditional capture" behavior — the target is always persisted regardless of whether it has a list destination. Targets captured without a list can later be manually organized into lists via the CRM UI, or picked up by future automation.

**Why `target_list` is optional rather than required**: Different sources have different list routing needs. Stripe purchases have a clear campaign workflow (post-purchase email sequence), so the Lambda includes `target_list: "post-purchase"` in its request. But a Netlify Form collecting general inquiries might just want to capture the lead without immediately routing it to a campaign. Making `target_list` optional means the ingestion endpoint can serve both use cases without forcing callers to invent a list name when they don't have a campaign workflow in mind.

**Request format examples**:

With list routing (Stripe Lambda post-purchase):
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

With list routing (Netlify Form B2C newsletter signup):
```json
{
  "email": "subscriber@example.com",
  "first_name": "Alex",
  "target_list": "b2c-newsletter",
  "contact_origin": "netlify_form"
}
```

Without list routing (general capture):
```json
{
  "email": "visitor@example.com",
  "first_name": "Pat",
  "contact_origin": "netlify_form"
}
```

Batch mode with list routing:
```json
{
  "target_list": "post-purchase",
  "targets": [
    { "email": "buyer1@example.com", "first_name": "Alice" },
    { "email": "buyer2@example.com", "first_name": "Bob" }
  ]
}
```

### 6.2 Root-Name-Driven Naming Convention

The system uses a **root name** concept to keep list names, campaign names, and template names consistent across the lifecycle of a campaign workflow. The root name is the value passed in the `target_list` parameter, and all derived names are built from it.

**Format**: Root names use **kebab-case** (lowercase, hyphen-separated). Examples: `post-purchase`, `b2c-newsletter`, `b2b-newsletter`, `product-launch`.

**Derived names from a root**:

| Purpose | Pattern | Example (root: `post-purchase`) |
|---|---|---|
| Pending list (intake) | `pending-{root}` | `pending-post-purchase` |
| Sent list (after campaign send) | `sent-{root}` | `sent-post-purchase` |
| Daily batch list | `{root}-batch-{YYYY-MM-DD}` | `post-purchase-batch-2026-05-28` |
| Campaign name | `{root} — {YYYY-MM-DD}` | `post-purchase — 2026-05-28` |
| Template name (manual setup) | `{root}` | `post-purchase` |

**Why kebab-case**: URL parameters (e.g., form submissions from Netlify Forms) naturally use kebab-case. The convention avoids encoding issues with spaces or special characters, and ensures consistency regardless of which external system is passing the `target_list` value. The CRM UI displays these names as-is, and kebab-case remains readable in the target list management views.

**The CAMPAIGN_ROOT constant**: Each automated campaign workflow (like the post-purchase batch cron) defines a `CAMPAIGN_ROOT` constant at the top of its Inngest function file. This constant is the root name used to derive all related list and campaign names. For the post-purchase workflow, `CAMPAIGN_ROOT = "post-purchase"`. To create a new automated workflow (e.g., a B2C newsletter welcome sequence), you would create a new Inngest cron function with `CAMPAIGN_ROOT = "b2c-newsletter"`, and the same naming pattern would automatically produce `pending-b2c-newsletter`, `sent-b2c-newsletter`, etc.

### 6.3 Unconditional Target Capture

A key design principle of the ingestion system is **unconditional target capture**: every target POSTed to the ingestion API is always created (or updated) in the `crm_Targets` table, regardless of whether a `target_list` parameter was provided. List routing is an optional second step that happens on top of the base capture.

**Why this matters**: In earlier design iterations, the ingestion endpoint was conceived as a pipeline where every target would be assigned to a list. This was changed because:

1. **No data loss**: If a form submission or webhook fires without specifying a `target_list` (due to misconfiguration, a new integration being tested, etc.), the target data is still captured. It can be organized into lists later.
2. **Flexibility for future sources**: Not every ingestion source has a clear campaign workflow. A "Contact Us" Netlify Form might just need to capture leads for manual review, not route them into an automated email sequence.
3. **Separation of concerns**: Capturing target data (who they are, where they came from) is a different concern from campaign routing (which email sequence should they receive). Keeping these decoupled makes the system easier to reason about and extend.

**How the `contact_origin` field relates to list routing**: The `contact_origin` field records how the target was created (e.g., `"stripe_webhook"`, `"netlify_form"`, `"csv_import"`, `"manual"`). This field accumulates values — if a target is first created by a Stripe webhook and later submitted through a Netlify Form, `contact_origin` will reflect both sources. However, `contact_origin` is **not** used for list routing or campaign assignment. It is a provenance record for auditing and segmentation, not an automation trigger. List routing is controlled exclusively by the `target_list` parameter at ingestion time.

### 6.4 Ingestion Sources

The ingestion API is source-agnostic by design. Any external system that can send an HTTP POST with a JSON body can create targets. The following sources are currently planned or in use:

#### Source 1: Stripe Webhook (via Lambda)

An external AWS Lambda function listens for Stripe webhook events (e.g., `checkout.session.completed`, `customer.created`) and POSTs customer data to `/api/crm/targets/ingest`. The Lambda includes `target_list: "post-purchase"` and `contact_origin: "stripe_webhook"` in the request body, which routes the target into the `pending-post-purchase` list for the daily batch cron to process.

**Deduplication**: Uses `stripe_customer_id` as the dedup key. If a returning customer makes a new purchase, the existing target is updated (with `last_order_date`, `cumulative_order_count`, etc.) rather than creating a duplicate.

#### Source 2: Netlify Forms (Planned)

Netlify Forms can be configured to POST form submission data to the ingestion API via a Netlify serverless function that listens for the `submission-created` event, or via a direct webhook integration. The form submission handler would extract fields from the form data and POST them to `/api/crm/targets/ingest` with the appropriate `contact_origin: "netlify_form"` and an optional `target_list` value.

**Routing options for forms**:
- A newsletter signup form would include `target_list: "b2c-newsletter"` (or `"b2b-newsletter"` based on a form field), routing the subscriber into a pending list for an automated welcome sequence.
- A general "Contact Us" form might omit `target_list` entirely, capturing the lead without automated campaign routing. The sales team would manually review and organize these targets.
- The `target_list` value can be passed as a URL parameter on the form action or embedded as a hidden field, giving each form instance control over its routing destination without code changes to the ingestion endpoint.

#### Source 3: CSV Import (Manual)

The web CSV import (`actions/crm/targets/import-targets.ts`) creates targets directly in the database without going through the ingestion API. CSV-imported targets are not automatically assigned to any target list — they are added to lists manually through the CRM UI after import. The `contact_origin` for CSV imports is `"csv_import"`.

#### Adding Future Sources

To add a new ingestion source:
1. Configure the external system to POST to `/api/crm/targets/ingest` with a Bearer token for authentication.
2. Include `contact_origin` set to a descriptive value for the new source (e.g., `"shopify_webhook"`, `"typeform"`).
3. Optionally include `target_list` with a kebab-case root name if the source should feed into an automated campaign workflow.
4. If the source needs its own automated campaign, create a new Inngest cron function with a matching `CAMPAIGN_ROOT` constant (see Section 10.2 for the pattern).

---

## 7. Known Limitations

| Limitation | Impact | Compliance risk |
|---|---|---|
| No global unsubscribe list | Unsubscribe is per-campaign; target can still receive other campaigns | **CAN-SPAM / GDPR** |
| No automated target list management | New buyers must be manually CSV-imported and assigned to lists unless using the automated ingestion API with `target_list` parameter (see Section 6) | Operational overhead |
| No event-triggered campaigns | All campaigns are one-shot (send now or schedule); automated post-purchase flow uses daily batch cron as workaround (see Section 10.2) | Feature gap |
| No A/B testing | No subject line or content variant testing | Feature gap |
| No unified send history after conversion | Campaign sends stay on target record; no cross-system email history | Data fragmentation |
| No "openers only" follow-up filter | Cannot target only people who opened | Feature gap |
| No click-based follow-up filter | `clicked_at` tracked but unused for targeting | Feature gap |
| No bounce exclusion in follow-ups | Bounced recipients not explicitly excluded | Delivery quality |

---

## 8. Workarounds for Missing Features

### 8.1 Manual Segmentation via Campaign Analytics

After sending, use the campaign detail page (`app/[locale]/(routes)/campaigns/[campaignId]/components/CampaignDetail.tsx`) to view per-recipient engagement. Manually create new target lists (e.g., "Campaign A Clickers") and send a separate campaign. Labor-intensive but works without code changes.

### 8.2 Programmatic Segmentation via MCP Tools

The codebase includes MCP tools in `lib/mcp/tools/campaigns.ts` that expose campaign send data programmatically, including `clicked_at` timestamps. An external script or automation could query this data, filter by engagement, and create new target lists via the MCP targets tools.

### 8.3 Code Enhancement: Extend `send_to` Options

Adding `"openers"`, `"clickers"`, and `"non_clickers"` options is contained:

1. Add new enum values to the `send_to` field (schema, UI dropdown, server action type).
2. Extend the filter query in `process-follow-up.ts`:
   - `opened_at IS NOT NULL` for openers
   - `clicked_at IS NULL` for non-clickers
   - `clicked_at IS NOT NULL` for clickers
3. No schema migration needed -- `opened_at` and `clicked_at` already exist.

Moderate-effort enhancement that adds meaningful behavioral targeting without redesigning the campaign architecture.

### 8.4 Global Unsubscribe Workaround

Maintain a "Do Not Email" target list and manually exclude it from all campaigns. Alternatively, verify whether the Resend suppression list handles global suppression at the email provider level.

---

## 9. Features Safe to Ignore for Email Marketing

| Feature | Why it can be ignored |
|---|---|
| Leads | For inbound sales prospects (form submissions, referrals), not outbound email marketing |
| Enrichment (Firecrawl + E2B) | B2B prospecting tool for researching companies / discovering decision-makers |
| Target Contacts (sub-records) | Research artifacts from enrichment; unrelated to email marketing |
| Opportunities | Downstream sales pipeline; only relevant after target-to-contact conversion |
| Contracts | Downstream sales pipeline |
| Invoices | Downstream sales pipeline |

---

# Part II — Implementation

---

## 10. Recommended Email Marketing Workflow

This workflow uses the minimum set of NextCRM features needed for email marketing, stays within the application's intended design, and avoids the complexity of the full CRM pipeline until sales tracking is actually needed.

### 10.1 Data Ingestion Methods

Three methods exist for getting data into the Targets system, each serving a different use case:

#### Method A: Manual CSV Import (Batch / Historical)

Export contacts from the previous CRM as CSV. Import into NextCRM as targets via the web UI. Supported CSV fields: `first_name`, `last_name`, `email`, `company`, `position`, phone numbers, social profiles. Best for initial data migration and bulk historical imports. CSV-imported targets are not automatically assigned to any target list.

#### Method B: Automated Stripe Webhook Ingestion (Real-Time)

An external Lambda function listens for Stripe webhook events (e.g., `checkout.session.completed`, `customer.created`) and POSTs customer data to the NextCRM ingestion API endpoint at `/api/crm/targets/ingest`.

The Lambda includes `target_list: "post-purchase"` in the request body, which causes the ingestion endpoint to create the target and add it to the `pending-post-purchase` target list. The `contact_origin` is set to `"stripe_webhook"`. Purchase metadata is stored in the target's custom fields (`stripe_customer_id`, `first_order_date`, `last_order_date`, `last_order_id`, `cumulative_order_count`). Deduplication is handled by `stripe_customer_id` — returning customers update the existing target rather than creating a duplicate.

**Key file:** `app/api/crm/targets/ingest/route.ts` — the target-based ingestion endpoint that the Lambda calls.

#### Method C: Netlify Forms Ingestion (Planned — Real-Time)

Netlify Forms can be used to capture signups, newsletter subscriptions, and other web form submissions. A serverless function or webhook handler would listen for form submission events and POST the captured data to `/api/crm/targets/ingest` with the appropriate `target_list` and `contact_origin: "netlify_form"`.

Different forms can route to different target lists by varying the `target_list` parameter:
- A B2C newsletter signup form would use `target_list: "b2c-newsletter"`, routing subscribers to `pending-b2c-newsletter` for an automated welcome sequence.
- A B2B inquiry form might use `target_list: "b2b-newsletter"` for a B2B-specific drip campaign.
- A general "Contact Us" form might omit `target_list` entirely, capturing the lead for manual review without automated campaign routing.

See Section 6.4 (Source 2) for full design details on Netlify Forms integration.

### 10.2 Automating Post-Purchase Email Delivery

The campaign system is batch-oriented: campaigns send to a fixed set of targets at a specific time. There is no built-in "send to each new target as they arrive." To bridge the continuous flow of Stripe purchases to the batch campaign system, the recommended approach is a **Daily Batch Cron** using the existing Inngest infrastructure.

#### 10.2.0 Automation Boundary — What Is Automatic vs. What Is Manual

This is the single most important thing to internalize about the post-purchase flow, and it is a common source of confusion. **For the automated post-purchase workflow, the campaign is created automatically by the cron — you do NOT create it by hand.** The only thing a human prepares ahead of time is the email *template*. The table below is the authoritative split.

| Step in the flow | Automatic or manual? | Who/what does it |
|---|---|---|
| Create the `pending-post-purchase` target list | **Automatic** | The ingestion API (`/api/crm/targets/ingest`) creates it on first use via `getOrCreateTargetList`, derived as `pending-{target_list}` from the Lambda's `target_list: "post-purchase"`. |
| Add the incoming target to that pending list | **Automatic** | The ingestion API adds the target on both the create and update paths. |
| Create the email **template** named `post-purchase` | **Manual (one-time)** | A human builds the template in the campaign template editor and gives it the name `post-purchase` (matching `CAMPAIGN_ROOT`). This is the *only* required manual setup step, and it is done entirely through the existing template editor UI. |
| Create the **campaign** | **Automatic** | The daily cron (`post-purchase-batch.ts`) creates a brand-new dated campaign each run (`post-purchase — {date}`). It is **not** created manually. |
| Create the dated batch target list (`post-purchase-batch-{date}`) | **Automatic** | The cron creates it and populates it with that day's eligible targets. |
| Choose which template the campaign uses | **Automatic (by name)** | The cron looks up the template named `post-purchase` — see 10.2 "How it works" step 2d below. The choice is expressed by *naming the template after the root*, not by selecting it at campaign-creation time. |
| Send the emails + track engagement | **Automatic** | Standard Inngest fan-out → Resend → webhook tracking. |
| Move processed targets to `sent-post-purchase` | **Automatic** | The cron moves them after dispatch. |

**Correcting two common assumptions:**

1. *"The campaign must be created manually with the root name."* — Not for the automated flow. The cron creates the campaign itself. The manual prerequisite is the **template** (named `post-purchase`), not the campaign. Manual campaign creation via the wizard (Section 4.1) is a *separate* path used for ad-hoc/one-off campaigns, not for the automated post-purchase sequence.
2. *"The cron runs an existing campaign if one exists with the correct name."* — No. The cron does not look up or re-run a pre-existing campaign by name. Each run it **creates a fresh dated campaign** from the named template, provided the preconditions below are met.

#### How it works:

The cron is `postPurchaseBatchCron` in `inngest/functions/campaigns/post-purchase-batch.ts`, scheduled `0 9 * * *` (daily at **09:00 UTC**). On each run it executes these steps in order, bailing out early (dispatching nothing) if any precondition is unmet:

1. **Stripe purchase arrives** → Lambda calls `/api/crm/targets/ingest` with `target_list: "post-purchase"` → target is created and added to the `pending-post-purchase` target list (this happens continuously, independent of the cron).
2. **The daily cron** then:
   - **2a. Finds the pending list** `pending-post-purchase`. If it does not exist, the cron exits (`reason: "no pending list found"`).
   - **2b. Finds eligible targets** — members of the pending list whose native `created_on` is **7+ days** in the past. If none are old enough, it exits (`reason: "no eligible targets (all too recent)"`).
   - **2c. Filters out already-sent targets** by checking `crm_campaign_sends` for records tied to any campaign carrying the `post-purchase` marker tag (matched on the campaign's `tags` array). This marker is stamped automatically by the cron when it creates each dated campaign (step 2f) — it is an internal idempotency marker, not a manual setup step. If all remaining targets were already sent, it exits.
   - **2d. Selects the template by name** — `crm_campaign_templates.findFirst({ where: { name: "post-purchase", deletedAt: null } })`, i.e. the template named after the campaign root. **If no template with that name exists, the cron exits** (`reason: 'no template named "post-purchase" found — create one first'`). This is why creating a template named `post-purchase` is the one required manual setup step. Because the name is set in the existing template editor, this step needs no out-of-band database access.
   - **2e. Creates the dated batch list** `post-purchase-batch-{date}` and adds the eligible targets to it.
   - **2f. Creates the campaign** `post-purchase — {date}`, stamped with the internal `[post-purchase]` marker tag, with `template_id` set to the named template and a single order-0 step. The step's subject is `template.subject_default` (falling back to `"Your post-purchase materials"`). The campaign's audience is the dated batch list, **not** the pending list directly.
   - **2g. Creates send records, marks the campaign `sending`, and fans out** one `campaigns/send-step` event per recipient.
   - **2h. Moves processed targets** from `pending-post-purchase` to `sent-post-purchase` (creating the sent list if needed) for record-keeping.
3. **Campaign sends** proceed through the normal Inngest fan-out (send-step → Resend API → webhook tracking).

**The `CAMPAIGN_ROOT` constant**: The cron function defines `const CAMPAIGN_ROOT = "post-purchase"` at the top of the file. All list and campaign names are derived from this constant using the naming patterns documented in Section 6.2. To create a new automated workflow (e.g., a B2C newsletter welcome sequence), duplicate the cron function file and change `CAMPAIGN_ROOT` to the new root name (e.g., `"b2c-newsletter"`). The same naming pattern produces `pending-b2c-newsletter`, `sent-b2c-newsletter`, `b2c-newsletter-batch-{date}`, etc.

**Key file:** `inngest/functions/campaigns/post-purchase-batch.ts`

**Why this approach:**
- Uses 100% of existing campaign infrastructure (target lists, templates, Inngest, Resend, engagement tracking)
- Creates proper campaign records visible in the dashboard with open/click/unsubscribe metrics
- Batches efficiently — one campaign per day, not per purchase
- The post-purchase email template can be managed via the CRM template editor UI
- Multi-step follow-ups work naturally (e.g., a non-opener resend 3 days after the batch send)
- The ~7 day delay is approximate (7-8 days depending on purchase time vs. cron time), which is acceptable since the delay is an estimate for delivery time
- The `CAMPAIGN_ROOT` pattern makes it straightforward to add new automated workflows by duplicating the cron function and changing the root name

**Tradeoffs:**
- Not a precise 7-day delay per customer (could be 7-8 days depending on when the daily cron runs relative to the original purchase)
- Creates one campaign record per batch day (manageable, but accumulates over time)
- Requires a new Inngest cron function to orchestrate the batch logic

#### Alternative Considered: Per-Purchase Inngest Delay

Each ingestion fires an Inngest event → Inngest function sleeps 7 days via `step.sleep("7d")` → creates a one-target campaign and sends. This gives an exact 7-day delay per customer but creates one campaign per purchase, which clutters the dashboard and doesn't support multi-step follow-ups as cleanly. Not recommended unless precise per-customer timing is critical.

#### Alternative Considered: Direct Resend Send (Bypass Campaign System)

Send the email directly via the Resend API after a 7-day Inngest delay, without creating a campaign at all. This is the simplest implementation but loses all CRM tracking (no open/click/unsubscribe analytics, no campaign dashboard visibility, no follow-up capability). Not recommended since engagement tracking is important for iterating on post-purchase email effectiveness.

### 10.3 Double-Send Prevention

The daily batch cron uses two layers of protection against duplicate sends:

**Layer 1 — List-based gating (primary)**: The cron queries the `pending-post-purchase` target list. After processing, targets are moved from `pending-post-purchase` to `sent-post-purchase`. On the next run, processed targets are no longer in the query set.

**Layer 2 — Send-record check (safety net)**: The cron also checks `crm_campaign_sends` for existing send records tied to any campaign carrying the `post-purchase` marker tag (matched on the campaign's `tags` array, not on the template). This tag is an internal marker the cron stamps on every dated campaign it creates — it is not a manual setup step and is distinct from how the template is identified (the template is matched by **name**, see Section 10.6). This layer catches edge cases: a target remaining in the pending list after a partial failure (campaign sent but list-move didn't complete), or a target accidentally re-added to the pending list.

The cron's effective query: *"Targets in the `pending-post-purchase` list where `created_on` is 7+ days ago AND who have no `crm_campaign_sends` records tied to any campaign carrying the `post-purchase` marker tag."*

### 10.4 Testing the Automation

The `pending-post-purchase` target list enables simple manual testing without a test harness:

1. Create a target (e.g., "John Doe") with an email address you control.
2. Add the target to the `pending-post-purchase` target list.
3. Set `created_on` to a date 7+ days in the past so the cron immediately considers the target eligible.
4. Manually trigger the Inngest cron function via the Inngest dashboard (or local dev server) — no need to wait for the scheduled run.
5. Verify: target appears in a dated batch list (e.g., `post-purchase-batch-2026-05-28`), a campaign is created and sent, and the email arrives.
6. Confirm the target was moved from `pending-post-purchase` to the `sent-post-purchase` list.

### 10.5 Organize into Target Lists

Create target lists by product line or buyer category (e.g., `widget-a-buyers`, `service-b-subscribers`, `newsletter-opt-ins`). Assign targets to appropriate lists. A single target can belong to multiple lists. For automated ingestion, the target list assignment happens automatically at ingestion time via the `target_list` parameter. Use kebab-case for all list names to maintain consistency with the automated naming conventions (see Section 6.2).

### 10.6 Create Email Templates

Use the campaign template editor. Use merge tags (`{{first_name}}`, `{{company}}`, etc.) for personalization. Templates are reusable across campaigns.

**Manual campaigns** select their template explicitly in the creation wizard (Step 2, Section 4.1); the chosen `template_id` is stored on the campaign and on each step.

**Automated campaigns choose their template by name, not by selection.** For the post-purchase flow, create a dedicated template with the post-purchase content and **name it `post-purchase`** (matching `CAMPAIGN_ROOT`). The daily cron locates it with `findFirst({ where: { name: "post-purchase", deletedAt: null } })`. Two caveats follow from this:

- The template **must exist with that exact name before the cron runs**, or the cron exits without sending (see Section 10.2 step 2d).
- If **more than one** non-deleted template shares the name `post-purchase`, `findFirst` returns one of them with no defined ordering — keep exactly one template per automated root to avoid ambiguity.

The same pattern applies to any future automated root (e.g. a template named `b2c-newsletter` for a `b2c-newsletter` cron). Because the template name is set in the existing template editor, identifying it this way keeps the whole pipeline — pending list, sent list, batch list, campaign, and template — keyed off one human-readable root string and configurable entirely through the UI, with no out-of-band database setup.

### 10.7 Build Multi-Step Campaigns

For each post-purchase flow, create a campaign with:

| Step | Order | Delay | Example |
|---|---|---|---|
| Initial email | 0 | 0 days | Post-purchase materials / getting started guide |
| Follow-up 1 | 1 | 3-7 days | Check-in, set `send_to` to `"all"` or `"non_openers"` |
| Follow-up N | N | As needed | Additional touches |

For automated flows, the daily batch cron handles campaign creation and triggering. For manual campaigns, assign relevant target list(s) and send immediately or schedule.

### 10.8 Monitor Engagement

Campaign detail page shows: sent count, delivered count, open rate, click rate, bounce rate. Individual recipient status visible in recipients table. Reports > Campaigns provides aggregate analytics. Automated batch campaigns appear in the campaign list with their batch date for easy identification (e.g., `post-purchase — 2026-05-28`).

### 10.9 Convert High-Value Targets to Contacts (Only When Needed)

If a target becomes a genuine sales prospect (reply, demo request, large order), manually convert via target edit form. Creates Account + Contact for CRM pipeline tracking. **Do not bulk-convert** -- this clutters the CRM with non-active sales records.

---

## 11. Key File References

| Component | Path |
|---|---|
| Target ingestion API (multi-source, supports `target_list` routing) | `app/api/crm/targets/ingest/route.ts` |
| Contact ingestion API (legacy, does not support `target_list`) | `app/api/crm/contacts/ingest/route.ts` |
| CSV target import action | `actions/crm/targets/import-targets.ts` |
| CLI contact importer | `scripts/import/crm-contact-importer.ts` |
| Target creation action | `actions/crm/targets/create-target.ts` |
| Target list creation action | `actions/crm/target-lists/create-target-list.ts` |
| Add targets to list action | `actions/crm/target-lists/add-targets-to-list.ts` |
| Target-to-contact conversion | `actions/crm/targets/convert-target.ts` |
| Campaign creation action | `actions/campaigns/create-campaign.ts` |
| Campaign creation wizard (Schedule/Follow-ups) | `app/[locale]/(routes)/campaigns/new/components/Step4Schedule.tsx` |
| Campaign detail / analytics | `app/[locale]/(routes)/campaigns/[campaignId]/components/CampaignDetail.tsx` |
| Inngest campaign scheduling | `inngest/functions/campaigns/schedule-send.ts` |
| Inngest campaign immediate send | `inngest/functions/campaigns/send-now.ts` |
| Inngest campaign send step | `inngest/functions/campaigns/send-step.ts` |
| Follow-up processing (Inngest) | `inngest/functions/campaigns/process-follow-up.ts` |
| Post-purchase batch cron (Inngest) | `inngest/functions/campaigns/post-purchase-batch.ts` |
| Inngest client config | `inngest/client.ts` |
| Campaign steps schema | `prisma/schema.prisma` (lines 337-356, `crm_campaign_steps` table) |
| Campaign sends schema | `prisma/schema.prisma` (`crm_campaign_sends` table) |
| Targets schema | `prisma/schema.prisma` (lines 1228-1283, `crm_Targets` table) |
| MCP campaign tools | `lib/mcp/tools/campaigns.ts` |
| Resend webhook handler | `app/api/campaigns/webhooks/resend/route.ts` |
| Target detail view (BasicView) | `app/[locale]/(routes)/campaigns/targets/[targetId]/components/BasicView.tsx` |
| Update target action | `actions/crm/targets/update-target.ts` |
| Next.js config (redirects) | `next.config.js` |
| Stripe fields migration (targets) | `prisma/migrations/20260525000000_add_stripe_fields_to_targets/migration.sql` |
| Decimal serialization utility | `lib/serialize-decimals.ts` |

---

## 12. Implementation Log

### 12.1 Fix: 405 Error on POST /api/crm/targets/ingest

**Date**: 2026-05-25
**Symptom**: The Stripe ingestion Lambda received a 405 (Method Not Allowed) when POSTing to `/api/crm/targets/ingest`.

Two separate root causes were discovered during investigation:

**Root cause 1 — Overly broad redirect intercepting API routes.** The `next.config.js` redirect rules used `/:locale/crm/targets/:path*` as their source pattern. Because `:locale` is a wildcard matching any single path segment, it captured `api` when the Lambda sent `POST /api/crm/targets/ingest`. This caused Next.js to issue a 308 redirect to `/api/campaigns/targets/ingest` — a path with no `ingest` route — producing the 405 seen in CloudWatch. The fix constrains the `:locale` parameter to only match actual locale values (`en|cz|de|uk`), so API routes pass through to the correct handler. The same fix was applied to the target-lists redirect to prevent a similar issue there.

**Root cause 2 — Missing database migration for `crm_Targets` table.** The previous agent run added Stripe/post-purchase automation fields (`stripe_customer_id`, `contact_origin`, `is_b2b`, `first_order_date`, `last_order_date`, `last_order_id`, `cumulative_order_count`, `opt_in_time`, `b2b_discount_percent`, `is_temporary`) to the Prisma schema for both `crm_Contacts` and `crm_Targets`, but only created a database migration for `crm_Contacts`. Without the migration, the `crm_Targets` database table lacked these columns, which would have caused runtime errors (500s) once the redirect issue was resolved and the route was reachable. A new migration (`20260525000000_add_stripe_fields_to_targets`) was added to create the missing columns and indexes on `crm_Targets`.

**Files changed:**
- `next.config.js` — Constrained redirect `:locale` parameter from wildcard to `(en|cz|de|uk)` for both `/crm/targets/` and `/crm/target-lists/` redirects
- `prisma/migrations/20260525000000_add_stripe_fields_to_targets/migration.sql` — New migration adding 10 Stripe/automation columns and 3 indexes to the `crm_Targets` table

### 12.2 Enhancement: Target Detail View — Custom Fields Card

**Date**: 2026-05-25
**Context**: The previous fix added database columns and a migration for the new Stripe/automation fields on `crm_Targets`, but the target detail UI did not render any of those fields. When viewing a target, users would only see the original fields (name, company, contact info, social networks) with no visibility into the Stripe-synced data.

**Changes**: A new "Custom Fields" card was added to the target detail view (`BasicView.tsx`) that displays all 10 Stripe/automation fields in a two-column grid: Stripe Customer ID, Contact Origin, Is B2B, B2B Discount %, First Order Date, Last Order Date, Last Order ID, Cumulative Order Count, Opt In Time, and Is Temporary. The card follows the same layout and styling as the equivalent section already present on the Contact detail view. The card appears between the social networks section and the notes section.

The `updateTarget` server action was also updated to accept all 10 new fields in its type definition, so these fields can be persisted through future form submissions or programmatic updates. Previously the action would silently ignore any of these fields passed to it because they were not in the TypeScript type.

**Files changed:**
- `app/[locale]/(routes)/campaigns/targets/[targetId]/components/BasicView.tsx` — Added "Custom Fields" card displaying all 10 Stripe/automation fields
- `actions/crm/targets/update-target.ts` — Added the 10 new fields to the action's TypeScript type definition

### 12.3 Multi-Source Ingestion — `target_list` Field and Naming Convention

**Date**: 2026-05-28
**Context**: The ingestion endpoint was originally hardcoded to assign every incoming target to a single "Pending Post-Purchase" target list. The design discussions in attempts 1-3 established a multi-source ingestion pattern where different sources (Stripe, Netlify Forms, future integrations) can route targets to different pending lists based on a `target_list` parameter, or capture targets without any list assignment at all.

**Design decisions documented**:
- The `target_list` field on the ingestion endpoint is optional. When provided, the system derives a pending list name using the `pending-{target_list}` pattern. When omitted, the target is captured unconditionally without list assignment.
- All list names use kebab-case (e.g., `pending-post-purchase`, `sent-post-purchase`, `post-purchase-batch-2026-05-28`).
- The `CAMPAIGN_ROOT` constant in each Inngest cron function serves as the root name from which all related list and campaign names are derived.
- `contact_origin` accumulates source values for provenance tracking but is not used for list routing or campaign assignment.
- Netlify Forms is identified as the next planned ingestion source, with form-specific `target_list` values controlling routing to different campaign workflows.

**Code changes** (implemented in prior agent runs):
- `app/api/crm/targets/ingest/route.ts` — Added optional `target_list` field support; pending list creation uses `pending-{target_list}` pattern; targets without `target_list` are captured without list assignment
- `inngest/functions/campaigns/post-purchase-batch.ts` — Replaced hardcoded list names with `CAMPAIGN_ROOT`-driven derivation (`pending-${CAMPAIGN_ROOT}`, `sent-${CAMPAIGN_ROOT}`, `${CAMPAIGN_ROOT}-batch-${date}`)

### 12.4 Clarification — Automation Boundary and Template-Tag Selection

**Date**: 2026-05-29
**Context**: A review of the live `post-purchase-batch.ts` cron and the `targets/ingest` route was performed to confirm exactly what is automated versus manual in the post-purchase flow, and to correct two mistaken assumptions held while reasoning about the system. No code was changed in this pass — only the documentation was clarified to match the verified behavior.

> **Superseded in part by Section 12.5**: this entry records the system as it behaved *before* the template lookup was changed. The findings about the automation boundary, campaign creation, and double-send prevention still hold. The specific finding that the template is selected **by tag** is no longer current — the cron now selects the template **by name**. See Section 12.5.

**Findings verified against code**:

- **Pending list + target capture are automatic (assumption confirmed)**: When the Stripe Lambda POSTs with `target_list: "post-purchase"`, the ingestion route derives `pending-post-purchase`, creates the list if absent (`getOrCreateTargetList`), and adds the target on both the create and update paths. Confirmed in `app/api/crm/targets/ingest/route.ts`.
- **The campaign is created automatically, not manually (assumption corrected)**: The daily cron creates a fresh dated campaign (`post-purchase — {date}`, tagged `[post-purchase]`) on every qualifying run. There is no manual campaign-creation step in the automated flow. The only required manual setup is an email **template tagged `post-purchase`**.
- **The cron does not "run an existing campaign by name" (assumption corrected)**: It builds a new campaign each run from the tagged template, gated by four preconditions (pending list exists, targets are 7+ days old, not already sent under a `post-purchase`-tagged campaign, and a `post-purchase`-tagged template exists). Each precondition has its own early-exit reason string.
- **The template is selected by tag for automated flows**: `crm_campaign_templates.findFirst({ where: { tags: { has: "post-purchase" } } })`. Manual campaigns, by contrast, select a template explicitly in the wizard. A caveat was documented: multiple templates sharing the tag make `findFirst` non-deterministic.
- **No abandoned-cart cron exists (assumption confirmed)**: `postPurchaseBatchCron` is the only campaign cron registered in `app/api/inngest/route.ts`. Adding an abandoned-cart flow would follow the `CAMPAIGN_ROOT` pattern: a new cron file with `CAMPAIGN_ROOT = "abandoned-cart"`, the Lambda sending `target_list: "abandoned-cart"`, and a template tagged `abandoned-cart`.

**Doc changes**:
- Added Section 10.2.0 "Automation Boundary — What Is Automatic vs. What Is Manual" with a responsibility table and explicit correction of the two assumptions.
- Rewrote the Section 10.2 "How it works" steps to reflect the cron's exact step sequence, schedule (`0 9 * * *`, 09:00 UTC), and early-exit conditions.
- Corrected Section 10.3 Layer 2 to state the safety-net check matches campaigns by the `post-purchase` **tag** (not by template).
- Expanded Section 10.6 to document template selection by tag for automated flows and the single-template-per-root caveat.

### 12.5 Change — Template Lookup Switched from Tag to Root-Name Convention

**Date**: 2026-05-29
**Context**: Section 12.4 documented that the post-purchase cron located its email template by a `tags: { has: "post-purchase" }` lookup. Investigation showed that the `tags` field on `crm_campaign_templates` cannot be set anywhere in the product UI — neither the template editor nor any server action reads or writes it. The only way to tag a template was to edit the database directly, making the one required manual setup step invisible and undiscoverable. The lists, batch lists, and campaign in the same pipeline are already keyed off the human-readable root name, so the template was the lone exception relying on a hidden field.

**Decision**: Switch the template lookup to the root-name convention so the entire pipeline keys off one human-readable root string, and the required manual setup (creating the template) is done entirely through the existing template editor with no out-of-band database access.

**Code change**:
- `inngest/functions/campaigns/post-purchase-batch.ts` — the `find-template` step now queries `crm_campaign_templates.findFirst({ where: { name: CAMPAIGN_ROOT, deletedAt: null } })` instead of `{ tags: { has: CAMPAIGN_ROOT } }`. The early-exit reason string was updated to `no template named "post-purchase" found — create one first`. No other behavior changed.

**What was intentionally left unchanged**: The campaign's `tags: [CAMPAIGN_ROOT]` value is still stamped on each dated campaign the cron creates, and the double-send safety net still matches campaigns on that tag. This tag is an internal idempotency marker applied automatically by the cron — it requires no manual setup and is not the invisible-configuration problem that motivated the template change, so it was kept as-is.

**Operator impact**: The post-purchase email template must now be **named** `post-purchase` (matching `CAMPAIGN_ROOT`) rather than tagged. Any existing template that was previously relying on the `post-purchase` tag must be renamed to `post-purchase` for the cron to find it.

**Doc changes**:
- Updated Section 6.2 to add the template name (`{root}`) to the derived-names table.
- Updated the Section 10.2.0 responsibility table and assumption corrections to describe template selection by name.
- Updated Section 10.2 step 2d to describe the name-based lookup and its early-exit reason, and clarified step 2c/2f that the campaign tag is an internal marker.
- Updated Section 10.3 Layer 2 to clarify the campaign marker tag is auto-applied and distinct from template identification.
- Updated Section 10.6 to document template selection by name and the single-template-per-root caveat.
- Added the superseding note to Section 12.4.
