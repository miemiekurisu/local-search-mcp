import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { ArtifactStore } = await import('../src/artifacts/artifactStore.js');

let seq = 0;
function makeStore() {
  seq += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `uc-artifacts-${seq}-`));
  return { dir, store: new ArtifactStore(dir) };
}

test('writeText roundtrip with metadata', () => {
  const { dir, store } = makeStore();
  const ref = store.writeText('papers', 'hello artifact', { query: 'q', kind: 'paper_search_results' });
  assert.match(ref, /^artifact:\/\/papers\/papers_\d+_[0-9a-f]{12}\.txt$/);
  const out = store.read(ref);
  assert.equal(out.text, 'hello artifact');
  assert.equal(out.total_bytes, 14);
  assert.equal(out.offset, 0);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, out.artifact_ref.replace('artifact://', '').replace('.txt', '.json')), 'utf8'));
  assert.equal(meta.kind, 'paper_search_results');
  assert.equal(meta.query, 'q');
});

test('read windowing avoids splitting multibyte chars', () => {
  const { store } = makeStore();
  // 'é' is 2 bytes, '中' is 3 bytes
  const ref = store.writeText('search', 'xé中z');
  const full = store.read(ref);
  assert.equal(full.total_bytes, 7);

  const win = store.read(ref, 1, 1);
  assert.equal(win.offset, 1);
  // byte 1 is the first byte of 'é' — window of 1 byte must not split it
  assert.equal(win.text, '');
  assert.ok(win.limit >= 0);

  const win2 = store.read(ref, 0, 99);
  assert.equal(win2.text, 'xé中z');

  const badOffset = store.read(ref, 99999);
  assert.equal(badOffset.offset, 7);
  assert.equal(badOffset.text, '');

  assert.equal(store.read(ref, -3, 4).text, 'xé');
});

test('read error mapping', () => {
  const { dir, store } = makeStore();
  assert.throws(() => store.read('artifact://search/missing_file.txt'), err => {
    assert.equal(err.code, 'ARTIFACT_NOT_FOUND');
    return true;
  });
  assert.throws(() => store.read('http://not/an/ref'), err => {
    assert.equal(err.code, 'INVALID_ARTIFACT_REF');
    return true;
  });
  assert.throws(() => store.read('artifact://a/b/c.txt'), err => {
    assert.equal(err.code, 'INVALID_ARTIFACT_REF');
    return true;
  });
  assert.throws(() => store.read('artifact://../evil/x.txt'), err => {
    assert.equal(err.code, 'INVALID_ARTIFACT_REF');
    return true;
  });
  // directory named like a file -> EISDIR-ish errors become ARTIFACT_READ_ERROR
  fs.mkdirSync(path.join(dir, 'search', 'dir.txt'), { recursive: true });
  assert.throws(() => store.read('artifact://search/dir.txt'), err => {
    assert.equal(err.code, 'ARTIFACT_READ_ERROR');
    return true;
  });
});

test('cleanup removes expired files, symlinks, empty dirs; keeps fresh data', () => {
  const { dir, store } = makeStore();
  const oldDir = path.join(dir, 'search');
  fs.makedirs = 0;
  fs.mkdirSync(oldDir, { recursive: true });
  const oldFile = path.join(oldDir, 'old_result.txt');
  fs.writeFileSync(oldFile, 'stale');
  fs.utimesSync(oldFile, new Date(Date.now() - 60 * 86400e3), new Date(Date.now() - 60 * 86400e3));
  const fresh = path.join(oldDir, 'fresh_result.json');
  fs.writeFileSync(fresh, '{}');
  const keep = path.join(oldDir, 'keepme.bin');
  fs.writeFileSync(keep, 'bin');

  const emptyKind = path.join(dir, 'emptyKind');
  fs.mkdirSync(emptyKind);

  const loose = path.join(dir, 'loose_file.txt');
  fs.writeFileSync(loose, 'loose');

  const fullDirOfOld = path.join(dir, 'bigkind');
  fs.mkdirSync(fullDirOfOld, { recursive: true });
  const bigOld = path.join(fullDirOfOld, 'expired.txt');
  fs.writeFileSync(bigOld, 'x');
  fs.utimesSync(bigOld, new Date(Date.now() - 30 * 86400e3), new Date(Date.now() - 30 * 86400e3));
  const alsoStale = path.join(fullDirOfOld, 'expired.json');
  fs.writeFileSync(alsoStale, 'x');
  fs.utimesSync(alsoStale, new Date(Date.now() - 30 * 86400e3), new Date(Date.now() - 30 * 86400e3));

  store._cleanupOld();

  assert.equal(fs.existsSync(oldFile), false, 'expired .txt removed');
  assert.equal(fs.existsSync(fresh), true, 'fresh .json kept');
  assert.equal(fs.existsSync(keep), true, 'non txt/json file not removed');
  assert.equal(fs.existsSync(oldDir), true, 'non-empty kind dir kept');
  assert.equal(fs.existsSync(emptyKind), false, 'empty kind dir removed');
  assert.equal(fs.existsSync(loose), true, 'loose base files not directories, skipped');
  assert.equal(fs.existsSync(bigOld), false, 'expired bigkind txt removed');
  assert.equal(fs.existsSync(alsoStale), false, 'expired bigkind json removed');
  assert.equal(fs.existsSync(fullDirOfOld), false, 'emptied kind dir removed');
});

test('cleanup removes symlinks when creatable', () => {
  const { dir, store } = makeStore();
  const kindDir = path.join(dir, 'search');
  fs.mkdirSync(kindDir, { recursive: true });
  const target = path.join(dir, 'target_outside.txt');
  fs.writeFileSync(target, 'secret');
  const linkPath = path.join(kindDir, 'linked.txt');
  let canSymlink = true;
  try {
    fs.symlinkSync(target, linkPath, 'file');
  } catch {
    canSymlink = false;
  }
  store._cleanupOld();
  if (!canSymlink) {
    // symlink creation not permitted on this host; nothing to assert
    return;
  }
  assert.equal(fs.existsSync(linkPath), false, 'symlink inside artifact dir removed');
  assert.equal(fs.existsSync(target), true, 'symlink target untouched');
});

test('cleanup scan error swallowed when baseDir missing', () => {
  const { dir, store } = makeStore();
  fs.rmSync(dir, { recursive: true, force: true });
  store._cleanupOld();
  assert.equal(fs.existsSync(dir), false);
});

test('cleanup error catch per kind dir (directory posing as .txt)', () => {
  const { dir, store } = makeStore();
  const kindDir = path.join(dir, 'search');
  fs.mkdirSync(kindDir, { recursive: true });
  const sneakyDir = path.join(kindDir, 'sneaky.txt');
  fs.mkdirSync(sneakyDir);
  const old = new Date(Date.now() - 60 * 86400e3);
  fs.utimesSync(sneakyDir, old, old);

  let juncCreated = true;
  try {
    fs.symlinkSync(kindDir, path.join(kindDir, 'link.json'), 'junction');
  } catch {
    juncCreated = false;
  }

  store._cleanupOld(); // must not throw even though unlinkSync(sneaky.txt) fails
  assert.equal(fs.existsSync(path.join(kindDir, 'sneaky.txt')), true, 'failed unlink leaves the suspect entry');
  if (juncCreated) {
    assert.equal(fs.existsSync(path.join(kindDir, 'link.json')), false, 'junction removed by symlink branch');
  }
});

test('read validates kind fragments', () => {
  const { store } = makeStore();
  const ref = store.writeText('papers', 'ok');
  const out = store.read(ref, 0, 2);
  assert.equal(out.text, 'ok');
});
