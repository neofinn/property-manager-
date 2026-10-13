#!/usr/bin/env bash
# Starts the app in the background whenever the codespace starts, and makes
# its link public so beta testers can open it. Data is kept in ./data, which
# survives the codespace stopping and starting.
set -u
cd "$(dirname "$0")/.."

if ! pgrep -f "node.*server.js" >/dev/null; then
  nohup npm start > /tmp/property-manager.log 2>&1 &
fi

if [ -n "${CODESPACE_NAME:-}" ]; then
  # Needs the codespace's GitHub login; if it fails, set the port to Public in the Ports tab.
  gh codespace ports visibility 3000:public -c "$CODESPACE_NAME" >/dev/null 2>&1 || true
  echo "Property Manager: https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
fi
