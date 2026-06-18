# RB Extensions — Migration Guide

> **Audience:** AI coding agents and developers performing the one-time restructure.
> **Goal:** Move all Redblock ("RB") custom code out of upstream-owned files and into an
> isolated, flag-controlled `rb-extensions/` area so this fork can keep pulling releases
> from `pdovhomilja/nextcrm-app` with minimal merge pain — **without rewriting the
> features we already built.**
>
> Read this together with `DEVELOPMENT_GUIDE.md` (how to write *new* code under this
> structure) and `UPSTREAM_DISCUSSION_PROMPT.md` (coordinating with the original project).

---

## 0. TL;DR for the impatient agent

1. This is a **relocation + thin-seam** refactor, not a rewrite. Behaviour must not change.
2. Everything custom moves under a single new top-level folder: **`rb-extensions/`**.
3. Every edit we made to an *upstream-owned* file collapses to **one registration line**.
4. Each upstream contact point is wrapped in a grep-able sentinel: `// >>> RB-EXT` … `// <<< RB-EXT`.
5. Prisma is the one layer that cannot be fully isolated — handle it per §6 exactly.
6. Work on the `dev` branch. Do **not** commit to `main`. Do **not** run build commands.
7. After each phase, verify the app still boots and the feature still works **with the flag
   both ON and OFF**.

---

## 1. Why we are doing this (context you must not lose)

The upstream project **has no plugin or add-on system**. It is a monolithic Next.js app that
the authors expect you to fork and edit directly. They even removed the old runtime module
toggle (`system_Modules_Enabled`). So "a feature is on because its code is present."

Our problem: our email-marketing / funnel work is **inlined into files upstream owns**
(`next.config.js`, `app-sidebar.tsx`, `app/api/inngest/route.ts`, `prisma/schema.prisma`,
and a UI card inside `BasicView.tsx`). Every upstream release will collide with those edits.
There is already physical evidence of this: **`prisma/schema.prisma.orig`** is a leftover
from a previous merge conflict on the schema.

The fix is to **impose** the isolation upstream doesn't give us:

- **A** — 100% of custom logic lives in `rb-extensions/`, a folder upstream will never create,
  so `git merge upstream/main` can never conflict inside it.
- **B** — Each upstream file we must touch gets reduced to a single spread/registration line.
- **C** — A feature-flag layer lets us turn the whole thing off, merge upstream, verify the
  vanilla app, then turn it back on to test compatibility.

---

## 2. Naming convention — read before creating anything

We use the **`rb` / `RB` (Redblock) prefix** to guarantee our names never collide with
upstream's. This is a standard, recommended practice (vendor prefixing / namespacing). **But
the *form* of the prefix changes by context** because of real technical constraints. Use this
table as the single source of truth:

| Context | Form | Example | Why this form |
|---|---|---|---|
| Top-level folder | `rb-` lowercase, hyphen | `rb-extensions/` | Hyphens are fine in paths; **lowercase** avoids macOS/Windows (case-insensitive) vs Linux (case-sensitive) bugs |
| Route group folder | `(rb-...)` lowercase | `app/[locale]/(routes)/(rb-extensions)/` | Same as above; parentheses route groups don't change URLs |
| File names | `rb-` lowercase, hyphen | `rb-registry.ts`, `rb-flags.ts` | Filesystem-safe, consistent |
| TS exports / vars | `rb` camelCase | `rbMenuItems`, `rbInngestFunctions` | Hyphens illegal in JS identifiers |
| **Prisma model name** | `Rb` PascalCase, **no hyphen** | `model RbCampaign { … }` | Prisma model names must match `[A-Za-z][A-Za-z0-9_]*` — **hyphens are illegal** |
| **DB table name** (`@@map`) | `rb_` snake_case | `@@map("rb_campaigns")` | Postgres lowercases unquoted identifiers; snake_case avoids quoting |
| Env var / feature flag | `RB_` UPPER_SNAKE | `RB_EMAIL_FUNNELS` | Standard env-var convention |
| Inngest function id | `rb/` prefix | `id: "rb/campaign-send-step"` | Prevents id collision if upstream adds a function with the same name |
| i18n key namespace | `rb` object root | `{ "rb": { "campaigns": { … } } }` | Keeps custom strings out of upstream key space |
| Sentinel comment | `RB-EXT` UPPER | `// >>> RB-EXT (email-funnels)` | A loud, grep-able token; case doesn't matter here |

> **Do not** use `RB-` (uppercase) for folders or files. **Do not** put hyphens in any
> JavaScript or Prisma identifier. When in doubt, copy an example from the row above.

---

## 3. Target structure

```
rb-extensions/                     ← new top-level folder, upstream never creates it
  rb-registry.ts                   ← aggregates all enabled extensions (the "what's on" file)
  rb-flags.ts                      ← reads env flags, decides what's enabled
  rb-config.cjs                    ← CommonJS shim for next.config.js (redirects, see §5.3)
  email-funnels/
    actions/                       ← from actions/campaigns, actions/crm/targets, actions/crm/target-lists
    api/                           ← logic behind /api/campaigns/* and /api/crm/targets/ingest
    components/                    ← custom UI incl. the BasicView "Custom Fields" card
    inngest/                       ← campaign Inngest functions (schedule-send, send-step, …)
    lib/                           ← merge-tags.ts and other helpers
    routes/                        ← page-level components (the thin app/ pages import these)
    feature.ts                     ← this feature's contributions: menu items, inngest fns, redirects, flag key
    docs/                          ← NextCRM_Email_Marketing_Workflow_Analysis.md

app/[locale]/(routes)/(rb-extensions)/
  email-funnels/                   ← thin page wrappers that import from rb-extensions/email-funnels/routes

prisma/schema/                     ← multi-file schema folder (see §6)
  main.prisma                      ← upstream owns this (datasource, generator, all upstream models)
  rb-extensions.prisma             ← our new models live here
```

**Principle:** anything inside `rb-extensions/` and `(rb-extensions)/` is conflict-proof.
Conflicts can only happen at the handful of seams in §5 and the Prisma file in §6.

---

## 4. Phase plan (do these in order; verify after each)

> Branch: `dev`. After every phase, confirm the app still boots and behaviour is unchanged.
> Toggle the flag (§5.4) both ways where relevant. Do **not** run `build` commands — the
> platform validates builds automatically.

### Phase 0 — Safety net & upstream remote
- [ ] Confirm you are on `dev` (`git status`). Never work on `main`.
- [ ] Delete the stale merge artifact: remove `prisma/schema.prisma.orig`.
- [ ] Add the upstream remote (it does not exist yet):
  ```bash
  git remote add upstream https://github.com/pdovhomilja/nextcrm-app.git
  git fetch upstream
  ```
- [ ] Take note of the current upstream tag we are effectively based on, for the changelog.

### Phase 1 — Scaffold the empty shell (no logic moved yet)
- [ ] Create `rb-extensions/` with empty `rb-flags.ts`, `rb-registry.ts`, `rb-config.cjs`.
- [ ] Create the `(rb-extensions)/` route group folder.
- [ ] Wire the **empty** registry into the three seams (§5) so spreads resolve to `[]`.
- [ ] Verify: app boots, the email-funnel feature is **unchanged** (logic still in old places —
      the empty registry just adds nothing yet). This proves the seams are inert before we move code.

### Phase 2 — Relocate logic (one sub-area at a time)
Move, don't rewrite. After each move, fix imports and verify. Order: lib → actions → inngest →
api → components → routes. Mapping table:

| Today (inlined / upstream namespace) | Move to |
|---|---|
| `lib/campaigns/*` | `rb-extensions/email-funnels/lib/` |
| `actions/campaigns/*`, `actions/crm/targets/*`, `actions/crm/target-lists/*` | `rb-extensions/email-funnels/actions/` |
| `inngest/functions/campaigns/*` | `rb-extensions/email-funnels/inngest/` |
| `app/api/campaigns/*`, `app/api/crm/targets/ingest/route.ts` | logic → `rb-extensions/email-funnels/api/`; keep a thin `route.ts` that re-exports |
| `app/[locale]/(routes)/campaigns/*` pages | move pages to `(rb-extensions)/email-funnels/`; logic to `…/routes/` |
| the "Custom Fields" card inside `BasicView.tsx` | extract to `rb-extensions/email-funnels/components/`, render via one import |

> **Import-path caution:** server actions use `"use server"`; keep those directives intact when
> moving files. Anything returning Prisma `Decimal` fields **must** still go through
> `serializeDecimals()` (see `DEVELOPMENT_GUIDE.md` §Gotchas). Moving the file does not change that.

### Phase 3 — Collapse the seams (§5)
- [ ] Replace each inlined block in `app-sidebar.tsx`, `app/api/inngest/route.ts`, and
      `next.config.js` with the single registration line, wrapped in `RB-EXT` sentinels.

### Phase 4 — Prisma restructure (§6)
- [ ] Convert to the multi-file schema folder, move custom models, rename to the `Rb*` namespace
      with `@@map` to preserve existing tables (no data migration).

### Phase 5 — Flags & dry run
- [ ] Set `RB_EMAIL_FUNNELS=off`, verify the app behaves as **vanilla upstream**.
- [ ] Set `RB_EMAIL_FUNNELS=on`, verify the feature returns intact.
- [ ] Do a trial `git merge upstream/main` on a throwaway branch to confirm conflicts are now
      limited to the seams + the Prisma file. Discard the throwaway branch.

---

## 5. The seams — reduce each upstream edit to one line

Wrap every seam in sentinels so a future merge is grep-able: `grep -rn "RB-EXT" .`

### 5.1 Navigation — `app/[locale]/(routes)/components/app-sidebar.tsx`
```ts
// >>> RB-EXT (registry import)
import { rbMenuItems } from "@/rb-extensions/rb-registry";
// <<< RB-EXT

const navItems = [
  getDashboardMenuItem({ /* … */ }),
  // …upstream items only…
  // >>> RB-EXT (menu items)
  ...rbMenuItems({ session, dict }),
  // <<< RB-EXT
];
```

### 5.2 Background jobs — `app/api/inngest/route.ts`
```ts
// >>> RB-EXT (registry import)
import { rbInngestFunctions } from "@/rb-extensions/rb-registry";
// <<< RB-EXT

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    ...upstreamFunctions,
    // >>> RB-EXT (inngest functions)
    ...rbInngestFunctions(),
    // <<< RB-EXT
  ],
});
```
> Remove the 5 individual `campaign*` imports and array entries that live here today; they are
> now provided by the spread.

### 5.3 Redirects — `next.config.js` (CommonJS!)
`next.config.js` uses `require`, so the redirect provider must be a CommonJS module
(`rb-config.cjs`), **not** the TypeScript registry:
```js
// >>> RB-EXT (redirects)
const { rbRedirects } = require("./rb-extensions/rb-config.cjs");
// <<< RB-EXT

async redirects() {
  return [
    // …upstream redirects…
    // >>> RB-EXT
    ...rbRedirects(),
    // <<< RB-EXT
  ];
}
```

### 5.4 The registry + flags (the heart of the system)
```ts
// rb-extensions/rb-flags.ts
export const rbFlags = {
  emailFunnels: process.env.RB_EMAIL_FUNNELS !== "off", // default ON; set "off" to disable
};
```
```ts
// rb-extensions/rb-registry.ts
import { rbFlags } from "./rb-flags";
import * as emailFunnels from "./email-funnels/feature";

export const rbMenuItems = (ctx) =>
  rbFlags.emailFunnels ? [emailFunnels.menuItem(ctx)] : [];

export const rbInngestFunctions = () =>
  rbFlags.emailFunnels ? emailFunnels.inngestFunctions : [];
```
```js
// rb-extensions/rb-config.cjs  (CommonJS — see §5.3)
const enabled = process.env.RB_EMAIL_FUNNELS !== "off";
const emailFunnelRedirects = [ /* the redirect objects moved out of next.config.js */ ];
exports.rbRedirects = () => (enabled ? emailFunnelRedirects : []);
```
> The flag is read in **two** places (`rb-flags.ts` for TS, `rb-config.cjs` for next.config).
> Keep the env-var name identical in both. This duplication is unavoidable because
> `next.config.js` cannot import TypeScript.

---

## 6. Prisma — the one layer that cannot be fully isolated

There is a single Prisma schema, so custom and upstream model definitions must coexist. We are
on **Prisma 7.6**, where the **multi-file schema folder is stable**. Use it.

### 6.1 Convert to a schema folder
- [ ] Create `prisma/schema/`.
- [ ] Move the existing `prisma/schema.prisma` content to `prisma/schema/main.prisma`
      (this stays upstream-owned).
- [ ] Delete `prisma/schema.prisma.orig` (merge leftover) — already done in Phase 0.
- [ ] Confirm `package.json` / Prisma config points at the folder (Prisma 7 auto-detects
      `prisma/schema/`; if a `schema` path is pinned anywhere, update it).

### 6.2 Move our models to `rb-extensions.prisma` and rename to the `Rb` namespace
Our custom models currently use the **`crm_` prefix — i.e. upstream's own namespace** — which
is exactly the collision risk (if upstream ships a model literally named `crm_campaigns`,
Prisma fails to compile). Rename the **model identifiers** to the `Rb*` namespace but keep the
**existing table names** via `@@map` so **no data migration is required**:

| Current model | New model (in `rb-extensions.prisma`) | Keep table via |
|---|---|---|
| `crm_campaigns` | `RbCampaign` | `@@map("crm_campaigns")` |
| `crm_campaign_templates` | `RbCampaignTemplate` | `@@map("crm_campaign_templates")` |
| `crm_campaign_steps` | `RbCampaignStep` | `@@map("crm_campaign_steps")` |
| `crm_campaign_sends` | `RbCampaignSend` | `@@map("crm_campaign_sends")` |
| `CampaignToTargetLists` | `RbCampaignToTargetLists` | `@@map("CampaignToTargetLists")` |

> Keeping `@@map` to the old table name means the database is untouched — only the **code-level
> identifier** changes. After renaming, fix every `prisma.crm_campaigns` call site (now
> `prisma.rbCampaign`, etc.). These call sites are almost all already inside
> `rb-extensions/email-funnels/` after Phase 2, so the churn is contained.
>
> **Decide explicitly:** if you would rather have clean `rb_*` table names too, that requires a
> real `ALTER TABLE … RENAME` migration. It is safe but it is a data migration — do it only as a
> deliberate, separate step, never silently.

### 6.3 The unavoidable shared edit: columns we added to `crm_Targets`
`crm_Targets` is an upstream model that we widened with three groups of columns
("Extended contact fields", "Stripe / post-purchase automation fields", "Conversion tracking").
A Prisma model can be defined **only once**, so these fields must stay inside the upstream
`crm_Targets` block in `main.prisma`. Two options:

- **Short term (lowest effort):** keep the added columns grouped at the bottom of the
  `crm_Targets` model behind sentinels:
  ```prisma
  // >>> RB-EXT (crm_Targets custom columns)
  stripe_customer_id     String?
  // … our added fields …
  // <<< RB-EXT
  ```
  They are **nullable, additive** columns, so they are non-breaking — upstream code ignores
  fields it doesn't know about. A merge conflict here is a single localized block.

- **Long term (cleanest, recommended):** move our custom attributes into a **side table we
  fully own**, e.g. `RbTargetMarketing` with a 1:1 relation to `crm_Targets`. Then *all* our
  schema lives in `rb-extensions.prisma` and the only upstream-owned change is one relation
  field (or none, if you relate by id without a back-reference). This eliminates the last
  shared edit. Treat it as a follow-up migration, not part of the initial relocation.

### 6.4 Migrations
Prisma migrations are timestamped and append-only, so custom migration files rarely conflict —
they apply in order. After any schema change run `prisma generate` and `prisma migrate`
(via the project's normal scripts — **do not** invent new build steps). Keep the migration
history **linear**; if upstream adds migrations, they interleave by timestamp. If you hit drift,
resolve with `prisma migrate resolve` deliberately — never delete applied migrations.

---

## 7. The recurring upstream-update loop (the payoff)

Once migrated, consuming an upstream release looks like this:

```bash
git checkout dev
git fetch upstream
# Optionally merge a specific tag instead of moving main, for controlled upgrades:
git merge upstream/main

# 1. Resolve conflicts — they are now ONLY at the seams and the Prisma file:
grep -rn "RB-EXT" .          # find every contact point in seconds
# 2. Regenerate client & migrate via the project's normal scripts.
# 3. RB_EMAIL_FUNNELS=off  → verify the vanilla upstream app boots & behaves.
# 4. RB_EMAIL_FUNNELS=on   → verify our feature still works against the new upstream.
# 5. Fix any breakage INSIDE rb-extensions/ only.
```

Then open the release PR per project convention: **`dev → main`** (base `main`, head `dev`).
Never commit directly to `main`; never force-push `dev` or `main`.

---

## 8. Acceptance checklist (definition of done)

- [ ] `rb-extensions/` contains all custom logic; `actions/campaigns`, `inngest/functions/campaigns`,
      `lib/campaigns`, custom `app/api/*` logic, and custom pages no longer hold business logic.
- [ ] `app-sidebar.tsx`, `app/api/inngest/route.ts`, `next.config.js` each contain **one**
      RB-EXT-wrapped registration line and nothing else custom.
- [ ] Prisma uses `prisma/schema/`; custom models are `Rb*`-named in `rb-extensions.prisma`;
      `crm_Targets` custom columns are sentinel-wrapped (or moved to a side table).
- [ ] `prisma/schema.prisma.orig` is gone.
- [ ] `upstream` remote exists and a trial merge shows conflicts only at seams + Prisma.
- [ ] `RB_EMAIL_FUNNELS=off` yields a clean vanilla app; `=on` restores the feature.
- [ ] No behaviour changed for end users.
- [ ] `DEVELOPMENT_GUIDE.md` is updated if any convention here was adjusted during the work.

---

## 9. Things that will bite you (migration-specific)

- **Don't rewrite while relocating.** Mixing a refactor with behaviour changes makes it
  impossible to tell whether a regression came from the move or the change. Relocate first,
  verify identical behaviour, change later.
- **`next.config.js` is CommonJS.** It cannot import the TS registry. Use `rb-config.cjs`.
- **Inngest function ids must stay unique.** When you move the campaign functions, give them
  `rb/`-prefixed ids so a future upstream function can't clash.
- **Route groups don't change URLs.** Moving pages into `(rb-extensions)/` keeps existing links
  working — but re-verify the `next.config.js` redirects still resolve after the move.
- **Prisma model rename ≠ table rename.** Renaming the model identifier with `@@map` is free;
  renaming the actual table is a data migration. Know which one you are doing.
- **Flags must fail safe.** When testing a fresh upstream, start with everything **off** and turn
  features on one at a time.
- **Stay on Prisma + Postgres.** This app's persistence is Prisma/Postgres (upstream's choice).
  Do **not** introduce a second ORM or storage engine for RB features — it would fragment the
  data layer and make upstreaming impossible. Use the existing Prisma client.
