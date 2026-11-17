#!/usr/bin/env bash
# UK POS pilot — GitHub push setup.
#
# Run this on your own machine (Git Bash on Windows, or Linux/macOS),
# from inside the uk-pos-pilot folder. It signs YOU in to GitHub in your
# own terminal, creates the repo under YOUR account, and pushes.
# It never stores, prints, or asks for any token or password.
set -e
cd "$(dirname "$0")/.."

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is not installed."
  echo "  Windows: winget install GitHub.cli"
  echo "  macOS:   brew install gh"
  echo "  Linux:   see https://github.com/cli/cli#installation"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Signing in to GitHub (interactive — use your own account)..."
  gh auth login
fi

if git remote get-url origin >/dev/null 2>&1; then
  echo "Remote 'origin' already set to: $(git remote get-url origin)"
else
  echo "No remote yet. What should the GitHub repo be called?"
  read -r -p "Repo name [uk-pos-pilot]: " REPO_NAME
  REPO_NAME="${REPO_NAME:-uk-pos-pilot}"
  gh repo create "$REPO_NAME" --public --source=. --remote=origin
fi

echo "Pushing main to origin..."
git push -u origin main

echo
echo "Push verified:"
git ls-remote origin HEAD
echo
echo "Next: Render + Neon (manual dashboards — no CLI exists for these)."
echo "Follow STAGING_DEPLOYMENT_GUIDE.md Steps 2-6: create the Neon/Supabase"
echo "database, link Render via render.yaml, fill the secrets, then verify."
