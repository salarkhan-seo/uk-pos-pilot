#!/usr/bin/env bash
# UK POS pilot — deploy readiness pre-flight (FULL-AUTO-CLOUD, 17 Nov 2026).
#
# Read-only. Checks everything that can be checked locally before the
# cloud steps, and names the one thing that cannot be done from here.
# It never prints a secret value, never writes to the repo, and never
# touches a live database — when DATABASE_URL is real it only prints
# the staging:check command for the owner to run.
#
#   bash scripts/deploy-readiness.sh
#
# Exit codes: 0 = ready (DATABASE_URL is real — run pnpm staging:check);
# 2 = structurally ready but DATABASE_URL is still the placeholder in
# .env.staging (waiting on the owner to create the Neon/Supabase
# database in eu-west-2); 1 = a structural check failed.
set -uo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.npm-global/bin:$PATH"

FAIL=0
WARN_DB=0
say() { printf '%s\n' "$1"; }
ok()   { say "  PASS  $1"; }
bad()  { say "  FAIL  $1"; FAIL=1; }

say "== deploy-readiness: UK POS pilot =="
say ""
say "[1/5] tooling"
command -v node >/dev/null 2>&1 && ok "node $(node --version)" || bad "node not found"
command -v pnpm >/dev/null 2>&1 && ok "pnpm $(pnpm --version)" || bad "pnpm not found (needs ~/.npm-global/bin on PATH)"
command -v python3 >/dev/null 2>&1 && ok "python3 present" || bad "python3 not found"
command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" || bad "git not found"

say ""
say "[2/5] repo state"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  ok "inside a git repo ($(git rev-parse --abbrev-ref HEAD))"
else
  bad "not inside a git repo"; say ""; say "RESULT: not ready (exit 1)"; exit 1
fi
if [ -z "$(git status --porcelain)" ]; then ok "working tree clean"; else bad "working tree has uncommitted changes"; fi
if git remote get-url origin >/dev/null 2>&1; then
  ok "origin: $(git remote get-url origin)"
  LOCAL_HEAD=$(git rev-parse HEAD)
  REMOTE_HEAD=$(git ls-remote origin HEAD 2>/dev/null | awk '{print $1}')
  if [ -n "$REMOTE_HEAD" ] && [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
    ok "local HEAD == origin/main ($LOCAL_HEAD)"
  else
    bad "local HEAD ($LOCAL_HEAD) != origin/main ($REMOTE_HEAD)"
  fi
else
  bad "no origin remote set"
fi

say ""
say "[3/5] render.yaml"
for svc in uk-pos-api uk-pos-register uk-pos-admin; do
  grep -q "name: $svc" render.yaml && ok "service $svc present" || bad "service $svc missing from render.yaml"
done
for key in DATABASE_URL WEBHOOK_ENCRYPTION_KEYS WEBHOOK_ACTIVE_KEY_ID PLATFORM_OPERATOR_KEYS; do
  if grep -A1 "key: $key" render.yaml | grep -q 'sync: false'; then
    ok "$key is sync:false (dashboard-filled)"
  else
    bad "$key is not marked sync:false in render.yaml"
  fi
done

say ""
say "[4/5] .env.staging (values never printed)"
if [ -f .env.staging ]; then
  ok ".env.staging exists"
else
  bad ".env.staging missing — run ENV-FILE-GEN first"; say ""; say "RESULT: not ready (exit 1)"; exit 1
fi
if git check-ignore -q .env.staging; then ok ".env.staging is git-ignored (never committed)"; else bad ".env.staging is NOT ignored — do not commit it"; fi
python3 - "$@" <<'PYEOF' || FAIL=1
import json, re, sys
text = open('.env.staging').read()
def check(name, want_ids):
    m = re.search(rf'^{name}=(.*)$', text, re.M)
    if not m:
        print(f"  FAIL  {name} missing"); return False
    try:
        val = json.loads(m.group(1))
    except Exception:
        print(f"  FAIL  {name} is not valid JSON"); return False
    if sorted(val) != sorted(want_ids):
        print(f"  FAIL  {name} ids {sorted(val)} != {sorted(want_ids)}"); return False
    if not all(isinstance(v, str) and re.fullmatch(r'[0-9a-f]{64}', v) for v in val.values()):
        print(f"  FAIL  {name} values are not 64-hex"); return False
    print(f"  PASS  {name}: ids {sorted(val)}, 64-hex values"); return True
ok = True
ok &= check('WEBHOOK_ENCRYPTION_KEYS', ['k1'])
ok &= check('PLATFORM_OPERATOR_KEYS', ['operator-1'])
m = re.search(r'^WEBHOOK_ACTIVE_KEY_ID=(.*)$', text, re.M)
if m and m.group(1) == 'k1':
    print("  PASS  WEBHOOK_ACTIVE_KEY_ID=k1")
else:
    print("  FAIL  WEBHOOK_ACTIVE_KEY_ID is not k1"); ok = False
m = re.search(r'^DATABASE_URL=(.*)$', text, re.M)
if not m:
    print("  FAIL  DATABASE_URL missing"); ok = False
elif '<user>' in m.group(1) or '<password>' in m.group(1):
    print("  WAIT  DATABASE_URL is still the placeholder template")
    open('/tmp/ukpos_db_placeholder', 'w').write('placeholder')
else:
    print("  PASS  DATABASE_URL is set (value not shown)")
sys.exit(0 if ok else 1)
PYEOF
[ -f /tmp/ukpos_db_placeholder ] && WARN_DB=1 && rm -f /tmp/ukpos_db_placeholder

say ""
say "[5/5] staging:check harness"
[ -x scripts/staging-check.sh ] && ok "scripts/staging-check.sh is executable" || bad "scripts/staging-check.sh is not executable"
bash -n scripts/staging-check.sh && ok "scripts/staging-check.sh parses clean" || bad "scripts/staging-check.sh has a syntax error"
grep -q '"staging:check"' package.json && ok "package.json has staging:check" || bad "package.json is missing staging:check"
grep -q '"concurrency:live"' packages/db/package.json && ok "@uk-pos/db has concurrency:live" || bad "@uk-pos/db is missing concurrency:live"

say ""
if [ "$FAIL" -ne 0 ]; then
  say "RESULT: not ready — fix the FAIL items above (exit 1)"
  exit 1
fi
if [ "$WARN_DB" -ne 0 ]; then
  say "RESULT: structurally ready — blocked on ONE item (exit 2)"
  say "  DATABASE_URL is still the placeholder in .env.staging."
  say "  Next (owner, dashboard): create the Neon/Supabase project in"
  say "  eu-west-2, paste its connection string (with ?sslmode=require)"
  say "  into .env.staging and into Render as DATABASE_URL, then run:"
  say "    DATABASE_URL=\"<your-neon-url>\" pnpm staging:check"
  say "  Then: Render Blueprint from render.yaml, fill the dashboard"
  say "  secrets, verify the three *.onrender.com URLs."
  exit 2
fi
say "RESULT: ready — run: pnpm staging:check (exit 0)"
exit 0
