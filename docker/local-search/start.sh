#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUMBER="${DISPLAY:-:99}"
SCREEN_GEOMETRY="${LOCAL_SEARCH_SCREEN_GEOMETRY:-1920x1080x24}"
VNC_PORT="${LOCAL_SEARCH_VNC_PORT:-5900}"
NOVNC_PORT="${LOCAL_SEARCH_NOVNC_PORT:-6080}"
VNC_LISTEN="${LOCAL_SEARCH_VNC_LISTEN:-0.0.0.0}"
VISIBLE_BROWSER_CDP_PORT="${VISIBLE_BROWSER_CDP_PORT:-9224}"
NOVNC_PASSWORD="${NOVNC_PASSWORD:-}"
VISIBLE_BROWSER_PROFILE_DIR="${VISIBLE_BROWSER_PROFILE_DIR:-/data/browser-profile}"
VISIBLE_BROWSER_START_URL="${VISIBLE_BROWSER_START_URL:-https://chatgpt.com/auth/login}"
VISIBLE_BROWSER_PROXY_SERVER="${VISIBLE_BROWSER_PROXY_SERVER:-}"
VISIBLE_BROWSER_RESTART_DELAY="${VISIBLE_BROWSER_RESTART_DELAY:-2}"
SUPERVISOR_CHECK_INTERVAL="${LOCAL_SEARCH_SUPERVISOR_CHECK_INTERVAL:-2}"

export DISPLAY="${DISPLAY_NUMBER}"

APP_PID=""
CHROMIUM_SUPERVISOR_PID=""
SHUTTING_DOWN=0

kill_if_running() {
  local pid="${1:-}"
  if [[ -n "${pid}" ]]; then
    kill "${pid}" 2>/dev/null || true
  fi
}

wait_if_child() {
  local pid="${1:-}"
  if [[ -n "${pid}" ]]; then
    wait "${pid}" 2>/dev/null || true
  fi
}

process_is_alive() {
  local pid="${1:-}"
  local stat=""
  if [[ -z "${pid}" ]]; then
    return 1
  fi
  stat="$(ps -p "${pid}" -o stat= 2>/dev/null || true)"
  [[ -n "${stat}" && "${stat}" != Z* ]]
}

Xvfb "${DISPLAY_NUMBER}" -screen 0 "${SCREEN_GEOMETRY}" -ac >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!

sleep 1

openbox >/tmp/openbox.log 2>&1 &
OPENBOX_PID=$!

# VNC password — required to enable noVNC access
# If NOVNC_PASSWORD is not set, noVNC (websockify) will NOT be started
# This is a security measure: noVNC exposes the full browser session
if [[ -n "${NOVNC_PASSWORD}" ]]; then
  x11vnc \
    -display "${DISPLAY_NUMBER}" \
    -forever \
    -shared \
    -passwd "${NOVNC_PASSWORD}" \
    -rfbport "${VNC_PORT}" \
    -listen "0.0.0.0" >/tmp/x11vnc.log 2>&1 &
  X11VNC_PID=$!

  websockify --web=/usr/share/novnc/ \
    --vncpasswd "${NOVNC_PASSWORD}" \
    "0.0.0.0:${NOVNC_PORT}" "0.0.0.0:${VNC_PORT}" >/tmp/websockify.log 2>&1 &
  WEBSOCKIFY_PID=$!

  echo "[start] noVNC enabled with password protection on :${NOVNC_PORT}"
else
  echo "[start] noVNC DISABLED (set NOVNC_PASSWORD env var to enable)"
  X11VNC_PID=""
  WEBSOCKIFY_PID=""
fi


find_playwright_chromium() {
  local root="${1:-}"
  if [[ -z "${root}" || ! -d "${root}" ]]; then
    return 1
  fi
  find "${root}" \( -type f -o -type l \) \( \
    -path '*/chrome-linux64/chrome' -o \
    -path '*/chrome-linux/chrome' \
  \) | sort | tail -n 1
}

resolve_chromium_bin() {
  local candidate=""
  local root=""

  if [[ -n "${CHROME_BIN:-}" ]]; then
    if [[ -x "${CHROME_BIN}" ]]; then
      printf '%s\n' "${CHROME_BIN}"
      return 0
    fi
    echo "CHROME_BIN is set but not executable: ${CHROME_BIN}" >&2
  fi

  candidate="$(node -e "try { const { chromium } = require('playwright'); const p = chromium.executablePath(); if (p) process.stdout.write(p); } catch (_) {}" 2>/dev/null || true)"
  if [[ -n "${candidate}" && -x "${candidate}" ]]; then
    printf '%s\n' "${candidate}"
    return 0
  fi

  for root in "${PLAYWRIGHT_BROWSERS_PATH:-}" /ms-playwright "${HOME:-/root}/.cache/ms-playwright" /root/.cache/ms-playwright; do
    candidate="$(find_playwright_chromium "${root}" || true)"
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  for candidate in chromium chromium-browser google-chrome google-chrome-stable chrome; do
    candidate="$(command -v "${candidate}" 2>/dev/null || true)"
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  return 1
}

print_browser_candidates() {
  local root=""
  echo "Tried CHROME_BIN=${CHROME_BIN:-<unset>}, Playwright chromium.executablePath(), PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-<unset>}, and common browser commands." >&2
  for root in "${PLAYWRIGHT_BROWSERS_PATH:-}" /ms-playwright "${HOME:-/root}/.cache/ms-playwright" /root/.cache/ms-playwright; do
    if [[ -d "${root}" ]]; then
      echo "Existing browser files under ${root}:" >&2
      find "${root}" -maxdepth 6 \( -type f -o -type l \) \( -name chrome -o -name chromium -o -name headless_shell \) -print >&2 || true
    fi
  done
}

CHROMIUM_BIN="$(resolve_chromium_bin || true)"

if [[ -z "${CHROMIUM_BIN}" || ! -x "${CHROMIUM_BIN}" ]]; then
  echo "visible chromium binary not found" >&2
  print_browser_candidates
  exit 1
fi

echo "Using visible Chromium: ${CHROMIUM_BIN}"

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
)

UBLOCK_DIR="/app/extensions/ublock-origin"
if [ -d "${UBLOCK_DIR}" ]; then
  CHROMIUM_ARGS+=("--disable-extensions-except=${UBLOCK_DIR}")
  CHROMIUM_ARGS+=("--load-extension=${UBLOCK_DIR}")
fi

CHROMIUM_ARGS+=("${VISIBLE_BROWSER_START_URL}")

if [[ -n "${VISIBLE_BROWSER_PROXY_SERVER}" ]]; then
  CHROMIUM_ARGS+=("--proxy-server=${VISIBLE_BROWSER_PROXY_SERVER}")
  CHROMIUM_ARGS+=("--proxy-bypass-list=<-loopback>")
fi

cleanup_browser_profile_locks() {
  mkdir -p "${VISIBLE_BROWSER_PROFILE_DIR}"
  rm -f \
    "${VISIBLE_BROWSER_PROFILE_DIR}/SingletonCookie" \
    "${VISIBLE_BROWSER_PROFILE_DIR}/SingletonLock" \
    "${VISIBLE_BROWSER_PROFILE_DIR}/SingletonSocket" \
    "${VISIBLE_BROWSER_PROFILE_DIR}/DevToolsActivePort"
}

launch_visible_chromium() {
  cleanup_browser_profile_locks
  "${CHROMIUM_BIN}" "${CHROMIUM_ARGS[@]}" >/tmp/chromium.log 2>&1 &
  CHROMIUM_PID=$!
  echo "Started visible Chromium pid=${CHROMIUM_PID}"
}

supervise_visible_chromium() {
  local CHROMIUM_PID=""
  local status=0

  stop_visible_chromium() {
    kill_if_running "${CHROMIUM_PID}"
    wait_if_child "${CHROMIUM_PID}"
    exit 0
  }
  trap stop_visible_chromium TERM INT

  while true; do
    launch_visible_chromium
    if wait "${CHROMIUM_PID}"; then
      status=0
    else
      status=$?
    fi
    CHROMIUM_PID=""
    echo "Visible Chromium exited with status ${status}; restarting in ${VISIBLE_BROWSER_RESTART_DELAY}s" >&2
    sleep "${VISIBLE_BROWSER_RESTART_DELAY}" || true
  done
}

shutdown() {
  if [[ "${SHUTTING_DOWN}" == "1" ]]; then
    return
  fi
  SHUTTING_DOWN=1
  kill_if_running "${APP_PID}"
  kill_if_running "${CHROMIUM_SUPERVISOR_PID}"
  kill_if_running "${WEBSOCKIFY_PID}"
  kill_if_running "${X11VNC_PID}"
  kill_if_running "${OPENBOX_PID}"
  kill_if_running "${XVFB_PID}"
  wait_if_child "${APP_PID}"
  wait_if_child "${CHROMIUM_SUPERVISOR_PID}"
  wait_if_child "${WEBSOCKIFY_PID}"
  wait_if_child "${X11VNC_PID}"
  wait_if_child "${OPENBOX_PID}"
  wait_if_child "${XVFB_PID}"
}

trap 'shutdown; exit 143' TERM INT

supervise_visible_chromium &
CHROMIUM_SUPERVISOR_PID=$!

npm start &
APP_PID=$!

while true; do
  if ! process_is_alive "${APP_PID}"; then
    set +e
    wait "${APP_PID}"
    APP_STATUS=$?
    set -e
    shutdown
    exit "${APP_STATUS}"
  fi

  if ! process_is_alive "${XVFB_PID}"; then
    echo "Xvfb exited; restarting Xvfb..." >&2
    Xvfb "${DISPLAY_NUMBER}" -screen 0 "${SCREEN_GEOMETRY}" -ac >/tmp/xvfb.log 2>&1 &
    XVFB_PID=$!
    sleep 1
    echo "Xvfb restarted with pid=${XVFB_PID}" >&2
  fi

  if ! process_is_alive "${OPENBOX_PID}"; then
    echo "openbox exited; restarting openbox..." >&2
    openbox >/tmp/openbox.log 2>&1 &
    OPENBOX_PID=$!
    echo "openbox restarted with pid=${OPENBOX_PID}" >&2
  fi

  if ! process_is_alive "${CHROMIUM_SUPERVISOR_PID}"; then
    echo "Chromium supervisor exited; stopping local-search-mcp so Docker can restart it" >&2
    kill_if_running "${APP_PID}"
    shutdown
    exit 1
  fi

  sleep "${SUPERVISOR_CHECK_INTERVAL}" || true
done
