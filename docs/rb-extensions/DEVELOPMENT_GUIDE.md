# RB Extensions — Development Guide

> **READ THIS BEFORE WRITING ANY CODE IN THIS REPO.**
>
> **Audience:** every developer and AI agent making changes to this fork of
> `pdovhomilja/nextcrm-app` (Redblock's "NextCRM" deployment).
>
> **Purpose:** this fork tracks an upstream open-source project. The single most important
> non-functional requirement is: **keep the ability to pull upstream releases.** Code that is
> written carelessly will silently destroy that ability by creating merge conflicts in files
> upstream owns. This guide tells you how to add features so that never happens.
>
> If you are doing the one-time restructure, read `MIGRATION_GUIDE.md` first. This guide assumes
> the `rb-extensions/` structure already exists (or that you will create it for a new feature).

---

## 1. The one rule

> **Upstream owns its files. We own `rb-extensions/`. The two meet only at named seams.**

Everything else in this document follows from that rule. If a change you are about to make
would edit an upstream-owned file in any way other than adding a single, sentinel-wrapped
registration line — **stop** and find the seam-based way to do it.

---

## 2. Where things go

| You are adding… | Put it in… | Touch upstream? |
|---|---|---|
| Business logic, server actions | `rb-extensions/<feature>/actions/` | No |
| Background jobs (Inngest) | `rb-extensions/<feature>/inngest/` | One spread in `app/api/inngest/route.ts` |
| API handlers | logic in `rb-extensions/<feature>/api/`; a thin `route.ts` under `app/api/` re-exports it | Thin wrapper only |
| Pages / screens | pages under `app/[locale]/(routes)/(rb-extensions)/<feature>/`; logic in `rb-extensions/<feature>/routes/` | No (route group is ours) |
| React components | `rb-extensions/<feature>/components/` | No |
| Helpers / libs | `rb-extensions/<feature>/lib/` | No |
| A nav menu entry | `rb-extensions/<feature>/feature.ts` → exposed via `rbMenuItems` | One spread in `app-sidebar.tsx` |
| A redirect | `rb-extensions/rb-config.cjs` | One spread in `next.config.js` |
| New DB models | `prisma/schema/rb-extensions.prisma` | No (separate schema file) |
| Columns on an **upstream** table | the upstream model, sentinel-wrapped — or better, a side table you own | Minimised / eliminated |
| Custom UI inside an upstream component | extract to `rb-extensions/<feature>/components/`, render via **one** import | One import line |
| Translations | an `rb` namespace key, ideally a separate locale file | Avoid editing shared locale files |

If your change doesn't fit a row above, it probably belongs in `rb-extensions/` anyway — ask
"does upstream need to know this exists?" The answer is almost always no.

---

## 3. Naming convention (authoritative — same table as the migration guide)

Use the `rb`/`RB` (Redblock) prefix everywhere to avoid colliding with upstream names. **The form
changes by context** — copy the right one:

| Context | Form | Example |
|---|---|---|
| Top-level folder | `rb-` lowercase, hyphen | `rb-extensions/` |
| Route group folder | `(rb-...)` lowercase | `(rb-extensions)/` |
| File names | `rb-` lowercase, hyphen | `rb-registry.ts` |
| TS exports / vars | `rb` camelCase | `rbMenuItems` |
| **Prisma model** | `Rb` PascalCase, **no hyphen** | `model RbCampaign` |
| **DB table** (`@@map`) | `rb_` snake_case | `@@map("rb_campaigns")` |
| Env var / flag | `RB_` UPPER_SNAKE | `RB_EMAIL_FUNNELS` |
| Inngest function id | `rb/` prefix | `"rb/campaign-send-step"` |
| i18n keys | `rb` object root | `{ "rb": { … } }` |
| Sentinel comment | `RB-EXT` UPPER | `// >>> RB-EXT (email-funnels)` |

**Hard constraints, not style preferences:**
- **Hyphens are illegal in Prisma model names and in any JS/TS identifier.** Folders and files
  may use hyphens; identifiers may not.
- **Use lowercase for paths.** Linux is case-sensitive; macOS/Windows are not. `RB-Extensions`
  and `rb-extensions` are the same folder on a Mac and different folders on the deploy server —
  that mismatch produces "works on my machine" build failures. Always lowercase paths.

---

## 4. The feature-flag contract

Every RB feature is gated by an env-var flag so it can be turned off to test a fresh upstream:

```ts
// rb-extensions/rb-flags.ts
export const rbFlags = {
  emailFunnels: process.env.RB_EMAIL_FUNNELS !== "off", // default ON
};
```

Rules:
- **One flag per feature.** Name it `RB_<FEATURE>`.
- **Default ON, opt-out with `"off"`** (so a missing var = feature present, matching upstream's
  "code present = feature on" philosophy). When validating a new upstream merge, flip everything
  off first, then on one at a time.
- The registry (`rb-registry.ts`) is the **only** place that maps a flag to its contributions
  (menu items, inngest functions, redirects). Don't scatter `if (process.env…)` checks across
  the codebase.
- `next.config.js` can't read the TS flags — `rb-config.cjs` re-reads the **same env var**. Keep
  the names in sync.

---

## 5. Seams — the only places you may touch upstream

Each is a single line wrapped in sentinels so a merge is grep-able (`grep -rn "RB-EXT" .`):

- **Menu:** `...rbMenuItems({ session, dict })` in `app-sidebar.tsx`.
- **Jobs:** `...rbInngestFunctions()` in `app/api/inngest/route.ts`.
- **Redirects:** `...rbRedirects()` in `next.config.js` (via `rb-config.cjs`).
- **Schema:** custom models in `prisma/schema/rb-extensions.prisma`; columns added to an upstream
  model are sentinel-wrapped in `main.prisma` (or, preferably, live in a side table).

**Never** add a second kind of edit to an upstream file. If you think you need to, you almost
certainly need a new seam — add one *general* spread, not feature-specific logic, and document it
here.

---

## 6. Gotchas — the things that actually break this app

These are specific to this codebase. Re-read them before a non-trivial change.

### 6.1 Prisma `Decimal` is not serializable across the server→client boundary
Prisma returns `Decimal` objects for decimal/numeric columns. They are **not serializable**
across a Server Action boundary or into a Client Component. Symptoms: silent failures,
`undefined` returns, hydration mismatches, broken `router.push()` after a server action.

**Always** wrap Prisma results before returning them from a server action or passing them to a
client component:
```ts
import { serializeDecimals, serializeDecimalsList } from "@/lib/serialize-decimals";
return serializeDecimals(invoice);      // single object
return serializeDecimalsList(invoices); // arrays
```
Do **not** "fix" it by stripping the return down to `{ id }` — keep the full object via
`serializeDecimals()`. This applies to every `"use server"` action and every Server Component
that hands Prisma objects with Decimal fields to a Client Component.

### 6.2 `next.config.js` is CommonJS
It uses `require`, so it cannot import TypeScript or ESM. Anything it needs (redirects,
rewrites, env wiring) must come from a `.cjs` module — that's why redirects live in
`rb-extensions/rb-config.cjs`, not the TS registry.

### 6.3 Inngest functions need unique ids *and* registration
A background job only runs if it is (a) given a unique id and (b) added to the `functions: [...]`
array in `app/api/inngest/route.ts`. Use `rb/`-prefixed ids so upstream can never collide with
us, and register via the `rbInngestFunctions()` spread — never by adding an individual import to
the upstream array.

### 6.4 Prisma model rename vs. table rename
Renaming a Prisma **model identifier** while keeping `@@map("old_table")` is free (code-only).
Renaming the **actual table** is a data migration (`ALTER TABLE … RENAME`). Know which you are
doing and never trigger the second one accidentally.

### 6.5 Columns on upstream tables are merge hotspots
Adding a column to an upstream model (e.g. `crm_Targets`) is the one edit that lands in an
upstream-owned model block. Keep such columns **nullable and additive** (non-breaking), group
them behind `// >>> RB-EXT` sentinels, and prefer moving them to an RB-owned **side table** with
a 1:1 relation when the set grows. Never reorder or rename upstream columns.

### 6.6 Don't fragment the data layer
This app persists data with **Prisma against Postgres** (upstream's choice). Do not introduce a
second ORM, a JSON file, in-memory state, or a different database for RB features. Use the
existing Prisma client and connection. (Generic platform advice to "use Drizzle / Blobs" does not
apply here — staying on Prisma is what keeps us upstream-compatible.)

### 6.7 Shared locale / i18n files
Translation JSON under `locales/` is upstream-owned and a frequent conflict source. Put custom
strings under an `rb` key namespace and, where the i18n setup allows, in a separate file merged at
load time — don't sprinkle keys through upstream dictionaries.

### 6.8 Migrations must stay linear and append-only
Never edit or delete an applied migration. New migrations are timestamped and stack on top of
upstream's. After a schema change, regenerate the client and apply migrations via the project's
existing scripts. If you see drift after an upstream merge, resolve it deliberately with
`prisma migrate resolve` — don't rewrite history.

### 6.9 Route groups don't change URLs
`(rb-extensions)/email-funnels/page.tsx` serves `/email-funnels`, not `/(rb-extensions)/…`. This
is intentional (keeps URLs stable) but means a redirect or link can't reference the group folder.

---

## 7. Git & release workflow (project convention)

Trunk-based flow: **`dev`** is integration, **`main`** is the release branch.

- Do routine work directly on `dev`. No long-lived feature branches for routine work.
- Push to `origin/dev` to deploy the remote dev environment; verify there, not just locally.
- Open the release PR **`dev → main`** (base `main`, head `dev`) only after remote dev is green.
  "Create a PR" with no other context means `dev → main`.
- **Never** commit to `main` directly. **Never** force-push `dev` or `main`.
- `release-please` manages versioning on `main` — **do not** hand-edit `CHANGELOG.md` or the
  `version` field in `package.json`.
- Consuming upstream happens on `dev` via the loop in `MIGRATION_GUIDE.md §7`.

---

## 8. Checklist before you open a PR

- [ ] All new logic lives under `rb-extensions/` (or `(rb-extensions)/` for pages).
- [ ] Every upstream-file touch is a single `RB-EXT`-wrapped registration line — no exceptions.
- [ ] New feature has an `RB_<FEATURE>` flag wired through the registry, default ON, off-able.
- [ ] New models are `Rb*`-named and live in `prisma/schema/rb-extensions.prisma`.
- [ ] Any new column on an upstream table is nullable, additive, and sentinel-wrapped.
- [ ] Server actions returning Decimal-bearing Prisma data use `serializeDecimals()`.
- [ ] Inngest jobs have `rb/`-prefixed ids and are registered via the spread.
- [ ] `RB_<FEATURE>=off` makes the app behave as vanilla upstream; `=on` restores the feature.
- [ ] No new ORM/storage engine introduced; data goes through the existing Prisma client.
- [ ] You did **not** run a build command (the platform validates builds automatically).
- [ ] PR is `dev → main` (unless explicitly asked otherwise); `CHANGELOG`/version untouched.

---

## 9. If you are tempted to break a rule

The rules above trade a little extra structure now for the ability to absorb years of upstream
improvements (security fixes, features, performance) for free. The moment custom logic leaks into
upstream files, every future `git merge upstream/main` becomes a manual, error-prone slog and the
fork starts to rot. When a rule is inconvenient, the right move is to **add or improve a seam**,
not to inline. If you genuinely believe a rule is wrong for a case, document the reasoning in the
PR and update this guide — don't quietly diverge.
