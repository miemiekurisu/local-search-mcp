import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG, ensureDir, safeJoin } from '../config/index.js';

export class ArtifactStore {
  constructor(baseDir = CONFIG.artifactDir) {
    this.baseDir = baseDir;
    ensureDir(this.baseDir);
  }

  writeText(kind, text, metadata = {}) {
    const id = `${kind}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const dir = safeJoin(this.baseDir, kind);
    ensureDir(dir);
    const textPath = safeJoin(dir, `${id}.txt`);
    const metaPath = safeJoin(dir, `${id}.json`);
    fs.writeFileSync(textPath, text || '', 'utf8');
    fs.writeFileSync(metaPath, JSON.stringify({ id, kind, created_at: new Date().toISOString(), ...metadata }, null, 2), 'utf8');
    return `artifact://${kind}/${id}.txt`;
  }

  read(ref, offset = 0, limit = 8000) {
    const { kind, file } = parseArtifactRef(ref);
    const filePath = safeJoin(this.baseDir, kind, file);
    const text = fs.readFileSync(filePath, 'utf8');
    const start = Math.max(0, Number(offset) || 0);
    const end = Math.min(text.length, start + Math.max(1, Number(limit) || 8000));
    return {
      artifact_ref: ref,
      offset: start,
      limit: end - start,
      total_chars: text.length,
      text: text.slice(start, end)
    };
  }
}

function parseArtifactRef(ref) {
  if (!String(ref).startsWith('artifact://')) throw new Error('invalid artifact ref');
  const rest = String(ref).slice('artifact://'.length);
  const parts = rest.split('/');
  if (parts.length !== 2) throw new Error('invalid artifact ref path');
  return { kind: parts[0], file: path.basename(parts[1]) };
}
