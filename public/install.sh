#!/bin/sh
set -eu

LABEL="in.flent.org-memory"
SERVER="${ORG_MEMORY_URL:-}"
TOKEN="${ORG_MEMORY_TOKEN:-}"
INTERVAL="3600"
UNINSTALL="false"

usage() {
  printf '%s\n' \
    'Org Memory connector installer (macOS)' '' \
    'Usage:' \
    '  install.sh --server https://memory.example.com --token om_...' \
    '  install.sh --server https://memory.example.com --token om_... --interval 1800' \
    '  install.sh --uninstall --server https://memory.example.com' '' \
    'The connector runs as the current user. It does not use sudo.'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  printf '%s\n' 'This installer currently supports macOS only.' >&2
  exit 1
fi

case "$SERVER" in
  http://*|https://*) SERVER="${SERVER%/}" ;;
  *) printf '%s\n' 'A valid --server http(s) URL is required.' >&2; exit 1 ;;
esac
case "$INTERVAL" in *[!0-9]*|'') printf '%s\n' '--interval must be a number of seconds.' >&2; exit 1 ;; esac
if [ "$INTERVAL" -lt 300 ]; then
  printf '%s\n' '--interval must be at least 300 seconds.' >&2
  exit 1
fi

INSTALL_DIR="$HOME/Library/Application Support/OrgMemory"
LOG_DIR="$HOME/Library/Logs/OrgMemory"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNNER="$INSTALL_DIR/run.sh"
CONNECTOR="$INSTALL_DIR/connector.js"
STATE="$INSTALL_DIR/state.json"
ACCOUNT="$(id -un)"
SERVER_HASH="$(printf '%s' "$SERVER" | shasum -a 256 | awk '{print substr($1,1,16)}')"
KEYCHAIN_SERVICE="$LABEL.$SERVER_HASH"
DOMAIN="gui/$(id -u)"

if [ "$UNINSTALL" = "true" ]; then
  launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  security delete-generic-password -a "$ACCOUNT" -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1 || true
  rm -rf "$INSTALL_DIR"
  printf '%s\n' 'Org Memory connector removed. Logs remain in:' "$LOG_DIR"
  exit 0
fi

if [ -z "$TOKEN" ]; then
  printf '%s\n' 'A connector --token is required. Generate the install command from Org Memory.' >&2
  exit 1
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  printf '%s\n' 'Node.js 22 or newer is required. Install Node.js, then run this command again.' >&2
  exit 1
fi
NODE_MAJOR="$($NODE -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  printf 'Node.js 22 or newer is required; found %s.\n' "$($NODE --version)" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$INSTALL_DIR" "$LOG_DIR"
TEMP_CONNECTOR="$(mktemp -t org-memory-connector.XXXXXX)"
trap 'rm -f "$TEMP_CONNECTOR"' EXIT HUP INT TERM
curl -fsSL "$SERVER/downloads/connector.js" -o "$TEMP_CONNECTOR"
$NODE --check "$TEMP_CONNECTOR"
mv "$TEMP_CONNECTOR" "$CONNECTOR"
chmod 600 "$CONNECTOR"

security add-generic-password -U -a "$ACCOUNT" -s "$KEYCHAIN_SERVICE" -w "$TOKEN" >/dev/null

cat > "$RUNNER" <<EOF
#!/bin/sh
set -eu
TOKEN=\$(/usr/bin/security find-generic-password -a '$ACCOUNT' -s '$KEYCHAIN_SERVICE' -w)
export ORG_MEMORY_URL='$SERVER'
export ORG_MEMORY_TOKEN="\$TOKEN"
export ORG_MEMORY_STATE='$STATE'
exec '$NODE' '$CONNECTOR'
EOF
chmod 700 "$RUNNER"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$RUNNER</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_DIR/sync.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/error.log</string>
</dict></plist>
EOF
chmod 600 "$PLIST"
plutil -lint "$PLIST" >/dev/null

launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

printf '%s\n' \
  'Org Memory is installed and the first sync has started.' \
  "Automatic sync interval: $INTERVAL seconds" \
  "Logs: $LOG_DIR" \
  "Status: launchctl print $DOMAIN/$LABEL" \
  "Run now: launchctl kickstart -k $DOMAIN/$LABEL" \
  "Guide: $SERVER/AUTOMATIC_SYNC.md"
