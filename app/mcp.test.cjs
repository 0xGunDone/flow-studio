'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { BridgeClient, readBridgeFile } = require('./bridge-client.cjs');
const { dispatch, definitions } = require('./mcp-server.cjs');

async function fakeBridge(t, handler = body => ({ method: body.method, params: body.params })) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-studio-mcp-'));
  const bridgePath = path.join(dir, 'agent-bridge.json');
  const token = 'a'.repeat(64);
  const calls = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.match(req.headers.host, /^127\.0\.0\.1:\d+$/);
    assert.equal(req.headers.origin, undefined);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({ ready: true, version: 1 }));
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body);
    const result = await handler(body, req, res);
    if (result !== undefined && !res.destroyed) res.end(JSON.stringify({ result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(bridgePath, JSON.stringify({ version: 1, port: server.address().port, token, pid: process.pid }), { mode: 0o600 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { bridgePath, calls, token, dir, server };
}

test('official SDK stdio initializes, lists strict tools, validates and calls local bridge', async t => {
  const bridge = await fakeBridge(t, body => body.method === 'status' ? { ready: true, modelsCount: 6, accounts: [], runningJobs: [], countHistory: 2 } : { jobId: 'fake-job', job: { id: 'fake-job', status: 'running' } });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, 'mcp-server.cjs')],
    env: { ...process.env, FLOW_STUDIO_BRIDGE_FILE: bridge.bridgePath, FLOW_STUDIO_NO_LAUNCH: '1' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'flow-studio-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), definitions.map(tool => tool.name));
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const generate = tools.find(tool => tool.name === 'flow_studio_generate');
  assert.equal(generate.inputSchema.properties.confirmCreditSpend.const, true);
  assert.equal(generate.inputSchema.properties.referencePaths.maxItems, 7);
  assert.equal(generate.inputSchema.properties.videoPaths.maxItems, 1);
  assert.ok(tools.find(tool => tool.name === 'flow_studio_list_models').inputSchema.properties.mode.enum.includes('edit'));
  assert.ok(generate.inputSchema.required.includes('requestId'));
  assert.equal(generate.annotations.idempotentHint, true);
  const status = await client.callTool({ name: 'flow_studio_status', arguments: {} });
  assert.equal(status.isError, undefined);
  assert.equal(status.structuredContent.ready, true);
  assert.equal(JSON.parse(status.content[0].text).modelsCount, 6);
  const valid = { model: 'example-image-model', prompt: 'test-only fake bridge', confirmCreditSpend: true, requestId: 'fake-request-id' };
  for (const args of [
    { ...valid, unexpected: true },
    { ...valid, confirmCreditSpend: false },
    { ...valid, requestId: '' },
    { ...valid, referencePaths: ['/tmp/reference.png'], startFramePath: '/tmp/start.png' },
    { ...valid, endFramePath: '/tmp/end.png' },
    { ...valid, referencePaths: ['https://example.com/image.png'] },
    { ...valid, referencePaths: Array(8).fill('/tmp/image.png') },
    { ...valid, videoPaths: ['/tmp/source.mp4'] },
    { ...valid, model: 'omni-1.1-flash-edit-landscape' },
    { ...valid, model: 'omni-1.1-flash-edit-landscape', videoPaths: ['/tmp/source.mp4'], referencePaths: Array(6).fill('/tmp/image.png') },
    { ...valid, model: 'omni-1.1-flash-edit-landscape', videoPaths: ['/tmp/source.mp4', '/tmp/second.mov'] },
    { ...valid, model: 'omni-1.1-flash-edit-landscape', videoPaths: ['relative.mp4'] },
    { ...valid, model: 'omni-1.1-flash-edit-landscape', videoPaths: ['https://example.com/source.mp4'] },
    { ...valid, model: 'omni-1.1-flash-edit-landscape', videoPaths: ['/tmp/source.avi'] },
    { ...valid, model: 'omni-1.1-flash-edit-landscape', videoPaths: ['/tmp/source.mp4'], startFramePath: '/tmp/start.png' },
    { ...valid, model: 'omni-1.1-flash-edit-landscape', videoPaths: ['/tmp/source.mp4'], sourceVideoId: 'source-id' },
  ]) {
    const result = await client.callTool({ name: 'flow_studio_generate', arguments: args });
    assert.equal(result.isError, true);
  }
  assert.equal(bridge.calls.length, 1, 'invalid input must never reach generation backend');
  const started = await client.callTool({ name: 'flow_studio_generate', arguments: valid });
  assert.equal(started.structuredContent.jobId, 'fake-job');
  assert.deepEqual(bridge.calls[1], { method: 'generate', params: valid });
  const mixed = { ...valid, model: 'omni-1.1-flash-edit-landscape', videoPaths: ['/tmp/source.MOV'], referencePaths: Array(5).fill('/tmp/image.png'), requestId: 'fake-edit-id' };
  assert.equal((await client.callTool({ name: 'flow_studio_generate', arguments: mixed })).isError, undefined);
  assert.deepEqual(bridge.calls[2], { method: 'generate', params: mixed });
  const images = { ...valid, model: 'omni-1.1-flash-8s-landscape', referencePaths: Array(7).fill('/tmp/image.png'), requestId: 'fake-seven-id' };
  assert.equal((await client.callTool({ name: 'flow_studio_generate', arguments: images })).isError, undefined);
  assert.deepEqual(bridge.calls[3], { method: 'generate', params: images });
  const unknown = await client.callTool({ name: 'flow_studio_arbitrary_method', arguments: {} });
  assert.equal(unknown.isError, true);
  assert.equal(stderr, '', 'stdio server must emit no diagnostic noise during normal calls');
});

test('CLI --call uses same bridge validation; --list-tools works offline', async t => {
  const bridge = await fakeBridge(t);
  const run = promisify(execFile);
  const args = [path.join(__dirname, 'mcp-server.cjs')];
  const env = { ...process.env, FLOW_STUDIO_BRIDGE_FILE: bridge.bridgePath, FLOW_STUDIO_NO_LAUNCH: '1' };
  const result = await run(process.execPath, [...args, '--call', 'history', '{"limit":2}'], { env });
  assert.deepEqual(JSON.parse(result.stdout), { result: { method: 'history', params: { limit: 2 } } });
  await assert.rejects(run(process.execPath, [...args, '--call', 'status', '{"token":"do-not-forward"}'], { env }), error => {
    assert.equal(JSON.parse(error.stdout).error.code, 'INVALID_ARGUMENTS');
    return true;
  });
  const listed = await run(process.execPath, [...args, '--list-tools'], { env: { ...env, FLOW_STUDIO_BRIDGE_FILE: '/missing/bridge.json' } });
  assert.equal(JSON.parse(listed.stdout).tools.length, 13);
  assert.equal(bridge.calls.length, 1);
});

test('private bridge file rejects unsafe mode, symlink, and remote host', async t => {
  const bridge = await fakeBridge(t);
  assert.equal((await readBridgeFile(bridge.bridgePath)).token, bridge.token);
  await fs.chmod(bridge.bridgePath, 0o644);
  await assert.rejects(readBridgeFile(bridge.bridgePath), { code: 'BRIDGE_UNSAFE' });
  await fs.chmod(bridge.bridgePath, 0o600);
  const link = path.join(bridge.dir, 'link.json');
  await fs.symlink(bridge.bridgePath, link);
  await assert.rejects(readBridgeFile(link), { code: 'BRIDGE_UNSAFE' });
  const data = JSON.parse(await fs.readFile(bridge.bridgePath, 'utf8'));
  await fs.writeFile(bridge.bridgePath, JSON.stringify({ ...data, host: 'example.com' }));
  await assert.rejects(readBridgeFile(bridge.bridgePath), { code: 'BRIDGE_INVALID' });
});

test('startup launches app once, retries fresh bridge file, and remains bounded', async t => {
  const bridge = await fakeBridge(t);
  const stagedPath = path.join(bridge.dir, 'not-yet-running.json');
  let launches = 0;
  const client = new BridgeClient({
    bridgePath: stagedPath, startupTimeoutMs: 200, retryDelayMs: 5,
    launch: async () => { launches++; await fs.copyFile(bridge.bridgePath, stagedPath); },
  });
  const [first, second] = await Promise.all([client.call('status', {}), client.call('history', { limit: 1 })]);
  assert.equal(first.method, 'status');
  assert.equal(second.method, 'history');
  assert.equal(launches, 1);
  const missing = new BridgeClient({ bridgePath: path.join(bridge.dir, 'missing.json'), startupTimeoutMs: 25, retryDelayMs: 5, launch: async () => {} });
  await assert.rejects(missing.call('status', {}), { code: 'BRIDGE_UNAVAILABLE' });
});

test('lost generation response retries exact requestId; app errors and unsafe mutations never retry', async t => {
  let generated = 0;
  const bridge = await fakeBridge(t, (body, req, res) => {
    if (body.method === 'generate' && ++generated === 1) { req.socket.destroy(); return; }
    if (body.method === 'generate') return { jobId: 'same-durable-job' };
    if (body.method === 'save') { req.socket.destroy(); return; }
    res.statusCode = 400;
    res.end(JSON.stringify({ error: { code: 'MODEL_DENIED', message: 'Requested model is unavailable.' } }));
  });
  const client = new BridgeClient({ bridgePath: bridge.bridgePath, launch: async () => { throw new Error('Unexpected launch'); } });
  const params = { model: 'requested-model', prompt: 'fake', confirmCreditSpend: true, requestId: 'stable-id' };
  assert.deepEqual(await dispatch(client, 'generate', params), { jobId: 'same-durable-job' });
  assert.equal(generated, 2);
  assert.deepEqual(bridge.calls[0], bridge.calls[1]);
  await assert.rejects(dispatch(client, 'save', { jobId: 'same-durable-job', outputPath: '/tmp/fake.png' }), { code: 'BRIDGE_TRANSPORT' });
  assert.equal(bridge.calls.filter(call => call.method === 'save').length, 1);
  await assert.rejects(client.call('models', {}), { code: 'MODEL_DENIED' });
  assert.equal(bridge.calls.filter(call => call.method === 'models').length, 1);
});
