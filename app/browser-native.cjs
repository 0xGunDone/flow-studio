'use strict';

const path = require('node:path');
const { spawn: spawnProcess } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { setTimeout: wait } = require('node:timers/promises');
const { createHmac, randomBytes } = require('node:crypto');

const MAX_INPUT = 64 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_TEXT = 20000;
const COMMAND_FIELDS = {
  status: [], requestPermission: [], requestScreenPermission:[], readLabel:['pid','nodeId'],locateFlow:[], focusFlow:['pid'], activateAccessibility:['pid'], snapshot: ['pid'], press: ['pid', 'nodeId'], focus: ['pid', 'nodeId'],
  setValue: ['pid', 'nodeId', 'value'], key: ['pid', 'key', 'modifiers'], text: ['pid', 'text'],
  chooseFile: ['pid', 'path', 'sha256'], readIngredientFingerprint: ['pid', 'nodeId'],
};
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

class NativeBrowserError extends Error {
  constructor(code, message) { super(message); this.name = 'NativeBrowserError'; this.code = code; }
}
function failure(code, message) { return new NativeBrowserError(code, message); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function cancelled(signal) { if (signal?.aborted) throw failure('REQUEST_CANCELLED', 'Действие в браузере отменено.'); }
function email(value) { return typeof value === 'string' && value.length <= 320 && EMAIL.test(value.trim()) ? value.trim().toLowerCase() : null; }
function pid(value) { return Number.isSafeInteger(value) && value > 0; }
function textValue(value) { return typeof value === 'string' && value.length <= MAX_TEXT && !value.includes('\0'); }

function discoveryFailure(code, message, result) {
  const evidence = {};
  if (Array.isArray(result?.candidates)) {
    evidence.candidates = result.candidates.length;
    evidence.distinctPids = new Set(result.candidates.filter(candidate => record(candidate) && pid(candidate.pid)).map(candidate => candidate.pid)).size;
  }
  for (const key of ['windowsChecked', 'chromeProcesses', 'duplicateWindowEntries']) {
    if (Number.isSafeInteger(result?.[key]) && result[key] >= 0) evidence[key] = result[key];
  }
  const error = failure(code, `${message} ${JSON.stringify(evidence)}`);
  error.discoveryEvidence = evidence;
  return error;
}

function commandArgs(command, args) {
  const fields = own(COMMAND_FIELDS, command) && COMMAND_FIELDS[command];
  if (!fields || !record(args) || Object.keys(args).some(key => !fields.includes(key))) throw failure('INVALID_ARGUMENTS', 'Неверная команда браузера.');
  if (fields.includes('pid') && !pid(args.pid)) throw failure('INVALID_ARGUMENTS', 'Неверный процесс браузера.');
  if (fields.includes('nodeId') && (typeof args.nodeId !== 'string' || !args.nodeId || args.nodeId.length > 256 || /[\x00-\x1f]/.test(args.nodeId))) throw failure('INVALID_ARGUMENTS', 'Неверный элемент браузера.');
  for (const key of ['value', 'text']) if (fields.includes(key) && !textValue(args[key])) throw failure('INVALID_ARGUMENTS', 'Текст браузера должен быть строкой не длиннее 20 000 символов.');
  if (command === 'chooseFile' && (typeof args.path !== 'string' || !path.isAbsolute(args.path) || args.path.length > 4096 || /[\x00-\x1f\x7f]/.test(args.path) || typeof args.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(args.sha256))) throw failure('INVALID_ARGUMENTS', 'Нужны абсолютный путь и SHA-256 подготовленного изображения.');
  if (command === 'key') {
    const modifiers = args.modifiers ?? [];
    const key = typeof args.key === 'string' ? args.key : '';
    const plain = ['tab', 'esc', 'escape', 'enter', 'return', 'left', 'right', 'up', 'down', 'home', 'end'];
    const shifted = ['tab', 'left', 'right', 'up', 'down', 'home', 'end'];
    const valid = Array.isArray(modifiers) && (
      (!modifiers.length && plain.includes(key)) ||
      (modifiers.length === 1 && modifiers[0] === 'shift' && shifted.includes(key)) ||
      (modifiers.length === 1 && modifiers[0] === 'command' && ['a', 'c', 'v'].includes(key)) ||
      (modifiers.length === 2 && modifiers.includes('command') && modifiers.includes('shift') && key === 'g')
    );
    if (!valid) throw failure('INVALID_ARGUMENTS', 'Это сочетание клавиш недоступно.');
  }
}

class NativeBrowser {
  constructor({ binaryPath = path.join(__dirname, 'native', 'bin', `flow-browser-${process.arch}`), spawn = spawnProcess } = {}) {
    if (typeof binaryPath !== 'string' || !path.isAbsolute(binaryPath) || binaryPath.includes('\0') || typeof spawn !== 'function') throw failure('INVALID_ARGUMENTS', 'Неверный путь помощника браузера.');
    this.binaryPath = binaryPath; this.spawn = spawn; this.child = null; this.pending = null;
    this.closed = false; this.nextId = 0; this.buffer = ''; this.decoder = new StringDecoder('utf8');
  }

  _start() {
    if (this.child) return;
    let child;
    try { child = this.spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false }); }
    catch { throw failure('NATIVE_UNAVAILABLE', 'Не удалось запустить помощник браузера.'); }
    if (!child?.stdin?.write || !child?.stdout?.on || !child?.on) { child?.kill?.(); throw failure('NATIVE_UNAVAILABLE', 'Помощник браузера недоступен.'); }
    this.child = child;
    this.onData = chunk => this._data(chunk);
    this.onError = () => this._stop(failure('NATIVE_UNAVAILABLE', 'Помощник браузера недоступен.'));
    this.onStreamError = () => this._stop(failure('NATIVE_TRANSPORT', 'Соединение с помощником браузера закрыто.'));
    this.onClose = () => {
      this._stop(failure('NATIVE_CLOSED', 'Помощник браузера завершил работу.'));
      child.stdout.removeListener('data', this.onData); child.stdout.removeListener('error', this.onStreamError);
      child.stdin.removeListener('error', this.onStreamError); child.removeListener('error', this.onError); child.removeListener('close', this.onClose);
    };
    child.on('error', this.onError); child.on('close', this.onClose);
    child.stdin.on('error', this.onStreamError); child.stdout.on('error', this.onStreamError); child.stdout.on('data', this.onData);
  }

  _stop(error) {
    if (this.closed) return;
    this.closed = true;
    const pending = this.pending; this.pending = null;
    if (pending) { pending.cleanup(); pending.reject(error); }
    const child = this.child; this.child = null; this.buffer = '';
    child?.stdin.destroy?.(); child?.stdout.destroy?.();
    try { if (child && !child.killed && child.exitCode == null) child.kill(); } catch {}
  }

  _data(chunk) {
    if (this.closed) return;
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_OUTPUT) return this._stop(failure('NATIVE_RESPONSE_TOO_LARGE', 'Ответ помощника браузера превышает допустимый размер.'));
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      let response;
      try { response = JSON.parse(line); } catch { return this._stop(failure('NATIVE_PROTOCOL', 'Помощник браузера вернул неверный JSON.')); }
      const pending = this.pending;
      if (!pending || !record(response) || response.id !== pending.id || own(response, 'result') === own(response, 'error') || Object.keys(response).some(key => !['id', 'result', 'error'].includes(key))) return this._stop(failure('NATIVE_PROTOCOL', 'Помощник браузера вернул неожиданный ответ.'));
      if (own(response, 'error') && (!record(response.error) || typeof response.error.code !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(response.error.code) || typeof response.error.message !== 'string' || response.error.message.length > 4096)) return this._stop(failure('NATIVE_PROTOCOL', 'Помощник браузера вернул неверную ошибку.'));
      this.pending = null; pending.cleanup();
      if (own(response, 'error')) pending.reject(failure(response.error.code, response.error.message));
      else pending.resolve(response.result);
    }
  }

  async call(command, args = {}, { signal, timeoutMs = 15000 } = {}) {
    if (this.closed) throw failure('NATIVE_CLOSED', 'Помощник браузера закрыт.');
    cancelled(signal); commandArgs(command, args);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw failure('INVALID_ARGUMENTS', 'Неверный срок ожидания браузера.');
    if (this.pending) throw failure('NATIVE_BUSY', 'Дождитесь завершения действия в браузере.');
    const id = String(++this.nextId), request = JSON.stringify({ id, command, ...args }) + '\n';
    if (Buffer.byteLength(request, 'utf8') > MAX_INPUT) throw failure('NATIVE_REQUEST_TOO_LARGE', 'Команда браузера превышает 64 КиБ.');
    this._start();
    return new Promise((resolve, reject) => {
      const abort = () => this._stop(failure('REQUEST_CANCELLED', 'Действие в браузере отменено.'));
      const timer = setTimeout(() => this._stop(failure('NATIVE_TIMEOUT', 'Браузер не ответил вовремя. Проверьте его перед повтором действия.')), timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending = { id, resolve, reject, cleanup };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      try { this.child.stdin.write(request, error => { if (error) this._stop(failure('NATIVE_TRANSPORT', 'Не удалось передать команду браузеру.')); }); }
      catch { this._stop(failure('NATIVE_TRANSPORT', 'Не удалось передать команду браузеру.')); }
    });
  }

  status(options) { return this.call('status', {}, options); }
  requestPermission(options) { return this.call('requestPermission', {}, options); }
  async close() { this._stop(failure('NATIVE_CLOSED', 'Помощник браузера закрыт.')); }
}

function snapshotNodes(snapshot) {
  if (!record(snapshot) || !pid(snapshot.pid) || !Array.isArray(snapshot.nodes) || snapshot.nodes.length > 4000 || snapshot.truncated !== false) throw failure('SNAPSHOT_INCOMPLETE', 'Не удалось полностью прочитать окно браузера.');
  const ids = new Set();
  for (const node of snapshot.nodes) {
    if (!record(node) || typeof node.id !== 'string' || !node.id || node.id.length > 256 || ids.has(node.id) || typeof node.role !== 'string' || node.role.length > 128 || typeof node.enabled !== 'boolean' || !Array.isArray(node.actions) || node.actions.some(action => typeof action !== 'string' || action.length > 128)) throw failure('SNAPSHOT_INVALID', 'Помощник вернул неверные элементы браузера.');
    for (const field of ['title', 'description', 'value']) if (node[field] !== undefined && (typeof node[field] !== 'string' || Buffer.byteLength(node[field], 'utf8') > 4000)) throw failure('SNAPSHOT_INVALID', 'Помощник вернул неверный текст браузера.');
    if (node.selected !== undefined && typeof node.selected !== 'boolean') throw failure('SNAPSHOT_INVALID', 'Помощник вернул неверный выбор элемента браузера.');
    ids.add(node.id);
  }
  return snapshot.nodes;
}

function findUnique(snapshot, query) {
  const fields = ['id', 'role', 'title', 'description', 'value', 'action', 'enabled'];
  if (!record(query) || !Object.keys(query).length || Object.keys(query).some(key => !fields.includes(key)) || !Object.keys(query).some(key => key !== 'enabled') || Object.entries(query).some(([key, value]) => key === 'enabled' ? typeof value !== 'boolean' : typeof value !== 'string' || !value)) throw failure('INVALID_ARGUMENTS', 'Нужен точный признак проверенного элемента браузера.');
  const matches = snapshotNodes(snapshot).filter(node => (query.enabled === undefined ? node.enabled : node.enabled === query.enabled) && Object.entries(query).every(([key, value]) => key === 'action' ? node.actions.includes(value) : key === 'enabled' || node[key] === value));
  if (matches.length !== 1) throw failure(matches.length ? 'CONTROL_AMBIGUOUS' : 'CONTROL_NOT_FOUND', matches.length ? 'Найдено несколько подходящих элементов. Проверьте окно Flow.' : 'Проверенный элемент не найден' + (query.role ? ' (' + query.role + (query.title || query.description ? ': ' + (query.title || query.description) : '') + ')' : '') + '. Откройте нужный экран Flow.');
  return matches[0];
}

function projectURL(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://flow.google.com' || url.username || url.password || url.search || url.hash || !/^\/project\/[A-Za-z0-9_-]{1,128}\/?$/.test(url.pathname)) return null;
    return url.origin + url.pathname.replace(/\/$/, '');
  } catch { return null; }
}

function accountPanelGroups(snapshot) {
  return snapshotNodes(snapshot).filter(node => node.role === 'AXGroup' && [node.title, node.description, node.value].includes('Настройки аккаунта'));
}

function accountPanelEvidence(snapshot) {
  const names = ['Настройки аккаунта', 'Закрыть панель аккаунта', 'Сведения об аккаунте'], nodes = snapshotNodes(snapshot);
  const count = (role, name) => nodes.filter(node => node.role === role && [node.title, node.description, node.value].includes(name)).length;
  return {
    ...(record(snapshot.diagnostics) ? {scan: Object.fromEntries(['attempted','emitted','maxDepthAttempted','maxDepthEmitted','limitSkips','ownerErrors','ownerMismatches','hashRepeats','equalRepeats','unequalHashCollisions','hashComparisonsOmitted','hashElementsStored','sensitiveSkips','childrenErrors','childrenTypeMismatches','webareaCount'].flatMap(key => Number.isSafeInteger(snapshot.diagnostics[key]) && snapshot.diagnostics[key] >= 0 ? [[key,snapshot.diagnostics[key]]] : []))} : {}), accountGroups: count('AXGroup', names[0]), closeButtons: count('AXButton', names[1]), accountInfoButtons: count('AXButton', names[2]),
    namedAccountNodes: nodes.flatMap(node => {
      const fields = ['title', 'description', 'value'].filter(field => names.includes(node[field]));
      return fields.length ? [{ role: node.role, fields, names: [...new Set(fields.map(field => node[field]))] }] : [];
    }),
  };
}

function accountEmail(snapshot) {
  const nodes = snapshotNodes(snapshot), groups = accountPanelGroups(snapshot);
  if (groups.length !== 1) throw failure('ACCOUNT_NOT_VERIFIED', 'Откройте панель аккаунта Flow для проверки адреса.');
  const byId = new Map(nodes.map(node => [node.id, node]));
  const inside = node => { const seen = new Set(); for (let parent = node.parent; parent && !seen.has(parent); parent = byId.get(parent)?.parent) { if (parent === groups[0].id) return true; seen.add(parent); } return false; };
  const addresses = nodes.filter(node => node.role === 'AXStaticText' && inside(node) && email(node.value)).map(node => email(node.value));
  if (addresses.length !== 1) throw failure('ACCOUNT_NOT_VERIFIED', 'Не удалось однозначно прочитать адрес аккаунта Flow.');
  return addresses[0];
}

function descendants(snapshot, root) {
  const nodes = snapshotNodes(snapshot), byId = new Map(nodes.map(node => [node.id, node]));
  return nodes.filter(node => { const seen = new Set(); for (let parent = node.parent; parent && !seen.has(parent); parent = byId.get(parent)?.parent) { if (parent === root) return true; seen.add(parent); } return node.id === root; });
}

function composer(snapshot, expectedPrompt, { allowEmpty = false, ingredientCount = 0 } = {}) {
  const trigger = findUnique(snapshot, { role: 'AXButton', title: 'Триггер настроек' });
  if (!trigger.parent) throw failure('COMPOSER_NOT_VERIFIED', 'Не удалось проверить окно запроса Flow.');
  const nodes = descendants(snapshot, trigger.parent), prompt = findUnique({ ...snapshot, nodes }, { role: 'AXTextArea', description: 'Что вы хотите создать?' });
  const matchesPrompt = expectedPrompt !== undefined && prompt.value === expectedPrompt;
  const emptyPrompt = typeof prompt.value === 'string' && !prompt.value.trim();
  if (expectedPrompt === undefined ? !emptyPrompt : !matchesPrompt && !(allowEmpty && emptyPrompt)) throw failure(expectedPrompt === undefined || allowEmpty ? 'DRAFT_PRESENT' : 'PROMPT_MISMATCH', expectedPrompt === undefined || allowEmpty ? 'В окне Flow уже есть другое описание. Сохраните или очистите его перед подготовкой.' : 'Flow не подтвердил точный текст описания.');
  const promptIds = new Set(descendants(snapshot, prompt.id).map(node => node.id));
  const ingredients = nodes.filter(node => node.role === 'AXButton' && node.title === 'Ингредиент');
  const ingredientChildren = new Set(ingredients.flatMap(node => descendants(snapshot, node.id).map(child => child.id)));
  const allowed = node => node.role === 'AXGroup' && !node.title && !node.description ||
    node.id === prompt.id || matchesPrompt && promptIds.has(node.id) && node.role === 'AXStaticText' && typeof node.value === 'string' && node.value.length > 0 && expectedPrompt.includes(node.value) ||
    node.role === 'AXPopUpButton' && node.title === 'Добавить ингредиенты в окно запроса' ||
    ingredientCount > 0 && ingredientChildren.has(node.id) && node.role === 'AXImage' && [node.title, node.description].includes('Изображение ингредиента') ||
    node.role === 'AXCheckBox' && node.title === 'Агент' && node.value === '0' ||
    node.role === 'AXButton' && (['Триггер настроек', 'Начать генерацию'].includes(node.title) || ingredientCount > 0 && node.title === 'Ингредиент' || matchesPrompt && node.title === 'Очистить запрос');
  if (ingredients.length !== ingredientCount || nodes.some(node => !allowed(node)) || !nodes.some(node => node.role === 'AXPopUpButton' && node.title === 'Добавить ингредиенты в окно запроса') || !nodes.some(node => node.role === 'AXCheckBox' && node.title === 'Агент' && node.value === '0')) throw failure('COMPOSER_NOT_VERIFIED', 'Уберите посторонние исходные файлы и выключите режим агента в окне запроса Flow.');
  if (prompt.settable !== true) throw failure('CONTROL_NOT_EDITABLE', 'Поле запроса Flow недоступно для ввода.');
  return prompt;
}

function validateTarget(snapshot, pin) {
  snapshotNodes(snapshot);
  if (!record(pin) || !pid(pin.pid) || snapshot.pid !== pin.pid) throw failure('TARGET_CHANGED', 'Окно браузера не соответствует выбранному аккаунту.');
  const expectedEmail = email(pin.expectedEmail);
  if (!expectedEmail) throw failure('INVALID_ARGUMENTS', 'Нужен адрес выбранного аккаунта.');
  const currentURL = projectURL(snapshot.documentURL);
  if (!currentURL) throw failure('FLOW_PROJECT_REQUIRED', 'Откройте проект на flow.google.com в окне выбранного аккаунта.');
  if (pin.projectURL !== undefined && (!projectURL(pin.projectURL) || projectURL(pin.projectURL) !== currentURL)) throw failure('TARGET_CHANGED', 'Проект Flow изменился. Проверьте окно перед продолжением.');
  // Only an observed account control can prove identity; prompt text cannot.
  let observedEmail;
  if (pin.accountControl) {
    const account = findUnique(snapshot, pin.accountControl);
    const addresses = new Set([account.title, account.description, account.value].filter(value => typeof value === 'string').flatMap(value => value.match(/[^\s@<>()\[\],;:]+@[^\s@<>()\[\],;:]+\.[^\s@<>()\[\],;:]+/g) || []).map(email).filter(Boolean));
    if (addresses.size === 1) observedEmail = [...addresses][0];
  } else observedEmail = accountEmail(snapshot);
  if (observedEmail !== expectedEmail) throw failure('ACCOUNT_MISMATCH', 'Адрес аккаунта в окне Flow не совпадает с выбранным.');
  return Object.freeze({ pid: snapshot.pid, accountMatch: true, projectURL: currentURL });
}

function inputPlan(input) {
  const allowed = ['accountId', 'expectedEmail', 'model', 'prompt', 'images', 'settings', 'projectURL'];
  if (!record(input) || Object.keys(input).some(key => !allowed.includes(key)) || !Number.isSafeInteger(input.accountId) || input.accountId <= 0 || !email(input.expectedEmail) || !textValue(input.prompt) || !input.prompt.trim()) throw failure('INVALID_ARGUMENTS', 'Выберите аккаунт, модель и непустое описание до 20 000 символов.');
  if (Buffer.byteLength(input.prompt, 'utf8') > 4000) throw failure('PROMPT_TOO_LARGE', 'Для точной проверки в браузере описание должно занимать не больше 4 000 байт UTF-8.');
  const match = typeof input.model === 'string' && /^omni-1\.2-flash-([3-9]|1[0-5])s-(landscape|portrait)(-360p)?$/.exec(input.model);
  const alias = input.model === 'omni-1.2-flash';
  if (!alias && (!match || Number(match[1]) < 3 || Number(match[1]) > 15)) throw failure('MODEL_UNSUPPORTED', 'Нативный браузер принимает только модель Omni 1.2 Flash.');
  if (input.images !== undefined && (!Array.isArray(input.images) || input.images.length > 7)) throw failure('INVALID_ARGUMENTS', 'Передайте не больше семи подготовленных изображений.');
  const images = (input.images || []).map((image, index) => {
    if (!record(image) || Object.keys(image).some(key => !['path', 'name', 'sha256'].includes(key)) || typeof image.path !== 'string' || !path.isAbsolute(image.path) || image.path.length > 4096 || /[\x00-\x1f\x7f]/.test(image.path) || typeof image.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(image.sha256) || typeof image.name !== 'string' || image.name !== path.basename(image.path) || !new RegExp(`^ref-${image.sha256.slice(0, 16)}-${index}-[0-9a-f]{8}\\.(png|jpe?g|webp|gif)$`).test(image.name)) throw failure('INVALID_ARGUMENTS', 'Изображение должно иметь проверенный путь, уникальное имя и SHA-256.');
    return Object.freeze({ path: image.path, name: image.name, sha256: image.sha256 });
  });
  const settings = { method: images.length ? 'ingredients' : 'text', duration: alias ? 8 : Number(match[1]), aspect: alias || match[2] === 'landscape' ? '16:9' : '9:16', resolution: !alias && match[3] ? '360p' : 'standard' };
  if (input.settings !== undefined && (!record(input.settings) || Object.entries(input.settings).some(([key, value]) => !own(settings, key) || value !== settings[key]))) throw failure('SETTINGS_MISMATCH', 'Настройки не совпадают с выбранной моделью.');
  if (input.projectURL !== undefined && !projectURL(input.projectURL)) throw failure('INVALID_ARGUMENTS', 'Нужна точная ссылка проекта Flow.');
  return Object.freeze({ accountId: input.accountId, expectedEmail: email(input.expectedEmail), model: input.model, prompt: input.prompt, images: Object.freeze(images), settings: Object.freeze(settings), ...(input.projectURL === undefined ? {} : { projectURL: projectURL(input.projectURL) }) });
}

function createBrowserTransport({ native, accounts, onProgress = () => {} } = {}) {
  if (!native?.call || !accounts?.acquireGenerationBrowser || !accounts?.releaseGenerationBrowser) throw failure('INVALID_ARGUMENTS', 'Не настроен нативный браузер.');
  const leases = new Map(), originals = new Map(); let opening = false, openingDone, openingController, closing, closed = false;
  const preparedObjects = new WeakSet(), preparedIngredients = new WeakMap(), submitUsed = new WeakSet(), baselineKey = randomBytes(32);
  const progress = stage => { try { onProgress({ stage }); } catch {} };
  const active = () => { if (closed) throw failure('NATIVE_CLOSED', 'Нативный браузер закрыт.'); };
  async function status({ signal } = {}) {
    active();
    const result = await native.call('status', {}, { signal });
    if (!record(result) || typeof result.trusted !== 'boolean' || typeof result.locked !== 'boolean') throw failure('NATIVE_PROTOCOL', 'Не удалось проверить доступ к браузеру.');
    return { available: true, trusted: result.trusted, locked: result.locked,...(typeof result.screenCaptureTrusted==='boolean'?{screenCaptureTrusted:result.screenCaptureTrusted}:{}) };
  }
  async function requestPermission({ signal } = {}) {
    active();
    const result = await native.call('requestPermission', {}, { signal });
    if (!record(result) || typeof result.trusted !== 'boolean') throw failure('NATIVE_PROTOCOL', 'Не удалось проверить разрешение macOS.');
    return { trusted: result.trusted };
  }
  const optional = (snapshot, query) => { try { return findUnique(snapshot, query); } catch (error) { if (error.code !== 'CONTROL_NOT_FOUND') throw error; return null; } };
  async function read(lease, signal, pinnedProject) {
    active(); cancelled(signal);
    const snapshot = await native.call('snapshot', { pid: lease.pid }, { signal }); snapshotNodes(snapshot);
    let url; try { url = new URL(snapshot.documentURL); } catch {}
    if (snapshot.pid !== lease.pid || url?.origin !== 'https://flow.google.com' || url.username || url.password) throw failure('TARGET_CHANGED', 'Откройте Flow в окне выбранного аккаунта.');
    if (pinnedProject && projectURL(snapshot.documentURL) !== pinnedProject) throw failure('TARGET_CHANGED', 'Проект Flow изменился. Проверьте окно перед продолжением.');
    return snapshot;
  }
  async function until(lease, signal, predicate, pinnedProject, timeoutMs = 10000, stage = 'изменение интерфейса') {
    const deadline = Date.now() + timeoutMs;
    let lastSnapshot;
    do {
      const snapshot = await read(lease, signal, pinnedProject); lastSnapshot = snapshot; if (predicate(snapshot)) return snapshot;
      try { await wait(250, undefined, { signal }); } catch { cancelled(signal); throw failure('REQUEST_CANCELLED', 'Действие в браузере отменено.'); }
    } while (Date.now() < deadline);
    const evidence = stage.includes('аккаунт') && lastSnapshot ? accountPanelEvidence(lastSnapshot) : null;
    const error = failure('UI_STATE_TIMEOUT', `Flow не подтвердил изменение интерфейса (${stage}). Проверьте окно перед повтором.${evidence ? ' ' + JSON.stringify(evidence) : ''}`);
    if (evidence) error.accountEvidence = evidence;
    throw error;
  }
  async function press(snapshot, query, signal) {
    const node = findUnique(snapshot, { action: 'AXPress', ...query });
    await native.call('press', { pid: snapshot.pid, nodeId: node.id }, { signal });
  }
  function ingredientNodes(snapshot) {
    const trigger = findUnique(snapshot, { role: 'AXButton', title: 'Триггер настроек' });
    if (!trigger.parent) throw failure('COMPOSER_NOT_VERIFIED', 'Не удалось проверить окно запроса Flow.');
    return descendants(snapshot, trigger.parent).filter(node => node.role === 'AXButton' && node.title === 'Ингредиент');
  }
  async function ingredientFingerprints(lease, snapshot, signal) {
    const result = [];
    for (const node of ingredientNodes(snapshot)) {
      const identity = await native.call('readIngredientFingerprint', { pid: lease.pid, nodeId: node.id }, { signal });
      if (!record(identity) || !['native-image', 'screen'].includes(identity.method) || typeof identity.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(identity.fingerprint)) throw failure('INGREDIENT_NOT_VERIFIED', 'Не удалось проверить изображение ингредиента в Flow.');
      result.push(Object.freeze({ method: identity.method, fingerprint: identity.fingerprint }));
    }
    return Object.freeze(result);
  }
  function sameIngredients(actual, expected) {
    return actual.length === expected.length && actual.every((item, index) => item.method === expected[index].method && item.fingerprint === expected[index].fingerprint);
  }
  function assertIngredients(actual, expected) {
    if (!sameIngredients(actual, expected)) {
      const error = failure('INGREDIENT_MISMATCH', 'Изображения или порядок ингредиентов Flow изменились. Подготовьте запрос заново.');
      error.ingredientEvidence = Object.freeze({ actualCount: actual.length, expectedCount: expected.length,
        methodsChanged: actual.some((item, index) => expected[index] !== undefined && item.method !== expected[index].method),
        fingerprintsChanged: actual.some((item, index) => expected[index] !== undefined && item.fingerprint !== expected[index].fingerprint) });
      error.message += ' ' + JSON.stringify(error.ingredientEvidence);
      throw error;
    }
  }
  async function verifyIngredients(lease, snapshot, expected, signal) {
    assertIngredients(await ingredientFingerprints(lease, snapshot, signal), expected);
  }
  async function stableNewIngredient(lease, plan, url, expected, signal) {
    const started = Date.now(), deadline = started + 5000;
    let previous, stable = 0, sampleCount = 0, maxStableSamples = 0, totalSnapshotMs = 0, totalFingerprintMs = 0, methodTransitions = 0, fingerprintTransitions = 0;
    do {
      const snapshotStarted = Date.now();
      const snapshot = await read(lease, signal, url);
      totalSnapshotMs += Math.max(0, Date.now() - snapshotStarted);
      composer(snapshot, plan.prompt, { ingredientCount: expected.length + 1 });
      const fingerprintStarted = Date.now();
      const actual = await ingredientFingerprints(lease, snapshot, signal);
      totalFingerprintMs += Math.max(0, Date.now() - fingerprintStarted); sampleCount++;
      assertIngredients(actual.slice(0, -1), expected);
      if (previous) {
        if (actual.some((item, index) => item.method !== previous[index]?.method)) methodTransitions++;
        if (actual.some((item, index) => item.fingerprint !== previous[index]?.fingerprint)) fingerprintTransitions++;
      }
      stable = previous && sameIngredients(actual, previous) ? stable + 1 : 1;
      maxStableSamples = Math.max(maxStableSamples, stable);
      if (Date.now() >= deadline) break;
      if (stable === 3) return actual;
      previous = actual;
      try { await wait(Math.min(250, deadline - Date.now()), undefined, { signal }); }
      catch { cancelled(signal); throw failure('REQUEST_CANCELLED', 'Действие в браузере отменено.'); }
    } while (Date.now() < deadline);
    const error = failure('INGREDIENT_NOT_VERIFIED', 'Изображение ингредиента Flow не стабилизировалось. Проверьте окно перед повтором.');
    error.ingredientEvidence = Object.freeze({ sampleCount, maxStableSamples, elapsedMs: Math.max(0, Date.now() - started), totalSnapshotMs, totalFingerprintMs, methodTransitions, fingerprintTransitions });
    error.message += ' ' + JSON.stringify(error.ingredientEvidence);
    throw error;
  }
  function pickerAsset(snapshot, name) {
    const list = optional(snapshot, { role: 'AXList', title: 'Список объектов' });
    if (!list) return null;
    const nodes = descendants(snapshot, list.id);
    if (nodes.some(node => node.role === 'AXProgressIndicator')) return null;
    const matches = nodes.filter(node => node.enabled && node.actions.includes('AXPress') && [node.title, node.description, node.value].includes(name + ' Изображение'));
    if (matches.length > 1) throw failure('CONTROL_AMBIGUOUS', 'В списке Flow найдено несколько изображений с подготовленным именем.');
    return matches[0] || null;
  }
  function selectedPickerAsset(snapshot, name) {
    const asset = pickerAsset(snapshot, name);
    if (!asset) return null;
    const list = findUnique(snapshot, { role: 'AXList', title: 'Список объектов' });
    const selected = descendants(snapshot, list.id).filter(node => node.selected === true && node.enabled && node.actions.includes('AXPress'));
    if (selected.some(node => node.id !== asset.id) || selected.length > 1) return null;
    const previews = snapshotNodes(snapshot).filter(node => node.role === 'AXImage' && [node.title, node.description].some(value => typeof value === 'string' && value.startsWith('Предпросмотр ресурса "')));
    const previewName = `Предпросмотр ресурса "${name}"`;
    if (previews.length > 1 || previews.length === 1 && ![previews[0].title, previews[0].description].includes(previewName)) return null;
    if (snapshot.nodes.some(node => node.role === 'AXSlider' && node.enabled)) return null;
    if (previews.length !== 1) return null;
    return asset;
  }
  async function attachImages(lease, plan, url, signal) {
    let expected = Object.freeze([]);
    for (const image of plan.images) {
      let snapshot = await read(lease, signal, url);
      composer(snapshot, plan.prompt, { ingredientCount: expected.length });
      await verifyIngredients(lease, snapshot, expected, signal);
      await press(snapshot, { role: 'AXPopUpButton', title: 'Добавить ингредиенты в окно запроса' }, signal);
      snapshot = await until(lease, signal, state => Boolean(optional(state, { role: 'AXButton', title: 'Загрузить' })) && Boolean(optional(state, { role: 'AXList', title: 'Список объектов' })), url, 10000, 'выбор изображения');
      const list = findUnique(snapshot, { role: 'AXList', title: 'Список объектов' });
      if (descendants(snapshot, list.id).some(node => [node.title, node.description, node.value].includes(image.name + ' Изображение'))) throw failure('INGREDIENT_NAME_EXISTS', 'В Flow уже есть изображение с подготовленным именем. Подготовьте запрос заново.');
      await press(snapshot, { role: 'AXButton', title: 'Загрузить' }, signal);
      const chosen = await native.call('chooseFile', { pid: lease.pid, path: image.path, sha256: image.sha256 }, { signal, timeoutMs: 30000 });
      if (!record(chosen) || chosen.chosen !== true || chosen.sha256 !== image.sha256) throw failure('FILE_NOT_VERIFIED', 'Браузер не подтвердил выбор подготовленного изображения.');
      snapshot = await until(lease, signal, state => Boolean(pickerAsset(state, image.name)), url, 30000, 'загрузка изображения');
      const asset = pickerAsset(snapshot, image.name);
      if (asset.selected !== true) await press(snapshot, { id: asset.id }, signal);
      snapshot = await until(lease, signal, state => {
        return Boolean(selectedPickerAsset(state, image.name)) && Boolean(optional(state, { role: 'AXButton', title: 'Добавить в запрос', action: 'AXPress' }));
      }, url, 10000, 'выбор загруженного изображения');
      await press(snapshot, { role: 'AXButton', title: 'Добавить в запрос' }, signal);
      snapshot = await until(lease, signal, state => !optional(state, { role: 'AXList', title: 'Список объектов' }) && ingredientNodes(state).length === expected.length + 1, url, 10000, 'добавление ингредиента');
      expected = await stableNewIngredient(lease, plan, url, expected, signal);
    }
    return expected;
  }
  function hasAccountPanel(snapshot) { return accountPanelGroups(snapshot).length > 0; }
  async function verifyAccount(lease, signal, pinnedProject) {
    let snapshot = await read(lease, signal, pinnedProject);
    if (!hasAccountPanel(snapshot)) {
      if (!optional(snapshot, { role: 'AXButton', title: 'Сведения об аккаунте' })) {
        try{snapshot=await until(lease,signal,current=>Boolean(optional(current,{role:'AXButton',title:'Сведения об аккаунте'})),pinnedProject,10000,'кнопка сведений об аккаунте');}
        catch(error){if(error.code!=='UI_STATE_TIMEOUT')throw error;throw failure('ACCOUNT_NOT_VERIFIED','Не найдена панель аккаунта Flow.');}
      }
      await press(snapshot, { role: 'AXButton', title: 'Сведения об аккаунте' }, signal);
      snapshot = await until(lease, signal, hasAccountPanel, pinnedProject, 10000, 'открытие панели аккаунта');
    }
    if (accountEmail(snapshot) !== leases.get(lease)) throw failure('ACCOUNT_MISMATCH', 'Адрес аккаунта в окне Flow не совпадает с выбранным.');
    await press(snapshot, { role: 'AXButton', title: 'Закрыть панель аккаунта' }, signal);
    return until(lease, signal, state => !hasAccountPanel(state), pinnedProject, 10000, 'закрытие панели аккаунта');
  }
  async function existingProject(lease, signal, pinnedProject) {
    let snapshot = await verifyAccount(lease, signal), current = projectURL(snapshot.documentURL);
    if (!current) {
      const links = snapshot.nodes.filter(node => node.role === 'AXLink' && node.title === 'Открыть проект' && node.enabled && node.actions.includes('AXPress') && (!pinnedProject || projectURL(node.url) === pinnedProject));
      if (!links.length) throw failure('FLOW_PROJECT_REQUIRED', 'Откройте существующий проект Flow перед подготовкой.');
      await native.call('press', { pid: lease.pid, nodeId: links[0].id }, { signal });
      snapshot = await until(lease, signal, state => Boolean(projectURL(state.documentURL))); current = projectURL(snapshot.documentURL);
    }
    if (pinnedProject && current !== pinnedProject) throw failure('TARGET_CHANGED', 'Открыт другой проект Flow.');
    await verifyAccount(lease, signal, current);
    return current;
  }
  async function verifyModel(lease, signal, url) {
    const current = await read(lease, signal, url), popup = findUnique(current, { role: 'AXPopUpButton', title: 'Выбрать семейство моделей' });
    const label = await native.call('readLabel', { pid: lease.pid, nodeId: popup.id }, { signal, timeoutMs: 45000 });
    if (!record(label) || label.method !== 'vision' || !Array.isArray(label.texts) || label.texts.length !== 1 || typeof label.texts[0] !== 'string' || label.texts[0].trim().replace(/\s+/g, ' ') !== 'Omni 1.2 Flash') throw failure('MODEL_NOT_VERIFIED', 'Flow не подтвердил выбранную модель Omni 1.2 Flash.');
  }
  async function requestScreenPermission({signal}={}) {active();return native.call('requestScreenPermission',{}, {signal});}
  async function release(lease,options) {
    if (!leases.has(lease)) return;
    leases.delete(lease); const original=originals.get(lease)||lease; originals.delete(lease); await accounts.releaseGenerationBrowser(original,options);
  }
  async function open(accountId, { expectedEmail, signal } = {}) {
    active(); cancelled(signal);
    if (!Number.isSafeInteger(accountId) || accountId <= 0 || (expectedEmail !== undefined && !email(expectedEmail))) throw failure('INVALID_ARGUMENTS', 'Выберите действующий аккаунт.');
    if (opening || leases.size) throw failure('BROWSER_BUSY', 'Дождитесь завершения действия в браузере.');
    opening = true; openingController = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, openingController.signal]) : openingController.signal;
    let completed; openingDone = new Promise(resolve => { completed = resolve; });
    let lease;
    try {
      const access = await status({ signal: operationSignal });
      if (!access.trusted) throw failure('AX_PERMISSION_REQUIRED', 'Разрешите Flow Studio управлять браузером в настройках универсального доступа macOS.');
      if (access.locked) throw failure('SESSION_LOCKED', 'Разблокируйте Mac перед работой с браузером.');
      progress('browser-opening');
      lease = await accounts.acquireGenerationBrowser(accountId, { signal: operationSignal, async resolveReuseExternal({ signal }) {
        const before=await native.call('locateFlow',{}, {signal});
        if(Array.isArray(before?.candidates)&&before.candidates.length>1)throw discoveryFailure('FLOW_WINDOW_AMBIGUOUS','Оставьте ровно одно окно Flow перед проверкой. Новое окно не открывалось.',before);
        return Array.isArray(before?.candidates)&&before.candidates.length===1;
      } }); cancelled(operationSignal); active();
      if (lease?.external === true) {
        const original=lease;
        let found;
        for(let attempt=0;attempt<20;attempt++) {
          cancelled(operationSignal);
          found=await native.call('locateFlow',{}, {signal:operationSignal});
          if(found?.candidates?.length)break;
          await wait(250,undefined,{signal:operationSignal});
        }
        if(!Array.isArray(found?.candidates)||found.candidates.length!==1||!pid(found.candidates[0].pid)) {
          const missing = Array.isArray(found?.candidates) && found.candidates.length === 0;
          throw discoveryFailure(missing ? 'FLOW_WINDOW_UNAVAILABLE' : 'FLOW_WINDOW_AMBIGUOUS', missing ? 'Не найдено доступное окно Flow в выбранном профиле Chrome.' : 'Оставьте ровно одно окно Flow в выбранном профиле Chrome.',found);
        }
        lease=Object.freeze({...original,pid:found.candidates[0].pid});originals.set(lease,original);
      }
      if (!record(lease) || !pid(lease.pid) || lease.accountId !== accountId || !email(lease.email) || (expectedEmail !== undefined && email(lease.email) !== email(expectedEmail))) throw failure('ACCOUNT_MISMATCH', 'Профиль браузера не соответствует выбранному аккаунту.');
      leases.set(lease, email(expectedEmail ?? lease.email));
      await native.call('focusFlow',{pid:lease.pid},{signal:operationSignal});
      try { await native.call('activateAccessibility',{pid:lease.pid},{signal:operationSignal}); } catch(error) { if(error.code!=='ACCESSIBILITY_ACTIVATION_FAILED')throw error; }
      return lease;
    } catch (error) { if (lease) {const original=originals.get(lease)||lease;originals.delete(lease);leases.delete(lease);await accounts.releaseGenerationBrowser(original).catch(() => {});} throw error; }
    finally { opening = false; openingController = null; completed(); }
  }
  async function inspect(accountId, { expectedEmail, signal, lease, accountControl, projectURL: pinnedProject, openProject = false } = {}) {
    active(); cancelled(signal);
    const owned = !lease;
    if (lease && (!leases.has(lease) || lease.accountId !== accountId || (expectedEmail !== undefined && email(expectedEmail) !== leases.get(lease)))) throw failure('ACCOUNT_MISMATCH', 'Окно браузера не соответствует выбранному аккаунту.');
    const handle = lease || await open(accountId, { expectedEmail, signal });
    try {
      const access = await status({ signal });
      if (!access.trusted || access.locked) return { ...access, accountMatch: false, projectURL: null, controls: {}, ready: false, reason: access.locked ? 'SESSION_LOCKED' : 'AX_PERMISSION_REQUIRED' };
      let snapshot, target, reason = 'UI_NOT_VERIFIED', accountMatch = false, diagnostics = null, failureMessage = null;
      try {
        if (!accountControl) {
          if (openProject) await existingProject(handle, signal, pinnedProject);
          snapshot = await verifyAccount(handle, signal, pinnedProject); accountMatch = true;
          const current = projectURL(snapshot.documentURL);
          if (!current) throw failure('FLOW_PROJECT_REQUIRED', 'Откройте проект Flow перед подготовкой.');
          target = { accountMatch: true, projectURL: current };
        } else { snapshot = await read(handle, signal); target = validateTarget(snapshot, { pid: handle.pid, expectedEmail: leases.get(handle), accountControl, ...(pinnedProject !== undefined ? { projectURL: pinnedProject } : {}) }); }
      }
      catch (error) { if (!(error instanceof NativeBrowserError)) throw error; reason = error.code; diagnostics = error.accountEvidence || null; failureMessage = error.code === 'TARGET_CHANGED' && ['The Chrome window is no longer showing Flow.', 'The accessible Chrome document is no longer Flow.', 'Откройте Flow в окне выбранного аккаунта.', 'Проект Flow изменился. Проверьте окно перед продолжением.', 'Открыт другой проект Flow.'].includes(error.message) ? error.message : null; }
      // Readiness contains counts only. Raw AX strings and node handles stay local.
      const roles = new Map();
      if (snapshot && reason !== 'SNAPSHOT_INCOMPLETE' && reason !== 'SNAPSHOT_INVALID') for (const node of snapshotNodes(snapshot)) roles.set(node.role, (roles.get(node.role) || 0) + 1);
      const controls = Object.fromEntries(roles);
      return { ...access, accountMatch: accountMatch || target?.accountMatch === true, projectURL: target?.projectURL || null, controls, ready: false, reason, diagnostics, failureMessage };
    } finally { if (owned) await release(handle); }
  }
  async function prepare(input, signal) {
    active(); cancelled(signal); const plan = inputPlan(input), lease = await open(plan.accountId, { expectedEmail: plan.expectedEmail, signal });
    try {
      const url = await existingProject(lease, signal, plan.projectURL);
      let snapshot = await read(lease, signal, url); composer(snapshot, plan.prompt, { allowEmpty: true });
      await press(snapshot, { role: 'AXButton', title: 'Триггер настроек' }, signal);
      snapshot = await until(lease, signal, state => Boolean(optional(state, { role: 'AXRadioButton', title: 'Видео' })), url, 10000, 'настройки видео');
      async function select(role, title) {
        let state = await read(lease, signal, url), node = findUnique(state, { role, title });
        if (node.value !== '1') { await press(state, { role, title }, signal); state = await until(lease, signal, current => optional(current, { role, title })?.value === '1', url, 10000, `настройка ${title}`); }
        return state;
      }
      await select('AXRadioButton', 'Видео');
      await select('AXRadioButton', 'Ингредиенты');
      snapshot = await read(lease, signal, url);
      await press(snapshot, { role: 'AXPopUpButton', title: 'Выбрать семейство моделей' }, signal);
      snapshot = await until(lease, signal, state => Boolean(optional(state, { role: 'AXMenuItem', title: 'Omni 1.2 Flash' })), url, 10000, 'список моделей');
      await press(snapshot, { role: 'AXMenuItem', title: 'Omni 1.2 Flash' }, signal);
      await until(lease, signal, state => Boolean(optional(state, { role: 'AXPopUpButton', title: 'Выбрать семейство моделей' })) && !optional(state, { role: 'AXMenuItem', title: 'Omni 1.2 Flash' }), url, 10000, 'выбор модели Omni 1.2 Flash');
      await select('AXRadioButton', plan.settings.aspect);
      const browserResolution = plan.settings.resolution === 'standard' ? '720p' : '360p';
      const resolutionTitle = browserResolution === '720p' ? '720p' : '360p 360p: видео генерируется быстрее, но разрешение ниже';
      await select('AXRadioButton', resolutionTitle); await select('AXRadioButton', 'x1');
      snapshot = await read(lease, signal, url);
      const durationSlider = state => {
        const node = findUnique(state, { role: 'AXSlider', description: 'Длительность' });
        if (node.settable !== true || node.minValue !== 0 || node.maxValue !== 12 || !/^(?:[0-9]|1[0-2])$/.test(node.value)) throw failure('DURATION_NOT_VERIFIED', 'Flow не подтвердил диапазон длительности Omni 1.2 Flash.');
        return node;
      };
      const slider = durationSlider(snapshot), index = String(plan.settings.duration - 3);
      if (slider.value !== index) {
        // Native keys dispatch the range input events that Flow needs to retain its setting.
        for (let position = 0; position <= Number(index); position++) {
          const current = durationSlider(await read(lease, signal, url));
          if (position > 0 && current.value !== String(position - 1)) throw failure('DURATION_NOT_VERIFIED', 'Длительность Flow изменилась во время настройки.');
          const focused = await native.call('focus', { pid: lease.pid, nodeId: current.id }, { signal });
          if (focused?.performed !== true) throw failure('FOCUS_FAILED', 'Flow не подтвердил фокус на длительности.');
          await native.call('key', { pid: lease.pid, key: position === 0 ? 'home' : 'right' }, { signal });
          await until(lease, signal, state => durationSlider(state).value === String(position), url, 10000, `длительность ${position + 3} с`);
        }
      }
      snapshot = await read(lease, signal, url);
      for (const title of ['Видео', 'Ингредиенты', plan.settings.aspect, resolutionTitle, 'x1']) if (findUnique(snapshot, { role: 'AXRadioButton', title }).value !== '1') throw failure('SETTINGS_MISMATCH', 'Flow изменил выбранные настройки. Проверьте окно перед продолжением.');
      if (findUnique(snapshot, { role: 'AXSlider', description: 'Длительность' }).value !== index) throw failure('DURATION_NOT_VERIFIED', 'Flow изменил выбранную длительность.');
      await press(snapshot, { role: 'AXButton', title: 'Триггер настроек' }, signal);
      await until(lease, signal, state => !optional(state, { role: 'AXSlider', description: 'Длительность' }), url, 10000, 'закрытие настроек видео');
      await verifyAccount(lease, signal, url); snapshot = await read(lease, signal, url);
      const prompt = composer(snapshot, plan.prompt, { allowEmpty: true });
      if (prompt.value !== plan.prompt) await native.call('setValue', { pid: lease.pid, nodeId: prompt.id, value: plan.prompt }, { signal });
      await until(lease, signal, state => { try { composer(state, plan.prompt); return true; } catch (error) { if (error.code === 'PROMPT_MISMATCH') return false; throw error; } }, url, 10000, 'поле описания');
      const ingredients = await attachImages(lease, plan, url, signal);
      snapshot = await read(lease, signal, url); composer(snapshot, plan.prompt, { ingredientCount: ingredients.length });
      await verifyIngredients(lease, snapshot, ingredients, signal);
      await press(snapshot, { role: 'AXButton', title: 'Триггер настроек' }, signal);
      await until(lease, signal, state => Boolean(optional(state, { role: 'AXRadioButton', title: 'Видео' })), url, 10000, 'финальная проверка настроек видео');
      await verifyModel(lease, signal, url); snapshot = await read(lease, signal, url);
      for (const title of ['Видео', 'Ингредиенты', plan.settings.aspect, resolutionTitle, 'x1']) if (findUnique(snapshot, { role: 'AXRadioButton', title }).value !== '1') throw failure('SETTINGS_MISMATCH', 'Flow изменил выбранные настройки. Проверьте окно перед продолжением.');
      if (durationSlider(snapshot).value !== index) throw failure('DURATION_NOT_VERIFIED', 'Flow изменил выбранную длительность.');
      await press(snapshot, { role: 'AXButton', title: 'Триггер настроек' }, signal);
      await until(lease, signal, state => !optional(state, { role: 'AXSlider', description: 'Длительность' }), url, 10000, 'закрытие финальных настроек видео');
      await verifyAccount(lease, signal, url);
      snapshot = await read(lease, signal, url); composer(snapshot, plan.prompt, { ingredientCount: ingredients.length });
      await verifyIngredients(lease, snapshot, ingredients, signal);
      const prepared = Object.freeze({ readyToSubmit: true, lease, projectURL: url, model: plan.model, prompt: plan.prompt, images: plan.images, settings: Object.freeze({ ...plan.settings, count: 1, browserModel: 'Omni 1.2 Flash', browserResolution }) });
      preparedIngredients.set(prepared, ingredients); preparedObjects.add(prepared); return prepared;
    } catch (error) { await release(lease); throw error; }
  }
  async function submit(prepared, { signal, beforeSubmit, onProgress: notify } = {}) {
    active(); cancelled(signal);
    if (!preparedObjects.has(prepared) || !leases.has(prepared.lease)) throw failure('PREPARATION_REQUIRED', 'Подготовьте запрос заново в этом окне Flow Studio.');
    if (submitUsed.has(prepared)) throw failure('SUBMIT_ALREADY_ATTEMPTED', 'Этот подготовленный запрос уже использован. Проверьте Flow перед повтором.');
    if (typeof beforeSubmit !== 'function' || notify !== undefined && typeof notify !== 'function') throw failure('INVALID_ARGUMENTS', 'Перед отправкой нужно сохранить состояние запроса.');
    submitUsed.add(prepared);
    const { lease, projectURL: url, settings } = prepared, ingredients = preparedIngredients.get(prepared);
    const emit = stage => { try { notify?.({ stage }); } catch {} };
    async function check() {
      if (!leases.has(lease)) throw failure('PREPARATION_REQUIRED', 'Окно подготовленного запроса уже закрыто.');
      await verifyAccount(lease, signal, url);
      let snapshot = await read(lease, signal, url); composer(snapshot, prepared.prompt, { ingredientCount: ingredients.length });
      await verifyIngredients(lease, snapshot, ingredients, signal);
      await press(snapshot, { role: 'AXButton', title: 'Триггер настроек' }, signal);
      await until(lease, signal, state => Boolean(optional(state, { role: 'AXRadioButton', title: 'Видео' })), url);
      await verifyModel(lease, signal, url); snapshot = await read(lease, signal, url);
      const resolution = settings.browserResolution === '720p' ? '720p' : '360p 360p: видео генерируется быстрее, но разрешение ниже';
      for (const title of ['Видео', 'Ингредиенты', settings.aspect, resolution, 'x1']) if (findUnique(snapshot, { role: 'AXRadioButton', title }).value !== '1') throw failure('SETTINGS_MISMATCH', 'Настройки Flow изменились после подготовки. Подготовьте запрос заново.');
      const slider = findUnique(snapshot, { role: 'AXSlider', description: 'Длительность' });
      if (slider.minValue !== 0 || slider.maxValue !== 12 || slider.value !== String(settings.duration - 3)) throw failure('DURATION_NOT_VERIFIED', 'Длительность Flow изменилась после подготовки.');
      await press(snapshot, { role: 'AXButton', title: 'Триггер настроек' }, signal);
      snapshot = await until(lease, signal, state => !optional(state, { role: 'AXSlider', description: 'Длительность' }), url);
      composer(snapshot, prepared.prompt, { ingredientCount: ingredients.length });
      await verifyIngredients(lease, snapshot, ingredients, signal);
      findUnique(snapshot, { role: 'AXButton', title: 'Начать генерацию', action: 'AXPress' });
      return snapshot;
    }
    emit('submission-checking'); await check(); cancelled(signal);
    await beforeSubmit(); cancelled(signal); active();
    const snapshot = await check(), trigger = findUnique(snapshot, { role: 'AXButton', title: 'Триггер настроек' });
    const composerIds = new Set(descendants(snapshot, trigger.parent).map(node => node.id));
    const groupFingerprints = Object.freeze(snapshot.nodes.filter(node => node.role === 'AXGroup' && typeof node.title === 'string' && node.title.trim() && !composerIds.has(node.id)).map(node => createHmac('sha256', baselineKey).update(node.title).digest('hex')).sort());
    const baseline = Object.freeze({ groupFingerprints });
    const button = findUnique(snapshot, { role: 'AXButton', title: 'Начать генерацию', action: 'AXPress' });
    cancelled(signal); active(); emit('submission-attempting'); cancelled(signal);
    try {
      const result = await native.call('press', { pid: lease.pid, nodeId: button.id }, { signal });
      if (result?.performed !== true) throw failure('SUBMIT_UNCONFIRMED', 'Браузер не подтвердил нажатие. Проверьте Flow перед повтором.');
    } catch (error) { const uncertain = error instanceof Error ? error : failure('SUBMIT_UNCONFIRMED', 'Не удалось подтвердить отправку. Проверьте Flow перед повтором.'); uncertain.unknownOutcome = true; throw uncertain; }
    emit('submission-attempted'); return Object.freeze({ submitted: true, projectURL: url, baseline });
  }
  async function close() {
    if (closing) return closing;
    closed = true; openingController?.abort();
    closing = (async () => {
      let closeError; try { await native.close?.(); } catch (error) { closeError = error; }
      await openingDone;
      const results = await Promise.allSettled([...leases.keys()].map(release));
      const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
      if (closeError) throw closeError;
    })();
    return closing;
  }
  return { status, requestPermission,requestScreenPermission, open, inspect, release, prepare, submit, close };
}

module.exports = { NativeBrowser, NativeBrowserError, createBrowserTransport, validateTarget, findUnique, inputPlan };
