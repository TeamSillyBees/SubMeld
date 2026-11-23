#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" 2>/dev/null; then
  echo "请先安装 Node.js 24 或更高版本，再启动探针。" >&2
  exit 1
fi
if ! node -e "for (const [name,version] of Object.entries(require('./package.json').dependencies)) { require(name); if (require(name + '/package.json').version !== version) process.exit(1) }" >/dev/null 2>&1; then
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
fi
exec node agent/main.ts "$@"
