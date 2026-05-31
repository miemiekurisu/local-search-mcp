const EXTENSION_MAP = {
  '.pdf': 'raw/pdf',
  '.html': 'raw/html',
  '.htm': 'raw/html',
  '.xml': 'raw/xml',
  '.tei.xml': 'raw/tei',
  '.tei': 'raw/tei'
};

const MIME_MAP = {
  'application/pdf': 'raw/pdf',
  'text/html': 'raw/html',
  'application/xhtml+xml': 'raw/html',
  'text/xml': 'raw/xml',
  'application/xml': 'raw/xml',
  'application/tei+xml': 'raw/tei',
  'text/plain': 'raw/text'
};

export function detectContentType(url, contentType, buffer) {
  if (contentType) {
    const ct = contentType.split(';')[0].trim().toLowerCase();
    const mapped = MIME_MAP[ct];
    if (mapped) return mapped;
  }

  try {
    const u = new URL(url);
    let pathname = u.pathname;

    for (const [ext, variant] of Object.entries(EXTENSION_MAP)) {
      if (pathname.endsWith(ext)) return variant;
    }

    if (pathname.includes('/pdf/') || pathname.endsWith('/pdf')) return 'raw/pdf';
  } catch {}

  if (buffer && buffer.length > 4) {
    const header = buffer.slice(0, 5).toString('utf8');
    if (header.startsWith('%PDF-')) return 'raw/pdf';
    if (header.startsWith('<!DOC') || header.startsWith('<html')) return 'raw/html';
    if (header.startsWith('<?xml')) {
      const first200 = buffer.slice(0, 200).toString('utf8').toLowerCase();
      if (first200.includes('tei') || first200.includes('tei.2')) return 'raw/tei';
      return 'raw/xml';
    }
  }

  return 'raw/pdf';
}

export function extensionForVariant(variant) {
  switch (variant) {
    case 'raw/pdf': return '.pdf';
    case 'raw/html': return '.html';
    case 'raw/xml': return '.xml';
    case 'raw/tei': return '.tei.xml';
    default: return '.bin';
  }
}
