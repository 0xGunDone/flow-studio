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
const { createAgentActions } = require('./agent-bridge.cjs');
const { Runtime } = require('./runtime.cjs');

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
  assert.equal(generate.inputSchema.required.includes('model'),false);
  assert.equal(generate.inputSchema.properties.settings.additionalProperties,false);
  const prepare=tools.find(tool=>tool.name==='flow_studio_prepare_generation');
  assert.equal(prepare.annotations.readOnlyHint,true);assert.equal(prepare.annotations.destructiveHint,false);
  assert.equal(prepare.inputSchema.properties.confirmCreditSpend,undefined);
  assert.equal(prepare.inputSchema.properties.requestId,undefined);
  assert.equal(generate.annotations.idempotentHint, true);
  const status = await client.callTool({ name: 'flow_studio_status', arguments: {} });
  assert.equal(status.isError, undefined, JSON.stringify(status));
  assert.equal(status.structuredContent.ready, true);
  assert.equal(JSON.parse(status.content[0].text).modelsCount, 6);
  const valid = { model: 'example-image-model', prompt: 'test-only fake bridge', confirmCreditSpend: true, requestId: 'fake-request-id' };
  const settings={kind:'video',method:'frames',family:'Veo 3.1 Fast',durationSeconds:8,aspectRatio:'16:9',resolution:'standard'};
  for (const args of [
    { ...valid, unexpected: true },
    { ...valid, model:undefined },
    { ...valid, settings },
    { ...valid, model:undefined,settings,method:'frames' },
    { ...valid, model:undefined,settings:{...settings,durationSeconds:undefined},startFramePath:'/tmp/start.png' },
    { ...valid, model:undefined,settings:{...settings,kind:'image'},startFramePath:'/tmp/start.png' },
    { ...valid, model:undefined,settings:{...settings,method:'edit'},videoPaths:['/tmp/source.mp4'] },
    { ...valid, method:'text',referencePaths:['/tmp/image.png'] },
    { ...valid, method:'ingredients' },
    { ...valid, method:'frames' },
    { ...valid, method:'extend',referencePaths:['/tmp/image.png'],sourceVideoId:'video-id' },
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
  const plan={settings,prompt:'prepare only',startFramePath:'/tmp/start.png',endFramePath:'/tmp/end.png'};
  assert.equal((await client.callTool({name:'flow_studio_prepare_generation',arguments:plan})).isError,undefined);
  assert.deepEqual(bridge.calls[4],{method:'prepare',params:plan});
  const selected={...plan,requestId:'settings-stable',confirmCreditSpend:true};
  assert.equal((await client.callTool({name:'flow_studio_generate',arguments:selected})).isError,undefined);
  assert.deepEqual(bridge.calls[5],{method:'generate',params:selected});
  for(const bad of [{...plan,confirmCreditSpend:true},{...plan,requestId:'not-for-prepare'},{...plan,settings:{...settings,unexpected:true}}])assert.equal((await client.callTool({name:'flow_studio_prepare_generation',arguments:bad})).isError,true);
  assert.equal(bridge.calls.length,6,'Invalid preparation never reaches the bridge');
  const filters={kind:'video',method:'ingredients',family:'Omni 1.1 Flash',durationSeconds:8,aspectRatio:'9:16',resolution:'standard'};
  assert.equal((await client.callTool({name:'flow_studio_list_models',arguments:filters})).isError,undefined);
  assert.deepEqual(bridge.calls[6],{method:'models',params:filters});
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
  assert.equal(JSON.parse(listed.stdout).tools.length, 14);
  const plan={settings:{kind:'image',method:'image',family:'Nano Banana 2.1',aspectRatio:'1:1'},prompt:'plan only',referencePaths:['/tmp/image.png']};
  const prepared=await run(process.execPath,[...args,'--call','prepare',JSON.stringify(plan)],{env});
  assert.deepEqual(JSON.parse(prepared.stdout),{result:{method:'prepare',params:plan}});
  assert.equal(bridge.calls.length, 2);
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

test('MCP prepare resolves UI settings without generation and pins a deduplicated authorized request',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'flow-mcp-prepare-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const start=path.join(root,'start.png'),end=path.join(root,'end.png');await fs.writeFile(start,'start');await fs.writeFile(end,'end');
  const runtime=new Runtime({});runtime.ready=true;
  runtime.models=[{id:'veo-3.1-fast-i2v-8s-landscape'},{id:'veo-3.1-fast-8s-landscape'},{id:'veo-3.1-fast'},{id:'omni-1.1-flash-8s-landscape'}];
  let generations=0,persists=0;runtime.start=async()=>runtime.snapshot();runtime.persist=async()=>{persists++;};runtime.runJob=async()=>{generations++;};
  const actions=createAgentActions({runtime});
  const bridge=await fakeBridge(t,async(body,_req,res)=>{try{return await actions(body.method,body.params);}catch(error){res.statusCode=400;res.end(JSON.stringify({error:{code:error.code||'request_failed',message:error.message}}));}});
  const client=new BridgeClient({bridgePath:bridge.bridgePath,launch:async()=>{throw Error('Unexpected launch');}});
  const status=await dispatch(client,'status',{});assert.equal(status.apiVersion,2);assert(status.features.includes('prepare-generation'));
  const settings={kind:'video',method:'frames',family:'Veo 3.1 Fast',durationSeconds:8,aspectRatio:'16:9'};
  const plan=await dispatch(client,'prepare',{settings,prompt:'Local test only',startFramePath:start,endFramePath:end});
  assert.equal(plan.valid,true);assert.equal(plan.model.id,'veo-3.1-fast-i2v-8s-landscape');assert.equal(plan.method,'frames');
  assert.equal(plan.inputs.startFrame,true);assert.equal(plan.inputs.endFrame,true);assert.equal(plan.checks.accountAccess,'not_checked');
  assert.equal(plan.generateArguments.settings,undefined);assert.equal(plan.generateArguments.model,plan.model.id);assert.equal(plan.generateArguments.method,'frames');
  assert.equal(JSON.stringify(plan).includes('base64'),false);assert.equal(plan.generateArguments.confirmCreditSpend,undefined);assert.equal(plan.generateArguments.requestId,undefined);
  assert.equal(generations,0);assert.equal(persists,0);assert.equal(runtime.jobs.length,0);
  const args={...plan.generateArguments,confirmCreditSpend:true,requestId:'prepared-stable'};
  const first=await dispatch(client,'generate',args),again=await dispatch(client,'generate',args);
  assert.equal(first.jobId,again.jobId);assert.equal(generations,1);assert.equal(runtime.jobs.length,1);
  await assert.rejects(dispatch(client,'generate',{...args,prompt:'Changed prompt'}),/requestId/);
  assert.equal(generations,1);
  const textPlan=await dispatch(client,'prepare',{settings:{...settings,method:'text'},prompt:'Text only'});
  assert.equal(textPlan.model.id,'veo-3.1-fast-8s-landscape','Only known alias resolves to the canonical variant');
  await assert.rejects(dispatch(client,'prepare',{settings:{...settings,durationSeconds:10},prompt:'No available option',startFramePath:start}));
  assert.equal(generations,1);assert.equal(runtime.jobs.length,1);
});
