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
  const resolution = id.match(/(?:-|_)(2k|4k|1080p)(?:-|_|$)/i)?.[1].toUpperCase();
  let name = description.split(' · ')[0].replace(' - ', ' ').replace(/\s+(?:I2V|R2V|Extend|Edit)$/, '');
  if (/generation\s*-/.test(name)) name = id;
  const operation = edit ? 'Редактирование' : extend ? 'Продолжение' : i2v ? 'По кадрам' : r2v ? 'По образцам' : '';
  const maxImages = kind === 'image' ? 5 : omni ? edit ? 5 : 7 : r2v ? 3 : i2v ? (/interpolation/.test(id) ? 2 : /(?:_|-)i2v(?:_|-)lite(?:_|-)/.test(id) ? 1 : 2) : 0;
  const minImages = r2v || i2v ? (/interpolation/.test(id) ? 2 : 1) : 0;
  const maxVideos = edit ? 1 : 0;
  const maxReferences = maxImages + maxVideos;
  const requiredTier = /^veo/.test(id) && ['4','6'].includes(seconds) ? 'Ultra' : '';
  const label = [name, operation, seconds ? `${seconds}\u00a0с` : '', aspect, resolution, requiredTier].filter(Boolean).join(' · ');
  return { id, kind, extend, i2v, r2v, omni, edit, maxImages, minImages, maxVideos, minVideos: edit ? 1 : 0, maxReferences, supportsVideoReferences: maxVideos > 0, requiredTier, label, aspect, seconds, resolution };
}

function referenceKind(reference) {
  return reference.kind || (/^data:video\//i.test(reference.dataUrl || '') ? 'video' : 'image');
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
    return { mode: draft?.mode === 'video' ? 'video' : 'image', model: text('model', 512), prompt: text('prompt', 16000), sourceVideoId: text('sourceVideoId', 2048) };
  } catch { return { mode: 'image', model: '', prompt: '', sourceVideoId: '' }; }
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

if (typeof module !== 'undefined' && module.exports) module.exports = { modelInfo, requestFor, mediaUrl, readDraft, requiresLogin, recoveryAccountId, errorMessage };
if (typeof document !== 'undefined') initialize();

function initialize() {
  const $ = id => document.getElementById(id);
  const api = window.flowStudio;
  const state = { ready: false, models: [], accounts: [], jobs: [], login: null, references: [], mode: 'image', selectedJobId: null, submitting: false, loginPending: false, loginAccountId: null, checkingAccountId: null, accountChecks: new Map(), startupPending: true };
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
  $('prompt').value = draft.prompt;
  $('source-video-id').value = draft.sourceVideoId;
  for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === state.mode;
  updatePromptCount();

  function saveDraft() {
    draft.model = $('model').value || draft.model;
    try { draftStorage?.setItem('flowStudio.draft', JSON.stringify({ mode: state.mode, model: draft.model, prompt: $('prompt').value, sourceVideoId: $('source-video-id').value })); } catch { /* A full or disabled store must not block generation. */ }
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
    $('generate').disabled = !state.ready || !selectedModel() || running || !available;
    $('generate-label').textContent = running ? 'Генерация идет…' : state.mode === 'video' ? 'Создать видео' : 'Создать изображение';
    $('generate-hint').textContent = !state.ready ? 'Ожидаем подключения Flow' : running ? 'Ход генерации виден справа' : !available ? 'Подключите активный аккаунт в разделе «Аккаунты»' : '⌘ Enter — создать';
  }
  function renderModels() {
    const previous = $('model').value || draft.model;
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
      const preferred = models.find(model => model.id === (state.mode === 'image' ? 'gemini-3.1-flash-image-landscape' : 'veo-3.1-fast-8s-landscape'));
      if (preferred) $('model').value = preferred.id;
    }
    $('model').disabled = !models.length;
    updateModel();
  }
  function updateModel() {
    const info = modelInfo(selectedModel());
    $('source-field').hidden = !info.extend;
    $('source-video-id').required = info.extend;
    $('pick-images-label').textContent = info.supportsVideoReferences ? 'Добавить фото или видео' : 'Добавить изображения';
    $('model-description').textContent = !selectedModel() ? '' : info.edit ? 'Редактирует исходное видео по вашему запросу и образцам' : info.extend ? 'Продолжает исходное видео по вашему запросу' : info.i2v ? 'Первое изображение — начальный кадр, второе — конечный' : info.r2v ? 'Использует изображения как образцы для видео' : info.omni ? 'По тексту или по тексту с изображениями' : info.kind === 'image' ? 'По тексту или с исходными изображениями' : 'Видео по текстовому описанию';
    $('references-hint').textContent = info.edit ? '1 исходное видео MP4, MOV или M4V до 10 с и до 5 изображений. Порядок образцов сохраняется' : info.i2v ? 'Порядок изображений задает начальный и конечный кадры' : info.minImages ? `От ${info.minImages} до ${info.maxImages} изображений` : info.maxImages ? `До ${info.maxImages} изображений, если нужны` : 'Эта модель не использует исходные изображения';
    renderReferences();
    setError('form-error', referenceError(info, state.references));
    updateGenerate();
  }
  function renderReferences() {
    const info = modelInfo(selectedModel());
    $('references').replaceChildren();
    const videos = state.references.filter(reference => referenceKind(reference) === 'video').length;
    const images = state.references.length - videos;
    $('references-field').hidden = !selectedModel() || (!info.maxReferences && !state.references.length);
    $('references-label').textContent = info.supportsVideoReferences || videos ? 'Исходные фото и видео' : 'Исходные изображения';
    $('references-count').textContent = info.maxVideos || videos ? `${images} / ${info.maxImages} фото · ${videos} / ${info.maxVideos} видео` : `${images} / ${info.maxImages}`;
    function changed() { renderReferences(); setError('form-error', referenceError(info, state.references)); }
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
    $('pick-images').disabled = state.references.length >= info.maxReferences;
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
    if (model) {
      state.mode = modelInfo(model).kind;
      for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === state.mode;
      renderModels();
      $('model').value = model.id;
    }
    $('prompt').value = job.prompt;
    state.references = [];
    $('source-video-id').value = '';
    updateModel();
    updatePromptCount();
    saveDraft();
    page('create');
    $('prompt').focus();
    notify('Запрос перенесен в редактор. Добавьте исходные изображения или ID видео заново, если они нужны');
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
      actions.append(button('Войти заново', 'small secondary reconnect', () => beginLogin(account.id)), button('Проверить подключение', 'small secondary check-account', () => checkAccount(account.id)));
      row.append(element('div', 'avatar', (account.email || 'G').slice(0, 1)), identity, balance, actions);
      $('accounts-list').append(row);
    }
    renderLogin();
    updateGenerate();
  }
  function renderLogin() {
    const login = state.login;
    const busy = state.loginPending || ['opening', 'waiting', 'syncing'].includes(login?.state);
    $('add-account').disabled = busy || state.checkingAccountId !== null || !state.ready;
    document.querySelectorAll('.reconnect').forEach(item => { item.disabled = busy || state.checkingAccountId !== null || !state.ready; });
    document.querySelectorAll('.check-account').forEach(item => { item.disabled = busy || state.checkingAccountId !== null || !state.ready; });
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
  async function checkAccount(accountId) {
    if (state.checkingAccountId !== null || state.loginPending || ['opening', 'waiting', 'syncing'].includes(state.login?.state) || !state.ready) return;
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
    if (state.loginPending || state.checkingAccountId !== null || ['opening', 'waiting', 'syncing'].includes(state.login?.state) || !state.ready) return;
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
    if (state.submitting || activeJob() || !state.ready) return;
    setError('form-error', '');
    let request;
    try { request = requestFor(selectedModel(), $('prompt').value, state.references, $('source-video-id').value); }
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
  $('model').addEventListener('change', () => { updateModel(); saveDraft(); });
  $('prompt').addEventListener('input', () => { updatePromptCount(); saveDraft(); });
  $('source-video-id').addEventListener('input', saveDraft);
  $('prompt').addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (!$('generate').disabled) $('generation-form').requestSubmit(); } });
  $('generation-form').addEventListener('submit', generate);
  $('retry-startup').addEventListener('click', () => start(true));
  $('pick-images').addEventListener('click', async () => {
    $('pick-images').disabled = true;
    try {
      const references = await api.pickImages({ allowVideos: modelInfo(selectedModel()).supportsVideoReferences });
      const key = reference => referenceKind(reference) === 'video' ? `video:${reference.path}` : `image:${reference.dataUrl}`;
      const seen = new Set(state.references.map(key));
      const unique = references.filter(reference => { const value = key(reference); if (seen.has(value)) return false; seen.add(value); return true; });
      const invalid = referenceError(modelInfo(selectedModel()), [...state.references, ...unique]);
      if (invalid) setError('form-error', invalid);
      else { state.references.push(...unique); setError('form-error', ''); }
    } catch (error) { setError('form-error', errorMessage(error)); }
    finally { renderReferences(); }
  });
  $('add-account').addEventListener('click', () => beginLogin());
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
    $('refresh-accounts').disabled = true;
    setError('accounts-error', '');
    try { state.accounts = await api.refreshAccounts(); renderAccounts(); }
    catch (error) { setError('accounts-error', errorMessage(error)); }
    finally { $('refresh-accounts').disabled = false; }
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
      updateGenerate();
    } else if (event.type === 'accounts') { accountVersion++; state.accounts = event.accounts || []; renderAccounts(); }
    else if (event.type === 'login') { loginVersion++; acceptLogin(event.login); }
    else if (event.type === 'error') notify(event.message, true);
  });
  const timer = setInterval(updateElapsed, 1000);
  window.addEventListener('beforeunload', () => { clearInterval(timer); unsubscribe?.(); });
  start();
}
