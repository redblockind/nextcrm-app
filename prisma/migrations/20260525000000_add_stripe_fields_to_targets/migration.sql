-- Add Stripe / post-purchase automation fields to crm_Targets
-- Mirrors the fields already present on crm_Contacts (migration 20260430035331)
ALTER TABLE "crm_Targets" ADD COLUMN IF NOT EXISTS "stripe_customer_id"     TEXT;
ALTER TABLE "crm_Targets" ADD COLUMN IF NOT EXISTS "first_order_date"       TEXT;
ALTER TABLE "crm_Targets" ADD COLUMN IF NOT EXISTS "last_order_date"        TEXT;
ALTER TABLE "crm_Targets" ADD COLUMN IF NOT EXISTS "last_order_id"          TEXT;
ALTER TABLE "crm_Targets" ADD COLUMN IF NOT EXISTS "cumulative_order_count" TEXT;
ALTER TABLE "crm_Targets" ADD COLUMN IF NOT EXISTS "contact_origin"         TEXT;
ALTER TABLE "crm_Targets" ADD COLUMN IF NOT EXISTS "opt_in_time"            TEXT;
ALTER TABLE "crm_Targets" ADD COLUMN IF NOT EXISTS "is_b2b"                 BOOLEAN;
ALTER TABLE "crm_Targets" ADD COLUMN IF NOT EXISTS "b2b_discount_percent"   TEXT;
ALTER TABLE "crm_Targets" ADD COLUMN IF NOT EXISTS "is_temporary"           BOOLEAN;

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS "crm_Targets_created_by_idx"  ON "crm_Targets"("created_by");
CREATE INDEX IF NOT EXISTS "crm_Targets_status_idx"      ON "crm_Targets"("status");
CREATE INDEX IF NOT EXISTS "crm_Targets_created_on_idx"  ON "crm_Targets"("created_on");
