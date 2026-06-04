import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG, ensureDir, safeJoin } from '../config/index.js';

const ARTIFACT_TTL_MS = CONFIG.artifactTtlDays * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 3600000;

export class ArtifactStore {
  constructor(baseDir = CONFIG.artifactDir) {
    this.baseDir = baseDir;
    ensureDir(this.baseDir);
    this._cleanupOld();
    this._cleanupTimer = setInterval(() => this._cleanupOld(), CLEANUP_INTERVAL_MS);
    this._cleanupTimer.unref();
  }

  _cleanupOld() {
    try {
      const now = Date.now();
      const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = safeJoin(this.baseDir, entry.name);
        try {
          const files = fs.readdirSync(dirPath);
          for (const file of files) {
            if (!file.endsWith('.txt') && !file.endsWith('.json')) continue;
            const filePath = safeJoin(dirPath, file);
            // Use lstatSync to detect symlinks — never follow them
            const lstat = fs.lstatSync(filePath);
            if (lstat.isSymbolicLink()) {
              fs.unlinkSync(filePath);
              continue;
            }
            if (now - lstat.mtimeMs > ARTIFACT_TTL_MS) {
              fs.unlinkSync(filePath);
            }
          }
          if (fs.readdirSync(dirPath).length === 0) {
            fs.rmdirSync(dirPath);
          }
        } catch (err) {
          console.error(`[artifactStore] cleanup error in ${dirPath}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[artifactStore] cleanup scan error:', err.message);
    }
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
    try {
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
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw Object.assign(new Error('Artifact not found'), { code: 'ARTIFACT_NOT_FOUND' });
      }
      if (err.message === 'unsafe path traversal' ||
          err.message === 'invalid artifact ref path' ||
          err.message === 'invalid artifact ref') {
        throw Object.assign(new Error('Invalid artifact reference'), { code: 'INVALID_ARTIFACT_REF' });
      }
      throw Object.assign(new Error('Failed to read artifact'), { code: 'ARTIFACT_READ_ERROR' });
    }
  }
}

function parseArtifactRef(ref) {
  if (!String(ref).startsWith('artifact://')) throw new Error('invalid artifact ref');
  const rest = String(ref).slice('artifact://'.length);
  const parts = rest.split('/');
  if (parts.length !== 2) throw new Error('invalid artifact ref path');
  return { kind: parts[0], file: path.basename(parts[1]) };
}
