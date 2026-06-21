#!/usr/bin/env bash
#
# restore-customizations.sh
# =============================================================================
# Disaster-recovery / upstream-resync tool for the redblockind/nextcrm-app fork.
#
# WHAT THIS DOES
#   Rebuilds a clean copy of NextCRM from the *upstream* project
#   (pdovhomilja/nextcrm-app) and then re-applies ONLY the customizations that
#   are genuinely ours, producing a branch you can deploy on Netlify.
#
#   It is the executable form of the recovery plan documented in
#   ../../2026_disaster_recovery_nextcrm.md. Read that document first — it
#   explains the mechanism, the verified inventory, and how to regenerate this
#   script if it drifts or breaks.
#
# THE MODEL (three tiers)
#   Tier A — ADDED FILES        : files that exist only in our fork (no upstream
#                                 equivalent). Pure additions; copied verbatim.
#                                 Auto-discovered from git, so the list never
#                                 goes stale.
#   Tier B — CUSTOM SHARED FILES: files that exist in upstream too, but whose
#                                 OUR version embodies a customization we want
#                                 (the Netlify Blobs storage swap + the Neon
#                                 connection wiring). Overlaid with our version,
#                                 then flagged so you can re-check whether
#                                 upstream improved them.
#   Tier C — SURGICAL MERGES    : files that carry a lot of upstream content we
#                                 must KEEP, plus a small bit of ours we must
#                                 re-insert. Handled field-by-field / key-by-key
#                                 so upstream's updates survive:
#                                   - package.json  -> only the `build` script
#                                   - prisma/schema.prisma -> only our columns
#
#   Everything NOT listed above takes UPSTREAM's version — that is the whole
#   point of resyncing: you get upstream's updates everywhere except the few
#   places that are truly yours.
#
# SAFETY
#   - Operates on a NEW branch; never force-pushes; never touches main directly.
#   - Idempotent: safe to re-run. Supports --dry-run.
#   - Does NOT run `next build`, `prisma migrate deploy`, or deploy anything.
#     It only prepares the code. You deploy via your normal dev -> Netlify flow.
#
# REQUIREMENTS
#   git, node (v18+). Run from inside a clone of the fork that has BOTH remotes:
#     origin   -> redblockind/nextcrm-app   (your fork; source of customizations)
#     upstream -> pdovhomilja/nextcrm-app   (the clean base to rebuild from)
# =============================================================================

set -euo pipefail

# --- Configuration (override via env or flags) -------------------------------
FORK_REF="${FORK_REF:-origin/main}"          # where OUR customizations come from
UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}" # the clean base to rebuild on
TARGET_BRANCH="${TARGET_BRANCH:-resync/upstream-$(date +%Y%m%d 2>/dev/null || echo manual)}"
DRY_RUN=0
DISCOVER_ONLY=0

# --- Curated Tier B list: shared files whose OUR version we want to keep ------
# These are the Netlify Blobs storage swap (replacing MinIO/S3) + the Neon
# connection wiring. They are the only shared files where "fork wins". Audit
# this list with --discover; see the recovery doc for why each is here.
CUSTOM_SHARED_FILES=(
  "lib/prisma.ts"                                                  # Neon URL fallback chain
  "lib/minio.ts"                                                   # neutralized legacy shim
  "lib/invoices/storage.ts"                                        # invoice storage on Blobs
  "lib/mcp/tools/crm-documents.ts"                                 # doc tool -> Blobs
  "actions/documents/delete-document.ts"                           # delete via Blobs
  "actions/documents/bulk-delete-documents.ts"                     # bulk delete via Blobs
  "app/api/upload/presigned-url/route.ts"                          # upload path -> Blobs
  "app/api/invoices/[invoiceId]/pdf/route.ts"                      # invoice PDF -> Blobs
  "inngest/functions/documents/enrich-document.ts"                 # reads from Blobs
  "inngest/functions/documents/generate-thumbnail.ts"             # reads/writes Blobs
  "components/ui/minio-uploader.tsx"                               # uploader UI -> Blobs route
  "components/ui/file-uploader-dropzone.tsx"                       # uploader UI -> Blobs route
  "app/[locale]/(routes)/documents/components/bulk-upload-modal.tsx" # bulk upload UI
)

# --- Paths excluded from Tier A auto-discovery (not part of the app) ----------
EXCLUDE_REGEX='^(\.netlify/|\.git/|CLAUDE\.local\.md$|.*\.orig$|node_modules/)'

usage() {
  cat <<EOF
Usage: $0 [options]

  --into <branch>        Target branch name (default: ${TARGET_BRANCH})
  --fork-ref <ref>       Git ref holding YOUR customizations (default: ${FORK_REF})
  --upstream-ref <ref>   Clean base ref to rebuild on   (default: ${UPSTREAM_REF})
  --dry-run              Print what would happen; change nothing
  --discover             Only print the auto-discovered Tier A + audit the Tier B list, then exit
  -h, --help             Show this help

Environment overrides: FORK_REF, UPSTREAM_REF, TARGET_BRANCH
EOF
}

# --- Parse args --------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --into)         TARGET_BRANCH="$2"; shift 2;;
    --fork-ref)     FORK_REF="$2"; shift 2;;
    --upstream-ref) UPSTREAM_REF="$2"; shift 2;;
    --dry-run)      DRY_RUN=1; shift;;
    --discover)     DISCOVER_ONLY=1; shift;;
    -h|--help)      usage; exit 0;;
    *) echo "Unknown option: $1" >&2; usage; exit 1;;
  esac
done

log()  { printf '\033[1;34m[restore]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[review]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
run()  { if [[ $DRY_RUN -eq 1 ]]; then echo "  (dry-run) $*"; else eval "$*"; fi; }

# --- Preflight ---------------------------------------------------------------
preflight() {
  command -v git  >/dev/null || { echo "git not found" >&2; exit 1; }
  command -v node >/dev/null || { echo "node not found" >&2; exit 1; }
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "Not a git repo" >&2; exit 1; }

  log "Fetching refs..."
  run "git fetch upstream --quiet || true"
  run "git fetch origin --quiet   || true"

  git rev-parse --verify "$FORK_REF^{commit}" >/dev/null 2>&1 \
    || { echo "FORK_REF '$FORK_REF' not resolvable. Is the 'origin' remote set?" >&2; exit 1; }
  git rev-parse --verify "$UPSTREAM_REF^{commit}" >/dev/null 2>&1 \
    || { echo "UPSTREAM_REF '$UPSTREAM_REF' not resolvable. Add it with:
       git remote add upstream https://github.com/pdovhomilja/nextcrm-app.git" >&2; exit 1; }

  if [[ $DRY_RUN -eq 0 && $DISCOVER_ONLY -eq 0 ]]; then
    if ! git diff --quiet || ! git diff --cached --quiet; then
      echo "Working tree is dirty. Commit or stash first." >&2; exit 1
    fi
  fi
}

# --- Tier A discovery: files in FORK but not in UPSTREAM ----------------------
discover_added_files() {
  comm -23 \
    <(git ls-tree -r --name-only "$FORK_REF" | sort) \
    <(git ls-tree -r --name-only "$UPSTREAM_REF" | sort) \
  | grep -vE "$EXCLUDE_REGEX" || true
}

# --- Discover mode: print the manifest the script will act on ----------------
do_discover() {
  log "Tier A — ADDED files (fork-only, copied verbatim):"
  discover_added_files | sed 's/^/  + /'
  echo
  log "Tier B — CUSTOM SHARED files (fork wins, review against upstream):"
  for f in "${CUSTOM_SHARED_FILES[@]}"; do
    if git cat-file -e "$FORK_REF:$f" 2>/dev/null; then
      if git diff --quiet "$UPSTREAM_REF" "$FORK_REF" -- "$f" 2>/dev/null; then
        echo "  = $f  (identical to upstream — no-op)"
      else
        echo "  ~ $f  (differs from upstream — will overlay our version)"
      fi
    else
      echo "  ? $f  (MISSING in $FORK_REF — list is stale, please update)"
    fi
  done
  echo
  log "Tier C — SURGICAL: package.json (build script), prisma/schema.prisma (our columns)"
}

# --- Tier C: merge only the `build` script of package.json -------------------
surgical_package_json() {
  log "Surgical merge: package.json build script"
  local fork_build
  fork_build="$(git show "$FORK_REF:package.json" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).scripts.build||"")}catch(e){process.exit(3)}})')" \
    || { warn "Could not read fork build script; skipping package.json merge"; return; }

  if [[ -z "$fork_build" ]]; then warn "Fork build script empty; skipping"; return; fi

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  (dry-run) would set scripts.build to our value (preserving upstream deps)"
    return
  fi

  FORK_BUILD="$fork_build" node -e '
    const fs=require("fs");
    const p=JSON.parse(fs.readFileSync("package.json","utf8"));
    p.scripts=p.scripts||{};
    p.scripts.build=process.env.FORK_BUILD;
    fs.writeFileSync("package.json", JSON.stringify(p,null,2)+"\n");
  '
  ok "package.json build script set (upstream dependencies preserved)"
}

# --- Tier C: insert our custom columns into prisma/schema.prisma -------------
# Per-field idempotent: adds a column to a model only if that field name is
# absent from the model block, so it never produces duplicate-field errors and
# never disturbs upstream's own schema changes.
surgical_schema() {
  log "Surgical merge: prisma/schema.prisma custom columns"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  (dry-run) would ensure custom columns on crm_Contacts, crm_Targets, crm_campaign_steps"
    return
  fi
  node -e '
    const fs=require("fs");
    const file="prisma/schema.prisma";
    let src=fs.readFileSync(file,"utf8");

    // model -> [ [fieldName, prismaLine], ... ]
    const SPEC={
      "crm_Contacts":[
        ["city","  city                   String?"],
        ["country","  country                String?"],
        ["state","  state                  String?"],
        ["is_b2b","  is_b2b                 Boolean?"],
        ["b2b_discount_percent","  b2b_discount_percent   String?"],
        ["contact_origin","  contact_origin         String?"],
        ["cumulative_order_count","  cumulative_order_count String?"],
        ["first_order_date","  first_order_date       String?"],
        ["is_temporary","  is_temporary           Boolean?"],
        ["last_order_date","  last_order_date        String?"],
        ["last_order_id","  last_order_id          String?"],
        ["opt_in_time","  opt_in_time            String?"],
        ["stripe_customer_id","  stripe_customer_id     String?"],
      ],
      "crm_Targets":[
        ["stripe_customer_id","  stripe_customer_id     String?"],
        ["first_order_date","  first_order_date       String?"],
        ["last_order_date","  last_order_date        String?"],
        ["last_order_id","  last_order_id          String?"],
        ["cumulative_order_count","  cumulative_order_count String?"],
        ["contact_origin","  contact_origin         String?"],
        ["opt_in_time","  opt_in_time            String?"],
        ["is_b2b","  is_b2b                 Boolean?"],
        ["b2b_discount_percent","  b2b_discount_percent   String?"],
        ["is_temporary","  is_temporary           Boolean?"],
      ],
      "crm_campaign_steps":[
        ["content_html","  content_html String? @db.Text"],
      ],
    };

    let totalAdded=0;
    for(const [model, fields] of Object.entries(SPEC)){
      const start=src.indexOf("model "+model+" {");
      if(start<0){ console.error("  ! model "+model+" not found in schema — SKIPPED (review manually)"); continue; }
      // find the matching closing brace for this model block
      let depth=0, i=src.indexOf("{",start), end=-1;
      for(; i<src.length; i++){
        if(src[i]==="{") depth++;
        else if(src[i]==="}"){ depth--; if(depth===0){ end=i; break; } }
      }
      if(end<0){ console.error("  ! could not parse "+model+" block — SKIPPED"); continue; }
      let block=src.slice(start,end);
      const additions=[];
      for(const [name,line] of fields){
        // field present if the block has a line starting with the field name
        const re=new RegExp("^\\s*"+name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\s","m");
        if(!re.test(block)) additions.push(line);
      }
      if(additions.length){
        const insert="\n  // >>> RB custom fields (restore-customizations.sh)\n"+additions.join("\n")+"\n";
        src=src.slice(0,end)+insert+src.slice(end);
        totalAdded+=additions.length;
        console.log("  + "+model+": added "+additions.length+" field(s)");
      } else {
        console.log("  = "+model+": all custom fields already present");
      }
    }
    fs.writeFileSync(file,src);
    console.log("  schema columns ensured ("+totalAdded+" added)");
  '
  ok "prisma/schema.prisma custom columns ensured"
  warn "Run \`npx prisma format && npx prisma validate\` after the script to confirm the schema parses."
}

# --- Main --------------------------------------------------------------------
preflight

if [[ $DISCOVER_ONLY -eq 1 ]]; then
  do_discover
  exit 0
fi

log "Rebuilding from '$UPSTREAM_REF' onto new branch '$TARGET_BRANCH'"
log "Re-applying customizations from '$FORK_REF'"
echo

# 1. Start from a clean upstream base on a new branch.
if [[ $DRY_RUN -eq 1 ]]; then
  echo "  (dry-run) git checkout -B $TARGET_BRANCH $UPSTREAM_REF"
else
  git checkout -B "$TARGET_BRANCH" "$UPSTREAM_REF"
fi

# 2. Tier A — overlay every fork-only file verbatim.
log "Tier A — overlaying fork-only added files..."
ADDED_COUNT=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  run "git checkout \"$FORK_REF\" -- \"$f\""
  ADDED_COUNT=$((ADDED_COUNT+1))
done < <(discover_added_files)
ok "Tier A: $ADDED_COUNT fork-only files overlaid"

# 3. Tier B — overlay our version of the curated shared files.
log "Tier B — overlaying custom shared files (Blobs storage + Neon wiring)..."
for f in "${CUSTOM_SHARED_FILES[@]}"; do
  if ! git cat-file -e "$FORK_REF:$f" 2>/dev/null; then
    warn "Tier B entry missing in fork, skipping: $f (audit the list with --discover)"
    continue
  fi
  run "git checkout \"$FORK_REF\" -- \"$f\""
  warn "overlaid (review vs upstream): $f"
done

# 4. Tier C — surgical merges that must preserve upstream content.
surgical_package_json
surgical_schema

# 5. Stage everything.
run "git add -A"

# --- Final report ------------------------------------------------------------
cat <<'REPORT'

=============================================================================
RESTORE COMPLETE (code only — nothing was built or deployed)
=============================================================================

NEXT STEPS (your normal dev -> Netlify flow):

  1. Review the staged changes, especially the files flagged [review] above —
     upstream may have improved them since the Blobs swap was written.

  2. Confirm the schema parses:
        npx prisma format
        npx prisma validate

  3. Confirm these environment variables are set on the Netlify site
     (NAMES only — never commit values):
        DATABASE_URL  (or NETLIFY_DATABASE_URL / NETLIFY_DATABASE_URL_UNPOOLED)
        NEXTCRM_TOKEN                 # legacy shared-key ingest endpoints
        BETTER_AUTH_URL / BETTER_AUTH_SECRET
        NEXT_PUBLIC_APP_URL / NEXT_PUBLIC_APP_NAME
        GOOGLE_ID / GOOGLE_SECRET
        RESEND_API_KEY / RESEND_FROM_EMAIL / RESEND_WEBHOOK_SECRET
        CRON_SECRET
     (Full catalogue: 2026_disaster_recovery_nextcrm.md)

  4. DATABASE: the build runs `prisma migrate deploy` against whatever DB the
     env points at. If you reuse the SAME Neon database, your data AND your
     `nxtc__` Lambda API tokens survive untouched. Take a Neon restore point
     BEFORE the first deploy whenever prisma/migrations/ changed.

  5. Commit, push to dev, and let Netlify build a deploy preview. Iron out any
     remaining issues there before promoting dev -> main.

If anything is wrong, this branch is disposable: `git checkout main` and start
over. Nothing here is irreversible until you deploy and migrations run.
=============================================================================
REPORT

ok "Done. Branch: $TARGET_BRANCH"
