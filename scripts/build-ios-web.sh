#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm build
mkdir -p apps/ios/Resources/Web
rsync -a --delete dist/ apps/ios/Resources/Web/
