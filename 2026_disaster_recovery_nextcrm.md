# 2026 Disaster Recovery — NextCRM (redblockind fork)

> **Audience:** AI coding agents (and the humans directing them).
> **Purpose:** Explain the mechanism behind this fork's disaster recovery so that an
> agent can (a) run the recovery, and (b) **recreate or repair the recovery script**
> (`scripts/disaster-recovery/restore-customizations.sh`) from first principles if it
> drifts, breaks, or becomes inoperable.
>
> This document is the *specification*; the script is one *implementation* of it. If the
> two ever disagree, this document is the source of truth — regenerate the script from it.

---

## 0. The one-paragraph summary

This app is the upstream **NextCRM** project (`pdovhomilja/nextcrm-app`) plus a **small,
mostly-additive set of customizations**. Because the custom surface is small and well
isolated, we can throw away our fork's drift at any time, rebuild a clean copy from
upstream, and **re-apply our customizations with a script**. The data lives in **Neon**
(independent of the code) and the code lives in **GitHub** (independent of the Netlify
site), so the Netlify site itself is disposable. Recovery = `fresh upstream` + `our delta`
+ `point at Neon` + `deploy`.

---

## 1. The three things you need (and where they live)

Recovery is feasible only because these three are independent:

| Asset | Lives in | Notes |
| --- | --- | --- |
| **Code** | GitHub: `redblockind/nextcrm-app` (`origin`) and `pdovhomilja/nextcrm-app` (`upstream`) | The fork is the *crown jewels of behaviour*; upstream is the *clean base*. |
| **Data** | **Neon Postgres** | Reached via `DATABASE_URL` / `NETLIFY_DATABASE_URL`. Take a Neon restore point before any migration. |
| **Config** | Netlify environment variables | Names catalogued in §6. **Never** stored in the repo. |

A critical, non-obvious fact: **our Lambda API tokens (`nxtc__…`) live in the database, not
in env vars.** Reuse the same Neon database → every token and all data survive untouched, and
the Stripe Lambdas keep working with zero reconfiguration. Start from an empty database →
you must mint one new token and paste it into the Lambda once.

---

## 2. Why a blind "Sync fork" is wrong (the mechanism we must respect)

Two facts shape everything:

1. **`prisma migrate deploy` runs at *build time*.** Our build command applies any new
   migrations to whatever database the environment points at *before the new code even
   runs*. So a deploy can change the live schema irreversibly. This is why a Neon restore
   point — taken **before** deploying anything that changed `prisma/migrations/` — is the
   single most important safety step. Reverting code does **not** undo an applied migration.

2. **Upstream and our fork both edit the same files over time.** A blind merge or a
   "fork-wins on everything" copy would either drown us in conflicts or silently throw away
   upstream's improvements. The recovery must therefore be **selective**: upstream wins
   almost everywhere; our version wins only in the few places that are genuinely ours.

---

## 3. The verified custom delta (the manifest the script reproduces)

This inventory was derived by comparing the fork against the **merge-base** it shares with
upstream (the last common ancestor), not by eyeballing the code. That is the only reliable
test for "what did *we* add." To regenerate it yourself, see §5.

### 3a. Tier A — files that are ours alone (pure additions, zero conflict)

These exist only in the fork; upstream has no equivalent, so they are copied **verbatim**.
The script discovers them dynamically (files in `origin/main` not in `upstream/main`), so the
list self-maintains. The load-bearing members:

- **Lambda intake endpoints** — `app/api/crm/targets/ingest/route.ts`,
  `app/api/crm/contacts/ingest/route.ts`. The heart of "receive data from my Lambdas."
- **Authenticated file route** — `app/api/files/[key]/route.ts` (serves Netlify Blobs).
- **Netlify Blobs abstraction** — `lib/storage.ts`.
- **Campaign-template API** — `app/api/campaigns/templates/route.ts` and `[templateId]/route.ts`.
- **Post-purchase automation** — `inngest/functions/campaigns/post-purchase-batch.ts`
  *(deprecated / non-functional — rides along harmlessly; it is not re-registered because we
  take upstream's `app/api/inngest/route.ts`)*.
- **Three custom migrations** — `prisma/migrations/20260430035331_add_amazon_connect_import_fields`,
  `…20260520000000_add_campaign_step_content_html`, `…20260525000000_add_stripe_fields_to_targets`.
- **Import / ops scripts** — `scripts/import/*`, `scripts/migration/backfill-roles.ts`,
  `scripts/activate-user.ts`, and the various reference docs.

### 3b. Tier B — shared files where *our* version is the customization

These exist in upstream too, but our version embodies the **Netlify Blobs storage swap**
(which replaced the MinIO/S3 path that needs Docker and `MINIO_*` env vars) plus the **Neon
connection wiring**. The script overlays our version and **flags each for review**, because
upstream may have improved these files since the swap was written.

| File | Why it's ours |
| --- | --- |
| `prisma.config.ts` | Same Neon wiring as `lib/prisma.ts` but for the Prisma **CLI**: the `DATABASE_URL → NETLIFY_DATABASE_URL_UNPOOLED → NETLIFY_DATABASE_URL` fallback (defaulting to `""`) plus `import "dotenv/config"`. Prisma 7 no longer auto-loads `.env` and upstream's config calls the strict `env("DATABASE_URL")` helper, which **throws `PrismaConfigEnvError` whenever `DATABASE_URL` is unset** (e.g. running `npx prisma format` locally). Ours degrades gracefully instead. |
| `lib/prisma.ts` | Adds the `DATABASE_URL → NETLIFY_DATABASE_URL → NETLIFY_DATABASE_URL_UNPOOLED` fallback chain. This *is* "the routine that connects to my Neon DB." Upstream reads only `DATABASE_URL`. |
| `lib/minio.ts` | Neutralized legacy shim. |
| `lib/invoices/storage.ts` | Invoice file storage routed through Blobs. |
| `lib/mcp/tools/crm-documents.ts` | Document tool reads from Blobs. |
| `actions/documents/delete-document.ts`, `…/bulk-delete-documents.ts` | Delete via Blobs. |
| `app/api/upload/presigned-url/route.ts` | Upload path → Blobs. |
| `app/api/invoices/[invoiceId]/pdf/route.ts` | Invoice PDF → Blobs. |
| `inngest/functions/documents/enrich-document.ts`, `…/generate-thumbnail.ts` | Read/write Blobs. |
| `components/ui/minio-uploader.tsx`, `components/ui/file-uploader-dropzone.tsx` | Uploader UIs point at the Blobs route. |
| `app/[locale]/(routes)/documents/components/bulk-upload-modal.tsx` | Bulk upload UI. |

### 3c. Tier C — shared files that need a *surgical* merge (keep upstream + re-insert ours)

Blind fork-wins here would discard large amounts of upstream content. The script merges only
the small part that is ours:

- **`package.json`** — keep upstream's entire file (its dependency updates matter), replace
  **only** the `build` script with ours. Ours runs, in order:
  `prisma generate` → *(if a DB URL is set)* `prisma migrate resolve --rolled-back
  20260415164939_invoices_module || true` → `prisma migrate deploy` → `next build`. The
  `migrate resolve` line is a **one-time reconciliation for the invoices-module migration —
  keep it.** Upstream's build is the simpler `prisma generate && prisma migrate deploy &&
  next build`.
- **`prisma/schema.prisma`** — keep upstream's schema, then ensure our custom columns exist
  on three models (idempotent, per-field, so it never produces duplicate-field errors and
  never disturbs upstream's own schema changes):
  - `crm_Contacts`: `city, country, state, is_b2b, b2b_discount_percent, contact_origin,
    cumulative_order_count, first_order_date, is_temporary, last_order_date, last_order_id,
    opt_in_time, stripe_customer_id` (all `String?`, except `is_b2b`/`is_temporary` `Boolean?`).
  - `crm_Targets`: the Stripe/post-purchase block — `stripe_customer_id, first_order_date,
    last_order_date, last_order_id, cumulative_order_count, contact_origin, opt_in_time,
    is_b2b, b2b_discount_percent, is_temporary`.
  - `crm_campaign_steps`: `content_html String? @db.Text`.

  These columns are also created in the database by the three Tier-A migrations, so schema and
  database stay in sync.

### 3d. Everything else → upstream wins

Any file not in Tier A/B/C takes upstream's version. That includes the invoicing module, the
AI enrichment engine, the MCP layer, Better Auth, `serializeDecimals()`, and the base
campaigns system — **all of these are upstream's, not ours**, and they update cleanly. Do not
"protect" them; doing so was the mistake of an earlier inventory.

---

## 4. The recovery procedure (what the script automates)

```
0. Pre-req: a clone with two remotes —
     origin   → redblockind/nextcrm-app   (customizations)
     upstream → pdovhomilja/nextcrm-app   (clean base)
   Add upstream if missing:
     git remote add upstream https://github.com/pdovhomilja/nextcrm-app.git

1. Take a Neon restore point (dashboard) — the only irreplaceable safety net.

2. Run the script:
     bash scripts/disaster-recovery/restore-customizations.sh --into resync/upstream-YYYYMMDD
   It: branches from upstream/main → overlays Tier A verbatim → overlays Tier B (flagged)
       → surgically merges package.json build script + schema columns → stages everything.

3. Reconcile the flagged [review] files and the schema:
     npx prisma format && npx prisma validate

4. Set the environment variables (§6) on the Netlify site. Point DATABASE_URL at Neon.

5. Commit → push to dev → let Netlify build a deploy preview. Verify against the deployed
   dev environment (no local DB needed). Iron out issues there.

6. Promote dev → main only once dev is green and a fresh Neon restore point exists.
```

**Rollback at any stage before step 6 is free:** the branch is disposable (`git checkout
main`). After a deploy that ran migrations, rollback = restore the Neon point **and** publish
the last good Netlify deploy; code revert alone is insufficient.

---

## 5. How to recreate / audit the script from scratch

If the script is lost or wrong, regenerate its manifest with these commands and rebuild it to
match §3. This is the exact method used to verify the inventory above.

```bash
git fetch upstream && git fetch origin
MB=$(git merge-base origin/main upstream/main)        # the shared ancestor

# Tier A — files we added (in fork, not in upstream):
comm -23 <(git ls-tree -r --name-only origin/main | sort) \
         <(git ls-tree -r --name-only upstream/main | sort)

# All shared files we changed since the ancestor (candidates for Tier B/C):
comm -12 <(git diff --name-only "$MB" origin/main | sort) \
         <(git ls-tree -r --name-only upstream/main | sort)

# Narrow Tier B to the storage swap — shared files that reference Blobs:
git grep -lE '@netlify/blobs|lib/storage|storage(Set|Get|Delete|PublicUrl)' origin/main \
  -- <paste the shared-files list>
```

**Classification rules the script encodes:**
- *In fork, not upstream* → **Tier A** (verbatim, auto-discovered).
- *Shared + references Blobs/storage, or is `lib/prisma.ts`* → **Tier B** (fork-wins, flag).
- *`package.json`* → **Tier C** (merge `build` script only).
- *`prisma/schema.prisma`* → **Tier C** (ensure custom columns, per-field idempotent).
- *Everything else* → upstream wins (drop our drift; that drift is mostly the deprecated
  campaigns add-on and incidental edits we do not need to preserve).

**Invariants any reimplementation must hold:**
1. Never force-push; always operate on a new branch off `upstream/main`.
2. Never run `next build` / `prisma migrate deploy` / deploy — prepare code only.
3. Schema editing must be **per-field idempotent** (re-running adds nothing, never duplicates).
4. `package.json` must keep upstream's dependencies — only the `build` script is ours.
5. Preserve the `migrate resolve --rolled-back 20260415164939_invoices_module || true` line.
6. Tier B overlays must be **flagged**, not silent — upstream may have improved them.

---

## 6. Environment variable catalogue (names only — never values)

Set these on the Netlify site. Grouped by purpose; the **integration-defining** ones are
marked ★ (the handful that encode how this app is wired to the outside world).

- **Database** ★ — `DATABASE_URL`, `NETLIFY_DATABASE_URL`, `NETLIFY_DATABASE_URL_UNPOOLED`
- **Lambda / intake auth** ★ — `NEXTCRM_TOKEN` (legacy shared-key endpoints),
  `RESEND_WEBHOOK_SECRET` (email webhook), `CRON_SECRET` (internal scheduled endpoints).
  *(The modern `nxtc__` ingest tokens are in the database, not here — see §1.)*
- **App identity / URLs** — `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_APP_DOMAIN`,
  `NEXT_PUBLIC_APP_NAME`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`
- **Auth (Google OAuth)** — `GOOGLE_ID`, `GOOGLE_SECRET`
- **Email** — `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, plus the SMTP/IMAP family
  (`SMTP_HOST/PORT/USER/PASSWORD`, `IMAP_HOST/PORT/USER/PASSWORD`, `EMAIL_*`,
  `EMAIL_ENCRYPTION_KEY`)
- **Background jobs (Inngest)** — `INNGEST_ID`, `INNGEST_APP_NAME`, `INNGEST_EVENT_KEY`,
  `INNGEST_SIGNING_KEY`, `INNGEST_BASE_URL`
- **AI / enrichment (optional; upstream features)** — `OPENAI_API_KEY` (and `OPEN_AI_*`
  variants), `ANTHROPIC_API_KEY`, `FIRECRAWL_API_KEY`, `E2B_API_KEY`, `E2B_ENRICHMENT_TEMPLATE`
- **Legacy storage (superseded by Netlify Blobs — safe to omit)** — `MINIO_*`, `DO_*`
- **Invoice OCR (Rossum, optional)** — `ROSSUM_*`

There is **no Stripe SDK and no Stripe key in this app** — all Stripe logic lives in the
external Lambda, which hands NextCRM finished JSON. So there is nothing Stripe-specific to set
here beyond the intake auth above.

---

## 7. The Lambda ↔ CRM contract (protect this across upstream merges)

Your Lambdas depend on these endpoints. Treat them as a stable contract — they are Tier A
(ours alone), so they never conflict during a merge, but verify they still resolve after one.

| Path | Method | Auth | Writes |
| --- | --- | --- | --- |
| `/api/crm/targets/ingest` | POST | Bearer `nxtc__…` (DB-backed, `validateApiToken`) | `crm_Targets` |
| `/api/crm/contacts/ingest` | POST | Bearer `nxtc__…` (DB-backed) | `crm_Contacts` |
| `/api/crm/contacts/create-from-remote` | POST | shared key in `NEXTCRM_TOKEN` header | `crm_Contacts` |
| `/api/crm/leads/create-lead-from-web` | POST | shared key, `authorization` = `NEXTCRM_TOKEN` | `crm_Leads` |
| `/api/campaigns/webhooks/resend` | POST | HMAC (Svix), `RESEND_WEBHOOK_SECRET` | `crm_campaign_sends` |

Behaviour of the primary intake (`/api/crm/targets/ingest`): dedupes on email
(case-insensitive); 0 matches → create, 1 → update, >1 → HTTP 409; merges
`stripe_customer_id` as a comma-separated list on returning customers; stamps
`contact_origin = "stripe_webhook"` when absent; accepts but ignores the legacy `target_list`
field. The `…/contacts/ingest` endpoint mirrors this design for contacts.

---

## 8. Glossary of the two recovery scenarios

- **Resync (routine):** start from the current fork, pull upstream's updates, re-apply our
  delta. Same Neon DB, same tokens. This is what the script does by default.
- **Cold rebuild (true disaster):** the Netlify site is gone. Clone upstream fresh, run the
  script, point at Neon (data + tokens survive if it's the same DB), set env vars, deploy.
  Identical mechanism; the only difference is whether the database is the existing one or new.

Both reduce to the same operation because our customizations are small, additive, and captured
here. Keep this document current whenever the custom delta changes, and the recovery stays
true.

---

## 9. Operator runbook — exact commands, in order (for a human, no local DB needed)

> **Who this is for:** the person actually performing the recovery at a keyboard. Sections 1–8
> explain *why*; this section is the *what-to-type, in what order*. Follow it top to bottom.
>
> **What you need:** `git` and `node` (v18+) installed, a clone of the fork, GitHub access, and
> a browser for the **Neon** and **Netlify** dashboards. **You do NOT need PostgreSQL installed
> locally.** Every database operation happens either in the Neon dashboard (the restore point)
> or automatically at **Netlify build time**. The only schema commands you run locally —
> `npx prisma format` and `npx prisma validate` — just read the schema *file*; they never open a
> database connection. (This works even with no `DATABASE_URL` set because our `prisma.config.ts`
> degrades gracefully — see §3b.)

### Where am I right now?

The single most important thing to know: **running `scripts/disaster-recovery/restore-customizations.sh`
is the core of the recovery, and it happens at Step 4 below.** If you have been doing `git checkout`
gymnastics and have *not* run that script yet, you are not "nearly finished" — you are at the
*start*. Almost all the real work (Steps 4–9) is still ahead. The git steps before it only exist
to hand the script a clean starting point.

---

### Step 0 — Confirm both GitHub remotes exist

The script rebuilds from **upstream** and re-applies **your** delta, so it needs both remotes.

```bash
git remote -v
# Expect to see BOTH:
#   origin    -> redblockind/nextcrm-app   (your fork — your customizations)
#   upstream  -> pdovhomilja/nextcrm-app   (clean base to rebuild from)

# If 'upstream' is missing, add it:
git remote add upstream https://github.com/pdovhomilja/nextcrm-app.git

# Pull the latest of both:
git fetch upstream
git fetch origin
```

---

### Step 1 — Clear the working tree (this is the `git checkout` error you hit)

If a `git checkout` failed with *"Your local changes to the following files would be overwritten…
`prisma/schema.prisma`"*, that is Git protecting un-saved edits — **not** data loss, and **not** a
problem with the recovery. The recovery script refuses to run on a dirty tree, so you must clear it
first. Because the script **rebuilds the schema from scratch anyway**, nothing in your working tree
is needed by the recovery — you are only deciding what to keep for your own records.

```bash
git status                       # see exactly what is dirty

# Recommended — tuck the edits away safely (you can get them back with `git stash pop`):
git stash push -m "pre-recovery local drift"

# OR, if you are certain the local edits are throwaway (e.g. `prisma format` noise),
# discard just that file instead:
#   git restore prisma/schema.prisma
```

You do **not** need to be on any particular branch — the script creates its own branch off
`upstream/main` regardless of where you are. A clean working tree is the only requirement.
Confirm it is clean:

```bash
git status                       # should report "nothing to commit, working tree clean"
```

---

### Step 2 — Take a Neon restore point (browser — do this BEFORE anything deploys)

Open the **Neon dashboard** and create a restore point (or a Neon branch) of the production
database. This is the one irreplaceable safety net: the Netlify build runs `prisma migrate deploy`
*at build time*, which can change the live schema irreversibly. Reverting code does **not** undo an
applied migration — only the Neon restore point does. (Nothing is deployed yet; you are just arming
the safety net now so it exists before Step 6.)

---

### Step 3 — Preview what the script will do (optional, recommended)

Neither of these changes anything — they just show you the plan.

```bash
# List the files the script classifies as Tier A / B / C:
bash scripts/disaster-recovery/restore-customizations.sh --discover

# Walk the full run without writing anything:
bash scripts/disaster-recovery/restore-customizations.sh --dry-run
```

---

### Step 4 — Run the recovery script  ← the step you had not reached yet

```bash
bash scripts/disaster-recovery/restore-customizations.sh --into "resync/upstream-$(date +%Y%m%d)"
```

This creates a new branch off `upstream/main`, overlays your Tier A files verbatim, overlays the
Tier B Blobs/Neon files (flagging each `[review]`), surgically merges the `package.json` build
script and your custom schema columns, and stages everything. **It does not build or deploy.**
When it finishes, note the branch name it created:

```bash
git branch --show-current        # e.g. resync/upstream-20260621
```

---

### Step 5 — Reconcile the schema and the flagged files (no DB needed)

```bash
npx prisma format                # parses + tidies the schema file (no DB connection)
npx prisma validate              # confirms the schema is valid   (no DB connection)
```

Then review every file the script flagged `[review]` (the Tier B overlays) against upstream — those
are the only places where upstream may have improved a file you overwrote:

```bash
git diff --stat                  # overview of everything staged
# For each flagged file, compare your version to upstream's, e.g.:
#   git diff upstream/main -- lib/prisma.ts
```

---

### Step 6 — Set the environment variables on the Netlify site (browser)

In the Netlify dashboard, set the variables catalogued in **§6**. The critical one is the database
URL: **point `DATABASE_URL` (and/or `NETLIFY_DATABASE_URL*`) at the SAME Neon database.** Reusing
the same database means all your data **and** your `nxtc__…` Lambda API tokens survive untouched
(see §1). Never commit any values to the repo — names only.

---

### Step 7 — Commit the recovered code

```bash
git add -A
git commit -m "Disaster recovery: resync upstream and re-apply customizations"
```

---

### Step 8 — Push to GitHub and let Netlify build a deploy preview

```bash
# Push the recovery branch (use the name from Step 4):
git push -u origin "$(git branch --show-current)"
```

Netlify builds a deploy preview for the branch. **This is the only place migrations run:** the build
executes `prisma generate → prisma migrate deploy → next build` against the Neon database your env
vars point at — which is exactly why you need no local database. Make sure your Step 2 Neon restore
point exists before this push whenever `prisma/migrations/` changed.

> **Team-flow note:** this project promotes work via `dev → main` (see §4 of AGENTS.md). If you want
> the recovery to ride the standard `dev` deploy instead of a per-branch preview, bring the recovery
> branch onto `dev` (`git checkout dev && git merge <recovery-branch>`), resolve any conflicts in
> favour of the recovery branch, then `git push origin dev`. Either way, **never force-push `dev` or
> `main`.**

---

### Step 9 — Verify on the deployed preview, then promote to production

1. On the deployed preview URL, smoke-test the integration surface: the Lambda intake endpoints
   in **§7** (`/api/crm/targets/ingest`, `/api/crm/contacts/ingest`), the authenticated file route,
   and login. Verify against the **deployed** environment — you have no local DB by design.
2. Once the preview is green **and** a fresh Neon restore point exists, open the release PR:

```bash
gh pr create --base main --head dev --title "release: disaster-recovery resync" \
  --body "Resynced from upstream and re-applied the verified custom delta (see 2026_disaster_recovery_nextcrm.md)."
```

(If you deployed the recovery branch directly rather than via `dev`, use `--head <recovery-branch>`.)

---

### Rollback — free until you deploy, deliberate afterward

- **Before Step 8 (nothing deployed):** the recovery branch is disposable. `git checkout main`
  (and `git stash pop` if you stashed in Step 1) returns you to where you started. Nothing is
  irreversible.
- **After a deploy that ran migrations:** code revert alone is **not** enough. You must **restore the
  Neon restore point from Step 2 AND publish the last known-good Netlify deploy.** This is the whole
  reason Step 2 is non-negotiable.

---

### The whole runbook at a glance

| # | Do | Command / place | Touches DB? |
| - | --- | --- | --- |
| 0 | Confirm remotes | `git remote -v` / `git remote add upstream …` | no |
| 1 | Clean working tree | `git stash push -m …` (the checkout-error fix) | no |
| 2 | Neon restore point | Neon dashboard | **yes (safety net)** |
| 3 | Preview (optional) | `…restore-customizations.sh --discover / --dry-run` | no |
| 4 | **Run the script** | `…restore-customizations.sh --into resync/upstream-$(date +%Y%m%d)` | no |
| 5 | Reconcile schema | `npx prisma format && npx prisma validate` | no |
| 6 | Set env vars | Netlify dashboard (point `DATABASE_URL` at same Neon) | no |
| 7 | Commit | `git add -A && git commit -m …` | no |
| 8 | Push → preview | `git push -u origin <recovery-branch>` (Netlify builds; migrations run here) | **yes (at build)** |
| 9 | Verify + promote | test preview, then `gh pr create --base main --head dev` | no |
