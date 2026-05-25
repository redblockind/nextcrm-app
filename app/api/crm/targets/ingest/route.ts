import { NextResponse } from "next/server";
import { prismadb } from "@/lib/prisma";
import { validateApiToken } from "@/lib/api-tokens";

export const runtime = "nodejs";

const PENDING_LIST_NAME = "Pending Post-Purchase";

const STRING_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "personal_email",
  "office_phone",
  "mobile_phone",
  "position",
  "description",
  "city",
  "country",
  "company",
  "company_website",
  "company_email",
  "company_phone",
  "stripe_customer_id",
  "b2b_discount_percent",
  "contact_origin",
  "cumulative_order_count",
  "first_order_date",
  "last_order_date",
  "last_order_id",
  "opt_in_time",
  "social_x",
  "social_linkedin",
  "social_instagram",
  "social_facebook",
] as const;

const BOOLEAN_FIELDS = ["status", "is_b2b", "is_temporary"] as const;
const ARRAY_FIELDS = ["tags", "notes"] as const;

const ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>([
  ...STRING_FIELDS,
  ...BOOLEAN_FIELDS,
  ...ARRAY_FIELDS,
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type IncomingTarget = Record<string, unknown>;

function validateTarget(t: unknown): string | null {
  if (!t || typeof t !== "object" || Array.isArray(t)) {
    return "target must be a JSON object";
  }
  const obj = t as IncomingTarget;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_FIELDS.has(key)) return `unknown field: ${key}`;
  }

  for (const key of STRING_FIELDS) {
    const v = obj[key];
    if (v !== undefined && v !== null && typeof v !== "string") {
      return `field ${key} must be a string`;
    }
  }
  for (const key of BOOLEAN_FIELDS) {
    const v = obj[key];
    if (v !== undefined && v !== null && typeof v !== "boolean") {
      return `field ${key} must be a boolean`;
    }
  }
  for (const key of ARRAY_FIELDS) {
    const v = obj[key];
    if (v !== undefined && v !== null) {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
        return `field ${key} must be an array of strings`;
      }
    }
  }

  if (typeof obj.last_name !== "string" || obj.last_name.trim() === "") {
    return "last_name is required";
  }
  if (typeof obj.email !== "string" || obj.email.trim() === "") {
    return "email is required";
  }
  return null;
}

function mergeStripeCustomerIds(
  existing: string | null | undefined,
  incoming: string
): { merged: string; appended: boolean } {
  if (!existing || existing.trim() === "") {
    return { merged: incoming, appended: false };
  }
  const list = existing
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (list.includes(incoming)) {
    return { merged: list.join(","), appended: false };
  }
  return { merged: [...list, incoming].join(","), appended: true };
}

type ResultEntry =
  | { email: string; action: "created"; id: string; added_to_pending: boolean }
  | {
      email: string;
      action: "updated";
      id: string;
      stripe_id_appended?: boolean;
    }
  | { email: string; action: "conflict"; matches: string[] };

function buildPayload(t: IncomingTarget): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  ALLOWED_FIELDS.forEach((key) => {
    if (key in t && t[key] !== undefined) data[key] = t[key];
  });
  return data;
}

async function getOrCreatePendingList(userId: string): Promise<string> {
  const existing = await prismadb.crm_TargetLists.findFirst({
    where: { name: PENDING_LIST_NAME, deletedAt: null },
    select: { id: true },
  });
  if (existing) return existing.id;

  const created = await prismadb.crm_TargetLists.create({
    data: {
      name: PENDING_LIST_NAME,
      description:
        "Auto-populated by Stripe ingestion. Daily cron processes targets 7+ days old.",
      created_by: userId,
    },
    select: { id: true },
  });
  return created.id;
}

async function processTarget(
  t: IncomingTarget,
  userId: string,
  pendingListId: string
): Promise<ResultEntry> {
  const email = (t.email as string).trim();

  const matches = await prismadb.crm_Targets.findMany({
    where: {
      email: { equals: email, mode: "insensitive" },
      deletedAt: null,
    },
    select: { id: true, stripe_customer_id: true },
  });

  if (matches.length > 1) {
    return {
      email,
      action: "conflict",
      matches: matches.map((m) => m.id),
    };
  }

  const data = buildPayload(t);

  if (matches.length === 0) {
    if (!data.contact_origin) {
      data.contact_origin = "stripe_webhook";
    }
    const created = await prismadb.crm_Targets.create({
      data: {
        ...data,
        created_by: userId,
        updatedBy: userId,
      } as never,
      select: { id: true },
    });

    let addedToPending = false;
    try {
      await prismadb.targetsToTargetLists.create({
        data: { target_id: created.id, target_list_id: pendingListId },
      });
      addedToPending = true;
    } catch {
      // skipDuplicates not available on create, but duplicates shouldn't happen for new targets
    }

    return { email, action: "created", id: created.id, added_to_pending: addedToPending };
  }

  const existing = matches[0];
  let stripeAppended = false;
  if (
    typeof data.stripe_customer_id === "string" &&
    (data.stripe_customer_id as string).trim() !== ""
  ) {
    const merge = mergeStripeCustomerIds(
      existing.stripe_customer_id,
      (data.stripe_customer_id as string).trim()
    );
    data.stripe_customer_id = merge.merged;
    stripeAppended = merge.appended;
  } else {
    delete data.stripe_customer_id;
  }

  await prismadb.crm_Targets.update({
    where: { id: existing.id },
    data: { ...data, updatedBy: userId } as never,
    select: { id: true },
  });

  const result: ResultEntry = { email, action: "updated", id: existing.id };
  if (stripeAppended) result.stripe_id_appended = true;
  return result;
}

export async function POST(req: Request) {
  const auth =
    req.headers.get("authorization") || req.headers.get("Authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
    return NextResponse.json(
      { error: "Missing or malformed Authorization header" },
      { status: 401 }
    );
  }
  const token = auth.slice(7).trim();
  let userId: string;
  try {
    userId = await validateApiToken(token);
  } catch {
    return NextResponse.json(
      { error: "Invalid or revoked token" },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Body must be a JSON object" },
      { status: 400 }
    );
  }

  const root = body as Record<string, unknown>;
  const isBatch = Array.isArray(root.targets);

  let targets: IncomingTarget[];
  if (isBatch) {
    const extras = Object.keys(root).filter((k) => k !== "targets");
    if (extras.length > 0) {
      return NextResponse.json(
        {
          error: `unknown top-level fields alongside "targets": ${extras.join(
            ", "
          )}`,
        },
        { status: 400 }
      );
    }
    targets = root.targets as IncomingTarget[];
    if (targets.length === 0) {
      return NextResponse.json(
        { error: "targets array must contain at least one entry" },
        { status: 400 }
      );
    }
  } else {
    targets = [root as IncomingTarget];
  }

  for (let i = 0; i < targets.length; i++) {
    const err = validateTarget(targets[i]);
    if (err) {
      const prefix = isBatch ? `targets[${i}]: ` : "";
      return NextResponse.json(
        { error: `${prefix}${err}` },
        { status: 400 }
      );
    }
  }

  const pendingListId = await getOrCreatePendingList(userId);

  const results: ResultEntry[] = [];
  for (const t of targets) {
    try {
      results.push(await processTarget(t, userId, pendingListId));
    } catch (err) {
      console.error("[INGEST_TARGET_FAILED]", {
        email: typeof t.email === "string" ? t.email : null,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { error: "Internal error processing target" },
        { status: 500 }
      );
    }
  }

  const status = results.some((r) => r.action === "conflict") ? 409 : 200;
  return NextResponse.json({ results }, { status });
}
