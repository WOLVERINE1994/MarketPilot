#!/usr/bin/env bash
# MarketPilot one-command server install (Ubuntu 22.04 / 24.04).
#   curl -fsSL https://raw.githubusercontent.com/WOLVERINE1994/MarketPilot/main/deploy/install.sh | sudo bash
# Re-running it is safe: it updates the code and keeps your .env and data.
set -euo pipefail
REPO="${MARKETPILOT_REPO:-https://github.com/WOLVERINE1994/MarketPilot.git}"
BRANCH="${MARKETPILOT_BRANCH:-main}"
DIR=/opt/marketpilot
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
# Read answers from the keyboard even when this script is piped from curl.
exec 3</dev/tty || { echo "Run this in an interactive terminal (SSH session)."; exit 1; }
ask() { local prompt="$1" var; read -r -u 3 -p "$prompt" var; echo "$var"; }
ask_secret() { local prompt="$1" var; read -r -s -u 3 -p "$prompt" var; echo >&2; echo "$var"; }

echo "==> Installing system packages and Node.js 22"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
timedatectl set-timezone Asia/Kolkata 2>/dev/null || true
# Angel One's instrument list is a large file; small servers get a swap file so loading it never runs out of memory.
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 1500000 ] && ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi
echo "    node $(node -v)"

echo "==> Getting MarketPilot ($BRANCH)"
id marketpilot >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/marketpilot --shell /usr/sbin/nologin marketpilot
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$DIR"
fi
mkdir -p "$DIR/data"

if [ ! -f "$DIR/.env" ]; then
  echo "==> Your settings (stored only on this server in $DIR/.env)"
  cp "$DIR/.env.example" "$DIR/.env"
  set_env() { local key="$1" value="$2"; value="${value//\\/\\\\}"; value="${value//&/\\&}"; value="${value//|/\\|}"; sed -i "s|^$key=.*|$key=$value|" "$DIR/.env"; }
  set_env ANGEL_API_KEY "$(ask 'Angel One SmartAPI key: ')"
  set_env ANGEL_CLIENT_CODE "$(ask 'Angel One client code: ')"
  set_env ANGEL_PIN "$(ask_secret 'Angel One PIN (hidden): ')"
  echo "The TOTP secret lets the server log in by itself every day (required on a server)."
  set_env ANGEL_TOTP_SECRET "$(ask_secret 'Angel One TOTP secret (hidden): ')"
  set_env TELEGRAM_BOT_TOKEN "$(ask 'Telegram bot token (Enter to skip): ')"
  set_env TELEGRAM_CHAT_ID "$(ask 'Telegram chat id (Enter to skip): ')"
  while :; do pw="$(ask_secret 'Choose a dashboard password (min 8 characters, hidden): ')"; [ ${#pw} -ge 8 ] && break; echo "Too short."; done
  set_env DASHBOARD_PASSWORD "$pw"
  set_env HOST "127.0.0.1"
  set_env DAILY_RESTART "08:45"
else
  echo "==> Keeping existing $DIR/.env"
fi
chown -R marketpilot:marketpilot "$DIR"
chmod 600 "$DIR/.env"

echo "==> Checking the Angel One login"
if runuser -u marketpilot -- bash -c "cd $DIR && node src/main.js --check"; then echo "    login OK"; else echo "    !! Login check failed — fix $DIR/.env (sudo nano $DIR/.env) and run: sudo systemctl restart marketpilot"; fi

echo "==> Starting the MarketPilot service"
cp "$DIR/deploy/marketpilot.service" /etc/systemd/system/marketpilot.service
systemctl daemon-reload
systemctl enable --now marketpilot >/dev/null
systemctl restart marketpilot

echo "==> Private HTTPS access for your phone (Tailscale)"
if ! command -v tailscale >/dev/null; then curl -fsSL https://tailscale.com/install.sh | sh >/dev/null; fi
if ! tailscale status >/dev/null 2>&1; then
  echo "Open the link below and sign in with the SAME account you use in the Tailscale phone app:"
  tailscale up
fi
tailscale serve --bg 3100 >/dev/null
URL="$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("https://"+j.Self.DNSName.replace(/\.$/,""))})')"
echo
echo "✅ MarketPilot is running."
echo "   Phone: install Tailscale, sign in, then open  $URL"
echo "   In Chrome tap ⋮ → 'Add to Home screen' (or the Install app button) to get the app icon."
echo "   Logs:    sudo journalctl -u marketpilot -f"
echo "   Update:  sudo bash $DIR/deploy/install.sh"
