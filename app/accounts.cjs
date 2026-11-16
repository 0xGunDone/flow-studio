'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { findChromeProfile } = require('./recovery.cjs');

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
  const listeners = new Set();
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
    listeners.clear();
    try { socket.close(); } catch {}
  };
  const abort = () => close();
  const client = {
    close,
    onEvent(listener) {
      if (typeof listener !== 'function') throw new TypeError('CDP event listener is required.');
      if (closed) throw failure('CDP_CLOSED', 'Соединение с Chrome закрыто.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(method, params = {}, sessionId) {
      checkSignal(signal);
      if (closed) return Promise.reject(failure('CDP_CLOSED', 'Соединение с Chrome закрыто.'));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const cdpMethod = typeof method === 'string' && /^[A-Z][A-Za-z0-9]{0,63}\.[a-z][A-Za-z0-9]{0,63}$/.test(method) ? method : 'CDP';
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(failure('CDP_TIMEOUT', 'Chrome не отвечает ('+cdpMethod+').'));
        }, 8000);
        pending.set(id, { resolve, reject, timer, sessionId, cdpMethod });
        try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch { clearTimeout(timer); pending.delete(id); reject(failure('CDP_CLOSED', 'Соединение с Chrome закрыто.')); }
      });
    },
  };
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (typeof message?.method === 'string' && message.id === undefined) {
      for (const listener of listeners) { try { listener(message); } catch {} }
      return;
    }
    const request = pending.get(message.id);
    if (!request || message.sessionId !== request.sessionId) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) {
      const cdpCode = Number.isSafeInteger(message.error.code) ? message.error.code : undefined;
      const error = failure('CDP_COMMAND', `Chrome не выполнил запрос (${request.cdpMethod}${cdpCode === undefined ? '' : `; code=${cdpCode}`}).`);
      error.cdpMethod = request.cdpMethod;
      if (cdpCode !== undefined) error.cdpCode = cdpCode;
      error.hiddenNeedsSeed = request.cdpMethod === 'Target.createTarget' && cdpCode === -32000 &&
        message.error.message === 'Hidden target can be created only when remote debugging is enabled';
      if (error.hiddenNeedsSeed) error.message = error.message.replace(').', '; hidden=requires-initial-page).');
      // Keep raw protocol messages internal: they may contain page or account data.
      const detail = [message.error.message, message.error.data].filter(value => typeof value === 'string').join(' ');
      error.hiddenUnsupported = request.cdpMethod === 'Target.createTarget' && (/\b(?:unknown|unrecognized|unrecognised|unsupported|unexpected)\s+(?:(?:field|parameter|option|property)\s*[:=]?\s*)?['"]?hidden\b/i.test(detail) ||
        /\bhidden\b['"]?(?:\s+(?:targets?|flag|option|parameter))?\s+(?:is\s+|are\s+)?(?:unsupported|not supported)\b/i.test(detail));
      request.reject(error);
    }
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

async function createBackgroundTarget(client) {
  const targetId = created => {
    if (typeof created.targetId !== 'string' || !/^[A-Za-z0-9-]+$/.test(created.targetId)) throw failure('CDP_TARGET', 'Chrome не создал вкладку Flow.');
    return created.targetId;
  };
  let created;
  try { created = await client.send('Target.createTarget', { url: FLOW_URL, background: true, hidden: true }); }
  catch (error) {
    if (error.hiddenNeedsSeed) {
      // Chrome 157 requires one frame target before hidden targets, even with CDP enabled.
      const seed = targetId(await client.send('Target.createTarget', { url: 'about:blank', background: true, newWindow: true, windowState: 'minimized' }));
      try { return targetId(await client.send('Target.createTarget', { url: FLOW_URL, background: true, hidden: true })); }
      finally { await client.send('Target.closeTarget', { targetId: seed }); }
    }
    if (!error.hiddenUnsupported) throw error;
    created = await client.send('Target.createTarget', { url: FLOW_URL, background: true });
  }
  return targetId(created);
}

/** Managed Chrome profiles belong only to this app. Credentials never pass through its UI.
 * syncAccount receives {email,cookies,expectedAccountId?,signal}; it must verify
 * backend identity before saving, and honor signal before any backend mutation.
 * Optional getAccount(id) returns {id,email} for regular Chrome metadata lookup.
 * External leases require visible Flow identity verification and never own Chrome.
 * Second argument supplies stdlib substitutes and shorter intervals for tests.
 */
function createAccountManager({ dataDir, chromePath, chromeDataDir, getAccount, syncAccount, onState = () => {}, onAccountsChanged = async () => {} }, deps = {}) {
  if (!path.isAbsolute(dataDir || '') || !path.isAbsolute(chromePath || '') || typeof syncAccount !== 'function') {
    throw new TypeError('Absolute dataDir, chromePath and syncAccount are required.');
  }
  if ((chromeDataDir !== undefined && !path.isAbsolute(chromeDataDir || '')) || (getAccount !== undefined && typeof getAccount !== 'function')) {
    throw new TypeError('Absolute chromeDataDir and getAccount callback are required for Chrome profiles.');
  }
  const launch = deps.spawn || spawn;
  const hostname = (deps.hostname || os.hostname)().toLowerCase().replace(/\.$/, '');
  const isProcessAlive = deps.isProcessAlive || (pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  });
  const fetchImpl = deps.fetch || globalThis.fetch;
  const WebSocketImpl = deps.WebSocket || globalThis.WebSocket;
  const pollMs = deps.pollMs ?? 1500;
  const startupTimeoutMs = deps.startupTimeoutMs ?? 30000;
  const loginTimeoutMs = deps.loginTimeoutMs ?? 15 * 60 * 1000;
  const backgroundTimeoutMs = deps.backgroundTimeoutMs ?? 45000;
  const syncIntervalMs = deps.syncIntervalMs ?? 10 * 60 * 1000;
  const generationStartupMs = deps.generationStartupMs ?? 250;
  const profilesDir = path.join(dataDir, 'chrome-profiles');
  const mappingFile = path.join(dataDir, 'google-accounts.json');
  let profiles = [];
  let initialized;
  let active = null;
  let stopped = false;
  let autoTimer;
  let backgroundController;
  let backgroundWork;
  let removingAccount = false;
  let generation = null;
  let shutdownWork;
  const pendingSyncs = new Map();
  const browsers = new Map();
  const generationHandles = new WeakMap();

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
    if (handle?.alive && !handle.intentionalExit) {
      // Never process-kill by name or PID from disk: only our ChildProcess handle.
      handle.intentionalExit = true;
      try { handle.child.kill('SIGTERM'); } catch {}
    }
  }
  async function stopBrowserAndWait(handle, signal) {
    if (!handle?.alive) return;
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
      if (session.generation && !debugging && !existing.debugging && !existing.intentionalExit) {
        session.browser = existing;
        return existing;
      }
      session.browser = existing;
      await stopBrowserAndWait(existing, session.controller.signal);
    }
    const profileDir = path.join(profilesDir, record.dir);
    const real = await directory(profileDir);
    if (path.dirname(real) !== await fs.realpath(profilesDir)) throw failure('PROFILE_PATH', 'Небезопасная папка профиля Chrome.');
    if (session.generation) {
      // An unowned Chrome may forward our launch to its process. Never adopt it.
      let lock, markers = false;
      for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        try {
          const stat = await fs.lstat(path.join(profileDir, name));
          markers = true;
          if (name === 'SingletonLock') lock = stat;
        }
        catch (error) { if (error.code === 'ENOENT') continue; throw failure('PROFILE_PATH', 'Не удалось проверить профиль Chrome.'); }
      }
      if (markers) {
        let dead = false;
        try {
          const target = lock?.isSymbolicLink() && await fs.readlink(path.join(profileDir, 'SingletonLock'));
          const match = typeof target === 'string' && /^(.+)-([1-9]\d*)$/.exec(target);
          const pid = match && Number(match[2]);
          if (match && match[1].toLowerCase().replace(/\.$/, '') === hostname && Number.isSafeInteger(pid) && pid <= 0x7fffffff) {
            dead = await isProcessAlive(pid) === false;
          }
        } catch {}
        // Only ESRCH proves a local stale lock. Let Chrome clean its own artifacts.
        if (!dead) throw failure('PROFILE_IN_USE', 'Этот профиль Chrome уже открыт. Закройте его и повторите генерацию.');
      }
      // Fresh endpoint must come from this launch, never an old or unowned Chrome.
      if (debugging) await fs.unlink(path.join(profileDir, 'DevToolsActivePort')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } else {
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
      await fs.unlink(path.join(profileDir, 'DevToolsActivePort')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    checkSignal(session.controller.signal);
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
          hiddenTarget = await createBackgroundTarget(browserClient);
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
    if (generation) throw failure('GENERATION_BUSY', 'Дождитесь завершения генерации в Chrome.');
    if (removingAccount) throw failure('ACCOUNT_BUSY', 'Дождитесь завершения удаления аккаунта.');
    if (active) return active.state;
    if (expectedAccountId != null && (!Number.isSafeInteger(expectedAccountId) || expectedAccountId <= 0)) throw new TypeError('Invalid account ID.');
    backgroundController?.abort(cancelled());
    const session = { controller: new AbortController(), expectedAccountId, background: false };
    active = session;
    const state = emit(session, 'opening', 'Открываем Google Chrome для входа…');
    session.work = run(session);
    return state;
  }
  async function autoSync() {
    if (stopped || active || backgroundWork || removingAccount || generation) return;
    backgroundController = new AbortController();
    backgroundWork = (async () => {
      await ready();
      // ponytail: one browser at a time; no concurrent foreground profile launches.
      for (const record of profiles.filter(profile => profile.accountId != null)) {
        if (stopped || active || removingAccount || generation || backgroundController.signal.aborted) break;
        if (!profiles.includes(record)) continue;
        await run({ controller: backgroundController, background: true, record });
      }
    })().catch(() => {}).finally(() => { backgroundWork = null; backgroundController = null; });
    await backgroundWork;
  }
  async function syncAccountNow(accountId) {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new TypeError('Invalid account ID.');
    if (stopped) throw failure('SHUTDOWN', 'Flow Studio закрывается.');
    if (generation) throw failure('GENERATION_BUSY', 'Дождитесь завершения генерации в Chrome.');
    if (removingAccount) throw failure('ACCOUNT_BUSY', 'Дождитесь завершения удаления аккаунта.');
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
  async function removeAccount(accountId, removeCallback) {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new TypeError('Invalid account ID.');
    if (typeof removeCallback !== 'function') throw new TypeError('removeCallback is required.');
    if (stopped) throw failure('SHUTDOWN', 'Flow Studio закрывается.');
    if (generation) throw failure('GENERATION_BUSY', 'Дождитесь завершения генерации в Chrome.');
    if (removingAccount) throw failure('ACCOUNT_BUSY', 'Дождитесь завершения удаления аккаунта.');
    if (active) throw failure('LOGIN_BUSY', 'Сначала завершите или отмените текущий вход в Google, затем повторите удаление аккаунта.');
    if (pendingSyncs.size) throw failure('SYNC_BUSY', 'Дождитесь завершения проверки аккаунта.');
    removingAccount = true;
    try {
      await ready();
      while (backgroundWork) await backgroundWork.catch(() => {});
      if (stopped) throw failure('SHUTDOWN', 'Flow Studio закрывается.');
      const result = await removeCallback(accountId);
      // Unlink the record, never the profile directory: a later login gets a fresh profile.
      profiles = profiles.filter(profile => profile.accountId !== accountId);
      await saveMappings();
      return result;
    } finally { removingAccount = false; }
  }
  async function openExternalGeneration(session, accountId, reuseExternal) {
    if (!chromeDataDir || !getAccount) throw failure('PROFILE_REQUIRED', 'Переподключите этот аккаунт через Google Chrome перед генерацией.');
    const signal = session.controller.signal;
    const accountEmail = async () => {
      const account = await withSignal(Promise.resolve().then(() => getAccount(accountId)), signal);
      const email = normalizedEmail(account?.email);
      if ((account?.id ?? account?.accountId) !== accountId || !email) throw failure('ACCOUNT_CHANGED', 'Аккаунт изменился или удалён. Выберите его заново.');
      return email;
    };
    const email = await accountEmail();
    const directory = await withSignal(findChromeProfile(chromeDataDir, email), signal);
    if (await accountEmail() !== email) throw failure('ACCOUNT_CHANGED', 'Аккаунт изменился или удалён. Выберите его заново.');
    if (!directory) throw failure('PROFILE_REQUIRED', 'Переподключите этот аккаунт через Google Chrome перед генерацией.');
    checkSignal(signal);
    if (!reuseExternal) try {
      // Regular Chrome and its new window remain user-owned, including after cancellation.
      const child = launch(chromePath, [`--profile-directory=${directory}`, '--new-window', FLOW_URL], { stdio: 'ignore', detached: true });
      child.unref?.();
      await withSignal(new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', () => reject(failure('CHROME_START', 'Не удалось открыть Google Chrome. Проверьте установку Chrome.')));
      }), signal);
    } catch (error) {
      checkSignal(signal);
      throw failure('CHROME_START', 'Не удалось открыть Google Chrome. Проверьте установку Chrome.');
    }
    checkSignal(signal);
    // Native UI must locate one Flow window and verify its visible email before actions.
    return Object.freeze({ external: true, accountId, email });
  }
  function reserveGeneration(accountId, signal, background) {
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new TypeError('Invalid account ID.');
    if (stopped) throw failure('SHUTDOWN', 'Flow Studio закрывается.');
    if (generation) throw failure('GENERATION_BUSY', 'Дождитесь завершения генерации в Chrome.');
    if (removingAccount) throw failure('ACCOUNT_BUSY', 'Дождитесь завершения удаления аккаунта.');
    if (active) throw failure('LOGIN_BUSY', 'Сначала завершите или отмените текущий вход в Google.');
    if (pendingSyncs.size) throw failure('SYNC_BUSY', 'Дождитесь завершения проверки аккаунта.');
    if (signal && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new TypeError('Invalid abort signal.');
    // ponytail: one generation lease across profiles; parallel work needs separate profile locks.
    const session = { controller: new AbortController(), generation: true, background };
    generation = session;
    const abort = () => session.controller.abort(signal.reason || cancelled());
    session.detachSignal = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    session.controller.signal.addEventListener('abort', () => stopBrowser(session.browser), { once: true });
    return session;
  }
  async function acquireGenerationBrowser(accountId, { signal, reuseExternal = false, resolveReuseExternal } = {}) {
    if (typeof reuseExternal !== 'boolean') throw new TypeError('Invalid external Chrome reuse option.');
    if (resolveReuseExternal !== undefined && typeof resolveReuseExternal !== 'function') throw new TypeError('Invalid external Chrome reuse resolver.');
    const session = reserveGeneration(accountId, signal, false);
    session.work = (async () => {
      try {
        const ownSignal = session.controller.signal;
        checkSignal(ownSignal);
        backgroundController?.abort(cancelled());
        while (backgroundWork) await withSignal(backgroundWork.catch(() => {}), ownSignal);
        await withSignal(ready(), ownSignal);
        checkSignal(ownSignal);
        if (resolveReuseExternal) {
          reuseExternal = await withSignal(resolveReuseExternal({ signal: ownSignal }), ownSignal);
          checkSignal(ownSignal);
          if (typeof reuseExternal !== 'boolean') throw new TypeError('Invalid resolved external Chrome reuse option.');
        }
        const record = profiles.find(profile => profile.accountId === accountId);
        let handle;
        if (!record) handle = await openExternalGeneration(session, accountId, reuseExternal);
        else {
          const browser = await openBrowser(record, session, false);
          // Chrome forwarding a launch to an existing process exits immediately.
          await delay(generationStartupMs, ownSignal);
          if (!browser.alive || browser.child.exitCode != null || browser.child.signalCode != null) {
            throw failure('PROFILE_IN_USE', 'Chrome не открыл отдельный процесс профиля. Закройте окно этого профиля и повторите генерацию.');
          }
          if (!Number.isSafeInteger(browser.child.pid) || browser.child.pid <= 0) throw failure('CHROME_START', 'Не удалось определить окно Google Chrome.');
          handle = Object.freeze({ pid: browser.child.pid, accountId: record.accountId, email: record.email });
        }
        generationHandles.set(handle, session);
        return handle;
      } catch (error) {
        await stopBrowserAndWait(session.browser, new AbortController().signal).catch(() => {});
        session.detachSignal();
        if (generation === session) generation = null;
        throw error;
      }
    })();
    return session.work;
  }
  async function releaseGenerationBrowser(handle, { close = true } = {}) {
    const session = handle && generationHandles.get(handle);
    if (!session || session.isolated) throw new TypeError('Invalid generation browser handle.');
    if (!session.releaseWork) session.releaseWork = (async () => {
      try {
        if (close) await stopBrowserAndWait(session.browser, new AbortController().signal);
      } finally {
        session.detachSignal();
        if (generation === session) generation = null;
      }
    })();
    return session.releaseWork;
  }
  function finishIsolatedGeneration(session) {
    if (!session.releaseWork) {
      session.releasing = true;
      session.releaseWork = (async () => {
        try {
          if (session.verificationWork) await session.verificationWork.catch(() => {});
          if (session.targetId && session.client && !session.controller.signal.aborted) {
            await session.client.send('Target.closeTarget', { targetId: session.targetId }).catch(() => {});
          }
        } finally {
          session.client?.close();
          try { await stopBrowserAndWait(session.browser, new AbortController().signal); }
          finally {
            session.detachSignal();
            if (generation === session) generation = null;
          }
        }
      })();
    }
    return session.releaseWork;
  }
  async function acquireIsolatedGenerationBrowser(accountId, { signal, windowMode } = {}) {
    if (windowMode !== undefined && windowMode !== 'offscreen') throw new TypeError('Invalid isolated browser window mode.');
    const session = reserveGeneration(accountId, signal, true);
    session.isolated = true;
    const ownSignal = session.controller.signal;
    ownSignal.addEventListener('abort', () => {
      session.client?.close();
      if (session.lease) void finishIsolatedGeneration(session).catch(() => {});
    }, { once: true });
    session.work = (async () => {
      let drainingBackground;
      try {
        checkSignal(ownSignal);
        drainingBackground = backgroundWork;
        backgroundController?.abort(cancelled());
        while (backgroundWork) await withSignal(backgroundWork.catch(() => {}), ownSignal);
        await withSignal(ready(), ownSignal);
        checkSignal(ownSignal);
        const record = profiles.find(profile => profile.accountId === accountId);
        if (!record) throw failure('PROFILE_REQUIRED', 'Подключите этот аккаунт через «Войти в Google» в Flow Studio перед фоновой генерацией.');
        session.browser = await openBrowser(record, session, true);
        await delay(generationStartupMs, ownSignal);
        const browser = session.browser;
        if (!browser.alive || browser.child.exitCode != null || browser.child.signalCode != null) {
          throw failure('PROFILE_IN_USE', 'Chrome не открыл отдельный процесс профиля. Закройте его и повторите генерацию.');
        }
        if (!Number.isSafeInteger(browser.child.pid) || browser.child.pid <= 0) throw failure('CHROME_START', 'Не удалось определить процесс Google Chrome.');
        session.client = await connectCDP(browser.browserURL, ownSignal, WebSocketImpl);
        if (windowMode === 'offscreen') {
          const created = await session.client.send('Target.createTarget', { url: FLOW_URL, newWindow: true, background: true });
          if (typeof created.targetId !== 'string' || !/^[A-Za-z0-9-]+$/.test(created.targetId)) throw failure('CDP_TARGET', 'Chrome не создал вкладку Flow.');
          session.targetId = created.targetId;
          const window = await session.client.send('Browser.getWindowForTarget', { targetId: session.targetId });
          if (!Number.isSafeInteger(window.windowId) || window.windowId < 0) throw failure('CDP_TARGET', 'Chrome не подтвердил окно Flow.');
          await session.client.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { left: -10000, top: 0, width: 1280, height: 900, windowState: 'normal' } });
        } else session.targetId = await createBackgroundTarget(session.client);
        const attached = await session.client.send('Target.attachToTarget', { targetId: session.targetId, flatten: true });
        if (typeof attached.sessionId !== 'string' || !/^[A-Za-z0-9-]+$/.test(attached.sessionId)) throw failure('CDP_TARGET', 'Chrome не подключился к вкладке Flow.');
        session.sessionId = attached.sessionId;
        checkSignal(ownSignal);
        const client = Object.freeze({
          send(method, params = {}) {
            if (session.releasing) return Promise.reject(failure('CDP_CLOSED', 'Соединение с Chrome закрыто.'));
            return session.client.send(method, params, session.sessionId);
          },
          withVerificationPage(callback) {
            if (typeof callback !== 'function') return Promise.reject(new TypeError('Verification callback is required.'));
            if (session.releasing || generation !== session) return Promise.reject(failure('CDP_CLOSED', 'Соединение с Chrome закрыто.'));
            if (session.verificationWork) return Promise.reject(failure('VERIFICATION_BUSY', 'Дождитесь завершения проверки аккаунта.'));
            const work = (async () => {
              let targetId, sessionId, active = true;
              try {
                checkSignal(ownSignal);
                const created = await createBackgroundTarget(session.client);
                if (created === session.targetId) throw failure('CDP_TARGET', 'Chrome не создал отдельную вкладку проверки аккаунта.');
                targetId = created;
                checkSignal(ownSignal);
                if (session.releasing) throw failure('CDP_CLOSED', 'Соединение с Chrome закрыто.');
                const attached = await session.client.send('Target.attachToTarget', { targetId, flatten: true });
                if (typeof attached.sessionId !== 'string' || !/^[A-Za-z0-9-]+$/.test(attached.sessionId) || attached.sessionId === session.sessionId) throw failure('CDP_TARGET', 'Chrome не подключился к отдельной вкладке проверки аккаунта.');
                sessionId = attached.sessionId;
                checkSignal(ownSignal);
                const verificationClient = Object.freeze({
                  send(method, params = {}) {
                    if (!['Runtime.evaluate', 'Emulation.setDeviceMetricsOverride'].includes(method)) return Promise.reject(new TypeError('Unsupported verification page command.'));
                    if (!active) return Promise.reject(failure('CDP_CLOSED', 'Вкладка проверки аккаунта закрыта.'));
                    return session.client.send(method, params, sessionId);
                  },
                });
                return await withSignal(Promise.resolve().then(() => callback(verificationClient)), ownSignal);
              } finally {
                active = false;
                if (!ownSignal.aborted) {
                  if (sessionId) { try { await session.client.send('Target.detachFromTarget', { sessionId }); } catch {} }
                  if (targetId) { try { await session.client.send('Target.closeTarget', { targetId }); } catch {} }
                }
              }
            })();
            session.verificationWork = work;
            return work.finally(() => { if (session.verificationWork === work) session.verificationWork = null; });
          },
          browserSend(method, params = {}) {
            if (!['Browser.setDownloadBehavior', 'Browser.cancelDownload'].includes(method)) return Promise.reject(new TypeError('Unsupported browser command.'));
            if (session.releasing) return Promise.reject(failure('CDP_CLOSED', 'Соединение с Chrome закрыто.'));
            return session.client.send(method, params);
          },
          onEvent(listener) {
            if (typeof listener !== 'function') throw new TypeError('CDP event listener is required.');
            if (session.releasing) throw failure('CDP_CLOSED', 'Соединение с Chrome закрыто.');
            return session.client.onEvent(event => {
              if (event.sessionId === session.sessionId || (!event.sessionId && ['Browser.downloadWillBegin', 'Browser.downloadProgress'].includes(event.method))) {
                listener({ method: event.method, params: event.params || {} });
              }
            });
          },
        });
        session.lease = Object.freeze({ accountId: record.accountId, email: record.email, targetId: session.targetId, sessionId: session.sessionId, signal: ownSignal, client });
        generationHandles.set(session.lease, session);
        return session.lease;
      } catch (error) {
        // An aborted sync owns its browser until cleanup ends, even if this acquire was cancelled.
        if (drainingBackground) await drainingBackground.catch(() => {});
        await finishIsolatedGeneration(session).catch(() => {});
        throw error;
      }
    })();
    return session.work;
  }
  async function releaseIsolatedGenerationBrowser(lease) {
    const session = lease && generationHandles.get(lease);
    if (!session?.isolated) throw new TypeError('Invalid isolated generation browser lease.');
    return finishIsolatedGeneration(session);
  }
  return {
    async hasAccountProfile(id) { await ready(); return profiles.some(profile => profile.accountId === id); },
    syncAccountNow,
    removeAccount,
    acquireGenerationBrowser,
    releaseGenerationBrowser,
    acquireIsolatedGenerationBrowser,
    releaseIsolatedGenerationBrowser,
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
      if (shutdownWork) return shutdownWork;
      stopped = true;
      clearInterval(autoTimer);
      active?.controller.abort(cancelled());
      backgroundController?.abort(cancelled());
      generation?.controller.abort(cancelled());
      shutdownWork = Promise.allSettled([
        active?.work, backgroundWork, generation?.work, generation?.releaseWork,
        ...[...browsers.values()].map(browser => stopBrowserAndWait(browser, new AbortController().signal)),
      ]).then(() => { generation?.detachSignal(); generation = null; });
      return shutdownWork;
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
