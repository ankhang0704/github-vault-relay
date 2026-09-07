#!/usr/bin/env bash
#
# GitHub Vault Relay - Desktop Local Git Handoff Consumer (Bash)
# Reads git-handoff.json and aligns local .git metadata with GitHub.
#

set -euo pipefail

VAULT_PATH="${1:-.}"
CONFIG_DIR=".obsidian"
HANDOFF_FILE="$VAULT_PATH/$CONFIG_DIR/github-vault-relay/git-handoff.json"

if [ ! -f "$HANDOFF_FILE" ]; then
  echo "[Git Handoff] No git-handoff.json found at $HANDOFF_FILE. Nothing to reconcile."
  exit 0
fi

STATUS=$(node -e "
  try {
    const data = JSON.parse(require('fs').readFileSync('$HANDOFF_FILE', 'utf8'));
    console.log(data.status || 'unknown');
  } catch (e) {
    console.log('invalid');
  }
")

if [ "$STATUS" != "pending" ]; then
  echo "[Git Handoff] Signal status is '$STATUS'. No pending action required."
  exit 0
fi

BRANCH=$(node -e "const data = JSON.parse(require('fs').readFileSync('$HANDOFF_FILE', 'utf8')); console.log(data.branch || 'main');")
COMMIT_SHA=$(node -e "const data = JSON.parse(require('fs').readFileSync('$HANDOFF_FILE', 'utf8')); console.log(data.remoteCommitSha || '');")

if [[ ! "$COMMIT_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "[Git Handoff] Error: Invalid commit SHA format: '$COMMIT_SHA'" >&2
  exit 1
fi

echo "[Git Handoff] Reconciling local .git with remote commit $COMMIT_SHA on branch '$BRANCH'..."

pushd "$VAULT_PATH" > /dev/null

if ! git fetch origin "$BRANCH" --quiet; then
  echo "[Git Handoff] Error: git fetch failed." >&2
  popd > /dev/null
  exit 1
fi

if ! git cat-file -e "$COMMIT_SHA"; then
  echo "[Git Handoff] Error: Commit object $COMMIT_SHA not found after fetch." >&2
  popd > /dev/null
  exit 1
fi

git reset --mixed "$COMMIT_SHA"

node -e "
  const fs = require('fs');
  const file = '$HANDOFF_FILE';
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.status = 'completed';
  data.appliedAt = new Date().toISOString();
  data.lastError = null;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
"

popd > /dev/null
echo "[Git Handoff] Successfully reconciled local .git! Working tree is clean."
