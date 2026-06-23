import { getSession } from "@/lib/auth-server";
import { prismadb } from "@/lib/prisma";

/**
 * Authorization helpers for server actions.
 *
 * These throw typed errors so callers can map them to user-facing results
 * (e.g. `{ error: "Unauthorized" }`) instead of leaking internals.
 */

export class AuthenticationError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends Error {
  constructor(message = "Not authorized") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface AuthenticatedUser {
  id: string;
  role?: string | null;
}

/**
 * Returns the currently authenticated user, or throws `AuthenticationError`
 * when there is no active session.
 */
export async function requireAuthenticated(): Promise<AuthenticatedUser> {
  const session = await getSession();
  if (!session?.user?.id) {
    throw new AuthenticationError();
  }
  return {
    id: session.user.id,
    role: (session.user as { role?: string | null }).role ?? null,
  };
}

/**
 * Ensures the given user may modify the campaign template identified by `id`.
 *
 * Admins may write any template; other users may only write templates they
 * created. Throws `AuthorizationError` when the template does not exist (or is
 * soft-deleted) or the user lacks permission.
 */
export async function assertCanWriteTemplate(
  user: AuthenticatedUser,
  id: string
): Promise<void> {
  const template = await prismadb.crm_campaign_templates.findFirst({
    where: { id, deletedAt: null },
    select: { created_by: true },
  });

  if (!template) {
    throw new AuthorizationError("Template not found");
  }

  if (user.role === "admin") {
    return;
  }

  if (template.created_by && template.created_by === user.id) {
    return;
  }

  throw new AuthorizationError();
}
