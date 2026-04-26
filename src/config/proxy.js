import { CONFIG, readJsonIfExists } from './index.js';

const DEFAULT_PROFILES = {
  direct: { type: 'direct' },
  auto: { type: 'direct' }
};

export class ProxyRouter {
  constructor() {
    const config = expandEnvVars(readJsonIfExists(CONFIG.proxyProfilesFile, {}));
    this.profiles = { ...DEFAULT_PROFILES, ...config };
    this.engineProxies = this.profiles.engine_proxies || {};
    delete this.profiles.engine_proxies;
  }

  resolve(profileName = 'auto', url = '') {
    const name = profileName || 'auto';
    const profile = this.profiles[name] || this.profiles.auto || this.profiles.direct;
    if (!profile || profile.type === 'direct') return { profile: name, proxyUrl: null, playwrightProxy: undefined };
    if (Array.isArray(profile.no_proxy) && shouldBypass(url, profile.no_proxy)) {
      return { profile: 'direct', proxyUrl: null, playwrightProxy: undefined };
    }
    const server = profile.server;
    if (!server) return { profile: name, proxyUrl: null, playwrightProxy: undefined };
    return {
      profile: name,
      proxyUrl: server,
      playwrightProxy: { server, username: profile.username, password: profile.password }
    };
  }

  resolveForEngine(engineName, url = '') {
    const proxyProfile = this.engineProxies[engineName];
    if (proxyProfile) {
      return this.resolve(proxyProfile, url);
    }
    return this.resolve('auto', url);
  }

  status() {
    return {
      profiles: Object.keys(this.profiles).map(name => ({ name, type: this.profiles[name].type || 'unknown' })),
      engine_proxies: this.engineProxies
    };
  }
}

function shouldBypass(url, noProxy = []) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return false; }
  for (const rule of noProxy) {
    if (!rule) continue;
    if (rule === '*') return true;
    if (host === rule || host.endsWith('.' + rule)) return true;
    if (rule === 'localhost' && host === 'localhost') return true;
    if (rule === '127.0.0.1' && host === '127.0.0.1') return true;
    if (rule === '10.0.0.0/8' && host.startsWith('10.')) return true;
    if (rule === '192.168.0.0/16' && host.startsWith('192.168.')) return true;
    if (rule === '172.16.0.0/12' && /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  }
  return false;
}

function expandEnvVars(value) {
  if (Array.isArray(value)) {
    return value.map(item => expandEnvVars(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnvVars(item)]));
  }
  if (typeof value !== 'string') {
    return value;
  }

  return value.replace(/\$\{([A-Z0-9_]+)(:-([^}]*))?\}/gi, (_match, envName, _withDefault, defaultValue = '') => {
    return process.env[envName] ?? defaultValue;
  }).trim();
}
