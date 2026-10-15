'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

function event() {
  const listeners = new Set();
  return {addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args); }};
}
function cookie(overrides = {}) {
  return {name: 'SID', value: 'fixture-session', domain: '.google.com', path: '/', hostOnly: false, secure: false, httpOnly: true, sameSite: 'unspecified', session: true, ...overrides};
}
function harness(options = {}) {
  const saved = {connectionToken: 'fixture-connection', loginAccount: 'person@example.com', ...options.saved};
  const alarms = new Map();
  const calls = {uploads: [], created: [], removed: [], sets: [], cookieQueries: []};
  const chrome = {
    runtime: {id: 'test-extension', onMessage: event(), onStartup: event(), onInstalled: event()},
    storage: {local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, saved[key]])),
      set: async values => { calls.sets.push(values); Object.assign(saved, values); }
    }, sync: {get: () => assert.fail('sync storage read'), set: () => assert.fail('sync storage write')}},
    alarms: {onAlarm: event(), get: async name => alarms.get(name), create: async (name, value) => alarms.set(name, value), clear: async name => alarms.delete(name)},
    tabs: {onUpdated: event(), onRemoved: event(), create: async input => { calls.created.push(input); return {id: 7}; }, get: async () => ({id: 7, status: 'complete', url: options.tabUrl || 'https://flow.google.com/projects'}), remove: async id => calls.removed.push(id)},
    cookies: {onChanged: event(), getAll: async query => {
      calls.cookieQueries.push(query);
      chrome.cookies.onChanged.emit({cookie: cookie()});
      return options.cookies || [cookie(), cookie({name: 'OSID', domain: 'flow.google.com', hostOnly: true, secure: true})];
    }}
  };
  const context = vm.createContext({
    chrome, URL, TextEncoder, Uint8Array, crypto: webcrypto, AbortSignal,
    setTimeout: (fn, ms) => setTimeout(fn, ms === 1500 ? 0 : ms), clearTimeout,
    fetch: async (url, request) => { calls.uploads.push({url, request}); return options.fetch ? options.fetch(url, request) : {ok: true, status: 200, json: async () => ({success: true})}; },
    console: {log: () => assert.fail('no plaintext logs'), warn: () => assert.fail('no plaintext logs'), error: () => assert.fail('no plaintext logs')}
  });
  vm.runInContext(source + '\n globalThis.api = {matchesFlow, exportCookies, syncSession, saveSettings, scheduleSync};', context);
  return {api: context.api, chrome, saved, calls, alarms};
}

test('cookie export preserves duplicates and exact scopes, excludes unrelated and partitioned cookies', () => {
  const {api} = harness();
  const input = [cookie(), cookie({domain: 'flow.google.com', hostOnly: true, path: '/projects', secure: true, sameSite: 'lax', expirationDate: Date.now() / 1000 + 3600}), cookie({domain: 'accounts.google.com', hostOnly: true}), cookie({domain: '.evilgoogle.com'}), cookie({path: '/project'}), cookie({partitionKey: {topLevelSite: 'https://example.com'}}), cookie({partitionKeyOpaque: true}), cookie({expirationDate: 1})];
  assert.deepEqual(JSON.parse(JSON.stringify(api.exportCookies(input))), input.slice(0, 2));
  assert.equal(api.matchesFlow(cookie({path: '/projects/'})), false);
  assert.equal(api.matchesFlow(cookie({domain: '.google.com', hostOnly: true})), false);
});

test('manual sync sends only fixed loopback endpoint, preserves metadata, closes tab, stores no cookie plaintext', async () => {
  const {api, calls, saved, alarms} = harness();
  const result = await api.saveSettings({loginAccount: 'Person@Example.com', connectionToken: 'fixture-new', apiUrl: 'https://elsewhere.invalid/collect'});
  assert.equal(result.code, 'success');
  assert.equal(saved.loginAccount, 'person@example.com');
  assert.equal(saved.connectionToken, 'fixture-new');
  assert.equal(calls.uploads.length, 1);
  const {url, request} = calls.uploads[0];
  assert.equal(url, 'http://127.0.0.1:38000/api/plugin/update-token');
  assert.equal(request.redirect, 'error');
  assert.equal(request.credentials, 'omit');
  const payload = JSON.parse(request.body);
  assert.equal(payload.login_account, 'person@example.com');
  assert.equal(payload.protocol_mode, 'protocol');
  assert.equal(JSON.parse(payload.google_cookies)[0].hostOnly, false);
  assert.deepEqual(calls.removed, [7]);
  assert.deepEqual(calls.created.map(value => JSON.parse(JSON.stringify(value))), [{url: 'https://flow.google.com/projects', active: false}]);
  assert.deepEqual(calls.cookieQueries.map(value => JSON.parse(JSON.stringify(value))), [{url: 'https://flow.google.com/projects'}]);
  assert.match(saved.lastFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(saved).includes('fixture-session'), false);
  assert.equal(alarms.has('flow-studio-cookie-change'), false, 'cookie changes during active sync must not form a loop');
  assert.equal(alarms.get('flow-studio-periodic').periodInMinutes, 10);
  assert.equal((await api.syncSession()).code, 'unchanged');
  assert.equal(calls.uploads.length, 1, 'unchanged automatic checks must skip upload');
  assert.equal((await api.syncSession(true)).code, 'success');
  assert.equal(calls.uploads.length, 2, 'explicit sync may retry unchanged session');
});

test('cookie event debounces, and simultaneous sync cannot overlap', async () => {
  let release;
  const {api, chrome, calls, alarms} = harness({fetch: () => new Promise(resolve => { release = () => resolve({ok: true, status: 200, json: async () => ({success: true})}); })});
  chrome.cookies.onChanged.emit({cookie: cookie()});
  await api.scheduleSync();
  assert.ok(alarms.get('flow-studio-cookie-change').when >= Date.now() + 29000);
  const deadline = alarms.get('flow-studio-cookie-change').when;
  await api.scheduleSync();
  assert.equal(alarms.get('flow-studio-cookie-change').when, deadline, 'repeated changes must not postpone sync');
  const first = api.syncSession(true);
  assert.equal((await api.syncSession(true)).code, 'busy');
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  chrome.cookies.onChanged.emit({cookie: cookie()});
  assert.equal(alarms.has('flow-studio-cookie-change'), false);
  release();
  assert.equal((await first).code, 'success');
  assert.equal(calls.uploads.length, 1);
});

test('safe errors never echo backend content or credentials and always close temporary tab', async () => {
  const {api, calls, saved} = harness({fetch: async () => ({ok: false, status: 400, json: async () => ({detail: 'sensitive upstream body'})})});
  assert.equal((await api.syncSession(true)).code, 'rejected');
  assert.equal(JSON.stringify(saved).includes('sensitive upstream body'), false);
  assert.deepEqual(calls.removed, [7]);
  assert.equal(saved.lastFingerprint, undefined);
  const redirected = harness({tabUrl: 'https://accounts.google.com/signin'});
  assert.equal((await redirected.api.syncSession(true)).code, 'login');
  assert.equal(redirected.calls.uploads.length, 0);
  assert.deepEqual(redirected.calls.removed, [7]);
});

test('manifest requests no page scripts or remote endpoint access', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.incognito, 'not_allowed');
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.permissions.includes('scripting'), false);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'https://*.google.com/*', 'http://google.com/*']);
});

test('status response contains no connection token and ignores outside messages', async () => {
  const {chrome} = harness();
  const result = await new Promise(resolve => chrome.runtime.onMessage.emit({type: 'status'}, {id: 'test-extension'}, resolve));
  assert.equal(result.hasToken, true);
  assert.equal(result.connectionToken, undefined);
  assert.equal(JSON.stringify(result).includes('fixture-connection'), false);
  chrome.runtime.onMessage.emit({type: 'status'}, {id: 'outside-extension'}, () => assert.fail('outside sender accepted'));
});

test('normal Flow navigation schedules forced upload; unrelated and incognito tabs do not', async () => {
  const {api, chrome, saved, alarms} = harness();
  chrome.tabs.onUpdated.emit(8, {status: 'complete'}, {url: 'https://flow.google.com/projects', incognito: true});
  chrome.tabs.onUpdated.emit(9, {status: 'complete'}, {url: 'https://example.com/', incognito: false});
  assert.equal(saved.pendingForce, undefined);
  assert.equal(alarms.has('flow-studio-cookie-change'), false);
  chrome.tabs.onUpdated.emit(10, {status: 'complete'}, {url: 'https://flow.google.com/projects', incognito: false});
  await api.scheduleSync();
  assert.equal(saved.pendingForce, true);
  assert.ok(alarms.has('flow-studio-cookie-change'));
});
