'use strict';

function modelInfo(model) {
  const id = String(model?.id || '');
  const description = String(model?.description || id);
  const kind = /^(veo|omni)[-_]/i.test(id) || /video generation/i.test(description) ? 'video' : 'image';
  const extend = /(?:-|_)extend(?:-|_)/.test(id);
  const i2v = /(?:-|_)(?:i2v|interpolation)(?:-|_)/.test(id);
  const r2v = /(?:-|_)r2v(?:-|_)/.test(id);
  const omni = /^omni[-_]/.test(id);
  const edit = omni && /(?:-|_)edit(?:-|_)/.test(id);
  const aspect = /portrait/.test(id) ? '9:16' : /square/.test(id) ? '1:1' : /four-three/.test(id) ? '4:3' : /three-four/.test(id) ? '3:4' : /landscape/.test(id) || kind === 'video' ? '16:9' : '';
  const seconds = id.match(/(?:-|_)(\d+)s(?:-|_|$)/)?.[1] || description.match(/\b(\d+)s\b/)?.[1];
  const resolutionMatch = id.match(/(?:-|_)(2k|4k|360p|720p|1080p)(?:-|_|$)/i)?.[1];
  const resolution = resolutionMatch && (/^(360|720)p$/i.test(resolutionMatch) ? resolutionMatch.toLowerCase() : resolutionMatch.toUpperCase());
  let name = description.split(' · ')[0].replace(' - ', ' ').replace(/\s+(?:I2V|R2V|Extend|Edit)$/, '');
  if (/generation\s*-/.test(name)) name = id;
  const operation = edit ? 'Редактирование' : extend ? 'Продолжение' : i2v ? 'По кадрам' : r2v ? 'По образцам' : '';
  const omni12 = /^omni-1\.2-flash(?:-|$)/.test(id);
  const maxImages = kind === 'image' ? 5 : i2v ? (omni12 && Number(seconds) > 10 ? 1 : /(?:_|-)i2v(?:_|-)lite(?:_|-)/.test(id) ? 1 : 2) : omni ? edit ? 5 : 7 : r2v ? 3 : 0;
  const maxInputDuration = edit ? omni12 ? 15 : 10 : 0;
  const minImages = r2v || i2v ? (/interpolation/.test(id) ? 2 : 1) : 0;
  const maxVideos = edit ? 1 : 0;
  const maxReferences = maxImages + maxVideos;
  const requiredTier = /^veo/.test(id) && ['4','6'].includes(seconds) ? 'Ultra' : omni12 && Number(seconds) > 10 ? 'Pro' : '';
  const label = [name, operation, seconds ? `${seconds}\u00a0с` : '', aspect, resolution, requiredTier].filter(Boolean).join(' · ');
  return { id, kind, extend, i2v, r2v, omni, edit, maxImages, minImages, maxVideos, minVideos: edit ? 1 : 0, maxReferences, supportsVideoReferences: maxVideos > 0, maxInputDuration, requiredTier, label, aspect, seconds, resolution };
}

function referenceKind(reference) {
  return reference.kind || (/^data:video\//i.test(reference.dataUrl || '') ? 'video' : 'image');
}

const PREFERRED_VIDEO_FAMILY = 'Omni 1.2 Flash';
const VIDEO_METHODS = { text: 'Текст → видео', frames: 'Frames · Кадры', ingredients: 'Ingredients · Ингредиенты', edit: 'Редактирование видео', extend: 'Продолжение видео' };
function modelSettings(model) {
  const info = modelInfo(model), id = info.id;
  const family = /^veo[-_]3[._]1[-_](lite|fast|quality)/.exec(id)?.[1];
  const omniVersion = /^omni[-_](\d+[._]\d+)[-_]flash/.exec(id)?.[1].replace('_', '.');
  const name = family ? `Veo 3.1 ${family[0].toUpperCase() + family.slice(1)}` : omniVersion ? `Omni ${omniVersion} Flash` : /flash-lite-image/.test(id) ? 'Nano Banana 2 Lite' : /flash-image/.test(id) ? 'Nano Banana 2.1' : /pro-image/.test(id) ? 'Nano Banana Pro' : (model?.description || id).split(' · ')[0];
  const methods = info.kind === 'image' ? ['image'] : info.edit ? ['edit'] : info.extend ? ['extend'] : info.i2v ? ['frames'] : info.r2v ? ['ingredients'] : info.omni ? ['text', 'ingredients'] : ['text'];
  return { model, info, family: name, methods, duration: info.edit ? 'source' : info.kind === 'video' ? info.seconds || '8' : '', aspect: info.aspect || '16:9', resolution: info.resolution || 'standard' };
}
function preferredModel(models, kind, method = kind === 'video' ? 'text' : 'image') {
  const entries = models.map(modelSettings).filter(entry => entry.info.kind === kind && entry.methods.includes(method));
  if (kind === 'image') return entries.find(entry => entry.info.id === 'gemini-3.1-flash-image-landscape')?.model || entries[0]?.model || null;
  const preferred = entries.filter(entry => entry.family === PREFERRED_VIDEO_FAMILY);
  return preferred.find(entry => entry.info.id === 'omni-1.2-flash-8s-landscape')?.model || preferred[0]?.model || null;
}
function frameReferences(frames, info, required = false) {
  const [start, end] = frames;
  if (!start && (end || required)) throw new Error('Добавьте начальный кадр');
  if (end && info.maxImages < 2) throw new Error('Эта модель не поддерживает конечный кадр');
  return [start, end].filter(Boolean);
}

function referenceError(info, references, required = false) {
  const images = references.filter(reference => referenceKind(reference) === 'image');
  const videos = references.filter(reference => referenceKind(reference) === 'video');
  if (images.length + videos.length !== references.length) return 'Файл должен быть изображением или видео';
  if (videos.length && !info.maxVideos) return info.omni ? 'Для видео выберите Omni Редактирование' : 'Эта модель не принимает видео. Выберите Omni Редактирование или удалите видео';
  if (videos.length > info.maxVideos) return `Эта модель принимает не больше ${info.maxVideos} видео. Удалите лишние`;
  if (videos.some(reference => typeof reference.path !== 'string' || !reference.path.trim())) return 'Не удалось прочитать исходное видео. Добавьте файл заново';
  if (info.maxImages && images.length > info.maxImages) return `Эта модель принимает не больше ${info.maxImages} изображений. Удалите лишние`;
  if (info.maxReferences && references.length > info.maxReferences) return `Эта модель принимает не больше ${info.maxReferences} исходных файлов. Удалите лишние`;
  if (required && info.minVideos && videos.length < info.minVideos) return 'Добавьте исходное видео для редактирования';
  if (required && images.length < info.minImages) return info.minImages === 2 ? 'Добавьте начальный и\u00a0конечный кадры' : 'Добавьте хотя бы одно исходное изображение';
  return '';
}

function requestFor(model, prompt, references, sourceVideoId) {
  const info = modelInfo(model);
  if (!model?.id) throw new Error('Выберите модель');
  if (!prompt.trim()) throw new Error('Опишите, что хотите создать');
  const invalid = referenceError(info, references, true);
  if (invalid) throw new Error(invalid);
  if (info.extend && !sourceVideoId.trim()) throw new Error('Укажите ID исходного видео из Flow');
  const inputs = references.some(reference => referenceKind(reference) === 'video')
    ? { references: references.map(reference => referenceKind(reference) === 'video' ? { kind: 'video', path: reference.path } : { kind: 'image', dataUrl: reference.dataUrl }) }
    : { images: info.maxImages ? references.map(reference => reference.dataUrl) : [] };
  return { model: model.id, prompt: prompt.trim(), ...inputs, ...(info.extend ? { sourceVideoId: sourceVideoId.trim() } : {}) };
}

function mediaUrl(url) {
  if (typeof url !== 'string') return '';
  if (/^(?:flow-media:\/\/|flow-input:\/\/|https:\/\/|data:(?:image|video)\/|blob:)/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    return parsed.origin === 'http://127.0.0.1:38000' && parsed.pathname.startsWith('/tmp/') && !parsed.username && !parsed.password ? url : '';
  } catch { return ''; }
}

function readDraft(storage) {
  try {
    const draft = JSON.parse(storage?.getItem('flowStudio.draft') || '{}');
    const text = (key, max) => typeof draft?.[key] === 'string' ? draft[key].slice(0, max) : '';
    return { mode: draft?.mode === 'video' ? 'video' : 'image', model: text('model', 512), videoMethod: Object.hasOwn(VIDEO_METHODS, draft?.videoMethod) ? draft.videoMethod : '', prompt: text('prompt', 16000), sourceVideoId: text('sourceVideoId', 2048) };
  } catch { return { mode: 'image', model: '', videoMethod: '', prompt: '', sourceVideoId: '' }; }
}

function requiresLogin(job) {
  return job?.needsLogin === true || /\b(?:code|status(?:Code)?|HTTP)["']?\s*(?:[=:]\s*)?401\b|\bUNAUTHENTICATED\b/i.test([job?.error, job?.progress].join('\n'));
}

function recoveryAccountId(job, accounts) {
  if (job?.accountId !== undefined && job.accountId !== null) return accounts.find(account => String(account.id) === String(job.accountId))?.id ?? null;
  const active = accounts.filter(account => account.isActive);
  return active.length === 1 ? active[0].id : null;
}

function errorMessage(error) {
  return (error?.message || String(error || 'Не удалось выполнить действие'))
    .replace(/^Error invoking remote method ['"]studio:[A-Za-z]+['"]:\s*(?:Error:\s*)?/, '');
}

if (typeof module !== 'undefined' && module.exports) module.exports = { modelInfo, modelSettings, preferredModel, PREFERRED_VIDEO_FAMILY, frameReferences, VIDEO_METHODS, requestFor, mediaUrl, readDraft, requiresLogin, recoveryAccountId, errorMessage };
if (typeof document !== 'undefined') initialize();

function initialize() {
  const $ = id => document.getElementById(id);
  const api = window.flowStudio;
  const state = { ready: false, models: [], accounts: [], jobs: [], login: null, references: [], frames: [null, null], videoMethod: 'text', mode: 'image', selectedJobId: null, submitting: false, loginPending: false, loginAccountId: null, checkingAccountId: null, accountPending: null, batchCheck: null, accountChecks: new Map(), startupPending: true, refreshPending: false, importPending: false };
  const dates = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const numbers = new Intl.NumberFormat('ru-RU');
  let unsubscribe;
  let jobVersion = 0;
  let accountVersion = 0;
  let loginVersion = 0;
  let draftStorage;
  try { draftStorage = window.localStorage; } catch { /* Drafts remain usable when browser storage is unavailable. */ }
  const draft = readDraft(draftStorage);
  state.mode = draft.mode;
  state.videoMethod = draft.videoMethod || 'text';
  $('prompt').value = draft.prompt;
  $('source-video-id').value = draft.sourceVideoId;
  for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === state.mode;
  updatePromptCount();

  function saveDraft() {
    draft.model = $('model').value || draft.model;
    try { draftStorage?.setItem('flowStudio.draft', JSON.stringify({ mode: state.mode, model: draft.model, videoMethod: state.videoMethod, prompt: $('prompt').value, sourceVideoId: $('source-video-id').value })); } catch { /* A full or disabled store must not block generation. */ }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, className, action) {
    const node = element('button', className, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }
  function setError(id, message) { $(id).textContent = message || ''; $(id).hidden = !message; }
  function notify(message, error = false) {
    $('notice-message').textContent = message;
    $('notice').classList.toggle('error', error);
    $('notice').hidden = false;
  }
  function activeJob() { return state.jobs.find(job => job.status === 'running'); }
  function selectedModel() { return state.models.find(model => model.id === $('model').value); }
  function currentReferences(required = false) {
    const info = modelInfo(selectedModel());
    if (state.mode === 'video' && state.videoMethod === 'frames') return frameReferences(state.frames, info, required);
    if (state.mode === 'video' && ['text','extend'].includes(state.videoMethod)) return [];
    return state.references;
  }
  function inputError(required = false) {
    try { return referenceError(modelInfo(selectedModel()), currentReferences(required), required); }
    catch (error) { return error.message; }
  }
  function date(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : dates.format(parsed);
  }
  function duration(seconds) {
    if (!Number.isFinite(seconds)) return '';
    return seconds < 60 ? `${Math.floor(seconds)}\u00a0с` : `${Math.floor(seconds / 60)}\u00a0мин ${Math.floor(seconds % 60)}\u00a0с`;
  }
  function page(name) {
    for (const section of document.querySelectorAll('.page')) section.hidden = section.id !== `page-${name}`;
    for (const item of document.querySelectorAll('[data-page]')) {
      const selected = item.dataset.page === name;
      item.classList.toggle('selected', selected);
      if (selected) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    }
    if (name === 'history') renderHistory();
  }
  function updateReady(message, ready) {
    state.ready = Boolean(ready);
    $('service-label').textContent = ready ? 'Flow подключен' : state.startupPending ? 'Запуск' : 'Нет подключения';
    $('service-detail').textContent = ready ? 'Готов к работе' : state.startupPending ? 'Подключаем Flow' : 'Повторите запуск';
    $('status-dot').classList.toggle('ready', Boolean(ready));
    $('status-dot').classList.toggle('failed', !ready && !state.startupPending);
    $('startup-banner').hidden = Boolean(ready);
    $('startup-message').textContent = message || 'Подключаем Flow…';
    $('retry-startup').hidden = ready || state.startupPending;
    renderLogin();
    updateGenerate();
  }
  function updateGenerate() {
    const running = Boolean(activeJob()) || state.submitting;
    const available = state.accounts.some(account => account.isActive);
    $('generate').disabled = !state.ready || !selectedModel() || running || !available || state.importPending || state.accountPending !== null || Boolean(state.batchCheck?.running);
    $('generate-label').textContent = running ? 'Генерация идет…' : state.mode === 'video' ? 'Создать видео' : 'Создать изображение';
    $('generate-hint').textContent = !state.ready ? 'Ожидаем подключения Flow' : running ? 'Ход генерации виден справа' : state.batchCheck?.running ? 'Проверяем аккаунты…' : state.accountPending !== null ? 'Обновляем подключение…' : state.importPending ? 'Добавляем вложения…' : !available ? 'Подключите активный аккаунт в разделе «Аккаунты»' : '⌘ Enter — создать';
  }
  function renderModels(requestedModel) {
    if (requestedModel !== undefined) draft.model = requestedModel;
    const previous = requestedModel ?? ($('model').value || draft.model);
    const models = state.models.filter(model => modelInfo(model).kind === state.mode);
    $('model').replaceChildren();
    if (!models.length) {
      const option = element('option', '', state.ready ? 'Нет доступных моделей' : 'Загружаем модели…');
      option.value = '';
      $('model').append(option);
    }
    for (const model of models) {
      const option = element('option', '', modelInfo(model).label);
      option.value = model.id;
      $('model').append(option);
    }
    if (models.some(model => model.id === previous)) $('model').value = previous;
    else {
      const missingSavedModel = previous && modelInfo({ id: previous }).kind === state.mode;
      const preferred = !missingSavedModel && preferredModel(models, state.mode, state.mode === 'video' ? state.videoMethod : 'image');
      if (preferred) $('model').value = preferred.id;
      else {
        const option = element('option', '', `${missingSavedModel ? previous : PREFERRED_VIDEO_FAMILY} недоступна для этого метода — выберите модель явно`);
        option.value = ''; $('model').append(option); $('model').value = '';
      }
    }
    $('model').disabled = !models.length;
    const settings = selectedModel() && modelSettings(selectedModel());
    if (state.mode === 'video' && settings && !settings.methods.includes(state.videoMethod)) state.videoMethod = settings.methods[0];
    renderSettings();
    updateModel();
  }
  function fillSelect(id, values, selected, label = value => value) {
    const node = $(id); node.replaceChildren();
    for (const value of [...new Set(values)]) { const option = element('option', '', label(value)); option.value = value; node.append(option); }
    node.value = values.includes(selected) ? selected : values[0] || '';
    node.disabled = !values.length;
    return node.value;
  }
  function renderSettings() {
    const catalog = state.models.filter(model => modelInfo(model).kind === state.mode).map(modelSettings);
    const selected = selectedModel() && modelSettings(selectedModel());
    $('video-method-field').hidden = state.mode !== 'video';
    fillSelect('video-method', Object.keys(VIDEO_METHODS).filter(method => catalog.some(entry => entry.methods.includes(method))), state.videoMethod, value => VIDEO_METHODS[value]);
    if (state.mode === 'video') state.videoMethod = $('video-method').value;
    const method = state.mode === 'image' ? 'image' : state.videoMethod;
    const entries = catalog.filter(entry => entry.methods.includes(method));
    fillSelect('model-family', entries.map(entry => entry.family), selected?.family);
    if (!selected && state.mode === 'video') {
      const option = element('option', '', 'Модель недоступна — выберите модель явно');
      option.value = ''; $('model-family').append(option); $('model-family').value = '';
    }
    const family = entries.filter(entry => entry.family === $('model-family').value);
    fillSelect('duration', [...new Set(family.map(entry => entry.duration))].sort((a,b) => Number(a)-Number(b)), selected?.duration, value => { const tier = family.find(entry => entry.duration === value && entry.info.requiredTier)?.info.requiredTier; return value === 'source' ? 'По исходному видео' : `${value} с${tier ? ' · ' + tier : ''}`; });
    $('duration').disabled = $('duration').children.length < 2;
    $('duration-field').hidden = state.mode !== 'video';
    fillSelect('aspect-ratio', family.filter(entry => entry.duration === $('duration').value).map(entry => entry.aspect), selected?.aspect);
    fillSelect('resolution', family.filter(entry => entry.duration === $('duration').value && entry.aspect === $('aspect-ratio').value).map(entry => entry.resolution), selected?.resolution, value => value === 'standard' ? 'Стандартное' : value);
    $('resolution-field').hidden = $('resolution').children.length < 2;
  }
  function selectSettings(changed) {
    const old = selectedModel() && modelSettings(selectedModel());
    if (changed === 'video-method') state.videoMethod = $('video-method').value;
    const method = state.mode === 'image' ? 'image' : state.videoMethod;
    let entries = state.models.map(modelSettings).filter(entry => entry.info.kind === state.mode && entry.methods.includes(method));
    const saved = state.models.find(model => model.id === draft.model);
    const prior = old || (saved && modelInfo(saved).kind === state.mode ? modelSettings(saved) : null);
    if (changed === 'video-method') {
      const preferred = prior || (draft.model && modelInfo({ id: draft.model }).kind === state.mode ? null : preferredModel(state.models, state.mode, method));
      const family = prior?.family || (preferred && modelSettings(preferred).family);
      entries = family ? entries.filter(entry => entry.family === family) : [];
    }
    const wants = { family: $('model-family').value, duration: $('duration').value, aspect: $('aspect-ratio').value, resolution: $('resolution').value };
    const keys = { 'model-family': 'family', duration: 'duration', 'aspect-ratio': 'aspect', resolution: 'resolution' };
    if (keys[changed]) entries = entries.filter(entry => entry[keys[changed]] === wants[keys[changed]]);
    for (const key of ['family','duration','aspect','resolution']) {
      if (key === keys[changed]) continue;
      const matching = entries.filter(entry => entry[key] === (wants[key] || prior?.[key]));
      if (matching.length) entries = matching;
    }
    const chosen = entries.find(entry => entry.model.id === old?.model.id) || entries[0];
    $('model').value = chosen?.model.id || '';
    renderSettings(); updateModel(); saveDraft();
  }
  function updateModel() {
    const info = modelInfo(selectedModel());
    $('source-field').hidden = !info.extend;
    $('source-video-id').required = info.extend;
    $('pick-images-label').textContent = info.supportsVideoReferences ? 'Добавить фото или видео' : 'Добавить изображения';
    $('model-description').textContent = !selectedModel() ? '' : info.edit ? 'Редактирует исходное видео по вашему запросу и ингредиентам' : info.extend ? 'Продолжает исходное видео по вашему запросу' : state.videoMethod === 'frames' && state.mode === 'video' ? 'Задайте начальный кадр и при необходимости конечный' : state.videoMethod === 'ingredients' && state.mode === 'video' ? 'Использует ингредиенты для содержания и стиля ролика' : info.kind === 'image' ? 'По тексту или с исходными изображениями' : 'Видео по текстовому описанию';
    $('references-hint').textContent = info.edit ? `1 исходное видео MP4, MOV или M4V до ${info.maxInputDuration} с и до 5 изображений. Порядок образцов сохраняется` : info.i2v ? 'Порядок изображений задает начальный и конечный кадры' : info.minImages ? `От ${info.minImages} до ${info.maxImages} изображений` : info.maxImages ? `До ${info.maxImages} изображений, если нужны` : 'Эта модель не использует исходные изображения';
    renderReferences();
    setError('form-error', inputError());
    updateGenerate();
  }
  function renderReferences() {
    const info = modelInfo(selectedModel());
    $('references').replaceChildren();
    const videos = state.references.filter(reference => referenceKind(reference) === 'video').length;
    const images = state.references.length - videos;
    $('references-field').hidden = !selectedModel() || state.mode === 'video' && ['text','frames','extend'].includes(state.videoMethod) || (!info.maxReferences && !state.references.length);
    $('references-label').textContent = state.mode === 'video' ? 'Ингредиенты' : 'Исходные изображения';
    $('references-count').textContent = info.maxVideos || videos ? `${images} / ${info.maxImages} фото · ${videos} / ${info.maxVideos} видео` : `${images} / ${info.maxImages}`;
    function changed() { renderReferences(); setError('form-error', inputError()); }
    state.references.forEach((reference, index) => {
      const item = element('figure', 'reference');
      item.setAttribute('role', 'listitem');
      const video = referenceKind(reference) === 'video';
      const preview = element(video ? 'video' : 'img');
      preview.src = mediaUrl(video ? reference.previewUrl : reference.dataUrl);
      if (video) { preview.controls = true; preview.muted = true; preview.preload = 'metadata'; preview.setAttribute('aria-label', reference.name); }
      else preview.alt = reference.name;
      const remove = button('×', 'reference-remove', () => { state.references.splice(index, 1); changed(); });
      remove.setAttribute('aria-label', `Удалить ${reference.name}`);
      const caption = element('figcaption');
      const name = element('span', 'reference-name', reference.name);
      name.title = reference.name;
      caption.append(name, element('span', 'reference-kind', info.i2v && !video ? index ? 'Конечный кадр' : 'Начальный кадр' : video ? 'Видео' : 'Изображение'));
      const actions = element('div', 'reference-actions');
      for (const [offset, symbol, label] of [[-1, '←', 'Переместить влево'], [1, '→', 'Переместить вправо']]) {
        const move = button(symbol, 'secondary', () => { const target = index + offset; if (target < 0 || target >= state.references.length) return; [state.references[index], state.references[target]] = [state.references[target], state.references[index]]; changed(); });
        move.disabled = index + offset < 0 || index + offset >= state.references.length;
        move.setAttribute('aria-label', `${label}: ${reference.name}`);
        actions.append(move);
      }
      item.append(preview, caption, actions, remove);
      $('references').append(item);
    });
    $('pick-images').disabled = state.importPending || state.references.length >= info.maxReferences;
    $('references-field').setAttribute('aria-busy', String(state.importPending));
    renderFrames();
  }
  function renderFrames() {
    const info = modelInfo(selectedModel());
    $('frames-field').hidden = state.mode !== 'video' || state.videoMethod !== 'frames';
    for (const [index, id, title] of [[0,'start-frame','Начальный кадр'],[1,'end-frame','Конечный кадр']]) {
      const node = $(id); node.replaceChildren();
      const supported = index === 0 || info.maxImages > 1;
      node.setAttribute('aria-label', title); node.setAttribute('aria-busy', String(state.importPending));
      node.append(element('span', 'frame-label', title));
      const file = state.frames[index];
      if (file) {
        const preview = element('img'); preview.src = mediaUrl(file.dataUrl); preview.alt = file.name;
        node.append(preview, element('span','reference-name',file.name));
      }
      const pick = button(file ? 'Заменить' : '+ Добавить', 'secondary frame-pick', () => importFrame(index, () => api.pickImages({ allowVideos: false })));
      pick.setAttribute('aria-label', `${file ? 'Заменить' : 'Добавить'} ${title.toLowerCase()}`);
      pick.disabled = !supported || state.importPending; node.append(pick);
      if (file) { const remove = button('Удалить', 'frame-remove', () => { state.frames[index] = null; renderFrames(); setError('form-error', inputError()); }); remove.setAttribute('aria-label', `Удалить ${title.toLowerCase()}`); node.append(remove); }
      else node.append(element('span','hint',!supported ? 'Недоступен для этой модели' : index && info.minImages < 2 ? 'Необязательно' : 'Обязательный кадр'));
    }
  }
  async function importFrame(index, read) {
    if (state.importPending) return;
    const info = modelInfo(selectedModel());
    if (state.videoMethod !== 'frames' || index > 0 && info.maxImages < 2) { setError('form-error','Этот кадр недоступен для выбранной модели'); return; }
    state.importPending = true; renderFrames(); updateGenerate();
    try {
      const files = await read();
      if (!files.length) return;
      if (files.length !== 1 || referenceKind(files[0]) !== 'image') throw new Error('Для одного кадра выберите одно изображение');
      state.frames[index] = files[0]; setError('form-error',inputError());
    } catch (error) { setError('form-error',errorMessage(error)); }
    finally { state.importPending = false; renderFrames(); updateGenerate(); }
  }
  async function importReferences(read) {
    if (state.importPending) return;
    const info = modelInfo(selectedModel());
    if (!selectedModel() || !info.maxReferences) { setError('form-error', 'Выбранная модель не принимает вложения'); return; }
    state.importPending = true;
    renderReferences(); updateGenerate();
    try {
      const references = await read(info);
      const key = reference => referenceKind(reference) === 'video' ? `video:${reference.path}` : `image:${reference.dataUrl}`;
      const seen = new Set(state.references.map(key));
      const unique = references.filter(reference => { const value = key(reference); if (seen.has(value)) return false; seen.add(value); return true; });
      const current = modelInfo(selectedModel());
      const invalid = current.maxReferences ? referenceError(current, [...state.references, ...unique]) : 'Выбранная модель не принимает вложения';
      if (invalid) setError('form-error', invalid);
      else { state.references.push(...unique); setError('form-error', ''); }
    } catch (error) { setError('form-error', errorMessage(error)); }
    finally { state.importPending = false; renderReferences(); updateGenerate(); }
  }
  function emptyResult() {
    const empty = element('div', 'empty-result');
    const frame = element('div', 'outline-frame');
    frame.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="7" width="36" height="34" rx="5"/><circle cx="16" cy="17" r="3"/><path d="m7 34 11-11 9 9 6-6 9 9"/></svg>';
    empty.append(frame, element('h3', '', 'Здесь появится ваша идея'), element('p', '', 'Выберите модель, опишите сцену и создайте первый результат'));
    return empty;
  }
  function reuse(job) {
    const model = state.models.find(item => item.id === job.model);
    state.mode = model ? modelInfo(model).kind : job.kind || modelInfo({ id: job.model }).kind;
    for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === state.mode;
    renderModels(job.model);
    $('prompt').value = job.prompt;
    state.references = [];
    state.frames = [null, null];
    $('source-video-id').value = '';
    const settings = model && modelSettings(model); if (state.mode === 'video' && settings && !settings.methods.includes(state.videoMethod)) state.videoMethod = settings.methods[0];
    renderSettings(); updateModel();
    updatePromptCount();
    saveDraft();
    page('create');
    $('prompt').focus();
    notify(model ? 'Запрос перенесен в редактор. Добавьте исходные изображения или ID видео заново, если они нужны' : `Модель ${job.model} недоступна. Текст перенесен; выберите другую модель явно`, !model);
  }
  function renderResult() {
    const job = state.jobs.find(item => item.id === state.selectedJobId);
    const result = $('result');
    result.replaceChildren();
    $('result-tag').textContent = !job ? 'Предпросмотр' : job.status === 'running' ? 'В процессе' : job.status === 'failed' || requiresLogin(job) ? 'Не получилось' : 'Готово';
    if (!job) { result.append(emptyResult()); return; }
    if (job.status === 'running') {
      const panel = element('div', 'job-running');
      const progress = element('progress');
      progress.removeAttribute('value');
      progress.setAttribute('aria-label', 'Идет генерация');
      const elapsed = element('time');
      elapsed.id = 'elapsed';
      const message = element('p', '', job.progress || 'Запрос выполняется');
      message.setAttribute('role', 'status');
      panel.append(element('h3', '', job.kind === 'video' ? 'Создаем видео' : 'Создаем изображение'), message, progress, elapsed);
      result.append(panel);
      updateElapsed();
      return;
    }
    if (job.status === 'failed' || requiresLogin(job)) {
      const panel = element('div', 'job-failed');
      if (requiresLogin(job)) {
        panel.append(element('h3', '', 'Нужно снова войти в Google'), element('p', 'inline-error', 'Google отклонил подключение аккаунта. Войдите заново и проверьте подключение в Flow Studio.'), button('Войти в Google заново', 'primary', () => recoverAccount(job)), element('p', 'hint recovery-note', 'Отправленная задача могла завершиться в Flow. Проверьте её там перед новым запуском. Повторный вход не запускает генерацию; запрос и исходные изображения остаются в редакторе.'));
        const details = element('details', 'error-details');
        details.append(element('summary', '', 'Технические детали'), element('pre', '', job.error || job.progress || 'Требуется повторный вход в Google'));
        panel.append(details);
      } else panel.append(element('h3', '', 'Генерация не завершилась'), element('p', 'inline-error', job.error || job.progress || 'Попробуйте повторить запрос'), button('Редактировать запрос', 'secondary', () => reuse(job)));
      result.append(panel);
    } else if (job.media?.length) {
      const media = element('div', 'result-media');
      job.media.forEach((item, index) => {
        const figure = element('figure');
        const preview = element(item.kind === 'video' ? 'video' : 'img');
        preview.src = mediaUrl(item.url);
        if (item.kind === 'video') {
          preview.controls = true; preview.preload = 'metadata';
          preview.addEventListener('error', () => console.warn('FLOW_MEDIA_ERROR ' + JSON.stringify({code:preview.error?.code,message:preview.error?.message,supported:preview.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')})));
        }
        else preview.alt = job.prompt;
        const failure = element('p', 'inline-error', 'Предпросмотр не загрузился. Попробуйте сохранить файл');
        failure.hidden = true;
        preview.addEventListener('error', () => { failure.hidden = false; });
        const actions = element('div', 'media-actions');
        const save = button('Сохранить как…', 'small secondary', async () => {
          save.disabled = true;
          try {
            const saved = await api.saveMedia({ jobId: job.id, index });
            if (saved?.path) {
              const current = state.jobs.find(entry => entry.id === job.id)?.media?.[index];
              if (current) current.savedPath = saved.path;
              if (state.selectedJobId === job.id) renderResult();
              notify('Файл сохранён');
            }
          }
          catch (error) { notify(errorMessage(error), true); }
          finally { save.disabled = false; }
        });
        actions.append(save);
        if (item.savedPath) actions.append(button('Открыть папку', 'small secondary', async () => { try { await api.revealFile(item.savedPath); } catch (error) { notify(errorMessage(error), true); } }));
        figure.append(preview, failure, actions);
        media.append(figure);
      });
      result.append(media);
    } else {
      const panel = element('div', 'job-failed');
      panel.append(element('h3', '', 'Нет файла результата'), element('p', 'inline-error', 'Генерация завершилась без доступного файла'), button('Редактировать запрос', 'secondary', () => reuse(job)));
      result.append(panel);
    }
    const details = element('div', 'result-details');
    const meta = element('div', 'meta');
    const model = state.models.find(item => item.id === job.model) || { id: job.model, description: job.model };
    meta.append(element('span', '', modelInfo(model).label), element('span', '', duration(job.elapsedSeconds) || date(job.createdAt)));
    details.append(meta, element('p', '', job.prompt), button('Использовать запрос', '', () => reuse(job)));
    result.append(details);
  }
  function updateElapsed() {
    const job = state.jobs.find(item => item.id === state.selectedJobId);
    if (!$('elapsed') || !job) return;
    const start = new Date(job.createdAt).getTime();
    $('elapsed').textContent = Number.isFinite(start) ? `Прошло ${duration(Math.max(0, (Date.now() - start) / 1000))}` : '';
  }
  function renderHistory() {
    $('history-count').textContent = numbers.format(state.jobs.length);
    $('history').replaceChildren();
    if (!state.jobs.length) {
      const empty = element('div', 'empty-section');
      empty.append(element('h3', '', 'Пока нет генераций'), element('p', '', 'Создайте изображение или видео — результат появится здесь'), button('Создать первое', 'primary', () => page('create')));
      $('history').append(empty);
      return;
    }
    for (const job of state.jobs) {
      const card = button('', 'history-card', () => { state.selectedJobId = job.id; renderResult(); page('create'); });
      const first = job.media?.[0];
      if (first?.url) {
        const image = element(first.kind === 'video' ? 'video' : 'img', `history-preview${first.kind === 'video' ? ' video' : ''}`);
        image.src = mediaUrl(first.url);
        if (first.kind === 'video') { image.preload = 'metadata'; image.muted = true; image.setAttribute('aria-hidden', 'true'); }
        else { image.alt = ''; image.loading = 'lazy'; }
        card.append(image);
      } else card.append(element('div', `history-preview${job.status === 'failed' ? ' history-failed' : ''}`, job.status === 'running' ? 'Генерация идет…' : job.status === 'failed' ? 'Не получилось' : 'Нет предпросмотра'));
      const content = element('div', 'history-card-content');
      const meta = element('div');
      meta.append(element('span', '', job.kind === 'video' ? 'Видео' : 'Изображение'), element('time', '', date(job.createdAt)));
      content.append(element('p', '', job.prompt), meta);
      card.append(content);
      $('history').append(card);
    }
  }
  function renderAccounts() {
    $('accounts-count').textContent = numbers.format(state.accounts.length);
    const active = state.accounts.filter(account => account.isActive).length;
    const countWord = { one: 'аккаунт', few: 'аккаунта', many: 'аккаунтов', other: 'аккаунта' }[new Intl.PluralRules('ru-RU').select(active)];
    $('account-summary').textContent = !state.accounts.length ? 'Подключить аккаунт' : `Для генерации: ${active} ${countWord}`;
    $('accounts-list').replaceChildren();
    if (!state.accounts.length) {
      const empty = element('div', 'empty-section');
      empty.append(element('h3', '', 'Подключите первый аккаунт'), element('p', '', 'Откроется Chrome. Войдите в Google и откройте Flow. Затем нажмите «Я вошёл»'));
      $('accounts-list').append(empty);
    }
    for (const account of state.accounts) {
      const row = element('article', 'account-card');
      const identity = element('div', 'account-identity');
      const status = element('p');
      status.append(element('span', `badge${account.isActive ? '' : ' inactive'}`, account.isActive ? 'Включен для генерации' : 'Выключен для генерации'));
      if (account.videoEnabled === false) status.append(document.createTextNode(' · Видео недоступно'));
      identity.append(element('h3', '', account.email || `Аккаунт ${account.id}`), status);
      const check = state.accountChecks.get(String(account.id));
      const connection = element('p', `account-connection${check?.status === 'verified' ? ' verified' : check?.status === 'error' ? ' failed' : ''}`, state.checkingAccountId === account.id ? 'Проверяем подключение…' : check?.status === 'verified' ? `Подключение проверено${check.checkedAt ? ` · ${date(check.checkedAt)}` : ''}` : check?.status === 'error' ? 'Подключение не подтверждено' : 'Вход ещё не проверен');
      connection.setAttribute('role', 'status');
      identity.append(connection);
      if (check?.status === 'error') {
        const details = element('details', 'error-details');
        details.append(element('summary', '', 'Причина ошибки'), element('pre', '', check.message));
        identity.append(details);
      }
      const balance = element('div', 'account-balance', account.credits !== null && account.credits !== undefined && Number.isFinite(Number(account.credits)) ? numbers.format(Number(account.credits)) : '—');
      balance.append(element('small', '', account.credits === null || account.credits === undefined ? 'Баланс неизвестен' : 'Кредиты'));
      const actions = element('div', 'account-actions');
      const toggle = element('label', 'account-switch');
      const input = element('input', 'account-toggle'); input.type = 'checkbox'; input.checked = account.isActive;
      input.setAttribute('role','switch'); input.setAttribute('aria-label',`Использовать ${account.email} для генерации`);
      input.addEventListener('change',()=>changeAccount(account.id,()=>api.setAccountActive(account.id,input.checked)));
      toggle.append(input,element('span','switch-track'),element('span','switch-label',account.isActive?'Включён':'Выключен'));
      actions.append(toggle);
      actions.append(button('Войти заново', 'small secondary reconnect', () => beginLogin(account.id)), button('Проверить подключение', 'small secondary check-account', () => checkAccount(account.id)),button('Удалить', 'small secondary delete-account', () => changeAccount(account.id,()=>api.deleteAccount(account.id),true)));
      row.append(element('div', 'avatar', (account.email || 'G').slice(0, 1)), identity, balance, actions);
      $('accounts-list').append(row);
    }
    renderLogin();
    updateGenerate();
  }
  function renderLogin() {
    const login = state.login;
    const busy = state.loginPending || ['opening', 'waiting', 'syncing'].includes(login?.state);
    const working = state.refreshPending || state.accountPending !== null || state.checkingAccountId !== null || Boolean(state.batchCheck?.running);
    $('refresh-accounts').disabled = !state.ready || state.startupPending || state.refreshPending || working || busy;
    $('check-enabled-accounts').disabled = !state.ready || state.startupPending || state.refreshPending || working || busy || Boolean(activeJob()) || !state.accounts.some(a=>a.isActive);
    $('check-enabled-accounts').textContent = state.batchCheck?.running ? 'Проверяем аккаунты…' : 'Проверить все включённые';
    const batch = state.batchCheck;
    $('account-check-progress').hidden = !batch;
    $('account-check-progress').textContent = batch ? batch.running ? `Проверено ${batch.checked} из ${batch.total}. Успешно: ${batch.verified}, ошибок: ${batch.failed}` : `Проверка завершена: ${batch.verified} успешно, ${batch.failed} с ошибками${batch.skipped ? ', пропущено: '+batch.skipped : ''}` : '';
    for(const node of document.querySelectorAll('.account-toggle'))node.disabled = !state.ready || working || busy;
    for(const node of document.querySelectorAll('.delete-account'))node.disabled = !state.ready || working || busy || Boolean(activeJob());
    $('add-account').disabled = busy || working || !state.ready;
    document.querySelectorAll('.reconnect').forEach(item => { item.disabled = busy || working || !state.ready; });
    document.querySelectorAll('.check-account').forEach(item => { item.disabled = busy || working || !state.ready; });
    $('login-panel').hidden = !login || login.state === 'cancelled';
    $('cancel-login').hidden = !busy;
    $('complete-login').hidden = !(login?.state === 'waiting' && login.canComplete === true);
    $('complete-login').disabled = state.loginPending;
    $('complete-login').textContent = login?.completeLabel || (login?.method === 'chrome' ? 'Проверить подключение' : 'Я вошёл');
    $('login-panel').classList.toggle('failed', login?.state === 'failed');
    $('login-title').textContent = ({ opening: 'Открываем Google', waiting: 'Завершите вход в браузере', syncing: 'Подключаем аккаунт', succeeded: 'Аккаунт подключен', failed: 'Аккаунт не подключен', cancelled: 'Вход отменен' })[login?.state] || '';
    $('login-message').textContent = login?.method === 'chrome' ? login.message || 'Войдите в нужный аккаунт Google в Chrome, откройте Flow и нажмите «Проверить подключение».' : login?.state === 'waiting' && login.canComplete === true ? 'Войдите в Google и откройте Flow. Затем нажмите «Я вошёл»' : login?.message || '';
  }
  function acceptLogin(login) {
    state.login = login;
    if (login?.state === 'succeeded') {
      const accountId = login.accountId ?? state.loginAccountId;
      if (accountId !== null && accountId !== undefined) state.accountChecks.set(String(accountId), { status: 'verified', checkedAt: login.checkedAt || new Date().toISOString() });
      renderAccounts();
    } else renderLogin();
  }
  async function recoverAccount(job) {
    page('accounts');
    const accountId = recoveryAccountId(job, state.accounts);
    const account = state.accounts.find(item => item.id === accountId);
    $('recovery-panel').hidden = false;
    $('recovery-account').textContent = account ? `Повторный вход: ${account.email || `Аккаунт ${account.id}`}` : job.accountId !== undefined && job.accountId !== null ? 'Аккаунт этой задачи не найден в списке. Проверьте адрес в Flow и выберите нужный аккаунт ниже.' : 'Выберите нужный аккаунт ниже и нажмите «Войти заново». По этой задаче нельзя однозначно определить аккаунт.';
    $('recovery-panel').focus();
    if (account) await beginLogin(account.id);
  }
  async function changeAccount(accountId,action,deleting=false) {
    if(state.refreshPending || state.accountPending !== null || state.batchCheck?.running || state.checkingAccountId !== null || state.loginPending || ['opening','waiting','syncing'].includes(state.login?.state) || !state.ready)return;
    state.accountPending=accountId;setError('accounts-error','');renderAccounts();
    try{
      const result=await action();
      if(result?.accounts){accountVersion++;state.accounts=result.accounts;}
      if(deleting&&result?.deleted)state.accountChecks.delete(String(accountId));
    }catch(error){setError('accounts-error',errorMessage(error));}
    finally{state.accountPending=null;renderAccounts();}
  }
  async function checkEnabledAccounts() {
    if(state.refreshPending || state.accountPending !== null || state.batchCheck?.running || state.checkingAccountId !== null || state.loginPending || ['opening','waiting','syncing'].includes(state.login?.state) || !state.ready || activeJob())return;
    state.batchCheck={running:true,total:state.accounts.filter(a=>a.isActive).length,checked:0,verified:0,failed:0,skipped:0};
    setError('accounts-error','');renderAccounts();
    try{
      const result=await api.checkEnabledAccounts();state.batchCheck=result;
      for(const item of result.results||[])state.accountChecks.set(String(item.accountId),item);
      if(result.failed)setError('accounts-error','Не все аккаунты подтвердили подключение. Причины указаны у каждого аккаунта.');
    }catch(error){setError('accounts-error',errorMessage(error));}
    finally{if(state.batchCheck)state.batchCheck.running=false;state.checkingAccountId=null;renderAccounts();}
  }
  async function checkAccount(accountId) {
    if (state.refreshPending || state.accountPending !== null || state.batchCheck?.running || state.checkingAccountId !== null || state.loginPending || ['opening', 'waiting', 'syncing'].includes(state.login?.state) || !state.ready) return;
    state.checkingAccountId = accountId;
    setError('accounts-error', '');
    renderAccounts();
    try {
      const result = await api.checkAccount(accountId);
      if (result?.ok !== true) throw new Error(result?.error || result?.message || 'Подключение не подтверждено');
      state.accountChecks.set(String(accountId), { status: 'verified', checkedAt: result.checkedAt || new Date().toISOString() });
    } catch (error) {
      state.accountChecks.set(String(accountId), { status: 'error', message: errorMessage(error) });
      setError('accounts-error', 'Подключение не подтверждено. Прочитайте причину у аккаунта. При ошибке входа нажмите «Войти заново».');
    } finally { state.checkingAccountId = null; renderAccounts(); }
  }
  async function beginLogin(accountId) {
    if (state.refreshPending || state.accountPending !== null || state.batchCheck?.running || state.loginPending || state.checkingAccountId !== null || ['opening', 'waiting', 'syncing'].includes(state.login?.state) || !state.ready) return;
    setError('accounts-error', '');
    state.loginPending = true;
    state.loginAccountId = accountId ?? null;
    if (accountId !== undefined) state.accountChecks.delete(String(accountId));
    renderAccounts();
    const version = loginVersion;
    try {
      const login = accountId === undefined ? await api.addAccount() : await api.reconnectAccount(accountId);
      if (version === loginVersion) acceptLogin(login);
    } catch (error) { setError('accounts-error', errorMessage(error)); }
    finally { state.loginPending = false; renderLogin(); }
  }
  async function start(retry = false) {
    state.startupPending = true;
    updateReady('Подключаем Flow…', false);
    const versions = { jobs: jobVersion, accounts: accountVersion, login: loginVersion };
    try {
      const data = await (retry ? api.retryStartup() : api.bootstrap());
      state.models = data.models || [];
      if (versions.accounts === accountVersion) state.accounts = data.accounts || [];
      if (versions.login === loginVersion) state.login = data.login || null;
      if (versions.jobs === jobVersion) state.jobs = data.history || [];
      else for (const job of data.history || []) if (!state.jobs.some(item => item.id === job.id)) state.jobs.push(job);
      state.jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      if (!state.selectedJobId) state.selectedJobId = state.jobs[0]?.id || null;
      state.startupPending = false;
      renderModels(); renderAccounts(); renderHistory(); renderResult();
      updateReady(data.message, data.ready);
    } catch (error) { state.startupPending = false; updateReady(errorMessage(error), false); }
  }
  async function generate(event) {
    event.preventDefault();
    if (state.submitting || state.importPending || state.accountPending !== null || state.batchCheck?.running || activeJob() || !state.ready) return;
    setError('form-error', '');
    let request;
    try { request = requestFor(selectedModel(), $('prompt').value, currentReferences(true), $('source-video-id').value); }
    catch (error) { setError('form-error', errorMessage(error)); return; }
    state.submitting = true;
    updateGenerate();
    try {
      const result = await api.generate(request);
      state.selectedJobId = result.jobId;
      renderResult();
    } catch (error) { setError('form-error', errorMessage(error)); }
    finally { state.submitting = false; updateGenerate(); }
  }
  function updatePromptCount() { $('prompt-count').textContent = numbers.format($('prompt').value.length); }

  for (const item of document.querySelectorAll('[data-page]')) item.addEventListener('click', () => page(item.dataset.page));
  for (const item of document.querySelectorAll('[data-help-target]')) item.addEventListener('click', () => {
    const target = $(item.dataset.helpTarget);
    if (!target) return;
    if (target.tagName === 'DETAILS') target.open = true;
    target.scrollIntoView({block:'start'});
    target.querySelector('summary')?.focus();
  });
  for (const item of document.querySelectorAll('[data-copy-target]')) item.addEventListener('click', async () => {
    const source = $(item.dataset.copyTarget);
    const feedback = $('help-copy-status');
    if (!source) return;
    item.disabled = true;
    try {
      await api.copyHelpText(source.textContent);
      if (feedback) feedback.textContent = 'Скопировано. Вставьте текст в Codex или настройки MCP.';
    } catch (error) {
      if (feedback) feedback.textContent = 'Не удалось скопировать. Выделите текст и нажмите ⌘C.';
    } finally { item.disabled = false; }
  });
  for (const item of document.querySelectorAll('[data-go-create]')) item.addEventListener('click', () => page('create'));
  for (const input of document.querySelectorAll('input[name="mode"]')) input.addEventListener('change', () => { state.mode = input.value; renderModels(); saveDraft(); });
  $('open-accounts').addEventListener('click', () => page('accounts'));
  $('dismiss-notice').addEventListener('click', () => { $('notice').hidden = true; });
  $('model').addEventListener('change', () => { const settings = selectedModel() && modelSettings(selectedModel()); if (state.mode === 'video' && settings && !settings.methods.includes(state.videoMethod)) state.videoMethod = settings.methods[0]; renderSettings(); updateModel(); saveDraft(); });
  for (const id of ['video-method','model-family','duration','aspect-ratio','resolution']) $(id).addEventListener('change', () => selectSettings(id));
  $('prompt').addEventListener('input', () => { updatePromptCount(); saveDraft(); });
  $('source-video-id').addEventListener('input', saveDraft);
  $('prompt').addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (!$('generate').disabled) $('generation-form').requestSubmit(); } });
  $('generation-form').addEventListener('submit', generate);
  $('retry-startup').addEventListener('click', () => start(true));
  $('pick-images').addEventListener('click', () => importReferences(info => api.pickImages({ allowVideos: info.supportsVideoReferences })));
  const isFileDrag = event => Array.from(event.dataTransfer?.types || []).includes('Files') || Boolean(event.dataTransfer?.files?.length);
  let dragDepth = 0;
  function clearDrag() { dragDepth = 0; $('references-field').classList.toggle('drag-over', false); }
  $('references-field').addEventListener('dragenter', event => {
    if (!isFileDrag(event)) return;
    event.preventDefault(); dragDepth++;
    $('references-field').classList.toggle('drag-over', !state.importPending);
  });
  $('references-field').addEventListener('dragleave', event => {
    if (!dragDepth) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) clearDrag();
  });
  $('references-field').addEventListener('dragover', event => {
    if (!isFileDrag(event)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = state.importPending ? 'none' : 'copy';
  });
  $('references-field').addEventListener('drop', async event => {
    event.preventDefault(); clearDrag();
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) { setError('form-error', 'Перетащите локальные фото или видео. Ссылки не поддерживаются'); return; }
    await importReferences(info => api.dropMedia(files, { allowVideos: info.supportsVideoReferences }));
  });
  for (const name of ['dragover', 'drop']) window.addEventListener(name, event => { if (isFileDrag(event)) event.preventDefault(); if (name === 'drop') clearDrag(); });
  window.addEventListener('dragend', clearDrag);
  for (const [index, id] of [[0,'start-frame'],[1,'end-frame']]) {
    $(id).addEventListener('dragover', event => { if (!isFileDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; $(id).classList.toggle('drag-over',true); });
    $(id).addEventListener('dragleave', () => $(id).classList.toggle('drag-over',false));
    $(id).addEventListener('drop', async event => {
      event.preventDefault(); $(id).classList.toggle('drag-over',false);
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length) { setError('form-error','Перетащите локальное изображение для кадра'); return; }
      await importFrame(index, () => api.dropMedia(files,{allowVideos:false}));
    });
  }
  $('add-account').addEventListener('click', () => beginLogin());
  $('check-enabled-accounts').addEventListener('click', checkEnabledAccounts);
  $('complete-login').addEventListener('click', async () => {
    if (state.loginPending || state.login?.state !== 'waiting' || state.login.canComplete !== true) return;
    state.loginPending = true;
    setError('accounts-error', '');
    renderLogin();
    const version = loginVersion;
    try {
      const login = await api.completeLogin();
      if (version === loginVersion) acceptLogin(login);
    } catch (error) { setError('accounts-error', errorMessage(error)); }
    finally { state.loginPending = false; renderLogin(); }
  });
  $('refresh-accounts').addEventListener('click', async () => {
    if (!state.ready || state.startupPending || state.refreshPending || state.accountPending !== null || state.batchCheck?.running || state.checkingAccountId !== null) return;
    state.refreshPending = true;
    renderLogin();
    setError('accounts-error', '');
    try { state.accounts = await api.refreshAccounts(); renderAccounts(); }
    catch (error) { setError('accounts-error', errorMessage(error)); }
    finally { state.refreshPending = false; renderLogin(); }
  });
  $('cancel-login').addEventListener('click', async () => {
    $('cancel-login').disabled = true;
    try { await api.cancelLogin(); state.login = { state: 'cancelled', message: '' }; renderLogin(); }
    catch (error) { setError('accounts-error', errorMessage(error)); }
    finally { $('cancel-login').disabled = false; }
  });
  renderResult(); renderHistory(); renderAccounts();
  if (!api) { state.startupPending = false; updateReady('Откройте Flow Studio как приложение', false); return; }
  unsubscribe = api.onEvent(event => {
    if (event.type === 'status') updateReady(event.message, event.ready);
    else if (event.type === 'job' && event.job) {
      jobVersion++;
      if (requiresLogin(event.job)) {
        const accountId = recoveryAccountId(event.job, state.accounts);
        if (accountId !== null) {
          state.accountChecks.set(String(accountId), { status: 'error', message: event.job.error || event.job.progress || 'Требуется повторный вход в Google' });
          renderAccounts();
        }
      }
      const index = state.jobs.findIndex(job => job.id === event.job.id);
      if (index < 0) state.jobs.unshift(event.job); else state.jobs[index] = event.job;
      if (event.job.status === 'running' || !state.selectedJobId) state.selectedJobId = event.job.id;
      renderHistory();
      if (event.job.id === state.selectedJobId) renderResult();
      updateGenerate();renderLogin();
    } else if (event.type === 'accounts') { accountVersion++; state.accounts = event.accounts || []; renderAccounts(); }
    else if (event.type === 'account-checks') {
      state.batchCheck=event;
      state.checkingAccountId=event.running&&event.status==='checking'?event.accountId:null;
      if(event.accountId!=null&&['verified','error'].includes(event.status))state.accountChecks.set(String(event.accountId),event);
      renderAccounts();
    }
    else if (event.type === 'login') { loginVersion++; acceptLogin(event.login); }
    else if (event.type === 'error') notify(event.message, true);
  });
  const timer = setInterval(updateElapsed, 1000);
  window.addEventListener('beforeunload', () => { clearInterval(timer); unsubscribe?.(); });
  start();
}
