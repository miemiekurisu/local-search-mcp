import net from 'node:net';
import dns from 'node:dns/promises';

// ── Host/SSRF guard ────────────────────────────────────────────────────────
// Replaces the previous string-prefix hostname checks, which were bypassable by
// numeric/hex/octal IP literals ("2130706433", "0x7f000001", "0177.0.0.1"),
// IPv4-mapped IPv6 ("::ffff:127.0.0.1") and DNS rebinding. All IP literals are
// normalised to a canonical dotted-quad / plain form, then matched against
// private/reserved ranges.

function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function ipv4FromInt(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function ipv4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  if (p.some(o => !/^\d{1,3}$/.test(o))) return null;
  const n = p.map(Number);
  if (n.some(x => x < 0 || x > 255)) return null;
  return ((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0;
}

function ipv4FromMappedV6(host) {
  let m = host.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
  if (m) {
    const octets = m.slice(1).map(Number);
    if (octets.every(o => o >= 0 && o <= 255)) return octets.join('.');
    return null;
  }
  m = host.match(/^::ffff:(\d+)$/i);
  if (m) {
    const n = Number(m[1]);
    if (n >= 0 && n <= 0xffffffff) return ipv4FromInt(n >>> 0);
  }
  return null;
}

function ipv4FromDotted(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const p of parts) {
    if (!/^0x[0-9a-f]+$/i.test(p) && !/^\d+$/.test(p)) return null;
    let radix = 10;
    let s = p;
    if (/^0x[0-9a-f]+$/i.test(p)) { radix = 16; s = p.slice(2); }
    else if (p.length > 1 && p[0] === '0') { radix = 8; s = p.slice(1); }
    const n = parseInt(s, radix);
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets.join('.');
}

function decodeEncodedIp(host) {
  if (/^\d+$/.test(host)) {
    const n = host.length > 1 && host[0] === '0' ? parseInt(host, 8) : Number(host);
    if (n >= 0 && n <= 0xffffffff) return ipv4FromInt(n >>> 0);
    return null;
  }
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = parseInt(host, 16);
    if (n >= 0 && n <= 0xffffffff) return ipv4FromInt(n >>> 0);
    return null;
  }
  return ipv4FromDotted(host);
}

export function normalizeHostForCheck(hostname) {
  let h = stripBrackets(String(hostname || '').toLowerCase());
  const mapped = ipv4FromMappedV6(h);
  if (mapped) return mapped;
  const enc = decodeEncodedIp(h);
  if (enc) return enc;
  return h;
}

const PRIVATE_V4_RANGES = [
  [0x00000000, 0xff000000], // 0.0.0.0/8
  [0x7f000000, 0xff000000], // 127.0.0.0/8 loopback
  [0x0a000000, 0xff000000], // 10.0.0.0/8
  [0xac100000, 0xfff00000], // 172.16.0.0/12
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16 link-local
  [0x64400000, 0xffc00000]  // 100.64.0.0/10 CGNAT
];

function ipv4Private(ip) {
  const n = ipv4ToInt(ip);
  if (n == null) return true;
  for (const [base, mask] of PRIVATE_V4_RANGES) {
    // (n & mask) is a signed int32 for high-bit ranges; force unsigned so it
    // compares correctly against the positive `base` literal.
    if (((n & mask) >>> 0) === base) return true;
  }
  if (n >= 0xe0000000) return true; // 224.0.0.0/4 multicast/reserved
  return false;
}

function ipv6Private(ip) {
  const low = ip.toLowerCase();
  if (low === '::' || low === '::1') return true;
  if (low.startsWith('::ffff:')) return true; // IPv4-mapped
  if (/^f[cd]/.test(low)) return true;        // fc00::/7 ULA
  if (/^fe[89ab]/.test(low)) return true;     // fe80::/10 link-local
  if (/^ff/.test(low)) return true;           // ff00::/8 multicast
  return false;
}

// Returns true when the hostname resolves (literally) to a private/reserved
// address or is an obviously internal hostname. Domains that need DNS are
// NOT resolved here — use assertPublicHost() before the actual request.
export function hostIsPrivate(hostname) {
  if (!hostname) return true;
  const h = normalizeHostForCheck(hostname);
  const v = net.isIP(h);
  if (v === 4) return ipv4Private(h);
  if (v === 6) return ipv6Private(h);
  const low = h.toLowerCase();
  if (low === 'localhost' || low.endsWith('.localhost') || low.endsWith('.local') || low.endsWith('.internal')) return true;
  if (low === 'host.docker.internal') return true;
  return false;
}

// Resolve a domain and fail if ANY address is private/reserved. Also guards IP
// literals directly. Fail-closed on DNS errors (cannot prove it is public).
export async function assertPublicHost(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw Object.assign(new Error('invalid URL'), { code: 'SSRF_BAD_URL' });
  }
  hostname = stripBrackets(hostname);
  const v = net.isIP(hostname);
  if (v) {
    if (hostIsPrivate(hostname)) {
      throw Object.assign(new Error('blocked private/reserved address'), { code: 'SSRF_BLOCKED' });
    }
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch (err) {
    throw Object.assign(new Error(`DNS resolution failed: ${err.message}`), { code: 'SSRF_DNS_ERROR' });
  }
  for (const { address } of addrs) {
    if (hostIsPrivate(address)) {
      throw Object.assign(new Error(`resolved to private/reserved address ${address}`), { code: 'SSRF_BLOCKED' });
    }
  }
}
