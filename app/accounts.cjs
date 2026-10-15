'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const FLOW_URL = 'https://flow.google.com/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const GOOGLE_SESSION = new Set(['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID']);
const IDENTITY_EXPRESSION = `(() => {
  if (location.origin !== 'https://flow.google.com') return null;
  const email = globalThis.WIZ_global_data?.oPEP7c;
  return typeof email === 'string' ? { email, origin: location.origin } : null;
})()`;

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function cancelled() { return failure('CANCELLED', 'Вход отменён.'); }
function checkSignal(signal) { if (signal.aborted) throw signal.reason || cancelled(); }
function normalizedEmail(value) {
  return typeof value === 'string' && value.length <= 320 && EMAIL.test(value.trim()) ? value.trim().toLowerCase() : null;
}
function isFlowURL(value) {
  try { const url = new URL(value); return url.origin === 'https://flow.google.com' && !url.username && !url.password; }
  catch { return false; }
}
function scopedCookies(cookies, now = Date.now() / 1000) {
  if (!Array.isArray(cookies)) return [];
  return cookies.filter(cookie => {
    if (!cookie || typeof cookie.domain !== 'string' || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') return false;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name) || /[\r\n\x00]/.test(cookie.value)) return false;
    // Keep non-Secure Google session cookies too. Host-only google.com is not Flow.
    const domain = cookie.domain.toLowerCase();
    if (!['flow.google.com', '.flow.google.com', '.google.com'].includes(domain)) return false;
    if (cookie.hostOnly && domain.replace(/^\./, '') !== 'flow.google.com') return false;
    if (cookie.path && cookie.path !== '/') return false;
    if (cookie.partitionKey || cookie.partitionKeyOpaque || cookie.partitioned) return false;
    return !Number.isFinite(cookie.expires) || cookie.expires <= 0 || cookie.expires > now;
  }).map(cookie => {
    const result = {};
    for (const key of ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite', 'priority', 'session']) {
      if (cookie[key] !== undefined) result[key] = cookie[key];
    }
    return result;
  });
}
function hasSession(cookies) {
  return cookies.some(cookie => ['OSID', '__Secure-OSID'].includes(cookie.name) && cookie.value) &&
    cookies.some(cookie => GOOGLE_SESSION.has(cookie.name) && cookie.value);
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason || cancelled());
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason || cancelled()); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
function withSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason || cancelled());
    const abort = () => reject(signal.reason || cancelled());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function validSocket(value, port, kind) {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      Number(url.port) === port && !url.username && !url.password && !url.search && !url.hash &&
      new RegExp(`^/devtools/${kind}/[A-Za-z0-9-]+$`).test(url.pathname);
  } catch { return false; }
}

async function connectCDP(url, signal, WebSocketImpl) {
  if (typeof WebSocketImpl !== 'function') throw failure('NO_WEBSOCKET', 'Обновите Flow Studio: недоступно подключение к Chrome.');
  checkSignal(signal);
  const socket = new WebSocketImpl(url);
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  let rejectOpening;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', abort);
    const error = signal.aborted ? signal.reason || cancelled() : failure('CDP_CLOSED', 'Соединение с Chrome закрыто.');
    rejectOpening?.(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    try { socket.close(); } catch {}
  };
  const abort = () => close();
  const client = {
    close,
    send(method, params = {}) {
      checkSignal(signal);
      if (closed) return Promise.reject(failure('CDP_CLOSED', 'Соединение с Chrome закрыто.'));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(failure('CDP_TIMEOUT', 'Chrome не отвечает.'));
        }, 8000);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch { clearTimeout(timer); pending.delete(id); reject(failure('CDP_CLOSED', 'Соединение с Chrome закрыто.')); }
      });
    },
  };
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(failure('CDP_COMMAND', 'Chrome не выполнил запрос.'));
    else request.resolve(message.result || {});
  });
  socket.addEventListener('close', close);
  socket.addEventListener('error', close);
  signal.addEventListener('abort', abort, { once: true });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { close(); }, 8000);
    rejectOpening = error => { clearTimeout(timer); reject(error); };
    socket.addEventListener('open', () => { clearTimeout(timer); rejectOpening = null; resolve(); }, { once: true });
    if (signal.aborted) close();
  });
  return client;
}

/** Chrome profiles belong only to this app. Credentials never pass through its UI.
 * syncAccount receives {email,cookies,expectedAccountId?,signal}; it must verify
 * backend identity before saving, and honor signal before any backend mutation.
 * Second argument supplies stdlib substitutes and shorter intervals for tests.
 */
function createAccountManager({ dataDir, chromePath, syncAccount, onState = () => {}, onAccountsChanged = async () => {} }, deps = {}) {
  if (!path.isAbsolute(dataDir || '') || !path.isAbsolute(chromePath || '') || typeof syncAccount !== 'function') {
    throw new TypeError('Absolute dataDir, chromePath and syncAccount are required.');
  }
  const launch = deps.spawn || spawn;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const WebSocketImpl = deps.WebSocket || globalThis.WebSocket;
  const pollMs = deps.pollMs ?? 1500;
  const startupTimeoutMs = deps.startupTimeoutMs ?? 30000;
  const loginTimeoutMs = deps.loginTimeoutMs ?? 15 * 60 * 1000;
  const backgroundTimeoutMs = deps.backgroundTimeoutMs ?? 45000;
  const syncIntervalMs = deps.syncIntervalMs ?? 10 * 60 * 1000;
  const profilesDir = path.join(dataDir, 'chrome-profiles');
  const mappingFile = path.join(dataDir, 'google-accounts.json');
  let profiles = [];
  let initialized;
  let active = null;
  let stopped = false;
  let autoTimer;
  let backgroundController;
  let backgroundWork;
  const pendingSyncs = new Map();
  const browsers = new Map();

  const emit = (session, state, message, extra = {}) => {
    const value = { state, message, ...extra };
    session.state = value;
    if (!session.background && active === session) { try { onState(value); } catch {} }
    return value;
  };
  async function directory(location) {
    await fs.mkdir(location, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(location);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('PROFILE_PATH', 'Папка профилей Chrome недоступна или небезопасна.');
    await fs.access(location, fs.constants.R_OK | fs.constants.W_OK);
    await fs.chmod(location, 0o700);
    return fs.realpath(location);
  }
  async function prepare() {
    const base = await directory(dataDir);
    const managed = await directory(profilesDir);
    if (path.dirname(managed) !== base) throw failure('PROFILE_PATH', 'Папка профилей Chrome находится вне Flow Studio.');
    try {
      const stat = await fs.lstat(mappingFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw failure('MAPPINGS_INVALID', 'Повреждён список профилей Google.');
      const stored = JSON.parse(await fs.readFile(mappingFile, 'utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.profiles) || stored.profiles.length > 100) throw new Error();
      const ids = new Set(), accounts = new Set(), emails = new Set();
      for (const record of stored.profiles) {
        if (!record || !UUID.test(record.profileId) || record.dir !== record.profileId || ids.has(record.profileId)) throw new Error();
        if (record.accountId != null && (!Number.isSafeInteger(record.accountId) || record.accountId <= 0 || accounts.has(record.accountId))) throw new Error();
        if (record.email != null && (!normalizedEmail(record.email) || normalizedEmail(record.email) !== record.email || emails.has(record.email))) throw new Error();
        if ((record.accountId == null) !== (record.email == null)) throw new Error();
        ids.add(record.profileId);
        if (record.accountId != null) { accounts.add(record.accountId); emails.add(record.email); }
        const resolved = await directory(path.join(profilesDir, record.dir));
        if (path.dirname(resolved) !== managed) throw new Error();
      }
      profiles = stored.profiles.map(({ profileId, dir, accountId, email }) => ({ profileId, dir, accountId: accountId ?? null, email: email ?? null }));
      await fs.chmod(mappingFile, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') throw failure('MAPPINGS_INVALID', 'Не удалось прочитать профили Google. Существующие данные сохранены.');
    }
  }
  function ready() { return initialized ||= prepare(); }
  async function saveMappings() {
    const temporary = `${mappingFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, profiles }), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, mappingFile);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async function profileFor(accountId) {
    let record = profiles.find(profile => accountId != null && profile.accountId === accountId);
    if (!record) record = profiles.find(profile => profile.accountId == null);
    if (!record) {
      const profileId = randomUUID();
      record = { profileId, dir: profileId, accountId: null, email: null };
      await directory(path.join(profilesDir, profileId));
      profiles.push(record);
      await saveMappings();
    }
    return record;
  }
  async function jsonAt(port, suffix, signal) {
    const response = await fetchImpl(`http://127.0.0.1:${port}${suffix}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]), redirect: 'error',
    });
    if (!response.ok) throw failure('CDP_HTTP', 'Chrome не отвечает.');
    return response.json();
  }
  async function endpoint(profileDir) {
    const file = path.join(profileDir, 'DevToolsActivePort');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw failure('CDP_ENDPOINT', 'Не удалось безопасно подключиться к Chrome.');
    const [rawPort, socketPath] = (await fs.readFile(file, 'utf8')).trim().split(/\r?\n/);
    const port = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(socketPath)) {
      throw failure('CDP_ENDPOINT', 'Не удалось безопасно подключиться к Chrome.');
    }
    return { port, browserURL: `ws://127.0.0.1:${port}${socketPath}` };
  }
  function stopBrowser(handle) {
    if (handle?.alive) {
      // Never process-kill by name or PID from disk: only our ChildProcess handle.
      handle.intentionalExit = true;
      try { handle.child.kill('SIGTERM'); } catch {}
    }
  }
  async function stopBrowserAndWait(handle, signal) {
    if (!handle?.alive) return;
    handle.intentionalExit = true;
    stopBrowser(handle);
    let timer;
    try {
      await withSignal(Promise.race([
        handle.closed,
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(failure('CHROME_CLOSE_TIMEOUT', 'Chrome не закрылся. Закройте окно этого профиля и повторите подключение.')), 10000); }),
      ]), signal);
    } finally { clearTimeout(timer); }
  }
  async function openBrowser(record, session, debugging = true) {
    checkSignal(session.controller.signal);
    const existing = browsers.get(record.profileId);
    if (existing?.alive) {
      if (debugging && existing.debugging && !existing.intentionalExit) return existing;
      await stopBrowserAndWait(existing, session.controller.signal);
    }
    const profileDir = path.join(profilesDir, record.dir);
    const real = await directory(profileDir);
    if (path.dirname(real) !== await fs.realpath(profilesDir)) throw failure('PROFILE_PATH', 'Небезопасная папка профиля Chrome.');
    // A crash may have left an app profile open. Do not adopt or kill an unknown process.
    try {
      const old = await endpoint(profileDir);
      let running = false;
      try { running = Boolean(await jsonAt(old.port, '/json/version', session.controller.signal)); } catch {}
      if (running) throw failure('PROFILE_IN_USE', 'Этот профиль Chrome уже открыт. Закройте его и повторите вход.');
    } catch (error) {
      if (error.code === 'PROFILE_IN_USE' || error.code === 'CDP_ENDPOINT') throw error;
      if (error.code !== 'ENOENT') checkSignal(session.controller.signal);
    }
    checkSignal(session.controller.signal);
    await fs.unlink(path.join(profileDir, 'DevToolsActivePort')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const args = [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check'];
    if (debugging) args.push('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0');
    if (session.background) args.push('--no-startup-window');
    else args.push('--new-window', FLOW_URL);
    let child;
    try { child = launch(chromePath, args, { stdio: 'ignore' }); }
    catch { throw failure('CHROME_START', 'Не удалось открыть Google Chrome. Проверьте, что Chrome установлен.'); }
    const handle = { child, alive: true, record, debugging, port: null, browserURL: null };
    let resolveClosed;
    handle.closed = new Promise(resolve => { resolveClosed = resolve; });
    browsers.set(record.profileId, handle);
    session.browser = handle;
    session.launchedBrowser = true;
    const exited = () => {
      handle.alive = false;
      resolveClosed();
      if (browsers.get(record.profileId) === handle) browsers.delete(record.profileId);
      if (!handle.intentionalExit && active?.browser === handle && ['opening', 'waiting', 'syncing'].includes(active.state?.state)) {
        active.controller.abort(failure('BROWSER_CLOSED', 'Chrome закрыт до завершения входа. Нажмите «Войти в Google», чтобы повторить.'));
      }
    };
    child.once('exit', exited);
    child.once('error', exited);
    if (!debugging) {
      await withSignal(new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', () => reject(failure('CHROME_START', 'Не удалось открыть Google Chrome. Проверьте установку Chrome.')));
      }), session.controller.signal);
      return handle;
    }
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      checkSignal(session.controller.signal);
      if (!handle.alive) throw failure('CHROME_START', 'Chrome не запустился. Закройте окно этого профиля и повторите вход.');
      try {
        Object.assign(handle, await endpoint(profileDir));
        await jsonAt(handle.port, '/json/version', session.controller.signal);
        return handle;
      } catch (error) {
        if (error.code === 'CDP_ENDPOINT') throw error;
        checkSignal(session.controller.signal);
      }
      await delay(Math.min(pollMs, 200), session.controller.signal);
    }
    throw failure('CHROME_TIMEOUT', 'Chrome не запустился вовремя. Проверьте установку Chrome и повторите вход.');
  }
  async function readIdentity(client) {
    const result = await client.send('Runtime.evaluate', { expression: IDENTITY_EXPRESSION, returnByValue: true });
    const identity = result.result?.value;
    if (identity?.origin !== 'https://flow.google.com' || result.exceptionDetails) return null;
    return normalizedEmail(identity.email);
  }
  async function capture(handle, record, signal, targetId) {
    const targets = await jsonAt(handle.port, '/json/list', signal);
    if (!Array.isArray(targets)) return null;
    if (!targetId && !targets.some(target => target.type === 'page')) throw failure('BROWSER_CLOSED', 'Окно Chrome закрыто до завершения входа. Повторите вход.');
    const pages = targets.filter(target => isFlowURL(target.url) && (targetId ? target.id === targetId : target.type === 'page'));
    for (const page of pages) {
      if (!validSocket(page.webSocketDebuggerUrl, handle.port, 'page')) continue;
      const client = await connectCDP(page.webSocketDebuggerUrl, signal, WebSocketImpl);
      try {
        const email = await readIdentity(client);
        if (!email) continue;
        if (record.email && record.email !== email) throw failure('ACCOUNT_MISMATCH', `Открыт ${email}. Для этого профиля войдите в ${record.email}.`);
        const result = await client.send('Network.getCookies', { urls: [FLOW_URL] });
        const cookies = scopedCookies(result.cookies);
        if (!hasSession(cookies) || await readIdentity(client) !== email) continue;
        return { email, cookies };
      } finally { client.close(); }
    }
    return null;
  }
  async function syncCaptured(session, record, captured) {
    const signal = session.controller.signal;
    checkSignal(signal);
    const collision = profiles.find(other => other !== record && other.email === captured.email);
    if (collision) throw failure('ACCOUNT_EXISTS', `${captured.email} уже добавлен. Используйте «Переподключить» для этого аккаунта.`);
    emit(session, 'syncing', 'Вход выполнен. Проверяем подключение к Flow…', { email: captured.email });
    let result;
    try {
      result = await withSignal(syncAccount({ ...captured, expectedAccountId: session.expectedAccountId ?? record.accountId ?? undefined, signal }), signal);
    } catch (error) {
      checkSignal(signal);
      // Backend errors may contain headers or cookies; never forward their text.
      throw failure('SYNC_FAILED', 'Не удалось подключить аккаунт к Flow. Проверьте доступ к Flow в Chrome и повторите вход.');
    }
    checkSignal(signal);
    const expected = session.expectedAccountId ?? record.accountId;
    if (!result || !Number.isSafeInteger(result.accountId) || result.accountId <= 0 || normalizedEmail(result.email) !== captured.email || (expected != null && expected !== result.accountId)) {
      throw failure('ACCOUNT_MISMATCH', 'Flow подтвердил другой аккаунт. Подключение не сохранено.');
    }
    if (profiles.some(other => other !== record && other.accountId === result.accountId)) throw failure('ACCOUNT_EXISTS', 'Этот аккаунт уже связан с другим профилем Flow Studio.');
    record.email = captured.email;
    record.accountId = result.accountId;
    await saveMappings();
    checkSignal(signal);
    emit(session, 'succeeded', 'Аккаунт подключён. Можно создавать изображения и видео.', { email: record.email, accountId: record.accountId });
    try { await onAccountsChanged(); } catch {}
  }
  async function run(session) {
    let browserClient, hiddenTarget;
    const signal = session.controller.signal;
    try {
      if (!session.background && backgroundWork) await backgroundWork.catch(() => {});
      await ready();
      checkSignal(signal);
      const record = session.record || await profileFor(session.expectedAccountId);
      checkSignal(signal);
      if (!session.background) {
        await openBrowser(record, session, false);
        checkSignal(signal);
        let confirmationTimer;
        const confirmation = new Promise((resolve, reject) => {
          session.confirm = resolve;
          confirmationTimer = setTimeout(() => reject(failure('LOGIN_TIMEOUT', 'Вход не завершён за 15 минут. Профиль сохранён — повторите вход.')), loginTimeoutMs);
        });
        emit(session, 'waiting', 'Войдите в Google в Chrome и откройте Flow. Затем вернитесь сюда и нажмите «Я вошёл».', { canComplete: true });
        try { await withSignal(confirmation, signal); }
        finally { clearTimeout(confirmationTimer); session.confirm = null; }
        await stopBrowserAndWait(session.browser, signal);
      }
      const alreadyOpen = Boolean(browsers.get(record.profileId)?.alive && browsers.get(record.profileId)?.debugging);
      const handle = await openBrowser(record, session);
      session.browser = handle;
      session.launchedBrowser = !alreadyOpen;
      checkSignal(signal);
      if (session.background || alreadyOpen) {
        browserClient = await connectCDP(handle.browserURL, signal, WebSocketImpl);
        if (session.background) {
          let created;
          try {
            created = await browserClient.send('Target.createTarget', { url: FLOW_URL, background: true, hidden: true });
          } catch (error) {
            if (error.code !== 'CDP_COMMAND') throw error;
            created = await browserClient.send('Target.createTarget', { url: FLOW_URL, background: true });
          }
          if (typeof created.targetId !== 'string' || !/^[A-Za-z0-9-]+$/.test(created.targetId)) throw failure('CDP_TARGET', 'Chrome не создал вкладку Flow.');
          hiddenTarget = created.targetId;
        } else {
          await browserClient.send('Target.createTarget', { url: FLOW_URL, newWindow: true, background: false });
        }
      }
      emit(session, 'syncing', 'Проверяем подключённый аккаунт Flow…');
      const deadline = Date.now() + backgroundTimeoutMs;
      while (Date.now() < deadline) {
        checkSignal(signal);
        if (!handle.alive) throw failure('BROWSER_CLOSED', 'Chrome закрыт до завершения входа. Повторите вход.');
        let captured;
        try { captured = await capture(handle, record, signal, hiddenTarget); }
        catch (error) {
          if (['ACCOUNT_MISMATCH', 'BROWSER_CLOSED'].includes(error.code) || signal.aborted) throw error;
          // Navigation tears down execution contexts; retry while user signs in.
        }
        if (captured) { await syncCaptured(session, record, captured); return; }
        await delay(pollMs, signal);
      }
      throw failure('CAPTURE_TIMEOUT', 'Вход в Flow не подтверждён. Нажмите «Войти в Google», завершите вход в Chrome и снова нажмите «Я вошёл».');
    } catch (error) {
      session.errorCode = error.code || 'CONNECTION_FAILED';
      // Let user fix account/access problems in the same visible Chrome profile.
      session.keepBrowser = !session.background && ['ACCOUNT_MISMATCH', 'ACCOUNT_EXISTS', 'SYNC_FAILED', 'CAPTURE_TIMEOUT'].includes(error.code);
      if (session.state?.state !== 'cancelled') {
        emit(session, 'failed', error.code ? error.message : 'Не удалось подключить Google. Проверьте Chrome и повторите вход.');
      }
    } finally {
      if (session.background) {
        await fs.writeFile(path.join(dataDir, 'last-background-sync.json'), JSON.stringify({
          at: new Date().toISOString(), accountId: session.record?.accountId,
          state: session.state?.state, code: session.errorCode || null,
          message: session.state?.message || ''
        }), {mode:0o600}).catch(() => {});
      }
      if (hiddenTarget && browserClient && !signal.aborted) await browserClient.send('Target.closeTarget', { targetId: hiddenTarget }).catch(() => {});
      browserClient?.close();
      if ((session.background && session.launchedBrowser) || (!session.background && session.state?.state === 'succeeded')) {
        // Successful login needs no visible window; wait for owned Chrome before releasing the slot.
        await stopBrowserAndWait(session.browser, new AbortController().signal).catch(() => {});
      } else if (!session.background && session.state?.state !== 'succeeded' && !session.keepBrowser) stopBrowser(session.browser);
      if (active === session) active = null;
    }
  }
  function begin(expectedAccountId) {
    if (stopped) throw failure('SHUTDOWN', 'Flow Studio закрывается.');
    if (active) return active.state;
    if (expectedAccountId != null && (!Number.isSafeInteger(expectedAccountId) || expectedAccountId <= 0)) throw new TypeError('Invalid account ID.');
    backgroundController?.abort(cancelled());
    const session = { controller: new AbortController(), expectedAccountId, background: false };
    active = session;
    const state = emit(session, 'opening', 'Открываем Google Chrome для входа…');
    void run(session);
    return state;
  }
  async function autoSync() {
    if (stopped || active || backgroundWork) return;
    backgroundController = new AbortController();
    backgroundWork = (async () => {
      await ready();
      // ponytail: one browser at a time; no concurrent foreground profile launches.
      for (const record of profiles.filter(profile => profile.accountId != null)) {
        if (stopped || active || backgroundController.signal.aborted) break;
        await run({ controller: backgroundController, background: true, record });
      }
    })().catch(() => {}).finally(() => { backgroundWork = null; backgroundController = null; });
    await backgroundWork;
  }
  async function syncAccountNow(accountId) {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new TypeError('Invalid account ID.');
    if (stopped) throw failure('SHUTDOWN', 'Flow Studio закрывается.');
    if (active) throw failure('LOGIN_BUSY', 'Сначала завершите или отмените текущий вход в Google, затем повторите проверку аккаунта.');
    if (pendingSyncs.has(accountId)) return pendingSyncs.get(accountId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(failure('SYNC_TIMEOUT', 'Обновление сессии Chrome не завершилось вовремя. Повторите проверку аккаунта.')), startupTimeoutMs + backgroundTimeoutMs + 10000);
    const work = (async () => {
      await withSignal(ready(), controller.signal);
      if (stopped) throw failure('SHUTDOWN', 'Flow Studio закрывается.');
      if (active) throw failure('LOGIN_BUSY', 'Сначала завершите или отмените текущий вход в Google, затем повторите проверку аккаунта.');
      const record = profiles.find(profile => profile.accountId === accountId);
      if (!record) return { synced: false };
      while (backgroundWork) {
        await withSignal(backgroundWork.catch(() => {}), controller.signal);
        if (stopped) throw failure('SHUTDOWN', 'Flow Studio закрывается.');
        if (active) throw failure('LOGIN_BUSY', 'Сначала завершите или отмените текущий вход в Google, затем повторите проверку аккаунта.');
      }
      checkSignal(controller.signal);
      if (stopped) throw failure('SHUTDOWN', 'Flow Studio закрывается.');
      if (active) throw failure('LOGIN_BUSY', 'Сначала завершите или отмените текущий вход в Google, затем повторите проверку аккаунта.');
      const session = { controller, background: true, record, expectedAccountId: accountId };
      backgroundController = controller;
      backgroundWork = run(session).then(() => {
        if (session.state?.state !== 'succeeded') throw failure(session.errorCode || 'SYNC_FAILED', session.state?.message || 'Не удалось обновить сессию Chrome. Повторите вход в Google.');
        return { synced: true, accountId };
      }).finally(() => { backgroundWork = null; backgroundController = null; });
      return withSignal(backgroundWork, controller.signal);
    })().finally(() => { clearTimeout(timer); pendingSyncs.delete(accountId); });
    pendingSyncs.set(accountId, work);
    return work;
  }
  return {
    async hasAccountProfile(id) { await ready(); return profiles.some(profile => profile.accountId === id); },
    syncAccountNow,
    addAccount: () => begin(),
    reconnectAccount: id => begin(id),
    completeLogin() {
      if (!active) throw failure('NO_LOGIN', 'Сначала нажмите «Войти в Google».');
      if (active.state?.state !== 'waiting' || !active.confirm) return active.state;
      const state = emit(active, 'syncing', 'Сохраняем вход и подключаем аккаунт Flow…');
      active.confirm();
      return state;
    },
    cancelLogin() {
      if (active) {
        const session = active;
        emit(session, 'cancelled', 'Вход отменён. Профиль Chrome сохранён.');
        session.controller.abort(cancelled());
        stopBrowser(session.browser);
      }
      return { cancelled: true };
    },
    shutdown() {
      stopped = true;
      clearInterval(autoTimer);
      active?.controller.abort(cancelled());
      backgroundController?.abort(cancelled());
      for (const browser of browsers.values()) stopBrowser(browser);
    },
    startAutoSync() {
      if (autoTimer || stopped) return;
      autoTimer = setInterval(() => { void autoSync(); }, syncIntervalMs);
      autoTimer.unref?.();
      void autoSync();
    },
  };
}

module.exports = { createAccountManager, _test: { scopedCookies, hasSession, normalizedEmail, isFlowURL, validSocket } };
