import { NextResponse } from "next/server";
import { prismadb } from "@/lib/prisma";
import { validateApiToken } from "@/lib/api-tokens";
import { writeAuditLog } from "@/lib/audit-log";

export const runtime = "nodejs";

const STRING_FIELDS = [
  "first_name",
  "last_name",
  "email",
  "personal_email",
  "office_phone",
  "mobile_phone",
  "website",
  "position",
  "birthday",
  "description",
  "city",
  "state",
  "country",
  "stripe_customer_id",
  "b2b_discount_percent",
  "contact_origin",
  "cumulative_order_count",
  "first_order_date",
  "last_order_date",
  "last_order_id",
  "opt_in_time",
  "social_twitter",
  "social_facebook",
  "social_linkedin",
  "social_skype",
  "social_instagram",
  "social_youtube",
  "social_tiktok",
] as const;

const BOOLEAN_FIELDS = ["status", "is_b2b", "is_temporary"] as const;
const ARRAY_FIELDS = ["tags", "notes"] as const;
const UUID_FIELDS = ["contact_type_id"] as const;

const ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>([
  ...STRING_FIELDS,
  ...BOOLEAN_FIELDS,
  ...ARRAY_FIELDS,
  ...UUID_FIELDS,
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type IncomingContact = Record<string, unknown>;

function validateContact(c: unknown): string | null {
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    return "contact must be a JSON object";
  }
  const obj = c as IncomingContact;

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
  for (const key of UUID_FIELDS) {
    const v = obj[key];
    if (v !== undefined && v !== null) {
      if (typeof v !== "string" || !UUID_RE.test(v)) {
        return `field ${key} must be a UUID string`;
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
  | { email: string; action: "created"; id: string }
  | {
      email: string;
      action: "updated";
      id: string;
      stripe_id_appended?: boolean;
    }
  | { email: string; action: "conflict"; matches: string[] };

function buildPayload(c: IncomingContact): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  ALLOWED_FIELDS.forEach((key) => {
    if (key in c && c[key] !== undefined) data[key] = c[key];
  });
  return data;
}

async function processContact(
  c: IncomingContact,
  userId: string
): Promise<ResultEntry> {
  const email = (c.email as string).trim();

  const matches = await prismadb.crm_Contacts.findMany({
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

  const data = buildPayload(c);

  if (matches.length === 0) {
    const created = await prismadb.crm_Contacts.create({
      data: {
        ...data,
        created_by: userId,
        createdBy: userId,
        updatedBy: userId,
      } as never,
      select: { id: true },
    });
    await writeAuditLog({
      entityType: "contact",
      entityId: created.id,
      action: "created",
      userId,
    });
    return { email, action: "created", id: created.id };
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

  const updated = await prismadb.crm_Contacts.update({
    where: { id: existing.id },
    data: { ...data, updatedBy: userId } as never,
    select: { id: true },
  });
  await writeAuditLog({
    entityType: "contact",
    entityId: updated.id,
    action: "updated",
    userId,
  });

  const result: ResultEntry = { email, action: "updated", id: updated.id };
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
  const isBatch = Array.isArray(root.contacts);

  let contacts: IncomingContact[];
  if (isBatch) {
    const extras = Object.keys(root).filter((k) => k !== "contacts");
    if (extras.length > 0) {
      return NextResponse.json(
        {
          error: `unknown top-level fields alongside "contacts": ${extras.join(
            ", "
          )}`,
        },
        { status: 400 }
      );
    }
    contacts = root.contacts as IncomingContact[];
    if (contacts.length === 0) {
      return NextResponse.json(
        { error: "contacts array must contain at least one entry" },
        { status: 400 }
      );
    }
  } else {
    contacts = [root as IncomingContact];
  }

  for (let i = 0; i < contacts.length; i++) {
    const err = validateContact(contacts[i]);
    if (err) {
      const prefix = isBatch ? `contacts[${i}]: ` : "";
      return NextResponse.json(
        { error: `${prefix}${err}` },
        { status: 400 }
      );
    }
  }

  const results: ResultEntry[] = [];
  for (const c of contacts) {
    try {
      results.push(await processContact(c, userId));
    } catch (err) {
      console.error("[INGEST_CONTACT_FAILED]", {
        email: typeof c.email === "string" ? c.email : null,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { error: "Internal error processing contact" },
        { status: 500 }
      );
    }
  }

  const status = results.some((r) => r.action === "conflict") ? 409 : 200;
  return NextResponse.json({ results }, { status });
}
