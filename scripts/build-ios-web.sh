#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm build
mkdir -p apps/ios/Resources/Web
rsync -a --delete apps/shared-ui/dist/ apps/ios/Resources/Web/
