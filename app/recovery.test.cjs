'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRecoveryManager } = require('./recovery.cjs');

const EMAIL = 'person@example.com';
const GOOD = { ok: true, accountId: 7, email: EMAIL, credits: 20 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function harness(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-recovery-test-'));
  const states = [], launches = [], checks = [];
  let accounts = [{ id: 7, email: EMAIL }];
  let verify = options.verify || (async () => GOOD);
  const localState = JSON.stringify({
    profile: { info_cache: options.profiles || { Default: { user_name: EMAIL, gaia_name: 'Example Person' } } },
    os_crypt: { encrypted_key: 'secret-not-for-ui' },
  });
  await fs.writeFile(path.join(dataDir, 'Local State'), localState);
  await fs.writeFile(path.join(dataDir, 'Login Data'), 'private-password-data');
  const manager = createRecoveryManager({
    chromeDataDir: dataDir, chromePath: '/fake/Google Chrome',
    listAccounts: async () => accounts,
    verifyAccount: async (id, options) => { checks.push({ id, ...options }); return verify(id, options); },
    onState: state => states.push(state),
  }, {
    pollMs: 0,
    spawn: (executable, args, spawnOptions) => {
      const child = new EventEmitter();
      child.kill = () => assert.fail('Regular Chrome must never be killed');
      child.unref = () => { child.unreferenced = true; };
      launches.push({ executable, args, options: spawnOptions, child });
      if (options.spawnError) queueMicrotask(() => child.emit('error', new Error('secret-chrome-error')));
      else if (!options.delaySpawn) queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    ...options.deps,
  });
  t.after(async () => { manager.shutdown(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const until = async predicate => {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(`Timed out: ${JSON.stringify(states)}`);
      await pause(2);
    }
  };
  return { manager, dataDir, localState, states, launches, checks, until,
    setAccounts: value => { accounts = value; }, setVerify: value => { verify = value; } };
}

test('opens exact email profile in ordinary Chrome and verifies same server identity without secrets', async t => {
  const h = await harness(t, { profiles: {
    Default: { user_name: 'another@example.com' },
    'Profile 14': { user_name: ' PERSON@example.com ', gaia_name: 'Example Person' },
  } });
  const initial = await h.manager.begin(7);
  assert.equal(initial.state, 'waiting');
  assert.equal(initial.method, 'chrome');
  assert.equal(initial.accountId, 7);
  assert.equal(initial.email, EMAIL);
  assert.equal(initial.canComplete, true);
  assert.equal(initial.completeLabel, 'Проверить подключение');
  assert.match(initial.message, /30 секунд/);
  assert.equal(h.manager.active, true);
  assert.equal(h.checks.length, 0);
  assert.deepEqual(h.launches[0].args, ['--profile-directory=Profile 14', '--new-window', 'https://flow.google.com/projects']);
  assert.deepEqual(h.launches[0].options, { stdio: 'ignore', detached: true });
  assert.equal(h.launches[0].executable, '/fake/Google Chrome');
  assert.equal(h.launches[0].child.unreferenced, true);
  assert.equal((await h.manager.verify()).state, 'succeeded');
  assert.equal(h.manager.active, false);
  assert.equal(h.checks[0].id, 7);
  assert(h.checks[0].signal instanceof AbortSignal);
  assert.deepEqual(h.states.map(state => state.state), ['opening', 'waiting', 'syncing', 'succeeded']);
  assert.equal(await fs.readFile(path.join(h.dataDir, 'Local State'), 'utf8'), h.localState);
  assert.equal(await fs.readFile(path.join(h.dataDir, 'Login Data'), 'utf8'), 'private-password-data');
  assert.doesNotMatch(JSON.stringify({ states: h.states, launches: h.launches }), /secret-not-for-ui|private-password-data/);
});

test('missing, ambiguous, unsafe and conflicting profile identities fall back without launching', async t => {
  const cases = [
    { Default: { user_name: 'different@example.com', gaia_name: 'Example Person' } },
    { Default: { user_name: EMAIL }, 'Profile 2': { email: EMAIL } },
    { '../Default': { user_name: EMAIL } },
    { 'Profile 2 --remote-debugging-port=9999': { user_name: EMAIL } },
    { Default: { user_name: EMAIL, email: 'different@example.com' } },
  ];
  for (const profiles of cases) {
    const h = await harness(t, { profiles });
    assert.equal(await h.manager.begin(7), null);
    assert.equal(h.manager.active, false);
    assert.equal(h.launches.length, 0);
    assert.equal(h.states.length, 0);
  }
});

test('unreadable, malformed and symlinked Local State fall back without inspecting another file', async t => {
  const h = await harness(t);
  const file = path.join(h.dataDir, 'Local State');
  await fs.writeFile(file, 'not json secret');
  assert.equal(await h.manager.begin(7), null);
  await fs.unlink(file);
  assert.equal(await h.manager.begin(7), null);
  await fs.writeFile(path.join(h.dataDir, 'other'), h.localState);
  await fs.symlink(path.join(h.dataDir, 'other'), file);
  assert.equal(await h.manager.begin(7), null);
  assert.equal(h.launches.length, 0);
});

test('wrong identity, absent verification and backend failures remain actionable and permit retry', async t => {
  const h = await harness(t);
  await h.manager.begin(7);
  for (const result of [
    { ...GOOD, accountId: 8 }, { ...GOOD, email: 'wrong@example.com' },
    { ...GOOD, ok: false }, { accountId: 7, email: EMAIL }, null,
  ]) {
    h.setVerify(async () => result);
    const state = await h.manager.verify();
    assert.equal(state.state, 'waiting');
    assert.equal(state.canComplete, true);
    assert.equal(h.manager.active, true);
  }
  h.setVerify(async () => { throw new Error('cookie=secret-backend-data'); });
  assert.equal((await h.manager.verify()).state, 'waiting');
  assert.doesNotMatch(JSON.stringify(h.states), /secret-backend-data/);
  h.setVerify(async () => GOOD);
  assert.equal((await h.manager.verify()).state, 'succeeded');
  assert.equal(h.launches.length, 1);
});

test('changed account binding prevents stale successful verification', async t => {
  let finish;
  const h = await harness(t, { verify: () => new Promise(resolve => { finish = resolve; }) });
  await h.manager.begin(7);
  const check = h.manager.verify();
  await h.until(() => finish);
  h.setAccounts([{ id: 7, email: 'changed@example.com' }]);
  finish(GOOD);
  assert.equal((await check).state, 'failed');
  assert.equal(h.manager.state.code, 'ACCOUNT_CHANGED');
  assert.equal(h.manager.active, false);
  assert.equal(h.states.some(state => state.state === 'succeeded'), false);
});

test('removed or ambiguous account binding fails before any server verification', async t => {
  const h = await harness(t);
  await h.manager.begin(7);
  h.setAccounts([]);
  assert.equal((await h.manager.verify()).state, 'failed');
  assert.equal(h.checks.length, 0);
  h.setAccounts([{ id: 7, email: EMAIL }, { accountId: 7, email: EMAIL }]);
  assert.equal((await h.manager.begin(7)).state, 'failed');
  assert.equal(h.launches.length, 1);
});

test('cancel aborts in-flight check, resolves immediately and ignores later success', async t => {
  let finish;
  const h = await harness(t, { verify: () => new Promise(resolve => { finish = resolve; }) });
  await h.manager.begin(7);
  const check = h.manager.verify();
  assert.equal(h.manager.verify(), check);
  await h.until(() => finish);
  assert.equal(h.manager.cancel().state, 'cancelled');
  assert.equal(h.checks[0].signal.aborted, true);
  assert.equal((await check).state, 'cancelled');
  finish(GOOD);
  await pause(5);
  assert.equal(h.manager.state.state, 'cancelled');
  assert.equal(h.manager.active, false);
  assert.equal(h.states.some(state => state.state === 'succeeded'), false);
});

test('cancel while Chrome opens leaves normal Chrome intact and discards late spawn', async t => {
  const h = await harness(t, { delaySpawn: true });
  const opening = h.manager.begin(7);
  await h.until(() => h.launches.length);
  h.manager.cancel();
  assert.equal((await opening).state, 'cancelled');
  h.launches[0].child.emit('spawn');
  await pause(5);
  assert.equal(h.manager.state.state, 'cancelled');
  assert.equal(h.checks.length, 0);
});

test('poll waits for initial extension sync and never overlaps manual checks', async t => {
  let finish;
  const h = await harness(t, { verify: () => new Promise(resolve => { finish = resolve; }), deps: { initialPollMs: 70, pollMs: 10 } });
  await h.manager.begin(7);
  await pause(25);
  assert.equal(h.checks.length, 0);
  const manual = h.manager.verify();
  await h.until(() => finish);
  await pause(80);
  assert.equal(h.checks.length, 1);
  assert.equal(h.manager.verify(), manual);
  finish({ ok: false });
  assert.equal((await manual).state, 'waiting');
  h.setVerify(async () => GOOD);
  await h.until(() => h.manager.state.state === 'succeeded');
  assert.equal(h.checks.length, 2);
});

test('poll deadline stops auto checks but keeps manual retry available', async t => {
  const h = await harness(t, { deps: { initialPollMs: 30, pollMs: 5, timeoutMs: 15 } });
  await h.manager.begin(7);
  await pause(40);
  assert.equal(h.checks.length, 0);
  assert.equal(h.manager.state.state, 'waiting');
  assert.match(h.manager.state.message, /Автопроверка завершена/);
  assert.equal((await h.manager.verify()).state, 'succeeded');
});

test('check timeout returns retryable state without leaking errors', async t => {
  const h = await harness(t, { verify: () => new Promise(() => {}), deps: { verifyTimeoutMs: 15 } });
  await h.manager.begin(7);
  const check = h.manager.verify();
  await h.until(() => h.manager.state.state === 'waiting');
  assert.equal((await check).state, 'waiting');
  assert.equal(h.checks[0].signal.aborted, true);
  assert.equal(h.manager.state.code, 'VERIFY_FAILED');
});

test('Chrome startup failures and shutdown are safe and terminal', async t => {
  const h = await harness(t, { spawnError: true });
  assert.equal((await h.manager.begin(7)).state, 'failed');
  assert.equal(h.manager.active, false);
  assert.doesNotMatch(JSON.stringify(h.states), /secret-chrome-error/);
  h.manager.shutdown();
  assert.throws(() => h.manager.begin(7), { code: 'SHUTDOWN' });
  assert.throws(() => createRecoveryManager({}), TypeError);
});
