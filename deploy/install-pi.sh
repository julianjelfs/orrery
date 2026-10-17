#!/usr/bin/env bash
# Install (or re-install) Orrery on the Pi. Run it ON the Pi:
#
#   cd ~/orrery && ./deploy/install-pi.sh
#
# Safe to re-run. Orrery keeps no data, so there is nothing to back up. It does not build
# the frontend (that happens on the laptop, via `orrery rebuild`) and it does not
# configure Caddy: one Caddyfile serves every app and it lives in the recipe-for-disaster
# repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(id -un)" = root ] && { echo "run this as your normal user, not root" >&2; exit 1; }

echo "==> backend dependencies"
"$HOME/.local/bin/uv" --version >/dev/null 2>&1 || { echo "uv is not installed: https://astral.sh/uv" >&2; exit 1; }
(cd "$ROOT/backend" && "$HOME/.local/bin/uv" sync -q --no-dev)

echo "==> systemd unit"
sudo cp "$ROOT/deploy/orrery.service" /etc/systemd/system/orrery.service
sudo systemctl daemon-reload
sudo systemctl enable orrery.service >/dev/null
sudo systemctl restart orrery.service

echo "==> waiting for the app"
for _ in $(seq 1 40); do
	curl -sf -m 1 http://127.0.0.1:8050/api/health >/dev/null && break
	sleep 0.5
done
curl -sf -m 3 http://127.0.0.1:8050/api/health >/dev/null \
	|| { echo "the app did not come up; see: sudo journalctl -u orrery -n 50" >&2; exit 1; }

echo
echo "installed."
printf "  app : %s\n" "$(systemctl is-active orrery)"
