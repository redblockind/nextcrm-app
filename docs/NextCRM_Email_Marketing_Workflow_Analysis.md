# NextCRM Email Marketing Workflow Analysis

> **Purpose**: Reference guide for AI agents and humans working with the NextCRM email marketing system.
> **Last validated**: 2026-05-27
> **Source**: Code analysis of the NextCRM codebase (multiple agent runs consolidated).

---

## Table of Contents

- [1. Data Model Overview](#1-data-model-overview)
- [1.1 Target Custom Fields](#11-target-custom-fields)
- [1.2 Data Migration Strategy](#12-data-migration-strategy)
- [2. Assumption Validation](#2-assumption-validation)
- [3. Campaign System Architecture](#3-campaign-system-architecture)
- [4. Multi-Step Campaign Configuration](#4-multi-step-campaign-configuration)
- [5. Engagement Tracking and Action-Based Follow-Ups](#5-engagement-tracking-and-action-based-follow-ups)
- [6. Recommended Email Marketing Workflow](#6-recommended-email-marketing-workflow)
- [6.1 Double-Send Prevention](#61-double-send-prevention)
- [6.2 Testing the Automation](#62-testing-the-automation)
- [7. Known Limitations](#7-known-limitations)
- [8. Workarounds for Missing Features](#8-workarounds-for-missing-features)
- [9. Features Safe to Ignore for Email Marketing](#9-features-safe-to-ignore-for-email-marketing)
- [10. Key File References](#10-key-file-references)
- [11. Implementation Log](#11-implementation-log)
- [11.1 Fix: 405 Error on POST /api/crm/targets/ingest](#111-fix-405-error-on-post-apicrmtargetsingest)
- [11.2 Enhancement: Target Detail View — Custom Fields Card](#112-enhancement-target-detail-view--custom-fields-card)

---

## 1. Data Model Overview

```
                          ┌─────────────────┐
                          │  Data Ingestion  │
                          └────────┬────────┘
                 ┌─────────────────┼─────────────────┐
                 │                 │                  │
          CSV Import      Stripe Webhook       (Future sources)
          (manual)        (automated via        
                           Lambda + API)        
                 │                 │                  │
                 └─────────────────┼──────────────────┘
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

### 1.1 Target Custom Fields

The following optional fields are added to `crm_Targets` to support the automated post-purchase workflow. All are nullable — the Prisma migration is `ALTER TABLE ADD COLUMN ... DEFAULT NULL` with zero risk to existing data. Existing code (campaigns, enrichment, UI, list management) ignores columns it doesn't reference, so this is a safe additive change.

| Field | Type | Purpose |
|---|---|---|
| `stripe_customer_id` | `String?` | Dedup key for Stripe webhook target ingestion. Prevents duplicate targets for returning customers. |
| `first_order_date` | `String?` | Records when the customer first ordered in Stripe. Historical reference only — **not** used for automation timing (see design decision below). |
| `last_order_date` | `String?` | Identifies repeat vs. one-time buyers for segmentation. |
| `last_order_id` | `String?` | Traceability back to Stripe for debugging or customer service. |
| `cumulative_order_count` | `String?` | First-time vs. repeat buyer segmentation. |
| `contact_origin` | `String?` | How the target was created: `"stripe_webhook"`, `"csv_import"`, `"manual"`. |
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

## 6. Recommended Email Marketing Workflow

This workflow uses the minimum set of NextCRM features needed for email marketing, stays within the application's intended design, and avoids the complexity of the full CRM pipeline until sales tracking is actually needed.

### Data Ingestion Methods

Two methods exist for getting buyer data into the Targets system:

#### Method A: Manual CSV Import (Batch / Historical)

Export contacts from the previous CRM as CSV. Import into NextCRM as targets via the web UI. Supported CSV fields: `first_name`, `last_name`, `email`, `company`, `position`, phone numbers, social profiles. Best for initial data migration and bulk historical imports.

#### Method B: Automated Stripe Webhook Ingestion (Real-Time)

An external Lambda function listens for Stripe webhook events (e.g., `checkout.session.completed`, `customer.created`) and POSTs customer data to the NextCRM ingestion API endpoint at `/api/crm/contacts/ingest`.

**Current state (needs migration):** The ingestion endpoint currently creates **contacts** (`crm_Contacts`), which are invisible to the campaign system. This must be changed to create **targets** (`crm_Targets`) instead, since campaigns can only send to targets via target lists.

**Required changes for automation:**
1. Create a new ingestion endpoint (or modify existing) that writes to `crm_Targets` instead of `crm_Contacts`
2. Auto-assign each new target to a standing target list (e.g., "Stripe Purchasers - Pending Post-Purchase Email")
3. Store purchase metadata using available target fields (`tags`, `notes`, `description`) and any new schema fields added for Stripe data (e.g., `stripe_customer_id`)
4. Handle deduplication by email (update existing target if found, create new if not)

**Key file:** `app/api/crm/contacts/ingest/route.ts` — the current contact-based ingestion endpoint that the Lambda calls.

### Automating Post-Purchase Email Delivery

The campaign system is batch-oriented: campaigns send to a fixed set of targets at a specific time. There is no built-in "send to each new target as they arrive." To bridge the continuous flow of Stripe purchases to the batch campaign system, the recommended approach is a **Daily Batch Cron** using the existing Inngest infrastructure.

#### Recommended: Daily Batch Cron via Inngest

**How it works:**

1. **Stripe purchase arrives** → Lambda calls ingestion API → target is created and added to the "Pending Post-Purchase" target list
2. **Daily Inngest cron job** (e.g., every morning at 9am) runs and:
   - Queries targets in the "Pending" list where `created_on` is 7+ days ago
   - Filters out targets that have already received the post-purchase campaign (by checking `crm_campaign_sends`)
   - If eligible targets exist: creates a dated batch target list (e.g., "Post-Purchase Batch 2026-05-23"), creates a campaign from the pre-built post-purchase template, triggers the send
   - Moves processed targets from the "Pending" list to a "Sent" list for record-keeping
3. **Campaign sends** proceed through the normal Inngest fan-out (send-step → Resend API → webhook tracking)

**Why this approach:**
- Uses 100% of existing campaign infrastructure (target lists, templates, Inngest, Resend, engagement tracking)
- Creates proper campaign records visible in the dashboard with open/click/unsubscribe metrics
- Batches efficiently — one campaign per day, not per purchase
- The post-purchase email template can be managed via the CRM template editor UI
- Multi-step follow-ups work naturally (e.g., a non-opener resend 3 days after the batch send)
- The ~7 day delay is approximate (7-8 days depending on purchase time vs. cron time), which is acceptable since the delay is an estimate for delivery time

**Tradeoffs:**
- Not a precise 7-day delay per customer (could be 7-8 days depending on when the daily cron runs relative to the original purchase)
- Creates one campaign record per batch day (manageable, but accumulates over time)
- Requires a new Inngest cron function to orchestrate the batch logic

#### Alternative Considered: Per-Purchase Inngest Delay

Each ingestion fires an Inngest event → Inngest function sleeps 7 days via `step.sleep("7d")` → creates a one-target campaign and sends. This gives an exact 7-day delay per customer but creates one campaign per purchase, which clutters the dashboard and doesn't support multi-step follow-ups as cleanly. Not recommended unless precise per-customer timing is critical.

#### Alternative Considered: Direct Resend Send (Bypass Campaign System)

Send the email directly via the Resend API after a 7-day Inngest delay, without creating a campaign at all. This is the simplest implementation but loses all CRM tracking (no open/click/unsubscribe analytics, no campaign dashboard visibility, no follow-up capability). Not recommended since engagement tracking is important for iterating on post-purchase email effectiveness.

### 6.1 Double-Send Prevention

The daily batch cron uses two layers of protection against duplicate sends:

**Layer 1 — List-based gating (primary)**: The cron queries the "Pending Post-Purchase" target list. After processing, targets are moved from "Pending" to "Sent Post-Purchase". On the next run, processed targets are no longer in the query set.

**Layer 2 — Send-record check (safety net)**: The cron also checks `crm_campaign_sends` for existing send records matching the post-purchase campaign template. This catches edge cases: a target remaining in Pending after a partial failure (campaign sent but list-move didn't complete), or a target accidentally re-added to Pending.

The cron's effective query: *"Targets in the Pending list where `created_on` is 7+ days ago AND who have no `crm_campaign_sends` records for a post-purchase campaign."*

### 6.2 Testing the Automation

The Pending Post-Purchase target list enables simple manual testing without a test harness:

1. Create a target (e.g., "John Doe") with an email address you control.
2. Add the target to the "Pending Post-Purchase" target list.
3. Set `created_on` to a date 7+ days in the past so the cron immediately considers the target eligible.
4. Manually trigger the Inngest cron function via the Inngest dashboard (or local dev server) — no need to wait for the scheduled run.
5. Verify: target appears in a dated batch list (e.g., "Post-Purchase Batch 2026-05-23"), a campaign is created and sent, and the email arrives.
6. Confirm the target was moved from "Pending" to the "Sent Post-Purchase" list.

### Step 2: Organize into Target Lists

Create target lists by product line or buyer category (e.g., "Widget A Buyers", "Service B Subscribers", "Newsletter Opt-ins"). Assign targets to appropriate lists. A single target can belong to multiple lists. For automated ingestion, the target list assignment happens automatically at ingestion time.

### Step 3: Create Email Templates

Use the campaign template editor. Use merge tags (`{{first_name}}`, `{{company}}`, etc.) for personalization. Templates are reusable across campaigns. For the post-purchase flow, create a dedicated template with the post-purchase materials content.

### Step 4: Build Multi-Step Campaigns

For each post-purchase flow, create a campaign with:

| Step | Order | Delay | Example |
|---|---|---|---|
| Initial email | 0 | 0 days | Post-purchase materials / getting started guide |
| Follow-up 1 | 1 | 3-7 days | Check-in, set `send_to` to `"all"` or `"non_openers"` |
| Follow-up N | N | As needed | Additional touches |

For automated flows, the daily batch cron handles campaign creation and triggering. For manual campaigns, assign relevant target list(s) and send immediately or schedule.

### Step 5: Monitor Engagement

Campaign detail page shows: sent count, delivered count, open rate, click rate, bounce rate. Individual recipient status visible in recipients table. Reports > Campaigns provides aggregate analytics. Automated batch campaigns appear in the campaign list with their batch date for easy identification.

### Step 6: Convert High-Value Targets to Contacts (Only When Needed)

If a target becomes a genuine sales prospect (reply, demo request, large order), manually convert via target edit form. Creates Account + Contact for CRM pipeline tracking. **Do not bulk-convert** -- this clutters the CRM with non-active sales records.

---

## 7. Known Limitations

| Limitation | Impact | Compliance risk |
|---|---|---|
| No global unsubscribe list | Unsubscribe is per-campaign; target can still receive other campaigns | **CAN-SPAM / GDPR** |
| No automated target list management | New buyers must be manually CSV-imported and assigned to lists unless using the Stripe webhook automation (see Section 6) | Operational overhead |
| No event-triggered campaigns | All campaigns are one-shot (send now or schedule); automated post-purchase flow uses daily batch cron as workaround (see Section 6) | Feature gap |
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

## 10. Key File References

| Component | Path |
|---|---|
| Stripe customer ingestion API (currently contacts, needs migration to targets) | `app/api/crm/contacts/ingest/route.ts` |
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

---

## 11. Implementation Log

### 11.1 Fix: 405 Error on POST /api/crm/targets/ingest

**Date**: 2026-05-25
**Symptom**: The Stripe ingestion Lambda received a 405 (Method Not Allowed) when POSTing to `/api/crm/targets/ingest`.

Two separate root causes were discovered during investigation:

**Root cause 1 — Overly broad redirect intercepting API routes.** The `next.config.js` redirect rules used `/:locale/crm/targets/:path*` as their source pattern. Because `:locale` is a wildcard matching any single path segment, it captured `api` when the Lambda sent `POST /api/crm/targets/ingest`. This caused Next.js to issue a 308 redirect to `/api/campaigns/targets/ingest` — a path with no `ingest` route — producing the 405 seen in CloudWatch. The fix constrains the `:locale` parameter to only match actual locale values (`en|cz|de|uk`), so API routes pass through to the correct handler. The same fix was applied to the target-lists redirect to prevent a similar issue there.

**Root cause 2 — Missing database migration for `crm_Targets` table.** The previous agent run added Stripe/post-purchase automation fields (`stripe_customer_id`, `contact_origin`, `is_b2b`, `first_order_date`, `last_order_date`, `last_order_id`, `cumulative_order_count`, `opt_in_time`, `b2b_discount_percent`, `is_temporary`) to the Prisma schema for both `crm_Contacts` and `crm_Targets`, but only created a database migration for `crm_Contacts`. Without the migration, the `crm_Targets` database table lacked these columns, which would have caused runtime errors (500s) once the redirect issue was resolved and the route was reachable. A new migration (`20260525000000_add_stripe_fields_to_targets`) was added to create the missing columns and indexes on `crm_Targets`.

**Files changed:**
- `next.config.js` — Constrained redirect `:locale` parameter from wildcard to `(en|cz|de|uk)` for both `/crm/targets/` and `/crm/target-lists/` redirects
- `prisma/migrations/20260525000000_add_stripe_fields_to_targets/migration.sql` — New migration adding 10 Stripe/automation columns and 3 indexes to the `crm_Targets` table

### 11.2 Enhancement: Target Detail View — Custom Fields Card

**Date**: 2026-05-25
**Context**: The previous fix added database columns and a migration for the new Stripe/automation fields on `crm_Targets`, but the target detail UI did not render any of those fields. When viewing a target, users would only see the original fields (name, company, contact info, social networks) with no visibility into the Stripe-synced data.

**Changes**: A new "Custom Fields" card was added to the target detail view (`BasicView.tsx`) that displays all 10 Stripe/automation fields in a two-column grid: Stripe Customer ID, Contact Origin, Is B2B, B2B Discount %, First Order Date, Last Order Date, Last Order ID, Cumulative Order Count, Opt In Time, and Is Temporary. The card follows the same layout and styling as the equivalent section already present on the Contact detail view. The card appears between the social networks section and the notes section.

The `updateTarget` server action was also updated to accept all 10 new fields in its type definition, so these fields can be persisted through future form submissions or programmatic updates. Previously the action would silently ignore any of these fields passed to it because they were not in the TypeScript type.

**Files changed:**
- `app/[locale]/(routes)/campaigns/targets/[targetId]/components/BasicView.tsx` — Added "Custom Fields" card displaying all 10 Stripe/automation fields
- `actions/crm/targets/update-target.ts` — Added the 10 new fields to the action's TypeScript type definition
