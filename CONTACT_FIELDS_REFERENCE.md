# NextCRM Contact Model - Complete Field Reference
**For: CSV Import, Stripe Webhook, Netlify Forms Webhook Mapping**

Generated: April 28, 2026

---

## 1. Core Identity Fields

| Field Name | DB Column | Type | Required | Importable | Notes |
|---|---|---|---|---|---|
| **First Name** | `first_name` | String | No | ✓ | Maps to Amazon Connect `FirstName` |
| **Last Name** | `last_name` | String | **YES** | ✓ | REQUIRED - Must have at least last name |
| **Email** | `email` | String | No | ✓ | Primary email; use for deduplication |
| **Personal Email** | `personal_email` | String | No | ✓ | Alternative email address |
| **Position/Title** | `position` | String | No | ✓ | Job title (e.g., "Sales Manager") |
| **Status** | `status` | Boolean | No | ✓ | Active=true, Inactive=false; default=true |

---

## 2. Contact Information

| Field Name | DB Column | Type | Required | Importable | Notes |
|---|---|---|---|---|---|
| **Office Phone** | `office_phone` | String | No | ✓ | Business phone number |
| **Mobile Phone** | `mobile_phone` | String | No | ✓ | Cell phone number |
| **Website** | `website` | String | No | ✓ | Contact's website URL |
| **Description** | `description` | String | No | ✓ | General notes/description about contact |

---

## 3. Birthday (Composite Field)

| Field Name | DB Column | Type | Required | Importable | Notes |
|---|---|---|---|---|---|
| **Birthday** | `birthday` | String | No | ✓ | Stored as single field; input split into day/month/year |
| Birthday (Input - Day) | `birthday_day` | String | No | ✓ | Day (1-31); used during import |
| Birthday (Input - Month) | `birthday_month` | String | No | ✓ | Month (1-12); used during import |
| Birthday (Input - Year) | `birthday_year` | String | No | ✓ | Year (YYYY); used during import |

---

## 4. Social Media Profiles

| Field Name | DB Column | Type | Required | Importable | Notes |
|---|---|---|---|---|---|
| **Twitter** | `social_twitter` | String | No | ✓ | Twitter handle/profile |
| **Facebook** | `social_facebook` | String | No | ✓ | Facebook profile |
| **LinkedIn** | `social_linkedin` | String | No | ✓ | LinkedIn profile |
| **Skype** | `social_skype` | String | No | ✓ | Skype username |
| **Instagram** | `social_instagram` | String | No | ✓ | Instagram profile |
| **YouTube** | `social_youtube` | String | No | ✓ | YouTube channel |
| **TikTok** | `social_tiktok` | String | No | ✓ | TikTok profile |

---

## 5. Relationships & Links

| Field Name | DB Column | Type | Required | Importable | Notes |
|---|---|---|---|---|---|
| **Account** | `accountsIDs` | UUID | No | ✓ | Link to parent Account/Company |
| **Assigned To** | `assigned_to` | UUID | No | ✓ | User ID for assignment (sales rep, etc.) |
| **Contact Type** | `contact_type_id` | UUID | No | ✓ | Reference to contact type (Customer, Prospect, etc.) |
| **Tags** | `tags` | String[] | No | ✓ | Array of tags (e.g., ["VIP", "Enterprise"]) |
| **Notes** | `notes` | String[] | No | ✓ | Array of note entries |

---

## 6. Audit & Lifecycle Fields

| Field Name | DB Column | Type | Required | Importable | Notes |
|---|---|---|---|---|---|
| **ID** | `id` | UUID | Yes (auto) | ✗ | Auto-generated; DO NOT import |
| **Created Date** | `created_on` / `cratedAt` | DateTime | No | ✓ | When contact was created (usually auto-set) |
| **Created By** | `created_by` | UUID | No | ✓ | User who created the contact |
| **Updated Date** | `updatedAt` | DateTime | No | ✗ | Auto-managed; DO NOT import |
| **Updated By** | `updatedBy` | UUID | No | ✗ | Auto-managed; DO NOT import |
| **Last Activity Date** | `last_activity` | DateTime | No | ✓ | When contact was last engaged |
| **Last Activity By** | `last_activity_by` | UUID | No | ✓ | User who had last activity |
| **Deleted Date** | `deletedAt` | DateTime | No | ✗ | For soft-deletes; DO NOT import (use status instead) |
| **Deleted By** | `deletedBy` | UUID | No | ✗ | For soft-deletes; DO NOT import |

---

## 7. Internal/System Fields

| Field Name | DB Column | Type | Required | Importable | Notes |
|---|---|---|---|---|---|
| **Version** | `v` | Int | No | ✗ | Internal version counter; DO NOT import |
| **Embedding** | `embedding` | Relation | No | ✗ | AI embedding data; DO NOT import |

---

## 8. Field Recommendations for Import

### **Must-Have (Import these)**
- `first_name` — unless only company name available
- `last_name` — **REQUIRED**
- `email` — for deduplication and contact

### **Should-Have (Highly Recommended)**
- `office_phone` or `mobile_phone`
- `position` — job title
- `accountsIDs` — link to company/account if available

### **Nice-to-Have (Optional)**
- `description` — any notes from old CRM
- `tags` — categorization (e.g., "Migrated from Amazon Connect")
- `social_linkedin` — for B2B enrichment
- `created_on` — preserve original creation date if available
- `status` — mark as active/inactive if needed

### **DO NOT Import (Auto-Managed)**
- `id` — auto-generated
- `updatedAt`, `updatedBy` — auto-managed
- `v` — internal version counter
- `deletedAt`, `deletedBy` — use status field instead
- `embedding` — AI system field

---

## 9. Source Tracking Field (for your use case)

**NOTE**: NextCRM does NOT have a built-in "Source" or "Origin" field in the Contact model.

**Recommended Approach**:
1. **Use `tags` array** — Add tags like:
   - `"imported-from-amazon-connect"`
   - `"stripe-customer"`
   - `"netlify-signup"`
   
2. **Use `description` field** — Prepend source info:
   - `"[Source: Stripe] Customer since 2026-01-15"`
   - `"[Source: Netlify Form] Newsletter signup"`

3. **Create a new field** (if needed) — Consider adding a `source` field to the schema if this becomes critical for business logic.

---

## 10. Contact Type IDs (Reference)

This field (`contact_type_id`) links to the `crm_Contact_Types` table. Common types might include:
- `Customer`
- `Prospect`
- `Partner`
- `Vendor`
- `Lead`

You'll need to query or create contact types first, then use their IDs during import.

---

## 11. Data Type Reference

| Type | Description | Example |
|---|---|---|
| **String** | Text field | "John", "john@example.com" |
| **String?** | Optional text field | null or "value" |
| **String[]** | Array of strings | ["tag1", "tag2"] |
| **Boolean** | True/False | true, false |
| **UUID** | Unique identifier | "550e8400-e29b-41d4-a716-446655440000" |
| **DateTime** | Timestamp | "2026-04-28T10:30:00Z" |

---

## 12. Mapping Template for Your Imports

Use this template when configuring your webhooks:

```
Source Field (CSV/Stripe/Netlify) → NextCRM Field → Type → Required? → Notes
```

### Example for Stripe:
```
customer.email → email → String → No → Primary identifier
customer.name → first_name + last_name → String → Yes → Split on space
customer.metadata.source → tags → String[] → No → Add "stripe-customer" tag
stripe_customer_id → description → String → No → Store as reference
```

### Example for Netlify:
```
email → email → String → No → Dedup check
name → first_name + last_name → String → Yes → Split on space
company → description → String → No → Include company name
form_source → tags → String[] → No → Tag with form name
```

---

## 13. Deduplication Strategy

When importing from multiple sources, use this priority:

1. **Check email first** — `SELECT * WHERE email = ?` or `crm_search_contacts(email: value)`
2. **Then check name** — If same email exists, skip (duplicate)
3. **Add source tag** — Tag with origin (stripe, netlify, imported-csv)
4. **Log conflicts** — If duplicate found with different data, log and skip

---

## 14. Known Schema Issues & Notes

- **Birthday field**: Stored as single `birthday` string, but inputs accept split `birthday_day`, `birthday_month`, `birthday_year`
- **Type field**: Legacy `type` column was removed. Use `contact_type_id` instead.
- **Timestamp columns**: Both `created_on` and `cratedAt` exist (appears to be a typo in schema; `cratedAt` likely meant to be `createdAt`). Avoid using `cratedAt` in new code.
- **No "Source" field**: Use tags or description to track contact origin

---

## 15. Next Steps

1. **Review this document** — Decide which fields are important for your use case
2. **Create mapping document** — For each source (CSV, Stripe, Netlify), define field → CRM field mappings
3. **Set up deduplication** — Decide on email/name matching logic
4. **Implement webhooks** — Configure Stripe and Netlify to POST contact data
5. **Test with subset** — Import small batch first, verify data quality

---

**End of Reference Document**
