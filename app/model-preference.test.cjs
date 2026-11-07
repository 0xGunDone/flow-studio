'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { modelInfo, frameReferences, modelSettings, preferredModel, PREFERRED_VIDEO_FAMILY } = require('./renderer.js');
const { capabilities, createAgentActions } = require('./agent-bridge.cjs');
const ids = [
  'omni-1.1-flash-8s-landscape', 'veo-3.1-fast-8s-landscape',
  'omni-1.2-flash', 'omni-1.2-flash-4s-portrait',
  'omni-1.2-flash-8s-portrait', 'omni-1.2-flash-8s-landscape'
];
const models = ids.map(id => ({ id }));

test('Omni 1.2 family is not mislabeled as Omni 1.1', () => {
  assert.equal(modelSettings({ id: 'omni-1.2-flash-8s-portrait' }).family, 'Omni 1.2 Flash');
  assert.equal(modelSettings({ id: 'omni-1.1-flash-8s-portrait' }).family, 'Omni 1.1 Flash');
  assert.equal(PREFERRED_VIDEO_FAMILY, 'Omni 1.2 Flash');
});

test('preferred video selection chooses canonical Omni 1.2 regardless of catalog order', () => {
  assert.equal(typeof preferredModel, 'function');
  for (const catalog of [models, [...models].reverse()]) {
    assert.equal(preferredModel(catalog, 'video', 'text').id, 'omni-1.2-flash-8s-landscape');
    assert.equal(preferredModel(catalog, 'video', 'ingredients').id, 'omni-1.2-flash-8s-landscape');
  }
  assert.equal(preferredModel([{ id: 'gemini-3.1-flash-image-landscape' }], 'image').id, 'gemini-3.1-flash-image-landscape');
});

test('missing or incompatible Omni 1.2 never silently falls back to Omni 1.1', () => {
  assert.equal(typeof preferredModel, 'function');
  assert.equal(preferredModel(models.filter(model => !model.id.startsWith('omni-1.2-')), 'video', 'text'), null);
  assert.equal(preferredModel(models, 'video', 'frames'), null);
});

test('bridge and UI expose the same preference while preserving legacy capabilities', () => {
  assert.equal(capabilities({ id: 'omni-1.2-flash-8s-landscape' }).preferred, true);
  assert.equal(capabilities({ id: 'omni-1.1-flash-8s-landscape' }).preferred, false);
  assert.equal(capabilities({ id: 'veo-3.1-fast-8s-landscape' }).preferred, false);
});

test('prepare resolves Omni 1.2 aliases, preserves explicit Omni 1.1, and never generates', async () => {
  const runtime = { models, jobs: [], ready: true, start: async () => {}, generate: async () => assert.fail('prepare must not generate') };
  const call = createAgentActions({ runtime });
  const settings = { kind: 'video', method: 'text', family: 'Omni 1.2 Flash', durationSeconds: 8, aspectRatio: '16:9' };
  const prepared = await call('prepare', { settings, prompt: 'A glowing star waves.' });
  assert.equal(prepared.generateArguments.model, 'omni-1.2-flash-8s-landscape');
  assert.equal(prepared.settings.family, 'Omni 1.2 Flash');
  const legacy = await call('prepare', { model: 'omni-1.1-flash-8s-landscape', method: 'text', prompt: 'A glowing star waves.' });
  assert.equal(legacy.generateArguments.model, 'omni-1.1-flash-8s-landscape');
  assert.deepEqual(runtime.jobs, []);
  runtime.models = models.filter(model => !model.id.startsWith('omni-1.2-'));
  await assert.rejects(call('prepare', { settings, prompt: 'A glowing star waves.' }), { code: 'MODEL_SELECTION_UNAVAILABLE' });
});

async function uiFixture(catalog, draft = {}, history = [], startupMessage = 'Готово') {
  const fs = require('node:fs'), vm = require('node:vm');
  const nodes = [];
  class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.dataset = {}; this.className = ''; this.disabled = false; this.textContent = ''; nodes.push(this); }
    get value() { return this._value === undefined ? this.children[0]?.value || '' : this._value; }
    set value(value) { this._value = value; }
    get classList() { return { toggle() {} }; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; this._value = undefined; }
    setAttribute() {} removeAttribute() {} focus() {} scrollIntoView() {} querySelector() { return null; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    async dispatch(name) { for (const fn of this.listeners[name] || []) await fn({ preventDefault() {} }); }
  }
  for (const match of fs.readFileSync(require.resolve('./index.html'), 'utf8').matchAll(/<(\w+)\b([^>]*)>/g)) {
    const node = new Node(match[1]), attributes = match[2];
    node.id = attributes.match(/\bid="([^"]+)"/)?.[1];
    node.name = attributes.match(/\bname="([^"]+)"/)?.[1];
    node.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] || '';
  }
  const byId = id => nodes.find(node => node.id === id);
  const document = { createElement: tag => new Node(tag), createTextNode: text => ({ textContent: text }), getElementById: byId, querySelectorAll: selector => selector === 'input[name="mode"]' ? nodes.filter(node => node.name === 'mode') : [] };
  let generated = 0;
  const snapshot = { ready: true, message: startupMessage, models: catalog, accounts: [{ id: 1, isActive: true, credits: 100 }], history, login: null };
  let storedDraft = { mode: 'video', ...draft };
  const window = { flowStudio: { bootstrap: async () => snapshot, onEvent: () => () => {}, generate: async () => { generated++; assert.fail('UI preference must not generate'); } }, localStorage: { getItem: () => JSON.stringify(storedDraft), setItem(key, value) { storedDraft = JSON.parse(value); } }, addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./renderer.js'), 'utf8'), { document, window, Intl, Date, setInterval: () => 1, clearInterval() {}, console });
  await new Promise(resolve => setImmediate(resolve));
  return { byId, nodes, generated: () => generated, draft: () => storedDraft };
}

test('actual UI defaults to Omni 1.2, retains explicit 1.1, and leaves no fallback selected', async () => {
  const fresh = await uiFixture(models);
  assert.equal(fresh.byId('model').value, 'omni-1.2-flash-8s-landscape');
  assert.equal(fresh.byId('model-family').value, 'Omni 1.2 Flash');
  const legacy = await uiFixture(models, { model: 'omni-1.1-flash-8s-landscape' });
  assert.equal(legacy.byId('model').value, 'omni-1.1-flash-8s-landscape');
  const absent = await uiFixture(models.filter(model => !model.id.startsWith('omni-1.2-')));
  assert.equal(absent.byId('model').value, '');
  assert.equal(absent.byId('model-family').value, '');
  assert.equal(absent.byId('generate').disabled, true);
  absent.byId('video-method').value = 'ingredients';
  await absent.byId('video-method').dispatch('change');
  assert.equal(absent.byId('model').value, '', 'Changing input method is not permission to fall back to 1.1');
  assert.equal(absent.byId('generate').disabled, true);
  fresh.byId('video-method').value = 'ingredients';
  await fresh.byId('video-method').dispatch('change');
  assert.equal(fresh.byId('model').value, 'omni-1.2-flash-8s-landscape');
  assert.equal(fresh.generated() + legacy.generated() + absent.generated(), 0);
});

test('missing saved model is not silently migrated to the new preference', async () => {
  const ui = await uiFixture(models.filter(model => !model.id.startsWith('omni-1.1-')), { model: 'omni-1.1-flash-8s-landscape', prompt: 'Keep my old model' });
  assert.equal(ui.byId('model').value, '');
  assert.equal(ui.byId('generate').disabled, true);
  assert.equal(ui.byId('prompt').value, 'Keep my old model');
  ui.byId('video-method').value = 'ingredients';
  await ui.byId('video-method').dispatch('change');
  assert.equal(ui.byId('model').value, '', 'A method change cannot replace a missing saved version');
  assert.equal(ui.draft().model, 'omni-1.1-flash-8s-landscape');
  assert.equal(ui.generated(), 0);
});

test('reusing a missing history model requires explicit selection instead of new default', async () => {
  const job = { id: 'legacy', kind: 'video', model: 'omni-1.1-flash-10s-portrait', prompt: 'Historical request', status: 'failed', error: 'Past error', media: [], createdAt: '2026-11-01T12:00:00Z' };
  const ui = await uiFixture(models, {}, [job]);
  const reuse = ui.nodes.find(node => node.tagName === 'BUTTON' && node.textContent === 'Редактировать запрос');
  assert.ok(reuse);
  await reuse.dispatch('click');
  assert.equal(ui.byId('model').value, '');
  assert.equal(ui.byId('generate').disabled, true);
  assert.equal(ui.byId('prompt').value, job.prompt);
  assert.equal(job.model, 'omni-1.1-flash-10s-portrait');
  assert.equal(ui.draft().model, job.model, 'A reused unavailable ID must survive restart in draft storage');
  const reloaded = await uiFixture(models, ui.draft());
  assert.equal(reloaded.byId('model').value, '');
  assert.equal(reloaded.byId('prompt').value, job.prompt);
  assert.equal(ui.generated(), 0);
});

test('MCP accepts an exact Omni 1.2 edit selector without forcing its 1.1 spelling', async () => {
  const { dispatch } = require('./mcp-server.cjs');
  const input = { model: 'omni-1.2-flash-edit-portrait', prompt: 'Keep the character', videoPaths: ['/tmp/source.mp4'] };
  const client = { call: async (method, params) => ({ method, params }) };
  assert.deepEqual(await dispatch(client, 'prepare', input), { method: 'prepare', params: input });
});


test('Omni 1.2 settings expose verified duration, resolution, frame and edit limits', () => {
  for (let seconds = 3; seconds <= 15; seconds++) {
    for (const orientation of ['landscape', 'portrait']) {
      for (const suffix of ['', '-360p']) {
        const ordinary = capabilities({ id: `omni-1.2-flash-${seconds}s-${orientation}${suffix}` });
        assert.deepEqual(ordinary.methods, ['text', 'ingredients']);
        assert.equal(ordinary.durationSeconds, seconds);
        assert.equal(ordinary.resolution, suffix ? '360p' : 'standard');
        assert.equal(ordinary.requiredTier, seconds > 10 ? 'Pro' : '');
        assert.equal(ordinary.maxImages, 7);
        const frames = capabilities({ id: `omni-1.2-flash-i2v-${seconds}s-${orientation}${suffix}` });
        assert.deepEqual(frames.methods, ['frames']);
        assert.equal(frames.minImages, 1);
        assert.equal(frames.maxImages, seconds > 10 ? 1 : 2);
        assert.equal(frames.supportsEndFrame, seconds <= 10);
      }
    }
  }
  const edit = capabilities({ id: 'omni-1.2-flash-edit-portrait-360p' });
  assert.equal(edit.fileLimits.video.maxDurationSeconds, 15);
  assert.equal(edit.durationSource, 'input_video');
  assert.equal(edit.durationSeconds, undefined);
  assert.equal(capabilities({ id: 'omni-1.1-flash-edit-portrait' }).fileLimits.video.maxDurationSeconds, 10);
  assert.throws(() => frameReferences([{}, {}], modelInfo({ id: 'omni-1.2-flash-i2v-15s-landscape' }), true), /не поддерживает конечный кадр/);
});

test('Omni 1.2 frame preparation retains roles and rejects a long end frame without spending', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-omni12-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const start = path.join(folder, 'start.png'), end = path.join(folder, 'end.png');
  await fs.writeFile(start, 'start'); await fs.writeFile(end, 'end');
  const runtime = { models: [8, 15].map(n => ({ id: `omni-1.2-flash-i2v-${n}s-landscape-360p` })), jobs: [], ready: true, start: async () => {}, generate: async () => assert.fail('preflight cannot spend') };
  const call = createAgentActions({ runtime });
  const args = { settings: { kind: 'video', method: 'frames', family: 'Omni 1.2 Flash', durationSeconds: 8, aspectRatio: '16:9', resolution: '360p' }, prompt: 'User scene', startFramePath: start, endFramePath: end };
  const prepared = await call('prepare', args);
  assert.equal(prepared.generateArguments.model, 'omni-1.2-flash-i2v-8s-landscape-360p');
  assert.equal(prepared.generateArguments.startFramePath, start);
  assert.equal(prepared.generateArguments.endFramePath, end);
  await assert.rejects(call('prepare', { ...args, settings: { ...args.settings, durationSeconds: 15 } }), /от 1 до 1/);
  assert.deepEqual(runtime.jobs, []);
});

test('MCP accepts exact Omni 1.2 360p edit selector', async () => {
  const { dispatch } = require('./mcp-server.cjs');
  const input = { model: 'omni-1.2-flash-edit-landscape-360p', prompt: 'User edit', videoPaths: ['/tmp/source.mp4'] };
  assert.deepEqual(await dispatch({ call: async (method, params) => ({ method, params }) }, 'prepare', input), { method: 'prepare', params: input });
});


test('incompatible method does not replace an explicit model family with preferred Omni 1.2', async () => {
  const catalog = [...models, { id: 'omni-1.2-flash-i2v-8s-landscape' }];
  const ui = await uiFixture(catalog, { model: 'omni-1.1-flash-8s-landscape' });
  ui.byId('video-method').value = 'frames';
  await ui.byId('video-method').dispatch('change');
  assert.equal(ui.byId('model').value, '');
  assert.equal(ui.draft().model, 'omni-1.1-flash-8s-landscape');
  assert.equal(ui.byId('generate').disabled, true);
});


test('successive method changes preserve stored explicit family after an incompatible method', async () => {
  const catalog = [...models, { id: 'omni-1.2-flash-i2v-8s-landscape' }, { id: 'omni-1.2-flash-edit-landscape' }];
  const ui = await uiFixture(catalog, { model: 'omni-1.1-flash-8s-landscape' });
  for (const method of ['frames', 'edit']) {
    ui.byId('video-method').value = method;
    await ui.byId('video-method').dispatch('change');
    assert.equal(ui.byId('model').value, '');
    assert.equal(ui.draft().model, 'omni-1.1-flash-8s-landscape');
  }
  ui.byId('video-method').value = 'text';
  await ui.byId('video-method').dispatch('change');
  assert.equal(ui.byId('model').value, 'omni-1.1-flash-8s-landscape');
});
