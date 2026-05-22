# NextCRM Email Marketing Workflow Analysis

> **Purpose**: Reference guide for AI agents and humans working with the NextCRM email marketing system.
> **Last validated**: 2026-05-22
> **Source**: Code analysis of the NextCRM codebase (two independent agent runs consolidated).

---

## Table of Contents

- [1. Data Model Overview](#1-data-model-overview)
- [2. Assumption Validation](#2-assumption-validation)
- [3. Campaign System Architecture](#3-campaign-system-architecture)
- [4. Multi-Step Campaign Configuration](#4-multi-step-campaign-configuration)
- [5. Engagement Tracking and Action-Based Follow-Ups](#5-engagement-tracking-and-action-based-follow-ups)
- [6. Recommended Email Marketing Workflow](#6-recommended-email-marketing-workflow)
- [7. Known Limitations](#7-known-limitations)
- [8. Workarounds for Missing Features](#8-workarounds-for-missing-features)
- [9. Features Safe to Ignore for Email Marketing](#9-features-safe-to-ignore-for-email-marketing)
- [10. Key File References](#10-key-file-references)

---

## 1. Data Model Overview

```
CSV Import --> Targets --> Target Lists --> Campaigns --> Email Sends (via Resend)
                |                                              |
                |                                      Tracking: opens,
                |                                      clicks, bounces,
                |                                      unsubscribes
                |
         [Manual Convert]
                |
                v
         Account + Contact --> Opportunities --> Contracts --> Invoices
         (Sales Pipeline - only when needed)
```

**Core design principle**: NextCRM treats **Targets** as the email marketing universe and **Contacts** as the sales relationship universe. These are deliberately separate systems. Campaigns operate exclusively on targets. The CRM pipeline (Accounts > Contacts > Opportunities > Contracts > Invoices) operates on contacts. The bridge is a manual, one-at-a-time conversion action.

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

### Step 1: Import Buyers as Targets via CSV

Export contacts from the previous CRM as CSV. Import into NextCRM as targets. Supported CSV fields: `first_name`, `last_name`, `email`, `company`, `position`, phone numbers, social profiles.

### Step 2: Organize into Target Lists

Create target lists by product line or buyer category (e.g., "Widget A Buyers", "Service B Subscribers", "Newsletter Opt-ins"). Assign targets to appropriate lists. A single target can belong to multiple lists.

### Step 3: Create Email Templates

Use the campaign template editor. Use merge tags (`{{first_name}}`, `{{company}}`, etc.) for personalization. Templates are reusable across campaigns.

### Step 4: Build Multi-Step Campaigns

For each post-purchase flow, create a campaign with:

| Step | Order | Delay | Example |
|---|---|---|---|
| Initial email | 0 | 0 days | Thank you / getting started guide |
| Follow-up 1 | 1 | 3-7 days | Check-in, set `send_to` to `"all"` or `"non_openers"` |
| Follow-up N | N | As needed | Additional touches |

Assign relevant target list(s). Send immediately or schedule.

### Step 5: Monitor Engagement

Campaign detail page shows: sent count, delivered count, open rate, click rate, bounce rate. Individual recipient status visible in recipients table. Reports > Campaigns provides aggregate analytics.

### Step 6: Convert High-Value Targets to Contacts (Only When Needed)

If a target becomes a genuine sales prospect (reply, demo request, large order), manually convert via target edit form. Creates Account + Contact for CRM pipeline tracking. **Do not bulk-convert** -- this clutters the CRM with non-active sales records.

---

## 7. Known Limitations

| Limitation | Impact | Compliance risk |
|---|---|---|
| No global unsubscribe list | Unsubscribe is per-campaign; target can still receive other campaigns | **CAN-SPAM / GDPR** |
| No automated target list management | New buyers must be manually CSV-imported and assigned to lists | Operational overhead |
| No event-triggered campaigns | All campaigns are one-shot (send now or schedule); no purchase/signup triggers | Feature gap |
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
| CSV target import action | `actions/crm/targets/import-targets.ts` |
| CLI contact importer | `scripts/import/crm-contact-importer.ts` |
| Target-to-contact conversion | `actions/crm/targets/convert-target.ts` |
| Campaign creation wizard (Schedule/Follow-ups) | `app/[locale]/(routes)/campaigns/new/components/Step4Schedule.tsx` |
| Campaign detail / analytics | `app/[locale]/(routes)/campaigns/[campaignId]/components/CampaignDetail.tsx` |
| Follow-up processing (Inngest) | `inngest/functions/campaigns/process-follow-up.ts` |
| Campaign steps schema | `prisma/schema.prisma` (lines 337-356, `crm_campaign_steps` table) |
| Campaign sends schema | `prisma/schema.prisma` (`crm_campaign_sends` table) |
| MCP campaign tools | `lib/mcp/tools/campaigns.ts` |
| Resend webhook handler | Check Inngest functions for webhook event handlers |
