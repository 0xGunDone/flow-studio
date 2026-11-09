'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { modelInfo, requestFor, mediaUrl, readDraft, requiresLogin, needsUploadVerification, recoveryAccountId, cooldownSeconds, cooldownLabel, errorMessage } = require('./renderer.js');

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

test('upload verification is a local pre-upload failure, not a session or content rejection',()=>{
  const error='Не удалось выполнить генерацию: Failed to obtain reCAPTCHA token for image upload';
  assert.equal(needsUploadVerification({error}),true);
  assert.equal(requiresLogin({error}),false);
  for(const code of ['FLOW_UPLOAD_BROWSER_TIMEOUT','FLOW_UPLOAD_BROWSER_UNAVAILABLE','FLOW_UPLOAD_BROWSER_ERROR','FLOW_UPLOAD_VERIFICATION_EMPTY']){
    const job={error:`Ошибка локального браузера [${code}]`};
    assert.equal(needsUploadVerification(job),true);assert.equal(requiresLogin(job),false);
  }
  assert.equal(needsUploadVerification({error:'[FLOW_UPLOAD_BROWSER_UNKNOWN]'}),false);
  for(const error of ['rpc=maseQ, code=401','PUBLIC_ERROR_MINOR','reCAPTCHA evaluation failed','Failed to obtain reCAPTCHA token for video generation'])assert.equal(needsUploadVerification({error}),false);
});

test('cooldown labels use expiry and tolerate absent or malformed timestamps',()=>{
 const now=Date.parse('2026-11-09T00:00:00Z');
 assert.equal(cooldownSeconds({cooldownUntil:'2026-11-09T00:30:00Z'},now),1800);
 assert.equal(cooldownLabel({cooldownUntil:'2026-11-09T00:30:00Z'},now),'Остывает · 30:00');
 assert.equal(cooldownLabel({cooldownUntil:'2026-11-08T23:00:00Z'},now),'КД завершён');
 assert.equal(cooldownSeconds({cooldownUntil:'bad'},now),0);assert.equal(cooldownSeconds(null,now),0);
});

test('draft reader allows only harmless fields and tolerates unavailable or corrupt storage', () => {
  const empty = { mode: 'image', model: '', videoMethod: '', prompt: '', sourceVideoId: '' };
  assert.deepEqual(readDraft(), empty);
  assert.deepEqual(readDraft({ getItem() { throw new Error('Disabled'); } }), empty);
  assert.deepEqual(readDraft({ getItem: () => '{' }), empty);
  assert.deepEqual(readDraft({ getItem: () => JSON.stringify({ mode: 'video', model: 'm', videoMethod: 'ingredients', prompt: 'draft', sourceVideoId: 'source', images: ['data:image/png;base64,secret'], credentials: 'secret' }) }), { mode: 'video', model: 'm', videoMethod: 'ingredients', prompt: 'draft', sourceVideoId: 'source' });
});

test('current catalog models expose format, duration, and correct input requirements', () => {
  const image = modelInfo({ id: 'gemini-3.1-flash-lite-image-three-four-4k', description: 'Nano Banana 2 Lite' });
  assert.equal(image.kind, 'image');
  assert.equal(image.label, 'Nano Banana 2 Lite · 3:4 · 4K');
  assert.equal(image.maxImages, 5);
  const video = modelInfo({ id: 'veo-3.1-fast-i2v-6s-portrait', description: 'Veo 3.1 - Fast I2V · 6s · portrait' });
  assert.equal(video.label, 'Veo 3.1 Fast · По кадрам · 6\u00a0с · 9:16 · Ultra');
  assert.equal(video.kind, 'video');
  assert.equal(video.minImages, 1);
  assert.equal(video.maxImages, 2);
  assert.equal(modelInfo({ id: 'veo-3.1-lite-i2v-4s-landscape' }).maxImages, 2);
  assert.equal(modelInfo({ id: 'veo-3.1-fast-r2v-8s-landscape' }).minImages, 1);
  assert.equal(modelInfo({ id: 'omni-1.1-flash-10s-portrait' }).maxImages, 7);
  const edit = modelInfo({ id: 'omni-1.1-flash-edit-landscape', description: 'Omni 1.1 Flash Edit' });
  assert.equal(edit.label, 'Omni 1.1 Flash · Редактирование · 16:9');
  assert.equal(edit.maxImages, 5);
  assert.equal(edit.maxVideos, 1);
  assert.equal(edit.minVideos, 1);
  assert.equal(edit.maxReferences, 6);
  assert.equal(edit.supportsVideoReferences, true);
  assert.equal(modelInfo({ id: 'veo-3.1-fast-r2v-8s-landscape' }).supportsVideoReferences, false);
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

test('mixed references keep their order and videos require Omni editing', () => {
  const image = { name: 'one.png', dataUrl: 'data:image/png;base64,abc' };
  const second = { kind: 'image', name: 'two.jpg', dataUrl: 'data:image/jpeg;base64,def' };
  const video = { kind: 'video', name: 'source.mov', path: '/chosen/source.mov', previewUrl: 'flow-input://source-id' };
  const edit = { id: 'omni-1.1-flash-edit-landscape' };
  assert.deepEqual(requestFor(edit, ' Edit this ', [second, video, image], ''), { model: edit.id, prompt: 'Edit this', references: [{ kind: 'image', dataUrl: second.dataUrl }, { kind: 'video', path: video.path }, { kind: 'image', dataUrl: image.dataUrl }] });
  assert.throws(() => requestFor(edit, 'Prompt', [image], ''), /исходное видео/);
  assert.throws(() => requestFor(edit, 'Prompt', [video, video], ''), /не больше 1 видео/);
  assert.throws(() => requestFor(edit, 'Prompt', [video, ...Array(6).fill(image)], ''), /не больше 5 изображений/);
  assert.throws(() => requestFor(edit, 'Prompt', [{ kind: 'video', name: 'missing.mp4' }], ''), /Добавьте файл заново/);
  for (const id of ['veo-3.1-fast-r2v-8s-landscape', 'veo-3.1-fast-i2v-6s-portrait', 'veo-3.1-fast-extend-8s-landscape', 'veo-3.1-fast-8s-landscape']) assert.throws(() => requestFor({ id }, 'Prompt', [video, image], 'source'), /не принимает видео/);
  const omni = { id: 'omni-1.1-flash-10s-landscape' };
  assert.throws(() => requestFor(omni, 'Prompt', [video], ''), /Для видео выберите Omni Редактирование/);
  assert.equal(requestFor(omni, 'Prompt', Array(7).fill(image), '').images.length, 7);
  assert.throws(() => requestFor(omni, 'Prompt', Array(8).fill(image), ''), /не больше 7/);
});

test('media previews accept only intended media protocols', () => {
  assert.equal(mediaUrl('flow-media://job/0'), 'flow-media://job/0');
  assert.equal(mediaUrl('flow-input://source-id'), 'flow-input://source-id');
  assert.equal(mediaUrl('data:video/mp4;base64,YQ=='), 'data:video/mp4;base64,YQ==');
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
  let tick;
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
  let dropped = [], dropError = null, finishDrop;
  const dropCalls = [], windowEvents = {};
  let loginCall = 0;
  let completionCall = 0;
  const reconnected = [];
  const checked = [];
  const pickerOptions = [];
  let saved = 0;
  const copied = [];
  let saveResult = null;
  const revealed = [];
  const snapshot = { ready: true, message: 'Готово', models: [
    { id: 'gemini-3.1-flash-image-landscape', description: 'Nano Banana 2.1' },
    { id: 'veo-3.1-fast-i2v-6s-portrait', description: 'Veo 3.1 - Fast I2V · 6s · portrait' },
    { id: 'veo-3.1-fast-extend-8s-landscape', description: 'Veo 3.1 - Fast Extend · landscape' },
    { id: 'omni-1.1-flash-edit-landscape', description: 'Omni 1.1 Flash Edit' },
    { id: 'veo-3.1-fast-r2v-8s-landscape', description: 'Veo 3.1 - Fast R2V · 8s · landscape' },
    { id: 'omni-1.1-flash-10s-landscape', description: 'Omni 1.1 Flash · 10s · landscape' },
    { id: 'veo-3.1-fast-i2v-8s-landscape' },
    { id: 'veo-3.1-fast-i2v-8s-portrait' },
    { id: 'veo-3.1-fast-4s-landscape' },
    { id: 'veo-3.1-fast-8s-landscape' },
    { id: 'omni-1.1-flash-4s-landscape' },
    { id: 'omni-1.1-flash-4s-portrait' }
  ], accounts: [{ id: 9, email: 'user@example.com', credits: 250, isActive: true, videoEnabled: true }], history: [], login: null };
  let finishBootstrap, finishRefresh, accountRefreshes = 0;
  const bootstrap = new Promise(resolve => { finishBootstrap = resolve; });
  let refresh = Promise.resolve(snapshot.accounts);
  const bridge = {
    onEvent: callback => { eventHandler = callback; return () => {}; }, bootstrap: async () => bootstrap,
    pickImages: async options => { pickerOptions.push(options); return picked; }, addAccount: async () => { loginCall++; return { state: 'waiting', canComplete: true, message: 'Войдите в Google' }; },
    dropMedia: async (files, options) => { dropCalls.push({ files, options }); if (dropError) throw dropError; return dropped; },
    reconnectAccount: async accountId => { reconnected.push(accountId); return { state: 'waiting', method: 'chrome', accountId, canComplete: true, completeLabel: 'Проверить подключение', message: 'Откройте Flow в вашем Chrome и войдите в user@example.com' }; },
    checkAccount: async accountId => { checked.push(accountId); return { ok: true, accountId, checkedAt: new Date().toISOString() }; },
    completeLogin: async () => { completionCall++; assert.equal(byId('complete-login').disabled, true); return { state: 'syncing', message: 'Проверяем вход' }; },
    cancelLogin: async () => ({ cancelled: true }), refreshAccounts: async () => { accountRefreshes++; return refresh; },
    copyHelpText: async text => { copied.push(text); return {copied:true}; },
    saveMedia: async () => { saved++; return saveResult; }, revealFile: async file => { revealed.push(file); },
    generate: async request => { generated.push(request); const id = `job-${generated.length}`; eventHandler({ type: 'job', job: { id, model: request.model, kind: 'image', prompt: request.prompt, createdAt: new Date().toISOString(), status: 'running', progress: 'В работе', media: [] } }); return { jobId: id }; }
  };
  const stored = new Map([['flowStudio.draft', JSON.stringify({ mode: 'video', model: snapshot.models[2].id, prompt: 'Saved draft', sourceVideoId: 'saved-source' })]]);
  const localStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  vm.runInNewContext(fs.readFileSync(require.resolve('./renderer.js'), 'utf8'), { document, window: { flowStudio: bridge, localStorage, addEventListener(name, callback) { (windowEvents[name] ||= []).push(callback); } }, Intl, Date, setInterval: callback => { tick=callback; return 1; }, clearInterval() {}, console });
  assert.equal(byId('refresh-accounts').disabled, true, 'Account refresh waits for startup');
  await byId('refresh-accounts').dispatch('click');
  assert.equal(accountRefreshes, 0, 'Early refresh must not reach the backend');
  eventHandler({ type: 'status', ready: true, message: 'Готово' });
  assert.equal(byId('refresh-accounts').disabled, true, 'Ready event cannot bypass pending bootstrap');
  await byId('refresh-accounts').dispatch('click');
  assert.equal(accountRefreshes, 0);
  finishBootstrap(snapshot);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(generated.length, 0, 'Opening app must never spend credits');
  assert.equal(byId('generate').disabled, false, byId('startup-message').textContent);
  assert.equal(byId('add-account').disabled, false, 'Ready status enables login after initial render');
  assert.equal(byId('refresh-accounts').disabled, false);
  assert.equal(byId('startup-banner').hidden, true);
  refresh = new Promise(resolve => { finishRefresh = resolve; });
  const refreshing = byId('refresh-accounts').dispatch('click');
  assert.equal(byId('refresh-accounts').disabled, true);
  eventHandler({ type: 'accounts', accounts: snapshot.accounts });
  assert.equal(byId('refresh-accounts').disabled, true, 'Account events keep pending refresh disabled');
  await byId('refresh-accounts').dispatch('click');
  assert.equal(accountRefreshes, 1, 'Concurrent refresh clicks share the pending request');
  eventHandler({ type: 'status', ready: false, message: 'Подключаем локальный движок…' });
  finishRefresh(snapshot.accounts);
  await refreshing;
  assert.equal(byId('refresh-accounts').disabled, true, 'Completed refresh must not enable an offline engine');
  await byId('refresh-accounts').dispatch('click');
  assert.equal(accountRefreshes, 1);
  eventHandler({ type: 'status', ready: true, message: 'Готово' });
  assert.equal(byId('refresh-accounts').disabled, false);
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
  assert.deepEqual(JSON.parse(stored.get('flowStudio.draft')), { mode: 'video', model: snapshot.models[2].id, videoMethod: 'extend', prompt: 'Test scene', sourceVideoId: 'source-id' });
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
  const uploadError='Не удалось выполнить генерацию: Failed to obtain reCAPTCHA token for image upload';
  let openedFlow=0;bridge.openFlow=async()=>{openedFlow++;return {opened:true};};
  const beforeUploadError=generated.length;
  eventHandler({type:'job',job:{id:'upload-failed',model:snapshot.models[1].id,kind:'video',status:'failed',error:uploadError,media:[]}});
  // Selecting known failed upload reveals the manual handoff without spending.
  const historyButtons=byId('history').children;
  await historyButtons[0].dispatch('click');
  assert.ok(resultButton('Открыть Flow в браузере'));
  assert(descendants(byId('result')).some(node=>node.tagName==='PRE'&&node.textContent===uploadError));
  await resultButton('Открыть Flow в браузере').dispatch('click');
  assert.equal(openedFlow,1);assert.equal(generated.length,beforeUploadError);
  const rawError = 'FLOW_RPC_ERROR: rpc=MZZa6b code=401';
  const authJob = { id: 'job-2', model: snapshot.models[2].id, kind: 'video', prompt: 'Old failed prompt', accountId: 9, status: 'failed', error: rawError, media: [] };
  eventHandler({ type: 'job', job: authJob });
  await byId('history').children[1].dispatch('click');
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

  await videoMode.dispatch('change');
  byId('model').value = snapshot.models[3].id;
  await byId('model').dispatch('change');
  assert.equal(byId('pick-images-label').textContent, 'Добавить фото или видео');
  assert.match(byId('references-hint').textContent, /до 10 с/);
  picked = [
    { name: 'source.mov', kind: 'video', path: '/chosen/source.mov', previewUrl: 'flow-input://source-id' },
    { name: 'second.png', kind: 'image', dataUrl: 'data:image/png;base64,c2Vjb25k' },
    { name: 'third.png', kind: 'image', dataUrl: 'data:image/png;base64,dGhpcmQ=' }
  ];
  await byId('pick-images').dispatch('click');
  assert.equal(pickerOptions.at(-1).allowVideos, true);
  assert.equal(byId('references').children.length, 4, 'Existing reference and several mixed files stay selected');
  assert.equal(byId('references-count').textContent, '3 / 5 фото · 1 / 1 видео');
  const referenceNodes = () => descendants(byId('references'));
  const referenceButton = label => referenceNodes().find(node => node.tagName === 'BUTTON' && node.attributes['aria-label'] === label);
  const videoPreview = referenceNodes().find(node => node.tagName === 'VIDEO');
  assert.equal(videoPreview.src, 'flow-input://source-id');
  assert.equal(videoPreview.controls, true);
  assert.equal(videoPreview.muted, true);
  assert.equal(videoPreview.preload, 'metadata');
  assert.equal(referenceNodes().filter(node => node.tagName === 'IMG').length, 3);
  await referenceButton('Переместить влево: source.mov').dispatch('click');
  await referenceButton('Переместить вправо: second.png').dispatch('click');
  assert.deepEqual(byId('references').children.map(node => descendants(node).find(child => child.className === 'reference-name').textContent), ['source.mov', 'input.png', 'third.png', 'second.png']);
  await referenceButton('Удалить third.png').dispatch('click');
  assert.equal(byId('references-count').textContent, '2 / 5 фото · 1 / 1 видео');
  await byId('generation-form').dispatch('submit');
  assert.equal(generated.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(generated[2])), { model: snapshot.models[3].id, prompt: 'Current editor draft', references: [{ kind: 'video', path: '/chosen/source.mov' }, { kind: 'image', dataUrl: 'data:image/png;base64,aGVsbG8=' }, { kind: 'image', dataUrl: 'data:image/png;base64,c2Vjb25k' }] });
  assert.equal(Object.hasOwn(generated[2], 'images'), false, 'Mixed request never also sends images');
  eventHandler({ type: 'job', job: { id: 'job-3', model: snapshot.models[3].id, kind: 'video', prompt: 'Current editor draft', status: 'failed', error: 'TEST_DONE', media: [] } });
  byId('model').value = snapshot.models[4].id;
  await byId('model').dispatch('change');
  assert.equal(byId('references').children.length, 3, 'Switching models preserves every selected file');
  assert.match(byId('form-error').textContent, /не принимает видео/);
  assert.equal(byId('pick-images-label').textContent, 'Добавить изображения');
  await byId('generation-form').dispatch('submit');
  assert.equal(generated.length, 3, 'Veo cannot silently drop source video and submit images');
  byId('model').value = snapshot.models[5].id;
  await byId('model').dispatch('change');
  assert.match(byId('form-error').textContent, /Для видео выберите Omni Редактирование/);
  await referenceButton('Удалить source.mov').dispatch('click');
  assert.equal(byId('form-error').hidden, true);
  assert.equal(byId('references-count').textContent, '2 / 7');
  assert.equal(byId('references-label').textContent, 'Ингредиенты');

  // File drops use the same reference state, validation, ordering and previews as the picker.
  while (referenceNodes().some(node => node.className === 'reference-remove')) await referenceNodes().find(node => node.className === 'reference-remove').dispatch('click');
  const zone = byId('references-field'), transfer = { types: ['Files'], files: [{ name: 'first.png' }, { name: 'second.png' }] };
  const photo1 = { kind: 'image', name: 'first.png', dataUrl: 'data:image/png;base64,Zmlyc3Q=' };
  const photo2 = { kind: 'image', name: 'second.png', dataUrl: 'data:image/png;base64,c2Vjb25k' };
  let prevented = false;
  await zone.dispatch('dragenter', { dataTransfer: transfer });
  await zone.dispatch('dragenter', { dataTransfer: transfer });
  await zone.dispatch('dragleave', { dataTransfer: transfer });
  assert(zone.className.includes('drag-over'), 'Moving over children keeps the drop highlight');
  await zone.dispatch('dragover', { dataTransfer: transfer, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(transfer.dropEffect, 'copy');
  dropped = new Promise(resolve => { finishDrop = resolve; });
  const importing = zone.dispatch('drop', { dataTransfer: transfer });
  assert.equal(byId('pick-images').disabled, true); assert.equal(byId('generate').disabled, true);
  assert.equal(zone.attributes['aria-busy'], 'true');
  await zone.dispatch('drop', { dataTransfer: transfer });
  await byId('generation-form').dispatch('submit');
  assert.equal(dropCalls.length, 1); assert.equal(generated.length, 3, 'Dropping files never generates or submits incomplete references');
  finishDrop([photo1, photo2]); await importing;
  assert.equal(byId('references-count').textContent, '2 / 7');
  assert.deepEqual(byId('references').children.map(node => descendants(node).find(child => child.className === 'reference-name').textContent), ['first.png', 'second.png']);
  assert.equal(dropCalls[0].options.allowVideos, false); assert.equal(dropCalls[0].files.length, 2);
  assert.equal(zone.className.includes('drag-over'), false); assert.equal(zone.attributes['aria-busy'], 'false');
  dropped = [photo1, photo2]; await zone.dispatch('drop', { dataTransfer: transfer });
  assert.equal(byId('references-count').textContent, '2 / 7', 'Duplicates are ignored');
  const beforeUrl = dropCalls.length;
  await zone.dispatch('drop', { dataTransfer: { types: ['text/uri-list'], files: [] } });
  assert.match(byId('form-error').textContent, /Ссылки не поддерживаются/); assert.equal(dropCalls.length, beforeUrl);
  dropped = Array.from({ length: 6 }, (_, n) => ({ ...photo1, name: `extra-${n}.png`, dataUrl: `data:image/png;base64,extra${n}` }));
  await zone.dispatch('drop', { dataTransfer: transfer });
  assert.match(byId('form-error').textContent, /не больше 7/); assert.equal(byId('references-count').textContent, '2 / 7');
  dropError = new Error('Неподдерживаемый формат файла'); await zone.dispatch('drop', { dataTransfer: transfer });
  assert.match(byId('form-error').textContent, /Неподдерживаемый формат/); assert.equal(byId('references-count').textContent, '2 / 7'); dropError = null;
  byId('model').value = snapshot.models[3].id; await byId('model').dispatch('change');
  dropped = [{ kind: 'video', name: 'clip.mov', path: '/chosen/clip.mov', previewUrl: 'flow-input://drop-video/' }];
  await zone.dispatch('drop', { dataTransfer: { types: ['Files'], files: [{ name: 'clip.mov' }] } });
  assert.equal(dropCalls.at(-1).options.allowVideos, true); assert.equal(byId('references-count').textContent, '2 / 5 фото · 1 / 1 видео');
  assert.equal(referenceNodes().find(node => node.tagName === 'VIDEO').src, 'flow-input://drop-video/');
  let outsidePrevented = false;
  for (const listener of windowEvents.drop) listener({ dataTransfer: transfer, preventDefault() { outsidePrevented = true; } });
  assert.equal(outsidePrevented, true, 'Files dropped outside attachments cannot navigate away from the app');
  assert.equal(generated.length, 3);

  // Website-like independent controls resolve the exact catalog model and preserve frame roles.
  byId('video-method').value = 'frames'; await byId('video-method').dispatch('change');
  assert.equal(byId('frames-field').hidden, false); assert.equal(byId('references-field').hidden, true);
  assert.equal(byId('model-family').value, 'Veo 3.1 Fast');
  byId('duration').value = '8'; await byId('duration').dispatch('change');
  byId('aspect-ratio').value = '9:16'; await byId('aspect-ratio').dispatch('change');
  assert.equal(byId('model').value, 'veo-3.1-fast-i2v-8s-portrait');
  const slotNodes = id => descendants(byId(id));
  const startFile = { kind: 'image', name: 'start.png', dataUrl: 'data:image/png;base64,c3RhcnQ=' };
  const endFile = { kind: 'image', name: 'end.png', dataUrl: 'data:image/png;base64,ZW5k' };
  dropped = [endFile]; await byId('end-frame').dispatch('drop', { dataTransfer: { types: ['Files'], files: [{ name: 'end.png' }] } });
  await byId('generation-form').dispatch('submit');
  assert.equal(generated.length, 3); assert.match(byId('form-error').textContent, /начальный кадр/);
  assert(slotNodes('end-frame').some(node => node.tagName === 'IMG' && node.alt === 'end.png'));
  picked = [startFile]; await slotNodes('start-frame').find(node => node.className.includes('frame-pick')).dispatch('click');
  await byId('generation-form').dispatch('submit');
  assert.equal(generated.length, 4);
  assert.equal(generated[3].model, 'veo-3.1-fast-i2v-8s-portrait');
  assert.deepEqual(Array.from(generated[3].images), [startFile.dataUrl, endFile.dataUrl], 'Frame roles determine order, even when end was added first');
  eventHandler({ type: 'job', job: { id: 'job-4', model: generated[3].model, kind: 'video', status: 'failed', error: 'TEST_DONE', media: [] } });
  byId('video-method').value = 'ingredients'; await byId('video-method').dispatch('change');
  assert.equal(byId('frames-field').hidden, true); assert.equal(byId('references-field').hidden, false);
  assert.equal(byId('references-count').textContent, '2 / 3 фото · 1 / 0 видео', 'Ingredients stay separate from frame slots');
  byId('model-family').value = 'Omni 1.1 Flash'; await byId('model-family').dispatch('change');
  byId('duration').value = '4'; await byId('duration').dispatch('change');
  byId('aspect-ratio').value = '9:16'; await byId('aspect-ratio').dispatch('change');
  assert.equal(byId('model').value, 'omni-1.1-flash-4s-portrait');
  assert.equal(byId('model-family').children.length, 2, 'Only distinct families are shown for ingredients');
  assert.equal(JSON.parse(stored.get('flowStudio.draft')).videoMethod, 'ingredients');
  byId('video-method').value = 'frames'; await byId('video-method').dispatch('change');
  assert(slotNodes('start-frame').some(node => node.tagName === 'IMG' && node.alt === 'start.png'));
  assert(slotNodes('end-frame').some(node => node.tagName === 'IMG' && node.alt === 'end.png'));
  dropped = [startFile, endFile]; await byId('start-frame').dispatch('drop', { dataTransfer: transfer });
  assert.match(byId('form-error').textContent, /одно изображение/);
  byId('video-method').value = 'edit'; await byId('video-method').dispatch('change');
  byId('model-family').value = 'Omni 1.1 Flash'; await byId('model-family').dispatch('change');
  assert.equal(byId('references-count').textContent, '2 / 5 фото · 1 / 1 видео');
  byId('video-method').value = 'extend'; await byId('video-method').dispatch('change');
  byId('model-family').value = 'Veo 3.1 Fast'; await byId('model-family').dispatch('change');
  byId('source-video-id').value = 'source-existing';
  assert.equal(byId('references-field').hidden, true);
  await byId('generation-form').dispatch('submit');
  assert.equal(generated.length, 5); assert.equal(generated[4].sourceVideoId,'source-existing');
  assert.equal(generated[4].images.length,0); assert.equal(generated[4].references,undefined,'Hidden edit video never blocks or leaks into extension');
  eventHandler({type:'job',job:{id:'job-5',model:generated[4].model,kind:'video',status:'failed',error:'TEST_DONE',media:[]}});
  {
  let managed=[{id:9,email:'enabled@example.test',isActive:true,credits:50},{id:10,email:'disabled@example.test',isActive:false,credits:25}];
  eventHandler({type:'accounts',accounts:managed});
  const accountNodes=()=>descendants(byId('accounts-list'));
  const toggles=()=>accountNodes().filter(node=>node.className==='account-toggle');
  assert.deepEqual(toggles().map(node=>node.checked),[true,false]);
  assert.equal(toggles()[0].attributes.role,'switch');
  assert.match(toggles()[0].attributes['aria-label'],/enabled@example.test/);
  let updates=0,finishToggle;
  bridge.setAccountActive=async(id,enabled)=>{updates++;await new Promise(resolve=>{finishToggle=resolve;});managed=managed.map(a=>a.id===id?{...a,isActive:enabled}:a);return {accounts:managed};};
  const input=toggles()[0];input.checked=false;const updating=input.dispatch('change');
  assert(toggles().every(node=>node.disabled));assert.equal(byId('check-enabled-accounts').disabled,true);
  await input.dispatch('change');assert.equal(updates,1,'Repeated toggle cannot duplicate in-flight write');
  finishToggle();await updating;assert.deepEqual(toggles().map(node=>node.checked),[false,false]);
  assert.equal(byId('check-enabled-accounts').disabled,true,'No enabled accounts cannot start a bulk check');
  managed[0].isActive=true;eventHandler({type:'accounts',accounts:managed});
  let deleted=0;
  bridge.deleteAccount=async()=>({deleted:false});
  await accountNodes().find(node=>node.className.includes('delete-account')).dispatch('click');
  assert.equal(toggles().length,2,'Cancelled native confirmation keeps account');
  bridge.deleteAccount=async id=>{deleted++;managed=managed.filter(a=>a.id!==id);return {deleted:true,accounts:managed};};
  const removeButtons=accountNodes().filter(node=>node.className.includes('delete-account'));
  await removeButtons[1].dispatch('click');assert.equal(deleted,1);assert.equal(toggles().length,1);
  let bulkCalls=0,finishBulk;
  bridge.checkEnabledAccounts=async()=>{bulkCalls++;eventHandler({type:'account-checks',running:true,total:1,checked:0,verified:0,failed:0,skipped:0,accountId:9,status:'checking'});return new Promise(resolve=>{finishBulk=resolve;});};
  const bulk=byId('check-enabled-accounts').dispatch('click');
  assert.equal(byId('check-enabled-accounts').disabled,true);assert.equal(byId('generate').disabled,true);
  assert.match(byId('account-check-progress').textContent,/0 из 1/);
  await byId('check-enabled-accounts').dispatch('click');assert.equal(bulkCalls,1);
  eventHandler({type:'account-checks',running:true,total:1,checked:1,verified:0,failed:1,skipped:0,accountId:9,status:'error',message:'rpc=nzlxg, code=401'});
  finishBulk({running:false,total:1,checked:1,verified:0,failed:1,skipped:0,results:[{accountId:9,status:'error',message:'rpc=nzlxg, code=401'}]});
  await bulk;
  assert.match(byId('account-check-progress').textContent,/0 успешно, 1 с ошибками/);
  assert(accountNodes().some(node=>node.tagName==='PRE'&&node.textContent==='rpc=nzlxg, code=401'));
  assert.equal(byId('check-enabled-accounts').disabled,false);
  }
  {
    const settingsTab=nodes.find(node=>node.dataset.page==='settings');
    let reads=0,writes=0,finishSettings,finishSave;
    bridge.getProviderSettings=async()=>{reads++;return new Promise(resolve=>{finishSettings=resolve;});};
    assert.equal(reads,0,'Startup does not fetch provider secrets or settings');
    await settingsTab.dispatch('click');
    assert.equal(byId('page-settings').hidden,false);assert.equal(byId('twocaptcha-api-key').value,'');
    assert.equal(byId('twocaptcha-api-key').disabled,true);
    await byId('refresh-provider-settings').dispatch('click');assert.equal(reads,1,'Only one settings read at a time');
    finishSettings({twoCaptchaKeyConfigured:true,captchaMethod:'browser'});await new Promise(setImmediate);
    assert.equal(byId('provider-settings-status').textContent,'Ключ сохранён');
    assert.equal(byId('twocaptcha-api-key').value,'','Existing key is never prefilled');
    assert.equal(byId('save-twocaptcha-key').disabled,true);
    await byId('provider-settings-form').dispatch('submit');assert.equal(writes,0,'Empty field never writes config');
    const syntheticKey='synthetic-provider-key-only';
    bridge.saveTwoCaptchaKey=async key=>{writes++;assert.equal(key,syntheticKey);return new Promise(resolve=>{finishSave=resolve;});};
    byId('twocaptcha-api-key').value=syntheticKey;await byId('twocaptcha-api-key').dispatch('input');
    assert.equal(byId('save-twocaptcha-key').disabled,false);
    const saving=byId('provider-settings-form').dispatch('submit');
    assert.equal(byId('save-twocaptcha-key').disabled,true);assert.equal(byId('twocaptcha-api-key').disabled,true);
    await byId('provider-settings-form').dispatch('submit');assert.equal(writes,1);
    finishSave({saved:true,twoCaptchaKeyConfigured:true,captchaMethod:'browser'});await saving;
    assert.equal(byId('twocaptcha-api-key').value,'');
    assert.match(byId('provider-settings-result').textContent,/Способ проверки не изменён/);
    assert.match(byId('provider-method').textContent,/Встроенный браузер/);
    assert(!JSON.stringify([...stored.values()]).includes(syntheticKey),'Provider secret cannot enter draft storage');
    bridge.saveTwoCaptchaKey=async()=>{throw new Error('SERVER ECHO '+syntheticKey);};
    byId('twocaptcha-api-key').value=syntheticKey;await byId('twocaptcha-api-key').dispatch('input');
    await byId('provider-settings-form').dispatch('submit');
    assert(!byId('provider-settings-error').textContent.includes(syntheticKey));
    await nodes.find(node=>node.dataset.page==='create').dispatch('click');
    assert.equal(byId('twocaptcha-api-key').value,'','Leaving settings clears unsaved secret');
  }
  {
    const until=new Date(Date.now()+30*60*1000).toISOString();
    let accounts=[{id:9,email:'cooling@example.test',isActive:true,credits:50,cooldownUntil:until,cooldownResetAllowed:true,lastGenerationError:'HTTP 503: provider unavailable',lastGenerationErrorAt:new Date().toISOString()},{id:10,email:'held@example.test',isActive:true,credits:25,cooldownUntil:until,cooldownResetAllowed:false,lastGenerationError:'PUBLIC_ERROR_UNUSUAL_ACTIVITY'}];
    eventHandler({type:'accounts',accounts});
    const accountTree=()=>descendants(byId('accounts-list'));
    assert(accountTree().some(node=>node.textContent?.startsWith('Остывает · 29:')||node.textContent==='Остывает · 30:00'));
    assert(accountTree().some(node=>node.tagName==='PRE'&&node.textContent==='PUBLIC_ERROR_UNUSUAL_ACTIVITY'));
    const resets=accountTree().filter(node=>node.className.includes('reset-cooldown'));
    assert.equal(resets.length,2);assert.equal(resets[0].disabled,false);assert.equal(resets[1].disabled,true,'Google hold cannot be lifted through local reset');
    let clears=0;bridge.clearCooldown=async id=>{clears++;assert.equal(id,9);accounts=accounts.map(a=>a.id===id?{...a,cooldownUntil:null}:a);return {accounts};};
    await resets[0].dispatch('click');assert.equal(clears,1);
    let retryCalls=0,finishRetry;const retryArgs=[];
    bridge.retryGeneration=async args=>{retryCalls++;retryArgs.push(args);return new Promise(resolve=>{finishRetry=resolve;});};
    const failed={id:'retry-source',model:snapshot.models[1].id,kind:'video',status:'failed',prompt:'same scene',error:'HTTP 503: provider unavailable',media:[],accountId:9,accountEmail:'cooling@example.test',retryAvailable:true};
    eventHandler({type:'job',job:failed});await byId('history').children[0].dispatch('click');
    assert(descendants(byId('result')).some(node=>node.textContent==='cooling@example.test'));
    let retry=resultButton('Повторить генерацию');assert(retry);assert.equal(retry.disabled,false);
    const repeated=retry.dispatch('click');
    assert.equal(resultButton('Повторить генерацию').disabled,true);
    await retry.dispatch('click');assert.equal(retryCalls,1);
    assert.equal(retryArgs[0].jobId,'retry-source');assert.ok(retryArgs[0].requestId);
    finishRetry({jobId:'retry-child'});await repeated;
    assert.equal(generated.length,5,'Retry calls only dedicated bridge, not edited composer inputs');
    eventHandler({type:'job',job:{...failed,id:'held-job',accountId:10,accountEmail:'held@example.test'}});await byId('history').children[0].dispatch('click');
    assert.equal(resultButton('Повторить генерацию').disabled,true);
    eventHandler({type:'job',job:{...failed,id:'legacy-job',retryAvailable:false,retryBlockedReason:'Нет сохранённых исходников'}});await byId('history').children[0].dispatch('click');
    assert.equal(resultButton('Повторить генерацию').disabled,true);
    assert(descendants(byId('result')).some(node=>node.textContent==='Нет сохранённых исходников'));
    eventHandler({type:'accounts',accounts,history:[{...failed,retryAvailable:false,retryBlockedReason:'Включите исходный аккаунт перед повтором.'}]});
    await byId('history').children[0].dispatch('click');
    assert.equal(resultButton('Повторить генерацию').disabled,true,'Account events refresh derived replay eligibility');
    const past=new Date(Date.now()-1000).toISOString();
    eventHandler({type:'accounts',accounts:accounts.map(a=>({...a,cooldownUntil:past})),history:[{...failed,retryAvailable:true}]});
    await byId('history').children[0].dispatch('click');tick();
    assert.equal(resultButton('Повторить генерацию').disabled,false);
    assert.equal(byId('generate').disabled,false,'Cooldown expiry restores manual controls without starting a job');
    assert.equal(retryCalls,1,'Cooldown expiry never generates automatically');
    eventHandler({type:'accounts',accounts:[{...accounts[0],cooldownUntil:until}],history:[failed]});
    await byId('history').children[0].dispatch('click');
    assert.equal(resultButton('Повторить генерацию').disabled,true);
    bridge.clearCooldown=async()=>{const updated=[{...accounts[0],cooldownUntil:null}];eventHandler({type:'accounts',accounts:updated,history:[failed]});return {accounts:updated};};
    await accountTree().find(node=>node.className.includes('reset-cooldown')).dispatch('click');
    assert.equal(resultButton('Повторить генерацию').disabled,false,'Reset completion immediately restores selected retry');
    bridge.checkEnabledAccounts=async()=>{eventHandler({type:'accounts',accounts:[accounts[0]],history:[failed]});return {running:false,results:[],failed:0};};
    await byId('check-enabled-accounts').dispatch('click');
    assert.equal(resultButton('Повторить генерацию').disabled,false,'Account check completion restores selected retry');
  }
});
