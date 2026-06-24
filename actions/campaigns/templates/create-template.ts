"use server";
import { getSession } from "@/lib/auth-server";
import { prismadb } from "@/lib/prisma";

export const createTemplate = async (data: {
  name: string;
  description?: string;
  subject_default?: string;
  content_html: string;
  content_json: object;
}): Promise<{ id: string }> => {
  const session = await getSession();
  const created = await prismadb.crm_campaign_templates.create({
    data: { ...data, created_by: session?.user?.id ?? null },
    select: { id: true },
  });
  return { id: created.id };
};
