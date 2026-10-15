'use strict';

// Original Flow Studio extension. Local endpoint is intentionally not configurable.
const API_URL = 'http://127.0.0.1:38000/api/plugin/update-token';
const FLOW_URL = 'https://flow.google.com/projects';
const PERIODIC_ALARM = 'flow-studio-periodic';
const CHANGE_ALARM = 'flow-studio-cookie-change';
const STATUS = {
  saved: 'Настройки сохранены.',
  busy: 'Синхронизация уже идёт.',
  working: 'Проверяем вход в Google Flow…',
  success: 'Вход обновлён в Flow Studio.',
  unchanged: 'Данные входа не изменились. Сервер не проверялся.',
  settings: 'Укажите адрес Google-аккаунта и токен подключения.',
  cookies: 'Войдите в Google Flow в этом профиле Chrome, затем повторите.',
  login: 'Flow не подтвердил вход. Откройте Flow и войдите в нужный аккаунт.',
  rejected: 'Сервер не подтвердил аккаунт. Проверьте выбранную почту и вход в Flow.',
  auth: 'Проверьте токен подключения из настроек локального сервера.',
  network: 'Нет связи с локальным Flow Studio. Запустите приложение и повторите.',
  failed: 'Синхронизация не завершилась. Откройте Flow Studio и повторите.'
};
let active = false;
let saving = false;
let scheduling = null;

function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function matchesFlow(cookie, now = Date.now() / 1000) {
  if (!cookie || cookie.partitionKey != null || cookie.partitionKeyOpaque || cookie.partitioned) return false;
  const host = 'flow.google.com';
  const domain = String(cookie.domain || '').toLowerCase().replace(/^\./, '');
  if (!domain || (cookie.hostOnly ? host !== domain : host !== domain && !host.endsWith('.' + domain))) return false;
  const path = cookie.path || '/';
  if ('/projects' !== path && !('/projects'.startsWith(path) && (path.endsWith('/') || '/projects'.slice(path.length).startsWith('/')))) return false;
  if (cookie.expirationDate != null && cookie.expirationDate <= now) return false;
  return typeof cookie.name === 'string' && !!cookie.name && typeof cookie.value === 'string';
}

function exportCookies(cookies) {
  const fields = ['name', 'value', 'domain', 'path', 'hostOnly', 'secure', 'httpOnly', 'sameSite', 'session', 'expirationDate'];
  return cookies.filter(cookie => matchesFlow(cookie)).map(cookie => Object.fromEntries(fields.filter(key => Object.hasOwn(cookie, key)).map(key => [key, cookie[key]])));
}

async function fingerprint(cookies) {
  const canonical = cookies.map(cookie => JSON.stringify(cookie)).sort().join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function setStatus(code) {
  const status = {code, message: STATUS[code] || STATUS.failed, at: Date.now()};
  await chrome.storage.local.set({lastStatus: status});
  return status;
}

function waitForTab(tabId) {
  return new Promise((resolve, reject) => {
    const finish = (error, tab) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updated);
      chrome.tabs.onRemoved.removeListener(removed);
      error ? reject(error) : resolve(tab);
    };
    const updated = (id, change, tab) => { if (id === tabId && change.status === 'complete') finish(null, tab); };
    const removed = id => { if (id === tabId) finish(new Error('login')); };
    const timer = setTimeout(() => finish(new Error('login')), 20000);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    chrome.tabs.get(tabId).then(tab => { if (tab.status === 'complete') finish(null, tab); }).catch(() => finish(new Error('login')));
  });
}

async function syncSession(force = false) {
  if (active || saving) return {code: 'busy', message: STATUS.busy};
  active = true;
  let tabId;
  try {
    const config = await chrome.storage.local.get(['connectionToken', 'loginAccount', 'lastFingerprint']);
    if (!validEmail(config.loginAccount) || typeof config.connectionToken !== 'string' || !config.connectionToken) return await setStatus('settings');
    await chrome.alarms.clear(CHANGE_ALARM);
    await setStatus('working');
    const tab = await chrome.tabs.create({url: FLOW_URL, active: false});
    tabId = tab.id;
    const loaded = await waitForTab(tabId);
    if (new URL(loaded.url || '').origin !== 'https://flow.google.com') throw new Error('login');
    await new Promise(resolve => setTimeout(resolve, 1500));
    const cookies = exportCookies(await chrome.cookies.getAll({url: FLOW_URL}));
    const names = new Set(cookies.map(cookie => cookie.name));
    if (![...names].some(name => name === 'OSID' || name === '__Secure-OSID') || !['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'].some(name => names.has(name))) throw new Error('cookies');
    const signature = await fingerprint(cookies);
    if (!force && signature === config.lastFingerprint) return await setStatus('unchanged');
    let response;
    try {
      response = await fetch(API_URL, {
        method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + config.connectionToken},
        body: JSON.stringify({google_cookies: JSON.stringify(cookies), login_account: config.loginAccount, protocol_mode: 'protocol'}),
        signal: AbortSignal.timeout(25000)
      });
    } catch { throw new Error('network'); }
    if (response.status === 401 || response.status === 403) throw new Error('auth');
    if (response.status === 400 || response.status === 422) throw new Error('rejected');
    if (!response.ok) throw new Error('failed');
    const body = await response.json().catch(() => null);
    if (body?.success !== true) throw new Error('failed');
    await chrome.storage.local.set({lastFingerprint: signature});
    return await setStatus('success');
  } catch (error) {
    return await setStatus(Object.hasOwn(STATUS, error.message) ? error.message : 'failed');
  } finally {
    if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
    active = false;
  }
}

async function saveSettings(input) {
  if (active || saving) return {code: 'busy', message: STATUS.busy};
  saving = true;
  try {
    const loginAccount = typeof input?.loginAccount === 'string' ? input.loginAccount.trim().toLowerCase() : '';
    const previous = await chrome.storage.local.get('connectionToken');
    const connectionToken = typeof input?.connectionToken === 'string' && input.connectionToken.trim() ? input.connectionToken.trim() : previous.connectionToken;
    if (!validEmail(loginAccount) || typeof connectionToken !== 'string' || !connectionToken || connectionToken.length > 4096 || /[\r\n]/.test(connectionToken)) return await setStatus('settings');
    await chrome.storage.local.set({loginAccount, connectionToken, lastFingerprint: ''});
    await ensureAlarm();
  } finally { saving = false; }
  return syncSession(true);
}

async function ensureAlarm() {
  // Chrome may clear alarms on restart; recreate only when missing.
  if (!await chrome.alarms.get(PERIODIC_ALARM)) await chrome.alarms.create(PERIODIC_ALARM, {periodInMinutes: 10});
}

async function scheduleSync(force = false) {
  if (active || saving) return;
  if (force) await chrome.storage.local.set({pendingForce: true});
  if (scheduling) return scheduling;
  scheduling = (async () => {
    if (!await chrome.alarms.get(CHANGE_ALARM)) await chrome.alarms.create(CHANGE_ALARM, {when: Date.now() + 30000});
  })();
  try { await scheduling; } finally { scheduling = null; }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  let task;
  if (message?.type === 'saveAndSync') task = saveSettings(message);
  else if (message?.type === 'status') task = chrome.storage.local.get(['loginAccount', 'connectionToken', 'lastStatus']).then(value => ({loginAccount: value.loginAccount || '', hasToken: !!value.connectionToken, status: value.lastStatus || null}));
  else return false;
  task.then(reply).catch(() => reply({code: 'failed', message: STATUS.failed}));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === PERIODIC_ALARM) void syncSession().catch(() => {});
  if (alarm.name === CHANGE_ALARM) void (async () => {
    const {pendingForce} = await chrome.storage.local.get('pendingForce');
    await chrome.storage.local.set({pendingForce: false});
    await syncSession(pendingForce === true);
  })().catch(() => {});
});
chrome.cookies.onChanged.addListener(change => {
  if (matchesFlow(change.cookie)) void scheduleSync().catch(() => {});
});
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.status === 'complete' && !tab.incognito && /^https:\/\/flow\.google\.com(?:\/|$)/.test(tab.url || '')) void scheduleSync(true).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { void ensureAlarm().then(() => syncSession(true)).catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { void ensureAlarm().catch(() => {}); });
void ensureAlarm().catch(() => {});
