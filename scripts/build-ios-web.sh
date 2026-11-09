#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/generate-bridge-protocol.mjs
pnpm build
mkdir -p apps/ios/Resources/Web
rsync -a --delete apps/shared-ui/dist/ apps/ios/Resources/Web/
# Settings → About shows this, so a tester can tell which commit is installed.
stamp=$(git rev-parse --short HEAD)
[ -n "$(git status --porcelain --untracked-files=no)" ] && stamp="$stamp-dirty"
printf '%s\n' "$stamp" > apps/ios/Resources/Web/build-stamp.txt
