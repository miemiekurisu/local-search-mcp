import net from 'net';

// noVNC is two processes living beside this service inside the container: x11vnc owns the
// RFB port and websockify turns it into the websocket the browser speaks to. Either one can
// die while search keeps working, and the noVNC page still loads because websockify serves
// its static files first -- so a dead VNC looked healthy to everything watching /health.
// Whether those two ports answer is the whole question here, so both are dialled in
// parallel, on a deadline, and the answer is cached and shared between concurrent callers.

function envInt(env, name, fallback, min) {
  const n = Number(env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

// One TCP connect, answered at most once. Reachability is all we ask, so the socket is
// dropped as soon as it speaks; the timer and the socket are released on every path,
// including the one where connect() never answers at all.
export function probeTcpPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    timer = setTimeout(() => finish({ open: false, reason: 'timeout' }), timeoutMs);
    if (timer.unref) timer.unref();
    socket.once('connect', () => finish({ open: true }));
    socket.once('error', (err) => finish({ open: false, reason: (err && err.code) || 'connect_failed' }));
  });
}

export class VncHealth {
  constructor(env = process.env) {
    // Empty NOVNC_PASSWORD means noVNC is off on purpose -- start.sh refuses to launch
    // websockify at all -- so "configured" is the same predicate the entrypoint uses.
    // VNC_HEALTH_CHECK=false is the escape hatch for running this service anywhere the
    // VNC ports are not supposed to exist.
    this.enabled = env.VNC_HEALTH_CHECK !== 'false';
    this.configured = this.enabled && Boolean(env.NOVNC_PASSWORD);
    // The address websockify itself dials, which start.sh exports. LOCAL_SEARCH_VNC_LISTEN
    // is not usable here: it is what x11vnc binds, a wildcard by default, and a wildcard
    // cannot be dialled while a named interface would make loopback a false negative.
    this.host = env.LOCAL_SEARCH_VNC_HEALTH_HOST || '127.0.0.1';
    this.rfbPort = envInt(env, 'LOCAL_SEARCH_VNC_PORT', 5900, 1);
    this.novncPort = envInt(env, 'LOCAL_SEARCH_NOVNC_PORT', 6080, 1);
    this.timeoutMs = envInt(env, 'VNC_HEALTH_TIMEOUT_MS', 500, 50);
    this.cacheMs = envInt(env, 'VNC_HEALTH_CACHE_MS', 1000, 0);
    this.cached = null;
    this.inFlight = null;
  }

  // Shape for /health: { ok, configured, host, rfb, novnc }. It never outlives
  // timeoutMs, because the thing waiting on it is the container healthcheck.
  async status() {
    if (!this.configured) {
      return { configured: false, ok: true, reason: this.enabled ? 'not_configured' : 'disabled' };
    }
    if (this.cached && Date.now() - this.cached.at < this.cacheMs) {
      return this.cached.value;
    }
    if (!this.inFlight) {
      // One probe serves every concurrent caller, so the container healthcheck and an
      // external monitor arriving together pay for one pair of connects, not two.
      this.inFlight = Promise.all([
        probeTcpPort(this.host, this.rfbPort, this.timeoutMs),
        probeTcpPort(this.host, this.novncPort, this.timeoutMs)
      ]).then(([rfb, novnc]) => {
        const value = {
          configured: true,
          host: this.host,
          rfb: { port: this.rfbPort, open: rfb.open, reason: rfb.reason },
          novnc: { port: this.novncPort, open: novnc.open, reason: novnc.reason },
          ok: rfb.open && novnc.open
        };
        this.cached = { at: Date.now(), value };
        return value;
      }).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }
}
