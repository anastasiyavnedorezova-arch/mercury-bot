#!/bin/bash
# Обновление боя: копия базы -> свежий код -> зависимости -> перезапуск
set -euo pipefail
/usr/local/bin/finnik-backup.sh >> /var/log/finnik-backup.log 2>&1
cd /opt/finnik/app
git pull --ff-only
npm ci --omit=dev
systemctl restart finnik
sleep 6
echo "служба: $(systemctl is-active finnik)"
journalctl -u finnik -n 8 --no-pager
