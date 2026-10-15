'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { modelInfo, requestFor, mediaUrl, readDraft, requiresLogin, recoveryAccountId, errorMessage } = require('./renderer.js');

test('account errors hide Electron wrapper but retain actual reason and RPC code', () => {
  assert.equal(errorMessage(new Error("Error invoking remote method 'studio:checkAccount': Error: Google Flow не подтвердил вход (rpc=nzlxg, code=401)")), 'Google Flow не подтвердил вход (rpc=nzlxg, code=401)');
  assert.equal(errorMessage(new Error('Ошибка сети')), 'Ошибка сети');
});

test('auth recovery recognizes arbitrary RPC 401 and never selects an unrelated account', () => {
  assert.equal(requiresLogin({ error: 'Flow RPC failed: rpc=MZZa6b code=401' }), true);
  assert.equal(requiresLogin({ error: 'Flow RPC failed: rpc=changedMethod code 401' }), true);
  assert.equal(requiresLogin({ error: '{"statusCode":401}' }), true);
  assert.equal(requiresLogin({ needsLogin: true, error: 'Вход истёк' }), true);
  assert.equal(requiresLogin({ error: 'rpc=MZZa6b code=403' }), false);
  assert.equal(requiresLogin({ error: 'Request 401 failed with code=500' }), false);
  const accounts = [{ id: 9, isActive: true }, { id: 10, isActive: true }];
  assert.equal(recoveryAccountId({ accountId: 10 }, accounts), 10);
  assert.equal(recoveryAccountId({}, accounts), null);
  assert.equal(recoveryAccountId({}, accounts.slice(0, 1)), 9);
  assert.equal(recoveryAccountId({ accountId: 99 }, accounts.slice(0, 1)), null);
  assert.equal(recoveryAccountId({}, [{ id: 9, isActive: false }]), null);
});

test('draft reader allows only harmless fields and tolerates unavailable or corrupt storage', () => {
  const empty = { mode: 'image', model: '', prompt: '', sourceVideoId: '' };
  assert.deepEqual(readDraft(), empty);
  assert.deepEqual(readDraft({ getItem() { throw new Error('Disabled'); } }), empty);
  assert.deepEqual(readDraft({ getItem: () => '{' }), empty);
  assert.deepEqual(readDraft({ getItem: () => JSON.stringify({ mode: 'video', model: 'm', prompt: 'draft', sourceVideoId: 'source', images: ['data:image/png;base64,secret'], credentials: 'secret' }) }), { mode: 'video', model: 'm', prompt: 'draft', sourceVideoId: 'source' });
});

test('current catalog models expose format, duration, and correct input requirements', () => {
  const image = modelInfo({ id: 'gemini-3.1-flash-lite-image-three-four-4k', description: 'Nano Banana 2 Lite' });
  assert.equal(image.kind, 'image');
  assert.equal(image.label, 'Nano Banana 2 Lite · 3:4 · 4K');
  assert.equal(image.maxImages, 5);
  const video = modelInfo({ id: 'veo-3.1-fast-i2v-6s-portrait', description: 'Veo 3.1 - Fast I2V · 6s · portrait' });
  assert.equal(video.label, 'Veo 3.1 Fast · По кадрам · 6\u00a0с · 9:16');
  assert.equal(video.kind, 'video');
  assert.equal(video.minImages, 1);
  assert.equal(video.maxImages, 2);
  assert.equal(modelInfo({ id: 'veo-3.1-lite-i2v-4s-landscape' }).maxImages, 2);
  assert.equal(modelInfo({ id: 'veo-3.1-fast-r2v-8s-landscape' }).minImages, 1);
  assert.equal(modelInfo({ id: 'omni-1.1-flash-10s-portrait' }).maxImages, 3);
  assert.equal(modelInfo({ id: 'veo-3.1-fast-8s-landscape' }).maxImages, 0);
  assert.equal(modelInfo({ id: 'veo-3.1-fast-extend-8s-landscape' }).extend, true);
});

test('generation payload validates exact model needs and excludes irrelevant inputs', () => {
  const image = { id: 'gemini-3.1-flash-image-landscape' };
  const ref = { name: 'one.png', dataUrl: 'data:image/png;base64,abc' };
  assert.deepEqual(requestFor(image, '  My prompt  ', [ref], 'unused'), { model: image.id, prompt: 'My prompt', images: [ref.dataUrl] });
  assert.throws(() => requestFor(image, ' ', [], ''), /Опишите/);
  assert.throws(() => requestFor(image, 'Prompt', Array(6).fill(ref), ''), /не больше 5/);
  assert.throws(() => requestFor({ id: 'veo-3.1-fast-i2v-4s-landscape' }, 'Prompt', [], ''), /хотя бы одно/);
  assert.throws(() => requestFor({ id: 'veo-3.1-fast-r2v-8s-landscape' }, 'Prompt', Array(4).fill(ref), ''), /не больше 3/);
  const extend = { id: 'veo-3.1-fast-extend-8s-landscape' };
  assert.throws(() => requestFor(extend, 'Prompt', [], ''), /ID исходного видео/);
  assert.deepEqual(requestFor(extend, 'Prompt', [ref], ' source '), { model: extend.id, prompt: 'Prompt', images: [], sourceVideoId: 'source' });
});

test('media previews accept only intended media protocols', () => {
  assert.equal(mediaUrl('flow-media://job/0'), 'flow-media://job/0');
  assert.equal(mediaUrl('https://example.com/result.png'), 'https://example.com/result.png');
  assert.equal(mediaUrl('http://127.0.0.1:38000/tmp/result.mp4'), 'http://127.0.0.1:38000/tmp/result.mp4');
  assert.equal(mediaUrl('http://127.0.0.1:38000/api/tokens'), '');
  assert.equal(mediaUrl('http://127.0.0.1:38000/tmp/../api/tokens'), '');
  assert.equal(mediaUrl('http://127.0.0.1:38001/tmp/result.mp4'), '');
  assert.equal(mediaUrl('http://example.com/tmp/result.mp4'), '');
  assert.equal(mediaUrl('file:///etc/passwd'), '');
  assert.equal(mediaUrl('javascript:alert(1)'), '');
  assert.equal(mediaUrl('data:text/html,unsafe'), '');
});

test('renderer bridge covers startup, generation, failure, history and Google login without auto generation', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const nodes = [];
  class Node {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.className = ''; this.hidden = false; this.disabled = false; this._value = ''; this.textContent = ''; nodes.push(this); }
    get value() { return this._value || (this.tagName === 'SELECT' ? this.children[0]?.value || '' : ''); }
    set value(value) { this._value = value; }
    get classList() { return { toggle: (name, on) => { const names = new Set(this.className.split(' ')); if (on) names.add(name); else names.delete(name); this.className = [...names].join(' '); } }; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; if (this.tagName === 'SELECT') this._value = ''; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    async dispatch(name, data = {}) { for (const callback of this.listeners[name] || []) await callback({ preventDefault() {}, ...data }); }
    focus() { this.focused = true; }
    scrollIntoView() { this.scrolled = true; }
    querySelector() { return null; }
    requestSubmit() { return this.dispatch('submit'); }
  }
  const html = fs.readFileSync(require.resolve('./index.html'), 'utf8');
  for (const match of html.matchAll(/<(\w+)\b([^>]*)>/g)) {
    const attributes = match[2];
    const node = new Node(match[1]);
    node.id = attributes.match(/\bid="([^"]+)"/)?.[1];
    node.className = attributes.match(/\bclass="([^"]+)"/)?.[1] || '';
    node.name = attributes.match(/\bname="([^"]+)"/)?.[1];
    node.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] || '';
    node.dataset.page = attributes.match(/\bdata-page="([^"]+)"/)?.[1];
    node.dataset.copyTarget = attributes.match(/\bdata-copy-target="([^"]+)"/)?.[1];
    node.dataset.helpTarget = attributes.match(/\bdata-help-target="([^"]+)"/)?.[1];
    node.goCreate = /data-go-create/.test(attributes);
    node.hidden = /\bhidden\b/.test(attributes);
  }
  const document = {
    createElement: tag => new Node(tag), createTextNode: text => ({ textContent: text }),
    getElementById: id => [...nodes].reverse().find(node => node.id === id),
    querySelectorAll: selector => nodes.filter(node => selector === '[data-page]' ? node.dataset.page : selector === '[data-copy-target]' ? node.dataset.copyTarget : selector === '[data-help-target]' ? node.dataset.helpTarget : selector === '[data-go-create]' ? node.goCreate : selector === 'input[name="mode"]' ? node.name === 'mode' : selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : false)
  };
  const byId = document.getElementById;
  let eventHandler;
  let generated = [];
  let picked = [{ name: 'input.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }];
  let loginCall = 0;
  let completionCall = 0;
  const reconnected = [];
  const checked = [];
  let saved = 0;
  const copied = [];
  let saveResult = null;
  const revealed = [];
  const snapshot = { ready: true, message: 'Готово', models: [
    { id: 'gemini-3.1-flash-image-landscape', description: 'Nano Banana 2.1' },
    { id: 'veo-3.1-fast-i2v-6s-portrait', description: 'Veo 3.1 - Fast I2V · 6s · portrait' },
    { id: 'veo-3.1-fast-extend-8s-landscape', description: 'Veo 3.1 - Fast Extend · landscape' }
  ], accounts: [{ id: 9, email: 'user@example.com', credits: 250, isActive: true, videoEnabled: true }], history: [], login: null };
  const bridge = {
    onEvent: callback => { eventHandler = callback; return () => {}; }, bootstrap: async () => snapshot,
    pickImages: async () => picked, addAccount: async () => { loginCall++; return { state: 'waiting', canComplete: true, message: 'Войдите в Google' }; },
    reconnectAccount: async accountId => { reconnected.push(accountId); return { state: 'waiting', method: 'chrome', accountId, canComplete: true, completeLabel: 'Проверить подключение', message: 'Откройте Flow в вашем Chrome и войдите в user@example.com' }; },
    checkAccount: async accountId => { checked.push(accountId); return { ok: true, accountId, checkedAt: new Date().toISOString() }; },
    completeLogin: async () => { completionCall++; assert.equal(byId('complete-login').disabled, true); return { state: 'syncing', message: 'Проверяем вход' }; },
    cancelLogin: async () => ({ cancelled: true }), refreshAccounts: async () => snapshot.accounts,
    copyHelpText: async text => { copied.push(text); return {copied:true}; },
    saveMedia: async () => { saved++; return saveResult; }, revealFile: async file => { revealed.push(file); },
    generate: async request => { generated.push(request); const id = `job-${generated.length}`; eventHandler({ type: 'job', job: { id, model: request.model, kind: 'image', prompt: request.prompt, createdAt: new Date().toISOString(), status: 'running', progress: 'В работе', media: [] } }); return { jobId: id }; }
  };
  const stored = new Map([['flowStudio.draft', JSON.stringify({ mode: 'video', model: snapshot.models[2].id, prompt: 'Saved draft', sourceVideoId: 'saved-source' })]]);
  const localStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  vm.runInNewContext(fs.readFileSync(require.resolve('./renderer.js'), 'utf8'), { document, window: { flowStudio: bridge, localStorage, addEventListener() {} }, Intl, Date, setInterval: () => 1, clearInterval() {}, console });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(generated.length, 0, 'Opening app must never spend credits');
  assert.equal(byId('generate').disabled, false, byId('startup-message').textContent);
  assert.equal(byId('add-account').disabled, false, 'Ready status enables login after initial render');
  assert.equal(byId('startup-banner').hidden, true);
  const helpNav = nodes.find(node => node.dataset.page === 'help');
  await helpNav.dispatch('click');
  assert.equal(byId('page-help').hidden, false);
  assert.equal(byId('page-create').hidden, true);
  assert.equal(helpNav.attributes['aria-current'], 'page');
  const copyButton = nodes.find(node => node.dataset.copyTarget);
  assert(copyButton, 'Help must include copyable instructions');
  if (copyButton) {
    byId(copyButton.dataset.copyTarget).textContent = 'verified sample command';
    await copyButton.dispatch('click');
    assert.deepEqual(copied, ['verified sample command']);
    assert.equal(copyButton.disabled, false);
    assert.match(byId('help-copy-status').textContent, /Скопировано/);
  }
  const helpSection = nodes.find(node => node.dataset.helpTarget);
  assert(helpSection, 'Help must include section shortcuts');
  if (helpSection) {
    await helpSection.dispatch('click');
    assert.equal(byId(helpSection.dataset.helpTarget).scrolled, true);
  }
  assert.equal(generated.length, 0, 'Reading/copying help never creates jobs');
  await nodes.find(node => node.dataset.page === 'create').dispatch('click');

  assert.equal(byId('model').value, snapshot.models[2].id, 'Restore saved valid model instead of default');
  assert.equal(byId('prompt').value, 'Saved draft');
  assert.equal(byId('source-video-id').value, 'saved-source');
  assert.equal(nodes.find(node => node.name === 'mode' && node.value === 'video').checked, true);
  await nodes.find(node => node.name === 'mode' && node.value === 'image').dispatch('change');
  byId('source-video-id').value = '';
  byId('prompt').value = 'Test scene';
  await byId('prompt').dispatch('input');
  await byId('pick-images').dispatch('click');
  await byId('generation-form').dispatch('submit');
  assert.equal(generated.length, 1);
  assert.equal(generated[0].images.length, 1);
  assert.equal(byId('generate').disabled, true);
  eventHandler({ type: 'job', job: { id: 'job-1', model: snapshot.models[0].id, kind: 'image', prompt: 'Test scene', status: 'failed', error: 'UPSTREAM_ERROR: test', media: [] } });
  assert.equal(byId('generate').disabled, false);
  assert.equal(byId('result-tag').textContent, 'Не получилось');
  const videoMode = nodes.find(node => node.name === 'mode' && node.value === 'video');
  await videoMode.dispatch('change');
  byId('model').value = snapshot.models[2].id;
  await byId('model').dispatch('change');
  await byId('generation-form').dispatch('submit');
  assert.equal(generated.length, 1, 'Invalid extend cannot submit');
  assert.match(byId('form-error').textContent, /ID исходного видео/);
  byId('source-video-id').value = 'source-id';
  await byId('source-video-id').dispatch('input');
  assert.deepEqual(JSON.parse(stored.get('flowStudio.draft')), { mode: 'video', model: snapshot.models[2].id, prompt: 'Test scene', sourceVideoId: 'source-id' });
  await byId('generation-form').dispatch('submit');
  assert.equal(generated[1].sourceVideoId, 'source-id');
  assert.equal(generated[1].images.length, 0, 'Hidden image references cannot leak into extend request');
  eventHandler({ type: 'job', job: { id: 'job-2', model: snapshot.models[2].id, kind: 'video', prompt: 'Test scene', status: 'succeeded', media: [{ url: 'flow-media://job-2/0', kind: 'video', path: '/saved.mp4' }] } });
  assert.equal(byId('result-tag').textContent, 'Готово');
  assert.equal(byId('history-count').textContent, '2');
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  const resultButton = label => descendants(byId('result')).find(node => node.tagName === 'BUTTON' && node.textContent === label);
  assert.equal(resultButton('Открыть папку'), undefined, 'Cached preview must not expose internal folder');
  const saveButton = resultButton('Сохранить как…');
  await saveButton.dispatch('click');
  assert.equal(saved, 1);
  assert.equal(resultButton('Открыть папку'), undefined, 'Cancel must not expose folder button');
  saveResult = { path: '/exports/chosen-result.mp4' };
  await saveButton.dispatch('click');
  assert.equal(saved, 2);
  assert.ok(resultButton('Сохранить как…'), 'Save As stays available for another copy');
  await resultButton('Открыть папку').dispatch('click');
  assert.deepEqual(revealed, ['/exports/chosen-result.mp4'], 'Open Folder reveals chosen export, not preview cache');
  const historyCard = byId('history').children[0];
  await historyCard.dispatch('click');
  assert.ok(resultButton('Открыть папку'), 'Saved path stays available when revisiting history');
  await byId('add-account').dispatch('click');
  assert.equal(loginCall, 1);
  assert.equal(byId('login-panel').hidden, false);
  assert.equal(byId('add-account').disabled, true);
  assert.equal(byId('complete-login').hidden, false);
  assert.match(byId('login-message').textContent, /Затем нажмите «Я вошёл»/);
  await byId('complete-login').dispatch('click');
  assert.equal(completionCall, 1);
  assert.equal(byId('login-title').textContent, 'Подключаем аккаунт', 'Button must not invent successful login');
  assert.equal(byId('complete-login').hidden, true);
  eventHandler({ type: 'login', login: { state: 'waiting', message: 'Ожидание' } });
  assert.equal(byId('complete-login').hidden, true, 'Only normal-browser completion states expose button');
  eventHandler({ type: 'login', login: { state: 'waiting', canComplete: true, message: 'Войдите в Google' } });
  bridge.completeLogin = async () => { throw new Error('Вход еще не завершен'); };
  await byId('complete-login').dispatch('click');
  assert.equal(byId('accounts-error').textContent, 'Вход еще не завершен');
  assert.equal(byId('complete-login').disabled, false);
  assert.equal(byId('complete-login').hidden, false);
  await byId('cancel-login').dispatch('click');
  assert.equal(byId('login-panel').hidden, true);
  assert.equal(byId('add-account').disabled, false);

  await nodes.find(node => node.name === 'mode' && node.value === 'image').dispatch('change');
  byId('prompt').value = 'Current editor draft';
  byId('source-video-id').value = 'current-source-id';
  const currentModel = byId('model').value;
  const referenceCount = byId('references').children.length;
  assert.equal(referenceCount, 1);
  eventHandler({ type: 'accounts', accounts: [...snapshot.accounts, { id: 10, email: 'other@example.com', isActive: true }] });
  const rawError = 'FLOW_RPC_ERROR: rpc=MZZa6b code=401';
  const authJob = { id: 'job-2', model: snapshot.models[2].id, kind: 'video', prompt: 'Old failed prompt', accountId: 9, status: 'failed', error: rawError, media: [] };
  eventHandler({ type: 'job', job: authJob });
  assert.ok(descendants(byId('result')).some(node => node.tagName === 'PRE' && node.textContent === rawError), 'Raw error remains in technical details');
  await resultButton('Войти в Google заново').dispatch('click');
  assert.deepEqual(reconnected, [9], 'Recovery uses job account even with multiple active accounts');
  assert.equal(byId('page-accounts').hidden, false);
  assert.equal(byId('recovery-panel').hidden, false);
  assert.match(byId('recovery-account').textContent, /user@example.com/);
  assert.equal(byId('complete-login').textContent, 'Проверить подключение');
  assert.equal(byId('login-message').textContent, 'Откройте Flow в вашем Chrome и войдите в user@example.com', 'Chrome login uses backend instructions');
  assert.equal(byId('prompt').value, 'Current editor draft');
  assert.equal(byId('source-video-id').value, 'current-source-id');
  assert.equal(byId('model').value, currentModel);
  assert.equal(byId('references').children.length, referenceCount, 'Recovery preserves image references');
  assert.equal(generated.length, 2, 'Recovery never submits a new generation');
  bridge.completeLogin = async () => ({ state: 'succeeded', method: 'chrome', accountId: 9, message: 'Подключение проверено' });
  await byId('complete-login').dispatch('click');
  let accountNodes = descendants(byId('accounts-list').children[0]);
  assert.ok(accountNodes.some(node => node.textContent === 'Включен для генерации'));
  assert.ok(accountNodes.some(node => /^Подключение проверено/.test(node.textContent)));
  await accountNodes.find(node => node.tagName === 'BUTTON' && node.textContent === 'Проверить подключение').dispatch('click');
  assert.deepEqual(checked, [9]);
  bridge.checkAccount = async () => { throw new Error('AUTH_REQUIRED: code=401'); };
  accountNodes = descendants(byId('accounts-list').children[0]);
  await accountNodes.find(node => node.tagName === 'BUTTON' && node.textContent === 'Проверить подключение').dispatch('click');
  accountNodes = descendants(byId('accounts-list').children[0]);
  assert.ok(accountNodes.some(node => node.textContent === 'Подключение не подтверждено'));
  assert.ok(accountNodes.some(node => node.tagName === 'PRE' && node.textContent === 'AUTH_REQUIRED: code=401'));
  assert.ok(accountNodes.some(node => node.textContent === 'Включен для генерации'), 'Stored activity stays distinct from auth verification');
  eventHandler({ type: 'job', job: { ...authJob, accountId: undefined, needsLogin: true, error: 'SESSION_EXPIRED' } });
  await resultButton('Войти в Google заново').dispatch('click');
  assert.equal(reconnected.length, 1, 'Ambiguous account requires user selection');
  assert.match(byId('recovery-account').textContent, /Выберите нужный аккаунт/);
  assert.equal(generated.length, 2, 'Checking and completing login never spend generation credits');
});
