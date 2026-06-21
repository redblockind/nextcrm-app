import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { prismadb } from "@/lib/prisma";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const {
      name,
      description,
      subject_default,
      content_html,
      content_json,
    } = body ?? {};

    if (!name || typeof name !== "string") {
      return NextResponse.json(
        { error: "Template name is required" },
        { status: 400 }
      );
    }
    if (typeof content_html !== "string") {
      return NextResponse.json(
        { error: "content_html is required" },
        { status: 400 }
      );
    }

    const created = await prismadb.crm_campaign_templates.create({
      data: {
        name,
        description: description ?? null,
        subject_default: subject_default ?? null,
        content_html,
        content_json: content_json ?? {},
        created_by: session.user.id,
      },
      select: { id: true },
    });

    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
