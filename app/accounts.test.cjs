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

async function harness(t, { email = 'person@example.com', syncAccount, stored, waitForIdentity = false, hiddenUnsupported = false, hiddenNeedsSeed = false, backgroundTimeoutMs = 1000, syncIntervalMs, onSpawn, generationStartupMs = 5, isProcessAlive, hostname, regularProfiles, getAccount, cdpError, cdpReply } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-accounts-test-'));
  const states = [], launches = [], synced = [], network = [], processEvents = [], commands = [], sockets = [];
  let child;
  let debugging = false;
  let hiddenTarget = false;
  let seedPresent = false;
  if (stored) await fs.writeFile(path.join(dataDir, 'google-accounts.json'), JSON.stringify(stored));
  const chromeDataDir = regularProfiles && path.join(dataDir, 'regular-chrome');
  if (chromeDataDir) {
    await fs.mkdir(chromeDataDir);
    await fs.writeFile(path.join(chromeDataDir, 'Local State'), JSON.stringify({ profile: { info_cache: regularProfiles } }));
  }
  class FakeSocket extends EventTarget {
    constructor(url) { super(); this.url = url; sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(text) {
      const request = JSON.parse(text);
      commands.push(request);
      const respond = message => queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, ...(request.sessionId ? { sessionId: request.sessionId } : {}), ...message }) })));
      const commandError = cdpError?.(request);
      if (commandError) { respond({ error: commandError }); return; }
      let result = {};
      if (request.method === 'Runtime.evaluate') result = { result: { value: waitForIdentity ? null : { email, origin: 'https://flow.google.com' } } };
      if (request.method === 'Network.getCookies') result = { cookies: cookieJar };
      if (request.method === 'Target.createTarget') {
        if (request.params.hidden && hiddenNeedsSeed && !seedPresent) {
          respond({ error: { code: -32000, message: 'Hidden target can be created only when remote debugging is enabled' } });
          return;
        }
        if (request.params.hidden && hiddenUnsupported) {
          respond({ error: { code: -32602, message: 'Unknown parameter hidden' } });
          return;
        }
        hiddenTarget = Boolean(request.params.hidden);
        if (request.params.url === 'about:blank') seedPresent = true;
        result = { targetId: request.params.url === 'about:blank' ? 'seed-1' : 'page-1' };
      }
      if (request.method === 'Target.closeTarget' && request.params.targetId === 'seed-1') seedPresent = false;
      if (request.method === 'Target.attachToTarget') result = { sessionId: 'session-1' };
      if (request.method === 'Browser.getWindowForTarget') result = { windowId: 23 };
      const reply = cdpReply?.(request);
      if (reply === null) return;
      respond(reply === undefined ? { result } : reply);
    }
    close() { this.closed = true; this.dispatchEvent(new Event('close')); }
  }
  const manager = createAccountManager({
    dataDir, chromePath: '/fake/Google Chrome', chromeDataDir: chromeDataDir || undefined, getAccount,
    onState: state => states.push(state),
    syncAccount: async payload => { synced.push(payload); return syncAccount ? syncAccount(payload) : { accountId: 7, email, credits: 10 }; },
  }, {
    pollMs: 2, startupTimeoutMs: 1000, loginTimeoutMs: 1000, backgroundTimeoutMs, syncIntervalMs, generationStartupMs, isProcessAlive, hostname, WebSocket: FakeSocket,
    spawn: (executable, args) => {
      launches.push({ executable, args });
      processEvents.push('launch');
      child = new EventEmitter();
      const launchedChild = child;
      launchedChild.pid = 4000 + launches.length;
      debugging = args.includes('--remote-debugging-port=0');
      hiddenTarget = false;
      launchedChild.kill = () => {
        processEvents.push('stop');
        setTimeout(() => { debugging = false; processEvents.push('exit'); launchedChild.emit('exit', 0); }, 2);
        return true;
      };
      const profileDir = args.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
      if (debugging) {
        const endpointFile = path.join(profileDir, 'DevToolsActivePort'), temporary = endpointFile + '.' + launchedChild.pid + '.test-tmp';
        fs.writeFile(temporary, '9234\n/devtools/browser/test\n').then(() => fs.rename(temporary, endpointFile)).catch(() => {});
      }
      queueMicrotask(() => { launchedChild.emit('spawn'); onSpawn?.(launchedChild, args); });
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
  t.after(async () => { await manager.shutdown(); await fs.rm(dataDir, { recursive: true, force: true, maxRetries:5, retryDelay:10 }); });
  async function until(predicate) {
    const deadline = Date.now() + 2500;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(`Timed out; states: ${JSON.stringify(states)}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  return { manager, states, launches, synced, network, processEvents, commands, sockets, dataDir, until, exit: () => child.emit('exit', 0) };
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

test('removal drains auto sync, blocks other work, and unlinks without deleting or reusing Chrome data', async t => {
  let finishSave, finishRemoval, deleting = false;
  const h = await harness(t, { stored: boundProfile, syncIntervalMs: 10, syncAccount: payload => new Promise(resolve => {
    finishSave = () => resolve({ accountId: payload.expectedAccountId, email: payload.email });
  }) });
  h.manager.startAutoSync();
  await h.until(() => h.synced.length === 1);
  const profileDir = path.join(h.dataDir, 'chrome-profiles', boundProfile.profiles[0].dir);
  await fs.writeFile(path.join(profileDir, 'Cookies'), 'saved cookies');
  await fs.writeFile(path.join(profileDir, 'History'), 'saved history');
  const removal = h.manager.removeAccount(7, id => {
    assert.equal(id, 7);
    assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
    deleting = true;
    return new Promise(resolve => { finishRemoval = () => resolve({ removed: true }); });
  });
  assert.equal(deleting, false);
  assert.throws(() => h.manager.addAccount(), { code: 'ACCOUNT_BUSY' });
  assert.throws(() => h.manager.reconnectAccount(7), { code: 'ACCOUNT_BUSY' });
  await assert.rejects(h.manager.syncAccountNow(7), { code: 'ACCOUNT_BUSY' });
  await assert.rejects(h.manager.removeAccount(7, () => assert.fail('Concurrent removal')), { code: 'ACCOUNT_BUSY' });
  finishSave();
  await h.until(() => deleting);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(h.synced.length, 1);
  assert.equal(h.launches.length, 1);
  finishRemoval();
  assert.deepEqual(await removal, { removed: true });
  assert.equal(await h.manager.hasAccountProfile(7), false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.dataDir, 'google-accounts.json'), 'utf8')), { version: 1, profiles: [] });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(h.synced.length, 1);
  assert.equal(h.launches.length, 1);
  h.manager.addAccount();
  await h.until(() => h.states.some(state => state.state === 'waiting'));
  assert.notEqual(h.launches[1].args.find(arg => arg.startsWith('--user-data-dir=')), `--user-data-dir=${profileDir}`);
  assert.equal(await fs.readFile(path.join(profileDir, 'Cookies'), 'utf8'), 'saved cookies');
  assert.equal(await fs.readFile(path.join(profileDir, 'History'), 'utf8'), 'saved history');
});

test('failed removal retains binding and allows automatic sync to resume', async t => {
  const h = await harness(t, { stored: boundProfile, syncIntervalMs: 10 });
  let failRemoval, deleting = false;
  const removal = h.manager.removeAccount(7, () => {
    deleting = true;
    return new Promise((resolve, reject) => { failRemoval = () => reject(new Error('Delete failed')); });
  });
  await h.until(() => deleting);
  h.manager.startAutoSync();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(h.launches.length, 0);
  const failed = assert.rejects(removal, /Delete failed/);
  failRemoval();
  await failed;
  assert.equal(await h.manager.hasAccountProfile(7), true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.dataDir, 'google-accounts.json'), 'utf8')), boundProfile);
  await h.until(() => h.synced.length > 0);
  assert.equal(h.synced[0].expectedAccountId, 7);
});

test('removal refuses foreground login and pending manual sync before invoking backend', async t => {
  const h = await harness(t, { stored: boundProfile });
  const remove = () => assert.fail('Backend removal must not start');
  await assert.rejects(h.manager.removeAccount(0, remove), TypeError);
  await assert.rejects(h.manager.removeAccount(7), TypeError);
  h.manager.reconnectAccount(7);
  await h.until(() => h.states.some(state => state.state === 'waiting'));
  await assert.rejects(h.manager.removeAccount(7, remove), { code: 'LOGIN_BUSY' });
  assert.deepEqual(h.processEvents, ['launch']);
  let finishSave;
  const h2 = await harness(t, { stored: boundProfile, syncAccount: payload => new Promise(resolve => {
    finishSave = () => resolve({ accountId: payload.expectedAccountId, email: payload.email });
  }) });
  const sync = h2.manager.syncAccountNow(7);
  await h2.until(() => h2.synced.length === 1);
  await assert.rejects(h2.manager.removeAccount(7, remove), { code: 'SYNC_BUSY' });
  finishSave();
  await sync;
});

test('shutdown cancels queued removal but persists removal already accepted by backend', async t => {
  const h = await harness(t, { stored: boundProfile, syncAccount: () => new Promise(() => {}) });
  h.manager.startAutoSync();
  await h.until(() => h.synced.length === 1);
  const queued = h.manager.removeAccount(7, () => assert.fail('Backend removal after shutdown'));
  h.manager.shutdown();
  await assert.rejects(queued, { code: 'SHUTDOWN' });
  assert.equal(await h.manager.hasAccountProfile(7), true);
  const h2 = await harness(t, { stored: boundProfile });
  let finishRemoval, deleting = false;
  const accepted = h2.manager.removeAccount(7, () => {
    deleting = true;
    return new Promise(resolve => { finishRemoval = resolve; });
  });
  await h2.until(() => deleting);
  h2.manager.shutdown();
  finishRemoval();
  await accepted;
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h2.dataDir, 'google-accounts.json'), 'utf8')), { version: 1, profiles: [] });
});

test('native generation leases only a mapped ordinary Chrome process without debugging or account capture', async t => {
  const h = await harness(t, { stored: boundProfile });
  await h.manager.hasAccountProfile(7);
  const endpointFile = path.join(h.dataDir, 'chrome-profiles', boundProfile.profiles[0].dir, 'DevToolsActivePort');
  await fs.writeFile(endpointFile, 'old-debugging-metadata');
  const lease = await h.manager.acquireGenerationBrowser(7);
  assert.deepEqual(lease, { pid: 4001, accountId: 7, email: 'person@example.com' });
  assert.equal(Object.isFrozen(lease), true);
  assert.equal(h.launches.length, 1);
  assert.deepEqual(h.launches[0].args, [
    `--user-data-dir=${path.dirname(endpointFile)}`, '--no-first-run', '--no-default-browser-check', '--new-window', 'https://flow.google.com/',
  ]);
  assert.equal(h.network.length, 0);
  assert.equal(h.synced.length, 0);
  assert.equal(await fs.readFile(endpointFile, 'utf8'), 'old-debugging-metadata');
  assert.throws(() => h.manager.addAccount(), { code: 'GENERATION_BUSY' });
  assert.throws(() => h.manager.reconnectAccount(7), { code: 'GENERATION_BUSY' });
  await assert.rejects(h.manager.syncAccountNow(7), { code: 'GENERATION_BUSY' });
  await assert.rejects(h.manager.acquireGenerationBrowser(7), { code: 'GENERATION_BUSY' });
  await assert.rejects(h.manager.removeAccount(7, () => assert.fail('Removal during generation')), { code: 'GENERATION_BUSY' });
  await assert.rejects(h.manager.releaseGenerationBrowser({ ...lease }), TypeError);
  assert.deepEqual(h.processEvents, ['launch']);
  const releasing = h.manager.releaseGenerationBrowser(lease);
  await assert.rejects(h.manager.acquireGenerationBrowser(7), { code: 'GENERATION_BUSY' });
  await releasing;
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
  await h.manager.releaseGenerationBrowser(lease);
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.dataDir, 'google-accounts.json'), 'utf8')), boundProfile);
});

test('isolated generation owns one hidden background target and scopes commands and events to its flattened session', async t => {
  const h = await harness(t, { stored: boundProfile });
  const lease = await h.manager.acquireIsolatedGenerationBrowser(7);
  assert.equal(Object.isFrozen(lease), true);
  assert.equal(Object.isFrozen(lease.client), true);
  assert.deepEqual(Object.keys(lease), ['accountId', 'email', 'targetId', 'sessionId', 'signal', 'client']);
  assert.ok(lease.signal instanceof AbortSignal);
  assert.equal(lease.signal.aborted, false);
  assert.equal(lease.accountId, 7);
  assert.equal(lease.email, 'person@example.com');
  assert.equal(lease.targetId, 'page-1');
  assert.equal(lease.sessionId, 'session-1');
  assert.deepEqual(h.launches[0].args, [
    `--user-data-dir=${path.join(h.dataDir, 'chrome-profiles', boundProfile.profiles[0].dir)}`,
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--no-startup-window',
  ]);
  assert.equal(h.launches[0].args.some(arg => /headless|automation|stealth|disable|no-sandbox|profile-directory/.test(arg)), false);
  assert.deepEqual(h.commands.map(({ method, params }) => ({ method, params })), [
    { method: 'Target.createTarget', params: { url: 'https://flow.google.com/', background: true, hidden: true } },
    { method: 'Target.attachToTarget', params: { targetId: 'page-1', flatten: true } },
  ]);
  await lease.client.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  assert.equal(h.commands.at(-1).sessionId, 'session-1');
  await lease.client.browserSend('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp/flow-job-test', eventsEnabled: true });
  assert.equal(h.commands.at(-1).sessionId, undefined);
  await lease.client.browserSend('Browser.cancelDownload', { guid: 'download-1' });
  assert.equal(h.commands.at(-1).sessionId, undefined);
  await assert.rejects(lease.client.browserSend('Browser.getVersion'), TypeError);
  await assert.rejects(lease.client.browserSend('Target.getTargets'), TypeError);
  const events = [];
  const unsubscribe = lease.client.onEvent(event => events.push(event));
  const emit = message => h.sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  emit({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'session-1' });
  emit({ method: 'Page.loadEventFired', params: { timestamp: 2 }, sessionId: 'another-session' });
  emit({ method: 'Browser.downloadWillBegin', params: { guid: 'download-1' } });
  emit({ method: 'Browser.downloadProgress', params: { guid: 'download-1', state: 'completed' } });
  emit({ method: 'Browser.downloadWillBegin', params: { guid: 'foreign-download' }, sessionId: 'another-session' });
  emit({ method: 'Target.targetCreated', params: {} });
  emit({ method: 'Browser.downloadSecret', params: {} });
  emit({ method: 'Network.requestWillBeSent', params: { headers: { Cookie: 'do-not-forward' } }, sessionId: 'another-session' });
  unsubscribe();
  emit({ method: 'Page.loadEventFired', params: { timestamp: 3 }, sessionId: 'session-1' });
  assert.deepEqual(events, [
    { method: 'Page.loadEventFired', params: { timestamp: 1 } },
    { method: 'Browser.downloadWillBegin', params: { guid: 'download-1' } },
    { method: 'Browser.downloadProgress', params: { guid: 'download-1', state: 'completed' } },
  ]);
  assert.equal(h.network.every(url => url === 'http://127.0.0.1:9234/json/version'), true);
  assert.equal(h.synced.length, 0);
  assert.throws(() => h.manager.addAccount(), { code: 'GENERATION_BUSY' });
  await assert.rejects(h.manager.syncAccountNow(7), { code: 'GENERATION_BUSY' });
  await assert.rejects(h.manager.acquireGenerationBrowser(7), { code: 'GENERATION_BUSY' });
  await assert.rejects(h.manager.acquireIsolatedGenerationBrowser(7), { code: 'GENERATION_BUSY' });
  await assert.rejects(h.manager.removeAccount(7, () => assert.fail('Removal during generation')), { code: 'GENERATION_BUSY' });
  await assert.rejects(h.manager.releaseIsolatedGenerationBrowser({ ...lease }), TypeError);
  await assert.rejects(h.manager.releaseGenerationBrowser(lease), TypeError);
  const releasing = h.manager.releaseIsolatedGenerationBrowser(lease);
  await assert.rejects(h.manager.acquireIsolatedGenerationBrowser(7), { code: 'GENERATION_BUSY' });
  await releasing;
  await h.manager.releaseIsolatedGenerationBrowser(lease);
  assert.deepEqual(h.commands.at(-1), { id: 6, method: 'Target.closeTarget', params: { targetId: 'page-1' } });
  assert.equal(h.sockets[0].closed, true);
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
  await assert.rejects(lease.client.send('Runtime.evaluate'), { code: 'CDP_CLOSED' });
  await assert.rejects(lease.client.browserSend('Browser.cancelDownload', { guid: 'download-1' }), { code: 'CDP_CLOSED' });
  assert.throws(() => lease.client.onEvent(() => {}), { code: 'CDP_CLOSED' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.dataDir, 'google-accounts.json'), 'utf8')), boundProfile);
});

function verificationTargetReplies(request) {
  if (request.method === 'Target.createTarget') {
    this.targets = (this.targets || 0) + 1;
    return { result: { targetId: this.targets === 1 ? 'page-1' : `verification-${this.targets}` } };
  }
  if (request.method === 'Target.attachToTarget' && request.params.targetId.startsWith('verification-')) {
    return { result: { sessionId: `session-${request.params.targetId}` } };
  }
}

test('verification page reads only its own hidden HOME session and leaves the primary editor alive', async t => {
  const h = await harness(t, { stored: boundProfile, cdpReply: verificationTargetReplies.bind({}) });
  const lease = await h.manager.acquireIsolatedGenerationBrowser(7);
  let retained;
  const result = await lease.client.withVerificationPage(async client => {
    retained = client;
    assert.equal(Object.isFrozen(client), true);
    assert.deepEqual(Object.keys(client), ['send']);
    for (const method of ['Target.getTargets', 'Target.closeTarget', 'Browser.getVersion', 'Network.getCookies', 'Page.navigate']) {
      await assert.rejects(client.send(method), TypeError);
    }
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    return client.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, 'foreign-session');
  });
  assert.equal(result.result.value.email, 'person@example.com');
  assert.equal(h.launches.length, 1);
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(h.commands.slice(2).map(({ method, params, sessionId }) => ({ method, params, ...(sessionId ? { sessionId } : {}) })), [
    { method: 'Target.createTarget', params: { url: 'https://flow.google.com/', background: true, hidden: true } },
    { method: 'Target.attachToTarget', params: { targetId: 'verification-2', flatten: true } },
    { method: 'Emulation.setDeviceMetricsOverride', params: { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId: 'session-verification-2' },
    { method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true }, sessionId: 'session-verification-2' },
    { method: 'Target.detachFromTarget', params: { sessionId: 'session-verification-2' } },
    { method: 'Target.closeTarget', params: { targetId: 'verification-2' } },
  ]);
  assert.equal(h.processEvents.includes('stop'), false);
  await assert.rejects(retained.send('Runtime.evaluate'), { code: 'CDP_CLOSED' });
  await lease.client.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  assert.equal(h.commands.at(-1).sessionId, 'session-1');
  await h.manager.releaseIsolatedGenerationBrowser(lease);
});

test('verification callback errors and local abort errors close only their own target', async t => {
  const h = await harness(t, { stored: boundProfile, cdpReply: verificationTargetReplies.bind({}) });
  const lease = await h.manager.acquireIsolatedGenerationBrowser(7);
  for (const error of [new Error('Verification callback failed'), new DOMException('Verification callback cancelled', 'AbortError')]) {
    let retained;
    await assert.rejects(lease.client.withVerificationPage(client => { retained = client; throw error; }), actual => actual === error);
    await assert.rejects(retained.send('Runtime.evaluate'), { code: 'CDP_CLOSED' });
  }
  assert.deepEqual(h.commands.filter(command => command.method === 'Target.closeTarget').map(command => command.params.targetId), ['verification-2', 'verification-3']);
  assert.deepEqual(h.commands.filter(command => command.method === 'Target.detachFromTarget').map(command => command.params.sessionId), ['session-verification-2', 'session-verification-3']);
  assert.equal(h.sockets[0].closed, undefined);
  assert.deepEqual(h.processEvents, ['launch']);
  await lease.client.send('Runtime.evaluate');
  assert.equal(h.commands.at(-1).sessionId, 'session-1');
  await h.manager.releaseIsolatedGenerationBrowser(lease);
});

test('verification is single-flight and release drains its own target before the primary editor', async t => {
  const h = await harness(t, { stored: boundProfile, cdpReply: verificationTargetReplies.bind({}) });
  const lease = await h.manager.acquireIsolatedGenerationBrowser(7);
  const before = h.commands.length;
  await assert.rejects(lease.client.withVerificationPage(null), TypeError);
  assert.equal(h.commands.length, before);
  let finish, retained;
  const verification = lease.client.withVerificationPage(client => {
    retained = client;
    return new Promise(resolve => { finish = resolve; });
  });
  await h.until(() => Boolean(finish));
  await assert.rejects(lease.client.withVerificationPage(() => assert.fail('Concurrent verification')), { code: 'VERIFICATION_BUSY' });
  let released = false;
  const releasing = h.manager.releaseIsolatedGenerationBrowser(lease).then(() => { released = true; });
  await assert.rejects(lease.client.withVerificationPage(() => assert.fail('Verification during release')), { code: 'CDP_CLOSED' });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(released, false);
  assert.equal(h.commands.some(command => command.method === 'Target.closeTarget'), false);
  assert.deepEqual(h.processEvents, ['launch']);
  await retained.send('Runtime.evaluate', { expression: 'document.title' });
  finish('verified');
  assert.equal(await verification, 'verified');
  await releasing;
  assert.deepEqual(h.commands.filter(command => ['Target.detachFromTarget', 'Target.closeTarget'].includes(command.method)).map(({ method, params }) => ({ method, params })), [
    { method: 'Target.detachFromTarget', params: { sessionId: 'session-verification-2' } },
    { method: 'Target.closeTarget', params: { targetId: 'verification-2' } },
    { method: 'Target.closeTarget', params: { targetId: 'page-1' } },
  ]);
  await assert.rejects(retained.send('Runtime.evaluate'), { code: 'CDP_CLOSED' });
  await assert.rejects(lease.client.withVerificationPage(() => {}), { code: 'CDP_CLOSED' });
  await h.manager.releaseIsolatedGenerationBrowser(lease);
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
});

test('lease abort interrupts verification and drains the owned browser without waiting on its callback', async t => {
  const h = await harness(t, { stored: boundProfile, cdpReply: verificationTargetReplies.bind({}) });
  const controller = new AbortController();
  const lease = await h.manager.acquireIsolatedGenerationBrowser(7, { signal: controller.signal });
  let retained;
  const verification = lease.client.withVerificationPage(client => { retained = client; return new Promise(() => {}); });
  const failed = assert.rejects(verification, /Cancel owned account verification/);
  await h.until(() => Boolean(retained));
  controller.abort(new Error('Cancel owned account verification'));
  await failed;
  await h.manager.releaseIsolatedGenerationBrowser(lease);
  await assert.rejects(retained.send('Runtime.evaluate'), { code: 'CDP_CLOSED' });
  assert.equal(h.sockets[0].closed, true);
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
  const next = await h.manager.acquireIsolatedGenerationBrowser(7);
  await h.manager.releaseIsolatedGenerationBrowser(next);
});

test('verification refuses a reused primary target and closes a new target after attach failure', async t => {
  const repeated = await harness(t, { stored: boundProfile });
  const first = await repeated.manager.acquireIsolatedGenerationBrowser(7);
  await assert.rejects(first.client.withVerificationPage(() => assert.fail('Adopted primary editor')), { code: 'CDP_TARGET' });
  assert.equal(repeated.commands.some(command => command.method === 'Target.closeTarget'), false);
  await first.client.send('Runtime.evaluate');
  await repeated.manager.releaseIsolatedGenerationBrowser(first);
  const reply = verificationTargetReplies.bind({});
  const failed = await harness(t, { stored: boundProfile, cdpReply: request => request.method === 'Target.attachToTarget' && request.params.targetId.startsWith('verification-') ? { error: { code: -32000, message: 'Attach failed' } } : reply(request) });
  const second = await failed.manager.acquireIsolatedGenerationBrowser(7);
  await assert.rejects(second.client.withVerificationPage(() => assert.fail('Unattached verification target')), { code: 'CDP_COMMAND' });
  assert.deepEqual(failed.commands.filter(command => command.method === 'Target.closeTarget').map(command => command.params.targetId), ['verification-2']);
  await second.client.send('Runtime.evaluate');
  await failed.manager.releaseIsolatedGenerationBrowser(second);
});

test('isolated generation requires managed mapping and never falls back to regular Chrome metadata', async t => {
  const h = await harness(t, {
    stored: boundProfile, regularProfiles: { Default: { user_name: 'person@example.com' } },
    getAccount: () => assert.fail('Isolated generation must not inspect regular Chrome'),
  });
  await assert.rejects(h.manager.acquireIsolatedGenerationBrowser(0), TypeError);
  await assert.rejects(h.manager.acquireIsolatedGenerationBrowser(7, { signal: {} }), TypeError);
  await assert.rejects(h.manager.acquireIsolatedGenerationBrowser(1), error => error.code === 'PROFILE_REQUIRED' && error.message.includes('Войти в Google'));
  assert.deepEqual(h.launches, []);
  assert.deepEqual(h.network, []);
  assert.deepEqual(h.commands, []);
  assert.equal(await h.manager.hasAccountProfile(1), false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.dataDir, 'google-accounts.json'), 'utf8')), boundProfile);
});

test('offscreen generation creates inactive app-owned window and moves only its returned window before attaching', async t => {
  const h = await harness(t, {
    stored: boundProfile, hiddenNeedsSeed: true, regularProfiles: { Default: { user_name: 'person@example.com' } },
    getAccount: () => assert.fail('Offscreen window must never inspect ordinary user Chrome'),
  });
  for (const windowMode of [null, true, 'hidden', 'minimized', 'normal', 'foreground', '']) await assert.rejects(h.manager.acquireIsolatedGenerationBrowser(7, { windowMode }), TypeError);
  assert.equal(h.launches.length, 0);
  const lease = await h.manager.acquireIsolatedGenerationBrowser(7, { windowMode: 'offscreen' });
  assert.deepEqual(h.commands.map(({ method, params }) => ({ method, params })), [
    { method: 'Target.createTarget', params: { url: 'https://flow.google.com/', newWindow: true, background: true } },
    { method: 'Browser.getWindowForTarget', params: { targetId: 'page-1' } },
    { method: 'Browser.setWindowBounds', params: { windowId: 23, bounds: { left: -10000, top: 0, width: 1280, height: 900, windowState: 'normal' } } },
    { method: 'Target.attachToTarget', params: { targetId: 'page-1', flatten: true } },
  ]);
  assert.equal(h.launches.length, 1);
  assert.ok(h.launches[0].args.includes(`--user-data-dir=${path.join(h.dataDir, 'chrome-profiles', boundProfile.profiles[0].dir)}`));
  assert.equal(h.commands.some(command => /activate|bringToFront|focus/i.test(command.method) || command.params.focus === true || command.params.hidden), false);
  assert.equal(h.commands.some(command => command.params.url === 'about:blank'), false);
  await h.manager.releaseIsolatedGenerationBrowser(lease);
  assert.equal(h.commands.at(-1).method, 'Target.closeTarget'); assert.equal(h.commands.at(-1).params.targetId, 'page-1');
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
});

test('offscreen lookup or placement failure closes target and owned browser before freeing generation slot', async t => {
  for (const stage of ['lookup', 'bounds', 'invalid-window']) {
    const h = await harness(t, { stored: boundProfile,
      cdpError: request => ((stage === 'lookup' && request.method === 'Browser.getWindowForTarget') || (stage === 'bounds' && request.method === 'Browser.setWindowBounds')) && { code: -32000, message: 'Window operation failed' },
      cdpReply: request => stage === 'invalid-window' && request.method === 'Browser.getWindowForTarget' ? { result: { windowId: 'ordinary-user-window' } } : undefined,
    });
    await assert.rejects(h.manager.acquireIsolatedGenerationBrowser(7, { windowMode: 'offscreen' }), error => ['CDP_COMMAND', 'CDP_TARGET'].includes(error.code));
    assert.equal(h.commands.some(command => command.method === 'Target.attachToTarget'), false);
    assert.equal(h.commands.at(-1).method, 'Target.closeTarget'); assert.equal(h.commands.at(-1).params.targetId, 'page-1');
    assert.equal(h.sockets[0].closed, true); assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
    const next = await h.manager.acquireGenerationBrowser(7); await h.manager.releaseGenerationBrowser(next);
  }
});

test('offscreen cancellation and shutdown drain only owned window once', async t => {
  for (const action of ['cancel', 'shutdown']) {
    const h = await harness(t, { stored: boundProfile }), controller = new AbortController();
    const lease = await h.manager.acquireIsolatedGenerationBrowser(7, { windowMode: 'offscreen', signal: controller.signal });
    if (action === 'cancel') controller.abort(Object.assign(new Error('Cancel offscreen browser'), { code: 'CANCELLED' }));
    else await h.manager.shutdown();
    await h.manager.releaseIsolatedGenerationBrowser(lease);
    assert.equal(lease.signal.aborted, true); assert.equal(h.sockets[0].closed, true);
    assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
    assert.equal(h.commands.filter(command => command.method === 'Browser.setWindowBounds').length, 1);
  }
});

test('isolated generation replaces only retained app Chrome and never connects to a stale debugging endpoint', async t => {
  const h = await harness(t, { stored: boundProfile });
  const native = await h.manager.acquireGenerationBrowser(7);
  await assert.rejects(h.manager.acquireIsolatedGenerationBrowser(7), { code: 'GENERATION_BUSY' });
  await h.manager.releaseGenerationBrowser(native, { close: false });
  const endpointFile = path.join(h.dataDir, 'chrome-profiles', boundProfile.profiles[0].dir, 'DevToolsActivePort');
  await fs.writeFile(endpointFile, '8333\n/devtools/browser/unowned\n');
  const lease = await h.manager.acquireIsolatedGenerationBrowser(7);
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit', 'launch']);
  assert.equal(h.network.some(url => url.includes(':8333')), false);
  assert.equal(h.sockets[0].url, 'ws://127.0.0.1:9234/devtools/browser/test');
  await h.manager.releaseIsolatedGenerationBrowser(lease);
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit', 'launch', 'stop', 'exit']);
});

test('isolated generation refuses unowned profile locks and forwarded or PID-less launches', async t => {
  const locked = await harness(t, { stored: boundProfile });
  await locked.manager.hasAccountProfile(7);
  const profileDir = path.join(locked.dataDir, 'chrome-profiles', boundProfile.profiles[0].dir);
  await fs.symlink('foreign.test-1234', path.join(profileDir, 'SingletonLock'));
  await fs.writeFile(path.join(profileDir, 'DevToolsActivePort'), '8333\n/devtools/browser/unowned\n');
  await assert.rejects(locked.manager.acquireIsolatedGenerationBrowser(7), { code: 'PROFILE_IN_USE' });
  assert.deepEqual(locked.processEvents, []);
  assert.deepEqual(locked.network, []);
  assert.equal(await fs.readlink(path.join(profileDir, 'SingletonLock')), 'foreign.test-1234');
  assert.equal(await fs.readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8'), '8333\n/devtools/browser/unowned\n');
  const forwarded = await harness(t, { stored: boundProfile, onSpawn: child => child.emit('exit', 0) });
  await assert.rejects(forwarded.manager.acquireIsolatedGenerationBrowser(7), error => ['PROFILE_IN_USE', 'CHROME_START'].includes(error.code));
  assert.deepEqual(forwarded.commands, []);
  assert.deepEqual(forwarded.processEvents, ['launch']);
  const pidless = await harness(t, { stored: boundProfile, onSpawn: child => { delete child.pid; } });
  await assert.rejects(pidless.manager.acquireIsolatedGenerationBrowser(7), { code: 'CHROME_START' });
  assert.deepEqual(pidless.commands, []);
  assert.deepEqual(pidless.processEvents, ['launch', 'stop', 'exit']);
});

test('isolated generation falls back only for unsupported hidden targets and cleans up target or attach failures', async t => {
  const fallback = await harness(t, { stored: boundProfile, hiddenUnsupported: true });
  const lease = await fallback.manager.acquireIsolatedGenerationBrowser(7);
  assert.deepEqual(fallback.commands.filter(command => command.method === 'Target.createTarget').map(command => command.params), [
    { url: 'https://flow.google.com/', background: true, hidden: true },
    { url: 'https://flow.google.com/', background: true },
  ]);
  await fallback.manager.releaseIsolatedGenerationBrowser(lease);
  for (const message of ['Target limit reached', 'Hidden target is unavailable', 'Hidden target creation denied: unknown browser context']) {
    const denied = await harness(t, { stored: boundProfile, cdpError: request => request.method === 'Target.createTarget' && { code: -32000, message } });
    await assert.rejects(denied.manager.acquireIsolatedGenerationBrowser(7), { code: 'CDP_COMMAND' });
    assert.equal(denied.commands.filter(command => command.method === 'Target.createTarget').length, 1);
    assert.equal(denied.sockets[0].closed, true);
    assert.deepEqual(denied.processEvents, ['launch', 'stop', 'exit']);
  }
  const invalid = await harness(t, { stored: boundProfile, cdpReply: request => request.method === 'Target.attachToTarget' ? { result: { sessionId: '../invalid' } } : undefined });
  await assert.rejects(invalid.manager.acquireIsolatedGenerationBrowser(7), { code: 'CDP_TARGET' });
  assert.equal(invalid.commands.at(-1).method, 'Target.closeTarget');
  assert.equal(invalid.sockets[0].closed, true);
  assert.deepEqual(invalid.processEvents, ['launch', 'stop', 'exit']);
  const native = await invalid.manager.acquireGenerationBrowser(7);
  await invalid.manager.releaseGenerationBrowser(native);
});

test('CDP failures include only safe method and numeric protocol code, excluding raw errors and request values', async t => {
  const privateValue = 'do-not-expose-session-or-person@example.test';
  for (const method of ['Target.createTarget', 'Target.attachToTarget']) {
    const h = await harness(t, { stored: boundProfile, cdpError: request => request.method === method && {
      code: -32602, message: `Invalid parameters ${privateValue}`, data: `Cookie=${privateValue}`,
    } });
    await assert.rejects(h.manager.acquireIsolatedGenerationBrowser(7), error => {
      assert.equal(error.code, 'CDP_COMMAND');
      assert.equal(error.cdpMethod, method);
      assert.equal(error.cdpCode, -32602);
      assert.equal(error.message, `Chrome не выполнил запрос (${method}; code=-32602).`);
      assert.equal(error.stack.includes(privateValue), false);
      assert.equal(JSON.stringify(error).includes(privateValue), false);
      return true;
    });
    assert.equal(h.commands.filter(command => command.method === 'Target.createTarget').length, 1);
    assert.equal(h.sockets[0].closed, true);
    assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
  }
  const runtime = await harness(t, { stored: boundProfile, cdpError: request => request.method.startsWith('Runtime.') && {
    code: `invalid-${privateValue}`, message: privateValue, data: privateValue,
  } });
  const lease = await runtime.manager.acquireIsolatedGenerationBrowser(7);
  await assert.rejects(lease.client.send('Runtime.evaluate', { expression: privateValue }), error => {
    assert.equal(error.message, 'Chrome не выполнил запрос (Runtime.evaluate).');
    assert.equal(error.cdpMethod, 'Runtime.evaluate');
    assert.equal(error.cdpCode, undefined);
    assert.equal(error.stack.includes(privateValue), false);
    return true;
  });
  await assert.rejects(lease.client.send('Runtime.evaluate\n' + privateValue, { expression: privateValue }), error => {
    assert.equal(error.message, 'Chrome не выполнил запрос (CDP).');
    assert.equal(error.cdpMethod, 'CDP');
    assert.equal(error.stack.includes(privateValue), false);
    assert.equal(JSON.stringify(error).includes(privateValue), false);
    return true;
  });
  await runtime.manager.releaseIsolatedGenerationBrowser(lease);
});

test('Chrome 157 empty-frame guard seeds one minimized inactive app target before hidden creation and closes seed before attach', async t => {
  const h = await harness(t, {
    stored: boundProfile, hiddenNeedsSeed: true,
    regularProfiles: { Default: { user_name: 'person@example.com' } },
    getAccount: () => assert.fail('Seed must stay inside app-owned managed Chrome'),
  });
  const lease = await h.manager.acquireIsolatedGenerationBrowser(7);
  assert.deepEqual(h.commands.map(({ method, params }) => ({ method, params })), [
    { method: 'Target.createTarget', params: { url: 'https://flow.google.com/', background: true, hidden: true } },
    { method: 'Target.createTarget', params: { url: 'about:blank', background: true, newWindow: true, windowState: 'minimized' } },
    { method: 'Target.createTarget', params: { url: 'https://flow.google.com/', background: true, hidden: true } },
    { method: 'Target.closeTarget', params: { targetId: 'seed-1' } },
    { method: 'Target.attachToTarget', params: { targetId: 'page-1', flatten: true } },
  ]);
  assert.equal(lease.targetId, 'page-1');
  assert.equal(h.launches.length, 1);
  assert.ok(h.launches[0].args.includes(`--user-data-dir=${path.join(h.dataDir, 'chrome-profiles', boundProfile.profiles[0].dir)}`));
  assert.ok(h.launches[0].args.includes('--no-startup-window'));
  assert.equal(h.launches[0].args.some(arg => /profile-directory|headless|stealth/.test(arg)), false);
  assert.equal(h.commands.some(command => /activate|focus/i.test(command.method) || command.params.focus === true), false);
  await h.manager.releaseIsolatedGenerationBrowser(lease);
  assert.equal(h.commands.at(-1).params.targetId, 'page-1');
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
});

test('hidden seed retry requires exact known message and numeric -32000 code and never retries twice', async t => {
  const known = 'Hidden target can be created only when remote debugging is enabled';
  for (const protocolError of [
    { code: -32602, message: known },
    { code: '-32000', message: known },
    { code: -32000, message: known + ': account-specific-detail' },
    { code: -32000, message: 'Target limit reached', data: known },
  ]) {
    const denied = await harness(t, { stored: boundProfile, cdpError: request => request.method === 'Target.createTarget' && protocolError });
    await assert.rejects(denied.manager.acquireIsolatedGenerationBrowser(7), error => error.code === 'CDP_COMMAND' && error.hiddenNeedsSeed === false);
    assert.equal(denied.commands.filter(command => command.method === 'Target.createTarget').length, 1);
    assert.equal(denied.commands.some(command => command.params.url === 'about:blank'), false);
    assert.deepEqual(denied.processEvents, ['launch', 'stop', 'exit']);
  }
  const repeated = await harness(t, { stored: boundProfile, cdpError: request => request.params.hidden && { code: -32000, message: known } });
  await assert.rejects(repeated.manager.acquireIsolatedGenerationBrowser(7), error => {
    assert.equal(error.code, 'CDP_COMMAND'); assert.equal(error.hiddenNeedsSeed, true);
    assert.equal(error.message, 'Chrome не выполнил запрос (Target.createTarget; code=-32000; hidden=requires-initial-page).');
    return true;
  });
  assert.equal(repeated.commands.filter(command => command.method === 'Target.createTarget' && command.params.hidden).length, 2);
  assert.equal(repeated.commands.filter(command => command.params.url === 'about:blank').length, 1);
  assert.deepEqual(repeated.commands.at(-1).params, { targetId: 'seed-1' });
  assert.equal(repeated.commands.some(command => command.method === 'Target.attachToTarget'), false);
  assert.equal(repeated.sockets[0].closed, true);
  assert.deepEqual(repeated.processEvents, ['launch', 'stop', 'exit']);
});

test('hidden seed creation or cleanup failure closes owned client and browser instead of returning a lease', async t => {
  for (const stage of ['seed-create', 'seed-close']) {
    const h = await harness(t, { stored: boundProfile, hiddenNeedsSeed: true, cdpError: request => {
      if ((stage === 'seed-create' && request.params.url === 'about:blank') || (stage === 'seed-close' && request.method === 'Target.closeTarget')) return { code: -32000, message: 'Internal failure with private page details' };
      return false;
    } });
    await assert.rejects(h.manager.acquireIsolatedGenerationBrowser(7), error => error.code === 'CDP_COMMAND' && error.cdpMethod === (stage === 'seed-close' ? 'Target.closeTarget' : 'Target.createTarget'));
    assert.equal(h.commands.some(command => command.method === 'Target.attachToTarget'), false);
    assert.equal(h.sockets[0].closed, true);
    assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
    const native = await h.manager.acquireGenerationBrowser(7);
    await h.manager.releaseGenerationBrowser(native);
  }
});

test('background account sync shares guarded hidden seeding without foreground callbacks', async t => {
  const h = await harness(t, { stored: boundProfile, hiddenNeedsSeed: true });
  assert.deepEqual(await h.manager.syncAccountNow(7), { synced: true, accountId: 7 });
  assert.equal(h.synced.length, 1);
  assert.equal(h.states.length, 0);
  assert.equal(h.commands.filter(command => command.params.url === 'about:blank').length, 1);
  assert.equal(h.commands.filter(command => command.method === 'Target.closeTarget' && command.params.targetId === 'seed-1').length, 1);
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
});

test('isolated generation aborts and drains autosync before launching and resumes sync after release', async t => {
  let stopRequested = false, finishExit;
  const h = await harness(t, {
    stored: boundProfile, syncIntervalMs: 10, syncAccount: () => new Promise(() => {}),
    onSpawn(child) {
      if (!finishExit) child.kill = () => {
        stopRequested = true;
        finishExit = () => child.emit('exit', 0);
        return true;
      };
    },
  });
  h.manager.startAutoSync();
  await h.until(() => h.synced.length === 1);
  const cancelled = new AbortController();
  cancelled.abort(new Error('Cancelled before autosync drain'));
  await assert.rejects(h.manager.acquireIsolatedGenerationBrowser(7, { signal: cancelled.signal }), /Cancelled before autosync drain/);
  assert.equal(stopRequested, false);
  const opening = h.manager.acquireIsolatedGenerationBrowser(7);
  try {
    await h.until(() => stopRequested);
    assert.equal(h.launches.length, 1);
    await assert.rejects(h.manager.acquireIsolatedGenerationBrowser(7), { code: 'GENERATION_BUSY' });
    finishExit();
    const lease = await opening;
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.launches.length, 2);
    assert.equal(h.synced.length, 1);
    await h.manager.releaseIsolatedGenerationBrowser(lease);
    await h.until(() => h.synced.length === 2);
  } finally { finishExit?.(); await opening.catch(() => {}); }
});

test('isolated generation cancellation closes requests and owned browser automatically and releases only its reservation', async t => {
  const cancelled = new AbortController();
  cancelled.abort(new Error('Cancelled before isolated launch'));
  const h = await harness(t, { stored: boundProfile, generationStartupMs: 30 });
  await assert.rejects(h.manager.acquireIsolatedGenerationBrowser(7, { signal: cancelled.signal }), /Cancelled before isolated launch/);
  assert.deepEqual(h.launches, []);
  const openingController = new AbortController();
  const opening = assert.rejects(h.manager.acquireIsolatedGenerationBrowser(7, { signal: openingController.signal }), /Cancel isolated startup/);
  await h.until(() => h.launches.length === 1);
  openingController.abort(new Error('Cancel isolated startup'));
  await opening;
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
  const pending = await harness(t, { stored: boundProfile, cdpReply: request => request.method === 'DOM.getDocument' ? null : undefined });
  const controller = new AbortController();
  const first = await pending.manager.acquireIsolatedGenerationBrowser(7, { signal: controller.signal });
  const request = assert.rejects(first.client.send('DOM.getDocument'), /Cancel acquired isolated generation/);
  pending.sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
    id: pending.commands.at(-1).id, sessionId: 'foreign-session', result: { root: { nodeId: 999 } },
  }) }));
  controller.abort(new Error('Cancel acquired isolated generation'));
  await request;
  await pending.until(() => pending.processEvents.at(-1) === 'exit');
  assert.equal(pending.sockets[0].closed, true);
  const second = await pending.manager.acquireIsolatedGenerationBrowser(7);
  await pending.manager.releaseIsolatedGenerationBrowser(first);
  await assert.rejects(pending.manager.acquireGenerationBrowser(7), { code: 'GENERATION_BUSY' });
  await pending.manager.releaseIsolatedGenerationBrowser(second);
  assert.deepEqual(pending.processEvents, ['launch', 'stop', 'exit', 'launch', 'stop', 'exit']);
});

test('isolated startup cancellation keeps generation reserved until aborted autosync exits', async t => {
  let stopRequested = false, finishExit;
  const h = await harness(t, {
    stored: boundProfile, syncIntervalMs: 10, waitForIdentity: true,
    onSpawn(child) { child.kill = () => { stopRequested = true; finishExit = () => child.emit('exit', 0); return true; }; },
  });
  h.manager.startAutoSync();
  await h.until(() => h.network.length > 0);
  const controller = new AbortController();
  let settled = false;
  const opening = assert.rejects(h.manager.acquireIsolatedGenerationBrowser(7, { signal: controller.signal }), /Cancel draining isolated launch/).then(() => { settled = true; });
  try {
    await h.until(() => stopRequested);
    controller.abort(new Error('Cancel draining isolated launch'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(settled, false);
    await assert.rejects(h.manager.acquireGenerationBrowser(7), { code: 'GENERATION_BUSY' });
    finishExit();
    await opening;
    assert.equal(h.launches.length, 1);
    await h.manager.shutdown();
  } finally { finishExit?.(); await opening; }
});

test('shutdown cancels isolated startup and drains an acquired isolated browser once', async t => {
  const opening = await harness(t, { stored: boundProfile, generationStartupMs: 30 });
  const acquiring = assert.rejects(opening.manager.acquireIsolatedGenerationBrowser(7), { code: 'CANCELLED' });
  await opening.until(() => opening.launches.length === 1);
  await opening.manager.shutdown();
  await acquiring;
  assert.deepEqual(opening.processEvents, ['launch', 'stop', 'exit']);
  const acquired = await harness(t, { stored: boundProfile });
  const lease = await acquired.manager.acquireIsolatedGenerationBrowser(7);
  assert.equal(lease.signal.aborted, false);
  await acquired.manager.shutdown();
  assert.equal(lease.signal.aborted, true);
  assert.equal(lease.signal.reason.code, 'CANCELLED');
  await acquired.manager.releaseIsolatedGenerationBrowser(lease);
  assert.equal(acquired.sockets[0].closed, true);
  assert.deepEqual(acquired.processEvents, ['launch', 'stop', 'exit']);
  await assert.rejects(acquired.manager.acquireIsolatedGenerationBrowser(7), { code: 'SHUTDOWN' });
});

test('native generation refuses missing or unowned profiles before launching or modifying them', async t => {
  const h = await harness(t, { stored: boundProfile });
  await assert.rejects(h.manager.acquireGenerationBrowser(0), TypeError);
  await assert.rejects(h.manager.acquireGenerationBrowser(8), { code: 'PROFILE_REQUIRED' });
  assert.equal(h.launches.length, 0);
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const locked = await harness(t, { stored: boundProfile });
    await locked.manager.hasAccountProfile(7);
    const lockFile = path.join(locked.dataDir, 'chrome-profiles', boundProfile.profiles[0].dir, name);
    await fs.symlink('/unknown/chrome/process', lockFile);
    await assert.rejects(locked.manager.acquireGenerationBrowser(7), { code: 'PROFILE_IN_USE' });
    assert.equal(locked.launches.length, 0);
    assert.equal(locked.network.length, 0);
    assert.equal(await fs.readlink(lockFile), '/unknown/chrome/process');
  }
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.dataDir, 'google-accounts.json'), 'utf8')), boundProfile);
});

test('native generation rejects a forwarded launch and a browser without an owned PID', async t => {
  const h = await harness(t, { stored: boundProfile, onSpawn: child => child.emit('exit', 0) });
  await assert.rejects(h.manager.acquireGenerationBrowser(7), { code: 'PROFILE_IN_USE' });
  assert.deepEqual(h.processEvents, ['launch']);
  assert.equal(h.network.length, 0);
  const missingPid = await harness(t, { stored: boundProfile, onSpawn: child => { delete child.pid; } });
  await assert.rejects(missingPid.manager.acquireGenerationBrowser(7), { code: 'CHROME_START' });
  assert.deepEqual(missingPid.processEvents, ['launch', 'stop', 'exit']);
});

test('native generation lets Chrome handle a confirmed dead local singleton lock without changing artifacts', async t => {
  const probes = [];
  const h = await harness(t, { stored: boundProfile, hostname: () => 'Noutbuk-Mihail.local', isProcessAlive: pid => { probes.push(pid); return false; } });
  await h.manager.hasAccountProfile(7);
  const profileDir = path.join(h.dataDir, 'chrome-profiles', boundProfile.profiles[0].dir);
  const markers = {
    SingletonLock: 'noutbuk-mihail.LOCAL.-67460',
    SingletonSocket: '/unavailable/socket',
    SingletonCookie: 'untouched-cookie-marker',
  };
  for (const [name, target] of Object.entries(markers)) await fs.symlink(target, path.join(profileDir, name));
  const lease = await h.manager.acquireGenerationBrowser(7);
  assert.deepEqual(probes, [67460]);
  assert.deepEqual(lease, { pid: 4001, accountId: 7, email: 'person@example.com' });
  assert.equal(h.network.length, 0);
  assert.equal(h.synced.length, 0);
  for (const [name, target] of Object.entries(markers)) assert.equal(await fs.readlink(path.join(profileDir, name)), target);
  await h.manager.releaseGenerationBrowser(lease);
});

test('native generation rejects live, uninspectable, foreign, and invalid singleton locks', async t => {
  for (const [target, alive, shouldProbe] of [
    ['local.test-67460', true, true],
    ['local.test-67460', 'EPERM', true],
    ['local.test-67460', 'EIO', true],
    ['foreign.test-67460', false, false],
    ['local.test-not-a-pid', false, false],
    ['local.test-0', false, false],
    ['local.test-9999999999999999999', false, false],
  ]) {
    const probes = [];
    const h = await harness(t, { stored: boundProfile, hostname: () => 'local.test', isProcessAlive: pid => {
      probes.push(pid);
      if (typeof alive === 'string') throw Object.assign(new Error('Unavailable'), { code: alive });
      return alive;
    } });
    await h.manager.hasAccountProfile(7);
    const lockFile = path.join(h.dataDir, 'chrome-profiles', boundProfile.profiles[0].dir, 'SingletonLock');
    await fs.symlink(target, lockFile);
    await assert.rejects(h.manager.acquireGenerationBrowser(7), { code: 'PROFILE_IN_USE' });
    assert.deepEqual(probes, shouldProbe ? [67460] : []);
    assert.equal(h.launches.length, 0);
    assert.equal(h.network.length, 0);
    assert.equal(await fs.readlink(lockFile), target);
  }
});

test('native generation pauses automatic sync, drains its owned browser, and resumes after release', async t => {
  const h = await harness(t, { stored: boundProfile, syncIntervalMs: 10, syncAccount: () => new Promise(() => {}) });
  h.manager.startAutoSync();
  await h.until(() => h.synced.length === 1);
  const lease = await h.manager.acquireGenerationBrowser(7);
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit', 'launch']);
  const requests = h.network.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.synced.length, 1);
  assert.equal(h.launches.length, 2);
  assert.equal(h.network.length, requests);
  await h.manager.releaseGenerationBrowser(lease);
  await h.until(() => h.synced.length === 2);
  assert.deepEqual(h.processEvents.slice(0, 7), ['launch', 'stop', 'exit', 'launch', 'stop', 'exit', 'launch']);
});

test('native generation refuses active login, explicit sync, and account removal without interrupting them', async t => {
  const login = await harness(t, { stored: boundProfile });
  login.manager.reconnectAccount(7);
  await login.until(() => login.states.some(state => state.state === 'waiting'));
  await assert.rejects(login.manager.acquireGenerationBrowser(7), { code: 'LOGIN_BUSY' });
  assert.deepEqual(login.processEvents, ['launch']);
  let finishSave;
  const syncing = await harness(t, { stored: boundProfile, syncAccount: payload => new Promise(resolve => {
    finishSave = () => resolve({ accountId: payload.expectedAccountId, email: payload.email });
  }) });
  const sync = syncing.manager.syncAccountNow(7);
  await syncing.until(() => syncing.synced.length === 1);
  await assert.rejects(syncing.manager.acquireGenerationBrowser(7), { code: 'SYNC_BUSY' });
  assert.deepEqual(syncing.processEvents, ['launch']);
  finishSave();
  await sync;
  let finishRemoval, removing = false;
  const removed = syncing.manager.removeAccount(7, () => new Promise(resolve => { removing = true; finishRemoval = resolve; }));
  await syncing.until(() => removing);
  await assert.rejects(syncing.manager.acquireGenerationBrowser(7), { code: 'ACCOUNT_BUSY' });
  finishRemoval();
  await removed;
});

test('native generation cancellation drains only its owned process and frees its slot', async t => {
  const h = await harness(t, { stored: boundProfile, generationStartupMs: 30 });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(new Error('Cancelled before launch'));
  await assert.rejects(h.manager.acquireGenerationBrowser(7, { signal: alreadyAborted.signal }), /Cancelled before launch/);
  assert.equal(h.launches.length, 0);
  const controller = new AbortController();
  const opening = h.manager.acquireGenerationBrowser(7, { signal: controller.signal });
  const cancelledOpening = assert.rejects(opening, /Cancel native generation/);
  await h.until(() => h.launches.length === 1);
  controller.abort(new Error('Cancel native generation'));
  await cancelledOpening;
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
  const activeController = new AbortController();
  const lease = await h.manager.acquireGenerationBrowser(7, { signal: activeController.signal });
  activeController.abort();
  await h.manager.releaseGenerationBrowser(lease);
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit', 'launch', 'stop', 'exit']);
});

test('native generation can retain and reuse its owned Chrome window without retaining old cancellation', async t => {
  const h = await harness(t, { stored: boundProfile });
  const controller = new AbortController();
  const first = await h.manager.acquireGenerationBrowser(7, { signal: controller.signal });
  await h.manager.releaseGenerationBrowser(first, { close: false });
  controller.abort();
  assert.deepEqual(h.processEvents, ['launch']);
  const second = await h.manager.acquireGenerationBrowser(7);
  assert.equal(second.pid, first.pid);
  assert.equal(h.launches.length, 1);
  await h.manager.releaseGenerationBrowser(second);
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
});

test('shutdown waits for native startup cancellation and closes an acquired Chrome lease once', async t => {
  const h = await harness(t, { stored: boundProfile, generationStartupMs: 30 });
  const opening = assert.rejects(h.manager.acquireGenerationBrowser(7), { code: 'CANCELLED' });
  await h.until(() => h.launches.length === 1);
  const stopping = h.manager.shutdown();
  assert.equal(h.manager.shutdown(), stopping);
  await stopping;
  await opening;
  assert.deepEqual(h.processEvents, ['launch', 'stop', 'exit']);
  await assert.rejects(h.manager.acquireGenerationBrowser(7), { code: 'SHUTDOWN' });
  const acquired = await harness(t, { stored: boundProfile });
  const lease = await acquired.manager.acquireGenerationBrowser(7);
  await acquired.manager.shutdown();
  await acquired.manager.releaseGenerationBrowser(lease);
  assert.deepEqual(acquired.processEvents, ['launch', 'stop', 'exit']);
});

test('native generation falls back to unique regular Chrome metadata without exposing or owning that profile', async t => {
  const reads = [];
  const h = await harness(t, {
    stored: boundProfile,
    regularProfiles: { Default: { user_name: 'Haenwuk@gmail.com' }, 'Profile 1': { user_name: 'someone@example.com' } },
    getAccount: id => { reads.push(id); return { id, email: 'Haenwuk@gmail.com' }; },
    onSpawn: child => child.emit('exit', 0),
  });
  const controller = new AbortController();
  const lease = await h.manager.acquireGenerationBrowser(1, { signal: controller.signal });
  assert.deepEqual(lease, { external: true, accountId: 1, email: 'haenwuk@gmail.com' });
  assert.equal(Object.isFrozen(lease), true);
  assert.deepEqual(reads, [1, 1]);
  assert.deepEqual(h.launches[0].args, ['--profile-directory=Default', '--new-window', 'https://flow.google.com/']);
  assert.equal(h.network.length, 0);
  assert.equal(h.synced.length, 0);
  assert.throws(() => h.manager.addAccount(), { code: 'GENERATION_BUSY' });
  controller.abort();
  await h.manager.releaseGenerationBrowser(lease);
  await h.manager.shutdown();
  assert.deepEqual(h.processEvents, ['launch']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.dataDir, 'google-accounts.json'), 'utf8')), boundProfile);
  assert.equal(await h.manager.hasAccountProfile(1), false);
});

test('native generation prefers its managed mapping over matching regular Chrome metadata', async t => {
  const h = await harness(t, {
    stored: boundProfile,
    regularProfiles: { Default: { user_name: 'person@example.com' } },
    getAccount: () => assert.fail('Managed profile must not consult regular Chrome account lookup'),
  });
  const lease = await h.manager.acquireGenerationBrowser(7, { reuseExternal: true });
  assert.equal(lease.external, undefined);
  assert.equal(lease.pid, 4001);
  assert.ok(h.launches[0].args[0].startsWith('--user-data-dir='));
  await h.manager.releaseGenerationBrowser(lease);
});

test('native generation fallback rejects changed account identity and ambiguous or unsafe metadata', async t => {
  let reads = 0;
  const changed = await harness(t, {
    stored: boundProfile, regularProfiles: { Default: { user_name: 'owner@example.com' } },
    getAccount: id => ({ id, email: ++reads === 1 ? 'owner@example.com' : 'changed@example.com' }),
  });
  await assert.rejects(changed.manager.acquireGenerationBrowser(1), { code: 'ACCOUNT_CHANGED' });
  assert.equal(changed.launches.length, 0);
  for (const regularProfiles of [
    { Default: { user_name: 'other@example.com' } },
    { Default: { user_name: 'owner@example.com' }, 'Profile 1': { user_name: 'owner@example.com' } },
    { '../outside': { user_name: 'owner@example.com' } },
    { Default: { user_name: 'owner@example.com', email: 'other@example.com' } },
  ]) {
    const h = await harness(t, { stored: boundProfile, regularProfiles, getAccount: id => ({ id, email: 'owner@example.com' }) });
    await assert.rejects(h.manager.acquireGenerationBrowser(1), { code: 'PROFILE_REQUIRED' });
    assert.equal(h.launches.length, 0);
    assert.equal(h.network.length, 0);
  }
  for (const getAccount of [() => null, () => ({ id: 2, email: 'owner@example.com' }), () => ({ id: 1, email: 'invalid' })]) {
    const h = await harness(t, { stored: boundProfile, regularProfiles: { Default: { user_name: 'owner@example.com' } }, getAccount });
    await assert.rejects(h.manager.acquireGenerationBrowser(1), { code: 'ACCOUNT_CHANGED' });
    assert.equal(h.launches.length, 0);
  }
});

test('native generation can lease an existing external Flow window without opening another one', async t => {
  const reads = [];
  const h = await harness(t, {
    stored: boundProfile, regularProfiles: { Default: { user_name: 'owner@example.com' } },
    getAccount: id => { reads.push(id); return { id, email: 'owner@example.com' }; },
  });
  for (const reuseExternal of [null, 1, 'true']) await assert.rejects(h.manager.acquireGenerationBrowser(1, { reuseExternal }), TypeError);
  const lease = await h.manager.acquireGenerationBrowser(1, { reuseExternal: true });
  assert.deepEqual(lease, { external: true, accountId: 1, email: 'owner@example.com' });
  assert.deepEqual(reads, [1, 1]);
  assert.deepEqual(h.processEvents, []);
  assert.equal(h.network.length, 0);
  assert.equal(h.synced.length, 0);
  assert.throws(() => h.manager.addAccount(), { code: 'GENERATION_BUSY' });
  await h.manager.releaseGenerationBrowser(lease);
  assert.deepEqual(h.processEvents, []);
  const launched = await h.manager.acquireGenerationBrowser(1, { reuseExternal: false });
  assert.deepEqual(launched, lease);
  assert.deepEqual(h.processEvents, ['launch']);
  await h.manager.releaseGenerationBrowser(launched);
  assert.deepEqual(h.processEvents, ['launch']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.dataDir, 'google-accounts.json'), 'utf8')), boundProfile);
});

test('shutdown and cancellation leave regular Chrome alive after generation fallback', async t => {
  const h = await harness(t, {
    stored: boundProfile, regularProfiles: { Default: { user_name: 'owner@example.com' } },
    getAccount: id => ({ id, email: 'owner@example.com' }),
  });
  const lease = await h.manager.acquireGenerationBrowser(1);
  await h.manager.shutdown();
  await h.manager.releaseGenerationBrowser(lease);
  assert.deepEqual(h.processEvents, ['launch']);
  const controller = new AbortController();
  const duringOpen = await harness(t, {
    stored: boundProfile, regularProfiles: { Default: { user_name: 'owner@example.com' } },
    getAccount: id => ({ id, email: 'owner@example.com' }),
    onSpawn: () => controller.abort(new Error('Cancel external launch')),
  });
  await assert.rejects(duringOpen.manager.acquireGenerationBrowser(1, { signal: controller.signal }), /Cancel external launch/);
  await duringOpen.manager.shutdown();
  assert.deepEqual(duringOpen.processEvents, ['launch']);
});

test('native discovery runs after autosync Chrome exits and holds generation reservation while deciding reuse', async t => {
  let stopRequested = false, finishExit, finishDecision, callbackStarted = false;
  const h = await harness(t, {
    stored: boundProfile, waitForIdentity: true, syncIntervalMs: 10,
    regularProfiles: { Default: { user_name: 'owner@example.com' } },
    getAccount: id => ({ id, email: 'owner@example.com' }),
    onSpawn(child, args) {
      if (args.includes('--no-startup-window')) child.kill = () => {
        stopRequested = true; finishExit = () => child.emit('exit', 0); return true;
      };
    },
  });
  h.manager.startAutoSync();
  await h.until(() => h.network.length > 0);
  const opening = h.manager.acquireGenerationBrowser(1, { resolveReuseExternal({ signal }) {
    assert.ok(signal instanceof AbortSignal);
    assert.equal(stopRequested, true);
    callbackStarted = true;
    return new Promise(resolve => { finishDecision = () => resolve(true); });
  } });
  try {
    await h.until(() => stopRequested);
    assert.equal(callbackStarted, false);
    await assert.rejects(h.manager.acquireGenerationBrowser(1), { code: 'GENERATION_BUSY' });
    finishExit();
    await h.until(() => callbackStarted);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.launches.length, 1, 'autosync and target launches stay blocked during discovery');
    finishDecision();
    const lease = await opening;
    assert.equal(lease.external, true);
    assert.equal(h.launches.length, 1, 'existing external window needs no target launch');
    await h.manager.releaseGenerationBrowser(lease);
  } finally { finishExit?.(); finishDecision?.(); await opening.catch(() => {}); }
});

test('native discovery rejection and invalid decisions free reservation without launching target Chrome', async t => {
  const h = await harness(t, {
    stored: boundProfile, regularProfiles: { Default: { user_name: 'owner@example.com' } },
    getAccount: id => ({ id, email: 'owner@example.com' }),
  });
  await assert.rejects(h.manager.acquireGenerationBrowser(1, { resolveReuseExternal: true }), TypeError);
  const ambiguous = Object.assign(new Error('Two user windows'), { code: 'FLOW_WINDOW_AMBIGUOUS' });
  await assert.rejects(h.manager.acquireGenerationBrowser(1, { resolveReuseExternal() { throw ambiguous; } }), error => error === ambiguous);
  await assert.rejects(h.manager.acquireGenerationBrowser(1, { resolveReuseExternal: () => 'true' }), TypeError);
  assert.equal(h.launches.length, 0);
  const lease = await h.manager.acquireGenerationBrowser(1, { reuseExternal: true });
  assert.equal(lease.external, true);
  await h.manager.releaseGenerationBrowser(lease);
});

test('native discovery cancellation aborts callback and frees reservation before any target launch', async t => {
  const h = await harness(t, {
    stored: boundProfile, regularProfiles: { Default: { user_name: 'owner@example.com' } },
    getAccount: id => ({ id, email: 'owner@example.com' }),
  });
  let callbackSignal;
  const controller = new AbortController();
  const opening = h.manager.acquireGenerationBrowser(1, { signal: controller.signal, resolveReuseExternal({ signal }) {
    callbackSignal = signal; return new Promise(() => {});
  } });
  const rejected = assert.rejects(opening, /Cancel discovery/);
  await h.until(() => callbackSignal);
  controller.abort(new Error('Cancel discovery'));
  await rejected;
  assert.equal(callbackSignal.aborted, true);
  assert.equal(h.launches.length, 0);
  const lease = await h.manager.acquireGenerationBrowser(1, { reuseExternal: true });
  await h.manager.releaseGenerationBrowser(lease);
});
