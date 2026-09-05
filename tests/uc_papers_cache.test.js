import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const [storeM, manifestM, cleanupM] = await Promise.all([
  import('../src/papers/cache/paperCacheStore.js'),
  import('../src/papers/cache/paperCacheManifest.js'),
  import('../src/papers/cache/paperCacheCleanup.js')
]);

const { PaperCacheStore } = storeM;
const { PaperCacheManifest } = manifestM;
const { PaperCacheCleanup } = cleanupM;

let seq = 0;
function makeConfig(over = {}) {
  seq += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `papers-cache-${seq}-`));
  return {
    enabled: true,
    dir,
    manifest: path.join(dir, 'manifest.json'),
    rawDir: path.join(dir, 'raw'),
    textDir: path.join(dir, 'text'),
    sectionDir: path.join(dir, 'sections'),
    chunkDir: path.join(dir, 'chunks'),
    tmpDir: path.join(dir, 'tmp'),
    rawMaxBytes: over.rawMaxBytes ?? 100,
    rawTtlDays: 7,
    textTtlDays: 90,
    ...over
  };
}

function rawEntryIds(store) {
  return store.manifest.allEntries().filter(i => i.variant.startsWith('raw/'));
}

test('disabled store returns nulls and empty results', async () => {
  const cfg = makeConfig();
  cfg.enabled = false;
  const store = new PaperCacheStore(cfg);
  assert.equal(store.enabled, false);
  assert.equal(await store.storeRaw('raw/pdf', 'http://u/x', Buffer.from('a')), null);
  assert.equal(await store.storeText('k', 't'), null);
  assert.equal(await store.storeSections('k', []), null);
  assert.deepEqual(store.findPaper('k'), {});
  assert.deepEqual(store.stats(), { enabled: false });
  assert.deepEqual(await new PaperCacheCleanup(store, cfg).cleanup(true), { enabled: false });
});

test('store raw/text/sections roundtrip with dedupe', async () => {
  const cfg = makeConfig();
  const store = new PaperCacheStore(cfg);

  const e1 = await store.storeRaw('raw/pdf', 'http://u/p.pdf?v=1#frag', Buffer.from('hello'), {
    paper_key: 'k1', source: 'arxiv', mime_type: 'application/pdf'
  });
  assert.equal(e1.variant, 'raw/pdf');
  assert.equal(e1.normalized_url, 'http://u/p.pdf?v=1');
  assert.ok(fs.existsSync(e1.file_path));
  assert.equal(fs.readFileSync(e1.file_path)[0], 0x68);
  assert.ok(new Date(e1.expires_at).getTime() > Date.now() + 6 * 86400000);

  const e1b = await store.storeRaw('raw/pdf', 'http://u/p.pdf?v=1', Buffer.from('hello'), { paper_key: 'k1' });
  assert.equal(e1b.id, e1.id);

  const sameUrl = await store.storeRaw('raw/html', 'http://u/p.pdf?v=1#frag', Buffer.from('changed'), { paper_key: 'k1' });
  assert.equal(sameUrl.id, e1.id);

  const t1 = await store.storeText('k1', 'some stored text', { source: 'test' });
  assert.equal(t1.variant, 'text');
  assert.equal(t1.mime_type, 'text/plain');
  assert.equal(fs.readFileSync(t1.file_path, 'utf8'), 'some stored text');

  const s1 = await store.storeSections('k1', [{ heading: 'A', text: 'x' }]);
  const c1 = await store.storeChunks('k1', [{ index: 0 }]);
  assert.equal(store.manifest.getItem(s1).variant, 'sections');
  assert.equal(store.manifest.getItem(c1).variant, 'chunks');

  const read = await store.readJson(s1);
  assert.deepEqual(read.data, [{ heading: 'A', text: 'x' }]);
  const raw = await store.readRaw(e1.id);
  assert.equal(Buffer.byteLength(raw.data), 5);
  const txt = await store.readText(t1.id);
  assert.equal(txt.data, 'some stored text');
  await store.readText(t1.id);
  assert.ok(store.manifest.getItem(t1.id).access_count >= 2);

  const fp = store.findPaper('k1');
  assert.equal(fp.sections.length, 1);
  assert.equal(fp.text.length, 1);
  assert.equal(fp.chunks.length, 1);
  assert.equal(fp.raws.length, 1);

  const st = store.stats();
  assert.equal(st.enabled, true);
  assert.equal(st.total_items, 4);
  assert.equal(st.pinned, 0);
  assert.equal(st.by_variant['raw/pdf'], 1);
  assert.equal(st.by_variant.text, 1);
  assert.equal(st.manifest_path, cfg.manifest);

  assert.equal(await store.readJson('nope-id'), null);
  store.close();
});

test('store invalid variants and paper keys rejected', async () => {
  const cfg = makeConfig();
  const store = new PaperCacheStore(cfg);
  await assert.rejects(store.storeRaw('weird', 'http://u/x', Buffer.from('a'), { paper_key: 'k' }), /invalid cache variant/);
  await assert.rejects(store.storeRaw('raw/pdf', 'http://u/x', Buffer.from('a'), {}), /Cannot derive paper key/);
  await assert.rejects(store.storeText('', 'x'), /invalid paper key/);
  const badKey = await store.storeText('bad/../key!', 'contents');
  assert.ok(fs.existsSync(badKey.file_path));
  assert.ok(!badKey.file_path.includes('..'));
  assert.equal(fs.readFileSync(badKey.file_path, 'utf8'), 'contents');
});

test('manifest direct api incl corrupt load and sorting', async () => {
  const cfg = makeConfig();
  fs.writeFileSync(cfg.manifest, 'this is not { valid json');
  const m = new PaperCacheManifest(cfg.manifest);
  m.load();
  assert.deepEqual(m.getItem('anything'), null);

  const idA = await m.addEntry({ paper_key: 'k', variant: 'text', file_path: cfg.dir + '/a.txt', size_bytes: 1, content_hash: 'h-text' });
  const idB = await m.addEntry({ paper_key: 'k', variant: 'sections', file_path: cfg.dir + '/b.json', size_bytes: 2, pinned: true, content_hash: 'h-sec' });
  m.getItem(idA).created_at = '2020-01-01T00:00:00.000Z';
  m.getItem(idB).created_at = '2020-02-01T00:00:00.000Z';

  assert.deepEqual(m.findByPaperKey('k').map(i => i.variant), ['sections', 'text']);
  assert.deepEqual(m.findByHash('h-text').map(i => i.id), [idA]);
  assert.equal(m.findByHash('h-none').length, 0);
  const byVariant = m.queryByVariant('sections');
  assert.equal(byVariant.length, 1);
  assert.equal(m.getItem(idB).pinned, 1);

  await m.touch(idA);
  assert.equal(m.getItem(idA).access_count, 1);
  await m.touch('unknown');
  assert.ok(m.stats().total_items >= 2);

  const removed = await m.deleteEntry(idA);
  assert.equal(removed.variant, 'text');
  assert.equal(m.getItem(idA), null);

  const saved = JSON.parse(fs.readFileSync(cfg.manifest, 'utf8'));
  assert.ok(Object.keys(saved.items).length >= 1);
  m.close();
});

test('manifest expired query', async () => {
  const cfg = makeConfig();
  const store = new PaperCacheStore(cfg);
  const item = await store.storeText('exp-key', 'exp text');
  store.manifest._data.items[item.id].expires_at = '2000-01-01T00:00:00Z';
  const expired = store.manifest.queryExpired(new Date());
  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, item.id);
  assert.ok(store.manifest.stats().expired === 1);
  store.close();
});

test('cleanupItems removes files respecting pinned and dryRun', async () => {
  const cfg = makeConfig();
  const store = new PaperCacheStore(cfg);
  const pinnedRaw = await store.storeRaw('raw/pdf', 'http://u/pin', Buffer.from('ppp'), { paper_key: 'pk', pinned: true });
  const victim = await store.storeText('vk', 'victim text');
  const removed = await store.cleanupItems([victim, pinnedRaw], false);
  assert.equal(removed.length, 1);
  assert.equal(removed[0].variant, 'text');
  assert.equal(fs.existsSync(victim.file_path), false);
  assert.equal(fs.existsSync(pinnedRaw.file_path), true);
  assert.equal(store.manifest.getItem(victim.id), null);

  const dry = await store.cleanupItems([pinnedRaw], true);
  assert.deepEqual(dry, []);
  store.close();
});

test('cleanup tmp dir old files only', async () => {
  const cfg = makeConfig();
  const store = new PaperCacheStore(cfg);
  fs.writeFileSync(path.join(cfg.tmpDir, 'old.part'), 'o');
  fs.writeFileSync(path.join(cfg.tmpDir, 'new.part'), 'n');
  fs.utimesSync(path.join(cfg.tmpDir, 'old.part'), new Date(Date.now() - 26 * 3600e3), new Date(Date.now() - 26 * 3600e3));

  const summary = await new PaperCacheCleanup(store, cfg).cleanup(true);
  const tmpStep = summary.steps.find(s => s.step === 'cleanup_tmp');
  assert.equal(tmpStep.removed, 1);
  assert.equal(tmpStep.dry_run, true);
  assert.equal(fs.existsSync(path.join(cfg.tmpDir, 'old.part')), true);
  store.close();

  const store2 = new PaperCacheStore(cfg);
  const summary2 = await new PaperCacheCleanup(store2, cfg).cleanup(false);
  assert.equal(summary2.steps.find(s => s.step === 'cleanup_tmp').removed, 1);
  assert.equal(fs.existsSync(path.join(cfg.tmpDir, 'old.part')), false);
  assert.equal(fs.existsSync(path.join(cfg.tmpDir, 'new.part')), true);
  store2.close();
});

test('cleanup raw quota evicts oldest unpinned, respects pinned', async () => {
  const cfg = makeConfig();
  const store = new PaperCacheStore(cfg);
  const a = await store.storeRaw('raw/pdf', 'http://u/a', Buffer.alloc(60, 1), { paper_key: 'pa' });
  const b = await store.storeRaw('raw/html', 'http://u/b', Buffer.alloc(60, 2), { paper_key: 'pb' });
  const c = await store.storeRaw('raw/xml', 'http://u/c', Buffer.alloc(60, 3), { paper_key: 'pc', pinned: true });
  store.manifest._data.items[a.id].last_access_at = '2020-01-01T00:00:00Z';
  store.manifest._data.items[b.id].last_access_at = '2021-01-01T00:00:00Z';

  const dry = await new PaperCacheCleanup(store, cfg).cleanup(true);
  const step = dry.steps.find(s => s.step === 'enforce_raw_quota');
  assert.equal(step.removed, 2);
  assert.equal(step.dry_run, true);
  assert.ok(fs.existsSync(a.file_path));

  const store2 = new PaperCacheStore(cfg);
  assert.equal(fs.existsSync(a.file_path), true);
  assert.equal(fs.existsSync(b.file_path), true);
  const real = await new PaperCacheCleanup(store2, cfg).cleanup(false);
  const step2 = real.steps.find(s => s.step === 'enforce_raw_quota');
  assert.equal(step2.removed, 2);
  assert.equal(step2.dry_run, false);
  assert.equal(fs.existsSync(a.file_path), false);
  assert.equal(fs.existsSync(b.file_path), false);
  assert.equal(fs.existsSync(c.file_path), true);
  assert.equal(rawEntryIds(store2).length, 1);
  assert.equal(real.total_removed >= 2, true);
  assert.deepEqual(store2.manifest.queryByVariant('raw/pdf').length, 0);
  store2.close();
});

test('cleanup expired entries removes files and manifest rows', async () => {
  const cfg = makeConfig();
  const store = new PaperCacheStore(cfg);
  const e = await store.storeText('exp', 'old text');
  store.manifest._data.items[e.id].expires_at = '2000-01-01T00:00:00Z';
  store.close();
  const store2 = new PaperCacheStore(cfg);
  const summary = await new PaperCacheCleanup(store2, cfg).cleanup(false);
  const step = summary.steps.find(s => s.step === 'cleanup_expired');
  assert.equal(step.removed, 1);
  assert.equal(fs.existsSync(e.file_path), false);
  assert.equal(store2.manifest.getItem(e.id), null);
  store2.close();
});

test('manifest persistence across store instances', async () => {
  const cfg = makeConfig();
  const m = new PaperCacheManifest(cfg.manifest);
  await m.addEntry({ paper_key: 'persist', variant: 'text', file_path: cfg.dir + '/p.txt', size_bytes: 1 });
  m.close();

  const store = new PaperCacheStore(cfg);
  assert.equal(store.findPaper('persist').text.length, 1);
  store.close();
  store.close();
});
