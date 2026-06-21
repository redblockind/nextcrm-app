import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { prismadb } from "@/lib/prisma";

export const runtime = "nodejs";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ templateId: string }> }
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { templateId } = await params;
    const body = await req.json();

    const existing = await prismadb.crm_campaign_templates.findFirst({
      where: { id: templateId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const data: Record<string, unknown> = {};
    if (typeof body.name === "string") data.name = body.name;
    if ("description" in body) data.description = body.description ?? null;
    if ("subject_default" in body) data.subject_default = body.subject_default ?? null;
    if (typeof body.content_html === "string") data.content_html = body.content_html;
    if ("content_json" in body) data.content_json = body.content_json ?? {};

    await prismadb.crm_campaign_templates.update({
      where: { id: templateId },
      data,
    });

    return NextResponse.json({ id: templateId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
