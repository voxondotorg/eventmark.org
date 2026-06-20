#!/usr/bin/env bash
# Install repo git hooks (strip Cursor co-author, block bad pushes).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_SRC="$ROOT/scripts/git-hooks"
GIT_HOOKS="$ROOT/.git/hooks"

if [[ ! -d "$GIT_HOOKS" ]]; then
  echo "Not a git repo: $ROOT"
  exit 1
fi

for hook in prepare-commit-msg commit-msg pre-push; do
  cp "$HOOK_SRC/$hook" "$GIT_HOOKS/$hook"
  chmod +x "$GIT_HOOKS/$hook"
  echo "Installed .git/hooks/$hook"
done

echo "Done. Git hooks installed for clean commit messages."
