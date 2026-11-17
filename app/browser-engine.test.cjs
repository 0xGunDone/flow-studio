'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createBrowserEngine, FlowPage, planFor, decodeImage, mediaIdentity, flowDOM, downloadOriginal, allowedDownload } = require('./browser-engine.cjs');
const { createReceiptStore } = require('./browser-receipts.cjs');
const { imageDOM } = require('./browser-images.cjs');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aKWQAAAAASUVORK5CYII=';
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const EMAIL = 'person@example.com';
const FRAME = 'frame-owned';
const GUID = '12345678-1234-4123-8123-123456789abc';
const SCENE = '87654321-4321-4321-8321-cba987654321';
const SOURCE_PROJECT = '5927b3e9-314b-432f-af56-b76efcd20c51';
const RIGHTS_TEXT = 'Rights to use this image\nYou confirm that you have rights to upload this image.\nI agree';
const MP4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
const failure = (code, message = code) => Object.assign(new Error(message), { code });
const evaluatePrefix = '(' + flowDOM.toString() + ')';
const imageEvaluatePrefix = '(' + imageDOM.toString() + ')';
const input = overrides => ({ accountId: 7, accountEmail: EMAIL, model: 'omni-1.2-flash-8s-landscape', prompt: 'Точный запрос "ёж"\nВторая строка', ...overrides });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('Fixture did not reach expected state'); }
async function temporary(t) { const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-browser-test-')); t.after(() => fs.rm(folder, { recursive: true, force: true })); return folder; }
const domError = error => ({ exceptionDetails: { exception: { description: `Error: ${error.code}: ${error.message}` } } });

// Protocol fixture: every command must be a documented page operation or a narrow
// browser download command. No HTTP, desktop, native helper, or provider fallback.
async function harness(t, options = {}) {
  const dataDir = await temporary(t), commands = [], ops = [], uploads = [], order = [], listeners = new Set();
  const state = {
    url: 'https://flow.google.com/', prompt: options.draft || '', ingredients: [...(options.ingredients || [])],
    settingsOpen: false, accountOpen: false, pickerOpen: false, model: '', duration: 0,
    radios: new Set(), assets: new Map(), selected: null, submitted: 0, resultPolls: 0,
    fileLookups: 0, acquisitions: 0, releases: 0, downloadFolder: null, focused: false,
    rightsText: RIGHTS_TEXT, rightsAccepted: false, rightsAccepts: 0,
    rightsPendingReads: 0,
  };
  const startup = [...(options.startup || [])];
  let signal, released = false;
  let leaseController = new AbortController();
  const emit = (method, params) => { for (const listener of listeners) listener({ method, params }); };
  const composer = () => ({ prompt: state.prompt, ingredients: [...state.ingredients], generateEnabled: true });
  const radioGroup = name => ['16:9', '9:16'].includes(name) ? ['16:9', '9:16'] : name.startsWith('360p') || name === '720p' ? ['720p', '360p 360p: видео генерируется быстрее, но разрешение ниже'] : [name];
  async function click(name) {
    if (name === 'Сведения об аккаунте') state.accountOpen = true;
    else if (name === 'Закрыть панель аккаунта') state.accountOpen = false;
    else if (name === 'Триггер настроек') state.settingsOpen = !state.settingsOpen;
    else if (name === 'Выбрать семейство моделей') assert.equal(state.settingsOpen, true);
    else if (name === 'Добавить ингредиенты в окно запроса') state.pickerOpen = true;
    else if (name === 'Старт' || name === 'Конец') { state.pickerOpen = true; (state.frameRoles ||= []).push(name); }
    else if (name === 'Добавить медиа') { assert.equal(options.edit, true); state.videoPicker = true; }
    else if (name === 'Загрузить') assert.equal(state.intercepting, true);
    else if (name === 'Добавить в запрос') { assert.ok(state.selected); state.ingredients.push(state.selected.identity); state.pickerOpen = false; }
    else if (name === 'Скачать медиаконтент') {
      state.downloadMenu = true;
    }
    else if (name === '1K Исходный размер') {
      assert.equal(options.image, true); assert.equal(state.downloadMenu, true);
      await fs.writeFile(path.join(state.downloadFolder, GUID), Buffer.from(PNG.split(',')[1], 'base64'));
      emit('Browser.downloadWillBegin', { guid: GUID, frameId: FRAME, url: 'blob:https://flow.google.com/' + GUID }); emit('Browser.downloadProgress', { guid: GUID, state: 'completed' });
    }
    else if (name === '720p Исходный размер' || name === '360p Исходный размер') {
      assert.equal(state.downloadMenu, true);
      assert.ok(state.downloadFolder);
      await fs.writeFile(path.join(state.downloadFolder, GUID), MP4);
      if(options.outputSize)await fs.truncate(path.join(state.downloadFolder,GUID),options.outputSize);
      emit('Browser.downloadWillBegin', { guid: GUID, frameId: FRAME, url: 'https://flow-content.google/video/result-owned?download=1' });
      emit('Browser.downloadProgress', { guid: GUID, state: 'completed' });
    } else assert.fail(`Unexpected website control: ${name}`);
    return true;
  }
  async function operation(op, arg) {
    ops.push({ op, arg });
    const overridden = await options.operation?.(op, arg, state);
    if (overridden !== undefined) return overridden;
    if (op === 'state') return { url: state.url, accountButtons: 1, projectLinks: [{ href: '/project/project-owned' }] };
    if (op === 'controls' || op === 'mode-inspection' || op === 'upload-options') return { buttons: ['Account information', 'Start generation'], radios: state.settingsOpen ? ['Video', 'Ingredients', '16:9', '720p'] : [], textboxes: ['What do you want to create?'], ranges: [] };
    if (op === 'recovery-diagnostic') return { cards: [] };
    if (op === 'control-point') { assert.equal(options.edit, true); assert.equal(arg.name, 'Загрузить'); return { x: 100, y: 100 }; }
    if (op === 'control-box') { assert.equal(options.edit, true); assert.equal(arg.name,state.videoPicker?'Загрузить':'Начать генерацию'); return { x: 100, y: 100, left: 50, top: 80, width: 100, height: 40 }; }
    if (op === 'video-uploaded') {
      if (options.requireVideoRights && !state.rightsAccepted) throw failure('FLOW_UPLOAD_CONSENT_REQUIRED');
      assert.equal(state.videoUploads?.length, 1); assert.equal(arg.name, path.basename(state.videoUploads[0].file));
      if (arg.open) { state.videoEditor = true; state.videoPicker = false; state.url = 'https://flow.google.com/project/' + SOURCE_PROJECT + '/edit/' + SCENE; }
      return { name: arg.name.replace(/\.(mp4|mov|m4v)$/i,''), poster: options.sourcePoster || 'https://flow.google.com/asb/source-video-poster' };
    }
    if (op === 'source-scene') {
      state.sourceSceneReads=(state.sourceSceneReads||0)+1;
      if(arg.loading&&state.sourceSceneReads<=(options.sourceSceneDelays||0))throw failure('SOURCE_VIDEO_NOT_READY');
      if(arg.output){state.sourceSceneOutputReads=(state.sourceSceneOutputReads||0)+1;if(state.sourceSceneOutputReads<=(options.sourceSceneOutputDelays||0))throw failure('SOURCE_VIDEO_NOT_READY');state.opened=true;}
      if (options.sourceSceneOutputError && arg.output) throw failure('SOURCE_VIDEO_NOT_VERIFIED');
      if (arg.sourceScene?.url && arg.sourceScene.url !== state.url) throw failure('SOURCE_VIDEO_NOT_VERIFIED');
      return { url: state.url, poster: options.sourcePoster || 'https://flow.google.com/asb/source-video-poster' };
    }
    if (op === 'edit-settings') {
      assert.equal(state.videoEditor, true);
      if(arg.choose){state.editMenuOpen=true;return true;}if(arg.close){state.editMenuOpen=false;return true;}
      assert.equal(state.model, 'Omni 1.2 Flash');
      return {model:state.model,clipCount:1,url:state.url,...(arg.quote?{credits:options.editCreditQuote??9}:{})};
    }
    if (op === 'failure-state') {
      if (options.diagnosticError) throw failure('DIAGNOSTIC_FAILED', 'Diagnostic must not replace transaction failure');
      return { url: state.url, regions: [{ name: 'History', tag: 'ASIDE', chars: 32 }], buttons: [{ name: 'История', tag: 'BUTTON' }], videos: 1 };
    }
    if (op === 'dialogs') return options.requireRights && !state.rightsAccepted ? [state.rightsText] : [];
    if (op === 'upload-rights') return { text: state.rightsText };
    if (op === 'upload-rights-pending') return state.rightsAccepted && state.rightsPendingReads++ < (options.rightsClosingPolls || 0);
    if (op === 'accept-upload-rights') {
      if (arg.text !== state.rightsText) throw failure('UPLOAD_RIGHTS_CHANGED');
      assert.equal(state.rightsAccepts, 0); state.rightsAccepts++; state.rightsAccepted = true; return true;
    }
    if (op === 'composer-mode') return { agent: false, creative: false, ready: true };
    if (op === 'close-empty-agent-panel') return false;
    if (op === 'product-announcement') return false;
    if (op === 'close-agent' || op === 'manual-mode') assert.fail('Normal composer must not switch assistant modes');
    if (op === 'click') return click(arg.name);
    if (op === 'download-option') { if (arg.click) await click(arg.resolution + ' Исходный размер'); return true; }
    if (op === 'image-download-option') { if (arg.click) await click('1K Исходный размер'); return { resolution: '1K' }; }
    if (op === 'exists') return arg.name === 'Видео' ? state.settingsOpen : arg.name === 'Загрузить' ? state.pickerOpen : true;
    if (op === 'account') return state.accountOpen ? options.visibleEmail || EMAIL : null;
    if (op === 'editor-account') return state.videoEditor&&!options.noEditorAvatar?options.visibleEmail||EMAIL:null;
    if (op === 'project') { state.url = 'https://flow.google.com/project/' + (options.edit ? SOURCE_PROJECT : 'project-owned'); return true; }
    if (op === 'radio') { if (arg.set) { for (const item of radioGroup(arg.name)) state.radios.delete(item); state.radios.add(arg.name); return true; } return state.radios.has(arg.name); }
    if (op === 'model-option') { state.model = arg.family || 'Omni 1.2 Flash'; return true; }
    if (op === 'model') return state.model;
    if (op === 'settings-summary') return options.settingsSummary || '720p 8s x1';
    if (op === 'duration') { if (arg.set !== undefined) state.duration = arg.set; return { value: state.duration, text: arg.seconds === state.duration + 3 }; }
    if (op === 'composer') return composer();
    if (op === 'focus-prompt') { state.focused = true; return true; }
    if (op === 'clear-owned') {
      if (state.prompt !== arg.prompt || JSON.stringify(state.ingredients) !== JSON.stringify(arg.ingredients)) return false;
      state.ingredients = []; state.focused = false; return true;
    }
    if (op === 'file-input') { if (state.fileLookups++ < (options.delayedFileInput || 0)) throw failure('FILE_INPUT_AMBIGUOUS'); return { type: 'object', subtype: 'node', objectId: 'file-input-owned' }; }
    if (op === 'asset') {
      if (options.rightsClosingPolls && state.rightsAccepted) assert.ok(state.rightsPendingReads > options.rightsClosingPolls, 'Asset must wait until consent closing animation completes');
      if (options.requireRights && (!state.rightsAccepted || options.repeatRights)) throw failure('FLOW_UPLOAD_CONSENT_REQUIRED');
      const asset = state.assets.get(arg.name);
      if (arg.select && asset) {
        state.selected = asset;
        if (options.cropResources) state.ingredients.push(options.invalidCrop || asset.identity + '-crop');
        else if (options.autoAdd) state.ingredients.push(asset.identity);
      }
      return { exists: Boolean(asset), preview: state.selected === asset && asset && (!options.autoAdd || options.cropResources) ? asset.identity + '?signed=fixture' : null, ingredients: [...state.ingredients] };
    }
    if (op === 'baseline') { assert.match(arg.job, /^[a-f0-9-]{36}$/); state.baselineJob = arg.job; return [{ name: 'existing job', poster: 'existing-poster' }]; }
    if (op === 'submit') {
      assert.equal(state.prompt, arg.prompt);
      assert.deepEqual(state.ingredients, arg.ingredients);
      if (options.image||options.edit) { assert.equal(arg.trusted, true); return { x: 100, y: 100 }; }
      state.submitted++; order.push('submit'); options.onSubmit?.(state);
      return { clicked: true };
    }
    if (op === 'bind-result') {
      assert.equal(state.submitted, options.recover ? 0 : 1); assert.equal(arg.baseline[0].name, 'existing job'); assert.equal(arg.job, state.baselineJob);
      state.bindingReads = (state.bindingReads || 0) + 1;
      if (options.bindingChanged || state.bindingReads <= (options.bindingDelays || 0)) throw failure('RESULT_BINDING_CHANGED');
      if (options.bindingAmbiguous) throw failure('RESULT_AMBIGUOUS');
      state.boundJob = arg.job; return true;
    }
    if (op === 'result') {
      assert.equal(arg.job, state.boundJob);
      if (options.resultError) return { progress: null, error: options.resultError, complete: false };
      if (options.resultLost && (!options.recoverAfterObservation || state.acquisitions === 1)) return null;
      if (arg.open) { if (!options.edit) state.url += '/edit/' + SCENE; state.opened = true; return { progress: 100, error: null, complete: true }; }
      return ++state.resultPolls === 1 ? { progress: 23, error: null, complete: false } : { progress: 100, error: null, complete: true };
    }
    if (op === 'result-poster') return 'https://flow.google.com/asb/result-unique';
    if (op === 'recovery-candidates') {
      assert.equal(state.submitted, options.recoverAfterObservation ? 1 : 0); state.bindingReads = (state.bindingReads || 0) + 1;
      if (options.resultLost && !options.recoverAfterObservation) throw failure('RESULT_LOST');
      if (state.bindingReads <= (options.bindingDelays || 0)) return [];
      return options.recoveryCandidates || [{ name: 'existing job', poster: 'existing-poster' }, { name: 'Generated video', poster: 'https://flow.google.com/asb/result-unique' }];
    }
    if (op === 'open-recovery-candidate') {
      assert.equal(state.submitted, options.recoverAfterObservation ? 1 : 0); state.currentCandidate = arg;
      if (!options.recoveryCandidates) assert.equal(arg.poster, 'https://flow.google.com/asb/result-unique');
      state.opened = true; state.boundJob = state.baselineJob; state.url += '/edit/' + SCENE; return true;
    }
    if (op === 'history') {
      assert.equal(state.opened, true); state.historyReads = (state.historyReads || 0) + 1;
      const ready = state.historyReads > (options.historyDelays || 0);
      if (options.candidateHistory) return { ...options.candidateHistory(state.currentCandidate), ingredientsReady: ready, url: state.url };
      const prompt=options.historyPrompt ?? state.prompt;
      return { text: options.historyText ?? prompt, prompt: Object.hasOwn(options,'historyPrompts') ? options.historyPrompts?.length===1 ? options.historyPrompts[0] : null : prompt, ingredients: ready ? [...state.ingredients] : state.ingredients.map(() => null), ingredientsReady: ready, posters: [options.historyPoster || 'https://flow.google.com/asb/result-unique'], ...(options.edit || options.historySourceVideos !== undefined ? { sourceVideos: options.historySourceVideos ?? ['https://flow-content.google/video/' + GUID] } : {}), url: state.url };
    }
    if (op === 'history-download') {
      assert.equal(state.opened,true);assert.equal(arg.binding.url,state.url);
      assert.equal(arg.binding.poster,options.historyPoster||state.currentCandidate?.poster||'https://flow.google.com/asb/result-unique');
      if(arg.click)state.downloadMenu=true;return true;
    }
    if (op === 'history-download-menu') { assert.equal(state.downloadMenu,true);return {menuId:'fixture-download-menu',needsSubmenu:false}; }
    assert.fail(`Unexpected DOM operation: ${op}`);
  }
  const client = {
    async send(method, params = {}) {
      signal?.throwIfAborted();
      leaseController.signal.throwIfAborted();
      if (released) throw failure('CDP_CLOSED');
      commands.push({ method, params });
      if (method === 'Emulation.setDeviceMetricsOverride') {
        assert.deepEqual(params, { width: options.agentEdit&&params.width===1920?1920:1280, height: options.agentEdit&&params.width===1920?1080:900, deviceScaleFactor: 1, mobile: false });
        state.viewport = { ...params }; return {};
      }
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'location.href') { const next = startup.shift(); if (next instanceof Error) throw next; return { result: { value: next || state.url } }; }
        if (params.expression.startsWith(imageEvaluatePrefix)) {
          assert.equal(options.image, true); assert.equal(params.returnByValue, true); assert.equal(params.awaitPromise, true); assert.equal(params.userGesture, true);
          const [op, arg] = JSON.parse('[' + params.expression.slice(imageEvaluatePrefix.length + 1, -1) + ']');
          (state.imageOps ||= []).push({ op, arg });
          if (op === 'exists') return { result: { value: state.settingsOpen } };
          if (op === 'radio') { if (arg.set) { for (const name of radioGroup(arg.name)) state.radios.delete(name); state.radios.add(arg.name); } return { result: { value: arg.set ? true : state.radios.has(arg.name) } }; }
          if (op === 'choose-model') { state.model = arg.family; return { result: { value: true } }; }
          if (op === 'model') return { result: { value: state.model } };
          assert.fail('Unexpected image settings operation: ' + op);
        }
        assert.ok(params.expression.startsWith(evaluatePrefix));
        assert.equal(params.awaitPromise, true);
        assert.equal(params.userGesture, true);
        const [op, arg] = JSON.parse('[' + params.expression.slice(evaluatePrefix.length + 1, -1) + ']');
        try { const value = await operation(op, arg); return params.returnByValue ? { result: { value } } : { result: value }; }
        catch (error) { if (error.code) return domError(error); throw error; }
      }
      if (method === 'Input.insertText') { assert.equal(state.focused, true); state.prompt = params.text; return {}; }
      if (method === 'Page.setWebLifecycleState') { assert.ok(options.image || options.edit); assert.deepEqual(params, { state: 'active' }); return {}; }
      if (method === 'Emulation.setFocusEmulationEnabled') { assert.ok(options.image || options.edit); assert.deepEqual(params, { enabled: true }); return {}; }
      if (method === 'Input.dispatchMouseEvent') {
        assert.ok(options.image || options.edit, 'Ordinary video submission must use verified website DOM click');
        assert.deepEqual(params, { type: params.type, button: params.type === 'mouseMoved' ? 'none' : 'left', buttons: params.type === 'mousePressed' ? 1 : 0, ...(params.type === 'mousePressed' ? { force: 0.5 } : {}), modifiers: 0, clickCount: params.type === 'mouseMoved' ? 0 : 1, x: 100, y: 100 });
        if (params.type === 'mousePressed') { if (options.edit && state.videoPicker) state.videoTrustedUploads = (state.videoTrustedUploads || 0) + 1; else { state.submitted++; order.push('submit'); options.onSubmit?.(state); } }
        if(params.type==='mouseReleased'&&options.edit&&state.videoPicker&&!options.noVideoChooser){assert.equal(state.intercepting,true);for(const params of options.videoChooserEvents||[{frameId:FRAME,backendNodeId:73,mode:'selectMultiple'}])emit('Page.fileChooserOpened',params);}
        return {};
      }
      if (method === 'Page.enable') return {};
      if(method==='Page.reload'){assert.ok(options.edit||options.recover);state.readOnlyReloads=(state.readOnlyReloads||0)+1;return {};}
      if (method === 'Page.navigate') { assert.ok(options.recover || options.recoverAfterObservation); state.url = params.url; state.videoEditor=/\/edit\//.test(state.url);state.opened = false; state.currentCandidate = null; return { frameId: FRAME }; }
      if (method === 'Page.setInterceptFileChooserDialog') { state.intercepting = params.enabled; return {}; }
      if (method === 'DOM.resolveNode') { assert.equal(options.edit,true);assert.deepEqual(params,{backendNodeId:73});state.videoResolved=true;return {object:{type:'object',subtype:'node',objectId:'video-file-input-owned'}}; }
      if (method === 'Runtime.callFunctionOn') {
        assert.equal(options.edit,true);assert.equal(params.objectId,'video-file-input-owned');assert.equal(params.returnByValue,true);assert.equal(params.awaitPromise,true);assert.equal(params.userGesture,true);assert.equal(params.arguments[0].value,state.url);assert.equal(params.arguments[1].value,'.mp4');assert.ok(params.functionDeclaration.includes('this instanceof HTMLInputElement'));
        return {result:{value:{file:true,connected:true,sameDocument:true,sameWindow:true,rootDocument:true,rootSelf:false,flowOrigin:true,acceptVideo:true,url:state.url,...(options.videoInputMetadata||{})}}};
      }
      if (method === 'DOM.setFileInputFiles') {
        assert.equal(params.objectId, options.edit&&/\.(mp4|mov|m4v)$/i.test(params.files[0])?'video-file-input-owned':'file-input-owned'); assert.equal(params.files.length, 1);
        const file = params.files[0], bytes = await fs.readFile(file), name = path.basename(file), stat = await fs.stat(file);
        assert.equal(stat.mode & 0o777, 0o600);
        assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
        if (options.edit && /\.(mp4|mov|m4v)$/i.test(file)) {
          (state.videoUploads ||= []).push({ file, name, bytes }); return {};
        }
        options.onFile?.(file, bytes, state); signal?.throwIfAborted();
        const asset = { identity: 'https://flow-content.google/image/asset-' + (uploads.length + 1), name };
        state.assets.set(name, asset); uploads.push({ file, name, bytes, identity: asset.identity }); return {};
      }
      if (method === 'Runtime.releaseObject') { assert.ok(['file-input-owned','video-file-input-owned'].includes(params.objectId));if(params.objectId==='video-file-input-owned')state.videoInputReleased=true;return {}; }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: FRAME } } };
      if (method === 'Page.captureScreenshot') {
        assert.deepEqual(params, { format: 'png', captureBeyondViewport: false });
        if (options.screenshotError) throw failure('SCREENSHOT_FAILED', 'Screenshot must not replace transaction failure');
        return { data: PNG.split(',')[1] };
      }
      assert.fail(`Unexpected CDP command: ${method}`);
    },
    async browserSend(method, params) {
      signal?.throwIfAborted(); leaseController.signal.throwIfAborted(); commands.push({ method, params, browser: true });
      if (method === 'Browser.setDownloadBehavior') { assert.equal(params.behavior, 'allowAndName'); assert.equal(params.eventsEnabled, true); state.downloadFolder = params.downloadPath; return {}; }
      if (method === 'Browser.cancelDownload') return {};
      assert.fail(`Unexpected browser command: ${method}`);
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const makeLease = () => Object.freeze({ accountId: 7, email: options.leaseEmail || EMAIL, targetId: 'target-owned-' + (state.acquisitions + 1), sessionId: 'session-owned-' + (state.acquisitions + 1), signal: leaseController.signal, client });
  let lease = makeLease();
  const leases = [lease], releasedLeases = new WeakSet();
  const accounts = {
    async acquireIsolatedGenerationBrowser(id, args) {
      assert.equal(id, 7);state.lastAcquireOptions=args; signal = args.signal; signal?.throwIfAborted();
      if (state.acquisitions) {
        assert.equal(options.recoverAfterObservation, true); assert.equal(released, true);
        assert.ok(releasedLeases.has(lease)); options.onRecoveryAcquire?.();
        released = false; leaseController = new AbortController(); lease = makeLease(); leases.push(lease);
        state.url = 'https://flow.google.com/'; state.opened = false; state.currentCandidate = null;
      }
      state.acquisitions++; order.push('acquire'); return lease;
    },
    async releaseIsolatedGenerationBrowser(value) { assert.ok(leases.includes(value)); if (!releasedLeases.has(value)) { releasedLeases.add(value); released = true; state.releases++; order.push('release'); } },
  };
  const engine = createBrowserEngine({ accounts, dataDir, agentEdit: options.agentEdit ?? false, observationRefreshMs: options.observationRefreshMs??30000, pollMs: 1, bindingTimeoutMs: options.bindingTimeoutMs ?? 20, confirmUploadRights: options.confirmUploadRights, inspectVideo: options.inspectVideo });
  return { engine, client, state, commands, ops, uploads, order, dataDir, listeners, leases, get lease() { return lease; }, get leaseController() { return leaseController; } };
}

test('model and input plan preserves exact selection and rejects unsupported routes before acquisition', async t => {
  const h = await harness(t);
  const plan = planFor(input({ model: 'omni-1.2-flash-15s-portrait-360p', references: [{ kind: 'image', dataUrl: PNG }] }));
  assert.equal(plan.model, 'omni-1.2-flash-15s-portrait-360p');
  assert.deepEqual([plan.seconds, plan.aspect, plan.resolution], [15, '9:16', '360p']);
  assert.equal(plan.prompt, input().prompt);
  for (const value of [input({ model: 'omni-1.1-flash-8s-landscape' }), input({ references: [{ kind: 'video' }] }), input({ sourceVideoId: 'existing-video' }), input({ prompt: ' ' })]) {
    await assert.rejects(h.engine.generate(value, { beforeSubmit: () => assert.fail('Unsupported input reached submit') }));
  }
  assert.equal(h.state.acquisitions, 0);
  assert.deepEqual(h.commands, []);
  assert.equal(h.engine.supports(input()), true);
  assert.equal(h.engine.supports(input({ model: 'omni-1.1-flash-8s-landscape' })), false);
});

test('Omni 1.2 frames plans preserve ordered start/end references and model-dependent frame limits', async t => {
  const start = { kind: 'image', dataUrl: PNG }, end = { kind: 'image', dataUrl: GIF };
  const h = await harness(t);
  for (const seconds of [3, 10]) for (const refs of [[start], [start, end]]) {
    const model = `omni-1.2-flash-i2v-${seconds}s-portrait-360p`, plan = planFor(input({ model, references: refs }));
    assert.equal(plan.model, model); assert.equal(plan.method, 'frames'); assert.equal(plan.seconds, seconds);
    assert.equal(plan.aspect, '9:16'); assert.equal(plan.resolution, '360p'); assert.equal(plan.prompt, input().prompt);
    assert.deepEqual(plan.refs, refs); assert.equal(plan.refs[0], start); if (refs.length === 2) assert.equal(plan.refs[1], end);
    assert.equal(h.engine.supports({ model }), true);
  }
  for (const seconds of [11, 15]) {
    const model = `omni-1.2-flash-i2v-${seconds}s-landscape`, plan = planFor(input({ model, images: [PNG] }));
    assert.equal(plan.method, 'frames'); assert.equal(plan.seconds, seconds); assert.equal(plan.aspect, '16:9'); assert.equal(plan.resolution, '720p');
    assert.deepEqual(plan.refs, [start]);
    assert.throws(() => planFor(input({ model, references: [start, end] })), { code: 'BROWSER_INPUT_UNSUPPORTED' });
  }
  for (const refs of [[], [start, end, start], [{ kind: 'video', path: '/fixture/source.mp4' }]]) {
    await assert.rejects(h.engine.prepare(input({ model: 'omni-1.2-flash-i2v-10s-landscape', references: refs })), { code: 'BROWSER_INPUT_UNSUPPORTED' });
  }
  assert.throws(() => planFor(input({ model: 'omni-1.2-flash-i2v-10s-landscape', references: [start], sourceVideoId: 'source' })), { code: 'BROWSER_INPUT_UNSUPPORTED' });
  for (const model of ['omni-1.2-flash-i2v-2s-landscape', 'omni-1.2-flash-i2v-16s-landscape', 'omni-1.1-flash-i2v-8s-landscape']) assert.equal(h.engine.supports({ model }), false);
  assert.equal(planFor(input()).method, 'ingredients');
  assert.equal(planFor(input({ references: [start, end] })).method, 'ingredients');
  assert.equal(h.state.acquisitions, 0); assert.deepEqual(h.commands, []);
});

test('all43 standard Veo IDs keep explicit model and method when selecting browser route', async t => {
  const h = await harness(t), models = [];
  for (const family of ['lite', 'fast', 'quality']) {
    models.push(`veo-3.1-${family}`);
    for (const method of ['', '-i2v']) for (const seconds of [4, 6, 8]) for (const aspect of ['landscape', 'portrait']) models.push(`veo-3.1-${family}${method}-${seconds}s-${aspect}`);
  }
  for (const family of ['lite', 'fast']) for (const aspect of ['landscape', 'portrait']) models.push(`veo-3.1-${family}-r2v-8s-${aspect}`);
  assert.equal(models.length, 43);
  for (const model of models) {
    assert.equal(h.engine.supports({ model }), true, model);
    const method = model.includes('-i2v-') ? 'frames' : model.includes('-r2v-') ? 'ingredients' : 'text';
    const references = method === 'text' ? [] : [{ kind: 'image', dataUrl: PNG }];
    const plan = planFor(input({ model, references }));
    assert.equal(plan.model, model); assert.equal(plan.kind, 'video'); assert.equal(plan.method, method); assert.equal(plan.resolution, '720p');
  }
  assert.equal(h.state.acquisitions, 0);
});

test('Veo8s text ingredients and frames use exact family and summary without Omni slider or resolution radio', async t => {
  for (const [model, references, method] of [
    ['veo-3.1-fast-8s-landscape', [], 'text'],
    ['veo-3.1-lite-r2v-8s-portrait', [{ kind: 'image', dataUrl: PNG }, { kind: 'image', dataUrl: GIF }], 'ingredients'],
    ['veo-3.1-fast-i2v-8s-landscape', [{ kind: 'image', dataUrl: PNG }, { kind: 'image', dataUrl: GIF }], 'frames'],
  ]) {
    const h = await harness(t), jobId = crypto.randomUUID(); let durable = 0;
    const result = await h.engine.generate(input({ model, references, jobId }), { beforeSubmit: async () => {
      durable++; const receipt = JSON.parse(await fs.readFile(path.join(h.dataDir, 'browser-receipts', jobId + '.json'), 'utf8'));
      assert.equal(receipt.model, model); assert.deepEqual(receipt.ingredients, h.uploads.map(upload => upload.identity));
    } });
    assert.equal(h.state.model, model.includes('-lite') ? 'Veo 3.1 - Lite' : 'Veo 3.1 - Fast');
    assert.ok(h.state.radios.has('Видео')); assert.ok(h.state.radios.has(method === 'frames' ? 'Кадры' : 'Ингредиенты'));
    assert.ok(h.state.radios.has(model.endsWith('portrait') ? '9:16' : '16:9')); assert.ok(h.state.radios.has('x1'));
    assert.equal(h.ops.some(op => op.op === 'duration'), false);
    assert.equal(h.ops.some(op => op.op === 'radio' && ['720p', '360p 360p: видео генерируется быстрее, но разрешение ниже'].includes(op.arg.name)), false);
    assert.ok(h.ops.filter(op => op.op === 'settings-summary').length >= 3);
    assert.equal(durable, 1); assert.equal(h.state.submitted, 1); assert.equal(h.uploads.length, references.length); assert.equal(h.state.releases, 1);
    if (method === 'frames') assert.deepEqual(h.state.frameRoles, ['Старт', 'Конец']);
    assert.equal(result.media[0].kind, 'video'); assert.deepEqual(await fs.readFile(result.media[0].path), MP4);
  }
});

test('Veo4s and6s keep requested IDs but fail before upload or submission without8s fallback', async t => {
  for (const seconds of [4, 6]) {
    const h = await harness(t), model = `veo-3.1-quality-${seconds}s-portrait`;
    await assert.rejects(h.engine.generate(input({ model, jobId: crypto.randomUUID() }), { beforeSubmit: () => assert.fail('Unavailable duration reached paid boundary') }), { code: 'MODEL_DURATION_UNAVAILABLE' });
    assert.equal(h.state.model, 'Veo 3.1 - Quality'); assert.equal(planFor(input({ model })).model, model);
    assert.equal(h.state.submitted, 0); assert.equal(h.uploads.length, 0); assert.equal(h.state.releases, 1);
    assert.equal(h.ops.some(op => op.op === 'submit' || op.op === 'duration'), false);
    await assert.rejects(fs.access(path.join(h.dataDir, 'browser-receipts')), { code: 'ENOENT' });
  }
});

test('Edit plan pins one absolute source video and preserves up to5 ordered image references', () => {
  const video = { kind: 'video', path: '/fixture/source.MOV' }, images = [PNG, GIF, PNG, GIF, PNG].map(dataUrl => ({ kind: 'image', dataUrl }));
  const model = 'omni-1.2-flash-edit-portrait-360p', plan = planFor(input({ model, references: [images[0], video, ...images.slice(1)] }));
  assert.equal(plan.method, 'edit'); assert.equal(plan.model, model); assert.equal(plan.prompt, input().prompt);
  assert.equal(plan.aspect, '9:16'); assert.equal(plan.resolution, '360p'); assert.equal(plan.video, video); assert.deepEqual(plan.refs, images);
  assert.equal(plan.seconds, undefined);
  for (const references of [[], images, [video, video], [video, ...images, images[0]], [{ kind: 'video', path: 'relative.mp4' }], [video, { kind: 'audio', path: '/fixture/audio.mp3' }]]) {
    assert.throws(() => planFor(input({ model, references })), { code: 'BROWSER_INPUT_UNSUPPORTED' });
  }
});

test('Edit rejects mixed local source video and extension sourceVideoId before metadata or browser work', async t => {
  const model = 'omni-1.2-flash-edit-landscape', references = [{ kind: 'video', path: '/fixture/source.mp4' }];
  let inspected = 0;
  const h = await harness(t, { inspectVideo: async () => { inspected++; return { durationSeconds: 3, mimeType: 'video/mp4', width: 1280, height: 720 }; } });
  const value = input({ model, references, sourceVideoId: 'existing-flow-video' });
  assert.throws(() => planFor(value), { code: 'BROWSER_INPUT_UNSUPPORTED' });
  await assert.rejects(h.engine.prepare(value), { code: 'BROWSER_INPUT_UNSUPPORTED' });
  assert.equal(inspected, 0); assert.equal(h.state.acquisitions, 0); assert.deepEqual(h.commands, []);
});

test('Edit source metadata must be inspected before browser acquisition and propagated validator failures block uploads', async t => {
  const model = 'omni-1.2-flash-edit-landscape', references = [{ kind: 'video', path: '/fixture/source.mp4' }];
  const noValidator = await harness(t);
  await assert.rejects(noValidator.engine.prepare(input({ model, references })), { code: 'VIDEO_METADATA_UNAVAILABLE' });
  assert.equal(noValidator.state.acquisitions, 0); assert.deepEqual(noValidator.commands, []);
  for (const [code, message] of [['VIDEO_DURATION_EXCEEDED', 'Source duration16s exceeds15s'], ['VIDEO_SIZE_EXCEEDED', 'Source exceeds100MiB'], ['VIDEO_UNSAFE', 'Source is not a regular file']]) {
    const controller = new AbortController(), expected = failure(code, message); let checked = 0, h;
    h = await harness(t, { inspectVideo: async details => {
      checked++; assert.equal(details.path, references[0].path); assert.equal(details.signal, controller.signal);
      assert.equal(h.state.acquisitions, 0); assert.deepEqual(h.commands, []); throw expected;
    } });
    await assert.rejects(h.engine.prepare(input({ model, references }), { signal: controller.signal }), error => error === expected);
    assert.equal(checked, 1); assert.equal(h.state.acquisitions, 0); assert.equal(h.uploads.length, 0); assert.deepEqual(h.commands, []);
  }
});

test('malformed Edit metadata or source duration above15.02 seconds fails before acquiring browser', async t => {
  for (const metadata of [
    null, {}, { durationSeconds: 0, mimeType: 'video/mp4' }, { durationSeconds: -1, mimeType: 'video/mp4' },
    { durationSeconds: NaN, mimeType: 'video/mp4' }, { durationSeconds: Infinity, mimeType: 'video/mp4' },
    { durationSeconds: '3', mimeType: 'video/mp4' }, { durationSeconds: 15.021, mimeType: 'video/mp4' },
    { durationSeconds: 3, mimeType: 'video/webm' }, { durationSeconds: 3, mimeType: 'application/octet-stream' }, { durationSeconds: 3 },
  ]) {
    const h = await harness(t, { inspectVideo: async () => metadata });
    await assert.rejects(h.engine.prepare(input({ model: 'omni-1.2-flash-edit-landscape', references: [{ kind: 'video', path: '/fixture/source.mp4' }] })), { code: 'VIDEO_METADATA_INVALID' });
    assert.equal(h.state.acquisitions, 0); assert.equal(h.uploads.length, 0); assert.deepEqual(h.commands, []);
  }
});

test('Edit dimensions must exactly match requested aspect and resolution before browser acquisition', async t => {
  for (const [model, expected] of [
    ['omni-1.2-flash-edit-landscape', [1280, 720]], ['omni-1.2-flash-edit-portrait', [720, 1280]],
    ['omni-1.2-flash-edit-landscape-360p', [640, 360]], ['omni-1.2-flash-edit-portrait-360p', [360, 640]],
  ]) for (const dimensions of [{}, { width: expected[0] }, { height: expected[1] }, { width: -1, height: expected[1] }, { width: expected[1], height: expected[0] }, { width: 1920, height: 1080 }]) {
    const h = await harness(t, { inspectVideo: async () => ({ durationSeconds: 3, mimeType: 'video/mp4', ...dimensions }) });
    await assert.rejects(h.engine.prepare(input({ model, references: [{ kind: 'video', path: '/fixture/source.mp4' }] })), { code: 'MODEL_SETTINGS_NOT_VERIFIED' });
    assert.equal(h.state.acquisitions, 0); assert.equal(h.uploads.length, 0); assert.equal(h.state.submitted, 0); assert.deepEqual(h.commands, []);
  }
});

test('explicit omni1.2 alias keeps chosen ID while using8s landscape720p for zero or one reference', async t => {
  for (const references of [[], [{ kind: 'image', dataUrl: PNG }]]) {
    const h = await harness(t), model = 'omni-1.2-flash', plan = planFor(input({ model, references }));
    assert.equal(h.engine.supports({ model }), true); assert.equal(plan.model, model);
    assert.deepEqual([plan.seconds, plan.aspect, plan.resolution], [8, '16:9', '720p']);
    assert.deepEqual(plan.refs, references);
    const prepared = await h.engine.prepare(input({ model, references }));
    assert.equal(prepared.plan.model, model); assert.equal(h.state.duration, 5); assert.equal(h.state.model, 'Omni 1.2 Flash');
    assert.ok(h.state.radios.has('16:9')); assert.ok(h.state.radios.has('720p')); assert.equal(h.uploads.length, references.length);
    assert.equal(h.state.submitted, 0); await h.engine.release(prepared); assert.equal(h.state.releases, 1);
  }
});

test('Edit transaction privately stages one video, accepts exact legal confirmation, and pins source receipt before one fake submit', async t => {
  const sourceFolder = await temporary(t), originalPath = path.join(sourceFolder, 'original.mp4'); await fs.writeFile(originalPath, MP4);
  let confirmations = 0, durable = 0;
  const h = await harness(t, { edit: true, requireVideoRights: true, inspectVideo: async ({ path: file }) => { if(file!==originalPath){assert.equal(path.basename(file),'result.mp4');assert.deepEqual(await fs.readFile(file),MP4);}return { durationSeconds:file===originalPath?3.029333:3, mimeType: 'video/mp4', width: 1280, height: 720 }; }, confirmUploadRights: async details => { confirmations++; assert.equal(details.accountEmail, EMAIL); return true; } });
  const jobId = crypto.randomUUID(), model = 'omni-1.2-flash-edit-landscape', refs = [PNG, GIF, PNG, GIF, PNG];
  const result = await h.engine.generate(input({ model, jobId, references: [{ kind: 'video', path: originalPath }, ...refs.map(dataUrl => ({ kind: 'image', dataUrl }))] }), { beforeSubmit: async () => {
    durable++; assert.equal(h.state.submitted, 0);
    const receipt = JSON.parse(await fs.readFile(path.join(h.dataDir, 'browser-receipts', jobId + '.json'), 'utf8'));
    assert.equal(receipt.model, model); assert.equal(receipt.sourceVideo, undefined);
    assert.deepEqual(receipt.baseline, []);
    assert.deepEqual(receipt.sourceScene, { url: 'https://flow.google.com/project/' + SOURCE_PROJECT + '/edit/' + SCENE, poster: 'https://flow.google.com/asb/source-video-poster', sha256: crypto.createHash('sha256').update(MP4).digest('hex'), durationSeconds: 3.029333, width: 1280, height: 720 });
    assert.deepEqual(receipt.ingredients, h.uploads.map(upload => upload.identity));
    assert.equal(h.state.videoInputReleased, true); assert.equal(h.state.videoUploads.length, 1);
    const staged = h.state.videoUploads[0]; assert.notEqual(staged.file, originalPath); assert.deepEqual(staged.bytes, MP4);
    assert.equal((await fs.stat(staged.file)).mode & 0o777, 0o600); assert.equal((await fs.stat(path.dirname(staged.file))).mode & 0o777, 0o700);
  } });
  assert.equal(confirmations, 1); assert.equal(h.state.rightsAccepts, 1); assert.equal(h.state.videoTrustedUploads, 1);
  assert.equal(h.uploads.length, 5); assert.deepEqual(h.uploads.map(upload => upload.bytes), refs.map(value => Buffer.from(value.split(',')[1], 'base64')));
  assert.equal(h.state.frameRoles, undefined); assert.equal(h.ops.some(op => op.op === 'duration'), false);
  assert.equal(h.ops.some(op => ['baseline','bind-result','recovery-candidates','open-recovery-candidate'].includes(op.op)), false);
  assert.equal(h.ops.filter(op => op.op === 'edit-settings').length >= 3, true);
  assert.equal(durable, 1); assert.equal(h.state.submitted, 1); assert.equal(h.state.releases, 1);
  assert.equal(result.media[0].kind, 'video'); assert.deepEqual(await fs.readFile(originalPath), MP4);
  for (const file of [...h.uploads.map(upload => upload.file), h.state.videoUploads[0].file]) await assert.rejects(fs.access(file), { code: 'ENOENT' });
});

test('Edit source upload uses one main-frame native chooser event and releases remote input interception and listener',async t=>{
 const folder=await temporary(t),file=path.join(folder,'source.mp4');await fs.writeFile(file,MP4);
 const h=await harness(t,{edit:true,inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720})});
 const prepared=await h.engine.prepare(input({model:'omni-1.2-flash-edit-landscape',references:[{kind:'video',path:file}]}));
 assert.equal(h.state.videoUploads.length,1);assert.equal(h.state.videoTrustedUploads,1);assert.equal(h.state.videoResolved,true);assert.equal(h.state.videoInputReleased,true);assert.equal(h.state.intercepting,false);assert.equal(h.listeners.size,0);assert.equal(h.ops.some(op=>['arm-video-input','video-input','release-video-input'].includes(op.op)),false);
 assert.deepEqual(h.commands.filter(command=>command.method==='Page.setInterceptFileChooserDialog').map(command=>command.params.enabled),[true,false]);await h.engine.release(prepared);
});

test('Edit source chooser accepts its exact native-event input in a removed overlay subtree of the same document and window',async t=>{
 const folder=await temporary(t),file=path.join(folder,'source.mp4');await fs.writeFile(file,MP4);
 const h=await harness(t,{edit:true,videoInputMetadata:{connected:false,rootDocument:false,rootSelf:false},inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720})});
 const prepared=await h.engine.prepare(input({model:'omni-1.2-flash-edit-landscape',references:[{kind:'video',path:file}]}));
 assert.equal(h.state.videoUploads.length,1);assert.equal(h.state.videoTrustedUploads,1);assert.equal(h.state.intercepting,false);assert.equal(h.listeners.size,0);await h.engine.release(prepared);
});

test('Edit source chooser rejects wrong frame invalid node repeated events and wrong input before assigning any files',async t=>{
 const folder=await temporary(t),file=path.join(folder,'source.mp4');await fs.writeFile(file,MP4);
 for(const patch of [
  {videoChooserEvents:[{frameId:'foreign-frame',backendNodeId:73,mode:'selectMultiple'}]},
  {videoChooserEvents:[{frameId:FRAME,backendNodeId:0,mode:'selectMultiple'}]},
  {videoChooserEvents:[{frameId:FRAME,backendNodeId:73,mode:'other'}]},
  {videoChooserEvents:[{frameId:FRAME,backendNodeId:73,mode:'selectMultiple'},{frameId:FRAME,backendNodeId:74,mode:'selectMultiple'}]},
  {videoInputMetadata:{connected:false,rootDocument:false,rootSelf:true,sameDocument:false}},
  {videoInputMetadata:{connected:false,rootDocument:false,rootSelf:true,sameWindow:false}},
  {videoInputMetadata:{flowOrigin:false}},
  {videoInputMetadata:{acceptVideo:false}},
 ]){
  const h=await harness(t,{edit:true,...patch,inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720})});
  await assert.rejects(h.engine.prepare(input({model:'omni-1.2-flash-edit-landscape',references:[{kind:'video',path:file}]})),error=>['FILE_INPUT_AMBIGUOUS','SOURCE_VIDEO_NOT_VERIFIED'].includes(error.code));
  assert.equal(h.state.videoUploads,undefined);assert.equal(h.state.videoTrustedUploads,1);assert.equal(h.state.intercepting,false);assert.equal(h.listeners.size,0);assert.equal(h.state.releases,1);assert.equal(h.commands.some(command=>command.method==='DOM.setFileInputFiles'),false);
 }
});

test('Edit source chooser timeout or attachment failure never retries and always disables interception',async()=>{
 for(const stage of ['timeout','inspect','assign']){
  const commands=[],listeners=new Set();let clicks=0,assigned=0,inspectedFunction;
  const page=new FlowPage({onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},send:async(method,params={})=>{
   commands.push({method,params});
   if(method==='Page.getFrameTree')return {frameTree:{frame:{id:FRAME}}};
   if(method==='DOM.resolveNode')return {object:{subtype:'node',objectId:'owned-input'}};
   if(method==='Runtime.callFunctionOn'){inspectedFunction=params.functionDeclaration;if(stage==='inspect')return {exceptionDetails:{}};return {result:{value:{file:true,connected:true,sameDocument:true,sameWindow:true,rootDocument:true,rootSelf:false,flowOrigin:true,acceptVideo:true,url:'https://flow.google.com/project/owned'}}};}
   if(method==='DOM.setFileInputFiles'){assigned++;throw failure('ATTACHMENT_FAILED');}
   return {};
  }});
  page.run=async()=>({url:'https://flow.google.com/project/owned'});
  page.trustedControlClick=async()=>{clicks++;if(stage!=='timeout')for(const listener of listeners)listener({method:'Page.fileChooserOpened',params:{frameId:FRAME,backendNodeId:73,mode:'selectMultiple'}});};
  page.until=async fn=>{const value=await fn();if(!value)throw failure('FLOW_UI_TIMEOUT');return value;};
  await assert.rejects(page.uploadSourceVideo('/fixture/source.mp4'),{code:stage==='timeout'?'FLOW_UI_TIMEOUT':stage==='inspect'?'SOURCE_VIDEO_NOT_VERIFIED':'ATTACHMENT_FAILED'});
  assert.equal(clicks,1);assert.equal(assigned,stage==='assign'?1:0);assert.equal(listeners.size,0);assert.deepEqual(commands.filter(command=>command.method==='Page.setInterceptFileChooserDialog').map(command=>command.params.enabled),[true,false]);
  assert.equal(commands.filter(command=>command.method==='Runtime.releaseObject').length,stage==='timeout'?0:1);
  if(inspectedFunction){class Input{}const element=new Input(),document={},context={HTMLInputElement:Input,document,location:{origin:'https://flow.google.com',href:'https://flow.google.com/project/owned'}};Object.assign(element,{type:'file',isConnected:true,ownerDocument:document,getRootNode:()=>document,getAttribute:()=>'.png,.mp4,.mov'});const inspect=vm.runInNewContext('document.defaultView=globalThis;('+inspectedFunction+')',context);assert.equal(inspect.call(element,'https://flow.google.com/project/owned','.mp4').acceptVideo,true);element.isConnected=false;element.getRootNode=()=>element;const detached=inspect.call(element,'https://flow.google.com/project/owned','.mp4');assert.equal(detached.sameDocument,true);assert.equal(detached.sameWindow,true);assert.equal(detached.rootSelf,true);assert.equal(detached.rootDocument,false);element.getRootNode=()=>({host:{}});assert.equal(inspect.call(element,'https://flow.google.com/project/owned','.mp4').rootSelf,false);element.getAttribute=()=>'.png';assert.equal(inspect.call(element,'https://flow.google.com/project/owned','.mp4').acceptVideo,false);element.type='text';assert.equal(inspect.call(element,'https://flow.google.com/project/owned','.mp4').file,false);}
 }
});

test('Edit credit quote mismatch stops before prompt references receipt or paid callback and closes its menu',async t=>{
 const folder=await temporary(t),file=path.join(folder,'source.mp4');await fs.writeFile(file,MP4);
 const h=await harness(t,{edit:true,editCreditQuote:9,inspectVideo:async()=>({durationSeconds:3.029333,mimeType:'video/mp4',width:360,height:640})});
 await assert.rejects(h.engine.generate(input({jobId:crypto.randomUUID(),model:'omni-1.2-flash-edit-portrait-360p',references:[{kind:'video',path:file},{kind:'image',dataUrl:PNG}]}),{beforeSubmit:()=>assert.fail('Mismatched quote reached paid boundary')}),error=>error.code==='MODEL_SETTINGS_NOT_VERIFIED'&&/360p/.test(error.message)&&/9/.test(error.message));
 assert.equal(h.state.submitted,0);assert.equal(h.state.editMenuOpen,false);assert.equal(h.uploads.length,0);assert.equal(h.ops.some(op=>op.op==='focus-prompt'||op.op==='submit'),false);assert.equal(h.state.releases,1);
 await assert.rejects(fs.access(path.join(h.dataDir,'browser-receipts')),{code:'ENOENT'});
});

test('Edit rechecks the quote before durable submission and keeps published extended-duration rates fail closed',async t=>{
 const folder=await temporary(t),file=path.join(folder,'source.mp4');await fs.writeFile(file,MP4);let credits=3;
 const h=await harness(t,{edit:true,inspectVideo:async()=>({durationSeconds:3.029333,mimeType:'video/mp4',width:360,height:640}),operation(op,arg,state){if(op==='edit-settings'&&arg.quote)return {model:'Omni 1.2 Flash',clipCount:1,url:state.url,credits};}});
 const prepared=await h.engine.prepare(input({jobId:crypto.randomUUID(),model:'omni-1.2-flash-edit-portrait-360p',references:[{kind:'video',path:file}]}));credits=9;
 await assert.rejects(h.engine.submit(prepared,{beforeSubmit:()=>assert.fail('Changed quote reached durable callback')}),{code:'MODEL_SETTINGS_NOT_VERIFIED'});assert.equal(h.state.submitted,0);assert.equal(h.state.editMenuOpen,false);await assert.rejects(fs.access(path.join(h.dataDir,'browser-receipts')),{code:'ENOENT'});await h.engine.release(prepared);
 for(const [resolution,durationSeconds,quote] of [['360p',12,14],['720p',12,42],['720p',10.026667,30]]){
  const calls=[],page=new FlowPage({});page.run=async(op,arg)=>{calls.push({op,arg});return arg?.quote?{model:'Omni 1.2 Flash',url:'source',credits:quote}:true;};page.until=async fn=>fn();
  await page.verifyEditSettings({resolution},{url:'source',durationSeconds});assert.equal(calls.at(-1).arg.close,true);
 }
});

test('Edit quote reads only the model control owned menu and rejects malformed or ambiguous costs',()=>{
 let expanded=true,costText='9 credits',costCount=1,menusAvailable=true;
 const model={innerText:'Omni 1.2 Flash arrow_drop_down',getClientRects:()=>[1],getAttribute:key=>key==='aria-label'?'Select model family':key==='aria-expanded'?String(expanded):key==='aria-controls'?'own-edit-menu':null,click:()=>{expanded=!expanded;}};
 const cost={getClientRects:()=>[1],getAttribute:()=>null,get innerText(){return costText;}};
 const menu={getClientRects:()=>[1],getAttribute:key=>key==='id'?'own-edit-menu':key==='role'?'menu':null,querySelectorAll:selector=>selector==='flow-credit-cost-label .credit-cost-link'?Array(costCount).fill(cost):[]};
 const context={location:{origin:'https://flow.google.com',href:'exact-scene'},getComputedStyle:()=>({visibility:'visible'}),document:{querySelector:()=>null,querySelectorAll:selector=>selector==='button,[role="button"]'?[model]:selector==='flow-scene-timeline .clip'?[{}]:selector==='[id]'&&menusAvailable?[menu]:[]}};
 const run=arg=>vm.runInNewContext('('+flowDOM.toString()+')('+'"edit-settings",'+JSON.stringify(arg)+')',context);
 assert.equal(run({quote:true}).credits,9);costText='9 credits extra';assert.throws(()=>run({quote:true}),/MODEL_SETTINGS_NOT_VERIFIED/);costText='9 credits';costCount=2;assert.throws(()=>run({quote:true}),/MODEL_SETTINGS_NOT_VERIFIED/);
 costCount=1;menusAvailable=false;assert.equal(run({quote:true}),false);menusAvailable=true;assert.equal(run({close:true}),true);assert.equal(expanded,false);assert.equal(run({quote:true}),false);
});

test('Edit uses one stable trusted Generate press after durable receipt and input verification without a DOM paid click',async t=>{
 const folder=await temporary(t),file=path.join(folder,'source.mp4');await fs.writeFile(file,MP4);let durable=false;
 const jobId=crypto.randomUUID(),h=await harness(t,{edit:true,inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720}),onSubmit(){assert.equal(durable,true);},operation(op,arg){if(op==='submit'){assert.equal(durable,true);assert.equal(arg.trusted,true);}}});
 const result=await h.engine.generate(input({jobId,model:'omni-1.2-flash-edit-landscape',references:[{kind:'video',path:file},{kind:'image',dataUrl:PNG},{kind:'image',dataUrl:GIF}]}),{beforeSubmit:async()=>{assert.equal(h.state.submitted,0);const receipt=JSON.parse(await fs.readFile(path.join(h.dataDir,'browser-receipts',jobId+'.json'),'utf8'));assert.equal(receipt.ingredients.length,2);await tick();durable=true;}});
 assert.equal(result.media[0].kind,'video');assert.equal(h.state.submitted,1);assert.equal(h.state.videoTrustedUploads,1);assert.equal(h.ops.filter(op=>op.op==='submit').length,1);
 assert.equal(h.ops.filter(op=>op.op==='control-box'&&op.arg.name==='Начать генерацию').length,2);
 assert.deepEqual(h.commands.filter(command=>command.method==='Input.dispatchMouseEvent').map(command=>command.params.type),['mouseMoved','mousePressed','mouseReleased','mouseMoved','mousePressed','mouseReleased']);
 assert.equal(h.state.acquisitions,1);assert.equal(h.state.releases,1);
});

test('Edit input drift at final DOM validation and unstable Generate control never press or resubmit',async t=>{
 const folder=await temporary(t),file=path.join(folder,'source.mp4');await fs.writeFile(file,MP4);
 for(const changed of ['prompt','control']){
  const h=await harness(t,{edit:true,inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720}),operation(op,arg,state){if(op==='submit'&&changed==='prompt')throw failure('PREPARED_INPUT_CHANGED');if(op==='control-box'&&arg.name==='Начать генерацию')throw failure('CONTROL_DISABLED');}});
  await assert.rejects(h.engine.generate(input({jobId:crypto.randomUUID(),model:'omni-1.2-flash-edit-landscape',references:[{kind:'video',path:file}]}),{beforeSubmit:()=>{}}),{code:changed==='prompt'?'PREPARED_INPUT_CHANGED':'CONTROL_DISABLED'});
  assert.equal(h.state.submitted,0);assert.equal(h.state.acquisitions,1);assert.equal(h.state.releases,1);assert.equal(h.state.videoTrustedUploads,1);assert.equal(h.ops.filter(op=>op.op==='submit').length,1);
  assert.deepEqual(h.commands.filter(command=>command.method==='Input.dispatchMouseEvent').map(command=>command.params.type),['mouseMoved','mousePressed','mouseReleased']);
 }
});

test('forged Edit source scene poster cannot enter durable receipt or paid callback', async t => {
  const folder = await temporary(t), originalPath = path.join(folder, 'source.mp4'); await fs.writeFile(originalPath, MP4);
  const h = await harness(t, { edit: true, sourcePoster: 'https://evil.example/video/forged', inspectVideo: async () => ({ durationSeconds: 3, mimeType: 'video/mp4', width: 1280, height: 720 }) });
  await assert.rejects(h.engine.generate(input({ model: 'omni-1.2-flash-edit-landscape', references: [{ kind: 'video', path: originalPath }] }), { beforeSubmit: () => assert.fail('Forged source reached paid boundary') }), { code: 'BROWSER_RECEIPT_INVALID' });
  assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1); assert.equal(h.ops.some(op => op.op === 'submit'), false);
  await assert.rejects(fs.access(path.join(h.dataDir, 'browser-receipts')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(originalPath), MP4);
});

test('Edit output requires saved source-scene proof before download even with exact prompt refs and result poster', async t => {
  const folder = await temporary(t), originalPath = path.join(folder, 'source.mp4'); await fs.writeFile(originalPath, MP4);
  for (const missingSource of ['missing', 'changed']) {
    const h = await harness(t, { edit: true, sourceSceneOutputError: true, inspectVideo: async () => ({ durationSeconds: 3, mimeType: 'video/mp4', width: 1280, height: 720 }) });
    await assert.rejects(h.engine.generate(input({ model: 'omni-1.2-flash-edit-landscape', references: [{ kind: 'video', path: originalPath }] }), { beforeSubmit: () => {} }), error => error.code === 'SOURCE_VIDEO_NOT_VERIFIED' && error.unknownOutcome === true);
    assert.equal(h.state.submitted, 1); assert.equal(h.state.releases, 1); assert.equal(h.state.acquisitions, 1);
    assert.equal(h.commands.some(command => command.method === 'Browser.setDownloadBehavior'), false);
  }
  const good = await harness(t, { edit: true, inspectVideo: async () => ({ durationSeconds: 3, mimeType: 'video/mp4', width: 1280, height: 720 }) });
  const result = await good.engine.generate(input({ model: 'omni-1.2-flash-edit-landscape', references: [{ kind: 'video', path: originalPath }] }), { beforeSubmit: () => {} });
  assert.equal(result.media[0].kind, 'video'); assert.deepEqual(await fs.readFile(result.media[0].path), MP4);
  assert.equal(good.commands.filter(command => command.method === 'Browser.setDownloadBehavior').length, 1); assert.equal(good.state.submitted, 1);
});

test('Edit rechecks source scene after durable callback and refuses replacement before Generate',async t=>{
 const folder=await temporary(t),file=path.join(folder,'source.mp4');await fs.writeFile(file,MP4);let changed=false,durable=0;
 const h=await harness(t,{edit:true,inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720}),operation(op,arg){if(op==='source-scene'&&arg.sourceScene&&changed)throw failure('SOURCE_VIDEO_NOT_VERIFIED');}});
 await assert.rejects(h.engine.generate(input({model:'omni-1.2-flash-edit-landscape',jobId:crypto.randomUUID(),references:[{kind:'video',path:file}]}),{beforeSubmit:()=>{durable++;changed=true;}}),error=>error.code==='SOURCE_VIDEO_NOT_VERIFIED'&&error.unknownOutcome===false);
 assert.equal(durable,1);assert.equal(h.state.submitted,0);assert.equal(h.state.releases,1);assert.equal(h.ops.some(op=>op.op==='submit'),false);
 assert.deepEqual(await fs.readFile(file),MP4);
});

test('Edit output must match typed geometry and source duration before success with no recovery or second submit on mismatch',async t=>{
 const folder=await temporary(t),file=path.join(folder,'source.mp4');await fs.writeFile(file,MP4);
 const source={durationSeconds:3.029333,mimeType:'video/mp4',width:360,height:640};
 for(const changed of [{width:720,height:1280},{durationSeconds:3.3},{durationSeconds:0},{durationSeconds:NaN},{durationSeconds:'3'},{durationSeconds:15.021},null]){
  let inspections=0;const progress=[];
  const h=await harness(t,{edit:true,editCreditQuote:3,inspectVideo:async({path:current,signal})=>{
   inspections++;if(current===file)return source;
   assert.equal(path.basename(current),'result.mp4');assert.deepEqual(await fs.readFile(current),MP4);assert.equal(signal,h.lease.signal);
   return changed===null?null:{...source,durationSeconds:3,...changed};
  }});
  await assert.rejects(h.engine.generate(input({jobId:crypto.randomUUID(),model:'omni-1.2-flash-edit-portrait-360p',references:[{kind:'video',path:file}]}),{beforeSubmit:()=>{},onProgress:text=>progress.push(text)}),error=>error.code==='MODEL_SETTINGS_NOT_VERIFIED'&&error.unknownOutcome===true&&error.generationTerminal!==true);
  assert.equal(inspections,2);assert.equal(progress.includes('Готово'),false);assert.equal(h.state.submitted,1);assert.equal(h.state.acquisitions,1);assert.equal(h.state.releases,1);
  await assert.rejects(fs.access(h.state.downloadFolder),{code:'ENOENT'});assert.deepEqual(await fs.readFile(file),MP4);
  assert.equal(h.ops.some(op=>['bind-result','recovery-candidates','open-recovery-candidate'].includes(op.op)),false);
 }
});

test('Edit recovery cannot claim success without output metadata or above existing inspector100MiB limit',async t=>{
 const projectURL='https://flow.google.com/project/'+SOURCE_PROJECT,sourceScene={url:projectURL+'/edit/'+SCENE,poster:'https://flow.google.com/asb/source-video-poster',sha256:crypto.createHash('sha256').update(MP4).digest('hex'),durationSeconds:3,width:1280,height:720};
 for(const large of [false,true]){
  const progress=[],h=await harness(t,{recover:true,historyPrompt:input().prompt,ingredients:['https://flow-content.google/image/original-upload'],...(large?{outputSize:100*1024*1024+1,inspectVideo:()=>assert.fail('Oversize output reached source-only metadata inspector')}:{})}),{jobId}=await savedReceipt(h,{model:'omni-1.2-flash-edit-landscape',projectURL,sourceScene});
  await assert.rejects(h.engine.recover(jobId,{onProgress:text=>progress.push(text)}),error=>error.code==='OUTPUT_METADATA_UNAVAILABLE'&&error.unknownOutcome===true&&error.generationTerminal!==true);
  assert.equal(progress.includes('Готово'),false);assert.equal(h.state.submitted,0);assert.equal(h.state.acquisitions,1);assert.equal(h.state.releases,1);await assert.rejects(fs.access(h.state.downloadFolder),{code:'ENOENT'});
 }
});

test('prepared Edit reference replacement is rejected before paid callback while original source scene remains intact',async t=>{
 const folder=await temporary(t),file=path.join(folder,'source.mp4');await fs.writeFile(file,MP4);
 const h=await harness(t,{edit:true,inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720})});
 const prepared=await h.engine.prepare(input({model:'omni-1.2-flash-edit-landscape',references:[{kind:'video',path:file},{kind:'image',dataUrl:PNG}]}));
 h.state.ingredients[0]='https://flow-content.google/image/replacement';
 await assert.rejects(h.engine.submit(prepared,{beforeSubmit:()=>assert.fail('Changed Edit reference reached paid callback')}),error=>error.code==='PREPARED_INPUT_CHANGED'&&error.unknownOutcome===false);
 assert.equal(h.state.submitted,0);assert.equal(h.ops.some(op=>op.op==='submit'),false);await h.engine.release(prepared);
 assert.equal(h.state.releases,1);assert.deepEqual(await fs.readFile(file),MP4);
});

test('Edit receipt recovery fails closed when existing detail cannot prove saved source video', async t => {
  const h = await harness(t, { recover: true, historyPrompt: input().prompt, historySourceVideos: [], ingredients: ['https://flow-content.google/image/original-upload'] });
  const { jobId, file } = await savedReceipt(h, { model: 'omni-1.2-flash-edit-landscape', sourceVideo: 'https://flow-content.google/video/' + GUID, sourceVideoDuration: 3 });
  const original = await fs.readFile(file);
  await assert.rejects(h.engine.recover(jobId), error => error.code === 'SOURCE_VIDEO_NOT_VERIFIED' && error.unknownOutcome === true);
  assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1); assert.equal(h.uploads.length, 0);
  assert.equal(h.commands.some(command => command.method === 'Browser.setDownloadBehavior'), false);
  assert.deepEqual(await fs.readFile(file), original);
});

test('source-scene Edit receipt recovery navigates exact saved scene offscreen without any project grid and requires same imported source version',async t=>{
 const projectURL='https://flow.google.com/project/'+SOURCE_PROJECT,sourceScene={url:projectURL+'/edit/'+SCENE,poster:'https://flow.google.com/asb/source-video-poster',sha256:crypto.createHash('sha256').update(MP4).digest('hex'),durationSeconds:3,width:1280,height:720};
 for(const rejected of [false,true]){
  const h=await harness(t,{recover:true,historyPrompt:input().prompt,ingredients:['https://flow-content.google/image/original-upload'],sourceSceneOutputError:rejected,inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720})});
  const {jobId,file}=await savedReceipt(h,{model:'omni-1.2-flash-edit-landscape',projectURL,sourceScene}),bytes=await fs.readFile(file);
  if(rejected)await assert.rejects(h.engine.recover(jobId),error=>error.code==='SOURCE_VIDEO_NOT_VERIFIED'&&error.unknownOutcome===true);
  else{const result=await h.engine.recover(jobId);assert.deepEqual(await fs.readFile(result.media[0].path),MP4);assert.equal(h.ops.find(op=>op.op==='history-download').arg.binding.sourceScene.url,sourceScene.url);}
  assert.deepEqual(h.commands.filter(command=>command.method==='Page.navigate').map(command=>command.params.url),[sourceScene.url]);
  assert.equal(h.state.lastAcquireOptions.windowMode,'offscreen');
  assert.equal(h.ops.some(op=>['recovery-candidates','open-recovery-candidate','bind-result','baseline','submit','asset'].includes(op.op)),false);
  assert.equal(h.state.submitted,0);assert.equal(h.uploads.length,0);assert.equal(h.state.releases,1);assert.deepEqual(await fs.readFile(file),bytes);
  if(rejected)assert.equal(h.commands.some(command=>command.method==='Browser.setDownloadBehavior'),false);
 }
});

test('source-scene manual recovery reports pending output while automatic observation waits for the same scene without resubmission',async t=>{
 const projectURL='https://flow.google.com/project/'+SOURCE_PROJECT,sourceScene={url:projectURL+'/edit/'+SCENE,poster:'https://flow.google.com/asb/source-video-poster',sha256:crypto.createHash('sha256').update(MP4).digest('hex'),durationSeconds:3,width:1280,height:720};
 for(const waiting of [false,true]){
  const h=await harness(t,{recover:true,historyPrompt:input().prompt,ingredients:['https://flow-content.google/image/original-upload'],sourceSceneOutputDelays:2,inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720})});
  const {jobId,file}=await savedReceipt(h,{model:'omni-1.2-flash-edit-landscape',projectURL,sourceScene}),bytes=await fs.readFile(file);
  if(waiting){const result=await h.engine.recover(jobId,{waitForResult:true});assert.deepEqual(await fs.readFile(result.media[0].path),MP4);assert.equal(h.state.sourceSceneOutputReads>=3,true);}
  else{await assert.rejects(h.engine.recover(jobId),error=>error.code==='RESULT_NOT_READY'&&error.unknownOutcome===true);assert.equal(h.commands.some(command=>command.method==='Browser.setDownloadBehavior'),false);}
  assert.equal(h.state.submitted,0);assert.equal(h.uploads.length,0);assert.deepEqual(await fs.readFile(file),bytes);assert.equal(h.ops.some(op=>['recovery-candidates','open-recovery-candidate'].includes(op.op)),false);
 }
});

test('source-scene recovery observes owned pending history then downloads exact new selected output without another submit',async t=>{
 const projectURL='https://flow.google.com/project/'+SOURCE_PROJECT,sourceScene={url:projectURL+'/edit/'+SCENE,poster:'https://flow.google.com/asb/source-video-poster',sha256:crypto.createHash('sha256').update(MP4).digest('hex'),durationSeconds:3,width:1280,height:720},outputPoster='https://flow.google.com/asb/result-unique';
 const pending=sourceSceneDOMFixture([{poster:sourceScene.poster},{pending:true,selected:false}]),ready=sourceSceneDOMFixture([{poster:sourceScene.poster,selected:false},{prompt:input().prompt,poster:outputPoster}]);
 for(const waiting of [false,true]){
  let reads=0;
  const h=await harness(t,{recover:true,historyPrompt:input().prompt,ingredients:['https://flow-content.google/image/original-upload'],inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720}),operation(op,arg,state){
   if(op==='source-scene'){try{const scene=++reads<=2?pending:ready,value=scene.run(op,arg);state.opened=true;return value;}catch(error){throw failure(error.message.split(':')[0],error.message);}}
   if(op==='history'){assert.equal(reads>=3,true);assert.equal(arg.poster,outputPoster);}
  }}),{jobId,file}=await savedReceipt(h,{model:'omni-1.2-flash-edit-landscape',projectURL,sourceScene}),bytes=await fs.readFile(file);
  if(waiting){const result=await h.engine.recover(jobId,{waitForResult:true});assert.deepEqual(await fs.readFile(result.media[0].path),MP4);assert.equal(result.sceneId,SCENE);}
  else await assert.rejects(h.engine.recover(jobId),error=>error.code==='RESULT_NOT_READY'&&error.unknownOutcome===true&&error.generationTerminal!==true);
  assert.equal(h.state.submitted,0);assert.equal(h.uploads.length,0);assert.equal(h.state.releases,1);assert.deepEqual(await fs.readFile(file),bytes);
  assert.deepEqual(h.commands.filter(command=>command.method==='Page.navigate').map(command=>command.params.url),[sourceScene.url]);
  assert.equal(h.ops.some(op=>['baseline','bind-result','recovery-candidates','open-recovery-candidate','submit'].includes(op.op)),false);
 }
});

test('source-scene recovery rejects wrong selected output prompt or ingredients before download and never looks in another scene',async t=>{
 const projectURL='https://flow.google.com/project/'+SOURCE_PROJECT,sourceScene={url:projectURL+'/edit/'+SCENE,poster:'https://flow.google.com/asb/source-video-poster',sha256:crypto.createHash('sha256').update(MP4).digest('hex'),durationSeconds:3,width:1280,height:720};
 for(const changed of [{historyPrompt:input().prompt+' other ending',ingredients:['https://flow-content.google/image/original-upload']},{historyPrompt:input().prompt,ingredients:['https://flow-content.google/image/foreign']}]){
  const h=await harness(t,{recover:true,...changed}),{jobId,file}=await savedReceipt(h,{model:'omni-1.2-flash-edit-landscape',projectURL,sourceScene}),bytes=await fs.readFile(file);
  await assert.rejects(h.engine.recover(jobId),error=>error.code==='RESULT_INPUT_MISMATCH'&&error.unknownOutcome===true);
  assert.equal(h.commands.some(command=>command.method==='Browser.setDownloadBehavior'),false);assert.equal(h.state.submitted,0);assert.equal(h.uploads.length,0);assert.deepEqual(await fs.readFile(file),bytes);assert.equal(h.ops.some(op=>['recovery-candidates','open-recovery-candidate'].includes(op.op)),false);
 }
});

test('actual Length slider max7 accepts frame durations3 and10 while rejecting11 and unrecognized max6', () => {
  const events = [];
  class RangeInput {
    constructor() { this.min = '0'; this.max = '7'; this._value = '0'; }
    get value() { return this._value; } set value(value) { this._value = value; }
    getClientRects() { return [1]; }
    dispatchEvent(event) { events.push(event.type); }
  }
  const range = new RangeInput();
  const context = {
    location: { origin: 'https://flow.google.com' }, HTMLInputElement: RangeInput, Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    getComputedStyle: () => ({ visibility: 'visible' }),
    document: { body: { innerText: '3s 10s' }, querySelector: () => null, querySelectorAll: selector => selector.includes('input[type="range"]') ? [range] : [] },
  };
  const run = arg => vm.runInNewContext('(' + flowDOM.toString() + ')("duration",' + JSON.stringify(arg) + ')', context);
  for (const seconds of [3, 10]) {
    const state = run({ seconds, set: seconds - 3 });
    assert.equal(state.value, seconds - 3); assert.equal(state.text, true);
  }
  assert.deepEqual(events, ['input', 'change', 'input', 'change']);
  assert.throws(() => run({ seconds: 11, set: 8 }), /DURATION_NOT_VERIFIED/);
  assert.equal(range.value, '7'); assert.equal(events.length, 4);
  range.max = '6';
  assert.throws(() => run({ seconds: 3, set: 0 }), /DURATION_NOT_VERIFIED/);
  assert.equal(events.length, 4);
});

test('two-frame no-spend check uploads Start then End and verifies canonical cropped identities before cleanup', async t => {
  const h = await harness(t, { cropResources: true }), model = 'omni-1.2-flash-i2v-10s-portrait-360p';
  const result = await h.engine.check(input({ model, references: [{ kind: 'image', dataUrl: PNG }, { kind: 'image', dataUrl: GIF }] }));
  assert.equal(result.model, model); assert.equal(result.uploadedImages, 2); assert.equal(result.referenceCount, 2);
  assert.equal(result.submitted, false); assert.equal(result.cleared, true);
  assert.deepEqual(h.state.frameRoles, ['Старт', 'Конец']);
  assert.equal(h.state.duration, 7); assert.equal(h.state.model, 'Omni 1.2 Flash');
  assert.ok(h.state.radios.has('Кадры')); assert.ok(h.state.radios.has('9:16')); assert.ok(h.state.radios.has('360p 360p: видео генерируется быстрее, но разрешение ниже')); assert.ok(h.state.radios.has('x1'));
  assert.deepEqual(h.uploads.map(upload => upload.bytes), [Buffer.from(PNG.split(',')[1], 'base64'), Buffer.from(GIF.split(',')[1], 'base64')]);
  assert.deepEqual(h.ops.filter(op => op.op === 'clear-owned').map(op => op.arg.ingredients), [h.uploads.map(upload => upload.identity + '-crop')]);
  assert.equal(h.ops.some(op => op.op === 'click' && op.arg.name === 'Добавить ингредиенты в окно запроса'), false);
  assert.equal(h.state.prompt, ''); assert.deepEqual(h.state.ingredients, []); assert.equal(h.state.releases, 1); assert.equal(h.state.submitted, 0);
  assert.equal(h.commands.some(command => command.method === 'Input.dispatchMouseEvent'), false);
  assert.equal(h.ops.some(op => op.op === 'submit'), false);
  assert.deepEqual(await fs.readdir(h.dataDir), []);
});

test('image engine shares one-submit transaction and ordered1/2ref uploads while returning validated PNG', async t => {
  for (const refs of [[PNG], [PNG, GIF]]) {
    const h = await harness(t, { image: true }), model = 'gemini-3.1-flash-image-square'; let durable = 0;
    const result = await h.engine.generate(input({ model, references: refs.map(dataUrl => ({ kind: 'image', dataUrl })) }), { beforeSubmit: () => { durable++; assert.equal(h.state.submitted, 0); } });
    assert.equal(h.state.model, 'Nano Banana 2.1'); assert.ok(h.state.radios.has('Image')); assert.ok(h.state.radios.has('1:1')); assert.ok(h.state.radios.has('Low')); assert.ok(h.state.radios.has('x1'));
    assert.equal(h.state.duration, 0); assert.equal(h.ops.some(op => op.op === 'duration'), false);
    assert.equal(durable, 1); assert.equal(h.state.submitted, 1); assert.equal(h.state.releases, 1); assert.equal(h.uploads.length, refs.length);
    assert.deepEqual(h.uploads.map(upload => upload.bytes), refs.map(value => Buffer.from(value.split(',')[1], 'base64')));
    assert.equal(result.media[0].kind, 'image'); assert.equal(path.basename(result.media[0].path), 'result.png');
    assert.deepEqual(await fs.readFile(result.media[0].path), Buffer.from(PNG.split(',')[1], 'base64'));
    assert.equal(h.ops.find(op => op.op === 'bind-result').arg.kind, 'image');
    assert.equal(h.ops.filter(op => ['result', 'result-poster', 'history'].includes(op.op)).every(op => op.arg.kind === 'image'), true);
    assert.equal(h.ops.filter(op => op.op === 'image-download-option').length, 2);
    assert.equal(h.ops.some(op => op.op === 'download-option'), false);
    assert.deepEqual(h.commands.filter(command => command.method === 'Input.dispatchMouseEvent').map(command => command.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
    for (const upload of h.uploads) await assert.rejects(fs.access(upload.file), { code: 'ENOENT' });
  }
});

test('crop identity substitution remains frame-only and must remain canonical Flow image resource', async t => {
  for (const [model, invalidCrop] of [[input().model, undefined], ['omni-1.2-flash-i2v-10s-landscape', 'https://evil.example/image/crop']]) {
    const h = await harness(t, { cropResources: true, invalidCrop });
    await assert.rejects(h.engine.check(input({ model, references: [{ kind: 'image', dataUrl: PNG }] })), { code: 'INGREDIENT_CHANGED' });
    assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1); assert.equal(h.ops.some(op => op.op === 'submit'), false);
  }
});

test('fresh about:blank and transient context wait before identity checks without desktop focus', async t => {
  const h = await harness(t, { startup: ['about:blank', failure('CDP_COMMAND'), 'https://flow.google.com/'] });
  const inspected = await h.engine.inspect(7, { email: EMAIL });
  assert.equal(inspected.ready, true); assert.equal(inspected.usesDesktopFocus, false);
  assert.equal(inspected.engine, 'isolated-browser');
  assert.equal(h.commands.filter(c => c.params?.expression === 'location.href').length, 3);
  assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1);
  const login = await harness(t, { startup: ['https://accounts.google.com/ServiceLogin'] });
  await assert.rejects(login.engine.inspect(7), { code: 'FLOW_LOGIN_REQUIRED' });
  assert.equal(login.state.releases, 1); assert.equal(login.state.submitted, 0);
});

test('inspect and preparation initialize owned desktop viewport before navigation and account DOM operations', async t => {
  for (const action of ['inspect', 'prepare']) {
    const h = await harness(t);
    const result = action === 'inspect' ? await h.engine.inspect(7) : await h.engine.prepare(input());
    assert.deepEqual(h.commands[0], { method: 'Emulation.setDeviceMetricsOverride', params: { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false } });
    assert.equal(h.commands.filter(command => command.method === 'Emulation.setDeviceMetricsOverride').length, 1);
    const firstEvaluate = h.commands.findIndex(command => command.method === 'Runtime.evaluate');
    assert.ok(firstEvaluate > 0);
    assert.equal(h.commands.some(command => /activateTarget|bringToFront|setWindowBounds/.test(command.method)), false);
    assert.equal(h.state.submitted, 0);
    if (action === 'prepare') await h.engine.release(result);
    assert.equal(h.state.releases, 1);
  }
});

test('project navigation waits for delayed canonical links before clicking project', async t => {
  let stateReads = 0, clickedAt = 0;
  const h = await harness(t, { operation(op, _arg, state) {
    if (op === 'state') return { url: state.url, accountButtons: 1, projectLinks: ++stateReads <= 3 ? [] : [{ href: '/project/project-owned' }] };
    if (op === 'project') clickedAt = stateReads;
  } });
  const result = await h.engine.inspect(7);
  assert.equal(result.ready, true); assert.equal(clickedAt, 4);
  assert.equal(h.ops.filter(op => op.op === 'project').length, 1);
  assert.deepEqual(result.controls, { buttons: ['Account information', 'Start generation'], radios: ['Video', 'Ingredients', '16:9', '720p'], textboxes: ['What do you want to create?'], ranges: [] });
  assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1);
});

test('diagnostics run before origin and verification guards and expose only bounded enums and control counts', () => {
  const privateMarker = 'private-cookie-password-person@example.test';
  const button = (value, shown = true) => ({
    innerText: value, textContent: value,
    getAttribute: attr => attr === 'aria-label' ? value : attr === 'title' ? privateMarker : null,
    getClientRects: () => shown ? [1] : [],
  });
  const raw = [button('Account details'), button('Сведения об аккаунте', false), button('Sign in'), ...Array.from({ length: 1001 }, () => button(privateMarker))];
  const document = {
    readyState: 'complete', visibilityState: 'hidden', documentElement: { lang: 'en-GB' },
    querySelector: selector => selector === 'input[type="password"]' ? {} : null,
    querySelectorAll: selector => selector === 'button,[role="button"]' ? raw : selector === 'a[href]' ? [{ getAttribute: () => '/project/' + privateMarker }] : [],
    get body() { assert.fail('Diagnostic must not read body contents'); },
  };
  for (const location of [
    { origin: 'https://accounts.google.com', pathname: '/signin', href: 'https://accounts.google.com/signin?token=' + privateMarker },
    { origin: 'https://flow.google.com', pathname: '/', href: 'https://flow.google.com/?token=' + privateMarker },
    { origin: 'https://private.example.test', pathname: '/secret', href: 'https://private.example.test/secret?token=' + privateMarker },
  ]) {
    const context = { location, document, innerWidth: 1280.4, innerHeight: 100000, getComputedStyle: () => ({ visibility: 'visible' }) };
    const result = vm.runInNewContext('(' + flowDOM.toString() + ')("diagnostic")', context);
    assert.ok(['flow', 'accounts', 'blank', 'other'].includes(result.origin));
    assert.ok(['home', 'project', 'edit', 'other'].includes(result.path));
    assert.equal(result.lang, 'en'); assert.equal(result.readyState, 'complete'); assert.equal(result.visibility, 'hidden');
    assert.equal(result.width, 1280); assert.equal(result.height, 10000);
    assert.equal(result.buttonCount, 1000); assert.equal(result.accountEn, 1); assert.equal(result.accountEnVisible, 1);
    assert.equal(result.accountRu, 1); assert.equal(result.accountRuVisible, 0);
    assert.equal(result.signIn, true); assert.equal(result.password, true); assert.equal(result.projectLinkCount, 1);
    assert.equal(JSON.stringify(result).includes(privateMarker), false);
    assert.equal(JSON.stringify(result).includes(location.href), false);
    assert.deepEqual(Object.keys(result).sort(), ['origin', 'path', 'readyState', 'lang', 'visibility', 'width', 'height', 'buttonCount', 'accountRu', 'accountRuVisible', 'accountEn', 'accountEnVisible', 'signIn', 'password', 'projectLinkCount'].sort());
  }
  document.documentElement.lang = privateMarker;
  const unknown = vm.runInNewContext('(' + flowDOM.toString() + ')("diagnostic")', { location: { origin: 'null', href: 'about:blank', pathname: 'blank' }, document, innerWidth: Infinity, innerHeight: -2, getComputedStyle: () => ({ visibility: 'visible' }) });
  assert.equal(unknown.origin, 'blank'); assert.equal(unknown.lang, 'other'); assert.equal(unknown.width, null); assert.equal(unknown.height, 0);
  assert.equal(JSON.stringify(unknown).includes(privateMarker), false);
});

test('controls inventory exposes capped canonical known labels and omits private or arbitrary controls', () => {
  const privateValue = 'private-full-prompt-person@example.test';
  const control = (name, shown = true) => ({
    getAttribute: attr => attr === 'aria-label' ? name : null,
    getClientRects: () => shown ? [1] : [],
    get value() { assert.fail('Control values must not be read'); },
    get innerText() { assert.fail('Named control contents must not be read'); },
    get textContent() { assert.fail('Named control contents must not be read'); },
  });
  const textboxes = [control(privateValue), ...Array.from({ length: 12 }, () => control('What do you want to create?'))];
  textboxes[1].getAttribute = attr => attr === 'placeholder' ? 'What do you want to create?' : null;
  const buttons = [control(privateValue), control('arbitrary-filename.png'), control('Settings', false), ...Array.from({ length: 105 }, () => control('Settings'))];
  const radios = [control(privateValue), control('not-a-setting'), ...Array.from({ length: 45 }, () => control('Video'))];
  const range = name => ({ getAttribute: attr => attr === 'aria-label' ? name : null, getClientRects: () => [1], min: '0', max: '12', value: '5' });
  const ranges = [
    range(privateValue), range('Length'),
  ];
  const context = {
    location: { origin: 'https://flow.google.com' }, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: () => null, querySelectorAll: selector => selector === 'button,[role="button"]' ? buttons : selector === 'input[type="radio"],[role="radio"]' ? radios : selector === '[role="textbox"],textarea,input[type="text"]' ? textboxes : selector === 'input[type="range"]' ? ranges : [] },
  };
  const result = vm.runInNewContext('(' + flowDOM.toString() + ')("controls")', context);
  assert.equal(result.buttons.length, 100); assert.equal(result.radios.length, 40); assert.equal(result.textboxes.length, 10);
  assert.equal(result.buttons.every(value => value === 'Триггер настроек'), true);
  assert.equal(result.radios.every(value => value === 'Видео'), true);
  assert.equal(result.textboxes.every(value => value === 'Что вы хотите создать?'), true);
  assert.equal(result.ranges.length, 1); assert.equal(result.ranges[0].label, 'Длительность');
  assert.deepEqual(Object.keys(result).sort(), ['buttons', 'radios', 'textboxes', 'ranges'].sort());
  assert.equal(JSON.stringify(result).includes(privateValue), false);
  assert.equal(JSON.stringify(result).includes('arbitrary-filename.png'), false);
});

test('English account controls work and project links use canonical paths independent of translated labels', () => {
  const clicked = [];
  const element = (name, extra = {}) => ({ innerText: name, getAttribute: attr => attr === 'aria-label' ? name : null, getClientRects: () => [1], click: () => clicked.push(name), ...extra });
  const account = element('Account information'), close = element('Close account panel');
  const panel = element('Account settings', { innerText: 'PERSON@example.com', querySelector: () => close });
  const valid = element('任意名称', { getAttribute: attr => attr === 'href' ? '/project/project-owned' : null });
  const unsafe = ['/project/project-owned?token=secret', '/project/../private', 'https://evil.example/project/other'].map(href => element('Open project', { getAttribute: attr => attr === 'href' ? href : null }));
  const context = {
    location: { origin: 'https://flow.google.com', href: 'https://flow.google.com/' }, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: () => null, querySelectorAll: selector => selector === 'button,[role="button"]' ? [account, close] : selector === 'a[href]' ? [...unsafe, valid] : selector.includes('Настройки аккаунта') ? [panel] : [] },
  };
  const run = (op, arg) => vm.runInNewContext('(' + flowDOM.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg || {}) + ')', context);
  assert.equal(run('exists', { name: 'Сведения об аккаунте' }), true);
  assert.equal(run('account'), EMAIL);
  assert.equal(run('state').accountButtons, 1);
  assert.equal(JSON.stringify(run('state').projectLinks), JSON.stringify([{ href: '/project/project-owned' }]));
  run('click', { name: 'Сведения об аккаунте' }); run('click', { name: 'Закрыть панель аккаунта' }); run('project');
  assert.deepEqual(clicked, ['Account information', 'Close account panel', '任意名称']);
});

test('English composer Settings lookup excludes duplicate global Settings and rejects ambiguous local matches', () => {
  const clicks = [];
  const element = (name, extra = {}) => ({ innerText: name, getAttribute: attr => attr === 'aria-label' ? name : null, getClientRects: () => [1], querySelectorAll: () => [], click: () => clicks.push(name), ...extra });
  const globalSettings = element('Settings', { click: () => clicks.push('global') });
  const localSettings = element('Settings', { click: () => clicks.push('composer') });
  const extraSettings = element('Settings', { click: () => clicks.push('duplicate') });
  const start = element('Start generation'), prompt = element('What do you want to create?');
  let duplicate = false;
  const composer = {
    parentElement: null,
    querySelectorAll: selector => selector === 'button,[role="button"]' ? [localSettings, ...(duplicate ? [extraSettings] : []), start] : selector === '[role="textbox"],textarea,input[type="text"]' ? [prompt] : [],
    contains: node => [localSettings, extraSettings, start, prompt].includes(node),
  };
  prompt.parentElement = composer;
  const body = { parentElement: null, querySelectorAll: selector => selector === 'button,[role="button"]' ? [globalSettings, ...composer.querySelectorAll(selector)] : composer.querySelectorAll(selector) };
  composer.parentElement = body;
  const context = {
    location: { origin: 'https://flow.google.com' }, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { body, documentElement: body, querySelector: () => null, querySelectorAll: selector => selector === '[role="dialog"]' ? [] : body.querySelectorAll(selector) },
  };
  const run = () => vm.runInNewContext('(' + flowDOM.toString() + ')("click",{"name":"Триггер настроек"})', context);
  assert.equal(run(), true); assert.deepEqual(clicks, ['composer']);
  duplicate = true;
  assert.throws(run, /CONTROL_AMBIGUOUS/);
  assert.deepEqual(clicks, ['composer']);
});

test('assistant mode exits only empty agent draft and switches empty creative composer through scoped Agent control', () => {
  let closeClicks = 0, agentClicks = 0, draft = '', agentOpen = true, creative = true;
  const element = (name, extra = {}) => ({ getAttribute: attr => attr === 'aria-label' ? name : null, getClientRects: () => [1], querySelectorAll: () => [], ...extra });
  const close = element('Close', { click: () => { closeClicks++; agentOpen = false; } });
  const agent = element('Agent', { click: () => { agentClicks++; creative = false; } });
  const start = element('Start generation');
  const panel = { querySelectorAll: selector => selector === 'button,[role="button"]' ? [close] : [] };
  const editor = element('What do you want to create?', { closest: selector => selector === 'flow-agent-panel' ? agentOpen && panel : selector === 'flow-creative-agent-prompt-box' ? creative && composer : null });
  Object.defineProperty(editor, 'innerText', { get: () => draft });
  const composer = { parentElement: null, querySelectorAll: selector => selector === 'button,[role="button"]' ? [agent, start] : selector === '[role="textbox"],textarea,input[type="text"]' ? [editor] : [] };
  editor.parentElement = composer;
  const document = { body: {}, querySelector: () => null, querySelectorAll: selector => selector === '[role="textbox"],textarea,input[type="text"]' ? [editor] : selector === 'button,[role="button"]' ? [close, agent, start] : [] };
  const context = { location: { origin: 'https://flow.google.com' }, document, getComputedStyle: () => ({ visibility: 'visible' }) };
  const run = op => vm.runInNewContext('(' + flowDOM.toString() + ')(' + JSON.stringify(op) + ')', context);
  assert.equal(run('composer-mode').agent, true);
  draft = 'User assistant draft';
  assert.throws(() => run('close-agent'), /BROWSER_DRAFT_PRESENT/); assert.equal(closeClicks, 0);
  draft = ''; assert.equal(run('close-agent'), true); assert.equal(closeClicks, 1);
  assert.equal(run('composer-mode').agent, false); assert.equal(run('composer-mode').creative, true);
  draft = 'User creative draft';
  assert.throws(() => run('manual-mode'), /BROWSER_DRAFT_PRESENT/); assert.equal(agentClicks, 0);
  draft = ''; assert.equal(run('manual-mode'), true); assert.equal(agentClicks, 1);
  assert.equal(run('composer-mode').creative, false);
});

test('expanded empty Agent panel beyond the viewport closes once and preserves message drafts refs and ambiguous controls',()=>{
 let value='\n',chip=false,panels=1,closed=0,unknownEditor=false,closeCount=1,inert=false,cssHidden=false;
 const element=(attributes={},extra={})=>({getAttribute:key=>attributes[key]??null,getClientRects:()=>[1],closest:()=>null,querySelectorAll:()=>[],...extra});
 const panel=element({},{getBoundingClientRect:()=>({left:1284,top:76,width:344,height:812,right:1628,bottom:888}),closest:selector=>selector==='[aria-hidden="true"],[inert]'&&inert?{}:null}),root=element({},{}),editor=element({role:'textbox','aria-label':'What do you want to create?'},{getBoundingClientRect:()=>({left:1311,top:799,width:288,height:20,right:1599,bottom:819}),closest:selector=>selector==='flow-agent-panel'?panel:selector==='flow-base-prompt-box'?root:null});Object.defineProperty(editor,'innerText',{get:()=>value});
 const title=element({'aria-label':'Editable text'},{value:'Untitled session'}),close=element({'aria-label':'Close'},{closest:selector=>selector==='flow-agent-panel'?panel:null,getBoundingClientRect:()=>({left:1586,top:83,width:34,height:34,right:1620,bottom:117}),click:()=>closed++}),foreignClose=element({'aria-label':'Close'},{click:()=>assert.fail('Foreign close button must never receive click')});
 root.closest=selector=>selector==='flow-agent-panel'?panel:null;
 root.querySelectorAll=selector=>selector==='flow-rich-text-editor [role="textbox"],textarea'?[editor]:selector==='[role="textbox"],textarea,[contenteditable="true"],input[type="text"]'?[editor,...(unknownEditor?[{...editor}]:[])]:selector==='flow-ingredient-chip,flow-image-ingredient-chip,flow-video-ingredient-chip,button[aria-label="Ingredient"],button[aria-label="Image ingredient"],button[aria-label="Ингредиент"]'?chip?[element()]:[]:[];
 panel.querySelectorAll=selector=>selector==='flow-base-prompt-box'?[root]:selector==='flow-image-ingredient-chip,flow-video-ingredient-chip,button[aria-label="Ingredient"],button[aria-label="Image ingredient"],button[aria-label="Ингредиент"]'?chip?[element()]:[]:selector==='button,[role="button"]'?Array(closeCount).fill(close):selector.includes('input')?[title]:[];
 const context={innerWidth:1280,innerHeight:900,location:{origin:'https://flow.google.com'},getComputedStyle:node=>({visibility:node===panel&&cssHidden?'hidden':'visible'}),document:{querySelector:()=>null,querySelectorAll:selector=>selector==='flow-agent-panel'?Array(panels).fill(panel):selector==='button,[role="button"]'?[foreignClose]:[]}};
 const run=()=>vm.runInNewContext('('+flowDOM.toString()+')("close-empty-agent-panel")',context);
 assert.equal(run(),true);assert.equal(closed,1);
 value='Exact foreign draft';assert.throws(run,/BROWSER_DRAFT_PRESENT/);assert.equal(closed,1);assert.equal(value,'Exact foreign draft');
 value='';chip=true;assert.throws(run,/BROWSER_DRAFT_PRESENT/);assert.equal(closed,1);
 chip=false;unknownEditor=true;assert.throws(run,/CONTROL_AMBIGUOUS/);assert.equal(closed,1);unknownEditor=false;closeCount=2;assert.throws(run,/CONTROL_AMBIGUOUS/);assert.equal(closed,1);closeCount=1;panels=2;assert.throws(run,/CONTROL_AMBIGUOUS/);assert.equal(closed,1);panels=1;inert=true;assert.equal(run(),false);assert.equal(closed,1);inert=false;cssHidden=true;assert.equal(run(),false);assert.equal(closed,1);cssHidden=false;panels=0;assert.equal(run(),false);
});

test('project closes expanded empty Agent before it waits for a standard composer and never types or submits',async()=>{
 const ops=[],url='https://flow.google.com/project/'+SOURCE_PROJECT;let open=true;
 const page=new FlowPage({send:()=>assert.fail('No raw mutations needed')},undefined,{pollMs:1});page.ready=async()=>{};page.verifyAccount=async()=>{};page.dismissProductAnnouncement=async()=>{};
 page.run=async op=>{ops.push(op);if(op==='state')return{url};if(op==='close-empty-agent-panel'){open=false;return true;}if(op==='composer-mode'){assert.equal(open,false,'Panel must close before prompt()-based composer inspection');return{agent:false,creative:false,ready:true};}assert.fail('Unexpected '+op);};
 assert.equal(await page.project(EMAIL),url);assert.equal(ops.filter(op=>op==='close-empty-agent-panel').length,1);assert.equal(ops.indexOf('close-empty-agent-panel')<ops.indexOf('composer-mode'),true);assert.equal(ops.some(op=>['submit','focus-prompt','clear-owned','manual-mode'].includes(op)),false);
});

test('English generated thumbnail supports baseline, result binding, completion, and exact poster identity', () => {
  const posterURL = 'https://flow.google.com/asb/result-English', poster = { getAttribute: attr => attr === 'src' ? posterURL : null };
  const tile = {
    innerText: input().prompt, getClientRects: () => [1],
    getAttribute: attr => tile.attributes[attr] || null,
    setAttribute: (attr, value) => { tile.attributes[attr] = value; }, attributes: {},
    querySelector: selector => selector === 'img' || selector.includes('Generated video thumbnail') ? poster : null,
    querySelectorAll: () => [],
  };
  const old = { ...tile, attributes: {}, innerText: 'older task', getAttribute(attr) { return this.attributes[attr] || null; }, setAttribute(attr, value) { this.attributes[attr] = value; } };
  let groups = [old];
  const context = {
    location: { origin: 'https://flow.google.com' }, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: () => null, querySelectorAll: selector => selector === '[role="group"]' ? groups : selector === '[data-flow-studio-job]' ? groups.filter(el => el.getAttribute('data-flow-studio-job')) : selector === '[data-flow-studio-baseline]' ? groups.filter(el => el.getAttribute('data-flow-studio-baseline')) : [] },
  };
  const run = (op, arg = {}) => vm.runInNewContext('(' + flowDOM.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg) + ')', context);
  const baseline = run('baseline', { job: 'job-English' }); assert.equal(baseline.length, 1);
  assert.equal(old.getAttribute('data-flow-studio-baseline'), 'job-English');
  groups.push(tile);
  assert.equal(run('bind-result', { baseline, prompt: input().prompt, job: 'job-English' }), true);
  assert.equal(run('result', { job: 'job-English', prompt: input().prompt }).complete, true);
  assert.equal(run('result-poster', { job: 'job-English' }), posterURL);
});

test('completed result opens exact flow-video-tile child with one click and detail2 double-click', () => {
  const actions = [], events = [], posterURL = 'https://flow.google.com/asb/open-child';
  const child = { getAttribute: () => null, click: () => actions.push('child-click'), dispatchEvent: event => events.push(event) };
  const poster = { getAttribute: attr => attr === 'src' ? posterURL : null };
  const group = {
    innerText: 'Generated task', getClientRects: () => [1], getAttribute: attr => attr === 'data-flow-studio-job' ? 'job-open' : null,
    querySelector: selector => selector === 'flow-video-tile' ? child : selector === 'img' || selector.includes('Generated video thumbnail') ? poster : null,
    querySelectorAll: () => [], click: () => assert.fail('Parent card must not receive open click'), dispatchEvent: () => assert.fail('Parent card must not receive double-click'),
  };
  const context = {
    location: { origin: 'https://flow.google.com' }, getComputedStyle: () => ({ visibility: 'visible' }),
    MouseEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    document: { querySelector: () => null, querySelectorAll: selector => selector === '[data-flow-studio-job]' ? [group] : [] },
  };
  const result = vm.runInNewContext('(' + flowDOM.toString() + ')("result",{"job":"job-open","open":true})', context);
  assert.equal(result.complete, true); assert.deepEqual(actions, ['child-click']);
  assert.equal(events.length, 1); assert.equal(events[0].type, 'dblclick'); assert.equal(events[0].detail, 2); assert.equal(events[0].bubbles, true);
});

test('baseline DOM identity excludes old same-prompt card when progress and poster change and binds only new card', () => {
  const makeTile = progress => ({
    innerText: input().prompt + '\n' + progress + '%', attributes: {}, getClientRects: () => [1],
    getAttribute(attr) { return this.attributes[attr] || null; }, setAttribute(attr, value) { this.attributes[attr] = value; },
    querySelector(selector) { return selector.includes('flow-video-tile') ? {} : selector === 'img' ? { getAttribute: () => this.poster } : null; },
    poster: 'old-poster',
  });
  const old = makeTile(11); let groups = [old];
  const context = {
    location: { origin: 'https://flow.google.com' }, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: () => null, querySelectorAll: selector => selector === '[role="group"]' ? groups : selector === '[data-flow-studio-baseline]' ? groups.filter(el => el.getAttribute('data-flow-studio-baseline')) : [] },
  };
  const run = (op, arg) => vm.runInNewContext('(' + flowDOM.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg) + ')', context);
  const job = 'new-job', baseline = run('baseline', { job });
  old.innerText = input().prompt + '\n12%'; old.poster = 'changed-old-poster';
  assert.equal(run('bind-result', { job, baseline, prompt: input().prompt }), false);
  assert.equal(old.getAttribute('data-flow-studio-job'), null);
  const current = makeTile(1); groups.push(current);
  assert.equal(run('bind-result', { job, baseline, prompt: input().prompt }), true);
  assert.equal(current.getAttribute('data-flow-studio-job'), job); assert.equal(old.getAttribute('data-flow-studio-job'), null);
  groups = [makeTile(12), current];
  assert.throws(() => run('bind-result', { job, baseline, prompt: input().prompt }), /RESULT_BINDING_CHANGED/);
});

test('baseline covers existing image and pending tiles; only unique new pending tile binds despite renamed prompt', () => {
  const tile = (kind, title, poster) => ({
    innerText: title, attributes: {}, getClientRects: () => [1],
    getAttribute(attr) { return this.attributes[attr] || null; }, setAttribute(attr, value) { this.attributes[attr] = value; },
    querySelector(selector) { return selector === 'img' && poster ? { getAttribute: () => poster } : selector.split(',').includes(kind) ? {} : null; },
    querySelectorAll: () => [],
  });
  const oldImage = tile('flow-image-tile', 'Existing image'), oldPending = tile('flow-pending-tile', 'Old pending', 'old-pending-poster'), oldVideo = tile('flow-video-tile', 'Old video');
  let groups = [oldImage, oldPending, oldVideo];
  const context = {
    location: { origin: 'https://flow.google.com' }, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: () => null, querySelectorAll: selector => selector === '[role="group"]' ? groups : selector === '[data-flow-studio-baseline]' ? groups.filter(el => el.getAttribute('data-flow-studio-baseline')) : [] },
  };
  const run = (op, arg) => vm.runInNewContext('(' + flowDOM.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg) + ')', context);
  const job = 'new-pending', baseline = run('baseline', { job });
  assert.equal(baseline.length, 3);
  for (const old of groups) assert.equal(old.getAttribute('data-flow-studio-baseline'), job);
  oldPending.innerText = 'Old pending progressed 12%';
  assert.equal(run('bind-result', { job, baseline, prompt: input().prompt }), false);
  const fresh = tile('flow-pending-tile', 'Provider shortened and renamed title'); groups.push(fresh);
  assert.equal(run('bind-result', { job, baseline, prompt: input().prompt }), true);
  assert.equal(fresh.getAttribute('data-flow-studio-job'), job);
  for (const old of [oldImage, oldPending, oldVideo]) assert.equal(old.getAttribute('data-flow-studio-job'), null);
  groups.push(tile('flow-pending-tile', 'Another concurrent task'));
  assert.throws(() => run('bind-result', { job, baseline, prompt: input().prompt }), /RESULT_AMBIGUOUS/);
});

test('baseline includes old warning-only error group and binds unique new failure without image or pending elements', () => {
  const warning = { innerText: 'warning', getAttribute: () => null };
  const errorGroup = text => ({
    innerText: text, attributes: {}, getClientRects: () => [1],
    getAttribute(attr) { return this.attributes[attr] || null; }, setAttribute(attr, value) { this.attributes[attr] = value; },
    querySelector: () => null, querySelectorAll: selector => selector === 'mat-icon,[role="alert"]' ? [warning] : [],
  });
  const old = errorGroup('Previous unrelated failed attempt'); let groups = [old];
  const context = {
    location: { origin: 'https://flow.google.com' }, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: () => null, querySelectorAll: selector => selector === '[role="group"]' ? groups : selector === '[data-flow-studio-baseline]' ? groups.filter(el => el.getAttribute('data-flow-studio-baseline')) : selector === '[data-flow-studio-job]' ? groups.filter(el => el.getAttribute('data-flow-studio-job')) : [] },
  };
  const run = (op, arg) => vm.runInNewContext('(' + flowDOM.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg || {}) + ')', context);
  const job = 'warning-job', baseline = run('baseline', { job });
  assert.equal(baseline.length, 1); assert.equal(old.getAttribute('data-flow-studio-baseline'), job);
  assert.equal(run('bind-result', { job, baseline, prompt: input().prompt }), false);
  const literal = 'We noticed unusual activity. Please try again later. You have not been charged.';
  const current = errorGroup(input().prompt + '\n' + literal); groups.push(current);
  assert.equal(run('bind-result', { job, baseline, prompt: input().prompt }), true);
  assert.equal(old.getAttribute('data-flow-studio-job'), null);
  const result = run('result', { job, prompt: input().prompt });
  assert.equal(result.complete, false); assert.equal(result.provisional, false);
  assert.equal(result.error.trim(), literal); assert.equal(result.error.includes('PUBLIC_ERROR_'), false);
});

test('exact unique old name and poster pairs recover rerendered baseline and exclude every previous card', () => {
  const card = (name, poster, kind = 'flow-video-tile') => ({
    innerText: name, attributes: {}, getClientRects: () => [1],
    getAttribute(attr) { return this.attributes[attr] || null; }, setAttribute(attr, value) { this.attributes[attr] = value; },
    querySelector(selector) { return selector === 'img' && poster ? { getAttribute: () => poster } : selector.split(',').includes(kind) ? {} : null; },
    querySelectorAll: () => [],
  });
  const original = [card('Old video title', 'old-video-poster'), card('Uploaded image filename', 'old-image-poster', 'flow-image-tile')];
  let groups = original;
  const context = {
    location: { origin: 'https://flow.google.com' }, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: () => null, querySelectorAll: selector => selector === '[role="group"]' ? groups : selector === '[data-flow-studio-baseline]' ? groups.filter(el => el.getAttribute('data-flow-studio-baseline')) : [] },
  };
  const run = (op, arg) => vm.runInNewContext('(' + flowDOM.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg) + ')', context);
  const job = 'rerender-job', baseline = run('baseline', { job });
  const newCard = card('Provider renamed new request', null, 'flow-pending-tile');
  groups = [card('Old video title', 'old-video-poster'), card('Uploaded image filename', 'old-image-poster', 'flow-image-tile'), newCard];
  assert.equal(run('bind-result', { job, baseline, prompt: input().prompt }), true);
  assert.equal(newCard.getAttribute('data-flow-studio-job'), job);
  for (const old of groups.slice(0, 2)) assert.equal(old.getAttribute('data-flow-studio-job'), null);
  for (const replacements of [
    [card('Old video title', 'different-poster'), card('Uploaded image filename', 'old-image-poster', 'flow-image-tile')],
    [card('Changed title', 'old-video-poster'), card('Uploaded image filename', 'old-image-poster', 'flow-image-tile')],
    [card('Old video title', 'old-video-poster'), card('Old video title', 'old-video-poster'), card('Uploaded image filename', 'old-image-poster', 'flow-image-tile')],
  ]) { groups = [...replacements, newCard]; assert.throws(() => run('bind-result', { job, baseline, prompt: input().prompt }), /RESULT_BINDING_CHANGED/); }
  groups = [card('Prior pending', null, 'flow-pending-tile')];
  assert.throws(() => run('baseline', { job }), /FLOW_EXISTING_GENERATION/);
  groups = [card('Prior pending', 'became-ready-poster'), newCard];
  assert.throws(() => run('bind-result', { job, baseline: [{ name: 'Prior pending', poster: '' }], prompt: input().prompt }), /RESULT_BINDING_CHANGED/);
});

function historyDOMFixture(values,options={}){
  const stepSelector='flow-editor-history-step-video,flow-editor-history-step-image',steps=[],globalButtons=options.globalButtons||[],menus=[];
  const element=(tag,attributes={},extra={})=>({tagName:tag.toUpperCase(),getAttribute:key=>attributes[key]??null,getClientRects:()=>[1],querySelectorAll:()=>[],closest:()=>null,...extra});
  for(const value of values){
    const entry=element(value.kind==='image'?'flow-editor-history-step-image':'flow-editor-history-step-video'),owned=extra=>({closest:selector=>selector===stepSelector?entry:null,...extra});
    const image=element('img',{src:value.poster,'data-media-id':value.mediaId||GUID},owned({currentSrc:value.poster,complete:value.loaded!==false,naturalWidth:value.loaded===false?0:360}));
    const tile=element('flow-tile-container',{},owned({querySelectorAll:selector=>selector.includes(value.kind==='image'?'flow-image-tile':'flow-video-tile')?[image]:[],click:()=>{value.selectionClicks=(value.selectionClicks||0)+1;for(const item of values)item.selected=false;value.selected=true;}}));
    const prompt=element('div',{},owned({innerText:'Truncated UI preview…',querySelectorAll:()=>value.promptControls?[element('button')]:[]}));Object.defineProperty(prompt,'textContent',{get:()=>value.prompt});
    const ingredients=(value.ingredients||[]).map(source=>element('button',{'aria-label':'Ingredient'},owned({querySelectorAll:selector=>selector.includes('Ingredient image')&&source?[{currentSrc:source}]:[]})));
    const videoIngredients=Array.from({length:Math.max(value.sourceVideos?.length||0,value.sourcePreviews?.length||0)},(_,index)=>{
      const source=value.sourceVideos?.[index],preview=value.sourcePreviews?.[index];
      const wrapper=element('flow-ingredient-chip',{},owned({})),videoChip=element('flow-video-ingredient-chip',{},owned({}));
      const media=element('video',{src:source},owned({closest:selector=>selector===stepSelector?entry:selector==='flow-video-ingredient-chip'?videoChip:null}));
      const imagePreview=element('img',{src:preview,alt:'Video ingredient image'},owned({currentSrc:preview,closest:selector=>selector===stepSelector?entry:selector==='flow-video-ingredient-chip'?videoChip:null}));
      return element('button',{'aria-label':'Ingredient','aria-busy':String(value.videoIngredientBusy??false)},owned({closest:selector=>selector===stepSelector?entry:selector==='flow-video-ingredient-chip'?videoChip:selector==='flow-ingredient-chip'?wrapper:null,querySelectorAll:selector=>selector==='video[src],source[src]'&&source?[media]:selector==='img[alt="Video ingredient image"]'&&preview?[imagePreview]:[]}));
    });
    const ingredientButtons=value.videoIngredientIndex===undefined?[...ingredients,...videoIngredients]:[...ingredients.slice(0,value.videoIngredientIndex),...videoIngredients,...ingredients.slice(value.videoIngredientIndex)];
    const sourceVideos=(value.sourceVideos||[]).map(source=>element('video',{src:source},owned({})));
    const attributes={'aria-label':value.moreOptions?'More options':'Download','aria-expanded':'false'},trigger=element('button',attributes,owned({click:()=>{value.downloadClicks=(value.downloadClicks||0)+1;attributes['aria-expanded']='true';attributes['aria-controls']=value.moreOptions?'owned-more-menu':'owned-size-menu';}}));
    if(value.hiddenHotbar)trigger.getClientRects=()=>[];
    tile.contains=button=>button===trigger;
    const sizeOptions=[['720p','Original size'],['1K','Original size'],['2K','Upscaled'],['4K','Upscaled']].map(([name,caption])=>element('button',{role:'menuitem'},{disabled:name==='4K'&&Boolean(value.disable4K),innerText:name+' '+caption,querySelectorAll:selector=>selector==='.item-text .label'?[{innerText:name}]:selector==='.item-text .caption'?[{innerText:caption}]:[],click:()=>{value.downloadOptionClicks=(value.downloadOptionClicks||0)+1;}}));
    const submenuAttributes={role:'menuitem','aria-expanded':'false'},submenuTrigger=element('button',submenuAttributes,{querySelectorAll:selector=>selector==='.item-text .label'?[{innerText:'Download'}]:[],click:()=>{value.submenuClicks=(value.submenuClicks||0)+1;submenuAttributes['aria-expanded']='true';submenuAttributes['aria-controls']='owned-size-menu';}});
    const sizeMenu=element('div',{role:'menu',id:'owned-size-menu'},{querySelectorAll:selector=>selector==='[role="menuitem"]'?sizeOptions:[]}),moreMenu=element('div',{role:'menu',id:'owned-more-menu'},{querySelectorAll:selector=>selector==='[role="menuitem"]'?[submenuTrigger]:[]});
    menus.push({trigger,attributes,submenuAttributes,moreMenu,sizeMenu});
    const buttons=value.download===false?[]:[trigger];
    const pending=Array(value.pendingCount??(value.pending?1:0)).fill(element('flow-pending-tile',{},owned({})));
    entry.querySelectorAll=selector=>selector==='flow-pending-tile'?pending:selector==='flow-tile-container'?[tile]:selector==='flow-tile-container.selected.high-emphasis'?value.selected===false?[]:Array(value.selectedCount||1).fill(tile):selector==='flow-expandable-prompt .prompt-text'?value.prompt===undefined?[]:Array(value.promptCount||1).fill(prompt):selector.includes('button[aria-label="Ingredient"]')?ingredientButtons:selector==='[data-source-video-id],video[src],source[src]'?sourceVideos:selector==='button,[role="button"]'||selector==='button[aria-label="Download"],button[aria-label="More options"]'?buttons:[];
    entry.value=value;entry.ingredients=ingredients;entry.videoIngredients=videoIngredients;steps.push(entry);
  }
  const region=element('div',{'aria-label':'History'},{innerText:options.regionText||'History controls contain unrelated prompts',querySelectorAll:selector=>selector===stepSelector?steps:selector.includes('Ingredient')?steps.flatMap(step=>step.ingredients):[]});
  const context={location:{origin:'https://flow.google.com',href:'https://flow.google.com/project/owned/edit/'+SCENE},URL,getComputedStyle:()=>({visibility:'visible'}),document:{querySelector:()=>null,querySelectorAll:selector=>selector==='[role="region"]'?[region]:selector==='button,[role="button"]'?globalButtons:selector==='[id]'?menus.flatMap(({attributes,submenuAttributes,moreMenu,sizeMenu})=>attributes['aria-expanded']==='true'?attributes['aria-controls']==='owned-size-menu'?[sizeMenu]:[moreMenu,...(submenuAttributes['aria-expanded']==='true'?[sizeMenu]:[])]:[]):[]}};
  return {steps,context,run:(op,arg)=>vm.runInNewContext('('+flowDOM.toString()+')('+JSON.stringify(op)+','+JSON.stringify(arg||{})+')',context)};
}

function sourceSceneDOMFixture(values,options={}){
 const h=historyDOMFixture(values),query=h.context.document.querySelectorAll;
 h.context.location.href=options.url||'https://flow.google.com/project/'+SOURCE_PROJECT+'/edit/'+SCENE;
 h.context.document.querySelectorAll=selector=>selector==='flow-scene-timeline .clip'?Array(options.clips??1).fill({}):selector==='.duration-timecode-label .duration-timecode-value'?(options.durationValues||['00:03:00']).map(value=>({innerText:value,getClientRects:()=>[1],getAttribute:()=>null})):query(selector);
 const run=h.run;h.run=(op,arg={})=>run(op,op==='source-scene'?{durationSeconds:3,...arg,...(arg.sourceScene?{sourceScene:{durationSeconds:3,...arg.sourceScene}}:{})}:arg);
 return h;
}

function failedSourceSceneDOMFixture({poster='https://flow-content.google/image/'+GUID,prompt=input().prompt,ingredients=[],sourceVideos=['https://flow-content.google/video/'+GUID],sourcePreviews=[],title='Failed',message='Sorry, this video failed to generate.',...options}={}){
 const h=sourceSceneDOMFixture([{poster},{prompt,ingredients,sourceVideos,sourcePreviews,selected:false,download:false}],options),entry=h.steps[1],query=entry.querySelectorAll,tile=query('flow-tile-container')[0],tileQuery=tile.querySelectorAll;
 const owned=extra=>({closest:selector=>selector==='flow-editor-history-step-video,flow-editor-history-step-image'?entry:null,...extra});
 const errorTile=owned({querySelectorAll:selector=>selector==='.error-title'?[owned({textContent:title})]:selector==='.error-message-text'?[owned({textContent:message})]:[]});
 entry.querySelectorAll=selector=>selector==='flow-error-tile'?[errorTile]:query(selector);
 tile.querySelectorAll=selector=>selector.includes('flow-video-tile img')?[]:tileQuery(selector);
 return h;
}

test('observed Edit error tile terminates only the exact request with retained source same resource and owned video ingredient',()=>{
 const sourceScene={url:'https://flow.google.com/project/'+SOURCE_PROJECT+'/edit/'+SCENE,poster:'https://flow-content.google/image/'+GUID},literal='Failed\nSorry, this video failed to generate.';
 const h=failedSourceSceneDOMFixture(),state=h.run('source-scene',{sourceScene,output:true,loading:true,prompt:input().prompt,ingredients:[]});
 assert.equal(state.url,sourceScene.url);assert.equal(state.poster,sourceScene.poster);assert.equal(state.failure.message,literal);assert.equal(state.outputPoster,undefined);
 const refs=['https://flow-content.google/image/first','https://flow-content.google/image/second'];
 assert.equal(failedSourceSceneDOMFixture({ingredients:refs}).run('source-scene',{sourceScene,output:true,loading:true,prompt:input().prompt,ingredients:refs}).failure.message,literal);
 assert.throws(()=>failedSourceSceneDOMFixture({ingredients:[...refs].reverse()}).run('source-scene',{sourceScene,output:true,loading:true,prompt:input().prompt,ingredients:refs}),/RESULT_INPUT_MISMATCH/);
 for(const changed of [
  {prompt:input().prompt+' other'},
  {ingredients:['https://flow-content.google/image/foreign']},
  {sourceVideos:['https://flow-content.google/video/'+SCENE]},
  {sourceVideos:[]},
  {sourceVideos:['https://evil.example/video/'+GUID]},
  {poster:'https://flow-content.google/image/'+SCENE},
  {poster:'https://flow.google.com/asb/opaque-source'},
  {url:sourceScene.url.replace(SCENE,GUID)},
  {clips:2},
 ])assert.throws(()=>failedSourceSceneDOMFixture(changed).run('source-scene',{sourceScene,output:true,loading:true,prompt:input().prompt,ingredients:[]}),/SOURCE_VIDEO_NOT_VERIFIED|RESULT_INPUT_MISMATCH/);
 const opaque={...sourceScene,poster:'https://flow.google.com/asb/opaque-source'};
 assert.throws(()=>failedSourceSceneDOMFixture({poster:opaque.poster}).run('source-scene',{sourceScene:opaque,output:true,loading:true,prompt:input().prompt,ingredients:[]}),/SOURCE_VIDEO_NOT_VERIFIED/);
 const incomplete=failedSourceSceneDOMFixture({message:''});assert.throws(()=>incomplete.run('source-scene',{sourceScene,output:true,loading:true,prompt:input().prompt,ingredients:[]}),/RESULT_INPUT_MISMATCH/);
 assert.throws(()=>h.run('source-scene',{sourceScene,output:true,loading:true}),/RESULT_INPUT_MISMATCH/);
});

test('Edit recovery preserves literal owned failure as terminal without provider public code download or retry and mismatches remain unknown',async t=>{
 const projectURL='https://flow.google.com/project/'+SOURCE_PROJECT,sourceScene={url:projectURL+'/edit/'+SCENE,poster:'https://flow-content.google/image/'+GUID,sha256:crypto.createHash('sha256').update(MP4).digest('hex'),durationSeconds:3,width:1280,height:720};
 for(const mismatch of [false,true]){
  const dom=failedSourceSceneDOMFixture({prompt:mismatch?input().prompt+' foreign':input().prompt}),h=await harness(t,{recover:true,operation(op,arg){if(op==='source-scene'){try{return dom.run(op,arg);}catch(error){throw failure(error.message.split(':')[0],error.message);}}}}),{jobId,file}=await savedReceipt(h,{model:'omni-1.2-flash-edit-landscape',projectURL,sourceScene,ingredients:[]}),bytes=await fs.readFile(file);
  await assert.rejects(h.engine.recover(jobId),error=>{
   if(mismatch)return error.code==='RESULT_INPUT_MISMATCH'&&error.unknownOutcome===true&&error.generationTerminal!==true;
   assert.equal(error.code,'FLOW_GENERATION_REJECTED');assert.equal(error.generationTerminal,true);assert.equal(error.accountFailure,false);assert.equal(error.unknownOutcome,false);assert.equal(error.message,'Flow отклонил редактирование: Failed\nSorry, this video failed to generate.');assert.equal(error.message.includes('PUBLIC_ERROR_'),false);return true;
  });
  assert.equal(h.state.submitted,0);assert.equal(h.state.acquisitions,1);assert.equal(h.state.releases,1);assert.equal(h.uploads.length,0);assert.equal(h.ops.some(op=>['submit','history','history-download','recovery-candidates','open-recovery-candidate'].includes(op.op)),false);assert.equal(h.commands.some(command=>command.method==='Browser.setDownloadBehavior'||command.method==='Input.dispatchMouseEvent'),false);assert.deepEqual(await fs.readFile(file),bytes);
 }
});

test('uploaded source card uses exact staged filename or extension-free nonce and exposes no invented media id',()=>{
 const name=GUID+'.mp4',poster='https://flow.google.com/asb/uploaded-source';let opens=0;
 const video={getClientRects:()=>[1],getAttribute:()=>null,click:()=>opens++,dispatchEvent:event=>{assert.equal(event.type,'dblclick');assert.equal(event.detail,2);}},image={complete:true,naturalWidth:360,getAttribute:attr=>attr==='src'?poster:null};
 const card={getAttribute:attr=>attr==='aria-label'?GUID:null,getClientRects:()=>[1],closest:()=>null,scrollIntoView(){},querySelector:selector=>selector==='flow-video-tile'?video:selector==='img'?image:null};let cards=[card];
 const context={location:{origin:'https://flow.google.com'},getComputedStyle:()=>({visibility:'visible'}),MouseEvent:class{constructor(type,options){this.type=type;Object.assign(this,options);}},document:{querySelector:()=>null,querySelectorAll:selector=>selector==='flow-grid-tile-container[role="group"]'?cards:[]}};
 const run=arg=>vm.runInNewContext('('+flowDOM.toString()+')("video-uploaded",'+JSON.stringify(arg)+')',context);
 const found=run({name});assert.equal(found.name,GUID);assert.equal(found.poster,poster);assert.equal(found.identity,undefined);
 image.complete=false;assert.equal(run({name}),false);image.complete=true;image.naturalWidth=0;assert.equal(run({name}),false);image.naturalWidth=360;
 image.getAttribute=()=> 'data:image/png;base64,placeholder';assert.equal(run({name}),false);image.getAttribute=attr=>attr==='src'?poster:null;
 assert.equal(run({name,open:true}).poster,poster);assert.equal(opens,1);
 assert.equal(run({name:'other.mp4'}),false);
 cards=[card,{...card}];assert.throws(()=>run({name}),/SOURCE_VIDEO_AMBIGUOUS/);assert.equal(opens,1);
});

test('uploaded source card scrolls its unique offscreen thumbnail before waiting for image readiness',()=>{
 const name=GUID+'.mp4',poster='https://flow.google.com/asb/lazy-upload';let top=1800,scrolls=0,opens=0,loaded=false;
 const video={getClientRects:()=>[1],getBoundingClientRect:()=>({left:248,top,right:410,bottom:top+288,width:162,height:288}),getAttribute:()=>null,click:()=>opens++,dispatchEvent:()=>{}};
 const image={get complete(){return loaded;},get naturalWidth(){return loaded?288:0;},getAttribute:key=>key==='src'?poster:null};
 const card={getAttribute:key=>key==='aria-label'?GUID:null,getClientRects:()=>[1],closest:()=>null,scrollIntoView:options=>{assert.equal(options.block,'center');scrolls++;top=100;},querySelector:selector=>selector==='flow-video-tile'?video:selector==='img'?image:null};let cards=[card];
 const context={innerWidth:1280,innerHeight:900,location:{origin:'https://flow.google.com'},getComputedStyle:()=>({visibility:'visible'}),MouseEvent:class{},document:{querySelector:()=>null,querySelectorAll:selector=>selector==='flow-grid-tile-container[role="group"]'?cards:[]}};
 const run=arg=>vm.runInNewContext('('+flowDOM.toString()+')("video-uploaded",'+JSON.stringify(arg)+')',context);
 assert.equal(run({name}),false);assert.equal(scrolls,1);assert.equal(opens,0);
 loaded=true;assert.equal(run({name,open:true}).poster,poster);assert.equal(opens,1);
 const previousScrolls=scrolls;assert.equal(run({name:'unrelated.mp4'}),false);cards=[card,{...card}];assert.throws(()=>run({name}),/SOURCE_VIDEO_AMBIGUOUS/);assert.equal(scrolls,previousScrolls);assert.equal(opens,1);
});

test('uploaded source card normalizes observed Flow image poster and rejects unrelated resources',()=>{
 const name=GUID+'.mp4',poster='https://flow-content.google/image/'+GUID;let src=poster+'?signature=upload';
 const image={complete:true,naturalWidth:1280,getAttribute:key=>key==='src'?src:null};
 const card={getAttribute:key=>key==='aria-label'?GUID:null,getClientRects:()=>[1],closest:()=>null,scrollIntoView(){},querySelector:selector=>selector==='flow-video-tile'?{}:selector==='img'?image:null};
 const context={URL,location:{origin:'https://flow.google.com'},getComputedStyle:()=>({visibility:'visible'}),document:{querySelector:()=>null,querySelectorAll:selector=>selector==='flow-grid-tile-container[role="group"]'?[card]:[]}};
 const run=()=>vm.runInNewContext('('+flowDOM.toString()+')('+'"video-uploaded",'+JSON.stringify({name})+')',context);
 assert.equal(run().poster,poster);assert.equal(run().identity,undefined);
 for(const value of [poster+'#fragment',poster.replace('https://','https://user:pass@'),poster.replace('flow-content.google','flow-content.google.evil.test'),poster.replace('/image/','/video/'),'https://storage.googleapis.com/ai-sandbox-videofx/image/'+GUID,'data:image/png;base64,placeholder']){src=value;assert.equal(run(),false);}
});

test('source scene normalizes only imported Flow image poster and retains exact generated poster binding',()=>{
 const poster='https://flow-content.google/image/'+GUID,projectURL='https://flow.google.com/project/'+SOURCE_PROJECT,expected={url:projectURL+'/edit/'+SCENE,poster};
 const initial=sourceSceneDOMFixture([{poster:poster+'?signature=imported'}]);assert.equal(initial.run('source-scene',{poster,projectURL,loading:true}).poster,poster);
 const generated='https://flow-content.google/image/generated-result?signature=exact-output';
 const output=sourceSceneDOMFixture([{poster:poster+'?signature=refreshed',selected:false},{prompt:input().prompt,poster:generated}]);
 assert.equal(output.run('source-scene',{sourceScene:expected,output:true}).outputPoster,generated);
 assert.equal(output.run('history',{poster:generated}).posters[0],generated);
 for(const values of [
  [{poster:poster+'-changed?signature=source'}],
  [{poster:poster+'#fragment'}],
  [{poster:'https://flow-content.google.evil.test/image/'+GUID}],
 ])assert.throws(()=>sourceSceneDOMFixture(values).run('source-scene',{sourceScene:expected}),/SOURCE_VIDEO_NOT_VERIFIED/);
 assert.throws(()=>sourceSceneDOMFixture([{poster,selected:false},{prompt:input().prompt,poster:poster+'?signature=duplicate'}]).run('source-scene',{sourceScene:expected,output:true}),/SOURCE_VIDEO_NOT_VERIFIED/);
 assert.throws(()=>initial.run('source-scene',{poster:poster+'?signature=not-canonical',projectURL}),/SOURCE_VIDEO_NOT_VERIFIED/);
});

test('initial source scene waits for positive unique playable MM SS FF duration compatible with source metadata',()=>{
 const poster='https://flow.google.com/asb/playable-source',projectURL='https://flow.google.com/project/'+SOURCE_PROJECT;
 const loading={poster,projectURL,durationSeconds:3.029333,loading:true};
 assert.throws(()=>sourceSceneDOMFixture([{poster}],{durationValues:['00:00:00']}).run('source-scene',loading),/SOURCE_VIDEO_NOT_READY/);
 assert.throws(()=>sourceSceneDOMFixture([{poster}],{durationValues:[]}).run('source-scene',loading),/SOURCE_VIDEO_NOT_READY/);
 assert.equal(sourceSceneDOMFixture([{poster}],{durationValues:['00:03:00']}).run('source-scene',loading).poster,poster);
 assert.equal(sourceSceneDOMFixture([{poster}],{durationValues:['00:07:22']}).run('source-scene',{...loading,durationSeconds:7.93}).poster,poster);
 for(const durationValues of [['00:00:00'],['00:12:00'],['03:00'],['00:03:99'],['garbled'],['00:03:00','00:03:00']])assert.throws(()=>sourceSceneDOMFixture([{poster}],{durationValues}).run('source-scene',{...loading,loading:false}),/SOURCE_VIDEO_NOT_VERIFIED/);
 assert.throws(()=>sourceSceneDOMFixture([{poster}],{durationValues:['00:12:00']}).run('source-scene',loading),/SOURCE_VIDEO_NOT_VERIFIED/);
 const output=sourceSceneDOMFixture([{poster,selected:false},{prompt:input().prompt,poster:'generated-ready'}],{durationValues:['00:00:00']});
 assert.equal(output.run('source-scene',{sourceScene:{url:projectURL+'/edit/'+SCENE,poster,durationSeconds:3.029333},output:true}).outputPoster,'generated-ready');
});

test('Edit waits for initial player readiness and rechecks playable source before the sole submit',async t=>{
 const folder=await temporary(t),file=path.join(folder,'source.mp4');await fs.writeFile(file,MP4);let initial=0,beforeSubmitReads=0;
 const h=await harness(t,{edit:true,inspectVideo:async()=>({durationSeconds:3.029333,mimeType:'video/mp4',width:1280,height:720}),operation(op,arg){
  if(op!=='source-scene'||arg.output)return;
  assert.equal(arg.sourceScene?.durationSeconds??arg.durationSeconds,3.029333);
  if(arg.sourceScene?.url){assert.equal(arg.loading,true);beforeSubmitReads++;if(beforeSubmitReads<=2)throw failure('SOURCE_VIDEO_NOT_READY');}
  else if(++initial<=2)throw failure('SOURCE_VIDEO_NOT_READY');
 }});
 const prepared=await h.engine.prepare(input({model:'omni-1.2-flash-edit-landscape',references:[{kind:'video',path:file}]}));
 assert.equal(initial,3);assert.equal(h.state.submitted,0);
 await h.engine.submit(prepared,{beforeSubmit:()=>{assert.ok(beforeSubmitReads>=3);}});assert.equal(h.state.submitted,1);assert.ok(beforeSubmitReads>=4);await h.engine.release(prepared);
});

test('source scene initializes only one imported version and output must retain it beside a distinct selected generated version',()=>{
 const sourcePoster='https://flow.google.com/asb/imported-source',projectURL='https://flow.google.com/project/'+SOURCE_PROJECT,expected={url:projectURL+'/edit/'+SCENE,poster:sourcePoster};
 const initial=sourceSceneDOMFixture([{poster:sourcePoster}]);
 assert.equal(JSON.stringify(initial.run('source-scene',{poster:sourcePoster,projectURL})),JSON.stringify(expected));
 const output=sourceSceneDOMFixture([{poster:sourcePoster,selected:false},{prompt:input().prompt,poster:'generated-poster'}]);
 assert.deepEqual(JSON.parse(JSON.stringify(output.run('source-scene',{sourceScene:expected,output:true}))),{...expected,outputPoster:'generated-poster'});
 for(const [values,options] of [
  [[{poster:sourcePoster}],{clips:2}],
  [[{poster:'replacement-poster'}],{}],
  [[{poster:sourcePoster}],{url:projectURL+'/edit/'+GUID}],
  [[{poster:sourcePoster},{poster:sourcePoster,selected:false}],{}],
 ])assert.throws(()=>sourceSceneDOMFixture(values,options).run('source-scene',{sourceScene:expected}),/SOURCE_VIDEO_NOT_VERIFIED/);
 for(const values of [
  [{prompt:input().prompt,poster:'generated-poster'}],
  [{poster:'different-source',selected:false},{prompt:input().prompt,poster:'generated-poster'}],
  [{poster:sourcePoster,selected:false},{prompt:input().prompt,poster:sourcePoster}],
  [{poster:sourcePoster},{prompt:input().prompt,poster:'generated-poster',selected:false}],
  [{poster:sourcePoster,selected:false},{prompt:input().prompt,poster:'generated-poster'},{poster:'another-import',selected:false}],
 ])assert.throws(()=>sourceSceneDOMFixture(values).run('source-scene',{sourceScene:expected,output:true}),/SOURCE_VIDEO_NOT_VERIFIED/);
 assert.throws(()=>sourceSceneDOMFixture([],{clips:0}).run('source-scene',{poster:sourcePoster,projectURL,loading:true}),/SOURCE_VIDEO_NOT_READY/);
 assert.throws(()=>sourceSceneDOMFixture([]).run('source-scene',{poster:sourcePoster,projectURL,loading:true}),/SOURCE_VIDEO_NOT_READY/);
 assert.throws(()=>sourceSceneDOMFixture([{poster:'data:image/png;base64,placeholder'}]).run('source-scene',{poster:sourcePoster,projectURL,loading:true}),/SOURCE_VIDEO_NOT_READY/);
 assert.throws(()=>sourceSceneDOMFixture([{poster:sourcePoster,loaded:false}]).run('source-scene',{poster:sourcePoster,projectURL,loading:true}),/SOURCE_VIDEO_NOT_READY/);
 assert.throws(()=>sourceSceneDOMFixture([{poster:'https://flow.google.com/asb/changed-source'}]).run('source-scene',{poster:sourcePoster,projectURL,loading:true}),/SOURCE_VIDEO_NOT_VERIFIED/);
 assert.throws(()=>sourceSceneDOMFixture([{poster:sourcePoster}],{clips:2}).run('source-scene',{poster:sourcePoster,projectURL,loading:true}),/SOURCE_VIDEO_NOT_VERIFIED/);
 assert.throws(()=>sourceSceneDOMFixture([{poster:sourcePoster}]).run('source-scene',{sourceScene:expected,output:true,loading:true}),/SOURCE_VIDEO_NOT_READY/);
 assert.throws(()=>sourceSceneDOMFixture([{poster:'https://flow.google.com/asb/replaced-source'}]).run('source-scene',{sourceScene:expected,output:true,loading:true}),/SOURCE_VIDEO_NOT_VERIFIED/);
});

test('source scene waits only one owned pending generated entry beside retained imported source in the same scene',()=>{
 const poster='https://flow.google.com/asb/imported-source',sourceScene={url:'https://flow.google.com/project/'+SOURCE_PROJECT+'/edit/'+SCENE,poster};
 for(const sourceSelected of [false,true]){
  const pending=sourceSceneDOMFixture([{poster,selected:sourceSelected},{pending:true,selected:!sourceSelected}]);
  assert.throws(()=>pending.run('source-scene',{sourceScene,output:true,loading:true}),/SOURCE_VIDEO_NOT_READY/);
  assert.throws(()=>pending.run('source-scene',{sourceScene,output:true}),/SOURCE_VIDEO_NOT_VERIFIED/);
 }
 for(const [values,options] of [
  [[{poster:'https://flow.google.com/asb/replaced-source',selected:false},{pending:true}],{}],
  [[{poster,selected:false},{pending:true}],{url:sourceScene.url.replace(SCENE,GUID)}],
  [[{poster,selected:false},{pending:true}],{clips:2}],
  [[{poster,selected:false},{}],{}],
  [[{poster,selected:false},{pendingCount:2}],{}],
  [[{poster,selected:false},{kind:'image',pending:true}],{}],
  [[{poster,selected:false},{prompt:input().prompt,poster:'new-output',loaded:false}],{}],
 ])assert.throws(()=>sourceSceneDOMFixture(values,options).run('source-scene',{sourceScene,output:true,loading:true}),/SOURCE_VIDEO_NOT_VERIFIED/);
});

test('Edit preparation waits only initial missing scene state and then preserves verified source binding',async t=>{
 const folder=await temporary(t),file=path.join(folder,'source.mp4');await fs.writeFile(file,MP4);
 const h=await harness(t,{edit:true,sourceSceneDelays:2,inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720})});
 const prepared=await h.engine.prepare(input({model:'omni-1.2-flash-edit-landscape',references:[{kind:'video',path:file}]}));
 assert.equal(h.state.sourceSceneReads,3);assert.equal(prepared.sourceScene.poster,'https://flow.google.com/asb/source-video-poster');assert.equal(h.state.submitted,0);
 assert.equal(h.ops.filter(op=>op.op==='source-scene').every(op=>op.arg.loading===true),true);await h.engine.release(prepared);assert.equal(h.state.releases,1);
});

test('bound History download rejects source replacement after exact selected output verification',()=>{
 const poster='generated-result',sourceScene={url:'https://flow.google.com/project/'+SOURCE_PROJECT+'/edit/'+SCENE,poster:'https://flow.google.com/asb/imported-source'};
 const values=[{poster:sourceScene.poster,selected:false},{prompt:input().prompt,poster,ingredients:[]}],h=sourceSceneDOMFixture(values),history=h.run('history',{poster});
 const binding={kind:'video',poster,prompt:history.prompt,ingredients:[],sourceVideos:[],url:history.url,sourceScene};
 assert.equal(h.run('history-download',{binding}),true);
 const changed=sourceSceneDOMFixture([{poster:'replacement',selected:false},values[1]]);
 assert.throws(()=>changed.run('history-download',{binding,click:true}),/SOURCE_VIDEO_NOT_VERIFIED/);assert.equal(values[1].downloadClicks,undefined);
});

test('English history retains full exact prompt canonical ingredients and poster in one selected semantic video entry', () => {
  const posterURL='https://flow.google.com/asb/result-English';
  const h=historyDOMFixture([{prompt:input().prompt,poster:posterURL,ingredients:['https://flow-content.google/image/ref-English?signed=test']}]);
  const result=h.run('history',{poster:posterURL});
  assert.equal(result.prompt,input().prompt);
  assert.equal(JSON.stringify(result.ingredients), JSON.stringify(['https://flow-content.google/image/ref-English']));
  assert.equal(JSON.stringify(result.posters), JSON.stringify([posterURL]));
  assert.equal(result.ingredientsReady, true);
});

test('English history waits for each ingredient image and rejects non-Flow placeholder sources', () => {
  const value={prompt:input().prompt,poster:'exact-poster',ingredients:[null]},h=historyDOMFixture([value]),ingredient=h.steps[0].ingredients[0];let images=[];ingredient.querySelectorAll=()=>images;
  const run=()=>h.run('history',{poster:value.poster});
  assert.equal(run().ingredientsReady, false); assert.equal(JSON.stringify(run().ingredients), '[null]');
  images = [{ currentSrc: 'https://other.example/image/placeholder' }]; assert.equal(run().ingredientsReady, false);
  images = [{ currentSrc: 'https://flow-content.google/image/original_ref?signature=transient' }];
  assert.equal(run().ingredientsReady, true); assert.equal(JSON.stringify(run().ingredients), '["https://flow-content.google/image/original_ref"]');
});

test('History never combines prompt ingredients source video or poster from different entries',()=>{
  const selected={prompt:'Wrong selected prompt',poster:'selected-poster',ingredients:[],sourceVideos:[]},other={selected:false,prompt:input().prompt,poster:'other-poster',ingredients:['https://flow-content.google/image/requested'],sourceVideos:['https://flow-content.google/video/source']};
  const h=historyDOMFixture([selected,other],{regionText:input().prompt});
  const result=h.run('history',{poster:selected.poster});assert.equal(result.prompt,selected.prompt);assert.deepEqual(Array.from(result.ingredients),[]);assert.deepEqual(Array.from(result.sourceVideos),[]);assert.deepEqual(Array.from(result.posters),[selected.poster]);
  assert.throws(()=>h.run('history',{poster:other.poster}),/RESULT_INPUT_MISMATCH/);
  other.selected=true;assert.throws(()=>historyDOMFixture([selected,other]).run('history'),/RESULT_INPUT_MISMATCH/);
});

test('History separates the observed owned video ingredient chip from ordered image ingredients',()=>{
 const source='https://flow-content.google/video/'+GUID,images=['https://flow-content.google/image/first','https://flow-content.google/image/second'];
 const value={prompt:input().prompt,poster:'exact-result',ingredients:images,sourceVideos:[source+'?signature=source'],videoIngredientIndex:1};
 const other={selected:false,prompt:'Other generation',poster:'foreign-result',ingredients:['https://flow-content.google/image/foreign'],sourceVideos:['https://flow-content.google/video/foreign']};
 const h=historyDOMFixture([value,other]);
 for(const button of h.steps[0].ingredients){const parent=button.closest,wrapper={},imageChip={closest:parent};button.closest=selector=>selector==='flow-image-ingredient-chip'?imageChip:selector==='flow-ingredient-chip'?wrapper:parent(selector);}
 const result=h.run('history',{poster:value.poster});
 assert.deepEqual(Array.from(result.ingredients),images);assert.deepEqual(Array.from(result.sourceVideos),[source]);assert.equal(result.ingredientsReady,true);
 const original=h.steps[0].querySelectorAll;h.steps[0].querySelectorAll=selector=>selector==='[data-source-video-id],video[src],source[src]'?[{getAttribute:()=> 'https://flow-content.google/video/unrelated-player',closest:()=>h.steps[0]}]:original(selector);
 assert.deepEqual(Array.from(h.run('history',{poster:value.poster}).sourceVideos),[source]);
});

test('History rejects unknown mixed or repeated video ingredient kinds and waits for a valid canonical video resource',()=>{
 const value={prompt:input().prompt,poster:'exact-result',sourceVideos:['https://flow-content.google/video/'+GUID]},h=historyDOMFixture([value]),button=h.steps[0].videoIngredients[0],closest=button.closest;
 for(const invalid of [null,'https://flow-content.google/image/'+GUID,'https://flow-content.google.evil.test/video/'+GUID,'https://user:pass@flow-content.google/video/'+GUID,'https://flow-content.google/video/'+GUID+'#fragment']){
  button.querySelectorAll=selector=>selector==='video[src],source[src]'&&invalid?[{getAttribute:()=>invalid,closest:selector=>selector==='flow-editor-history-step-video,flow-editor-history-step-image'?h.steps[0]:selector==='flow-video-ingredient-chip'?closest(selector):null}]:[];
  assert.equal(h.run('history',{poster:value.poster}).ingredientsReady,false);
 }
 button.closest=selector=>selector==='flow-image-ingredient-chip'?{}:closest(selector);assert.throws(()=>h.run('history',{poster:value.poster}),/RESULT_INPUT_MISMATCH/);
 button.closest=selector=>selector==='flow-video-ingredient-chip'?null:closest(selector);assert.throws(()=>h.run('history',{poster:value.poster}),/RESULT_INPUT_MISMATCH/);
 assert.throws(()=>historyDOMFixture([{...value,sourceVideos:[...value.sourceVideos,...value.sourceVideos]}]).run('history',{poster:value.poster}),/RESULT_INPUT_MISMATCH/);
});

test('History reads the persisted typed video image preview as source provenance without inventing video identity',()=>{
 const id=GUID,preview='https://storage.googleapis.com/ai-sandbox-videofx/image/'+id,images=['https://flow-content.google/image/first','https://flow-content.google/image/second'];
 const value={prompt:input().prompt,poster:'generated-result',ingredients:images,sourcePreviews:[preview+'?GoogleAccessId=fixture&Signature=private'],videoIngredientIndex:1},h=historyDOMFixture([value]);
 const result=h.run('history',{poster:value.poster});assert.deepEqual(Array.from(result.ingredients),images);assert.deepEqual(Array.from(result.sourceVideos),[]);assert.deepEqual(Array.from(result.sourcePreviews),[preview]);assert.equal(result.ingredientsReady,true);
 const flowPreview='https://flow-content.google/image/'+id,withBoth=historyDOMFixture([{...value,sourcePreviews:[flowPreview],sourceVideos:['https://flow-content.google/video/'+id]}]).run('history',{poster:value.poster});assert.deepEqual(Array.from(withBoth.sourcePreviews),[flowPreview]);assert.equal(withBoth.ingredientsReady,true);
 assert.throws(()=>historyDOMFixture([{...value,sourceVideos:['https://flow-content.google/video/'+SCENE]}]).run('history',{poster:value.poster}),/RESULT_INPUT_MISMATCH/);
 for(const sourcePreviews of [[preview.replace(id,'not-a-uuid')],[preview+'#fragment'],[preview.replace('https://','https://user:pass@')],[preview.replace('storage.googleapis.com','storage.googleapis.com.evil.test')],['https://flow-content.google/video/'+id]])assert.equal(historyDOMFixture([{...value,sourcePreviews}]).run('history',{poster:value.poster}).ingredientsReady,false);
 assert.equal(historyDOMFixture([{...value,videoIngredientBusy:true}]).run('history',{poster:value.poster}).ingredientsReady,false);
 const button=h.steps[0].videoIngredients[0],query=button.querySelectorAll;button.querySelectorAll=selector=>selector==='img[alt="Video ingredient image"]'?[...query(selector),...query(selector)]:query(selector);assert.throws(()=>h.run('history',{poster:value.poster}),/RESULT_INPUT_MISMATCH/);
});

test('History download binds exact source image preview and old bindings accept only an absent preview',()=>{
 const value={prompt:input().prompt,poster:'generated-result',sourcePreviews:['https://storage.googleapis.com/ai-sandbox-videofx/image/'+GUID]},h=historyDOMFixture([value]),history=h.run('history',{poster:value.poster});
 const binding={kind:'video',poster:value.poster,prompt:history.prompt,ingredients:[],sourceVideos:[],sourcePreviews:Array.from(history.sourcePreviews),url:history.url};
 assert.equal(h.run('history-download',{binding,click:true}),true);assert.equal(value.downloadClicks,1);
 const old={...binding};delete old.sourcePreviews;assert.throws(()=>h.run('history-download',{binding:old,click:true}),/RESULT_INPUT_MISMATCH/);assert.equal(value.downloadClicks,1);
 const changed=historyDOMFixture([{...value,sourcePreviews:['https://storage.googleapis.com/ai-sandbox-videofx/image/'+SCENE]}]);assert.throws(()=>changed.run('history-download',{binding,click:true}),/RESULT_INPUT_MISMATCH/);assert.equal(value.downloadClicks,1);
 const legacyValue={prompt:input().prompt,poster:'legacy-result'},legacy=historyDOMFixture([legacyValue]),legacyHistory=legacy.run('history',{poster:legacyValue.poster});assert.equal(legacy.run('history-download',{binding:{kind:'video',poster:legacyValue.poster,prompt:legacyHistory.prompt,ingredients:[],sourceVideos:[],url:legacyHistory.url}}),true);
});

test('Agent scene result binds fresh exact two-entry source and generated History through typed image preview despite opaque poster aliases',()=>{
 const sourceScene={url:'https://flow.google.com/project/'+SOURCE_PROJECT+'/edit/'+SCENE,poster:'https://flow-content.google/image/'+GUID},sourcePreview='https://storage.googleapis.com/ai-sandbox-videofx/image/'+GUID,refs=['https://flow-content.google/image/first','https://flow-content.google/image/second'];
 const source={poster:'https://flow.google.com/asb/current-source-alias',selected:false},output={prompt:input().prompt,poster:'https://flow.google.com/asb/generated-output',sourcePreviews:[sourcePreview+'?Signature=private'],ingredients:refs};
 const request={sourceScene,sourcePreview,prompt:input().prompt,ingredients:refs},h=sourceSceneDOMFixture([source,output]),ready=h.run('agent-scene-result',request);
 assert.equal(ready.ready,true);assert.equal(ready.url,sourceScene.url);assert.deepEqual(Array.from(ready.sourcePreviews),[sourcePreview]);assert.deepEqual(Array.from(ready.ingredients),refs);assert.deepEqual(Array.from(ready.sourceVideos),[]);assert.deepEqual(Array.from(ready.posters),[output.poster]);
 const binding={kind:'video',poster:output.poster,prompt:ready.prompt,ingredients:refs,sourceVideos:[],sourcePreviews:[sourcePreview],url:ready.url,agentSource:{sourceScene,sourcePreview}};
 assert.equal(h.run('history-download',{binding,click:true}),true);assert.equal(output.downloadClicks,1);
 const replaced=sourceSceneDOMFixture([source,{...output,sourcePreviews:['https://storage.googleapis.com/ai-sandbox-videofx/image/'+SCENE]}]);assert.throws(()=>replaced.run('history-download',{binding,click:true}),/SOURCE_VIDEO_NOT_VERIFIED|RESULT_INPUT_MISMATCH/);assert.equal(output.downloadClicks,1);
 for(const [values,options] of [
  [[source,{...output,prompt:input().prompt+' foreign'}],{}],
  [[source,{...output,ingredients:[...refs].reverse()}],{}],
  [[source,{...output,sourcePreviews:['https://storage.googleapis.com/ai-sandbox-videofx/image/'+SCENE]}],{}],
  [[source,{...output,poster:sourcePreview+'?Signature=source'}],{}],
  [[{poster:'https://flow-content.google/image/'+SCENE,selected:false},output],{}],
  [[source,output,{...output,selected:false}],{}],
  [[source,output],{url:sourceScene.url.replace(SCENE,GUID)}],
  [[source,output],{clips:2}],
 ])assert.throws(()=>sourceSceneDOMFixture(values,options).run('agent-scene-result',request),/SOURCE_VIDEO_NOT_VERIFIED|RESULT_INPUT_MISMATCH/);
});

test('Agent scene result waits for owned pending and selects only exact generated tile while literal owned failures need exact inputs',()=>{
 const sourceScene={url:'https://flow.google.com/project/'+SOURCE_PROJECT+'/edit/'+SCENE,poster:'https://flow-content.google/image/'+GUID},sourcePreview='https://storage.googleapis.com/ai-sandbox-videofx/image/'+GUID,request={sourceScene,sourcePreview,prompt:input().prompt,ingredients:[]};
 const pending=sourceSceneDOMFixture([{poster:sourceScene.poster},{prompt:input().prompt,pending:true,sourcePreviews:[sourcePreview],selected:false}]);assert.equal(pending.run('agent-scene-result',request),false);
 const source={poster:'https://flow.google.com/asb/source-alias'},output={prompt:input().prompt,poster:'https://flow.google.com/asb/generated-output',sourcePreviews:[sourcePreview],selected:false},h=sourceSceneDOMFixture([source,output]);
 assert.equal(h.run('agent-scene-result',request),false);assert.equal(output.selectionClicks,undefined);assert.equal(h.run('agent-scene-result',{...request,open:true}),false);assert.equal(output.selectionClicks,1);assert.equal(source.selectionClicks,undefined);assert.equal(h.run('agent-scene-result',request).ready,true);
 const failed=failedSourceSceneDOMFixture({sourceVideos:[],sourcePreviews:[sourcePreview]});
 // This fixture's dedicated wrapper owns the error tile; source previews use the same typed base entry.
 const failure=failed.run('agent-scene-result',request);assert.equal(failure.failure.message,'Failed\nSorry, this video failed to generate.');
 assert.throws(()=>failed.run('agent-scene-result',{...request,prompt:'foreign'}),/RESULT_INPUT_MISMATCH/);
});

test('Agent scene reload waits for imported and output pending tiles until owned prompt previews and images load',()=>{
 const sourceScene={url:'https://flow.google.com/project/'+SOURCE_PROJECT+'/edit/'+SCENE,poster:'https://flow-content.google/image/'+GUID},sourcePreview='https://storage.googleapis.com/ai-sandbox-videofx/image/'+GUID,request={sourceScene,sourcePreview,prompt:input().prompt,ingredients:[]};
 for(const values of [
  [{poster:'https://flow.google.com/asb/source',pending:true},{prompt:input().prompt,poster:'https://flow.google.com/asb/output',pending:true,sourcePreviews:[sourcePreview],selected:false}],
  [{poster:'https://flow.google.com/asb/source',pending:true},{poster:'https://flow.google.com/asb/output',pending:true,selected:false}],
  [{poster:'https://flow.google.com/asb/source',loaded:false},{prompt:input().prompt,poster:'https://flow.google.com/asb/output',sourcePreviews:[sourcePreview],selected:false}],
  [{poster:'https://flow.google.com/asb/source'},{prompt:input().prompt,poster:'https://flow.google.com/asb/output',sourcePreviews:[null],videoIngredientBusy:true,selected:false}],
 ])assert.equal(sourceSceneDOMFixture(values).run('agent-scene-result',request),false);
 const source={poster:'https://flow.google.com/asb/source',selected:false},output={prompt:input().prompt,poster:'https://flow.google.com/asb/output',sourcePreviews:[sourcePreview]};
 const settled=sourceSceneDOMFixture([source,output]);assert.equal(settled.run('agent-scene-result',request).ready,true);
 assert.throws(()=>sourceSceneDOMFixture([{poster:source.poster},{poster:output.poster,selected:false}]).run('agent-scene-result',request),/SOURCE_VIDEO_NOT_VERIFIED/);
 assert.throws(()=>sourceSceneDOMFixture([source,{...output,prompt:'Known foreign request'}]).run('agent-scene-result',request),/RESULT_INPUT_MISMATCH/);
});

test('Agent scene result waits only ephemeral source poster placeholders and reports safe mismatch enums without URLs',()=>{
 const sourceScene={url:'https://flow.google.com/project/'+SOURCE_PROJECT+'/edit/'+SCENE,poster:'https://flow-content.google/image/'+GUID},sourcePreview='https://storage.googleapis.com/ai-sandbox-videofx/image/'+GUID,request={sourceScene,sourcePreview,prompt:input().prompt,ingredients:[]},output={prompt:input().prompt,poster:'https://flow.google.com/asb/generated-result',sourcePreviews:[sourcePreview]};
 for(const poster of ['',undefined,'data:image/png;base64,PLACEHOLDER','blob:https://flow.google.com/'+SCENE])assert.equal(sourceSceneDOMFixture([{poster,selected:false},output]).run('agent-scene-result',request),false);
 for(const [poster,reason] of [['https://flow-content.google/image/'+SCENE,'recognized-resource-mismatch'],['https://evil.example/private?token=SECRET','unrecognized-source-poster'],['blob:https://evil.example/private','unrecognized-source-poster'],[sourcePreview,'unrecognized-source-poster']]){
  assert.throws(()=>sourceSceneDOMFixture([{poster,selected:false},output]).run('agent-scene-result',request),error=>error.message.includes(reason)&&!error.message.includes('SECRET')&&!error.message.includes('https://'));
 }
 assert.equal(sourceSceneDOMFixture([{poster:'https://flow.google.com/asb/settled-source',selected:false},output]).run('agent-scene-result',request).ready,true);
});

test('History rejects missing duplicate imported and mixed-kind selected entries and prompt UI contamination',()=>{
  const base={prompt:input().prompt,poster:'exact-poster'};
  for(const values of [[],[{...base,selected:false}],[{...base,selectedCount:2}],[{...base,promptCount:2}],[{...base,prompt:undefined}],[{...base,promptControls:true}],[{...base,kind:'image'}]])assert.throws(()=>historyDOMFixture(values).run('history',{poster:'exact-poster'}),/RESULT_INPUT_MISMATCH/);
  const image=historyDOMFixture([{...base,kind:'image',ingredients:['https://flow-content.google/image/ref']}]);assert.equal(image.run('history',{kind:'image',poster:base.poster}).prompt,input().prompt);
  assert.throws(()=>historyDOMFixture([{...base,kind:'image',prompt:undefined}]).run('history',{kind:'image',poster:base.poster}),/RESULT_INPUT_MISMATCH/);
});

test('History download rechecks same selected entry tuple and clicks only its own observed Download control',()=>{
  const value={prompt:input().prompt,poster:'exact-poster',ingredients:['https://flow-content.google/image/ref'],sourceVideos:[]};let globalClicks=0;
  const h=historyDOMFixture([value],{globalButtons:[{click:()=>globalClicks++}]}),history=h.run('history',{poster:value.poster}),binding={kind:'video',poster:value.poster,prompt:history.prompt,ingredients:Array.from(history.ingredients),sourceVideos:Array.from(history.sourceVideos),url:history.url};
  assert.equal(h.run('history-download',{binding,click:true}),true);assert.equal(value.downloadClicks,1);assert.equal(globalClicks,0);
  value.prompt+=' changed';assert.throws(()=>h.run('history-download',{binding,click:true}),/RESULT_INPUT_MISMATCH/);assert.equal(value.downloadClicks,1);
});

test('selected hidden hotbar uses its own raw More options button and never a foreign hidden trigger',()=>{
  const value={kind:'image',prompt:input().prompt,poster:'hidden-hotbar-image',moreOptions:true,hiddenHotbar:true},foreign={kind:'image',selected:false,prompt:'Other prompt',poster:'foreign-image',moreOptions:true,hiddenHotbar:true};
  const h=historyDOMFixture([value,foreign]),history=h.run('history',{kind:'image',poster:value.poster}),binding={kind:'image',poster:value.poster,prompt:history.prompt,ingredients:[],sourceVideos:[],url:history.url};
  assert.equal(h.run('history-download',{binding,click:true}),true);assert.equal(value.downloadClicks,1);assert.equal(foreign.downloadClicks,undefined);
  assert.equal(h.run('history-download-menu',{binding}).needsSubmenu,true);
});

test('portrait History download follows only its own aria-controlled More options Download submenu and bound size option',()=>{
  const value={kind:'image',prompt:input().prompt,poster:'exact-image-poster',ingredients:[],moreOptions:true,disable4K:true};
  const h=historyDOMFixture([value]),history=h.run('history',{kind:'image',poster:value.poster}),binding={kind:'image',poster:value.poster,prompt:history.prompt,ingredients:[],sourceVideos:[],url:history.url};
  assert.equal(h.run('history-download-menu',{binding}),false);
  assert.equal(h.run('history-download',{binding,click:true}),true);assert.equal(value.downloadClicks,1);
  const outer=h.run('history-download-menu',{binding});assert.equal(outer.menuId,'owned-more-menu');assert.equal(outer.needsSubmenu,true);
  assert.equal(h.run('history-download-menu',{binding,open:true}),false);assert.equal(value.submenuClicks,1);
  const menu=h.run('history-download-menu',{binding,submenu:true});assert.equal(menu.menuId,'owned-size-menu');assert.equal(menu.needsSubmenu,false);
  assert.equal(h.run('image-download-option',{binding,menuId:menu.menuId,resolution:'1K',click:true}),true);assert.equal(value.downloadOptionClicks,1);
  assert.throws(()=>h.run('image-download-option',{binding,menuId:menu.menuId,resolution:'4K',click:true}),/IMAGE_RESOLUTION_UNAVAILABLE/);assert.equal(value.downloadOptionClicks,1);
  assert.throws(()=>h.run('image-download-option',{binding,menuId:'foreign-menu',resolution:'1K',click:true}),/RESULT_INPUT_MISMATCH/);
  value.prompt+=' changed';assert.throws(()=>h.run('image-download-option',{binding,menuId:menu.menuId,resolution:'1K',click:true}),/RESULT_INPUT_MISMATCH/);assert.equal(value.downloadOptionClicks,1);
});

test('English uploaded asset matches filename newline Image and exact Preview of filename alt', () => {
  const filename = 'ref-cafe123456789abc-0-abc12345.png'; let selected = 0;
  const option = { innerText: filename + '\nImage', getAttribute: () => null, getClientRects: () => [1], click: () => { selected++; } };
  const preview = { alt: 'Preview of ' + filename, currentSrc: 'https://flow-content.google/image/upload-owned?signature=fixture', getClientRects: () => [1] };
  const unrelated = { alt: 'Preview of other.png', currentSrc: 'https://flow-content.google/image/other', getClientRects: () => [1] };
  const context = {
    location: { origin: 'https://flow.google.com' }, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: () => null, querySelectorAll: selector => selector === '[role="option"]' ? [option] : selector === 'img' ? [unrelated, preview] : [] },
  };
  const run = arg => vm.runInNewContext('(' + flowDOM.toString() + ')("asset",' + JSON.stringify(arg) + ')', context);
  const state = run({ name: filename });
  assert.equal(state.exists, true); assert.equal(state.preview, preview.currentSrc); assert.equal(selected, 0);
  assert.equal(run({ name: filename, select: true }).exists, true); assert.equal(selected, 1);
  preview.alt += '.different';
  assert.equal(run({ name: filename }).preview, null); assert.equal(selected, 1);
});

test('frame picker selects exact filename button and Image ingredient chip exposes canonical source to composer and history', () => {
  const filename = 'ref-exact-frame.png'; let selected = 0;
  const image = { currentSrc: 'https://flow-content.google/image/frame-cropped?signature=fixture' };
  const picker = { innerText: filename, getAttribute: () => null, getClientRects: () => [1], click: () => { selected++; } };
  const chip = { getAttribute: attr => attr === 'aria-label' ? 'Image ingredient' : null, getClientRects: () => [1], querySelectorAll: selector => selector.includes('Ingredient image') ? [image] : [] };
  const prompt = { innerText: 'Frame prompt', getAttribute: attr => attr === 'aria-label' ? 'What do you want to create?' : null, getClientRects: () => [1] };
  const start = { getAttribute: attr => attr === 'aria-label' ? 'Start generation' : null, getClientRects: () => [1] };
  const context = {
    location: { origin: 'https://flow.google.com', href: 'https://flow.google.com/project/owned' }, URL, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: () => null, querySelectorAll: selector => selector === 'button,[role="button"]' ? [picker, chip, start] : selector === '[role="textbox"],textarea,input[type="text"]' ? [prompt] : [] },
  };
  const run = (op, arg) => vm.runInNewContext('(' + flowDOM.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg || {}) + ')', context);
  assert.equal(run('asset', { name: filename, select: true }).exists, true); assert.equal(selected, 1);
  assert.equal(JSON.stringify(run('composer').ingredients), '["https://flow-content.google/image/frame-cropped"]');
  const history=historyDOMFixture([{prompt:'Frame prompt',poster:'frame-result',ingredients:[image.currentSrc]}]).run('history',{poster:'frame-result'});
  assert.equal(JSON.stringify(history.ingredients), '["https://flow-content.google/image/frame-cropped"]'); assert.equal(history.ingredientsReady, true);
  assert.equal(run('asset', { name: filename + '-other' }).exists, false); assert.equal(selected, 1);
});

test('image asset waits for picker match and never opens same-filename navigation rail media',()=>{
 const filename='ref-475358b2dabfec30-0-c036bd11.png';let navigationClicks=0,pickerClicks=0,options=[];
 const rail={tagName:'FLOW-NAVIGATION-RAIL'};
 const navigation={getClientRects:()=>[1],getAttribute:key=>key==='aria-label'?filename:null,closest:selector=>selector.includes('flow-navigation-rail')?rail:null,click:()=>navigationClicks++};
 const picker={getClientRects:()=>[1],getAttribute:key=>key==='aria-label'?filename+' Image':null,closest:()=>null,click:()=>pickerClicks++};
 const context={location:{origin:'https://flow.google.com'},getComputedStyle:()=>({visibility:'visible'}),document:{querySelector:()=>null,querySelectorAll:selector=>selector==='button,[role="button"]'?[navigation]:selector==='[role="option"]'?options:[]}};
 const run=()=>vm.runInNewContext('('+flowDOM.toString()+')('+'"asset",'+JSON.stringify({name:filename,select:true})+')',context);
 assert.equal(run().exists,false);assert.equal(navigationClicks,0);assert.equal(pickerClicks,0);
 options=[picker];assert.equal(run().exists,true);assert.equal(navigationClicks,0);assert.equal(pickerClicks,1);
 options=[picker,{...picker}];assert.throws(run,/INGREDIENT_AMBIGUOUS/);assert.equal(navigationClicks,0);assert.equal(pickerClicks,1);
});

test('text preparation preserves prompt and exact settings, with no input upload or submission', async t => {
  const h = await harness(t), value = input({ model: 'omni-1.2-flash-15s-portrait-360p' });
  const prepared = await h.engine.prepare(value);
  assert.equal(h.state.prompt, value.prompt);
  assert.equal(h.state.duration, 12);
  assert.deepEqual([...h.state.radios], ['Видео', 'Ингредиенты', '9:16', '360p 360p: видео генерируется быстрее, но разрешение ниже', 'x1']);
  assert.equal(h.state.model, 'Omni 1.2 Flash');
  assert.equal(prepared.folder, undefined); assert.deepEqual(prepared.ingredients, []);
  assert.equal(h.commands.filter(c => c.method === 'Input.insertText').length, 1);
  assert.equal(h.commands.some(c => c.method === 'DOM.setFileInputFiles'), false);
  assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 0);
  await h.engine.release(prepared); assert.equal(h.state.releases, 1);
});

test('one and two ingredients retain uploaded byte digests, canonical resource order, and private file modes', async t => {
  for (const references of [[{ kind: 'image', dataUrl: PNG }], [{ kind: 'image', dataUrl: PNG }, { kind: 'image', dataUrl: GIF }]]) {
    const h = await harness(t, { delayedFileInput: 1, autoAdd: references.length === 1 });
    const prepared = await h.engine.prepare(input({ references }));
    assert.deepEqual(prepared.ingredients, h.uploads.map(upload => upload.identity));
    for (let i = 0; i < references.length; i++) {
      const bytes = Buffer.from(references[i].dataUrl.split(',')[1], 'base64'), digest = crypto.createHash('sha256').update(bytes).digest('hex');
      assert.deepEqual(h.uploads[i].bytes, bytes);
      assert.ok(h.uploads[i].name.startsWith(`ref-${digest.slice(0, 16)}-${i}-`));
      assert.equal(path.dirname(h.uploads[i].file), prepared.folder);
    }
    assert.deepEqual(h.commands.filter(c => c.method === 'Page.setInterceptFileChooserDialog').map(c => c.params.enabled), references.flatMap(() => [true, false]));
    assert.equal(h.commands.filter(c => c.method === 'DOM.setFileInputFiles').length, references.length);
    assert.equal(h.commands.filter(c => c.method === 'Runtime.releaseObject').length, references.length);
    assert.equal(h.commands.filter(c => c.method === 'Page.enable').length, references.length);
    assert.equal(h.state.submitted, 0);
    await h.engine.release(prepared);
    await assert.rejects(fs.access(prepared.folder), { code: 'ENOENT' });
    assert.equal(h.state.releases, 1);
  }
});

test('no-spend check uploads two exact ordered refs, clears owned draft, and releases all files without mouse submission', async t => {
  const h = await harness(t), references = [{ kind: 'image', dataUrl: PNG }, { kind: 'image', dataUrl: GIF }];
  const result = await h.engine.check(input({ references }));
  assert.deepEqual(result, { ready: true, accountId: 7, accountEmail: EMAIL, projectURL: 'https://flow.google.com/project/project-owned', model: input().model, referenceCount: 2, uploadedImages: 2, submitted: false, cleared: true });
  assert.equal(h.uploads.length, 2);
  for (let i = 0; i < references.length; i++) assert.deepEqual(h.uploads[i].bytes, Buffer.from(references[i].dataUrl.split(',')[1], 'base64'));
  assert.deepEqual(h.ops.filter(op => op.op === 'clear-owned').map(op => op.arg), [{ prompt: input().prompt, ingredients: h.uploads.map(upload => upload.identity) }]);
  assert.equal(h.state.prompt, ''); assert.deepEqual(h.state.ingredients, []);
  assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1);
  assert.equal(h.commands.some(command => command.method === 'Input.dispatchMouseEvent'), false);
  assert.equal(h.commands.some(command => command.method === 'Browser.setDownloadBehavior'), false);
  assert.deepEqual(await fs.readdir(h.dataDir), []);
  for (const upload of h.uploads) await assert.rejects(fs.access(upload.file), { code: 'ENOENT' });
});

test('cleanup waits for asynchronous chip removal then refocuses editor before clearing text', async t => {
  let clearing = false, polls = 0, focusAt = 0;
  const h = await harness(t, { operation(op, arg, state) {
    if (op === 'clear-owned') {
      assert.equal(state.prompt, arg.prompt); assert.deepEqual(state.ingredients, arg.ingredients);
      state.focused = false; clearing = true; return true;
    }
    if (clearing && op === 'composer') {
      polls++; state.focused = false;
      if (polls >= 3) state.ingredients = [];
      return { prompt: state.prompt, ingredients: [...state.ingredients], generateEnabled: true };
    }
    if (clearing && op === 'focus-prompt') { focusAt = polls; state.focused = true; return true; }
  } });
  const result = await h.engine.check(input({ references: [{ kind: 'image', dataUrl: PNG }] }));
  assert.equal(result.cleared, true); assert.equal(focusAt, 3);
  assert.deepEqual(h.commands.filter(command => command.method === 'Input.insertText').map(command => command.params.text), [input().prompt, '']);
  assert.equal(h.state.prompt, ''); assert.deepEqual(h.state.ingredients, []); assert.equal(h.state.releases, 1);
  assert.equal(h.state.submitted, 0);
});

test('upload rights require explicit true human callback and never accept on absent or false confirmation', async t => {
  for (const confirmation of [undefined, false]) {
    let confirmations = 0;
    const h = await harness(t, { requireRights: true, ...(confirmation === undefined ? {} : { confirmUploadRights: async details => {
      confirmations++; assert.deepEqual({ ...details, signal: undefined }, { text: RIGHTS_TEXT, accountId: 7, accountEmail: EMAIL, signal: undefined }); assert.ok(details.signal instanceof AbortSignal); return false;
    } }) });
    await assert.rejects(h.engine.check(input({ references: [{ kind: 'image', dataUrl: PNG }] })), { code: 'FLOW_UPLOAD_CONSENT_REQUIRED' });
    assert.equal(confirmations, confirmation === undefined ? 0 : 1);
    assert.equal(h.state.rightsAccepts, 0); assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1);
    assert.equal(h.ops.some(op => op.op === 'accept-upload-rights'), false);
    assert.equal(h.commands.some(command => command.method === 'Input.dispatchMouseEvent'), false);
    assert.deepEqual((await fs.readdir(h.dataDir)).filter(name => name !== 'browser-diagnostics'), []);
    if ((await fs.readdir(h.dataDir)).includes('browser-diagnostics')) {
      const diagnosticFolder = path.join(h.dataDir, 'browser-diagnostics');
      assert.equal((await fs.stat(diagnosticFolder)).mode & 0o777, 0o700);
      for (const name of await fs.readdir(diagnosticFolder)) assert.equal((await fs.stat(path.join(diagnosticFolder, name))).mode & 0o777, 0o600);
    }
  }
});

test('confirmed unchanged upload rights accept once and finish two-reference check without generating', async t => {
  let confirmations = 0;
  const h = await harness(t, { requireRights: true, confirmUploadRights: async details => {
    confirmations++; assert.deepEqual({ ...details, signal: undefined }, { text: RIGHTS_TEXT, accountId: 7, accountEmail: EMAIL, signal: undefined }); assert.ok(details.signal instanceof AbortSignal); return true;
  } });
  const result = await h.engine.check(input({ references: [{ kind: 'image', dataUrl: PNG }, { kind: 'image', dataUrl: GIF }] }));
  assert.equal(result.ready, true); assert.equal(result.submitted, false); assert.equal(result.uploadedImages, 2);
  assert.equal(confirmations, 1); assert.equal(h.state.rightsAccepts, 1);
  assert.deepEqual(h.ops.filter(op => op.op === 'accept-upload-rights').map(op => op.arg), [{ text: RIGHTS_TEXT }]);
  assert.equal(h.state.prompt, ''); assert.deepEqual(h.state.ingredients, []);
  assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1);
  assert.equal(h.commands.some(command => command.method === 'Input.dispatchMouseEvent'), false);
  assert.deepEqual(await fs.readdir(h.dataDir), []);
});

test('accepted upload-rights dialog closing animation finishes before asset polling without second acceptance', async t => {
  let confirmations = 0;
  const h = await harness(t, { requireRights: true, rightsClosingPolls: 2, confirmUploadRights: async () => { confirmations++; return true; } });
  const result = await h.engine.check(input({ references: [{ kind: 'image', dataUrl: PNG }] }));
  assert.equal(result.ready, true); assert.equal(result.submitted, false);
  assert.equal(confirmations, 1); assert.equal(h.state.rightsAccepts, 1); assert.equal(h.state.rightsPendingReads, 3);
  const acceptance = h.ops.findIndex(op => op.op === 'accept-upload-rights');
  assert.deepEqual(h.ops.slice(acceptance + 1, acceptance + 5).map(op => op.op), ['upload-rights-pending', 'upload-rights-pending', 'upload-rights-pending', 'asset']);
  assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1);
  assert.equal(h.commands.some(command => command.method === 'Input.dispatchMouseEvent'), false);
  assert.deepEqual(await fs.readdir(h.dataDir), []);
});

test('human upload-rights confirmation taking over 45 seconds gets fresh asset timeout without another confirmation', async t => {
  const actualNow = Date.now.bind(Date); let elapsed = 0, confirmations = 0;
  const clock = t.mock.method(Date, 'now', () => actualNow() + elapsed);
  try {
    const h = await harness(t, { requireRights: true, confirmUploadRights: async details => {
      confirmations++; assert.equal(details.text, RIGHTS_TEXT);
      elapsed += 50000; return true;
    } });
    const result = await h.engine.check(input({ references: [{ kind: 'image', dataUrl: PNG }] }));
    assert.equal(result.ready, true); assert.equal(result.submitted, false); assert.equal(result.uploadedImages, 1);
    assert.equal(confirmations, 1); assert.equal(h.state.rightsAccepts, 1);
    assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1);
    assert.equal(h.commands.some(command => command.method === 'Input.dispatchMouseEvent'), false);
    assert.deepEqual(await fs.readdir(h.dataDir), []);
  } finally { clock.mock.restore(); }
});

test('request and lease cancellation settle pending human consent without response, acceptance, or submission', async t => {
  for (const cause of ['request', 'lease']) {
    const controller = cause === 'request' ? new AbortController() : undefined;
    let confirmationSignal, finishConfirmation, confirmations = 0;
    const h = await harness(t, { requireRights: true, confirmUploadRights: details => {
      confirmations++; confirmationSignal = details.signal;
      return new Promise(resolve => { finishConfirmation = resolve; });
    } });
    const reason = new Error('Cancel pending human consent via ' + cause);
    const checking = h.engine.check(input({ references: [{ kind: 'image', dataUrl: PNG }] }), { signal: controller?.signal });
    const rejection = assert.rejects(checking, error => error === reason);
    await until(() => confirmationSignal);
    assert.equal(confirmationSignal.aborted, false);
    if (cause === 'request') controller.abort(reason);
    else h.leaseController.abort(reason);
    let timer;
    try { await Promise.race([rejection, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Pending consent did not settle on abort')), 1000); })]); }
    finally { clearTimeout(timer); }
    assert.equal(confirmationSignal.aborted, true); assert.equal(confirmationSignal.reason, reason);
    assert.equal(confirmations, 1); assert.equal(h.state.rightsAccepts, 0); assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1);
    assert.equal(h.ops.some(op => op.op === 'accept-upload-rights'), false);
    assert.equal(h.commands.some(command => command.method === 'Input.dispatchMouseEvent'), false);
    assert.deepEqual(await fs.readdir(h.dataDir), []);
    finishConfirmation(true); await tick();
    assert.equal(h.state.rightsAccepts, 0); assert.equal(h.state.releases, 1);
  }
});

test('changed or repeated upload rights fail closed instead of accepting another dialog', async t => {
  for (const repeatRights of [false, true]) {
    let confirmations = 0, h;
    h = await harness(t, { requireRights: true, repeatRights, confirmUploadRights: async () => {
      confirmations++; if (!repeatRights) h.state.rightsText += '\nChanged terms'; return true;
    } });
    await assert.rejects(h.engine.check(input({ references: [{ kind: 'image', dataUrl: PNG }] })), { code: repeatRights ? 'FLOW_UPLOAD_CONSENT_REQUIRED' : 'UPLOAD_RIGHTS_CHANGED' });
    assert.equal(confirmations, 1); assert.equal(h.state.rightsAccepts, repeatRights ? 1 : 0);
    assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1);
    assert.equal(h.commands.some(command => command.method === 'Input.dispatchMouseEvent'), false);
  }
});

test('page DOM accepts only exact unchanged upload-rights text and refuses unrelated agreement dialogs', () => {
  let clicks = 0, text = RIGHTS_TEXT, duplicate = false;
  const agree = { getAttribute: attr => attr === 'aria-label' ? 'I agree' : null, getClientRects: () => [1], click: () => { clicks++; } };
  const dialog = {
    get innerText() { return text; }, getAttribute: () => null, getClientRects: () => [1],
    querySelectorAll: selector => selector === 'button,[role="button"]' ? duplicate ? [agree, agree] : [agree] : [],
  };
  const context = {
    location: { origin: 'https://flow.google.com' }, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: () => null, querySelectorAll: selector => selector === '[role="dialog"],mat-dialog-container' ? [dialog] : [] },
  };
  const run = (op, arg) => vm.runInNewContext('(' + flowDOM.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg || {}) + ')', context);
  assert.equal(run('upload-rights').text, RIGHTS_TEXT);
  text += '\nChanged legal condition';
  assert.throws(() => run('accept-upload-rights', { text: RIGHTS_TEXT }), /UPLOAD_RIGHTS_CHANGED/); assert.equal(clicks, 0);
  text = RIGHTS_TEXT; duplicate = true;
  assert.throws(() => run('accept-upload-rights', { text: RIGHTS_TEXT }), /CONTROL_AMBIGUOUS/); assert.equal(clicks, 0);
  duplicate = false; assert.equal(run('accept-upload-rights', { text: RIGHTS_TEXT }), true); assert.equal(clicks, 1);
  text = 'Unrelated agreement. I agree';
  assert.throws(() => run('upload-rights'), /UPLOAD_RIGHTS_NOT_VERIFIED/);
  assert.throws(() => run('accept-upload-rights', { text }), /UPLOAD_RIGHTS_CHANGED/); assert.equal(clicks, 1);
});

test('submit waits for durable callback, clicks once, binds result and downloads original MP4 before releasing', async t => {
  const h = await harness(t), controller = new AbortController(), progress = [], accountEvents = [];
  let entered = false, finishDurable;
  const running = h.engine.generate(input({ references: [{ kind: 'image', dataUrl: PNG }, { kind: 'image', dataUrl: GIF }] }), {
    signal: controller.signal,
    onAccount: value => accountEvents.push(value), onProgress: value => progress.push(value),
    beforeSubmit: async () => { entered = true; await new Promise(resolve => { finishDurable = resolve; }); h.order.push('durable'); },
  });
  await until(() => entered);
  assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 0);
  assert.equal(h.commands.some(command => command.method === 'Input.dispatchMouseEvent'), false);
  finishDurable();
  const result = await running;
  assert.equal(h.state.submitted, 1); assert.equal(h.state.releases, 1);
  assert.deepEqual(h.order, ['acquire', 'durable', 'submit', 'release']);
  assert.equal(h.ops.filter(op => op.op === 'submit').length, 1);
  assert.equal(h.commands.some(command => command.method === 'Input.dispatchMouseEvent'), false);
  assert.deepEqual(accountEvents, [{ id: 7, email: EMAIL }]);
  assert.ok(progress.includes('Генерация: 23%')); assert.equal(progress.at(-1), 'Готово');
  assert.deepEqual(await fs.readFile(result.media[0].path), MP4);
  assert.equal(result.sceneId, SCENE); assert.equal(result.accountId, 7); assert.equal(result.accountEmail, EMAIL);
  assert.equal(result.projectURL, 'https://flow.google.com/project/project-owned');
  for (const upload of h.uploads) await assert.rejects(fs.access(upload.file), { code: 'ENOENT' });
  assert.equal(h.listeners.size, 0);
});

test('post-submit observation loss releases first lease and recovers same receipt with no second paid action or upload', async t => {
  const jobId = crypto.randomUUID(); let durable = 0, receiptBytes, h;
  h = await harness(t, { recoverAfterObservation: true, resultLost: true, onRecoveryAcquire: () => {
    assert.equal(h.state.releases, 1); assert.equal(h.order.at(-1), 'release');
    assert.equal(h.state.submitted, 1); assert.equal(h.uploads.length, 1);
  } });
  const file = path.join(h.dataDir, 'browser-receipts', jobId + '.json');
  const result = await h.engine.generate(input({ jobId, references: [{ kind: 'image', dataUrl: PNG }] }), { beforeSubmit: async () => { durable++; receiptBytes = await fs.readFile(file); } });
  assert.equal(durable, 1); assert.equal(h.state.submitted, 1); assert.equal(h.uploads.length, 1);
  assert.equal(h.state.acquisitions, 2); assert.equal(h.state.releases, 2); assert.notEqual(h.leases[0], h.leases[1]);
  assert.deepEqual(h.order, ['acquire', 'submit', 'release', 'acquire', 'release']);
  assert.equal(h.ops.filter(op => op.op === 'submit').length, 1); assert.equal(h.ops.filter(op => op.op === 'baseline').length, 1);
  assert.equal(h.commands.filter(command => command.method === 'DOM.setFileInputFiles').length, 1);
  assert.equal(h.commands.filter(command => command.method === 'Input.insertText').length, 1);
  assert.equal(h.ops.filter(op => op.op === 'open-recovery-candidate').length, 1);
  assert.deepEqual(await fs.readFile(file), receiptBytes);
  assert.deepEqual(await fs.readdir(path.dirname(file)), [jobId + '.json']);
  assert.deepEqual(await fs.readFile(result.media[0].path), MP4);
});

test('cancellation or confirmed Flow rejection never automatically reacquires browser or resubmits', async t => {
  for (const type of ['cancel', 'rejection']) {
    const controller = new AbortController();
    const h = await harness(t, { recoverAfterObservation: true, ...(type === 'cancel' ? { onSubmit: () => controller.abort(new Error('Stop accepted job observation')) } : { resultError: 'Google refused this request' }) });
    await assert.rejects(h.engine.generate(input({ jobId: crypto.randomUUID() }), { signal: controller.signal, beforeSubmit: () => {} }), error => type === 'cancel' ? /Stop accepted job observation/.test(error.message) && error.unknownOutcome === true : error.generationTerminal === true && error.unknownOutcome === false);
    assert.equal(h.state.submitted, 1); assert.equal(h.state.acquisitions, 1); assert.equal(h.state.releases, 1);
    assert.equal(h.ops.some(op => op.op === 'recovery-candidates' || op.op === 'open-recovery-candidate'), false);
  }
});

test('job-specific private receipt exists before durable callback and contains exact preparation metadata', async t => {
  const h = await harness(t), jobId = crypto.randomUUID();
  const result = await h.engine.generate(input({ jobId, references: [{ kind: 'image', dataUrl: PNG }] }), { beforeSubmit: async () => {
    assert.equal(h.state.submitted, 0);
    const file = path.join(h.dataDir, 'browser-receipts', jobId + '.json');
    const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(receipt.schema, 1); assert.equal(receipt.jobId, jobId); assert.equal(receipt.nonce, jobId);
    assert.equal(receipt.model, input().model); assert.equal(receipt.prompt, input().prompt);
    assert.equal(receipt.accountId, 7); assert.equal(receipt.accountEmail, EMAIL);
    assert.equal(receipt.projectURL, 'https://flow.google.com/project/project-owned');
    assert.deepEqual(receipt.ingredients, h.uploads.map(upload => upload.identity));
    assert.deepEqual(receipt.baseline, [{ name: 'existing job', poster: 'existing-poster' }]);
    assert.ok(Number.isFinite(Date.parse(receipt.createdAt)));
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).nlink, 1);
  } });
  assert.equal(h.state.submitted, 1); assert.equal(h.state.baselineJob, jobId); assert.equal(h.state.boundJob, jobId);
  assert.equal(result.accountId, 7); assert.equal(h.state.releases, 1);
});

test('existing job receipt is never overwritten and blocks durable callback or website submission', async t => {
  const h = await harness(t), jobId = crypto.randomUUID(), folder = path.join(h.dataDir, 'browser-receipts');
  await fs.mkdir(folder, { mode: 0o700 });
  const file = path.join(folder, jobId + '.json'), existing = 'Existing receipt must stay exact\n';
  await fs.writeFile(file, existing, { flag: 'wx', mode: 0o600 });
  await assert.rejects(h.engine.generate(input({ jobId }), { beforeSubmit: () => assert.fail('Existing receipt must block another durable submission') }), error => error.code === 'BROWSER_RECEIPT_EXISTS' && error.unknownOutcome === false);
  assert.equal(await fs.readFile(file, 'utf8'), existing);
  assert.deepEqual(await fs.readdir(folder), [jobId + '.json']);
  assert.equal(h.state.submitted, 0); assert.equal(h.ops.some(op => op.op === 'submit'), false); assert.equal(h.state.releases, 1);
});

async function savedReceipt(h, overrides = {}) {
  const jobId = crypto.randomUUID(), value = {
    model: input().model, prompt: input().prompt, accountId: 7, accountEmail: EMAIL,
    projectURL: 'https://flow.google.com/project/project-owned',
    ingredients: ['https://flow-content.google/image/original-upload'],
    baseline: [{ name: 'existing job', poster: 'existing-poster' }], createdAt: new Date().toISOString(), ...overrides,
  };
  const receipt = await createReceiptStore(h.dataDir).write(jobId, value);
  h.state.baselineJob = receipt.nonce;
  return { jobId, receipt, file: path.join(h.dataDir, 'browser-receipts', jobId + '.json') };
}

async function submitWithoutObservationRecovery(h, value, options = {}) {
  let prepared;
  try { prepared = await h.engine.prepare(value, options); return await h.engine.submit(prepared, options); }
  finally { if (prepared) await h.engine.release(prepared); }
}

test('recovery reads immutable saved receipt, navigates saved project, and downloads verified result without upload or submission', async t => {
  const h = await harness(t, { recover: true, historyPrompt: input().prompt, ingredients: ['https://flow-content.google/image/original-upload'] });
  const { jobId, receipt, file } = await savedReceipt(h), originalBytes = await fs.readFile(file);
  const progress = [];
  const result = await h.engine.recover(jobId, { expected: { accountId: 7, accountEmail: EMAIL, model: input().model, prompt: input().prompt }, onProgress: value => progress.push(value) });
  assert.equal(result.accountId, 7); assert.equal(result.accountEmail, EMAIL);
  assert.equal(result.projectURL, receipt.projectURL); assert.deepEqual(await fs.readFile(result.media[0].path), MP4);
  assert.deepEqual(h.commands.filter(command => command.method === 'Page.navigate'), [{ method: 'Page.navigate', params: { url: receipt.projectURL } }]);
  assert.equal(h.commands.some(command => /^(Input\.|DOM\.setFileInputFiles|Page\.setInterceptFileChooserDialog)/.test(command.method)), false);
  assert.equal(h.ops.some(op => ['submit', 'baseline', 'asset', 'focus-prompt', 'clear-owned', 'radio', 'model-option', 'duration'].includes(op.op)), false);
  assert.equal(h.ops.some(op => op.op === 'click' && op.arg.name === 'Триггер настроек'), false);
  assert.equal(h.uploads.length, 0); assert.equal(h.state.submitted, 0); assert.equal(h.state.acquisitions, 1); assert.equal(h.state.releases, 1);
  assert.equal(h.state.boundJob, receipt.nonce); assert.ok(progress.length > 0);
  assert.deepEqual(await fs.readFile(file), originalBytes);
});

test('frame receipt recovery uses saved ordered frame identities without reopening upload or frame settings', async t => {
  const frames = ['https://flow-content.google/image/saved-start-crop', 'https://flow-content.google/image/saved-end-crop'];
  const h = await harness(t, { recover: true, historyPrompt: input().prompt, ingredients: frames });
  const { jobId, file } = await savedReceipt(h, { model: 'omni-1.2-flash-i2v-10s-landscape', ingredients: frames });
  const original = await fs.readFile(file), result = await h.engine.recover(jobId);
  assert.deepEqual(await fs.readFile(result.media[0].path), MP4);
  assert.equal(h.state.submitted, 0); assert.equal(h.uploads.length, 0); assert.equal(h.state.releases, 1);
  assert.equal(h.commands.some(command => command.method.startsWith('Input.') || command.method === 'DOM.setFileInputFiles'), false);
  assert.equal(h.ops.some(op => ['submit', 'asset', 'radio', 'duration', 'clear-owned'].includes(op.op)), false);
  assert.deepEqual(await fs.readFile(file), original);
});

test('recovery checks wrong newest candidate then downloads only second exact receipt match without resubmission', async t => {
  const wrong = { name: 'Newest unrelated video', poster: 'https://flow.google.com/asb/wrong-newest' };
  const correct = { name: 'Older requested video', poster: 'https://flow.google.com/asb/correct-result' };
  const h = await harness(t, {
    recover: true, recoveryCandidates: [{ name: 'existing job', poster: 'existing-poster' }, wrong, correct],
    candidateHistory: candidate => ({ text: candidate.poster === correct.poster ? input().prompt : input().prompt+' other ending', prompt: candidate.poster === correct.poster ? input().prompt : input().prompt+' other ending', ingredients: ['https://flow-content.google/image/original-upload'], posters: [candidate.poster] }),
  });
  const { jobId, receipt, file } = await savedReceipt(h), original = await fs.readFile(file);
  const result = await h.engine.recover(jobId);
  assert.deepEqual(h.ops.filter(op => op.op === 'open-recovery-candidate').map(op => op.arg), [wrong, correct]);
  assert.equal(h.commands.filter(command => command.method === 'Page.navigate').length, 2);
  assert.equal(h.commands.filter(command => command.method === 'Page.navigate').every(command => command.params.url === receipt.projectURL), true);
  assert.equal(h.commands.filter(command => command.method === 'Browser.setDownloadBehavior').length, 1);
  assert.equal(h.ops.filter(op => op.op === 'download-option' && op.arg.click).length, 1);
  assert.equal(h.state.currentCandidate.poster, correct.poster); assert.deepEqual(await fs.readFile(result.media[0].path), MP4);
  assert.equal(h.state.submitted, 0); assert.equal(h.uploads.length, 0); assert.equal(h.state.releases, 1);
  assert.equal(h.ops.some(op => ['submit', 'asset', 'baseline', 'clear-owned', 'radio', 'duration'].includes(op.op)), false);
  assert.equal(h.commands.some(command => command.method.startsWith('Input.') || command.method === 'DOM.setFileInputFiles'), false);
  assert.deepEqual(await fs.readFile(file), original);
});

test('recovery skips first candidate whose selected History prompt cannot be read and accepts only the next exact receipt match',async t=>{
  const wrong={name:'Imported source without generation prompt',poster:'https://flow.google.com/asb/no-prompt'},correct={name:'Requested generated video',poster:'https://flow.google.com/asb/exact-generated'};
  const h=await harness(t,{recover:true,recoveryCandidates:[{name:'existing job',poster:'existing-poster'},wrong,correct],operation:(op,arg,state)=>{if(op==='history'&&state.currentCandidate?.poster===wrong.poster)throw failure('RESULT_INPUT_MISMATCH','Не удалось прочитать полный запрос выбранной записи истории.');},candidateHistory:candidate=>({prompt:input().prompt,text:'History controls',ingredients:['https://flow-content.google/image/original-upload'],posters:[candidate.poster]})});
  const {jobId,file}=await savedReceipt(h),receipt=await fs.readFile(file),result=await h.engine.recover(jobId);
  assert.deepEqual(h.ops.filter(op=>op.op==='open-recovery-candidate').map(op=>op.arg),[wrong,correct]);
  assert.equal(h.commands.filter(command=>command.method==='Browser.setDownloadBehavior').length,1);assert.equal(h.ops.filter(op=>op.op==='download-option'&&op.arg.click).length,1);
  assert.equal(h.state.currentCandidate.poster,correct.poster);assert.equal(h.state.submitted,0);assert.equal(h.uploads.length,0);assert.equal(h.ops.some(op=>['submit','baseline','asset','radio','duration','clear-owned'].includes(op.op)),false);
  assert.deepEqual(await fs.readFile(file),receipt);assert.deepEqual(await fs.readFile(result.media[0].path),MP4);assert.equal(h.state.releases,1);
});

test('generation and recovery reject requested prompt as prefix suffix or embedded text in another exact History prompt', async t => {
  const requested = input().prompt;
  for (const actual of [requested + ' with a different ending', 'An unrelated beginning: ' + requested, 'Other beginning ' + requested + ' other ending']) {
    for (const mode of ['generate', 'recover']) {
      const h = await harness(t, { recover: mode === 'recover', historyPrompt: actual, ingredients: mode === 'recover' ? ['https://flow-content.google/image/original-upload'] : [] });
      const saved = mode === 'recover' ? await savedReceipt(h) : null, receiptBytes = saved ? await fs.readFile(saved.file) : null;
      const operation = mode === 'recover' ? h.engine.recover(saved.jobId) : submitWithoutObservationRecovery(h, input(), { beforeSubmit: () => {} });
      await assert.rejects(operation, error => error.code === 'RESULT_INPUT_MISMATCH' && error.unknownOutcome === true, mode + ' accepted another full prompt');
      assert.equal(h.state.submitted, mode === 'recover' ? 0 : 1); assert.equal(h.state.acquisitions, 1); assert.equal(h.state.releases, 1);
      assert.equal(h.commands.some(command => command.method === 'Browser.setDownloadBehavior'), false);
      assert.equal(h.ops.some(op => op.op === 'download-option' || op.op === 'image-download-option'), false);
      if (saved) { assert.equal(h.uploads.length, 0); assert.deepEqual(await fs.readFile(saved.file), receiptBytes); }
    }
  }
});

test('History region text cannot substitute for absent empty or different exact prompt nodes', async t => {
  for (const prompts of [undefined, [], ['Another request']]) {
    const h = await harness(t, { recover: true, historyText: 'Model and controls\n' + input().prompt, historyPrompts: prompts, ingredients: ['https://flow-content.google/image/original-upload'] });
    const { jobId, file } = await savedReceipt(h), receiptBytes = await fs.readFile(file);
    await assert.rejects(h.engine.recover(jobId), error => error.code === 'RESULT_INPUT_MISMATCH' && error.unknownOutcome === true);
    assert.equal(h.state.submitted, 0); assert.equal(h.uploads.length, 0); assert.equal(h.state.releases, 1);
    assert.equal(h.commands.some(command => command.method === 'Browser.setDownloadBehavior'), false); assert.deepEqual(await fs.readFile(file), receiptBytes);
  }
});

test('exact History prompt accepts UI whitespace normalization independently of surrounding region controls', async t => {
  const h = await harness(t, { recover: true, historyText: 'Nano Banana model\nReuse prompt\nDownload', historyPrompts: [' \n' + input().prompt.replace(/\n/g, '\r\n\n') + '\n '], ingredients: ['https://flow-content.google/image/original-upload'] });
  const { jobId } = await savedReceipt(h), result = await h.engine.recover(jobId);
  assert.equal(h.state.submitted, 0); assert.equal(h.uploads.length, 0); assert.equal(h.state.releases, 1);
  assert.deepEqual(await fs.readFile(result.media[0].path), MP4);
});

test('lazy grid binding retries transient generation baseline while manual recovery reports no ready result safely', async t => {
  const h = await harness(t, { bindingDelays: 2, bindingTimeoutMs: 1000 });
  const result = await h.engine.generate(input(), { beforeSubmit: () => {} });
  assert.equal(result.accountId, 7); assert.equal(h.state.bindingReads, 3); assert.equal(h.state.submitted, 1); assert.equal(h.state.releases, 1);
  assert.deepEqual(await fs.readFile(result.media[0].path), MP4);
  const notReady = await harness(t, { bindingDelays: 2, recover: true });
  await assert.rejects(notReady.engine.recover((await savedReceipt(notReady)).jobId), { code: 'RESULT_NOT_READY' });
  assert.equal(notReady.state.submitted, 0); assert.equal(notReady.state.releases, 1);
  assert.equal(notReady.commands.some(command => command.method === 'Browser.setDownloadBehavior'), false);
});

test('generation and recovery wait for two placeholder history renders before validating exact references or downloading', async t => {
  for (const mode of ['generate', 'recover']) {
    const h = await harness(t, { historyDelays: 2, recover: mode === 'recover', historyPrompt: input().prompt, ingredients: mode === 'recover' ? ['https://flow-content.google/image/original-upload'] : [] });
    const result = mode === 'recover' ? await h.engine.recover((await savedReceipt(h)).jobId) : await h.engine.generate(input({ references: [{ kind: 'image', dataUrl: PNG }] }), { beforeSubmit: () => {} });
    assert.equal(h.state.historyReads, 3); assert.equal(h.state.releases, 1); assert.equal(h.state.submitted, mode === 'recover' ? 0 : 1);
    assert.deepEqual(await fs.readFile(result.media[0].path), MP4);
    const allOps = h.ops.map(op => op.op), historyAt = allOps.indexOf('history');
    assert.deepEqual(allOps.slice(historyAt, historyAt + 3), ['history', 'history', 'history']);
    const downloadAt = h.commands.findIndex(command => command.method === 'Browser.setDownloadBehavior');
    assert.ok(downloadAt > 0);
    assert.equal(h.commands.slice(0, downloadAt).filter(command => command.method === 'Runtime.evaluate' && command.params.expression.includes(')("history",')).length, 3);
  }
});

test('binding wait preserves last baseline error on timeout while ambiguity fails immediately', async () => {
  const original = failure('RESULT_BINDING_CHANGED', 'Previous grid still incomplete');
  const page = new FlowPage({}, undefined, { pollMs: 1 }); let attempts = 0;
  page.run = async op => { if (op === 'diagnostic') return { readyState: 'complete' }; assert.equal(op, 'bind-result'); attempts++; throw original; };
  await assert.rejects(page.bind([], input().prompt, crypto.randomUUID(), 5), error => error === original);
  assert.ok(attempts >= 1);
  const ambiguity = failure('RESULT_AMBIGUOUS'); attempts = 0;
  page.run = async op => { assert.equal(op, 'bind-result'); attempts++; throw ambiguity; };
  await assert.rejects(page.bind([], input().prompt, crypto.randomUUID(), 1000), error => error === ambiguity);
  assert.equal(attempts, 1);
});

test('recovery missing receipt and expected account or model mismatch fail before browser acquisition', async t => {
  const missing = await harness(t, { recover: true });
  await assert.rejects(missing.engine.recover(crypto.randomUUID()), { code: 'BROWSER_RECEIPT_MISSING' });
  assert.equal(missing.state.acquisitions, 0); assert.deepEqual(missing.commands, []);
  for (const changed of [
    { accountId: 8 }, { accountEmail: 'other@example.com' }, { model: 'omni-1.2-flash-10s-portrait' }, { prompt: input().prompt + ' changed' },
  ]) {
    const h = await harness(t, { recover: true }), { jobId } = await savedReceipt(h);
    await assert.rejects(h.engine.recover(jobId, { expected: { accountId: 7, accountEmail: EMAIL, model: input().model, prompt: input().prompt, ...changed } }), { code: 'BROWSER_RECEIPT_MISMATCH' });
    assert.equal(h.state.acquisitions, 0); assert.equal(h.state.submitted, 0); assert.deepEqual(h.commands, []);
  }
});

test('recovery refuses changed lease or visible account and releases without submission or download', async t => {
  for (const changed of [{ leaseEmail: 'other@example.com' }, { visibleEmail: 'other@example.com' }]) {
    const h = await harness(t, { recover: true, ...changed }), { jobId } = await savedReceipt(h);
    await assert.rejects(h.engine.recover(jobId), error => error.code === 'ACCOUNT_MISMATCH' && error.unknownOutcome === true);
    assert.equal(h.state.acquisitions, 1); assert.equal(h.state.releases, 1); assert.equal(h.state.submitted, 0);
    assert.equal(h.commands.some(command => command.method === 'Browser.setDownloadBehavior' || command.method.startsWith('Input.')), false);
  }
});

test('recovery wrong ordered history references stays unknown and never downloads or resubmits', async t => {
  const h = await harness(t, { recover: true, historyPrompt: input().prompt, ingredients: ['https://flow-content.google/image/different-upload'] });
  const { jobId, file } = await savedReceipt(h), originalBytes = await fs.readFile(file);
  await assert.rejects(h.engine.recover(jobId), error => error.code === 'RESULT_INPUT_MISMATCH' && error.unknownOutcome === true);
  assert.equal(h.state.acquisitions, 1); assert.equal(h.state.releases, 1); assert.equal(h.state.submitted, 0);
  assert.equal(h.commands.some(command => command.method === 'Browser.setDownloadBehavior' || command.method.startsWith('Input.')), false);
  assert.equal(h.ops.some(op => op.op === 'submit' || op.op === 'asset' || op.op === 'clear-owned'), false);
  assert.deepEqual(await fs.readFile(file), originalBytes);
});

test('failed transaction diagnostics stay private local files and preserve original outcome code', async t => {
  const h = await harness(t, { resultLost: true }), jobId = crypto.randomUUID();
  await assert.rejects(submitWithoutObservationRecovery(h, input({ jobId }), { beforeSubmit: () => {} }), error => error.code === 'RESULT_LOST' && error.unknownOutcome === true);
  const folder = path.join(h.dataDir, 'browser-diagnostics'), file = path.join(folder, jobId + '.json'), screenshot = path.join(folder, jobId + '.png');
  assert.equal((await fs.stat(folder)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600); assert.equal((await fs.stat(screenshot)).mode & 0o777, 0o600);
  const diagnostic = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(diagnostic.code, 'RESULT_LOST'); assert.ok(Number.isFinite(Date.parse(diagnostic.at)));
  assert.deepEqual(diagnostic.state, { url: 'https://flow.google.com/project/project-owned', regions: [{ name: 'History', tag: 'ASIDE', chars: 32 }], buttons: [{ name: 'История', tag: 'BUTTON' }], videos: 1 });
  assert.deepEqual(await fs.readFile(screenshot), Buffer.from(PNG.split(',')[1], 'base64'));
  assert.equal(h.commands.filter(command => command.method === 'Page.captureScreenshot').length, 1);
  assert.equal(h.state.submitted, 1); assert.equal(h.state.releases, 1);
});

test('failed diagnostic DOM or screenshot commands never replace original generation or recovery error', async t => {
  for (const mode of ['generate', 'recover']) for (const diagnostic of [{ diagnosticError: true }, { screenshotError: true }]) {
    const h = await harness(t, { ...diagnostic, resultLost: true, recover: mode === 'recover', historyPrompt: input().prompt });
    const jobId = mode === 'recover' ? (await savedReceipt(h)).jobId : crypto.randomUUID();
    const operation = mode === 'recover' ? h.engine.recover(jobId) : submitWithoutObservationRecovery(h, input({ jobId }), { beforeSubmit: () => {} });
    await assert.rejects(operation, error => {
      assert.equal(error.code, 'RESULT_LOST'); assert.equal(error.unknownOutcome, true);
      assert.equal(error.message.includes('Diagnostic must not replace'), false); assert.equal(error.message.includes('Screenshot must not replace'), false);
      return true;
    });
    assert.equal(h.state.releases, 1); assert.equal(h.state.submitted, mode === 'recover' ? 0 : 1);
    if (diagnostic.diagnosticError) assert.equal(h.commands.some(command => command.method === 'Page.captureScreenshot'), false);
    else assert.equal(h.commands.filter(command => command.method === 'Page.captureScreenshot').length, 1);
  }
});

test('successful generation and recovery create no screenshot or diagnostic files', async t => {
  for (const mode of ['generate', 'recover']) {
    const h = await harness(t, { recover: mode === 'recover', historyPrompt: input().prompt, ingredients: mode === 'recover' ? ['https://flow-content.google/image/original-upload'] : [] });
    if (mode === 'recover') await h.engine.recover((await savedReceipt(h)).jobId);
    else await h.engine.generate(input(), { beforeSubmit: () => {} });
    assert.equal(h.ops.some(op => op.op === 'failure-state'), false);
    assert.equal(h.commands.some(command => command.method === 'Page.captureScreenshot'), false);
    await assert.rejects(fs.access(path.join(h.dataDir, 'browser-diagnostics')), { code: 'ENOENT' });
    assert.equal(h.state.releases, 1);
  }
});

test('prepared requests are one use and reject mutated settings or description before durable submit', async t => {
  for (const mutate of [h => { h.state.prompt += 'changed'; }, h => { h.state.duration = 1; }]) {
    const h = await harness(t), prepared = await h.engine.prepare(input()); mutate(h);
    await assert.rejects(h.engine.submit(prepared, { beforeSubmit: () => assert.fail('Changed request reached durable boundary') }), error => ['PREPARED_INPUT_CHANGED', 'SETTINGS_CHANGED'].includes(error.code) && error.unknownOutcome === false);
    await assert.rejects(h.engine.submit(prepared, { beforeSubmit: () => {} }), { code: 'PREPARATION_REQUIRED' });
    assert.equal(h.state.submitted, 0); await h.engine.release(prepared);
  }
  const h = await harness(t), prepared = await h.engine.prepare(input());
  await h.engine.submit(prepared, { beforeSubmit: () => {} });
  await assert.rejects(h.engine.submit(prepared, { beforeSubmit: () => {} }), { code: 'PREPARATION_REQUIRED' });
  assert.equal(h.state.submitted, 1); await h.engine.release(prepared);
});

test('identity mismatch and draft release profile; invalid second input fails before acquiring or modifying profile', async t => {
  for (const [options, value, code] of [
    [{ leaseEmail: 'other@example.com' }, input(), 'ACCOUNT_MISMATCH'],
    [{ visibleEmail: 'other@example.com' }, input(), 'ACCOUNT_MISMATCH'],
    [{ draft: 'unsaved user work' }, input(), 'BROWSER_DRAFT_PRESENT'],
    [{}, input({ references: [{ kind: 'image', dataUrl: PNG }, { kind: 'image', dataUrl: 'data:image/png;base64,bm90LWFuLWltYWdl' }] }), 'INVALID_REFERENCE'],
  ]) {
    const h = await harness(t, options);
    await assert.rejects(h.engine.generate(value, { beforeSubmit: () => assert.fail('Invalid preparation reached submit') }), { code });
    const expectedLease = code === 'INVALID_REFERENCE' ? 0 : 1;
    assert.equal(h.state.acquisitions, expectedLease); assert.equal(h.state.releases, expectedLease); assert.equal(h.state.submitted, 0);
    for (const upload of h.uploads) await assert.rejects(fs.access(upload.file), { code: 'ENOENT' });
    assert.deepEqual((await fs.readdir(h.dataDir)).filter(name => name.startsWith('browser-inputs-')), []);
  }
});

test('cancellation during file attachment drains lease and removes private input files', async t => {
  const controller = new AbortController(), h = await harness(t, { onFile: () => controller.abort(new Error('Cancel file preparation')) });
  await assert.rejects(h.engine.generate(input({ references: [{ kind: 'image', dataUrl: PNG }] }), { signal: controller.signal, beforeSubmit: () => assert.fail('Cancelled preparation submitted') }), /Cancel file preparation/);
  assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1);
  assert.deepEqual(await fs.readdir(h.dataDir), []);
});

test('file attachment error releases remote object, disables chooser interception, and cleans profile lease', async t => {
  const h = await harness(t, { onFile: () => { throw failure('ATTACHMENT_FAILED'); } });
  await assert.rejects(h.engine.generate(input({ references: [{ kind: 'image', dataUrl: PNG }] }), { beforeSubmit: () => assert.fail('Failed attachment submitted') }), { code: 'ATTACHMENT_FAILED' });
  const attachedAt = h.commands.findIndex(c => c.method === 'DOM.setFileInputFiles');
  assert.deepEqual(h.commands.slice(attachedAt + 1).filter(c => c.method !== 'Runtime.evaluate' && c.method !== 'Page.captureScreenshot').map(c => ({ method: c.method, params: c.params })), [
    { method: 'Runtime.releaseObject', params: { objectId: 'file-input-owned' } },
    { method: 'Page.setInterceptFileChooserDialog', params: { enabled: false } },
    { method: 'Input.insertText', params: { text: '' } },
  ]);
  assert.equal(h.state.intercepting, false); assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1);
  assert.equal(h.state.prompt, ''); assert.deepEqual(h.state.ingredients, []);
  assert.deepEqual((await fs.readdir(h.dataDir)).filter(name => name !== 'browser-diagnostics'), []);
});

test('durable callback failure stops paid click and releases prepared files', async t => {
  const h = await harness(t);
  await assert.rejects(h.engine.generate(input({ references: [{ kind: 'image', dataUrl: PNG }] }), { beforeSubmit: () => { throw failure('PERSIST_FAILED'); } }), error => error.code === 'PERSIST_FAILED' && error.unknownOutcome === false);
  assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1);
  assert.equal(h.state.prompt, ''); assert.deepEqual(h.state.ingredients, []);
  for (const upload of h.uploads) await assert.rejects(fs.access(upload.file), { code: 'ENOENT' });
});

test('pre-submit cleanup preserves preexisting draft and changed foreign prompt or ingredients', async t => {
  const existing = await harness(t, { draft: 'user draft' });
  await assert.rejects(existing.engine.prepare(input()), { code: 'BROWSER_DRAFT_PRESENT' });
  assert.equal(existing.state.prompt, 'user draft');
  assert.equal(existing.ops.some(op => op.op === 'clear-owned'), false);
  assert.equal(existing.commands.some(command => command.method === 'Input.insertText'), false);
  for (const change of [state => { state.prompt = 'other task prompt'; }, state => { state.ingredients.push('https://flow-content.google/image/foreign'); }]) {
    const h = await harness(t), prepared = await h.engine.prepare(input({ references: [{ kind: 'image', dataUrl: PNG }] }));
    change(h.state);
    const expected = { prompt: h.state.prompt, ingredients: [...h.state.ingredients] };
    await assert.rejects(h.engine.submit(prepared, { beforeSubmit: () => assert.fail('Foreign draft submitted') }), { code: 'PREPARED_INPUT_CHANGED' });
    assert.deepEqual({ prompt: h.state.prompt, ingredients: h.state.ingredients }, expected);
    assert.equal(h.commands.some(command => command.method === 'Input.insertText' && command.params.text === ''), false);
    assert.equal(h.state.submitted, 0); await h.engine.release(prepared);
  }
});

test('lost result and post-submit cancellation keep outcome unknown and never retry or fall back', async t => {
  const controller = new AbortController();
  for (const [options, signal, code] of [
    [{ resultLost: true }, undefined, 'RESULT_LOST'],
    [{ bindingChanged: true }, undefined, 'RESULT_BINDING_CHANGED'],
    [{ onSubmit: () => controller.abort(new Error('Cancel after submit')) }, controller.signal, undefined],
    [{ historyPrompt: 'Another request' }, undefined, 'RESULT_INPUT_MISMATCH'],
    [{ historyPoster: 'https://flow.google.com/asb/another-result' }, undefined, 'RESULT_INPUT_MISMATCH'],
  ]) {
    const h = await harness(t, options);
    await assert.rejects(h.engine.generate(input(), { signal, beforeSubmit: () => {} }), error => error.unknownOutcome === true && (!code || error.code === code));
    assert.equal(h.state.submitted, 1); assert.equal(h.state.acquisitions, 1); assert.equal(h.state.releases, 1);
    assert.equal(h.commands.some(c => c.method === 'Browser.setDownloadBehavior'), false);
    assert.equal(h.ops.some(op => op.op === 'clear-owned'), false);
  }
});

test('confirmed Flow rejection is terminal and still submits only once', async t => {
  const h = await harness(t, { resultError: 'Google Flow: unusual activity' });
  await assert.rejects(h.engine.generate(input(), { beforeSubmit: () => {} }), error => error.code === 'FLOW_GENERATION_REJECTED' && error.generationTerminal === true && error.unknownOutcome === false);
  assert.equal(h.state.submitted, 1); assert.equal(h.state.releases, 1); assert.equal(h.state.acquisitions, 1);
});

test('literal UI unusual-activity rejection terminates once without invented Google public code or observation retry', async t => {
  const literal = 'We noticed unusual activity. Please try again later. You have not been charged.';
  const h = await harness(t, { resultError: literal });
  await assert.rejects(h.engine.generate(input({ jobId: crypto.randomUUID() }), { beforeSubmit: () => {} }), error => {
    assert.equal(error.code, 'FLOW_GENERATION_REJECTED'); assert.equal(error.message, literal);
    assert.equal(error.generationTerminal, true); assert.equal(error.unknownOutcome, false); assert.equal(error.accountFailure, false);
    assert.equal(error.message.includes('PUBLIC_ERROR_'), false); return true;
  });
  assert.equal(h.state.submitted, 1); assert.equal(h.state.acquisitions, 1); assert.equal(h.state.releases, 1);
  assert.equal(h.ops.some(op => op.op === 'recovery-candidates' || op.op === 'download-option'), false);
});

test('preparation and submission require same abort signal and never click on mismatch', async t => {
  const h = await harness(t), prepared = await h.engine.prepare(input(), { signal: new AbortController().signal });
  await assert.rejects(h.engine.submit(prepared, { signal: new AbortController().signal, beforeSubmit: () => assert.fail('Mismatched task submitted') }), { code: 'PREPARATION_SIGNAL_CHANGED' });
  assert.equal(h.state.submitted, 0); await h.engine.release(prepared);
});

test('ambiguous or unconfirmed submit RPC keeps outcome unknown and never repeats action', async t => {
  for (const operation of [
    (op) => { if (op === 'submit') throw failure('CONTROL_AMBIGUOUS'); },
    (op) => op === 'submit' ? { clicked: false } : undefined,
  ]) {
    const h = await harness(t, { operation }); let durable = 0;
    await assert.rejects(h.engine.generate(input(), { beforeSubmit: () => { durable++; } }), error => ['CONTROL_AMBIGUOUS', 'SUBMIT_CONTROL_UNAVAILABLE'].includes(error.code) && error.unknownOutcome === true);
    assert.equal(durable, 1); assert.equal(h.state.submitted, 0); assert.equal(h.state.releases, 1);
    assert.equal(h.commands.some(command => command.method === 'Input.dispatchMouseEvent'), false);
    assert.equal(h.ops.filter(op => op.op === 'submit').length, 1);
    assert.equal(h.ops.some(op => op.op === 'clear-owned'), false);
  }
});

async function downloadHarness(t, scenario) {
  const folder = await temporary(t), commands = [], listeners = new Set();
  const emit = (method, params) => { for (const listener of listeners) listener({ method, params }); };
  const begin = overrides => emit('Browser.downloadWillBegin', { guid: GUID, frameId: FRAME, url: 'https://flow-content.google/video/result-owned', ...overrides });
  const progress = (state, guid = GUID) => emit('Browser.downloadProgress', { guid, state });
  const client = {
    async browserSend(method, params) { commands.push({ method, params }); assert.ok(['Browser.setDownloadBehavior', 'Browser.cancelDownload'].includes(method)); return {}; },
    async send(method) { assert.equal(method, 'Page.getFrameTree'); return { frameTree: { frame: { id: FRAME } } }; },
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const page = {
    async click(name) { if (name === '720p Исходный размер') await scenario({ folder, begin, progress, emit }); else assert.equal(name, 'Скачать медиаконтент'); },
    async run(op, arg) { assert.equal(op, 'download-option'); assert.equal(arg.resolution, '720p'); if (arg.click) await this.click('720p Исходный размер'); return true; },
    async until(fn) { for (let i = 0; i < 4; i++) { const result = await fn(); if (result) return result; await tick(); } throw failure('FIXTURE_POLL_TIMEOUT'); },
  };
  return { folder, client, page, commands, listeners };
}

test('download follows only own frame and allowed origin, cancels unrelated downloads, and returns MP4', async t => {
  const foreign = '22345678-1234-4123-8123-123456789abc', evil = '32345678-1234-4123-8123-123456789abc';
  const h = await downloadHarness(t, async ({ folder, begin, progress }) => {
    begin({ guid: foreign, frameId: 'foreign-frame' }); progress('completed', foreign);
    begin({ guid: evil, url: 'https://flow-content.google.evil.example/video/other' }); progress('completed', evil);
    await fs.writeFile(path.join(folder, GUID), MP4); begin(); progress('completed');
  });
  assert.equal(await downloadOriginal(h.client, h.page, h.folder, '720p'), 'result.mp4');
  assert.deepEqual(await fs.readFile(path.join(h.folder, 'result.mp4')), MP4);
  assert.deepEqual(h.commands.filter(c => c.method === 'Browser.cancelDownload').map(c => c.params.guid), [foreign, evil]);
  assert.deepEqual(h.commands[0], { method: 'Browser.setDownloadBehavior', params: { behavior: 'allowAndName', downloadPath: h.folder, eventsEnabled: true } });
  assert.equal(h.listeners.size, 0);
});

test('own-frame exact Flow blob download returns original 4532573-byte MP4 without cancellation', async t => {
  const original = Buffer.alloc(4532573); MP4.copy(original);
  const h = await downloadHarness(t, async ({ folder, begin, progress }) => {
    await fs.writeFile(path.join(folder, GUID), original);
    begin({ url: 'blob:https://flow.google.com/' + GUID }); progress('completed');
  });
  assert.equal(await downloadOriginal(h.client, h.page, h.folder, '720p'), 'result.mp4');
  assert.deepEqual(await fs.readFile(path.join(h.folder, 'result.mp4')), original);
  assert.equal(h.commands.some(command => command.method === 'Browser.cancelDownload'), false);
  assert.equal(h.listeners.size, 0);
});

test('download URL allowlist accepts exact Flow blob and canonical CDN video paths and rejects forged identities', () => {
  assert.equal(allowedDownload('blob:https://flow.google.com/' + GUID), true);
  assert.equal(allowedDownload('https://flow-content.google/video/result_123-abc?signature=fixture'), true);
  for (const value of [
    'blob:https://evil.example/' + GUID,
    'blob:https://flow.google.com.evil.example/' + GUID,
    'blob:http://flow.google.com/' + GUID,
    'blob:https://person:password@flow.google.com/' + GUID,
    'blob:https://flow.google.com/' + GUID + '?secret=1',
    'blob:https://flow.google.com/' + GUID + '#fragment',
    'blob:https://flow.google.com/not-a-uuid',
    'blob:https://flow.google.com/project/' + GUID,
    'blob:https://flow.google.com/' + GUID + '/extra',
    'https://flow-content.google.evil.example/video/result',
    'https://person:password@flow-content.google/video/result',
    'http://flow-content.google/video/result',
    'https://flow-content.google/image/result',
    'https://flow-content.google/video/result/extra',
  ]) assert.equal(allowedDownload(value), false, value);
  assert.equal(allowedDownload('https://flow-content.google/image/generated_result?signature=fixture', 'image'), true);
  assert.equal(allowedDownload('https://flow-content.google/video/generated_result', 'image'), false);
  assert.equal(allowedDownload('https://flow-content.google/image/generated_result', 'video'), false);
});

test('image download selects1K Original size and recognizes PNG JPEG and WebP signatures', async t => {
  for (const [bytes, filename] of [
    [Buffer.from(PNG.split(',')[1], 'base64'), 'result.png'],
    [Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]), 'result.jpg'],
    [Buffer.from('524946460400000057454250', 'hex'), 'result.webp'],
  ]) {
    const h = await downloadHarness(t, async () => {});
    h.page.click = async name => { assert.equal(name, 'Скачать медиаконтент'); };
    h.page.run = async (op, arg) => {
      assert.equal(op, 'image-download-option'); if (!arg.click) return { resolution: '1K' };
      await fs.writeFile(path.join(h.folder, GUID), bytes);
      // Browser events are scoped by lease; this test supplies direct image download events.
      for (const listener of h.listeners) {
        listener({ method: 'Browser.downloadWillBegin', params: { guid: GUID, frameId: FRAME, url: 'https://flow-content.google/image/generated_result' } });
        listener({ method: 'Browser.downloadProgress', params: { guid: GUID, state: 'completed' } });
      }
      return true;
    };
    assert.equal(await downloadOriginal(h.client, h.page, h.folder, 'standard', undefined, 'image'), filename);
    assert.deepEqual(await fs.readFile(path.join(h.folder, filename)), bytes);
    assert.equal(h.commands.some(command => command.method === 'Browser.cancelDownload'), false);
  }
});

test('loaded image recovery returns exact image point without DOM click and trusted double-click carries buttons and force', async () => {
  let clicks = 0;
  const poster = 'https://flow.google.com/asb/image-point';
  const image = { complete: false, naturalWidth: 0, getAttribute: attr => attr === 'src' ? poster : null, getClientRects: () => [1], getBoundingClientRect: () => ({ left: 20, top: 30, width: 200, height: 100 }), click: () => { clicks++; } };
  const group = { getAttribute: attr => attr === 'aria-label' ? 'Generated image' : null, getClientRects: () => [1], scrollIntoView:()=>{}, querySelector: selector => selector === 'img' || selector === 'flow-image-tile img' ? image : selector === 'flow-image-tile' ? {} : null };
  const context = { location: { origin: 'https://flow.google.com' }, getComputedStyle: () => ({ visibility: 'visible' }), document: { elementFromPoint: () => image, querySelector: () => null, querySelectorAll: selector => ['[role="group"]','flow-grid-tile-container[role="group"]'].includes(selector) ? [group] : [] } };
  const run = (op, arg) => vm.runInNewContext('(' + flowDOM.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg || {}) + ')', context);
  assert.equal(run('recovery-candidates', { kind: 'image' }).length, 0);
  image.complete = true; image.naturalWidth = 1024;
  assert.equal(run('recovery-candidates', { kind: 'image' }).length, 1);
  const opened = run('open-recovery-candidate', { name: 'Generated image', poster, kind: 'image' });
  assert.equal(JSON.stringify(opened), JSON.stringify({ openPoint: { x: 120, y: 80 } })); assert.equal(clicks, 0);
  const commands = [], page = new FlowPage({ async send(method, params) { commands.push({ method, params }); return {}; } }, new AbortController().signal);
  await page.trustedClick({ x: 120, y: 80 }, true);
  assert.deepEqual(commands, [
    { method: 'Page.setWebLifecycleState', params: { state: 'active' } },
    { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', button: 'none', buttons: 0, modifiers: 0, clickCount: 0, x: 120, y: 80 } },
    ...[1, 2].flatMap(clickCount => [
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', button: 'left', buttons: 1, force: 0.5, modifiers: 0, clickCount, x: 120, y: 80 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', button: 'left', buttons: 0, modifiers: 0, clickCount, x: 120, y: 80 } },
    ]),
  ]);
  assert.equal(clicks, 0);
});

test('recovery enumerates loaded offscreen semantic media cards and scrolls only the exact candidate before opening',()=>{
  let top=1400,scrolled=0,clicked=0,foreignClicks=0;const poster='https://flow.google.com/asb/offscreen-owned',video={getAttribute:()=>null,getClientRects:()=>[1],getBoundingClientRect:()=>({left:20,top,width:180,height:300,bottom:top+300,right:200}),click:()=>clicked++,dispatchEvent:()=>{}};
  const image={getAttribute:name=>name==='src'?poster:null},group={getAttribute:name=>name==='aria-label'?'Offscreen requested result':null,getClientRects:()=>[1],getBoundingClientRect:()=>video.getBoundingClientRect(),scrollIntoView:options=>{assert.equal(options.block,'center');scrolled++;top=100;},querySelector:selector=>selector==='img'?image:selector.includes('flow-video-tile')?video:null};
  const foreign={...group,getAttribute:name=>name==='aria-label'?'Foreign arbitrary group':null,scrollIntoView:()=>foreignClicks++,querySelector:()=>video};
  const context={innerWidth:1280,innerHeight:900,location:{origin:'https://flow.google.com'},MouseEvent:class{constructor(type,values){this.type=type;Object.assign(this,values);}},getComputedStyle:()=>({visibility:'visible'}),document:{querySelector:()=>null,querySelectorAll:selector=>selector==='flow-grid-tile-container[role="group"]'?[group]:selector==='[role="group"]'?[group,foreign]:[]}};
  const run=(op,arg)=>vm.runInNewContext('('+flowDOM.toString()+')('+JSON.stringify(op)+','+JSON.stringify(arg||{})+')',context);
  assert.deepEqual(JSON.parse(JSON.stringify(run('recovery-candidates'))),[{name:'Offscreen requested result',poster}]);assert.equal(scrolled,0);
  assert.equal(run('open-recovery-candidate',{name:'Offscreen requested result',poster}),true);assert.equal(scrolled,1);assert.equal(clicked,1);assert.equal(foreignClicks,0);
  assert.throws(()=>run('open-recovery-candidate',{name:'Foreign arbitrary group',poster}),/RESULT_AMBIGUOUS/);assert.equal(foreignClicks,0);
});

test('upload trusted control waits for animation geometry then presses current verified center once', async () => {
  const commands = [], first = { x: 1026, y: 80, left: 967, top: 71, width: 118, height: 19 }, stable = { x: 1043, y: 86, left: 971, top: 74, width: 144, height: 24 };
  const boxes = [first, stable, stable, stable]; let reads = 0;
  const page = new FlowPage({ async send(method, params) { commands.push({ method, params, reads }); return {}; } }, new AbortController().signal, { pollMs: 1 });
  page.run = async (op, arg) => { assert.equal(op, 'control-box'); assert.deepEqual(arg, { name: 'Загрузить', role: 'button' }); return boxes[reads++]; };
  await page.trustedControlClick('Загрузить');
  assert.equal(reads, 4);
  const mouse = commands.filter(command => command.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(mouse.map(command => command.params.type), ['mouseMoved', 'mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.deepEqual(mouse.filter(command => command.params.type === 'mousePressed').map(command => ({ x: command.params.x, y: command.params.y, reads: command.reads })), [{ x: stable.x, y: stable.y, reads: 4 }]);
  assert.equal(mouse.some(command => command.params.type === 'mousePressed' && command.params.x === first.x), false);
  assert.deepEqual(mouse.at(-2).params, { type: 'mousePressed', button: 'left', buttons: 1, force: 0.5, modifiers: 0, clickCount: 1, x: stable.x, y: stable.y });
});

test('temporary overlay after upload mouse move retries until two unobscured stable reads then presses once', async () => {
  const commands = [], overlay = failure('CONTROL_OBSCURED'); let reads = 0;
  const page = new FlowPage({ async send(method, params) { commands.push({ method, params }); return {}; } }, new AbortController().signal, { pollMs: 1 });
  page.run = async op => { assert.equal(op, 'control-box'); if (++reads === 2) throw overlay; return { x: 100, y: 100, left: 50, top: 80, width: 100, height: 40 }; };
  await page.trustedControlClick('Загрузить');
  assert.equal(reads, 4); assert.deepEqual(commands.filter(command => command.method === 'Input.dispatchMouseEvent').map(command => command.params.type), ['mouseMoved', 'mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('persistent obscured upload times out safely without any press and unrelated errors stop immediately', async () => {
  const commands = [], page = new FlowPage({ async send(method, params) { commands.push({ method, params }); return {}; } }, new AbortController().signal, { pollMs: 1 });
  let reads = 0;
  page.run = async op => { if (op === 'diagnostic') return {}; assert.equal(op, 'control-box'); reads++; throw failure('CONTROL_OBSCURED'); };
  await assert.rejects(page.trustedControlClick('Загрузить','button',5), { code: 'FLOW_UI_TIMEOUT' });
  assert.ok(reads >= 1); assert.equal(commands.some(command => command.method === 'Input.dispatchMouseEvent'), false);
  for (const code of ['CONTROL_AMBIGUOUS', 'CDP_CLOSED']) {
    let attempts = 0; const original = failure(code); page.run = async () => { attempts++; throw original; };
    await assert.rejects(page.trustedControlClick('Загрузить','button',100), error => error === original); assert.equal(attempts, 1);
  }
});

test('foreign-frame or forged blob download is canceled before accepting valid own-frame blob', async t => {
  const foreign = '22345678-1234-4123-8123-123456789abc', forged = '32345678-1234-4123-8123-123456789abc';
  const h = await downloadHarness(t, async ({ folder, begin, progress }) => {
    begin({ guid: foreign, frameId: 'foreign', url: 'blob:https://flow.google.com/' + foreign }); progress('completed', foreign);
    begin({ guid: forged, url: 'blob:https://flow.google.com.evil.example/' + forged }); progress('completed', forged);
    await fs.writeFile(path.join(folder, GUID), MP4); begin({ url: 'blob:https://flow.google.com/' + GUID }); progress('completed');
  });
  assert.equal(await downloadOriginal(h.client, h.page, h.folder, '720p'), 'result.mp4');
  assert.deepEqual(h.commands.filter(command => command.method === 'Browser.cancelDownload').map(command => command.params.guid), [foreign, forged]);
});

test('download option selects actual newline English original-size button and rejects upscaled or duplicate choices', () => {
  const clicks = [];
  const button = (name, type) => ({ innerText: name, getAttribute: () => null, getClientRects: () => [1], click: () => clicks.push(type) });
  const original = button('720p\nOriginal size', 'original'), upscaled = button('1080p\nUpscaled', 'upscaled'), wrongResolution = button('360p\nOriginal size', '360p');
  let buttons = [upscaled, wrongResolution, original];
  const context = {
    location: { origin: 'https://flow.google.com' }, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: () => null, querySelectorAll: selector => selector === 'button,[role="button"]' ? buttons : [] },
  };
  const run = arg => vm.runInNewContext('(' + flowDOM.toString() + ')("download-option",' + JSON.stringify(arg) + ')', context);
  assert.equal(run({ resolution: '720p' }), true); assert.deepEqual(clicks, []);
  assert.equal(run({ resolution: '720p', click: true }), true); assert.deepEqual(clicks, ['original']);
  buttons = [upscaled, wrongResolution];
  assert.equal(run({ resolution: '720p' }), false); assert.throws(() => run({ resolution: '720p', click: true }), /CONTROL_NOT_FOUND/);
  buttons = [original, button('720p Original size', 'duplicate')];
  assert.throws(() => run({ resolution: '720p', click: true }), /CONTROL_AMBIGUOUS/);
  assert.deepEqual(clicks, ['original']);
});

test('download rejects ambiguous, canceled, invalid GUID, bad MP4 and symlink outputs', async t => {
  const cases = [
    ['DOWNLOAD_AMBIGUOUS', async ({ begin }) => { begin(); begin({ guid: '22345678-1234-4123-8123-123456789abc' }); }],
    ['DOWNLOAD_FAILED', async ({ begin, progress }) => { begin(); progress('canceled'); }],
    ['DOWNLOAD_INVALID', async ({ begin, progress }) => { begin({ guid: '../outside' }); progress('completed', '../outside'); }],
    ['DOWNLOAD_INVALID', async ({ folder, begin, progress }) => { await fs.writeFile(path.join(folder, GUID), Buffer.from('not-an-mp4-document')); begin(); progress('completed'); }],
    ['DOWNLOAD_INVALID', async ({ folder, begin, progress }) => { const original = path.join(folder, 'original.mp4'); await fs.writeFile(original, MP4); await fs.symlink(original, path.join(folder, GUID)); begin(); progress('completed'); }],
  ];
  for (const [code, scenario] of cases) {
    const h = await downloadHarness(t, scenario);
    await assert.rejects(downloadOriginal(h.client, h.page, h.folder, '720p'), { code });
    assert.equal(h.listeners.size, 0);
    if (['DOWNLOAD_AMBIGUOUS', 'DOWNLOAD_FAILED'].includes(code)) assert.ok(h.commands.some(c => c.method === 'Browser.cancelDownload' && c.params.guid === GUID));
    await assert.rejects(fs.access(path.join(h.folder, 'result.mp4')), { code: 'ENOENT' });
  }
});

test('page DOM clicks website submit once only after exact inputs and unobscured enabled button verify', () => {
  let clicks = 0;
  const element = (label, extra = {}) => ({ innerText: label, textContent: label, getAttribute: name => name === 'aria-label' ? label : null, getClientRects: () => [1], getBoundingClientRect: () => ({ left: 50, top: 80, width: 100, height: 40 }), contains: () => false, querySelectorAll: () => [], click: () => { clicks++; }, ...extra });
  const image = { currentSrc: 'https://flow-content.google/image/ref-one?signature=fixture' };
  const ingredient = element('Ингредиент', { querySelectorAll: () => [image] }), generate = element('Начать генерацию'), prompt = element('Что вы хотите создать?', { innerText: input().prompt });
  const context = {
    location: { origin: 'https://flow.google.com' }, URL, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { elementFromPoint: () => generate, querySelector: () => null, querySelectorAll: selector => selector === 'button,[role="button"]' ? [ingredient, generate] : selector === '[role="textbox"],textarea,input[type="text"]' ? [prompt] : [] },
  };
  const run = args => vm.runInNewContext('(' + flowDOM.toString() + ')("submit",' + JSON.stringify(args) + ')', context);
  assert.throws(() => run({ prompt: 'changed', ingredients: ['https://flow-content.google/image/ref-one'] }), /PREPARED_INPUT_CHANGED/);
  assert.throws(() => run({ prompt: input().prompt, ingredients: [] }), /PREPARED_INPUT_CHANGED/);
  assert.equal(clicks, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(run({prompt:input().prompt,ingredients:['https://flow-content.google/image/ref-one'],trusted:true}))),{x:100,y:100});
  assert.equal(clicks,0,'Trusted submission validates and returns a point without a DOM click');
  assert.throws(()=>run({prompt:'changed',ingredients:['https://flow-content.google/image/ref-one'],trusted:true}),/PREPARED_INPUT_CHANGED/);assert.equal(clicks,0);
  assert.equal(JSON.stringify(run({ prompt: input().prompt, ingredients: ['https://flow-content.google/image/ref-one'] })), JSON.stringify({ clicked: true })); assert.equal(clicks, 1);
  context.document.elementFromPoint = () => ({});
  assert.throws(() => run({ prompt: input().prompt, ingredients: ['https://flow-content.google/image/ref-one'] }), /CONTROL_OBSCURED/);
  context.document.elementFromPoint = () => generate;
  generate.disabled = true;
  assert.throws(() => run({ prompt: input().prompt, ingredients: ['https://flow-content.google/image/ref-one'] }), /CONTROL_DISABLED/);
  generate.disabled = false;
  image.currentSrc = 'https://flow-content.google.evil.example/image/ref-one';
  assert.throws(() => run({ prompt: input().prompt, ingredients: ['https://flow-content.google/image/ref-one'] }), /INGREDIENT_NOT_VERIFIED/);
  assert.equal(clicks, 1);
});

test('paragraph normalization accepts DOM newline padding while preserving letters, spaces, tabs and actual prompt content', async () => {
  const expected = 'Первый абзац "ёж"\n\nSecond paragraph: café\n\nТретий\t  абзац.';
  const actual = 'Первый абзац "ёж"\r\n\r\n\r\nSecond paragraph: café\r\n\r\n\r\nТретий\t  абзац.';
  let rendered = actual, clicks = 0, writes = 0, focused = false;
  const prompt = {
    getAttribute: attr => attr === 'aria-label' ? 'What do you want to create?' : null,
    getClientRects: () => [1], focus: () => { focused = true; },
  };
  Object.defineProperty(prompt, 'innerText', { get: () => rendered, set: () => { writes++; assert.fail('Verification must not rewrite prompt text'); } });
  const generate = {
    getAttribute: attr => attr === 'aria-label' ? 'Start generation' : null, getClientRects: () => [1],
    getBoundingClientRect: () => ({ left: 20, top: 20, width: 100, height: 40 }), click: () => { clicks++; },
  };
  const context = {
    location: { origin: 'https://flow.google.com' }, URL, getComputedStyle: () => ({ visibility: 'visible' }),
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    document: {
      createRange: () => ({ selectNodeContents() {} }), elementFromPoint: () => generate, querySelector: () => null,
      querySelectorAll: selector => selector === 'button,[role="button"]' ? [generate] : selector === '[role="textbox"],textarea,input[type="text"]' ? [prompt] : [],
    },
  };
  const run = (op, arg) => vm.runInNewContext('(' + flowDOM.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg || {}) + ')', context);
  assert.equal(JSON.stringify(run('submit', { prompt: expected, ingredients: [] })), JSON.stringify({ clicked: true }));
  assert.equal(run('clear-owned', { prompt: expected, ingredients: [] }), true); assert.equal(focused, false);
  assert.equal(rendered, actual); assert.equal(writes, 0); assert.equal(clicks, 1);
  for (const changed of [
    expected.replace('café', 'cafe'), expected.replace('Третий', 'Другой'),
    expected.replace('\t  ', '   '), expected.replace('  абзац.', ' абзац.'),
    expected.replace('\n\nSecond', ' Second'), expected + ' ', expected + '\n',
  ]) {
    assert.throws(() => run('submit', { prompt: changed, ingredients: [] }), /PREPARED_INPUT_CHANGED/);
    assert.equal(run('clear-owned', { prompt: changed, ingredients: [] }), false);
    assert.equal(rendered, actual);
  }
  const diagnostics = run('prompt-state', { expected });
  assert.equal(diagnostics.paragraphEqual, true); assert.equal(diagnostics.lineBreakEqual, false);
  assert.equal(diagnostics.actualLength, actual.length); assert.equal(diagnostics.expectedLength, expected.length);
  assert.equal(JSON.stringify(diagnostics).includes('café'), false);
  assert.equal(JSON.stringify(diagnostics).includes('абзац'), false);
  assert.equal(writes, 0); assert.equal(clicks, 1);
  const sent = [];
  const page = new FlowPage({ async send(method, params) { sent.push({ method, params }); return {}; } }, undefined, { pollMs: 1 });
  page.run = async op => op === 'focus-prompt' ? true : op === 'composer' ? { prompt: actual } : assert.fail(`Unexpected prompt verification op ${op}`);
  await page.fillPrompt(expected);
  assert.deepEqual(sent, [{ method: 'Input.insertText', params: { text: expected } }]);
});

test('empty contenteditable newline placeholder reads as empty without mutating editor or trimming real whitespace', () => {
  let rendered = '\n', mutations = 0;
  const editor = { getAttribute: attr => attr === 'aria-label' ? 'What do you want to create?' : null, getClientRects: () => [1] };
  Object.defineProperty(editor, 'innerText', { get: () => rendered, set: () => { mutations++; } });
  const start = { getAttribute: attr => attr === 'aria-label' ? 'Start generation' : null, getClientRects: () => [1] };
  const context = {
    location: { origin: 'https://flow.google.com' }, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: () => null, querySelectorAll: selector => selector === '[role="textbox"],textarea,input[type="text"]' ? [editor] : selector === 'button,[role="button"]' ? [start] : [] },
  };
  const run = (op, arg) => vm.runInNewContext('(' + flowDOM.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg || {}) + ')', context);
  for (const placeholder of ['\n', '\r\n\n', '']) {
    rendered = placeholder; assert.equal(run('composer').prompt, '');
    assert.equal(run('clear-owned', { prompt: '', ingredients: [] }), true); assert.equal(rendered, placeholder);
  }
  for (const actual of [' ', '\t', '\n \n', 'text\n']) { rendered = actual; assert.equal(run('composer').prompt, actual); }
  assert.equal(mutations, 0);
});

test('page DOM returns only unique file input and rejects verification or duplicate submit controls', () => {
  let clicks = 0, inputs = [{}], buttons = [], verification = false;
  const generate = { innerText: 'Начать генерацию', getAttribute: name => name === 'aria-label' ? 'Начать генерацию' : null, getClientRects: () => [1], click: () => { clicks++; } };
  const prompt = { innerText: 'exact', getAttribute: name => name === 'aria-label' ? 'Что вы хотите создать?' : null, getClientRects: () => [1] };
  const context = {
    location: { origin: 'https://flow.google.com' }, URL, getComputedStyle: () => ({ visibility: 'visible' }),
    document: {
      querySelector: () => verification ? {} : null,
      querySelectorAll: selector => selector === 'input[type="file"]' ? inputs : selector === 'button,[role="button"]' ? buttons : selector === '[role="textbox"],textarea,input[type="text"]' ? [prompt] : [],
    },
  };
  const run = (op, arg) => vm.runInNewContext('(' + flowDOM.toString() + ')(' + JSON.stringify(op) + ',' + JSON.stringify(arg || {}) + ')', context);
  assert.equal(run('file-input'), inputs[0]); inputs = [{}, {}];
  assert.throws(() => run('file-input'), /FILE_INPUT_AMBIGUOUS/);
  buttons = [generate, generate];
  assert.throws(() => run('submit', { prompt: 'exact', ingredients: [] }), /CONTROL_AMBIGUOUS/);
  verification = true; buttons = [generate];
  assert.throws(() => run('submit', { prompt: 'exact', ingredients: [] }), /FLOW_VERIFICATION_REQUIRED/);
  assert.equal(clicks, 0);
});

test('completed result stays successful when user prompt contains words used in failure messages', () => {
  const tile = {
    innerText: 'A failed robot fixes ошибка сети during unusual activity',
    getAttribute: name => name === 'data-flow-studio-job' ? 'job-owned' : null,
    querySelector: selector => selector.includes('img[alt="Значок сгенерированного видео"]') ? {} : null,
    querySelectorAll: () => [],
  };
  const context = {
    location: { origin: 'https://flow.google.com' }, URL, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: () => null, querySelectorAll: selector => selector === '[data-flow-studio-job]' ? [tile] : [] },
  };
  const result = vm.runInNewContext('(' + flowDOM.toString() + ')("result",{"job":"job-owned"})', context);
  assert.equal(result.complete, true);
  assert.equal(result.error, null);
});

test('pending tile needs dedicated warning before reporting terminal error and excludes original prompt', () => {
  const originalPrompt = 'A failed robot fixes ошибка сети';
  let warnings = [];
  const tile = {
    innerText: originalPrompt + '\n23%',
    getAttribute: name => name === 'data-flow-studio-job' ? 'job-owned' : null,
    querySelector: () => null,
    querySelectorAll: () => warnings,
  };
  const context = {
    location: { origin: 'https://flow.google.com' }, URL, getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: () => null, querySelectorAll: selector => selector === '[data-flow-studio-job]' ? [tile] : [] },
  };
  const run = () => vm.runInNewContext('(' + flowDOM.toString() + ')("result",' + JSON.stringify({ job: 'job-owned', prompt: originalPrompt }) + ')', context);
  assert.equal(run().complete, false); assert.equal(run().error, null); assert.equal(run().progress, 23);
  warnings = [{ innerText: 'warning', getAttribute: () => null }]; tile.innerText = originalPrompt + '\nPUBLIC_ERROR_UNUSUAL_ACTIVITY';
  assert.equal(run().error.trim(), 'PUBLIC_ERROR_UNUSUAL_ACTIVITY');
});

test('image decoder and resource canonicalization reject mismatched bytes, credentials, and unrelated origins', () => {
  const decoded = decodeImage(PNG); assert.equal(decoded.ext, 'png'); assert.equal(decoded.sha256.length, 64);
  assert.throws(() => decodeImage('data:image/png;base64,' + Buffer.from('wrong magic').toString('base64')), { code: 'INVALID_REFERENCE' });
  assert.equal(mediaIdentity('https://flow-content.google/image/asset_1?signature=test#ignored'), 'https://flow-content.google/image/asset_1');
  for (const value of ['https://name:password@flow-content.google/image/asset', 'https://flow-content.google.evil.example/image/asset', 'http://flow-content.google/image/asset', 'https://flow-content.google/image/../asset']) assert.equal(mediaIdentity(value), null);
});

test('scene account verification reads only unique observed Google account avatar label and avoids opening unrelated drawer', async () => {
 const avatar=name=>({getAttribute:key=>key==='aria-label'?name:null,getClientRects:()=>[1],closest:()=>null});
 let buttons=[avatar('Google Account: Rafi  \n(rafijrab@gmail.com), Google membership')];
 const context={location:{origin:'https://flow.google.com',pathname:'/project/owned/edit/'+SCENE,href:'https://flow.google.com/project/owned/edit/'+SCENE},document:{querySelector:()=>null,querySelectorAll:selector=>selector==='button,[role="button"]'?buttons:[]},getComputedStyle:()=>({visibility:'visible'})};
 const read=()=>vm.runInNewContext('('+flowDOM.toString()+')("editor-account")',context);
 assert.equal(read(),'rafijrab@gmail.com');
 buttons=[avatar('Some content rafijrab@gmail.com')];assert.equal(read(),null);
 buttons=[avatar('Google Account: Rafi (rafijrab@gmail.com), Google membership'),avatar('Google Account: Other (other@example.test), Google membership')];assert.throws(read,/ACCOUNT_MISMATCH/);
 buttons=[avatar('Google Account: Rafi (rafijrab@gmail.com), Google membership')];context.location.pathname='/project/owned';assert.equal(read(),null);
 let reads=0;const page=new FlowPage({send:async()=>{throw Error('No raw browser commands expected');}});
 page.run=async op=>{reads++;assert.equal(op,'editor-account');return 'rafijrab@gmail.com';};
 await page.verifyAccount('RAFIJRAB@GMAIL.COM');assert.equal(reads,1);
 await assert.rejects(page.verifyAccount('other@example.test'),{code:'ACCOUNT_MISMATCH'});
});

test('avatar-free Edit verifies fresh home account in managed second target without changing editor and rejects mismatch or editor navigation',async()=>{
 const sceneURL='https://flow.google.com/project/'+SOURCE_PROJECT+'/edit/'+SCENE;
 for(const scenario of ['fresh','mismatch','editor-changed','unavailable']){
  const controller=new AbortController(),leaseController=new AbortController(),homeCalls=[],editorOps=[];
  let currentURL=sceneURL,visibleEmail=EMAIL,opened=false,verifications=0;
  const verificationClient={async send(method,params){
   homeCalls.push({method,params});
   if(method==='Emulation.setDeviceMetricsOverride')return {};
   assert.equal(method,'Runtime.evaluate');
   if(params.expression==='location.href')return {result:{value:'https://flow.google.com/'}};
   const [op,arg]=JSON.parse('['+params.expression.slice(evaluatePrefix.length+1,-1)+']');
   let value;
   if(op==='editor-account')value=null;
   else if(op==='state')value={url:'https://flow.google.com/'};
   else if(op==='exists'){assert.equal(arg.name,'Сведения об аккаунте');value=true;}
   else if(op==='click'){assert(['Сведения об аккаунте','Закрыть панель аккаунта'].includes(arg.name));opened=arg.name==='Сведения об аккаунте';value=true;}
   else if(op==='account')value=opened?visibleEmail:null;
   else assert.fail('Verification target must only inspect account drawer: '+op);
   return {result:{value}};
  }};
  const client={send:()=>assert.fail('Editor must not navigate or mutate prompt during account verification'),...(scenario==='unavailable'?{}:{async withVerificationPage(callback){verifications++;if(scenario==='mismatch')visibleEmail='other@example.test';const value=await callback(verificationClient);if(scenario==='editor-changed')currentURL=sceneURL.replace(SCENE,GUID);return value;}})};
  const page=new FlowPage(client,controller.signal,{pollMs:1,leaseSignal:leaseController.signal});
  page.run=async op=>{editorOps.push(op);if(op==='editor-account')return null;if(op==='state')return {url:currentURL};assert.fail('Editor prompt must remain untouched: '+op);};
  page.until=()=>assert.fail('Avatar-free Edit must use managed account verification target');
  if(scenario==='fresh'){
   await page.verifyAccount(EMAIL.toUpperCase());assert.equal(opened,false);assert.equal(verifications,1);
   visibleEmail='other@example.test';await assert.rejects(page.verifyAccount(EMAIL),{code:'ACCOUNT_MISMATCH'});assert.equal(verifications,2,'Previous account proof cannot replace fresh check');
  }else await assert.rejects(page.verifyAccount(EMAIL),{code:scenario==='unavailable'?'ACCOUNT_VERIFICATION_UNAVAILABLE':'ACCOUNT_MISMATCH'});
  assert.equal(editorOps.every(op=>['editor-account','state'].includes(op)),true);
  if(scenario==='unavailable')assert.equal(homeCalls.length,0);
 }
});

test('Agent Edit writes its immutable proposal before one approval and verifies source-bound output without a direct submit',async t=>{
 const folder=await temporary(t),source=path.join(folder,'source.mp4');await fs.writeFile(source,MP4);
 const sourcePoster='https://flow-content.google/image/'+GUID,sourcePreview='https://storage.googleapis.com/ai-sandbox-videofx/image/'+GUID,sceneURL='https://flow.google.com/project/'+SOURCE_PROJECT+'/edit/'+SCENE;
 let h,approvals=0,durable=0;const stages=[];
 const agentEdit={
  async startAgentSession(){assert.equal(h.state.prompt,'');assert.equal(h.state.url,'https://flow.google.com/project/'+SOURCE_PROJECT);stages.push('session');},
  async configureAgentEdit(page,plan){assert.equal(plan.model,'omni-1.2-flash-edit-landscape');stages.push('settings');},
  async attachAgentAsset(page,value){assert.equal(value.kind,'video');assert.equal(value.expectedResourceId,GUID);assert.match(value.name,/^[a-f0-9-]{36}$/);stages.push('source');},
  async verifyAgentEditSettings(){stages.push('verify-settings');},
  async prepareAgentProposal(page,expected,{verifySettings}){await verifySettings();assert.equal(expected.prompt,input().prompt);assert.equal(expected.sourceImageResourceId,GUID);return {source:{origin:'https://storage.googleapis.com',path:'/ai-sandbox-videofx/image/'+GUID},quoteCredits:9,permissionTitle:'Would you like me to kick off this 1 video generation, costing 9 credits?'};},
  async approveAgentEdit(page,binding,{beforeSubmit,verifySettings}){await verifySettings();await beforeSubmit();assert.equal(durable,1);const receipt=await createReceiptStore(h.dataDir).read(h.jobId);assert.deepEqual(receipt.agentProposal,{quoteCredits:9,videoCount:1,sourcePreview,approvalText:binding.permissionTitle});approvals++;h.state.agentApproved=true;},
  async readAgentEditOutput(){h.state.url=sceneURL;h.state.opened=true;return {openPoint:{x:100,y:100}};},
 };
 h=await harness(t,{edit:true,recover:true,agentEdit,sourcePoster,historyPoster:'https://flow-content.google/image/result-owned',inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720}),operation(op,arg,state){if(op==='agent-scene-result'){assert.equal(state.agentApproved,true);state.opened=true;assert.equal(arg.sourceScene.url,sceneURL);assert.equal(arg.sourcePreview,sourcePreview);return {ready:true,prompt:input().prompt,ingredients:[],sourceVideos:[],sourcePreviews:[sourcePreview],ingredientsReady:true,posters:['https://flow-content.google/image/result-owned'],url:sceneURL};}}});
 h.jobId=crypto.randomUUID();const result=await h.engine.generate(input({jobId:h.jobId,model:'omni-1.2-flash-edit-landscape',references:[{kind:'video',path:source}]}),{beforeSubmit(){durable++;}});
 assert.equal(approvals,1);assert.equal(durable,1);assert.deepEqual(stages.slice(0,3),['session','settings','source']);assert.equal(h.ops.some(op=>op.op==='submit'),false);assert.equal(result.media[0].kind,'video');assert.equal(h.state.releases,1);assert.equal(h.commands.filter(c=>c.method==='Page.reload'&&c.params.ignoreCache===true).length,1);
 const binding=h.ops.find(op=>op.op==='history-download').arg.binding;assert.deepEqual(binding.sourcePreviews,[sourcePreview]);assert.equal(binding.agentSource.sourceScene.url,sceneURL);
});

test('Agent Edit durable failure never approves, and interruption after approval remains unknown without replay',async t=>{
 for(const stage of ['persist','after-approval']){
  const folder=await temporary(t),source=path.join(folder,'source.mp4');await fs.writeFile(source,MP4);let approvals=0,plans=0,h;
  const agentEdit={async startAgentSession(){},async configureAgentEdit(){},async attachAgentAsset(){},async verifyAgentEditSettings(){},async prepareAgentProposal(){plans++;return {source:{origin:'https://flow-content.google',path:'/image/'+GUID},quoteCredits:9,permissionTitle:'Would you like me to kick off this 1 video generation, costing 9 credits?'};},async approveAgentEdit(page,binding,{beforeSubmit}){await beforeSubmit();approvals++;},async readAgentEditOutput(){throw failure('CDP_CLOSED');}};
  h=await harness(t,{edit:true,recover:true,agentEdit,sourcePoster:'https://flow-content.google/image/'+GUID,inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720}),operation(op){if(op==='agent-scene-result')throw failure('CDP_CLOSED');}});
  await assert.rejects(h.engine.generate(input({jobId:crypto.randomUUID(),model:'omni-1.2-flash-edit-landscape',references:[{kind:'video',path:source}]}),{beforeSubmit(){if(stage==='persist')throw failure('PERSIST_FAILED');}}),e=>e.code===(stage==='persist'?'PERSIST_FAILED':'CDP_CLOSED')&&e.unknownOutcome===(stage==='after-approval'));
  assert.equal(plans,1);assert.equal(approvals,stage==='persist'?0:1);assert.equal(h.ops.some(op=>op.op==='submit'),false);assert.equal(h.state.releases,1);
 }
});

test('Agent receipt recovery reads only the saved source scene and output preview without planning or approving again',async t=>{
 const projectURL='https://flow.google.com/project/'+SOURCE_PROJECT,sourceScene={url:projectURL+'/edit/'+SCENE,poster:'https://flow-content.google/image/'+GUID,sha256:crypto.createHash('sha256').update(MP4).digest('hex'),durationSeconds:3,width:1280,height:720},sourcePreview='https://storage.googleapis.com/ai-sandbox-videofx/image/'+GUID;
 const h=await harness(t,{recover:true,edit:true,historyPoster:'https://flow-content.google/image/result-owned',inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720}),agentEdit:new Proxy({},{get(){assert.fail('Recovery called Agent planning or approval')}}),operation(op,arg,state){if(op==='agent-scene-result'){assert.equal(state.url,sourceScene.url);state.opened=true;return {ready:true,prompt:input().prompt,ingredients:[],sourceVideos:[],sourcePreviews:[sourcePreview],ingredientsReady:true,posters:['https://flow-content.google/image/result-owned'],url:state.url};}}});
 const {jobId}=await savedReceipt(h,{model:'omni-1.2-flash-edit-landscape',projectURL,sourceScene,agentProposal:{quoteCredits:9,videoCount:1,sourcePreview,approvalText:'Would you like me to kick off this 1 video generation, costing 9 credits?'}});
 const result=await h.engine.recover(jobId);assert.deepEqual(await fs.readFile(result.media[0].path),MP4);assert.equal(h.state.submitted,0);assert.equal(h.state.videoUploads,undefined);assert.deepEqual(h.commands.filter(c=>c.method==='Page.navigate').map(c=>c.params.url),[sourceScene.url]);assert.equal(h.state.releases,1);
});

test('Agent recovery refreshes only the saved scene when its loaded state stalls, without another upload or approval',async t=>{
 const projectURL='https://flow.google.com/project/'+SOURCE_PROJECT,sourceScene={url:projectURL+'/edit/'+SCENE,poster:'https://flow-content.google/image/'+GUID,sha256:crypto.createHash('sha256').update(MP4).digest('hex'),durationSeconds:3,width:1280,height:720},sourcePreview='https://storage.googleapis.com/ai-sandbox-videofx/image/'+GUID;
 const h=await harness(t,{recover:true,edit:true,observationRefreshMs:1,historyPoster:'https://flow-content.google/image/result-owned',inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720}),operation(op,arg,state){if(op==='agent-scene-result'){if(!state.readOnlyReloads)return false;state.opened=true;return {ready:true,prompt:input().prompt,ingredients:[],sourceVideos:[],sourcePreviews:[sourcePreview],ingredientsReady:true,posters:['https://flow-content.google/image/result-owned'],url:state.url};}}});
 const {jobId,file}=await savedReceipt(h,{model:'omni-1.2-flash-edit-landscape',projectURL,sourceScene,agentProposal:{quoteCredits:9,videoCount:1,sourcePreview,approvalText:'Would you like me to kick off this 1 video generation, costing 9 credits?'}}),before=await fs.readFile(file);
 const result=await h.engine.recover(jobId);assert.deepEqual(await fs.readFile(result.media[0].path),MP4);assert.equal(h.state.readOnlyReloads,1);assert.equal(h.state.submitted,0);assert.equal(h.state.videoUploads,undefined);assert.deepEqual(await fs.readFile(file),before);
});

test('Agent attachment failure clears only recorded own selection nonces before approval',async t=>{
 const folder=await temporary(t),source=path.join(folder,'source.mp4');await fs.writeFile(source,MP4);let h,clearArgs,approvals=0;
 const imageNonce='00000000-0000-4000-8000-000000000002',sourceNonce='00000000-0000-4000-8000-000000000001';
 const agentEdit={async startAgentSession(){},async configureAgentEdit(){},async prepareAgentReferenceContext(){},async verifyAgentEditSettings(){},async attachAgentAsset(page,{kind}){if(kind==='video')return {selectionNonce:sourceNonce};throw Object.assign(failure('FLOW_UI_TIMEOUT'),{agentSelectionNonce:imageNonce});},async clearOwnedAgentAttachments(page,args){clearArgs=args;return true;},async approveAgentEdit(){approvals++;assert.fail('Attachment failure approved');}};
 h=await harness(t,{edit:true,recover:true,agentEdit,sourcePoster:'https://flow-content.google/image/'+GUID,inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720})});
 await assert.rejects(h.engine.generate(input({jobId:crypto.randomUUID(),model:'omni-1.2-flash-edit-landscape',references:[{kind:'video',path:source},{kind:'image',dataUrl:PNG}]}),{beforeSubmit:()=>assert.fail('Failed attachment persisted paid submission')}),{code:'FLOW_UI_TIMEOUT'});
 assert.deepEqual(clearArgs,{nonces:[sourceNonce,imageNonce],prompt:''});assert.equal(approvals,0);assert.equal(h.state.releases,1);assert.equal(h.ops.some(op=>op.op==='submit'),false);
});

async function agentObservationRecoveryFixture(t,{code='SOURCE_VIDEO_NOT_VERIFIED',persistent=false,receiptChange,onSent,noJobId=false}={}){
 const folder=await temporary(t),source=path.join(folder,'source.mp4');await fs.writeFile(source,MP4);
 const sourcePoster='https://flow-content.google/image/'+GUID,sourcePreview='https://storage.googleapis.com/ai-sandbox-videofx/image/'+GUID,counters={approvals:0,plans:0,sessions:0,attachments:0,durable:0};let h,receiptBytes;
 const jobId=noJobId?undefined:crypto.randomUUID();
 const agentEdit={async startAgentSession(){counters.sessions++;},async configureAgentEdit(){},async verifyAgentEditSettings(){},async prepareAgentReferenceContext(){},async attachAgentAsset(){counters.attachments++;},async prepareAgentProposal(){counters.plans++;return {source:{origin:'https://storage.googleapis.com',path:'/ai-sandbox-videofx/image/'+GUID},quoteCredits:9,permissionTitle:'Would you like me to kick off this 1 video generation, costing 9 credits?'};},async approveAgentEdit(page,binding,{beforeSubmit}){await beforeSubmit();counters.approvals++;}};
 h=await harness(t,{edit:true,recover:true,recoverAfterObservation:true,agentEdit,sourcePoster,historyPoster:'https://flow-content.google/image/result-owned',inspectVideo:async()=>({durationSeconds:3,mimeType:'video/mp4',width:1280,height:720}),onRecoveryAcquire(){assert.equal(h.state.releases,1);assert.equal(h.order.at(-1),'release');assert.equal(counters.approvals,1);assert.equal(counters.plans,1);},async operation(op,arg,state){
  if(op!=='agent-scene-result')return;
  if(state.acquisitions===1||persistent){
   if(receiptChange&&state.acquisitions===1&&!state.changedReceipt){state.changedReceipt=true;await receiptChange(path.join(h.dataDir,'browser-receipts',jobId+'.json'));}
   throw failure(code);
  }
  assert.equal(state.url,arg.sourceScene.url);assert.equal(arg.prompt,input().prompt);assert.equal(arg.sourcePreview,sourcePreview);state.opened=true;
  return {ready:true,prompt:input().prompt,ingredients:[],sourceVideos:[],sourcePreviews:[sourcePreview],ingredientsReady:true,posters:['https://flow-content.google/image/result-owned'],url:state.url};
 }});
 const value=input({...(jobId?{jobId}:{}),model:'omni-1.2-flash-edit-landscape',references:[{kind:'video',path:source}]}),run=options=>h.engine.generate(value,{beforeSubmit:async()=>{counters.durable++;if(jobId)receiptBytes=await fs.readFile(path.join(h.dataDir,'browser-receipts',jobId+'.json'));},onProgress:text=>{if(text.startsWith('Редактирование отправлено'))onSent?.();},...options});
 return{h,counters,jobId,run,get receiptBytes(){return receiptBytes;}};
}

test('paid Agent observation errors recover once in a fresh lease without repeating uploads session planning or approval',async t=>{
 for(const code of ['SOURCE_VIDEO_NOT_VERIFIED','RESULT_INPUT_MISMATCH','AGENT_PROPOSAL_CHANGED','AGENT_INPUTS_NOT_VERIFIED']){
  const f=await agentObservationRecoveryFixture(t,{code}),result=await f.run();
  assert.deepEqual(await fs.readFile(result.media[0].path),MP4);assert.deepEqual(f.counters,{approvals:1,plans:1,sessions:1,attachments:1,durable:1});assert.equal(f.h.state.videoUploads.length,1);assert.equal(f.h.uploads.length,0);assert.equal(f.h.state.acquisitions,2);assert.equal(f.h.state.releases,2);assert.equal(f.h.ops.some(op=>op.op==='submit'),false);
  assert.equal(f.h.commands.filter(command=>command.method==='DOM.setFileInputFiles').length,1);assert.deepEqual(await fs.readFile(path.join(f.h.dataDir,'browser-receipts',f.jobId+'.json')),f.receiptBytes);
 }
});

test('paid Agent observation recovery validates immutable receipt before a second acquisition and rejects missing corrupt or changed ownership',async t=>{
 for(const [receiptChange,code] of [
  [file=>fs.unlink(file),'BROWSER_RECEIPT_MISSING'],
  [file=>fs.writeFile(file,'not-json'),'BROWSER_RECEIPT_INVALID'],
  [async file=>{const value=JSON.parse(await fs.readFile(file,'utf8'));value.prompt+=' changed';await fs.writeFile(file,JSON.stringify(value));},'BROWSER_RECEIPT_MISMATCH'],
  [async file=>{const value=JSON.parse(await fs.readFile(file,'utf8'));value.sourceScene.sha256='b'.repeat(64);await fs.writeFile(file,JSON.stringify(value));},'BROWSER_RECEIPT_MISMATCH'],
  [async file=>{const value=JSON.parse(await fs.readFile(file,'utf8'));delete value.agentProposal;await fs.writeFile(file,JSON.stringify(value));},'BROWSER_RECEIPT_MISMATCH'],
 ]){
  const f=await agentObservationRecoveryFixture(t,{receiptChange});await assert.rejects(f.run(),error=>error.code===code&&error.unknownOutcome===true);assert.equal(f.h.state.acquisitions,1);assert.equal(f.h.state.releases,1);assert.equal(f.counters.approvals,1);assert.equal(f.h.state.videoUploads.length,1);
 }
});

test('paid Agent observation recovery never loops or follows cancelled terminal or unkeyed jobs',async t=>{
 const persistent=await agentObservationRecoveryFixture(t,{persistent:true});await assert.rejects(persistent.run(),error=>error.code==='SOURCE_VIDEO_NOT_VERIFIED'&&error.unknownOutcome===true);assert.equal(persistent.h.state.acquisitions,2);assert.equal(persistent.h.state.releases,2);assert.equal(persistent.counters.approvals,1);
 const controller=new AbortController(),cancelled=await agentObservationRecoveryFixture(t,{onSent:()=>controller.abort(failure('CANCELLED'))});await assert.rejects(cancelled.run({signal:controller.signal}),{code:'CANCELLED'});assert.equal(cancelled.h.state.acquisitions,1);assert.equal(cancelled.counters.approvals,1);
 const terminal=await agentObservationRecoveryFixture(t,{onSent:()=>{throw Object.assign(failure('SOURCE_VIDEO_NOT_VERIFIED'),{generationTerminal:true});}});await assert.rejects(terminal.run(),error=>error.generationTerminal===true&&error.unknownOutcome===false);assert.equal(terminal.h.state.acquisitions,1);assert.equal(terminal.counters.approvals,1);
 const unkeyed=await agentObservationRecoveryFixture(t,{noJobId:true});await assert.rejects(unkeyed.run(),error=>error.code==='SOURCE_VIDEO_NOT_VERIFIED'&&error.unknownOutcome===true);assert.equal(unkeyed.h.state.acquisitions,1);assert.equal(unkeyed.counters.approvals,1);
});

test('360p Agent Edit verifies ordinary resolution preferences and requires the exact four-credit proposal before one paid action',async t=>{
 const folder=await temporary(t),source=path.join(folder,'source.mp4');await fs.writeFile(source,MP4);let h,approvals=0,context;
 const sceneURL='https://flow.google.com/project/'+SOURCE_PROJECT+'/edit/'+SCENE,preview='https://storage.googleapis.com/ai-sandbox-videofx/image/'+GUID;
 const agentEdit={async startAgentSession(){assert.equal(h.state.radios.has('360p 360p: видео генерируется быстрее, но разрешение ниже'),true);},async configureAgentEdit(){},async prepareAgentReferenceContext(page,args){context=args;},async attachAgentAsset(){},async verifyAgentEditSettings(){},async prepareAgentProposal(page,expected){assert.equal(expected.maxCredits,4);return {source:{origin:'https://storage.googleapis.com',path:'/ai-sandbox-videofx/image/'+GUID},quoteCredits:4,permissionTitle:'Would you like me to kick off this 1 video generation, costing 4 credits?'};},async approveAgentEdit(page,binding,{beforeSubmit}){await beforeSubmit();approvals++;}};
 h=await harness(t,{edit:true,recover:true,agentEdit,sourcePoster:'https://flow-content.google/image/'+GUID,historyPoster:'https://flow-content.google/image/result-owned',inspectVideo:async()=>({durationSeconds:3.029333,mimeType:'video/mp4',width:360,height:640}),operation(op,arg,state){if(op==='agent-scene-result'){state.opened=true;return {ready:true,prompt:input().prompt,ingredients:[],sourceVideos:[],sourcePreviews:[preview],ingredientsReady:true,posters:['https://flow-content.google/image/result-owned'],url:sceneURL};}}});
 const result=await h.engine.generate(input({jobId:crypto.randomUUID(),model:'omni-1.2-flash-edit-portrait-360p',references:[{kind:'video',path:source}]}),{beforeSubmit(){}});assert.equal(approvals,1);assert.equal(context.resolution,'360p');assert.equal(context.aspect,'9:16');assert.equal(result.media[0].kind,'video');assert.equal(h.ops.some(x=>x.op==='submit'),false);
});

test('project resolves a recognized product announcement before account verification on initial and newly navigated pages',async()=>{
 for(const initial of ['https://flow.google.com/','https://flow.google.com/project/project-owned']){
  let url=initial,announcement=true,checks=0;const events=[],page=new FlowPage({send:()=>assert.fail('Project readiness fixture must not use raw browser commands')});
  page.ready=async()=>{events.push('ready');};
  page.dismissProductAnnouncement=async()=>{events.push('announcement:'+url);announcement=false;};
  page.verifyAccount=async email=>{assert.equal(announcement,false,'Announcement must be resolved before opening the account drawer');assert.equal(email,EMAIL);checks++;events.push('account:'+url);};
  page.until=async fn=>{for(let attempt=0;attempt<3;attempt++){const result=await fn();if(result)return result;}assert.fail('Project fixture did not settle');};
  page.run=async op=>{
   if(op==='state')return {url,projectLinks:[{href:'/project/project-owned'}]};
   if(op==='project'){events.push('navigate');url='https://flow.google.com/project/project-owned';announcement=true;return true;}
   if(op==='close-empty-agent-panel'){assert.equal(announcement,false);return false;}
   if(op==='composer-mode')return {agent:false,creative:false,ready:true};
   assert.fail('Unexpected project readiness operation: '+op);
  };
  assert.equal(await page.project(EMAIL),'https://flow.google.com/project/project-owned');assert.equal(checks,2);
  assert.ok(events.indexOf('announcement:'+initial)<events.indexOf('account:'+initial));
  if(initial==='https://flow.google.com/')assert.ok(events.indexOf('navigate')<events.lastIndexOf('announcement:https://flow.google.com/project/project-owned'));
 }
});

function productAnnouncementFixture(){
 let title='Introducing Omni 1.2!',active=true,roots=1,duplicateGetStarted=false,foreignInput=false,foreignLink=false,policyText=false,inert=false,cssHidden=false;const clicks=[];
 const element=(attributes={},extra={})=>Object.defineProperties({getAttribute:key=>attributes[key]??null,getClientRects:()=>active?[1]:[],getBoundingClientRect:()=>({left:260,top:100,width:600,height:650,right:860,bottom:750}),closest:selector=>selector==='[aria-hidden="true"],[inert]'&&inert?{}:selector==='[role="dialog"],dialog'?dialog:null,querySelectorAll:()=>[],querySelector:()=>null},Object.getOwnPropertyDescriptors(extra));
 const heading=element({role:'heading'},{get innerText(){return title;},get textContent(){return title;}}),getStarted=element({},{innerText:'Get started',textContent:'Get started',click(){clicks.push('Get started');active=false;}}),changelogs=element({},{innerText:'View all changelogs',textContent:'View all changelogs',click(){clicks.push('View all changelogs');}}),unknown=element({role:'checkbox'},{innerText:'Email me product updates'});
 const dialog=element({role:'dialog'},{get innerText(){return title+'\nNew features\nView all changelogs\nGet started'+(policyText?'\nTerms of service and consent to marketing':'');},get textContent(){return this.innerText;},contains:node=>[heading,getStarted,changelogs,unknown].includes(node)});
 dialog.querySelectorAll=selector=>{
  if(selector==='h1,h2,h3,[role="heading"]')return [heading];
  if(selector==='button,[role="button"]')return [getStarted,changelogs,...(duplicateGetStarted?[getStarted]:[])];
  if(/input|checkbox|select|textarea|switch/.test(selector))return foreignInput||foreignLink&&selector.includes('a[href]')?[unknown]:[];
  if(selector.includes('a[')||selector==='a')return foreignLink?[unknown]:[];
  return [];
 };
 dialog.querySelector=selector=>dialog.querySelectorAll(selector)[0]||null;
 const context={innerWidth:1280,innerHeight:900,location:{origin:'https://flow.google.com'},getComputedStyle:()=>({visibility:cssHidden?'hidden':'visible'}),document:{querySelector:()=>null,querySelectorAll:selector=>selector==='[role="dialog"],dialog'||selector==='[role="dialog"]'?active?Array(roots).fill(dialog):[]:[]}};
 return {clicks,run:arg=>vm.runInNewContext('('+flowDOM.toString()+')("product-announcement",'+JSON.stringify(arg||{})+')',context),set:values=>{if(values.title!==undefined)title=values.title;if(values.active!==undefined)active=values.active;if(values.roots!==undefined)roots=values.roots;if(values.duplicateGetStarted!==undefined)duplicateGetStarted=values.duplicateGetStarted;if(values.foreignInput!==undefined)foreignInput=values.foreignInput;if(values.foreignLink!==undefined)foreignLink=values.foreignLink;if(values.policyText!==undefined)policyText=values.policyText;if(values.inert!==undefined)inert=values.inert;if(values.cssHidden!==undefined)cssHidden=values.cssHidden;}};
}

test('product announcement dismisses only the unique exact Omni heading and owned Get started control once',()=>{
 const h=productAnnouncementFixture();assert.equal(h.run(),true);assert.deepEqual(h.clicks,[]);assert.equal(h.run({dismiss:true}),true);assert.deepEqual(h.clicks,['Get started']);assert.equal(h.run(),false);assert.equal(h.run({dismiss:true}),false);assert.deepEqual(h.clicks,['Get started']);
});

test('product announcement preserves unrelated onboarding policy inputs links and ambiguous or inert dialogs',()=>{
 for(const scenario of [{title:'Welcome to Flow'}, {title:'Terms of service'}, {duplicateGetStarted:true}, {roots:2}, {foreignInput:true}, {foreignLink:true}, {policyText:true}, {inert:true}, {cssHidden:true}]){
  const h=productAnnouncementFixture();h.set(scenario);let result,error;try{result=h.run({dismiss:true});}catch(caught){error=caught;}if(error)assert.match(error.message,/PRODUCT_ANNOUNCEMENT_NOT_VERIFIED/,JSON.stringify(scenario));else assert.equal(result,false,JSON.stringify(scenario));assert.deepEqual(h.clicks,[],JSON.stringify(scenario));
 }
});

function lateAnnouncementAccountFixture({visibleEmail=EMAIL,reappears=false}={}){
 const events=[];let accountPolls=0,announcementChecks=0,dismissals=0,opened=false;
 const page=new FlowPage({send:()=>assert.fail('Account readiness fixture must not use raw browser commands')});
 page.until=async(fn,_timeout,stage)=>{for(let attempt=0;attempt<4;attempt++){const value=await fn();if(value)return value;}throw failure('FLOW_UI_TIMEOUT',stage||'ui');};
 page.dismissProductAnnouncement=async()=>{announcementChecks++;if(accountPolls<2){events.push('announcement-absent');return false;}dismissals++;events.push('announcement-dismissed');return true;};
 page.click=async name=>{events.push(name);if(name==='Сведения об аккаунте')opened=true;else if(name==='Закрыть панель аккаунта')opened=false;else assert.fail('Unexpected account control: '+name);};
 page.run=async(op,arg)=>{
  if(op==='editor-account')return null;
  if(op==='state')return {url:'https://flow.google.com/project/'+SOURCE_PROJECT};
  if(op==='exists'){assert.equal(arg.name,'Сведения об аккаунте');accountPolls++;const available=accountPolls>=3&&dismissals===1&&!reappears;events.push(available?'account-available':'account-blocked');return available;}
  if(op==='account')return opened?visibleEmail:null;
  assert.fail('Unexpected account readiness operation: '+op);
 };
 return {page,events,get accountPolls(){return accountPolls;},get announcementChecks(){return announcementChecks;},get dismissals(){return dismissals;}};
}

test('account wait dismisses a late announcement after an early false check and still validates the exact account identity',async()=>{
 for(const visibleEmail of [EMAIL,'other@example.test']){
  const h=lateAnnouncementAccountFixture({visibleEmail});
  if(visibleEmail===EMAIL)await h.page.verifyAccount(EMAIL);else await assert.rejects(h.page.verifyAccount(EMAIL),{code:'ACCOUNT_MISMATCH'});
  assert.equal(h.dismissals,1);assert.equal(h.announcementChecks,2,'An absent first check must leave one later dismissal available');assert.equal(h.accountPolls,3);assert.equal(h.events.indexOf('announcement-absent')<h.events.indexOf('announcement-dismissed'),true);assert.equal(h.events.indexOf('announcement-dismissed')<h.events.indexOf('Сведения об аккаунте'),true);assert.equal(h.events.filter(value=>value==='Сведения об аккаунте').length,1);assert.equal(h.events.includes('Закрыть панель аккаунта'),visibleEmail===EMAIL);
 }
});

test('account wait never dismisses a reappearing announcement twice and never opens an unverified account drawer',async()=>{
 const h=lateAnnouncementAccountFixture({reappears:true});await assert.rejects(h.page.verifyAccount(EMAIL),error=>error.code==='FLOW_UI_TIMEOUT'&&error.message==='account-button');assert.equal(h.dismissals,1);assert.equal(h.announcementChecks,2);assert.equal(h.accountPolls,4);assert.equal(h.events.includes('Сведения об аккаунте'),false);
});
