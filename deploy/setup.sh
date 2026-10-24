#!/usr/bin/env bash
# One-step setup for the Deepwater whale data server on an Ubuntu VPS (tested target: Oracle Cloud Free Tier).
#
# Run it on the server, logged in as the normal user (e.g. ubuntu):
#   curl -fsSL https://raw.githubusercontent.com/mezeezain/deepwater/main/deploy/setup.sh | bash
#
# It asks for your DuckDNS subdomain and token (the token is typed hidden), then:
#   1. checks Binance answers from this server
#   2. installs Node 22, git and Caddy
#   3. downloads (or updates) the Deepwater code
#   4. runs the Smart Money probe and saves it to ~/probe.txt
#   5. runs the whale data server as a service that starts on boot
#   6. opens ports 80/443 in the server firewall
#   7. points your DuckDNS name at this server and keeps it updated
#   8. serves the API over HTTPS at https://<name>.duckdns.org
# Safe to run again: each step checks what is already done.
set -euo pipefail

REPO=https://github.com/mezeezain/deepwater.git
APP_DIR="$HOME/deepwater"
PORT=8787
ORIGIN=https://mezeezain.github.io

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m    ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m    ✗ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -ne 0 ] || fail "Run this as your normal user (ubuntu), not root. It uses sudo when needed."
command -v apt-get >/dev/null || fail "This script expects Ubuntu or Debian."

# ---------------------------------------------------------------- inputs
SUB="${1:-}"
TOKEN="${2:-}"
if [ -z "$SUB" ]; then
  read -rp "DuckDNS subdomain (just the name, e.g. deepwater-whales): " SUB </dev/tty
fi
SUB="${SUB%.duckdns.org}"
[ -n "$SUB" ] || fail "A DuckDNS subdomain is required."
if [ -z "$TOKEN" ]; then
  read -rsp "DuckDNS token (hidden while you type/paste): " TOKEN </dev/tty
  echo
fi
[ -n "$TOKEN" ] || fail "The DuckDNS token is required (shown at the top of duckdns.org after you sign in)."
DOMAIN="$SUB.duckdns.org"

# ---------------------------------------------------------------- 1. Binance reachable?
say "Checking that Binance answers from this server"
if curl -fsS --max-time 15 https://fapi.binance.com/fapi/v1/ping >/dev/null; then
  ok "Binance futures API reachable"
else
  fail "Binance did not answer (blocked region or network problem). The whale server can't work from here."
fi

# ---------------------------------------------------------------- 2. packages
say "Installing Node 22, git and firewall tools"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo -E apt-get install -y -qq curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent netfilter-persistent >/dev/null
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo -E apt-get install -y -qq nodejs >/dev/null
fi
ok "Node $(node -v), git $(git --version | awk '{print $3}')"

# ---------------------------------------------------------------- 3. code
say "Getting the Deepwater code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only -q
  ok "Updated $APP_DIR"
else
  git clone -q "$REPO" "$APP_DIR"
  ok "Downloaded to $APP_DIR"
fi

# ---------------------------------------------------------------- 4. probe
say "Probing Binance Smart Money data for BTCUSDT"
if node "$APP_DIR/worker/smartmoney.mjs" --probe BTCUSDT >"$HOME/probe.txt" 2>&1; then
  if grep -q "No whale or smart-trader positions were recognised" "$HOME/probe.txt"; then
    warn "Binance answered, but the whale fields weren't recognised. Send the contents of ~/probe.txt so the parser can be adjusted."
  else
    ok "Whale fields recognised. Full output saved to ~/probe.txt"
  fi
else
  warn "Probe failed: $(tail -n 1 "$HOME/probe.txt"). Saved to ~/probe.txt. Setup will continue."
fi

# ---------------------------------------------------------------- 5. service
say "Running the whale data server as a service"
sudo tee /etc/systemd/system/whales.service >/dev/null <<EOF
[Unit]
Description=Deepwater whale data server
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) worker/smartmoney.mjs
Environment=PORT=$PORT
Environment=ALLOW_ORIGIN=$ORIGIN
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable -q whales
sudo systemctl restart whales
for _ in $(seq 1 15); do
  curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://localhost:$PORT/api/health" >/dev/null || fail "The whale server didn't start. Check: sudo journalctl -u whales -n 50"
ok "Whale server running on port $PORT (logs: sudo journalctl -u whales -f)"

# ---------------------------------------------------------------- 6. firewall
say "Opening ports 80 and 443 in the server firewall"
for p in 80 443; do
  if sudo iptables -C INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT 2>/dev/null; then
    continue
  fi
  # Oracle's Ubuntu image ends INPUT with a REJECT rule; the ACCEPT must come before it.
  REJECT_LINE=$(sudo iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')
  if [ -n "$REJECT_LINE" ]; then
    sudo iptables -I INPUT "$REJECT_LINE" -p tcp --dport "$p" -m state --state NEW -j ACCEPT
  else
    sudo iptables -A INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT
  fi
done
sudo netfilter-persistent save >/dev/null 2>&1 || true
ok "Ports 80 and 443 open (also needed: the ingress rules in Oracle's security list)"

# ---------------------------------------------------------------- 7. DuckDNS
say "Pointing $DOMAIN at this server"
mkdir -p "$HOME/duckdns"
cat >"$HOME/duckdns/update.sh" <<EOF
#!/bin/sh
curl -fsS "https://www.duckdns.org/update?domains=$SUB&token=$TOKEN&ip=" -o "$HOME/duckdns/last.log"
EOF
chmod 700 "$HOME/duckdns/update.sh"
"$HOME/duckdns/update.sh" || true
if [ "$(cat "$HOME/duckdns/last.log" 2>/dev/null)" = "OK" ]; then
  ok "DuckDNS updated"
else
  fail "DuckDNS said '$(cat "$HOME/duckdns/last.log" 2>/dev/null)'. Check the subdomain and token, then run this script again."
fi
# A new server has no crontab yet (crontab -l exits 1) and grep -v exits 1 on empty input;
# neither is an error here, so don't let set -e / pipefail stop the script.
CRON_LINE="*/5 * * * * $HOME/duckdns/update.sh >/dev/null 2>&1"
EXISTING=$(crontab -l 2>/dev/null | grep -v duckdns/update.sh || true)
printf '%s\n%s\n' "$EXISTING" "$CRON_LINE" | sed '/^$/d' | crontab -
ok "DuckDNS kept up to date every 5 minutes"

# ---------------------------------------------------------------- 8. HTTPS
say "Setting up HTTPS with Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo -E apt-get install -y -qq caddy >/dev/null
fi
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
  reverse_proxy localhost:$PORT
}
EOF
sudo systemctl restart caddy
ok "Caddy configured for $DOMAIN"

say "Waiting for the HTTPS certificate (up to 2 minutes)"
HTTPS_OK=0
for _ in $(seq 1 24); do
  if curl -fsS --max-time 10 "https://$DOMAIN/api/health" >/dev/null 2>&1; then
    HTTPS_OK=1
    break
  fi
  sleep 5
done

echo
if [ "$HTTPS_OK" = 1 ]; then
  ok "https://$DOMAIN/api/health answers"
  printf '\n\033[1mDone.\033[0m On your site, open Whales → Whale data, paste:\n\n    https://%s\n\nand tap Connect.\n' "$DOMAIN"
else
  warn "HTTPS isn't answering yet. Most likely ports 80/443 aren't open in Oracle's security list,"
  warn "or DuckDNS hasn't updated yet. Fix that, then check: sudo journalctl -u caddy -n 30"
fi
printf '\nProbe result (send this to Claude):\n----------------------------------------\n'
head -c 4000 "$HOME/probe.txt"
printf '\n----------------------------------------\n'
