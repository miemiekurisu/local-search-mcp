#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUMBER="${DISPLAY:-:99}"
SCREEN_GEOMETRY="${LOCAL_SEARCH_SCREEN_GEOMETRY:-1920x1080x24}"
VNC_PORT="${LOCAL_SEARCH_VNC_PORT:-5900}"
NOVNC_PORT="${LOCAL_SEARCH_NOVNC_PORT:-6080}"
VISIBLE_BROWSER_CDP_PORT="${VISIBLE_BROWSER_CDP_PORT:-9224}"
VISIBLE_BROWSER_PROFILE_DIR="${VISIBLE_BROWSER_PROFILE_DIR:-/data/browser-profile}"
VISIBLE_BROWSER_START_URL="${VISIBLE_BROWSER_START_URL:-https://chatgpt.com/auth/login}"
VISIBLE_BROWSER_PROXY_SERVER="${VISIBLE_BROWSER_PROXY_SERVER:-}"

export DISPLAY="${DISPLAY_NUMBER}"

Xvfb "${DISPLAY_NUMBER}" -screen 0 "${SCREEN_GEOMETRY}" -ac >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!

sleep 1

openbox >/tmp/openbox.log 2>&1 &
OPENBOX_PID=$!

x11vnc \
  -display "${DISPLAY_NUMBER}" \
  -forever \
  -shared \
  -nopw \
  -rfbport "${VNC_PORT}" \
  -listen 0.0.0.0 >/tmp/x11vnc.log 2>&1 &
X11VNC_PID=$!

websockify --web=/usr/share/novnc/ "${NOVNC_PORT}" "localhost:${VNC_PORT}" >/tmp/websockify.log 2>&1 &
WEBSOCKIFY_PID=$!

CHROMIUM_BIN="$(find /ms-playwright -path '*/chrome-linux/chrome' | sort | tail -n 1)"
if [[ -z "${CHROMIUM_BIN}" || ! -x "${CHROMIUM_BIN}" ]]; then
  echo "visible chromium binary not found under /ms-playwright" >&2
  exit 1
fi

mkdir -p "${VISIBLE_BROWSER_PROFILE_DIR}"
rm -f \
  "${VISIBLE_BROWSER_PROFILE_DIR}/SingletonCookie" \
  "${VISIBLE_BROWSER_PROFILE_DIR}/SingletonLock" \
  "${VISIBLE_BROWSER_PROFILE_DIR}/SingletonSocket" \
  "${VISIBLE_BROWSER_PROFILE_DIR}/DevToolsActivePort"

CHROMIUM_ARGS=(
  "--no-first-run"
  "--no-default-browser-check"
  "--disable-dev-shm-usage"
  "--disable-blink-features=AutomationControlled"
  "--disable-infobars"
  "--password-store=basic"
  "--start-maximized"
  "--ozone-platform=x11"
  "--remote-debugging-port=${VISIBLE_BROWSER_CDP_PORT}"
  "--remote-debugging-address=127.0.0.1"
  "--user-data-dir=${VISIBLE_BROWSER_PROFILE_DIR}"
  "--no-sandbox"
  "${VISIBLE_BROWSER_START_URL}"
)

if [[ -n "${VISIBLE_BROWSER_PROXY_SERVER}" ]]; then
  CHROMIUM_ARGS+=("--proxy-server=${VISIBLE_BROWSER_PROXY_SERVER}")
fi

"${CHROMIUM_BIN}" "${CHROMIUM_ARGS[@]}" >/tmp/chromium.log 2>&1 &
CHROMIUM_PID=$!

cleanup() {
  kill "${CHROMIUM_PID}" "${WEBSOCKIFY_PID}" "${X11VNC_PID}" "${OPENBOX_PID}" "${XVFB_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec npm start
