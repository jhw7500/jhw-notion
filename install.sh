#!/bin/bash
set -euo pipefail
# This check parses on old Node as well, before loading modern deployment ESM.
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
  printf '%s\n' '{"error":{"code":"DEPLOY_NODE_UNSUPPORTED"}}'
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/scripts/runtime-deploy.mjs" "$@"
