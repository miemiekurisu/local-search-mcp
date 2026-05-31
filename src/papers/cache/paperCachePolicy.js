import { CONFIG } from '../../config/index.js';

export function isExpired(item, now) {
  if (item.pinned) return false;
  if (!item.expires_at) return false;
  return new Date(item.expires_at) <= now;
}

export function ttlFromNow(ttlDays) {
  const d = new Date();
  d.setDate(d.getDate() + ttlDays);
  return d.toISOString();
}

export function computeExpiresAt(variant, config = CONFIG.paperCache) {
  switch (variant) {
    case 'raw/pdf':
    case 'raw/html':
    case 'raw/xml':
    case 'raw/tei':
      return ttlFromNow(config.rawTtlDays);
    case 'text':
      return ttlFromNow(config.textTtlDays);
    default:
      return null;
  }
}

export function variantPriority(variant) {
  const order = ['raw/tei', 'raw/xml', 'raw/html', 'raw/pdf', 'text', 'sections', 'chunks'];
  const idx = order.indexOf(variant);
  return idx >= 0 ? idx : 999;
}
