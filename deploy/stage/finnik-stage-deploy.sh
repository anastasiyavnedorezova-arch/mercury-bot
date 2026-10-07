#!/bin/bash
# Выкладка на тестовую среду. Берёт ветку staging (если её нет на GitHub — main).
# Использование: finnik-stage-deploy.sh [ветка]
set -euo pipefail
APP=/opt/finnik-stage/app
cd "$APP"
git fetch --prune origin
BRANCH="${1:-}"
if [ -z "$BRANCH" ]; then
  if git ls-remote --exit-code --heads origin staging >/dev/null 2>&1; then BRANCH=staging; else BRANCH=main; fi
fi
git checkout -q -B "$BRANCH" "origin/$BRANCH"
git reset -q --hard "origin/$BRANCH"
npm ci --omit=dev --silent 2>&1 | grep -v "npm warn" || true
systemctl restart finnik-stage
sleep 4
echo "тест: ветка $BRANCH, коммит $(git rev-parse --short HEAD)"
echo "служба: $(systemctl is-active finnik-stage)"
journalctl -u finnik-stage -n 6 --no-pager
