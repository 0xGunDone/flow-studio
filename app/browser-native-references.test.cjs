'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { NativeBrowser, inputPlan, createBrowserTransport } = require('./browser-native.cjs');

const SHA = '1'.repeat(64);
const image = (index = 0, sha256 = SHA) => ({
  path: `/private/tmp/flow-ref-test/ref-${sha256.slice(0, 16)}-${index}-abcdef12.png`,
  name: `ref-${sha256.slice(0, 16)}-${index}-abcdef12.png`, sha256,
});
const input = images => ({ accountId: 7, expectedEmail: 'test@example.invalid', model: 'omni-1.2-flash-8s-landscape', prompt: 'Exact test prompt', images });

test('reference plan preserves ordered immutable descriptors and infers ingredients', () => {
  const refs = [image(), image(1, '2'.repeat(64))], plan = inputPlan(input(refs));
  assert.deepEqual(plan.images, refs);
  assert.equal(plan.settings.method, 'ingredients');
  assert.ok(Object.isFrozen(plan.images));
  assert.ok(plan.images.every(Object.isFrozen));
  refs[0].sha256 = '3'.repeat(64);
  assert.equal(plan.images[0].sha256, SHA);
  assert.equal(inputPlan(input([])).settings.method, 'text');
});

test('reference plan rejects opaque, mismatched, duplicate and excessive inputs', () => {
  const invalid = [
    ['data:image/png;base64,AA=='], [{ path: image().path }],
    [{ ...image(), extra: true }], [{ ...image(), path: 'relative.png' }],
    [{ ...image(), sha256: SHA.toUpperCase().replace(/^1/, 'G') }],
    [{ ...image(), name: 'different.png' }],
    [{ ...image(), path: image().path.replace('1111', '2222'), name: image().name.replace('1111', '2222') }],
    [image(), image()], Array.from({ length: 8 }, (_, i) => image(i)),
  ];
  for (const images of invalid) assert.throws(() => inputPlan(input(images)), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => inputPlan({ ...input([image()]), settings: { method: 'text' } }), { code: 'SETTINGS_MISMATCH' });
});

function helper(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => { child.killed = true; };
  const requests = [];
  child.stdin.on('data', chunk => {
    const request = JSON.parse(chunk.toString()); requests.push(request);
    queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: request.command === 'chooseFile' ? { chosen: true, sha256: request.sha256 } : { fingerprint: SHA, method: 'screen' } }) + '\n'));
  });
  const native = new NativeBrowser({ binaryPath: path.join(__dirname, 'native', 'bin', 'test-helper'), spawn: () => child });
  t.after(() => native.close()); return { native, requests };
}

test('native wrapper wires bounded chooser and ingredient fingerprint commands', async t => {
  const { native, requests } = helper(t), ref = image();
  assert.deepEqual(await native.call('chooseFile', { pid: 123, path: ref.path, sha256: ref.sha256 }, { timeoutMs: 30000 }), { chosen: true, sha256: SHA });
  assert.deepEqual(await native.call('readIngredientFingerprint', { pid: 123, nodeId: 'ingredient-1' }), { fingerprint: SHA, method: 'screen' });
  assert.deepEqual(requests.map(({ id, ...request }) => request), [
    { command: 'chooseFile', pid: 123, path: ref.path, sha256: SHA },
    { command: 'readIngredientFingerprint', pid: 123, nodeId: 'ingredient-1' },
  ]);
  for (const args of [{ pid: 123, path: 'relative.png', sha256: SHA }, { pid: 123, path: ref.path, sha256: '' }, { pid: 123, path: ref.path, sha256: SHA, token: 'unexpected' }]) await assert.rejects(native.call('chooseFile', args), { code: 'INVALID_ARGUMENTS' });
  assert.equal(requests.length, 2);
});

function flow(t, options = {}) {
  const state = { panel: false, settings: false, menu: false, picker: false, selected: null, prompt: '', chips: options.initialChips || [], assets: options.initialAssets || [], calls: [], fingerprintReads: [], generations: 0, releases: 0, duration: '5', radio: new Map([['Видео', '1'], ['Ингредиенты', '1'], ['16:9', '1'], ['720p', '1'], ['x1', '1']]) };
  let nextEpoch = 0, activeEpoch = null, focused = null, previewReads = 0;
  if (options.duration !== undefined) state.duration = String(options.duration);
  const node = (id, role, title, extra = {}) => ({ id, role, title, enabled: true, actions: ['AXPress'], ...extra });
  function snapshot() {
    const nodes = [
      node('composer', 'AXGroup', '', { actions: [] }),
      node('trigger', 'AXButton', 'Триггер настроек', { parent: 'composer' }),
      node('prompt', 'AXTextArea', '', { parent: 'composer', description: 'Что вы хотите создать?', value: state.prompt, settable: true, actions: [] }),
      node('ingredients', 'AXPopUpButton', 'Добавить ингредиенты в окно запроса', { parent: 'composer' }),
      node('agent', 'AXCheckBox', 'Агент', { parent: 'composer', value: '0' }),
      node('generate', 'AXButton', 'Начать генерацию', { parent: 'composer' }),
      ...state.chips.flatMap((chip, index) => [node(`chip-${index}`, 'AXButton', 'Ингредиент', { parent: 'composer' }), node(`chip-image-${index}`, 'AXImage', '', { description: 'Изображение ингредиента', parent: `chip-${index}`, actions: [] })]),
    ];
    if (options.paragraphs && state.prompt) nodes.push(node('prompt-paragraphs', 'AXGroup', '', { parent: 'prompt', actions: [] }), ...state.prompt.split('\n\n').map((value, index) => node(`paragraph-${index}`, 'AXStaticText', '', { parent: 'prompt-paragraphs', value, actions: [] })));
    if (options.foreignPromptText && state.prompt) nodes.push(node('foreign-prompt-text', 'AXStaticText', '', { parent: 'prompt', value: 'Text absent from exact prompt', actions: [] }));
    if (options.outsidePromptText && state.prompt) nodes.push(node('outside-prompt-text', 'AXStaticText', '', { parent: 'composer', value: state.prompt.slice(0, 4), actions: [] }));
    if (state.prompt) nodes.push(node('clear', 'AXButton', 'Очистить запрос', { parent: 'composer' }));
    nodes.push(node('account', 'AXButton', 'Сведения об аккаунте'));
    if (state.panel) nodes.push(node('panel', options.accountPanelRole || 'AXGroup', options.accountPanelValueOnly ? '' : 'Настройки аккаунта', { ...(options.accountPanelValueOnly ? { value: 'Настройки аккаунта' } : {}), actions: [] }), node('email', 'AXStaticText', '', { parent: 'panel', value: options.accountEmail || 'test@example.invalid', actions: [] }), node('close-panel', 'AXButton', 'Закрыть панель аккаунта'));
    if (state.settings) {
      nodes.push(...[...state.radio].map(([title, value]) => node(`radio-${title}`, 'AXRadioButton', title, { value })), node('model', 'AXPopUpButton', 'Выбрать семейство моделей'), node('duration', 'AXSlider', '', { description: 'Длительность', value: state.duration, minValue: 0, maxValue: 12, settable: true }));
      if (state.menu) nodes.push(node('model-item', 'AXMenuItem', 'Omni 1.2 Flash'));
    }
    if (state.picker) {
      nodes.push(node('asset-list', 'AXList', 'Список объектов', { actions: [] }), node('upload', 'AXButton', 'Загрузить'), node('add-to-prompt', 'AXButton', 'Добавить в запрос', { enabled: state.selected !== null }));
      nodes.push(...state.assets.map((asset, index) => node(`asset-${index}`, 'AXUnknown', asset.name + ' Изображение', { parent: 'asset-list', selected: options.selectedAbsent ? false : state.selected === index || Boolean(options.foreignSelected && index === 0) })));
      if (state.selected !== null && !options.noPreview) {
        previewReads++;
        nodes.push(node('preview', 'AXImage', '', { description: `Предпросмотр ресурса "${options.wrongPreview || previewReads <= (options.previewDelayReads || 0) ? 'other.png' : state.assets[state.selected].name}"`, actions: [] }));
      }
      if (state.selected !== null && options.videoPreview) nodes.push(node('video-preview-slider', 'AXSlider', '', { description: 'Видео', value: '0' }));
      if (options.progress) nodes.push(node('upload-progress', 'AXProgressIndicator', '', { parent: 'asset-list', actions: [] }));
    }
    activeEpoch = ++nextEpoch;
    const result = { pid: 123, documentURL: 'https://flow.google.com/project/test-project', truncated: false, nodes: nodes.map(node => ({ ...node, id: `${node.id}@${activeEpoch}`, ...(node.parent ? { parent: `${node.parent}@${activeEpoch}` } : {}) })) };
    options.onSnapshot?.(state, result); return result;
  }
  const native = { async call(command, args, callOptions) {
    state.calls.push({ command, args, options: callOptions });
    if (args.nodeId) {
      assert.ok(activeEpoch !== null && args.nodeId.endsWith(`@${activeEpoch}`), 'native node handle must be fresh');
      args = { ...args, nodeId: args.nodeId.slice(0, args.nodeId.lastIndexOf('@')) };
    }
    if (['press', 'focus', 'setValue', 'key', 'text', 'chooseFile', 'readLabel'].includes(command)) activeEpoch = null;
    if (command === 'status') return { trusted: true, locked: false };
    if (command === 'locateFlow') return { candidates: [] };
    if (['focusFlow', 'activateAccessibility'].includes(command)) return {};
    if (command === 'snapshot') return snapshot();
    if (command === 'readLabel') return { method: 'vision', texts: options.badModel ? ['Unreadable model'] : ['Omni 1.2 Flash'] };
    if (command === 'focus') { assert.equal(args.nodeId, 'duration'); if (options.badFocus) return { performed: false }; focused = 'duration'; return { performed: true }; }
    if (command === 'readIngredientFingerprint') {
      if (options.badFingerprint) return { method: 'count', fingerprint: SHA };
      const index = Number(args.nodeId.slice(5));
      state.fingerprintReads.push({ index, count: state.chips.length });
      return options.onFingerprint?.(state, index) || { method: 'native-image', fingerprint: state.chips[index] };
    }
    if (command === 'chooseFile') {
      assert.equal(callOptions.timeoutMs, 30000);
      if (options.badChoice) return { chosen: true, sha256: '0'.repeat(64) };
      state.assets.push({ name: options.wrongAssetName ? 'other.png' : path.basename(args.path), sha256: args.sha256 });
      return { chosen: true, sha256: args.sha256 };
    }
    if (command === 'setValue') { assert.notEqual(args.nodeId, 'duration', 'duration must dispatch native input events'); if (args.nodeId === 'prompt') state.prompt = args.value; else assert.fail('unexpected setValue'); return { performed: true }; }
    if (command === 'key') {
      if (args.key === 'escape') { state.settings = false; focused = null; }
      else { assert.equal(focused, 'duration'); assert.ok(['home', 'right'].includes(args.key)); state.duration = args.key === 'home' ? '0' : String(Number(state.duration) + 1); }
      return { performed: true };
    }
    if (command === 'press') {
      if (args.nodeId === 'account') state.panel = true;
      else if (args.nodeId === 'close-panel') state.panel = false;
      else if (args.nodeId === 'trigger') state.settings = !state.settings;
      else if (args.nodeId === 'model') state.menu = true;
      else if (args.nodeId === 'model-item') state.menu = false;
      else if (args.nodeId.startsWith('radio-')) state.radio.set(args.nodeId.slice(6), '1');
      else if (args.nodeId === 'ingredients') { state.picker = true; state.selected = null; }
      else if (args.nodeId === 'upload') assert.equal(state.picker, true);
      else if (args.nodeId.startsWith('asset-')) state.selected = Number(args.nodeId.slice(6));
      else if (args.nodeId === 'add-to-prompt') { assert.notEqual(state.selected, null); state.chips.push(state.assets[state.selected].sha256); state.picker = false; }
      else if (args.nodeId === 'generate') state.generations++;
      else assert.fail('unexpected press: ' + args.nodeId);
      return { performed: true };
    }
    assert.fail('unexpected command: ' + command);
  }, async close() {} };
  const accounts = { async acquireGenerationBrowser(accountId, { signal, resolveReuseExternal } = {}) { if (resolveReuseExternal) await resolveReuseExternal({ signal }); return { accountId, pid: 123, email: 'test@example.invalid' }; }, async releaseGenerationBrowser() { state.releases++; } };
  const transport = createBrowserTransport({ native, accounts });
  t.after(() => transport.close()); return { state, transport };
}

test('native prepare attaches only exact ordered uploaded assets then submit rechecks identities', async t => {
  const { state, transport } = flow(t), refs = [image(), image(1, '2'.repeat(64))];
  const prepared = await transport.prepare(input(refs));
  assert.deepEqual(prepared.images, refs);
  assert.equal(prepared.settings.method, 'ingredients');
  assert.deepEqual(state.chips, refs.map(ref => ref.sha256));
  assert.equal(state.generations, 0);
  assert.ok(!Object.keys(prepared).some(key => /fingerprint/i.test(key)));
  const beforeSubmitReads = state.calls.filter(call => call.command === 'readIngredientFingerprint').length;
  let saved = false;
  const submitted = await transport.submit(prepared, { beforeSubmit: async () => { saved = true; assert.equal(state.generations, 0); } });
  assert.equal(saved, true); assert.equal(submitted.submitted, true); assert.equal(state.generations, 1);
  assert.equal(state.calls.filter(call => call.command === 'readIngredientFingerprint').length - beforeSubmitReads, 8);
  await assert.rejects(transport.submit(prepared, { beforeSubmit: async () => {} }), { code: 'SUBMIT_ALREADY_ATTEMPTED' });
});

test('submit blocks removed, replaced and reordered ingredients including changes after durable save', async t => {
  for (const mutate of [state => { state.chips.pop(); }, state => { state.chips[0] = '3'.repeat(64); }, state => { state.chips.reverse(); }]) {
    const { state, transport } = flow(t), prepared = await transport.prepare(input([image(), image(1, '2'.repeat(64))]));
    await assert.rejects(transport.submit(prepared, { beforeSubmit: async () => mutate(state) }), error => ['COMPOSER_NOT_VERIFIED', 'INGREDIENT_MISMATCH'].includes(error.code));
    assert.equal(state.generations, 0);
  }
});

test('changed ingredient fails first submit check before durable save', async t => {
  const { state, transport } = flow(t), prepared = await transport.prepare(input([image()]));
  state.chips[0] = '7'.repeat(64); let saved = false;
  await assert.rejects(transport.submit(prepared, { beforeSubmit: async () => { saved = true; } }), { code: 'INGREDIENT_MISMATCH' });
  assert.equal(saved, false); assert.equal(state.generations, 0);
});

test('new reference waits for three stable screen samples after thumbnail reflow before pinning', async t => {
  const { state, transport } = flow(t, { onFingerprint(state) {
    return { method: 'screen', fingerprint: state.fingerprintReads.length === 1 ? '0'.repeat(64) : SHA };
  } });
  const prepared = await transport.prepare(input([image()]));
  assert.equal(prepared.readyToSubmit, true); assert.equal(state.generations, 0);
  assert.equal(state.fingerprintReads.length, 6);
  assert.equal(state.calls.filter(call => call.command === 'chooseFile').length, 1);
});

test('new reference may settle from screen to native-image only before initial pin', async t => {
  const options = { onFingerprint(state) { return { method: state.fingerprintReads.length === 1 || options.afterPin ? 'screen' : 'native-image', fingerprint: SHA }; } };
  const { state, transport } = flow(t, options), prepared = await transport.prepare(input([image()]));
  assert.equal(prepared.readyToSubmit, true); assert.equal(state.fingerprintReads.length, 6);
  options.afterPin = true; let saved = false;
  await assert.rejects(transport.submit(prepared, { beforeSubmit: async () => { saved = true; } }), error => {
    assert.equal(error.code, 'INGREDIENT_MISMATCH');
    assert.deepEqual(error.ingredientEvidence, { actualCount: 1, expectedCount: 1, methodsChanged: true, fingerprintsChanged: false });
    assert.equal(Object.keys(error.ingredientEvidence).length, 4);
    assert.ok(error.message.startsWith('Изображения или порядок ингредиентов Flow изменились. Подготовьте запрос заново. '));
    assert.ok(error.message.endsWith(JSON.stringify(error.ingredientEvidence)));assert.equal(Object.isFrozen(error.ingredientEvidence),true);
    assert.equal(error.message.includes(SHA),false);assert.equal(error.message.includes('Exact test prompt'),false);assert.equal(error.message.includes('test@example.invalid'),false);assert.equal(error.message.includes('/private/'),false);return true;
  });
  assert.equal(saved, false); assert.equal(state.generations, 0);
});

test('reference stabilization never repins a changed previous reference while adding next image', async t => {
  const { state, transport } = flow(t, { onFingerprint(state, index) {
    return { method: 'native-image', fingerprint: state.chips.length === 2 && index === 0 ? '9'.repeat(64) : state.chips[index] };
  } });
  await assert.rejects(transport.prepare(input([image(), image(1, '2'.repeat(64))])), error => {
    assert.equal(error.code, 'INGREDIENT_MISMATCH');
    assert.deepEqual(error.ingredientEvidence, { actualCount: 1, expectedCount: 1, methodsChanged: false, fingerprintsChanged: true });
    return true;
  });
  assert.equal(state.fingerprintReads.filter(item => item.count === 2).length, 2);
  assert.equal(state.releases, 1); assert.equal(state.generations, 0);
});

test('fingerprint change after initial stable pin fails preparation without another settling window', async t => {
  const { state, transport } = flow(t, { onFingerprint(state) {
    return { method: 'screen', fingerprint: state.fingerprintReads.length <= 3 ? SHA : '8'.repeat(64) };
  } });
  await assert.rejects(transport.prepare(input([image()])), error => {
    assert.equal(error.code, 'INGREDIENT_MISMATCH');
    assert.deepEqual(error.ingredientEvidence, { actualCount: 1, expectedCount: 1, methodsChanged: false, fingerprintsChanged: true });
    assert.equal(JSON.stringify(error.ingredientEvidence).includes(SHA), false); assert.equal(error.message.includes('8'.repeat(64)),false); return true;
  });
  assert.equal(state.fingerprintReads.length, 4); assert.equal(state.releases, 1); assert.equal(state.generations, 0);
});

test('reference that never stabilizes times out within bounded samples without preparing or generating', async t => {
  const { state, transport } = flow(t, { onFingerprint(state) {
    return { method: 'screen', fingerprint: (state.fingerprintReads.length % 2 ? '1' : '2').repeat(64) };
  } });
  await assert.rejects(transport.prepare(input([image()])), error => {
    assert.equal(error.code,'INGREDIENT_NOT_VERIFIED');
    assert.equal(error.ingredientEvidence.sampleCount,state.fingerprintReads.length);
    assert.equal(error.ingredientEvidence.maxStableSamples,1);assert.equal(error.ingredientEvidence.methodTransitions,0);
    assert.equal(error.ingredientEvidence.fingerprintTransitions,state.fingerprintReads.length-1);
    assert.ok(error.ingredientEvidence.elapsedMs>=5000);assert.ok(Object.values(error.ingredientEvidence).every(value=>Number.isSafeInteger(value)&&value>=0));
    assert.equal(Object.isFrozen(error.ingredientEvidence),true);assert.ok(error.message.endsWith(JSON.stringify(error.ingredientEvidence)));
    assert.equal(error.message.includes(SHA),false);assert.equal(error.message.includes('2'.repeat(64)),false);assert.equal(error.message.includes('Exact test prompt'),false);
    return true;
  });
  assert.ok(state.fingerprintReads.length >= 3 && state.fingerprintReads.length <= 21);
  assert.equal(state.releases, 1); assert.equal(state.generations, 0);
});

test('slow identical fingerprint samples report timing budget exhaustion without claiming transitions', async t => {
  const originalNow=Date.now;let now=0;Date.now=()=>now;
  try{
    const {state,transport}=flow(t,{onSnapshot(state){if(state.chips.length)now+=1400;},onFingerprint(){now+=300;return {method:'screen',fingerprint:SHA};}});
    await assert.rejects(transport.prepare(input([image()])),error=>{
      assert.equal(error.code,'INGREDIENT_NOT_VERIFIED');
      assert.deepEqual(error.ingredientEvidence,{sampleCount:3,maxStableSamples:3,elapsedMs:5100,totalSnapshotMs:4200,totalFingerprintMs:900,methodTransitions:0,fingerprintTransitions:0});
      assert.equal(Object.isFrozen(error.ingredientEvidence),true);assert.ok(error.message.endsWith(JSON.stringify(error.ingredientEvidence)));
      assert.equal(error.message.includes(SHA),false);assert.equal(error.message.includes('/private/'),false);assert.equal(error.message.includes('test@example.invalid'),false);
      return true;
    });
    assert.equal(state.fingerprintReads.length,3);assert.equal(state.releases,1);assert.equal(state.generations,0);
  }finally{Date.now=originalNow;}
});

test('foreign drafts, preexisting names and unverified chooser or chip fail without generation', async t => {
  const cases = [
    [{ initialChips: [SHA] }, 'COMPOSER_NOT_VERIFIED'],
    [{ initialAssets: [{ name: image().name, sha256: SHA }] }, 'INGREDIENT_NAME_EXISTS'],
    [{ badChoice: true }, 'FILE_NOT_VERIFIED'], [{ badFingerprint: true }, 'INGREDIENT_NOT_VERIFIED'],
  ];
  for (const [options, code] of cases) {
    const { state, transport } = flow(t, options);
    await assert.rejects(transport.prepare(input([image()])), { code });
    assert.equal(state.generations, 0); assert.equal(state.releases, 1);
  }
});

test('wrong names and uploading assets never get selected', async t => {
  for (const mode of ['wrongAssetName', 'progress']) {
    const controller = new AbortController();
    const { state, transport } = flow(t, { [mode]: true, onSnapshot(state) { if (state.picker && state.assets.length) controller.abort(); } });
    await assert.rejects(transport.prepare(input([image()]), controller.signal), { code: 'REQUEST_CANCELLED' });
    assert.equal(state.chips.length, 0); assert.equal(state.generations, 0);
    assert.ok(!state.calls.some(call => call.command === 'press' && call.args.nodeId.startsWith('asset-')));
  }
});

test('text preparation keeps empty ingredients and never opens chooser', async t => {
  const { state, transport } = flow(t), prepared = await transport.prepare(input([]));
  assert.equal(prepared.settings.method, 'text'); assert.deepEqual(prepared.images, []);
  await transport.submit(prepared, { beforeSubmit: async () => {} });
  assert.equal(state.generations, 1);
  assert.ok(!state.calls.some(call => ['chooseFile', 'readIngredientFingerprint'].includes(call.command)));
});

test('duration uses focused native Home and Right keys rather than AXValue setter', async t => {
  for (const duration of [3, 10, 15]) {
    const { state, transport } = flow(t, { duration: duration === 3 ? 12 : 0 });
    const prepared = await transport.prepare({ ...input([]), model: `omni-1.2-flash-${duration}s-landscape` });
    assert.equal(prepared.settings.duration, duration); assert.equal(state.duration, String(duration - 3));
    const keys = state.calls.filter(call => call.command === 'key' && call.args.key !== 'escape').map(call => call.args.key);
    assert.deepEqual(keys, ['home', ...Array(duration - 3).fill('right')]);
    assert.equal(state.calls.filter(call => call.command === 'focus').length, duration - 2);
    assert.ok(!state.calls.some(call => call.command === 'setValue' && call.args.nodeId.startsWith('duration@')));
    assert.equal(state.generations, 0);
  }
});

test('unconfirmed slider focus stops before any duration keys', async t => {
  const { state, transport } = flow(t, { duration: 0, badFocus: true });
  await assert.rejects(transport.prepare(input([])), { code: 'FOCUS_FAILED' });
  assert.ok(!state.calls.some(call => call.command === 'key'));
  assert.equal(state.generations, 0); assert.equal(state.releases, 1);
});

test('exact multiline textarea accepts paragraph text only within its own descendants', async t => {
  const { state, transport } = flow(t, { paragraphs: true });
  const prompt = 'First paragraph.\n\nSecond paragraph with exact text.\n\nТретий абзац.';
  const prepared = await transport.prepare({ ...input([]), prompt });
  assert.equal(prepared.prompt, prompt); assert.equal(state.prompt, prompt);
  await transport.submit(prepared, { beforeSubmit: async () => {} });
  assert.equal(state.generations, 1);
});

test('multiline validation rejects foreign descendant text and prompt-like text outside textarea', async t => {
  for (const options of [{ paragraphs: true, foreignPromptText: true }, { paragraphs: true, outsidePromptText: true }]) {
    const { state, transport } = flow(t, options);
    await assert.rejects(transport.prepare({ ...input([]), prompt: 'First paragraph.\n\nSecond paragraph.' }), { code: 'COMPOSER_NOT_VERIFIED' });
    assert.equal(state.generations, 0);
  }
});

test('paragraph children never override changed authoritative full textarea value', async t => {
  const { state, transport } = flow(t, { paragraphs: true });
  const prepared = await transport.prepare({ ...input([]), prompt: 'First paragraph.\n\nSecond paragraph.' });
  state.prompt += '\nUnexpected text'; let saved = false;
  await assert.rejects(transport.submit(prepared, { beforeSubmit: async () => { saved = true; } }), { code: 'PROMPT_MISMATCH' });
  assert.equal(saved, false); assert.equal(state.generations, 0);
});

test('upload completes before sole model OCR gate and OCR failure issues no prepared plan', async t => {
  const { state, transport } = flow(t, { badModel: true });
  await assert.rejects(transport.prepare(input([image()])), { code: 'MODEL_NOT_VERIFIED' });
  assert.deepEqual(state.chips, [SHA]);
  assert.equal(state.releases, 1); assert.equal(state.generations, 0);
  const commands = state.calls.map(call => call.command);
  assert.equal(commands.filter(command => command === 'readLabel').length, 1);
  assert.ok(commands.indexOf('chooseFile') < commands.indexOf('readLabel'));
});

test('final gate rechecks settings changed after reference attachment', async t => {
  const { state, transport } = flow(t, { onSnapshot(state) { if (state.chips.length) state.radio.set('16:9', '0'); } });
  await assert.rejects(transport.prepare(input([image()])), { code: 'SETTINGS_MISMATCH' });
  assert.deepEqual(state.chips, [SHA]);
  assert.equal(state.releases, 1); assert.equal(state.generations, 0);
});

test('settings close through exact observed toggle without unreliable Escape keys', async t => {
  const { state, transport } = flow(t), prepared = await transport.prepare(input([image()]));
  assert.equal(state.settings, false);
  await transport.submit(prepared, { beforeSubmit: async () => {} });
  assert.equal(state.settings, false); assert.equal(state.generations, 1);
  assert.equal(state.calls.filter(call => call.command === 'press' && call.args.nodeId.startsWith('trigger@')).length, 8);
  assert.ok(!state.calls.some(call => call.command === 'key' && ['escape', 'esc'].includes(call.args.key)));
});

test('exact uploaded image preview proves choice when AXSelected is absent', async t => {
  const { state, transport } = flow(t, { selectedAbsent: true });
  const prepared = await transport.prepare(input([image()]));
  assert.deepEqual(state.chips, [SHA]); assert.equal(prepared.readyToSubmit, true);
  assert.equal(state.generations, 0);
});

test('foreign preview, foreign selected asset and video preview block adding image', async t => {
  const originalNow = Date.now; let now = 0;
  Date.now = () => now += 10001;
  try {
    for (const options of [{ wrongPreview: true }, { initialAssets: [{ name: 'foreign.png', sha256: '9'.repeat(64) }], foreignSelected: true }, { videoPreview: true }]) {
      const { state, transport } = flow(t, options);
      await assert.rejects(transport.prepare(input([image()])), error => error.code === 'UI_STATE_TIMEOUT' && error.message.includes('выбор загруженного изображения'));
      assert.deepEqual(state.chips, []); assert.equal(state.generations, 0);
      assert.ok(!state.calls.some(call => call.command === 'press' && call.args.nodeId.startsWith('add-to-prompt@')));
    }
  } finally { Date.now = originalNow; }
});

test('stale preview waits for exact newly selected image before adding', async t => {
  const { state, transport } = flow(t, { previewDelayReads: 2 });
  const prepared = await transport.prepare(input([image()]));
  assert.equal(prepared.readyToSubmit, true); assert.deepEqual(state.chips, [SHA]);
  assert.equal(state.calls.filter(call => call.command === 'press' && call.args.nodeId.startsWith('add-to-prompt@')).length, 1);
  assert.equal(state.generations, 0);
});

test('AXSelected alone never substitutes for exact image preview', async t => {
  const controller = new AbortController();
  const { state, transport } = flow(t, { noPreview: true, onSnapshot(state) { if (state.picker && state.selected !== null) controller.abort(); } });
  await assert.rejects(transport.prepare(input([image()]), controller.signal), { code: 'REQUEST_CANCELLED' });
  assert.deepEqual(state.chips, []); assert.equal(state.generations, 0);
  assert.ok(!state.calls.some(call => call.command === 'press' && call.args.nodeId.startsWith('add-to-prompt@')));
});

test('account verification uses separate observed open and close buttons once per check', async t => {
  const { state, transport } = flow(t), lease = await transport.open(7, { expectedEmail: 'test@example.invalid' });
  const result = await transport.inspect(7, { lease });
  assert.equal(result.accountMatch, true); assert.equal(state.panel, false);
  const presses = state.calls.filter(call => call.command === 'press');
  assert.equal(presses.length, 2);
  assert.ok(presses[0].args.nodeId.startsWith('account@'));
  assert.ok(presses[1].args.nodeId.startsWith('close-panel@'));
  assert.ok(!presses.some(call => /switch|recovery/.test(call.args.nodeId)));
  assert.equal(state.generations, 0);
});

test('wrong account identity stops before closing or continuing from account panel', async t => {
  const { state, transport } = flow(t, { accountEmail: 'other@example.invalid' });
  await assert.rejects(transport.prepare(input([])), { code: 'ACCOUNT_MISMATCH' });
  const presses = state.calls.filter(call => call.command === 'press');
  assert.equal(presses.length, 1); assert.ok(presses[0].args.nodeId.startsWith('account@'));
  assert.equal(state.panel, true); assert.equal(state.releases, 1); assert.equal(state.generations, 0);
});

test('account panel value field identifies exact group and retains scoped email verification', async t => {
  const { state, transport } = flow(t, { accountPanelValueOnly: true });
  const prepared = await transport.prepare(input([]));
  assert.equal(prepared.readyToSubmit, true); assert.equal(state.panel, false); assert.equal(state.generations, 0);
});

test('account timeout evidence contains only fixed labels roles fields and counts', async t => {
  const originalNow = Date.now; let now = 0;
  Date.now = () => now += 10001;
  try {
    const secret = 'private-identity@example.invalid';
    const { state, transport } = flow(t, { accountPanelRole: 'AXUnknown', accountPanelValueOnly: true, accountEmail: secret });
    await assert.rejects(transport.prepare({ ...input([]), prompt: 'Private prompt should stay private' }), error => {
      assert.equal(error.code, 'UI_STATE_TIMEOUT'); assert.ok(error.message.includes('открытие панели аккаунта'));
      assert.deepEqual(error.accountEvidence, {
        accountGroups: 0, closeButtons: 1, accountInfoButtons: 1,
        namedAccountNodes: [
          { role: 'AXButton', fields: ['title'], names: ['Сведения об аккаунте'] },
          { role: 'AXUnknown', fields: ['value'], names: ['Настройки аккаунта'] },
          { role: 'AXButton', fields: ['title'], names: ['Закрыть панель аккаунта'] },
        ],
      });
      assert.ok(!error.message.includes(secret)); assert.ok(!error.message.includes('Private prompt'));
      assert.ok(!JSON.stringify(error.accountEvidence).includes(secret)); return true;
    });
    assert.equal(state.generations, 0); assert.equal(state.releases, 1);
  } finally { Date.now = originalNow; }
});


test('inspect exposes only allowlisted numeric snapshot counters', async t => {
  const originalNow = Date.now; let now = 0;
  Date.now = () => now += 10001;
  try {
    const { state, transport } = flow(t, { accountPanelRole: 'AXUnknown', onSnapshot(state, result) {
      result.diagnostics = { attempted: 20, emitted: 18, unequalHashCollisions: 2, childrenErrors: 0,
        ownerErrors: -1, hashRepeats: 'private@example.invalid', secret: 'private prompt', webareas: ['private'] };
    } });
    const result = await transport.inspect(7, { expectedEmail: 'test@example.invalid' });
    assert.equal(result.accountMatch, false); assert.equal(result.reason, 'UI_STATE_TIMEOUT');
    assert.deepEqual(result.diagnostics.scan, { attempted: 20, emitted: 18, unequalHashCollisions: 2, childrenErrors: 0 });
    assert.ok(!JSON.stringify(result.diagnostics).includes('private'));
    assert.equal(state.generations, 0); assert.equal(state.releases, 1);
  } finally { Date.now = originalNow; }
});

function discovery(t, results, external = false) {
  const state = { acquisitions: 0, releases: 0, reads: 0, calls: [], reserved: false };
  const native = { async call(command) {
    state.calls.push(command);
    if (command === 'status') return { trusted: true, locked: false };
    if (command === 'locateFlow') { assert.equal(state.reserved, true, 'discovery must run within account manager generation reservation'); return results[Math.min(state.reads++, results.length - 1)]; }
    if (['focusFlow', 'activateAccessibility'].includes(command)) return {};
    assert.fail('unexpected discovery command: ' + command);
  }, async close() {} };
  const accounts = { async acquireGenerationBrowser(accountId, { signal, resolveReuseExternal } = {}) { state.acquisitions++; state.reserved = true; try { await resolveReuseExternal({ signal }); } catch (error) { state.reserved = false; throw error; } return { accountId, pid: 123, email: 'test@example.invalid', external }; }, async releaseGenerationBrowser() { state.releases++; state.reserved = false; } };
  const transport = createBrowserTransport({ native, accounts });
  t.after(() => transport.close()); return { state, transport };
}

test('discovery ambiguity reports safe counts without candidate titles URLs or process IDs', async t => {
  for (const pids of [[123, 123], [123, 456]]) {
    const result = { candidates: pids.map(pid => ({ pid, title: 'private account', documentURL: 'https://flow.google.com/project/private' })), windowsChecked: 3, chromeProcesses: 2, duplicateWindowEntries: 1 };
    const { state, transport } = discovery(t, [result]);
    await assert.rejects(transport.open(7), error => {
      assert.equal(error.code, 'FLOW_WINDOW_AMBIGUOUS');
      assert.deepEqual(error.discoveryEvidence, { candidates: 2, distinctPids: new Set(pids).size, windowsChecked: 3, chromeProcesses: 2, duplicateWindowEntries: 1 });
      assert.ok(error.message.includes(JSON.stringify(error.discoveryEvidence)));
      assert.ok(!/private|123|456|https:/.test(error.message)); return true;
    });
    assert.equal(state.acquisitions, 1); assert.equal(state.reserved, false); assert.deepEqual(state.calls, ['status', 'locateFlow']);
  }
});

test('discovery evidence omits invalid and unknown helper metadata', async t => {
  const { transport } = discovery(t, [{ candidates: [{ pid: 123 }, { pid: 123 }, { pid: 'private' }], windowsChecked: -1, chromeProcesses: 'private', secret: 'private' }]);
  await assert.rejects(transport.open(7), error => {
    assert.deepEqual(error.discoveryEvidence, { candidates: 3, distinctPids: 1 });
    assert.ok(!error.message.includes('private')); return true;
  });
});

test('external discovery ambiguity includes final counts and releases acquired browser', async t => {
  const { state, transport } = discovery(t, [{ candidates: [] }, { candidates: [{ pid: 123 }, { pid: 456 }], windowsChecked: 4, chromeProcesses: 2 }], true);
  await assert.rejects(transport.open(7), error => {
    assert.equal(error.code, 'FLOW_WINDOW_AMBIGUOUS');
    assert.deepEqual(error.discoveryEvidence, { candidates: 2, distinctPids: 2, windowsChecked: 4, chromeProcesses: 2 }); return true;
  });
  assert.equal(state.acquisitions, 1); assert.equal(state.releases, 1); assert.equal(state.reads, 2);
  assert.ok(!state.calls.includes('focusFlow'));
});

test('external discovery reports zero accessible windows separately from ambiguity', async t => {
  const { state, transport } = discovery(t, [{ candidates: [], windowsChecked: 2, chromeProcesses: 1 }], true);
  await assert.rejects(transport.open(7), error => {
    assert.equal(error.code, 'FLOW_WINDOW_UNAVAILABLE');
    assert.deepEqual(error.discoveryEvidence, { candidates: 0, distinctPids: 0, windowsChecked: 2, chromeProcesses: 1 }); return true;
  });
  assert.equal(state.acquisitions, 1); assert.equal(state.releases, 1); assert.equal(state.reads, 21);
  assert.ok(!state.calls.includes('focusFlow'));
});
