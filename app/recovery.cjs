'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FLOW_URL = 'https://flow.google.com/projects';
const PROFILE = /^(?:Default|Profile [0-9]+)$/;
const ACCOUNT_CHANGED_MESSAGE = 'Аккаунт изменился или удалён. Выберите аккаунт заново и повторите вход.';
const emailOf = value => typeof value === 'string' && value.length <= 320 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.trim()) ? value.trim().toLowerCase() : null;
const failure = (code, message) => Object.assign(new Error(message), { code });

function withSignal(work, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { Promise.resolve(work).catch(() => {}); return reject(signal.reason); }
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Only Local State's profile metadata is inspected. No profile or credential files.
async function findChromeProfile(chromeDataDir, email) {
  let file;
  try {
    file = await fs.open(path.join(chromeDataDir, 'Local State'), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    const cache = JSON.parse(await file.readFile('utf8'))?.profile?.info_cache;
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return null;
    const matches = Object.entries(cache).filter(([directory, metadata]) => {
      if (!PROFILE.test(directory) || directory.length > 64 || !metadata || typeof metadata !== 'object') return false;
      const emails = new Set([metadata.email, metadata.user_name, metadata.gaia_name].map(emailOf).filter(Boolean));
      return emails.size === 1 && emails.has(email);
    });
    return matches.length === 1 ? matches[0][0] : null;
  } catch { return null; }
  finally { await file?.close().catch(() => {}); }
}

/** verifyAccount(id, {signal}) must perform a read-only server check and return
 * {ok:true, accountId:id, email} only after confirming the connected identity.
 * listAccounts() returns [{id,email}]; accountId is accepted in place of id.
 */
function createRecoveryManager({ chromeDataDir, chromePath, listAccounts, verifyAccount, onState = () => {}, deps = {} }, overrides = {}) {
  if (!path.isAbsolute(chromeDataDir || '') || !path.isAbsolute(chromePath || '') || typeof listAccounts !== 'function' || typeof verifyAccount !== 'function') {
    throw new TypeError('Absolute chromeDataDir, chromePath, listAccounts and verifyAccount are required.');
  }
  deps = { ...deps, ...overrides };
  const launch = deps.spawn || spawn;
  const pollMs = deps.pollMs ?? 5000;
  const initialPollMs = deps.initialPollMs ?? 30000;
  const timeoutMs = deps.timeoutMs ?? 15 * 60 * 1000;
  const verifyTimeoutMs = deps.verifyTimeoutMs ?? 15000;
  let active = null, lastState = null, stopped = false;

  function emit(session, state, message, code) {
    if (active !== session || session.controller.signal.aborted) return session.state;
    const value = { state, method: 'chrome', accountId: session.accountId, email: session.email,
      canComplete: state === 'waiting', completeLabel: 'Проверить подключение', message, ...(code ? { code } : {}) };
    session.state = lastState = value;
    try { onState(value); } catch {}
    return value;
  }
  async function accountFor(session, signal = session.controller.signal) {
    const accounts = await withSignal(listAccounts(), signal);
    const matches = Array.isArray(accounts) ? accounts.filter(account => (account?.id ?? account?.accountId) === session.accountId) : [];
    const email = matches.length === 1 ? emailOf(matches[0].email) : null;
    if (!email || (session.email && session.email !== email)) throw failure('ACCOUNT_CHANGED', ACCOUNT_CHANGED_MESSAGE);
    return email;
  }
  function schedule(session, delay = pollMs) {
    clearTimeout(session.timer);
    if (active !== session || session.controller.signal.aborted || session.state?.state !== 'waiting' || pollMs <= 0) return;
    const remaining = session.deadline - Date.now();
    if (remaining <= 0) {
      emit(session, 'waiting', 'Автопроверка завершена. Завершите вход в Flow в Chrome, затем нажмите «Проверить подключение».');
      return;
    }
    session.timer = setTimeout(() => {
      if (Date.now() >= session.deadline) schedule(session);
      else void verify();
    }, Math.min(delay, remaining));
    session.timer.unref?.();
  }
  async function open(session, directory) {
    let child;
    try {
      child = launch(chromePath, [`--profile-directory=${directory}`, '--new-window', FLOW_URL], { stdio: 'ignore', detached: true });
      child.unref?.();
      await withSignal(new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      }), session.controller.signal);
    } catch {
      throw failure('CHROME_START', 'Не удалось открыть Google Chrome. Проверьте установку Chrome и повторите вход.');
    }
  }
  async function start(session) {
    try {
      session.email = await accountFor(session);
      if (active !== session || session.controller.signal.aborted) return session.state || null;
      const directory = await findChromeProfile(chromeDataDir, session.email);
      if (active !== session || session.controller.signal.aborted) return session.state || null;
      if (!directory) { active = null; return null; }
      await accountFor(session);
      if (active !== session || session.controller.signal.aborted) return session.state || null;
      emit(session, 'opening', 'Открываем ваш профиль Google Chrome…');
      await open(session, directory);
      if (active !== session || session.controller.signal.aborted) return session.state || null;
      session.deadline = Date.now() + timeoutMs;
      const state = emit(session, 'waiting', `В Chrome войдите в ${session.email} и откройте Flow. Подождите 30 секунд для синхронизации расширения и нажмите «Проверить подключение».`);
      schedule(session, initialPollMs);
      return state;
    } catch (error) {
      if (active !== session || session.controller.signal.aborted) return session.state || null;
      const state = emit(session, 'failed', error?.code === 'ACCOUNT_CHANGED' ? ACCOUNT_CHANGED_MESSAGE : 'Не удалось открыть вход в Google. Проверьте Chrome и повторите попытку.', error?.code === 'ACCOUNT_CHANGED' ? error.code : 'CHROME_START');
      active = null;
      return state;
    }
  }
  function begin(accountId) {
    if (stopped) throw failure('SHUTDOWN', 'Flow Studio закрывается.');
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new TypeError('Invalid account ID.');
    if (active?.accountId === accountId) return active.starting || Promise.resolve(active.state);
    cancel();
    const session = { accountId, controller: new AbortController() };
    active = session;
    session.starting = start(session).finally(() => { session.starting = null; });
    return session.starting;
  }
  function verify() {
    const session = active;
    if (!session || !session.state || session.starting) return Promise.resolve(session?.state || lastState);
    if (session.work) return session.work;
    clearTimeout(session.timer);
    emit(session, 'syncing', 'Проверяем подключение к Flow…');
    const controller = new AbortController();
    const abort = () => controller.abort(session.controller.signal.reason);
    session.controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(failure('VERIFY_TIMEOUT', 'Проверка заняла слишком много времени.')), verifyTimeoutMs);
    timer.unref?.();
    session.work = (async () => {
      try {
        await accountFor(session, controller.signal);
        const result = await withSignal(verifyAccount(session.accountId, { signal: controller.signal }), controller.signal);
        await accountFor(session, controller.signal);
        if (active !== session || session.controller.signal.aborted) return session.state;
        if (result?.ok === true && result.accountId === session.accountId && emailOf(result.email) === session.email) {
          const state = emit(session, 'succeeded', 'Подключение проверено. Вернитесь к работе в Flow Studio.');
          active = null;
          return state;
        }
        return emit(session, 'waiting', `Подключение ещё не подтверждено. В Chrome проверьте вход в ${session.email}, откройте Flow и повторите проверку.`, 'NOT_VERIFIED');
      } catch (error) {
        if (active !== session || session.controller.signal.aborted) return session.state;
        if (error?.code === 'ACCOUNT_CHANGED') {
          const state = emit(session, 'failed', ACCOUNT_CHANGED_MESSAGE, error.code);
          active = null;
          return state;
        }
        return emit(session, 'waiting', 'Не удалось проверить подключение. Завершите вход в Flow в Chrome, проверьте соединение и нажмите «Проверить подключение».', 'VERIFY_FAILED');
      } finally {
        clearTimeout(timer);
        session.controller.signal.removeEventListener('abort', abort);
        session.work = null;
        schedule(session);
      }
    })();
    return session.work;
  }
  function cancel() {
    if (!active) return { cancelled: true };
    const session = active;
    const state = emit(session, 'cancelled', 'Вход отменён. Окно Chrome осталось открытым.');
    clearTimeout(session.timer);
    session.controller.abort(failure('CANCELLED', 'Вход отменён.'));
    active = null;
    return state;
  }
  return { begin, verify, cancel, shutdown() { stopped = true; cancel(); }, get active() { return Boolean(active); }, get state() { return lastState; } };
}

module.exports = { createRecoveryManager };
