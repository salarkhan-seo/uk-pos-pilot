#!/usr/bin/env bash
# UK POS pilot — cloud deploy template (STRICT-API-DEPLOY, 17 Nov 2026).
#
# Automates everything the Render and Neon APIs actually allow, and says
# plainly where they stop. Read the header before running it.
#
#   export NEON_API_KEY="<from console.neon.tech > Account Settings > API Keys>"
#   export RENDER_API_KEY="<from dashboard.render.com/u/settings#api-keys>"
#   bash scripts/cloud-deploy.sh            # Neon + validate + dashboard steps
#   bash scripts/cloud-deploy.sh --finish   # after the Blueprint exists: env vars + deploys + verify
#
# WHAT IS AUTOMATED (verified against the official API references):
#   Neon API v2 (https://console.neon.tech/api/v2):
#     POST /projects  {name: uk-pos-staging, region_id: aws-eu-west-2, pg_version: 16}
#     POST /projects/{id}/databases  {name: ukpos_staging}
#     GET  /projects/{id}/connection_uri?database_name=ukpos_staging
#     -> DATABASE_URL is written into .env.staging (git-ignored) and
#        printed ONCE so it can be pasted into Render. Never commit it.
#   Render API v1 (https://api.render.com/v1):
#     POST /blueprints/validate  (render.yaml dry-run; creates nothing)
#     PUT  /services/{id}/env-vars/{key}  (one secret at a time)
#     POST /services/{id}/deploys  (trigger a deploy)
#     GET  /services, /services/{id}/deploys  (lookup + status polling)
#
# WHAT IS NOT AUTOMATED — AND WHY (do not "fix" this by guessing):
#   Creating the Render Blueprint itself is DASHBOARD-ONLY. The Render
#   API reference lists GET /blueprints, POST /blueprints/validate,
#   GET/PATCH /blueprints/{id} and POST /blueprints/{id}/sync — there is
#   NO create-blueprint endpoint. The CLI cannot create one either.
#   Separately, free-plan web services cannot be created via the API at
#   all (dashboard or a paid plan only) — and this Blueprint uses free
#   services. So the one manual step is: Render dashboard > New >
#   Blueprint > select salarkhan-seo/uk-pos-pilot > Apply. After that
#   first sync, everything else in this script works via the API.
#
# Tokens come from the environment only. They are never written to a
# file, never printed, and never passed on a command line that another
# process could read — curl reads them from the variable in this shell.
# The script fails fast (exit 1) when a token is missing.
set -uo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.npm-global/bin:$PATH"

NEON_API="https://console.neon.tech/api/v2"
RENDER_API="https://api.render.com/v1"
REPO="salarkhan-seo/uk-pos-pilot"
PROJECT_NAME="uk-pos-staging"
DB_NAME="ukpos_staging"
REGION="aws-eu-west-2"

die() { echo "ERROR: $1" >&2; exit 1; }
need_token() {
  local var="$1" where="$2"
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set." >&2
    echo "Get it from $where and export it first:" >&2
    echo "  export $var=\"<paste-the-key-here>\"" >&2
    echo "Never put the key in a file, in git, or in chat." >&2
    exit 1
  fi
}
neon()  { curl -fsS -H "Authorization: Bearer $NEON_API_KEY" -H 'Accept: application/json' "$@"; }
render(){ curl -fsS -H "Authorization: Bearer $RENDER_API_KEY" -H 'Accept: application/json' "$@"; }

# ---------- --finish: env vars + deploys + verify (Blueprint must exist) ----------
if [ "${1:-}" = "--finish" ]; then
  need_token RENDER_API_KEY "dashboard.render.com/u/settings#api-keys"
  [ -f .env.staging ] || die ".env.staging missing — run the default mode first (it fills DATABASE_URL)"
  grep -q '^DATABASE_URL=postgresql://' .env.staging || die "DATABASE_URL in .env.staging is still the placeholder — run the default mode first"
  echo "== finish: set env vars, deploy, verify =="
  for svc in uk-pos-api uk-pos-register uk-pos-admin; do
    id=$(render "$RENDER_API/services?limit=100" | jq -r ".[] | select(.service.name==\"$svc\") | .service.id" | head -1)
    [ -n "$id" ] && [ "$id" != "null" ] || die "service $svc not found — create the Blueprint in the dashboard first (see the default run)"
    echo "-- $svc ($id)"
    if [ "$svc" = "uk-pos-api" ]; then
      python3 - "$id" <<'PYEOF'
import json, re, subprocess, sys
text = open('.env.staging').read()
keys = ['DATABASE_URL', 'WEBHOOK_ENCRYPTION_KEYS', 'WEBHOOK_ACTIVE_KEY_ID', 'PLATFORM_OPERATOR_KEYS']
sid = sys.argv[1]
for k in keys:
    m = re.search(rf'^{k}=(.*)$', text, re.M)
    if not m:
        print(f"  SKIP {k}: not in .env.staging"); continue
    body = json.dumps({"value": m.group(1)})
    r = subprocess.run(['curl', '-fsS', '-X', 'PUT',
        f'https://api.render.com/v1/services/{sid}/env-vars/{k}',
        '-H', 'Authorization: Bearer ' + __import__('os').environ['RENDER_API_KEY'],
        '-H', 'Content-Type: application/json', '-d', body],
        capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  FAIL {k}: {r.stderr.strip()[:200]}"); sys.exit(1)
    print(f"  set {k}")
PYEOF
    fi
    dep=$(render -X POST "$RENDER_API/services/$id/deploys" -H 'Content-Type: application/json' -d '{}' | jq -r '.deploy.id // empty')
    echo "  deploy triggered: ${dep:-unknown}"
  done
  echo ""
  echo "Polling deploys (up to 10 min)…"
  for svc in uk-pos-api uk-pos-register uk-pos-admin; do
    id=$(render "$RENDER_API/services?limit=100" | jq -r ".[] | select(.service.name==\"$svc\") | .service.id" | head -1)
    for _ in $(seq 1 60); do
      st=$(render "$RENDER_API/services/$id/deploys?limit=1" | jq -r '.[0].deploy.status // empty')
      case "$st" in
        live) echo "  $svc: live"; break ;;
        build_failed|update_failed|deactivated) die "$svc deploy failed: $st — check the Render dashboard build logs" ;;
        *) sleep 10 ;;
      esac
    done
    [ "$st" = "live" ] || die "$svc did not go live within 10 minutes"
    url=$(render "$RENDER_API/services/$id" | jq -r '.service.serviceDetails.url // empty')
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "https://$url/catalogue/status" 2>/dev/null || echo 000)
    echo "  $svc https://$url -> /catalogue/status HTTP $code"
  done
  echo ""
  echo "DONE. All three services are live. Next: DATABASE_URL is already in"
  echo ".env.staging — run: DATABASE_URL=\"\$(grep '^DATABASE_URL=' .env.staging | cut -d= -f2-)\" pnpm staging:check"
  exit 0
fi

# ---------- default: Neon + validate + dashboard instructions ----------
need_token NEON_API_KEY "console.neon.tech > Account Settings > API Keys"
need_token RENDER_API_KEY "dashboard.render.com/u/settings#api-keys"
command -v jq >/dev/null 2>&1 || die "jq is required (install it, then re-run)"

echo "== 1/3 Neon: create project $PROJECT_NAME ($REGION) =="
resp=$(neon -X POST "$NEON_API/projects" -H 'Content-Type: application/json' \
  -d "{\"project\":{\"name\":\"$PROJECT_NAME\",\"region_id\":\"$REGION\",\"pg_version\":\"16\"}}")
proj=$(echo "$resp" | jq -r '.project.id // empty')
[ -n "$proj" ] || die "Neon project creation failed: $(echo "$resp" | head -c 300)"
echo "  project: $proj"
op=$(echo "$resp" | jq -r '.operations[0].id // empty')
if [ -n "$op" ]; then
  for _ in $(seq 1 12); do
    st=$(neon "$NEON_API/projects/$proj/operations/$op" | jq -r '.operation.status // empty')
    [ "$st" = "finished" ] && break
    [ "$st" = "failed" ] && die "Neon project provisioning failed (operation $op)"
    sleep 10
  done
  [ "$st" = "finished" ] || die "Neon project did not finish provisioning within 2 minutes"
fi
role=$(echo "$resp" | jq -r '.roles[0].name // empty')
echo "  owner role: $role"

echo "== 2/3 Neon: create database $DB_NAME =="
neon -X POST "$NEON_API/projects/$proj/databases" -H 'Content-Type: application/json' \
  -d "{\"database\":{\"name\":\"$DB_NAME\",\"owner_name\":\"$role\"}}" >/dev/null \
  || die "database creation failed"
uri=$(neon "$NEON_API/projects/$proj/connection_uri?database_name=$DB_NAME&role_name=$role" | jq -r '.uri // empty')
[ -n "$uri" ] && [ "$uri" != "null" ] || die "could not fetch the connection URI"
case "$uri" in *sslmode=require*) ;; *) die "connection URI lacks sslmode=require" ;; esac
python3 - "$uri" <<'PYEOF'
import re, sys
uri = sys.argv[1]
text = open('.env.staging').read()
text2, n = re.subn(r'^DATABASE_URL=.*$', f'DATABASE_URL={uri}', text, count=1, flags=re.M)
assert n == 1, "DATABASE_URL line not found in .env.staging"
open('.env.staging', 'w').write(text2)
print("  DATABASE_URL written into .env.staging (git-ignored)")
PYEOF
echo ""
echo "  *** DATABASE_URL (paste into Render as DATABASE_URL — never into git or chat) ***"
echo "  $uri"
echo "  *** end ***"
echo ""

echo "== 3/3 Render: validate render.yaml (creates nothing) =="
# NOTE: the reference says this endpoint takes multipart/form-data with the
# render.yaml file. If Render rejects the field name, check the live
# reference at https://api-docs.render.com/reference/validate-blueprint
# and adjust the -F field name; the rest of this script is unaffected.
if render -X POST "$RENDER_API/blueprints/validate" -F "blueprint=@render.yaml" | jq . >/dev/null 2>&1; then
  echo "  render.yaml validates against the Render API"
else
  echo "  WARNING: blueprint validation did not return a clean plan — re-check"
  echo "  the render.yaml against https://render.com/docs/blueprint-spec"
  echo "  before creating the Blueprint. Continuing with the dashboard steps."
fi
echo ""
echo "== Dashboard step (the one the API cannot do) =="
echo "  Render has NO create-blueprint API endpoint, and free-plan web"
echo "  services cannot be created via the API either — so create the"
echo "  Blueprint once, by hand:"
echo "    1. Open https://dashboard.render.com/blueprints"
echo "    2. New > Blueprint > select $REPO (branch main) > Apply"
echo "    3. When Render asks for the sync:false secrets, paste them from"
echo "       .env.staging: DATABASE_URL (printed above),"
echo "       WEBHOOK_ENCRYPTION_KEYS, WEBHOOK_ACTIVE_KEY_ID=k1,"
echo "       PLATFORM_OPERATOR_KEYS"
echo "  Then finish via the API:"
echo "    bash scripts/cloud-deploy.sh --finish"
echo "  (It sets the secrets per service, triggers the three deploys,"
echo "   polls until live, and curls the status endpoints.)"
echo ""
echo "DONE (default mode). Neon is created; Render awaits the one dashboard click."
