#!/usr/bin/env bash
# deploy.sh — Deploy Mediant Python worker to Modal and wire it into Supabase.
# Run from the project root: bash modal_worker/deploy.sh
set -euo pipefail

MODAL_BIN="$HOME/Library/Python/3.13/bin/modal"
SUPABASE_REF=$(cat supabase/.temp/project-ref 2>/dev/null || echo "")

# ── 1. Authenticate Modal ──────────────────────────────────────────────────
echo "==> Checking Modal auth..."
if ! $MODAL_BIN profile list 2>&1 | grep -q "│"; then
  echo "    Not authenticated. Opening browser for Modal login..."
  $MODAL_BIN token new
  echo "    Authenticated. Continuing..."
else
  echo "    Already authenticated."
fi

# ── 2. Deploy the worker ───────────────────────────────────────────────────
echo "==> Deploying mediant-worker to Modal..."
$MODAL_BIN deploy modal_worker/worker.py

# ── 3. Get the deployed URL ────────────────────────────────────────────────
echo ""
echo "==> Deployed. Get the endpoint URL from the Modal dashboard:"
echo "    https://modal.com/apps/mbwmatthew-ux/main/deployed/mediant-worker"
echo ""
echo "    Current URL: https://mbwmatthew-ux--mediant-worker-analyze.modal.run"
echo ""

# ── 4. Set the URL as a Supabase secret ───────────────────────────────────
if [ -n "$SUPABASE_REF" ]; then
  read -r -p "Paste the Modal endpoint URL here (or press Enter to skip): " MODAL_URL
  if [ -n "$MODAL_URL" ]; then
    echo "==> Setting MODAL_WORKER_URL in Supabase secrets..."
    npx supabase secrets set MODAL_WORKER_URL="$MODAL_URL" --project-ref "$SUPABASE_REF"
    echo "    Done. The pipeline will now use the Modal measurement worker (CREPE + librosa + music21)."
  else
    echo "    Skipped. Set it later with:"
    echo "    npx supabase secrets set MODAL_WORKER_URL='<url>' --project-ref $SUPABASE_REF"
  fi
else
  echo "    Could not read Supabase project ref. Set the secret manually:"
  echo "    npx supabase secrets set MODAL_WORKER_URL='<url>' --project-ref <your-ref>"
fi
