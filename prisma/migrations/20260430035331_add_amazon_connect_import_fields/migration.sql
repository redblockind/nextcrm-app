-- Add custom fields for Amazon Connect CSV import to crm_Contacts model
ALTER TABLE "crm_Contacts" ADD COLUMN "city" TEXT;
ALTER TABLE "crm_Contacts" ADD COLUMN "country" TEXT;
ALTER TABLE "crm_Contacts" ADD COLUMN "state" TEXT;
ALTER TABLE "crm_Contacts" ADD COLUMN "is_b2b" BOOLEAN;
ALTER TABLE "crm_Contacts" ADD COLUMN "b2b_discount_percent" TEXT;
ALTER TABLE "crm_Contacts" ADD COLUMN "contact_origin" TEXT;
ALTER TABLE "crm_Contacts" ADD COLUMN "cumulative_order_count" TEXT;
ALTER TABLE "crm_Contacts" ADD COLUMN "first_order_date" TEXT;
ALTER TABLE "crm_Contacts" ADD COLUMN "is_temporary" BOOLEAN;
ALTER TABLE "crm_Contacts" ADD COLUMN "last_order_date" TEXT;
ALTER TABLE "crm_Contacts" ADD COLUMN "last_order_id" TEXT;
ALTER TABLE "crm_Contacts" ADD COLUMN "opt_in_time" TEXT;
ALTER TABLE "crm_Contacts" ADD COLUMN "stripe_customer_id" TEXT;
