'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Runtime } = require('./runtime.cjs');
const { saveWithDialog, revealSaved } = require('./exports.cjs');

async function fixture(t, cached = true) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-exports-test-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const events = [];
  const runtime = new Runtime({ dataDir: folder, onEvent: event => events.push(event) });
  const cachedPath = path.join(folder, 'cache.png');
  await fs.writeFile(cachedPath, 'generated image');
  const media = { kind: 'image', url: 'data:image/png;base64,Z2VuZXJhdGVk', ...(cached ? { path: cachedPath } : {}) };
  runtime.jobs = [{ id: 'job-1', createdAt: '2026-10-14T12:34:56.000Z', status: 'succeeded', media: [media] }];
  return { folder, runtime, events, media, cachedPath, input: { jobId: 'job-1', index: 0 } };
}

test('canceling Save As leaves uncached media and history untouched', async t => {
  const { folder, runtime, events, input } = await fixture(t, false);
  const before = JSON.stringify(runtime.jobs);
  runtime.cacheMedia = async () => { throw new Error('Cancellation must not download'); };
  runtime.persist = async () => { throw new Error('Cancellation must not persist'); };
  const result = await saveWithDialog({ runtime, downloadsDir: folder, dialog: { showSaveDialog: async () => ({ canceled: true }) } }, input);
  assert.equal(result, null);
  assert.equal(JSON.stringify(runtime.jobs), before);
  assert.equal(events.length, 0);
});

test('Save As persists actual export path and reveals exported file after relaunch', async t => {
  const { folder, runtime, events, media, cachedPath, input } = await fixture(t);
  const destination = path.join(folder, 'chosen-result.png');
  let options;
  const result = await saveWithDialog({ runtime, downloadsDir: folder, dialog: { showSaveDialog: async (_window, value) => { options = value; return { canceled: false, filePath: destination }; } } }, input);
  assert.deepEqual(result, { path: destination });
  assert.equal(await fs.readFile(destination, 'utf8'), 'generated image');
  assert.equal(media.path, cachedPath);
  assert.equal(media.savedPath, destination);
  assert.equal(options.defaultPath, path.join(folder, 'Flow-2026-10-14T12-34-56-000Z.png'));
  assert.equal(events.at(-1).job.media[0].savedPath, destination);
  const relaunched = new Runtime({ dataDir: folder });
  await relaunched.initializeHistory();
  assert.equal(relaunched.publicJobs()[0].media[0].savedPath, destination);
  const revealed = [];
  const context = { runtime: relaunched, shell: { showItemInFolder: file => revealed.push(file) } };
  await revealSaved(context, destination);
  assert.deepEqual(revealed, [destination]);
  await assert.rejects(revealSaved(context, cachedPath), /Сохранённый файл не найден/);
  await assert.rejects(revealSaved(context, null), /Сохранённый файл не найден/);
  await fs.unlink(destination);
  await assert.rejects(revealSaved(context, destination), /Сохраните результат заново/);
  assert.equal(revealed.length, 1);
});

test('Save As downloads missing cache only after destination chosen', async t => {
  const { folder, runtime, media, cachedPath, input } = await fixture(t, false);
  const destination = path.join(folder, 'downloaded.png');
  let chosen = false;
  runtime.cacheMedia = async (jobId, index, item) => {
    assert.equal(chosen, true);
    assert.equal(jobId, input.jobId);
    assert.equal(index, input.index);
    assert.equal(item, media);
    return cachedPath;
  };
  await saveWithDialog({ runtime, downloadsDir: folder, dialog: { showSaveDialog: async () => { chosen = true; return { canceled: false, filePath: destination }; } } }, input);
  assert.equal(media.path, cachedPath);
  assert.equal(media.savedPath, destination);
  assert.equal(await fs.readFile(destination, 'utf8'), 'generated image');
});

test('failed export retains last saved path and invalid result never opens dialog', async t => {
  const { folder, runtime, events, media, input } = await fixture(t);
  media.savedPath = path.join(folder, 'previous.png');
  const previous = media.savedPath;
  const context = { runtime, downloadsDir: folder, dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path.join(folder, 'missing', 'result.png') }) } };
  await assert.rejects(saveWithDialog(context, input), { code: 'ENOENT' });
  assert.equal(media.savedPath, previous);
  assert.equal(events.length, 0);
  context.dialog.showSaveDialog = async () => { throw new Error('Invalid result must not show dialog'); };
  for (const invalid of [null, {}, { jobId: input.jobId, index: -1 }, { jobId: input.jobId, index: '0' }, { jobId: input.jobId, index: 1 }]) {
    await assert.rejects(saveWithDialog(context, invalid), /Результат не найден/);
  }
});
