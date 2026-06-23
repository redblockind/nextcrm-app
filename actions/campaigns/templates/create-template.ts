"use server";
import { prismadb } from "@/lib/prisma";
import { requireAuthenticated, AuthenticationError } from "@/lib/authz";

export const createTemplate = async (data: {
  name: string;
  description?: string;
  subject_default?: string;
  content_html: string;
  content_json: object;
}): Promise<{ id: string } | { error: string }> => {
  let user;
  try {
    user = await requireAuthenticated();
  } catch (e) {
    if (e instanceof AuthenticationError) return { error: "Unauthorized" };
    throw e;
  }

  const created = await prismadb.crm_campaign_templates.create({
    data: { ...data, created_by: user.id },
    select: { id: true },
  });
  return { id: created.id };
};
