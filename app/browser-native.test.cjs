'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { NativeBrowser, createBrowserTransport, validateTarget, findUnique, inputPlan } = require('./browser-native.cjs');

function helper() {
  const child = new EventEmitter(), requests = [], options = [];
  child.stdout = new PassThrough(); child.killed = false; child.exitCode = null;
  child.stdin = new Writable({ write(chunk, _encoding, done) { requests.push(JSON.parse(chunk.toString())); done(); } });
  child.kill = () => { child.killed = true; child.emit('close', null, 'SIGTERM'); return true; };
  const native = new NativeBrowser({ binaryPath: '/test/flow-browser', spawn: (...args) => { options.push(args); return child; } });
  const reply = (result, id = requests.at(-1).id) => child.stdout.write(JSON.stringify({ id, result }) + '\n');
  return { native, child, requests, options, reply };
}
function snapshot() {
  return { pid: 42, documentURL: 'https://flow.google.com/project/project-123', truncated: false, window: { role: 'AXWindow', title: 'Flow' }, nodes: [
    { id: 'account', role: 'AXButton', description: 'Google Account: Test (test@example.com)', enabled: true, actions: ['AXPress'] },
    { id: 'prompt', role: 'AXTextArea', title: 'Observed prompt', value: 'hello', enabled: true, actions: ['AXSetValue'] },
    { id: 'submit', role: 'AXButton', title: 'Observed submit', enabled: true, actions: ['AXPress'] },
  ] };
}
const pin = { pid: 42, expectedEmail: 'test@example.com', accountControl: { role: 'AXButton', description: 'Google Account: Test (test@example.com)' } };
const input = { accountId: 1, expectedEmail: 'test@example.com', model: 'omni-1.2-flash-8s-landscape', prompt: 'A red kite', images: [] };
function transportHarness({ trusted = true, locked = false, state = snapshot(), acquire } = {}) {
  const calls = [], released = [], acquired = [], handle = Object.freeze({ pid: 42, accountId: 1, email: 'test@example.com' });
  const native = { async call(command, args) { calls.push({ command, args }); return command === 'snapshot' ? state : command === 'status' ? { trusted, locked } : { trusted }; }, async close() { calls.push({ command: 'close' }); } };
  const accounts = { async acquireGenerationBrowser(id, options) { acquired.push({ id, options }); return acquire ? acquire(id, options) : handle; }, async releaseGenerationBrowser(lease) { released.push(lease); } };
  return { transport: createBrowserTransport({ native, accounts }), calls, released, acquired, handle };
}

test('native helper uses bounded flat JSON-lines, split UTF-8, and silent stderr', async () => {
  const { native, child, requests, options, reply } = helper();
  const result = native.status();
  assert.deepEqual(requests, [{ id: '1', command: 'status' }]);
  assert.deepEqual(options[0], ['/test/flow-browser', [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false }]);
  reply({ trusted: true, locked: false });
  assert.deepEqual(await result, { trusted: true, locked: false });
  const next = native.call('snapshot', { pid: 42 });
  const data = Buffer.from(JSON.stringify({ id: '2', result: { text: 'тест' } }) + '\n');
  const split = data.indexOf(Buffer.from('т')) + 1; child.stdout.write(data.subarray(0, split)); child.stdout.write(data.subarray(split));
  assert.deepEqual(await next, { text: 'тест' });
  await native.close(); assert.equal(child.killed, true);
  await assert.rejects(native.status(), { code: 'NATIVE_CLOSED' });
});

test('native helper preserves typed errors and rejects unsupported commands before spawn', async () => {
  const mock = helper();
  for (const [command, args] of [
    ['status', { command: 'press' }], ['snapshot', { pid: -1 }], ['press', { pid: 42, nodeId: '' }],
    ['setValue', { pid: 42, nodeId: 'x', value: 'a'.repeat(20001) }], ['text', { pid: 42, text: '\0' }],
    ['key', { pid: 42, key: 'l', modifiers: ['command'] }], ['key', { pid: 42, key: 'g', modifiers: ['command', 'command'] }], ['key', { pid: 42, key: 'TAB' }],
    ['fetch', {}], ['__proto__', {}],
  ]) await assert.rejects(mock.native.call(command, args), { code: 'INVALID_ARGUMENTS' });
  await assert.rejects(mock.native.call('text', { pid: 42, text: '\n'.repeat(20000) }, { timeoutMs: Infinity }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(mock.options.length, 0);
  const pending = mock.native.call('press', { pid: 42, nodeId: 'current-node' });
  mock.child.stdout.write(JSON.stringify({ id: '1', error: { code: 'STALE_NODE', message: 'Элемент устарел.' } }) + '\n');
  await assert.rejects(pending, { code: 'STALE_NODE', message: 'Элемент устарел.' });
  const again = mock.native.status(); mock.reply({ trusted: false, locked: false }); await again;
  await mock.native.close();
});

test('single in-flight request, timeout, abort, and close clean pending work without retry', async () => {
  const busy = helper(), pending = busy.native.status();
  await assert.rejects(busy.native.status(), { code: 'NATIVE_BUSY' });
  assert.equal(busy.requests.length, 1); busy.reply({ trusted: true }); await pending; await busy.native.close();
  const timed = helper(); await assert.rejects(timed.native.call('status', {}, { timeoutMs: 5 }), { code: 'NATIVE_TIMEOUT' });
  assert.equal(timed.child.killed, true); assert.equal(timed.native.pending, null);
  await assert.rejects(timed.native.status(), { code: 'NATIVE_CLOSED' });
  const aborted = helper(), controller = new AbortController();
  const task = aborted.native.status({ signal: controller.signal }); controller.abort();
  await assert.rejects(task, { code: 'REQUEST_CANCELLED' }); assert.equal(aborted.child.killed, true);
  const already = helper(); await assert.rejects(already.native.status({ signal: controller.signal }), { code: 'REQUEST_CANCELLED' }); assert.equal(already.options.length, 0);
  const closing = helper(), closingTask = closing.native.status(); await closing.native.close();
  await assert.rejects(closingTask, { code: 'NATIVE_CLOSED' }); assert.equal(closing.native.pending, null);
});

test('helper protocol rejects mismatched IDs, malformed output, oversize, and crash', async () => {
  for (const response of ['not json\n', JSON.stringify({ id: 'other', result: {} }) + '\n', JSON.stringify({ id: '1', result: {}, error: {} }) + '\n', JSON.stringify({ id: '1', error: { code: 'bad code', message: 'unsafe' } }) + '\n']) {
    const mock = helper(), pending = mock.native.status(); mock.child.stdout.write(response);
    await assert.rejects(pending, { code: 'NATIVE_PROTOCOL' }); assert.equal(mock.child.killed, true);
  }
  const oversized = helper(), pending = oversized.native.status(); oversized.child.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(pending, { code: 'NATIVE_RESPONSE_TOO_LARGE' });
  const largeInput = helper(); await assert.rejects(largeInput.native.call('text', { pid: 42, text: '\x01'.repeat(20000) }), { code: 'NATIVE_REQUEST_TOO_LARGE' }); assert.equal(largeInput.options.length, 0);
  const crashed = helper(), crashTask = crashed.native.status(); crashed.child.emit('close', 1);
  await assert.rejects(crashTask, { code: 'NATIVE_CLOSED' });
  const failed = helper(), failedTask = failed.native.status(); failed.child.emit('error', new Error('secret path'));
  await assert.rejects(failedTask, error => error.code === 'NATIVE_UNAVAILABLE' && !error.message.includes('secret'));
});

test('semantic controls require exact, unique, enabled matches from complete snapshot', () => {
  const state = snapshot();
  assert.equal(findUnique(state, { role: 'AXTextArea', title: 'Observed prompt', action: 'AXSetValue' }).id, 'prompt');
  assert.throws(() => findUnique(state, { role: 'AXButton' }), { code: 'CONTROL_AMBIGUOUS' });
  assert.throws(() => findUnique(state, { title: 'prompt' }), { code: 'CONTROL_NOT_FOUND' });
  assert.throws(() => findUnique(state, { enabled: true }), { code: 'INVALID_ARGUMENTS' });
  state.nodes[1].enabled = false;
  assert.throws(() => findUnique(state, { id: 'prompt' }), { code: 'CONTROL_NOT_FOUND' });
  assert.equal(findUnique(state, { id: 'prompt', enabled: false }).id, 'prompt');
  state.truncated = true; assert.throws(() => findUnique(state, { id: 'prompt' }), { code: 'SNAPSHOT_INCOMPLETE' });
});

test('target guard pins process, HTTPS Flow project and observed account evidence', () => {
  assert.deepEqual(validateTarget(snapshot(), pin), { pid: 42, accountMatch: true, projectURL: 'https://flow.google.com/project/project-123' });
  assert.throws(() => validateTarget(snapshot(), { ...pin, pid: 43 }), { code: 'TARGET_CHANGED' });
  assert.throws(() => validateTarget(snapshot(), { ...pin, expectedEmail: 'other@example.com' }), { code: 'ACCOUNT_MISMATCH' });
  assert.throws(() => validateTarget(snapshot(), { ...pin, projectURL: 'https://flow.google.com/project/other' }), { code: 'TARGET_CHANGED' });
  assert.throws(() => validateTarget(snapshot(), { pid: 42, expectedEmail: pin.expectedEmail }), { code: 'ACCOUNT_NOT_VERIFIED' });
  const spoof = snapshot(); spoof.nodes[0].description = 'Google Account: Other (other@example.com)'; spoof.nodes[1].value = pin.expectedEmail;
  assert.throws(() => validateTarget(spoof, { ...pin, accountControl: { id: 'account' } }), { code: 'ACCOUNT_MISMATCH' });
  for (const documentURL of ['https://flow.google.com/projects', 'https://flow.google.com.evil/project/id', 'http://flow.google.com/project/id', 'https://test:secret@flow.google.com/project/id', 'https://flow.google.com/project/id?x=secret', 'https://flow.google.com/project/../projects']) assert.throws(() => validateTarget({ ...snapshot(), documentURL }, pin), { code: 'FLOW_PROJECT_REQUIRED' });
  const duplicate = snapshot(); duplicate.nodes.push({ ...duplicate.nodes[0] }); assert.throws(() => validateTarget(duplicate, pin), { code: 'SNAPSHOT_INVALID' });
});

test('text plan keeps original prompt/model and rejects unsupported modes or changed settings', () => {
  const plan = inputPlan({ ...input, prompt: '  Exact prompt\n' });
  assert.equal(plan.prompt, '  Exact prompt\n'); assert.equal(plan.model, input.model);
  assert.deepEqual(plan.settings, { method: 'text', duration: 8, aspect: '16:9', resolution: 'standard' });
  assert.deepEqual(inputPlan({ ...input, model: 'omni-1.2-flash-15s-portrait-360p' }).settings, { method: 'text', duration: 15, aspect: '9:16', resolution: '360p' });
  assert.equal(inputPlan({ ...input, model: 'omni-1.2-flash' }).settings.duration, 8);
  for (const model of ['omni-1.1-flash-8s-landscape', 'veo-3.1-fast-8s-landscape', 'omni-1.2-flash-i2v-8s-landscape', 'omni-1.2-flash-16s-landscape', 'omni-1.2-flash-08s-landscape', 'omni-1.2-flash-8s-square']) assert.throws(() => inputPlan({ ...input, model }), { code: 'MODEL_UNSUPPORTED' });
  assert.throws(() => inputPlan({ ...input, images: ['/private/image.png'] }), { code: 'INVALID_ARGUMENTS' });
  const image={path:'/private/ref-aaaaaaaaaaaaaaaa-0-0123abcd.png',name:'ref-aaaaaaaaaaaaaaaa-0-0123abcd.png',sha256:'a'.repeat(64)};
  const withImage=inputPlan({...input,images:[image]});assert.equal(withImage.settings.method,'ingredients');assert.deepEqual(withImage.images,[image]);
  for(const changed of [{path:'relative.png'},{name:'another.png'},{sha256:'b'.repeat(64)},{sha256:'a'.repeat(63)},{cookies:'private'}])assert.throws(()=>inputPlan({...input,images:[{...image,...changed}]}),{code:'INVALID_ARGUMENTS'});
  assert.throws(() => inputPlan({ ...input, settings: { duration: 6 } }), { code: 'SETTINGS_MISMATCH' });
  assert.throws(() => inputPlan({ ...input, settings: { method: 'ingredients' } }), { code: 'SETTINGS_MISMATCH' });
  assert.throws(() => inputPlan({ ...input, sourceVideoId: 'id' }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => inputPlan({ ...input, prompt: ' ' }), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => inputPlan({ ...input, prompt: 'я'.repeat(2001) }), { code: 'PROMPT_TOO_LARGE' });
});

test('status and permission do not acquire a browser; missing trust fails before opening', async () => {
  const h = transportHarness({ trusted: false });
  assert.deepEqual(await h.transport.status(), { available: true, trusted: false, locked: false });
  assert.deepEqual(await h.transport.requestPermission(), { trusted: false }); assert.equal(h.acquired.length, 0);
  await assert.rejects(h.transport.open(1), { code: 'AX_PERMISSION_REQUIRED' }); assert.equal(h.acquired.length, 0);
  const locked = transportHarness({ locked: true }); await assert.rejects(locked.transport.open(1), { code: 'SESSION_LOCKED' }); assert.equal(locked.acquired.length, 0);
});

test('inspection returns counts only, releases owned browser and never submits generation', async () => {
  const h = transportHarness();
  const ready = await h.transport.inspect(1, { expectedEmail: input.expectedEmail, accountControl: pin.accountControl });
  assert.deepEqual(ready, { available: true, trusted: true, locked: false, accountMatch: true, projectURL: snapshot().documentURL, controls: { AXButton: 2, AXTextArea: 1 }, ready: false, reason: 'UI_NOT_VERIFIED', diagnostics: null, failureMessage: null });
  assert.equal(h.released[0], h.handle); assert.equal(h.released.length, 1);
  assert(h.calls.every(call => ['status', 'snapshot','focusFlow','activateAccessibility','locateFlow'].includes(call.command)));
  assert(!JSON.stringify(ready).includes(input.expectedEmail)); assert(!JSON.stringify(ready).includes('Observed prompt'));
  const missing = await h.transport.inspect(1, { expectedEmail: input.expectedEmail });
  assert.equal(missing.accountMatch, false); assert.equal(missing.reason, 'ACCOUNT_NOT_VERIFIED'); assert.equal(h.released.length, 2);
  const invalid = transportHarness({ state: { ...snapshot(), truncated: true } });
  assert.deepEqual((await invalid.transport.inspect(1)).controls, {}); assert.equal(invalid.released.length, 1);
});

test('open keeps original lease identity until explicit release or close', async () => {
  const h = transportHarness(), lease = await h.transport.open(1, { expectedEmail: input.expectedEmail });
  assert.equal(lease, h.handle);
  await assert.rejects(h.transport.open(1), { code: 'BROWSER_BUSY' });
  await h.transport.inspect(1, { lease, accountControl: pin.accountControl }); assert.equal(h.released.length, 0);
  await assert.rejects(h.transport.inspect(1, { lease: { ...lease } }), { code: 'ACCOUNT_MISMATCH' });
  await h.transport.release(lease); await h.transport.release(lease); assert.equal(h.released.length, 1);
  await h.transport.open(1); await h.transport.close(); assert.equal(h.released.length, 2);
  await assert.rejects(h.transport.status(), { code: 'NATIVE_CLOSED' });
  assert.equal(h.calls.at(-1).command, 'close');
});

test('account mismatch and unverified UI release browser; invalid prepare is inert', async () => {
  const mismatch = transportHarness();
  await assert.rejects(mismatch.transport.open(1, { expectedEmail: 'other@example.com' }), { code: 'ACCOUNT_MISMATCH' }); assert.equal(mismatch.released.length, 1);
  const h = transportHarness();
  await assert.rejects(h.transport.prepare(input), { code: 'ACCOUNT_NOT_VERIFIED' }); assert.equal(h.released.length, 1);
  const before = h.calls.length;
  await assert.rejects(h.transport.prepare({ ...input, images: ['image.png'] }), { code: 'INVALID_ARGUMENTS' }); assert.equal(h.calls.length, before);
});

test('closing waits for acquisition cleanup and aborts in-progress browser opening', async () => {
  let finish, acquiredSignal;
  const handle = Object.freeze({ pid: 42, accountId: 1, email: input.expectedEmail });
  const h = transportHarness({ acquire: (_id, { signal }) => { acquiredSignal = signal; return new Promise(resolve => { finish = () => resolve(handle); }); } });
  const opening = h.transport.open(1), rejected = assert.rejects(opening, { code: 'REQUEST_CANCELLED' });
  await new Promise(setImmediate); assert(finish);
  let finished = false; const closing = h.transport.close().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(acquiredSignal.aborted, true); assert.equal(finished, false);
  finish(); await rejected; await closing; assert.equal(h.released[0], handle);
});

function observedUI({ actualEmail = 'Test@Example.com', draft = '\n', chip = false, promptChild, outsideEmail, label = { texts: [], method: 'vision' }, generateError } = {}) {
  let drawer = false, settings = false, menu = false, serial = 0, current = new Map(), duration = '5', focused;
  const radioValues = new Map();
  const calls = [], handle = Object.freeze({ pid: 42, accountId: 1, email: input.expectedEmail }), released = [];
  const node = (role, title, parent, extra = {}) => ({ role, ...(title ? { title } : {}), parent, enabled: true, actions: ['AXPress'], ...extra });
  function state() {
    const prefix = String(++serial) + ':', nodes = [], add = (key, value) => { nodes.push({ id: prefix + key, ...value, ...(value.parent ? { parent: prefix + value.parent } : {}) }); };
    add('account-open', node('AXButton', 'Сведения об аккаунте'));
    if (outsideEmail) add('unrelated-email', node('AXStaticText', undefined, undefined, { value: outsideEmail }));
    if (drawer) {
      add('drawer', node('AXGroup', 'Настройки аккаунта'));
      add('nested', node('AXGroup', undefined, 'drawer')); add('email', node('AXStaticText', undefined, 'nested', { value: actualEmail }));
      add('account-close', node('AXButton', 'Закрыть панель аккаунта', 'drawer'));
    }
    add('composer', node('AXGroup')); add('prompt-wrap', node('AXGroup', undefined, 'composer'));
    add('prompt', node('AXTextArea', 'Что вы хотите создать?', 'prompt-wrap', { description: 'Что вы хотите создать?', settable: true, value: draft }));
    add('prompt-inner', node('AXGroup', undefined, 'prompt', { settable: true }));
    if (draft.trim()) {
      add('prompt-text', node('AXStaticText', undefined, 'prompt-inner', { value: promptChild ?? draft }));
      add('clear', node('AXButton', 'Очистить запрос', 'composer', { description: 'Очистить запрос' }));
    }
    add('ingredients', node('AXPopUpButton', 'Добавить ингредиенты в окно запроса', 'composer'));
    add('agent', node('AXCheckBox', 'Агент', 'composer', { value: '0' }));
    add('settings', node('AXButton', 'Триггер настроек', 'composer'));
    add('generate-wrap', node('AXGroup', undefined, 'composer')); add('generate', node('AXButton', 'Начать генерацию', 'generate-wrap', { enabled: Boolean(draft.trim()) }));
    add('existing-card', node('AXGroup', 'Existing private card title'));
    if (chip) add('chip', node('AXImage', undefined, 'composer', { description: 'uploaded.png' }));
    if (settings) {
      for (const title of ['Видео', 'Ингредиенты', '16:9', '720p', 'x1']) add(title, node('AXRadioButton', title, undefined, { value: radioValues.get(title) ?? '1' }));
      add('model-popup', node('AXPopUpButton', 'Выбрать семейство моделей'));
      add('duration', node('AXSlider', undefined, undefined, { description: 'Длительность', value: duration, settable: true, minValue: 0, maxValue: 12 }));
      if (menu) add('model-item', node('AXMenuItem', 'Omni 1.2 Flash'));
    }
    current = new Map(nodes.map(value => [value.id, value]));
    return { pid: 42, documentURL: 'https://flow.google.com/project/project-123', truncated: false, nodes };
  }
  const native = {
    async call(command, args) {
      calls.push({ command, args });
      if (command === 'status') return { trusted: true, locked: false };
      if (command === 'snapshot') return state();
      if (command === 'readLabel') { assert.equal(current.get(args.nodeId)?.title, 'Выбрать семейство моделей'); if (label instanceof Error) throw label; return label; }
      if (command === 'press' || command === 'setValue') {
        const target = current.get(args.nodeId); assert(target, 'Opaque node ID must come from latest snapshot'); current.clear();
        if (command === 'setValue') { if (target.role === 'AXSlider') duration = args.value; else { assert.equal(target.role, 'AXTextArea'); draft = args.value; } }
        else if (target.title === 'Сведения об аккаунте') drawer = true;
        else if (target.title === 'Закрыть панель аккаунта') drawer = false;
        else if (target.title === 'Триггер настроек') settings = !settings;
        else if (target.title === 'Выбрать семейство моделей') menu = true;
        else if (target.title === 'Omni 1.2 Flash') menu = false;
        else if (target.title === 'Начать генерацию') { if (generateError) throw generateError; }
        else assert.fail('Unexpected UI press: ' + target.title);
      }
      if (command === 'focus') { const target=current.get(args.nodeId);assert(target,'Focus must use latest snapshot node');assert.equal(target.role,'AXSlider');assert.equal(settings,true);focused=target.role; }
      if (command === 'key') { assert.equal(settings,true);assert.equal(focused,'AXSlider');assert.equal(args.modifiers,undefined);assert(['home','right'].includes(args.key));duration=args.key==='home'?'0':String(Number(duration)+1); }
      return { performed: true };
    }, async close() {},
  };
  const accounts = { async acquireGenerationBrowser() { return handle; }, async releaseGenerationBrowser(value) { released.push(value); } };
  return { transport: createBrowserTransport({ native, accounts }), calls, released, drift(values) { if (values.prompt !== undefined) draft = values.prompt; if (values.duration !== undefined) duration = values.duration; if (values.radio) radioValues.set(...values.radio); if (values.label) label = values.label; } };
}

test('inspect verifies only exact email descendant of observed account drawer and closes it', async () => {
  const h = observedUI({ outsideEmail: 'other@example.com' });
  const result = await h.transport.inspect(1);
  assert.equal(result.accountMatch, true); assert.equal(result.reason, 'UI_NOT_VERIFIED'); assert.equal(h.released.length, 1);
  assert.deepEqual(h.calls.filter(call => call.command === 'press').length, 2);
  assert(!JSON.stringify(result).includes('example.com'));
  const mismatch = observedUI({ actualEmail: 'other@example.com', outsideEmail: input.expectedEmail });
  assert.equal((await mismatch.transport.inspect(1)).reason, 'ACCOUNT_MISMATCH');
  assert.equal(mismatch.calls.filter(call => call.command === 'press').length, 1);
});

test('prepare refuses draft and composer attachments before prompt entry and rejects missing final model readback without submitting', async () => {
  for (const [options, code] of [[{ draft: 'my draft' }, 'DRAFT_PRESENT'], [{ chip: true }, 'COMPOSER_NOT_VERIFIED'], [{}, 'MODEL_NOT_VERIFIED']]) {
    const h = observedUI(options); await assert.rejects(h.transport.prepare(input), { code });
    assert.equal(h.released.length, 1); assert.deepEqual(h.calls.filter(call=>call.command==='setValue').map(call=>call.args.value),code==='MODEL_NOT_VERIFIED'?[input.prompt]:[]);
    assert(!h.calls.some(call => call.command === 'press' && String(call.args.nodeId).endsWith(':generate')));
  }
});

test('prepare verifies cropped model label, settings and exact prompt without submitting', async () => {
  const h = observedUI({ label: { texts: ['  Omni 1.2 Flash  '], method: 'vision' } });
  const result = await h.transport.prepare({ ...input, model: 'omni-1.2-flash-10s-landscape', prompt: '  Exact prompt\n' });
  assert.equal(result.readyToSubmit, true); assert.equal(result.prompt, '  Exact prompt\n');
  assert.deepEqual(result.settings, { method: 'text', duration: 10, aspect: '16:9', resolution: 'standard', count: 1, browserModel: 'Omni 1.2 Flash', browserResolution: '720p' });
  assert.equal(h.calls.filter(call => call.command === 'readLabel').length, 1);
  assert.deepEqual(h.calls.filter(call => call.command === 'setValue').map(call => call.args.value), ['  Exact prompt\n']);
  assert.deepEqual(h.calls.filter(call=>call.command==='key').map(call=>call.args.key),['home',...Array(7).fill('right')]);
  assert.equal(h.calls.filter(call=>call.command==='focus').length,8);
  assert(!h.calls.some(call => call.command === 'press' && call.args.nodeId.endsWith(':generate')));
  assert.equal(h.released.length, 0); await h.transport.release(result.lease); assert.equal(h.released.length, 1);
});

test('prepare reuses identical filled draft without typing and rejects wrong text descendants or chips', async () => {
  const label = { texts: ['Omni 1.2 Flash'], method: 'vision' };
  const h = observedUI({ draft: input.prompt, label }), result = await h.transport.prepare(input);
  assert.equal(result.readyToSubmit, true); assert(!h.calls.some(call => call.command === 'setValue'));
  assert(!h.calls.some(call => call.command === 'press' && /:(?:clear|generate)$/.test(call.args.nodeId)));
  await h.transport.release(result.lease);
  for (const options of [{ promptChild: 'unrelated text' }, { chip: true }]) {
    const rejected = observedUI({ draft: input.prompt, label, ...options });
    await assert.rejects(rejected.transport.prepare(input), { code: 'COMPOSER_NOT_VERIFIED' });
    assert(!rejected.calls.some(call => call.command === 'setValue')); assert.equal(rejected.released.length, 1);
  }
});

test('unconfirmed or ambiguous final model OCR and missing screen permission fail before prepared success or Generate', async () => {
  for (const label of [{ texts: ['Omni 1.1 Flash'], method: 'vision' }, { texts: ['Omni 1.2 Flash', 'Omni 1.1 Flash'], method: 'vision' }, { texts: ['Omni 1.2 Flash'], method: 'guess' }, Object.assign(new Error('Нужно разрешение записи экрана.'), { code: 'SCREEN_CAPTURE_REQUIRED' })]) {
    const h = observedUI({ label }); await assert.rejects(h.transport.prepare(input), { code: label instanceof Error ? 'SCREEN_CAPTURE_REQUIRED' : 'MODEL_NOT_VERIFIED' });
    assert.deepEqual(h.calls.filter(call=>call.command==='setValue').map(call=>call.args.value),[input.prompt]);assert.equal(h.released.length,1);
    assert(!h.calls.some(call=>call.command==='press'&&call.args.nodeId.endsWith(':generate')));
  }
});

const validLabel = { texts: ['Omni 1.2 Flash'], method: 'vision' };
const generateCalls = h => h.calls.filter(call => call.command === 'press' && call.args.nodeId.endsWith(':generate'));
test('submit accepts only issued prepared identity and persists before one Generate press', async () => {
  const h = observedUI({ label: validLabel }), prepared = await h.transport.prepare(input), events = [];
  await assert.rejects(h.transport.submit({ ...prepared }, { beforeSubmit() {} }), { code: 'PREPARATION_REQUIRED' });
  let persisted = 0;
  const result = await h.transport.submit(prepared, { async beforeSubmit() { persisted++; assert.equal(generateCalls(h).length, 0); }, onProgress: event => events.push(event.stage) });
  assert.equal(persisted, 1); assert.equal(generateCalls(h).length, 1); assert.equal(result.submitted, true);
  assert.equal(result.projectURL, prepared.projectURL); assert(!('media' in result));
  assert.equal(result.baseline.groupFingerprints.length, 1); assert.match(result.baseline.groupFingerprints[0], /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(result).includes('Existing private card title'));
  assert.deepEqual(events, ['submission-checking', 'submission-attempting', 'submission-attempted']);
  await assert.rejects(h.transport.submit(prepared, { beforeSubmit() { persisted++; } }), { code: 'SUBMIT_ALREADY_ATTEMPTED' });
  assert.equal(persisted, 1); assert.equal(generateCalls(h).length, 1); assert.equal(h.released.length, 0);
  await h.transport.release(prepared.lease);
});

test('failed persistence and cancellation cannot click or reuse prepared submission', async () => {
  const h = observedUI({ label: validLabel }), prepared = await h.transport.prepare(input);
  await assert.rejects(h.transport.submit(prepared, { beforeSubmit() { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } }), { code: 'ENOSPC' });
  assert.equal(generateCalls(h).length, 0);
  await assert.rejects(h.transport.submit(prepared, { beforeSubmit() {} }), { code: 'SUBMIT_ALREADY_ATTEMPTED' });
  const c = observedUI({ label: validLabel }), ready = await c.transport.prepare(input), controller = new AbortController();
  await assert.rejects(c.transport.submit(ready, { signal: controller.signal, beforeSubmit() { controller.abort(); } }), { code: 'REQUEST_CANCELLED' });
  assert.equal(generateCalls(c).length, 0);
});

test('submit detects setting and prompt drift without repairing or spending', async () => {
  for (const drift of [{ prompt: 'different prompt' }, { duration: '0' }, { radio: ['x1', '0'] }, { label: { texts: ['Omni 1.1 Flash'], method: 'vision' } }]) {
    const h = observedUI({ label: validLabel }), prepared = await h.transport.prepare(input); h.drift(drift);
    const writes = h.calls.filter(call => call.command === 'setValue').length;
    let persisted = false;
    await assert.rejects(h.transport.submit(prepared, { beforeSubmit() { persisted = true; } }));
    assert.equal(persisted, false); assert.equal(generateCalls(h).length, 0);
    assert.equal(h.calls.filter(call => call.command === 'setValue').length, writes);
  }
  const h = observedUI({ label: validLabel }), prepared = await h.transport.prepare(input);
  await assert.rejects(h.transport.submit(prepared, { beforeSubmit() { h.drift({ prompt: 'changed during persistence' }); } }), { code: 'PROMPT_MISMATCH' });
  assert.equal(generateCalls(h).length, 0);
});

test('failure after single Generate attempt records unknown outcome and forbids retry', async () => {
  const h = observedUI({ label: validLabel, generateError: Object.assign(new Error('helper disconnected'), { code: 'NATIVE_TRANSPORT' }) });
  const prepared = await h.transport.prepare(input);
  await assert.rejects(h.transport.submit(prepared, { beforeSubmit() {} }), error => error.code === 'NATIVE_TRANSPORT' && error.unknownOutcome === true);
  assert.equal(generateCalls(h).length, 1);
  await assert.rejects(h.transport.submit(prepared, { beforeSubmit() {} }), { code: 'SUBMIT_ALREADY_ATTEMPTED' });
  assert.equal(generateCalls(h).length, 1);
});



test('external browser reuses one existing Flow window and releases the original metadata lease',async()=>{
 const external=Object.freeze({external:true,accountId:1,email:input.expectedEmail}),released=[],acquired=[];
 const native={async call(command,args){
  if(command==='status')return {trusted:true,locked:false};
  if(command==='locateFlow')return {candidates:[{pid:42,documentURL:'https://flow.google.com/'}]};
  return {performed:true};
 },async close(){}};
 const accounts={async acquireGenerationBrowser(id,options){assert.equal(typeof options.resolveReuseExternal,'function');assert.equal(options.reuseExternal,undefined);acquired.push({id,reuseExternal:await options.resolveReuseExternal({signal:options.signal})});return external;},async releaseGenerationBrowser(handle){released.push(handle);}};
 const transport=createBrowserTransport({native,accounts});
 const handle=await transport.open(1,{expectedEmail:input.expectedEmail});
 assert.equal(handle.pid,42);assert.equal(handle.external,true);assert.deepEqual(acquired,[{id:1,reuseExternal:true}]);
 await transport.release(handle);assert.equal(released[0],external);await transport.close();
});
