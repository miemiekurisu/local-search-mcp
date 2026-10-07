#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUMBER="${DISPLAY:-:99}"
SCREEN_GEOMETRY="${LOCAL_SEARCH_SCREEN_GEOMETRY:-1920x1080x24}"
VNC_PORT="${LOCAL_SEARCH_VNC_PORT:-5900}"
NOVNC_PORT="${LOCAL_SEARCH_NOVNC_PORT:-6080}"
VNC_LISTEN="${LOCAL_SEARCH_VNC_LISTEN:-0.0.0.0}"
# 0.0.0.0 / :: are listen-only wildcards: they are not something you can dial, so
# the websocket proxy connects to loopback in that (default) case.
VNC_TARGET="${VNC_LISTEN}"
if [[ "${VNC_TARGET}" == "0.0.0.0" || "${VNC_TARGET}" == "::" ]]; then
  VNC_TARGET="127.0.0.1"
fi
VISIBLE_BROWSER_CDP_PORT="${VISIBLE_BROWSER_CDP_PORT:-9224}"
NOVNC_PASSWORD="${NOVNC_PASSWORD:-}"
VISIBLE_BROWSER_PROFILE_DIR="${VISIBLE_BROWSER_PROFILE_DIR:-/data/browser-profile}"
VISIBLE_BROWSER_START_URL="${VISIBLE_BROWSER_START_URL:-https://chatgpt.com/auth/login}"
VISIBLE_BROWSER_PROXY_SERVER="${VISIBLE_BROWSER_PROXY_SERVER:-}"
# Hosts to bypass the visible-browser proxy (comma-separated, Chromium syntax).
# Per-site bypass lets engines like DeepSeek (domestic, no proxy needed) connect
# directly while others (Google/Bing) still go through VISIBLE_BROWSER_PROXY_SERVER.
VISIBLE_BROWSER_PROXY_BYPASS="${VISIBLE_BROWSER_PROXY_BYPASS:-<-loopback>}"
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

# Xvfb has created its listening socket once the display answers, and this image
# ships no X client tools (no xdpyinfo, no xset), so the socket is the readiness
# signal. Without it x11vnc races Xvfb at boot: it cannot open the display, exits
# instead of waiting, and noVNC then loads in the browser forever against a port
# nothing listens on.
X_DISPLAY_NUMBER="${DISPLAY_NUMBER#*:}"
X_DISPLAY_NUMBER="${X_DISPLAY_NUMBER%%.*}"
X_SOCKET="/tmp/.X11-unix/X${X_DISPLAY_NUMBER}"
X_LOCK="/tmp/.X${X_DISPLAY_NUMBER}-lock"

display_is_ready() {
  # The socket appearing is not the same as the server answering: Xvfb creates it a
  # moment before it accepts, and x11vnc gives up rather than waiting. Actually dial
  # it (node is what this container runs the app on, and resolve_chromium_bin below
  # already shells out to it).
  [[ -S "${X_SOCKET}" ]] || return 1
  node -e 'const n=require("net");const s=n.connect(process.argv[1]);s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1))' "${X_SOCKET}" 2>/dev/null
}

wait_for_display() {
  local tries="${1:-60}"
  while (( tries > 0 )); do
    if display_is_ready; then
      return 0
    fi
    sleep 0.5
    tries=$((tries - 1))
  done
  return 1
}

# Logs are truncated rather than appended: both are restarted by the supervisor
# loop below, and a crash loop must not fill the container's /tmp. The pid is
# dropped before either starts because websockify binds with SO_REUSEPORT: a
# restart that assumed the old one was gone would otherwise leave both listening.
drop_vnc_child() {
  kill_if_running "${1:-}"
  wait_if_child "${1:-}"
}

start_x11vnc() {
  drop_vnc_child "${X11VNC_PID}"
  x11vnc \
    -display "${DISPLAY_NUMBER}" \
    -forever \
    -shared \
    -passwd "${NOVNC_PASSWORD}" \
    -rfbport "${VNC_PORT}" \
    -listen "${VNC_LISTEN}" >/tmp/x11vnc.log 2>&1 &
  X11VNC_PID=$!
  echo "[start] x11vnc on :${VNC_PORT} (pid=${X11VNC_PID})" >&2
}

start_websockify() {
  drop_vnc_child "${WEBSOCKIFY_PID}"
  websockify --web=/usr/share/novnc/ \
    "0.0.0.0:${NOVNC_PORT}" "${VNC_TARGET}:${VNC_PORT}" >/tmp/websockify.log 2>&1 &
  WEBSOCKIFY_PID=$!
  echo "[start] noVNC proxy on :${NOVNC_PORT} (pid=${WEBSOCKIFY_PID})" >&2
}

Xvfb "${DISPLAY_NUMBER}" -screen 0 "${SCREEN_GEOMETRY}" -ac >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!

sleep 1

openbox >/tmp/openbox.log 2>&1 &
OPENBOX_PID=$!

# VNC password — required to enable noVNC access
# If NOVNC_PASSWORD is not set, noVNC (websockify) will NOT be started
# This is a security measure: noVNC exposes the full browser session
X11VNC_PID=""
WEBSOCKIFY_PID=""
if [[ -n "${NOVNC_PASSWORD}" ]]; then
  if wait_for_display 60; then
    start_x11vnc
    start_websockify
    echo "[start] noVNC enabled with password protection on :${NOVNC_PORT}"
  else
    # Not fatal: the supervisor loop below starts both as soon as the display answers.
    echo "[start] display ${DISPLAY_NUMBER} is not up yet; noVNC will start later" >&2
  fi
else
  echo "[start] noVNC DISABLED (set NOVNC_PASSWORD env var to enable)"
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
  CHROMIUM_ARGS+=("--proxy-bypass-list=${VISIBLE_BROWSER_PROXY_BYPASS}")
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
    wait_if_child "${XVFB_PID}"
    # This Xvfb is gone, so a lock/socket still sitting under /tmp is stale, and the
    # next Xvfb refuses to start because of it ("Server is already active for
    # display 99") -- which would take Chromium and noVNC down with it for good.
    rm -f "${X_SOCKET}" "${X_LOCK}"
    Xvfb "${DISPLAY_NUMBER}" -screen 0 "${SCREEN_GEOMETRY}" -ac >/tmp/xvfb.log 2>&1 &
    XVFB_PID=$!
    sleep 1
    echo "Xvfb restarted with pid=${XVFB_PID}" >&2
    # The x11vnc that served the old X server has nothing to do with the new one.
    # Drop it; the check below restarts it once the display answers again.
    kill_if_running "${X11VNC_PID}"
    X11VNC_PID=""
  fi

  if ! process_is_alive "${OPENBOX_PID}"; then
    echo "openbox exited; restarting openbox..." >&2
    openbox >/tmp/openbox.log 2>&1 &
    OPENBOX_PID=$!
    echo "openbox restarted with pid=${OPENBOX_PID}" >&2
  fi

  # Both halves of noVNC used to be fire-and-forget: started once at boot and never
  # watched, so one early failure -- or one Xvfb restart -- left the web page loading
  # forever against a port nothing listens on.
  if [[ -n "${NOVNC_PASSWORD}" ]]; then
    if ! process_is_alive "${X11VNC_PID}"; then
      # Only worth trying with a display to attach to; otherwise the Xvfb branch
      # above has to bring it back first.
      if display_is_ready; then
        echo "x11vnc not running; starting it..." >&2
        start_x11vnc
      fi
    fi
    if ! process_is_alive "${WEBSOCKIFY_PID}"; then
      echo "websockify not running; starting it..." >&2
      start_websockify
    fi
  fi

  if ! process_is_alive "${CHROMIUM_SUPERVISOR_PID}"; then
    echo "Chromium supervisor exited; stopping local-search-mcp so Docker can restart it" >&2
    kill_if_running "${APP_PID}"
    shutdown
    exit 1
  fi

  sleep "${SUPERVISOR_CHECK_INTERVAL}" || true
done
