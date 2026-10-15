'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createAccountManager, _test } = require('./accounts.cjs');

const cookieJar = [
  { name: 'OSID', value: 'flow-session-test', domain: 'flow.google.com', path: '/', secure: true, httpOnly: true },
  { name: 'SID', value: 'google-session-test', domain: '.google.com', path: '/', secure: false },
  { name: 'unrelated', value: 'do-not-capture', domain: 'accounts.google.com', path: '/' },
  { name: 'unrelated', value: 'do-not-capture', domain: 'other.example', path: '/' },
  { name: 'expired', value: 'do-not-capture', domain: '.google.com', path: '/', expires: 1 },
];

test('cookie and target scope excludes unrelated origins and retains non-Secure Google SID', () => {
  assert.deepEqual(_test.scopedCookies(cookieJar).map(cookie => cookie.name), ['OSID', 'SID']);
  assert.equal(_test.hasSession(_test.scopedCookies(cookieJar)), true);
  assert.equal(_test.hasSession([cookieJar[1]]), false);
  assert.equal(_test.scopedCookies([{ ...cookieJar[1], domain: 'google.com' }]).length, 0);
  assert.equal(_test.scopedCookies([{ ...cookieJar[1], partitionKey: { topLevelSite: 'https://example.com' } }]).length, 0);
  assert.equal(_test.isFlowURL('https://flow.google.com/'), true);
  assert.equal(_test.isFlowURL('https://flow.google.com.evil.example/'), false);
  assert.equal(_test.isFlowURL('http://flow.google.com/'), false);
  assert.equal(_test.validSocket('ws://127.0.0.1:9234/devtools/page/test', 9234, 'page'), true);
  assert.equal(_test.validSocket('ws://example.com:9234/devtools/page/test', 9234, 'page'), false);
});

async function harness(t, { email = 'person@example.com', syncAccount, stored, waitForIdentity = false, hiddenUnsupported = false, backgroundTimeoutMs = 1000 } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-accounts-test-'));
  const states = [], launches = [], synced = [], network = [], processEvents = [];
  let child;
  let debugging = false;
  let hiddenTarget = false;
  if (stored) await fs.writeFile(path.join(dataDir, 'google-accounts.json'), JSON.stringify(stored));
  class FakeSocket extends EventTarget {
    constructor(url) { super(); this.url = url; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(text) {
      const request = JSON.parse(text);
      let result = {};
      if (request.method === 'Runtime.evaluate') result = { result: { value: waitForIdentity ? null : { email, origin: 'https://flow.google.com' } } };
      if (request.method === 'Network.getCookies') result = { cookies: cookieJar };
      if (request.method === 'Target.createTarget') {
        if (request.params.hidden && hiddenUnsupported) {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({id:request.id,error:{code:-32000,message:'Hidden target is unavailable'}}) })));
          return;
        }
        hiddenTarget = Boolean(request.params.hidden);
        result = { targetId: 'page-1' };
      }
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, result }) })));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const manager = createAccountManager({
    dataDir, chromePath: '/fake/Google Chrome',
    onState: state => states.push(state),
    syncAccount: async payload => { synced.push(payload); return syncAccount ? syncAccount(payload) : { accountId: 7, email, credits: 10 }; },
  }, {
    pollMs: 2, startupTimeoutMs: 1000, loginTimeoutMs: 1000, backgroundTimeoutMs, WebSocket: FakeSocket,
    spawn: (executable, args) => {
      launches.push({ executable, args });
      processEvents.push('launch');
      child = new EventEmitter();
      const launchedChild = child;
      debugging = args.includes('--remote-debugging-port=0');
      hiddenTarget = false;
      launchedChild.kill = () => {
        processEvents.push('stop');
        setTimeout(() => { debugging = false; processEvents.push('exit'); launchedChild.emit('exit', 0); }, 2);
        return true;
      };
      const profileDir = args.find(arg => arg.startsWith('--user-data-dir=')).split('=').slice(1).join('=');
      if (debugging) fs.writeFile(path.join(profileDir, 'DevToolsActivePort'), '9234\n/devtools/browser/test\n').catch(() => {});
      queueMicrotask(() => launchedChild.emit('spawn'));
      return child;
    },
    fetch: async url => {
      network.push(url);
      if (!debugging) throw new Error('Browser stopped');
      return { ok: true, json: async () => url.endsWith('/json/list')
        ? [{ id: 'page-1', type: hiddenTarget ? 'other' : 'page', url: 'https://flow.google.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9234/devtools/page/page-1' }]
        : { Browser: 'Chrome/Test' } };
    },
  });
  t.after(async () => { manager.shutdown(); await fs.rm(dataDir, { recursive: true, force: true, maxRetries:5, retryDelay:10 }); });
  async function until(predicate) {
    const deadline = Date.now() + 2500;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(`Timed out; states: ${JSON.stringify(states)}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  return { manager, states, launches, synced, network, processEvents, dataDir, until, exit: () => child.emit('exit', 0) };
}

test('real launch contract, verified identity, scoped cookies, secret-free persistent account binding', async t => {
  const h = await harness(t);
  assert.equal(h.manager.addAccount().state, 'opening');
  await h.until(() => h.states.some(state => state.state === 'waiting'));
  assert.equal(h.states.at(-1).canComplete, true);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(h.synced.length, 0);
  assert.equal(h.network.length, 0);
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0].args.some(arg => /remote-debugging|automation|disable|no-sandbox|headless/.test(arg)), false);
  assert.equal(h.manager.completeLogin().state, 'syncing');
  await h.until(() => h.states.some(state => state.state === 'succeeded'));
  assert.deepEqual(h.states.map(state => state.state).filter((state, index, list) => index === 0 || state !== list[index - 1]), ['opening', 'waiting', 'syncing', 'succeeded']);
  assert.equal(h.synced.length, 1);
  assert.deepEqual(h.synced[0].cookies.map(cookie => cookie.name), ['OSID', 'SID']);
  assert.equal(h.synced[0].email, 'person@example.com');
  assert.ok(h.synced[0].signal instanceof AbortSignal);
  const args = h.launches[1].args;
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.ok(args.includes('https://flow.google.com/'));
  assert.equal(args.some(arg => /disable|no-sandbox|headless/.test(arg)), false);
  assert.equal(h.launches[0].args.find(arg => arg.startsWith('--user-data-dir=')), args.find(arg => arg.startsWith('--user-data-dir=')));
  assert.deepEqual(h.processEvents.slice(0, 4), ['launch', 'stop', 'exit', 'launch']);
  const saved = await fs.readFile(path.join(h.dataDir, 'google-accounts.json'), 'utf8');
  assert.equal(saved.includes('session-test'), false);
  assert.deepEqual(JSON.parse(saved).profiles.map(profile => [profile.accountId, profile.email]), [[7, 'person@example.com']]);
  await h.until(() => h.processEvents.length === 6);
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit', 'launch', 'stop', 'exit']);
  assert.equal(h.states.at(-1).state, 'succeeded');
  assert.deepEqual(await h.manager.syncAccountNow(7), { synced: true, accountId: 7 });
  assert.equal(h.launches.length, 3);
  assert.ok(h.launches[2].args.includes('--no-startup-window'));
  assert.equal(h.launches[2].args.includes('--new-window'), false);
  assert.equal(h.launches[2].args.find(arg => arg.startsWith('--user-data-dir=')), args.find(arg => arg.startsWith('--user-data-dir=')));
  assert.equal(await fs.readFile(path.join(h.dataDir, 'google-accounts.json'), 'utf8'), saved);
  assert.equal(h.synced[1].expectedAccountId, 7);
  assert.equal(h.states.at(-1).state, 'succeeded');
});

test('reconnect rejects wrong Google identity before sync and preserves binding', async t => {
  const stored = { version: 1, profiles: [{ profileId: '18f3fd0c-2191-4fdb-99d6-fbdc1d5b5f57', dir: '18f3fd0c-2191-4fdb-99d6-fbdc1d5b5f57', accountId: 7, email: 'correct@example.com' }] };
  const h = await harness(t, { stored });
  h.manager.reconnectAccount(7);
  await h.until(() => h.states.some(state => state.state === 'waiting'));
  h.manager.completeLogin();
  await h.until(() => h.states.some(state => state.state === 'failed'));
  assert.equal(h.synced.length, 0);
  assert.match(h.states.at(-1).message, /correct@example.com/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.dataDir, 'google-accounts.json'), 'utf8')), stored);
});

test('cancel and browser close resolve waiting state without syncing', async t => {
  const h = await harness(t, { waitForIdentity: true });
  h.manager.addAccount();
  await h.until(() => h.states.some(state => state.state === 'waiting'));
  h.manager.cancelLogin();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.states.at(-1).state, 'cancelled');
  assert.equal(h.synced.length, 0);
  const h2 = await harness(t, { waitForIdentity: true });
  h2.manager.addAccount();
  await h2.until(() => h2.states.some(state => state.state === 'waiting'));
  h2.exit();
  await h2.until(() => h2.states.some(state => state.state === 'failed'));
  assert.equal(h2.synced.length, 0);
});

test('corrupt/path-traversing mappings fail closed before launching Chrome', async t => {
  const h = await harness(t, { stored: { version: 1, profiles: [{ profileId: 'bad', dir: '../../Google/Chrome', email: null, accountId: null }] } });
  h.manager.addAccount();
  await h.until(() => h.states.some(state => state.state === 'failed'));
  assert.equal(h.launches.length, 0);
});


test('persisted accounts refresh immediately on startup without a new login', async t => {
  const stored = { version: 1, profiles: [{ profileId: '18f3fd0c-2191-4fdb-99d6-fbdc1d5b5f57', dir: '18f3fd0c-2191-4fdb-99d6-fbdc1d5b5f57', accountId: 7, email: 'person@example.com' }] };
  const h = await harness(t, { stored });
  h.manager.startAutoSync();
  await h.until(() => h.synced.length === 1);
  assert.equal(h.synced[0].expectedAccountId, 7);
  assert(h.launches[0].args.includes('--no-startup-window'));
  assert.equal(h.states.length, 0);
});

test('background sync falls back when hidden targets are unavailable', async t => {
  const stored = { version: 1, profiles: [{ profileId: '18f3fd0c-2191-4fdb-99d6-fbdc1d5b5f57', dir: '18f3fd0c-2191-4fdb-99d6-fbdc1d5b5f57', accountId: 7, email: 'person@example.com' }] };
  const h = await harness(t, { stored, hiddenUnsupported:true });
  h.manager.startAutoSync();
  await h.until(() => h.synced.length === 1);
  assert.equal(h.synced[0].expectedAccountId, 7);
});

const boundProfile = { version: 1, profiles: [{ profileId: '18f3fd0c-2191-4fdb-99d6-fbdc1d5b5f57', dir: '18f3fd0c-2191-4fdb-99d6-fbdc1d5b5f57', accountId: 7, email: 'person@example.com' }] };

test('explicit sync uses the bound Chrome profile and waits for verified save', async t => {
  let finishSave;
  const h = await harness(t, { stored: boundProfile, syncAccount: payload => new Promise(resolve => {
    finishSave = () => resolve({ accountId: payload.expectedAccountId, email: payload.email });
  }) });
  let settled = false;
  const work = h.manager.syncAccountNow(7).then(result => { settled = true; return result; });
  await h.until(() => h.synced.length === 1);
  h.manager.startAutoSync();
  assert.equal(settled, false);
  assert.equal(h.synced[0].expectedAccountId, 7);
  assert.equal(h.synced[0].email, 'person@example.com');
  assert.deepEqual(h.synced[0].cookies.map(cookie => cookie.name), ['OSID', 'SID']);
  assert.ok(h.launches[0].args.includes(`--user-data-dir=${path.join(h.dataDir, 'chrome-profiles', boundProfile.profiles[0].dir)}`));
  finishSave();
  assert.deepEqual(await work, { synced: true, accountId: 7 });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.dataDir, 'google-accounts.json'), 'utf8')), boundProfile);
  assert.equal(h.states.length, 0);
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
  assert.equal(h.synced.length, 1);
});

test('explicit sync without a bound profile leaves normal account check available', async t => {
  const h = await harness(t, { stored: boundProfile });
  assert.deepEqual(await h.manager.syncAccountNow(8), { synced: false });
  assert.equal(h.launches.length, 0);
  assert.equal(h.synced.length, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.dataDir, 'google-accounts.json'), 'utf8')), boundProfile);
});

test('explicit sync rejects capture failure and sanitizes backend failure', async t => {
  const h = await harness(t, { stored: boundProfile, waitForIdentity: true, backgroundTimeoutMs: 20 });
  await assert.rejects(h.manager.syncAccountNow(7), { code: 'CAPTURE_TIMEOUT' });
  assert.equal(h.synced.length, 0);
  const h2 = await harness(t, { stored: boundProfile, syncAccount: async () => {
    throw Object.assign(new Error('Cookie: private-session-token'), { code: 'HTTP_403' });
  } });
  await assert.rejects(h2.manager.syncAccountNow(7), error => {
    assert.equal(error.code, 'SYNC_FAILED');
    assert.doesNotMatch(error.message, /Cookie|private-session-token|HTTP_403/);
    return true;
  });
});

test('explicit sync refuses an active foreground login without stopping Chrome', async t => {
  const h = await harness(t, { stored: boundProfile });
  h.manager.reconnectAccount(7);
  await h.until(() => h.states.some(state => state.state === 'waiting'));
  await assert.rejects(h.manager.syncAccountNow(7), { code: 'LOGIN_BUSY' });
  assert.equal(h.states.at(-1).state, 'waiting');
  assert.equal(h.synced.length, 0);
  assert.deepEqual(h.processEvents, ['launch']);
});

test('concurrent explicit checks deduplicate and wait for auto sync before capturing again', async t => {
  const finishSaves = [];
  const h = await harness(t, { stored: boundProfile, syncAccount: payload => new Promise(resolve => {
    finishSaves.push(() => resolve({ accountId: payload.expectedAccountId, email: payload.email }));
  }) });
  h.manager.startAutoSync();
  await h.until(() => h.synced.length === 1);
  const first = h.manager.syncAccountNow(7);
  const second = h.manager.syncAccountNow(7);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(h.synced.length, 1);
  assert.equal(h.launches.length, 1);
  finishSaves[0]();
  await h.until(() => h.synced.length === 2);
  assert.deepEqual(h.processEvents.slice(0, 4), ['launch', 'stop', 'exit', 'launch']);
  finishSaves[1]();
  assert.deepEqual(await Promise.all([first, second]), [{ synced: true, accountId: 7 }, { synced: true, accountId: 7 }]);
  assert.equal(h.synced.length, 2);
  assert.equal(h.launches.length, 2);
});

test('foreground login can follow an explicit sync it cancels', async t => {
  const h = await harness(t, { stored: boundProfile, syncAccount: () => new Promise(() => {}) });
  const checked = assert.rejects(h.manager.syncAccountNow(7), { code: 'CANCELLED' });
  await h.until(() => h.synced.length === 1);
  h.manager.reconnectAccount(7);
  await checked;
  await h.until(() => h.states.some(state => state.state === 'waiting'));
  assert.equal(h.states.at(-1).state, 'waiting');
  assert.deepEqual(h.processEvents.slice(0, 4), ['launch', 'stop', 'exit', 'launch']);
});
