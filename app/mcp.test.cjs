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
  const bridge = await fakeBridge(t, body => body.method === 'status' ? { ready: true, modelsCount: 6, accounts: [], runningJobs: [], countHistory: 2, features:['video-watermark-selection'] } : { jobId: 'fake-job', job: { id: 'fake-job', status: 'running' } });
  const requests = () => bridge.calls.filter(call => call.method !== 'status');
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
  assert.match(generate.inputSchema.properties.videoPaths.description,/fileLimits\.video\.maxDurationSeconds/);
  assert.match(generate.inputSchema.properties.videoPaths.description,/Omni 1\.2 Edit allows 15s; Omni 1\.1 Edit allows 10s/);
  assert.equal(generate.inputSchema.properties.accountId.minimum, 1);
  assert.equal(generate.inputSchema.properties.accountId.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(generate.inputSchema.required.includes('accountId'), false);
  assert.deepEqual(generate.inputSchema.properties.videoWatermark.enum,['with','without']);
  assert.equal(generate.inputSchema.required.includes('videoWatermark'),false);
  assert.equal(generate.inputSchema.properties.settings.properties.videoWatermark,undefined);
  assert.ok(tools.find(tool => tool.name === 'flow_studio_list_models').inputSchema.properties.mode.enum.includes('edit'));
  assert.ok(generate.inputSchema.required.includes('requestId'));
  assert.equal(generate.inputSchema.required.includes('model'),false);
  assert.equal(generate.inputSchema.properties.settings.additionalProperties,false);
  const prepare=tools.find(tool=>tool.name==='flow_studio_prepare_generation');
  assert.equal(prepare.annotations.readOnlyHint,false);assert.equal(prepare.annotations.destructiveHint,false);assert.equal(prepare.annotations.idempotentHint,false);
  assert.equal(prepare.inputSchema.properties.confirmCreditSpend,undefined);
  assert.equal(prepare.inputSchema.properties.requestId,undefined);
  assert.equal(prepare.inputSchema.properties.accountId.minimum,1);
  assert.deepEqual(prepare.inputSchema.properties.videoWatermark.enum,['with','without']);
  assert.equal(prepare.inputSchema.properties.checkBrowser.type,'boolean');assert.equal(generate.inputSchema.properties.checkBrowser,undefined);
  assert.match(generate.description,/isolated background browser/);
  assert.match(tools.find(tool=>tool.name==='flow_studio_prepare_browser').description,/Legacy diagnostic/);
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
    { ...valid, requestId: '' },{...valid,checkBrowser:true},{...valid,checkBrowser:false},
    { ...valid, method:'image', videoWatermark:'with' },
    { ...valid, videoWatermark:'off' },
    { ...valid, videoWatermark:null },
    ...[null,0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'7'].map(accountId=>({...valid,accountId})),
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
  assert.deepEqual(requests()[0], { method: 'generate', params: valid });
  const mixed = { ...valid, model: 'omni-1.1-flash-edit-landscape', videoPaths: ['/tmp/source.MOV'], referencePaths: Array(5).fill('/tmp/image.png'), accountId:7, requestId: 'fake-edit-id' };
  assert.equal((await client.callTool({ name: 'flow_studio_generate', arguments: mixed })).isError, undefined);
  assert.deepEqual(requests()[1], { method: 'generate', params: mixed });
  const images = { ...valid, model: 'omni-1.1-flash-8s-landscape', referencePaths: Array(7).fill('/tmp/image.png'), requestId: 'fake-seven-id' };
  assert.equal((await client.callTool({ name: 'flow_studio_generate', arguments: images })).isError, undefined);
  assert.deepEqual(requests()[2], { method: 'generate', params: images });
  const plan={settings,prompt:'prepare only',startFramePath:'/tmp/start.png',endFramePath:'/tmp/end.png',accountId:7,videoWatermark:'without'};
  assert.equal((await client.callTool({name:'flow_studio_prepare_generation',arguments:plan})).isError,undefined);
  assert.deepEqual(requests()[3],{method:'prepare',params:plan});
  const selected={...plan,requestId:'settings-stable',confirmCreditSpend:true};
  assert.equal((await client.callTool({name:'flow_studio_generate',arguments:selected})).isError,undefined);
  assert.deepEqual(requests()[4],{method:'generate',params:selected});
  for(const bad of [{...plan,confirmCreditSpend:true},{...plan,requestId:'not-for-prepare'},{...plan,videoWatermark:'on'},{...plan,settings:{...settings,videoWatermark:'without'}},...[null,0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'7'].map(accountId=>({...plan,accountId}))])assert.equal((await client.callTool({name:'flow_studio_prepare_generation',arguments:bad})).isError,true);
  assert.equal(requests().length,5,'Invalid preparation never reaches the bridge');
  const filters={kind:'video',method:'ingredients',family:'Omni 1.1 Flash',durationSeconds:8,aspectRatio:'9:16',resolution:'standard'};
  assert.equal((await client.callTool({name:'flow_studio_list_models',arguments:filters})).isError,undefined);
  assert.deepEqual(requests()[5],{method:'models',params:filters});
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
  const tools=JSON.parse(listed.stdout).tools;
  assert.equal(tools.length, definitions.length);
  for(const method of ['prepare','generate'])assert.ok(tools.find(tool=>tool.method===method).parameters.includes('videoWatermark'));
  const plan={settings:{kind:'image',method:'image',family:'Nano Banana 2.1',aspectRatio:'1:1'},prompt:'plan only',referencePaths:['/tmp/image.png']};
  const prepared=await run(process.execPath,[...args,'--call','prepare',JSON.stringify(plan)],{env});
  assert.deepEqual(JSON.parse(prepared.stdout),{result:{method:'prepare',params:plan}});
  await assert.rejects(run(process.execPath,[...args,'--call','prepare',JSON.stringify({...plan,videoWatermark:'without'})],{env}),error=>JSON.parse(error.stdout).error.code==='INVALID_ARGUMENTS');
  assert.equal(bridge.calls.length, 2);
});

test('isolated inspection accepts one exact account and keeps cancellation on shared bridge operation',async()=>{
  const calls=[],client={call:async(...args)=>{calls.push(args);return args[0]==='isolated_inspect'?{ready:true,accountId:7,accountEmail:'owner@example.test',projectURL:'https://flow.google.com/project/fixture',engine:'isolated-browser',usesDesktopFocus:false}:{job:{id:'pending',status:'running',unknownOutcome:true}};}};
  for(const params of [undefined,null,[],{},1,{accountId:7,extra:true},{accountId:0},{accountId:-1},{accountId:1.5},{accountId:Number.MAX_SAFE_INTEGER+1},{accountId:'7'}])await assert.rejects(dispatch(client,'isolated_inspect',params),{code:'INVALID_ARGUMENTS'});
  assert.equal(calls.length,0);
  const signal=new AbortController().signal,result=await dispatch(client,'isolated_inspect',{accountId:7},{signal});
  assert.equal(result.ready,true);assert.equal(result.usesDesktopFocus,false);assert.deepEqual(calls[0],['isolated_inspect',{accountId:7},{signal}]);
  const definition=definitions.find(item=>item.method==='isolated_inspect');assert.equal(definition.name,'flow_studio_inspect_isolated_browser');
  assert.equal(definition.annotations.readOnlyHint,false);assert.equal(definition.annotations.destructiveHint,false);assert.equal(definition.annotations.idempotentHint,false);
  assert.match(definition.description,/without desktop focus/);assert.match(definition.description,/updates its local cache/);assert.match(definition.description,/Does not upload/);assert.match(definition.description,/spend generation credits/);
  const cancelled=await dispatch(client,'cancel',{jobId:'pending'});assert.equal(cancelled.job.status,'running');assert.equal(cancelled.job.unknownOutcome,true);assert.deepEqual(calls[1].slice(0,2),['cancel',{jobId:'pending'}]);
});
test('optional browser prepare is strict and strips no paid fields into ordinary generate schema',async()=>{
 const calls=[],client={call:async(...args)=>{calls.push(args);return {valid:true,checks:{browser:'passed',upload:'passed'}};}};
 const input={model:'omni-1.2-flash-8s-landscape',method:'ingredients',prompt:'test',referencePaths:['/tmp/reference.png'],accountId:7,checkBrowser:true};
 for(const patch of [{accountId:undefined},{checkBrowser:'true'},{checkBrowser:1},{confirmCreditSpend:true},{requestId:'not-for-prepare'}])await assert.rejects(dispatch(client,'prepare',{...input,...patch}),{code:'INVALID_ARGUMENTS'});
 assert.equal(calls.length,0);await dispatch(client,'prepare',input);assert.deepEqual(calls[0].slice(0,2),['prepare',input]);
 await dispatch(client,'prepare',{...input,checkBrowser:false,accountId:undefined});assert.equal(calls.length,2);
 const definition=definitions.find(item=>item.method==='prepare');assert.equal(definition.annotations.readOnlyHint,false);assert.equal(definition.annotations.idempotentHint,false);assert.match(definition.description,/uploads requested images/);assert.match(definition.description,/Never clicks Generate/);
});
test('browser upload preparation uses one 600s bridge call and never retries transport errors',async()=>{
 const input={model:'omni-1.2-flash-8s-landscape',prompt:'test',accountId:7,checkBrowser:true};
 for(const code of ['BRIDGE_TRANSPORT','BRIDGE_TIMEOUT']){
  const client=new BridgeClient(),calls=[];client.connect=async()=>({});client.request=async(...args)=>{
   if(JSON.parse(args[2]).method==='status')return {result:{features:['video-watermark-selection']}};
   calls.push(args);throw Object.assign(new Error('Synthetic transport failure'),{code});
  };
  await assert.rejects(client.call('prepare',input),{code});assert.equal(calls.length,1);assert.equal(calls[0][3],600000);
 }
 for(const local of [{model:input.model,prompt:input.prompt},{...input,checkBrowser:false}]){
  const client=new BridgeClient();let calls=0;client.connect=async()=>({});client.request=async(...args)=>{assert.equal(args[3],120000);if(++calls===1)throw Object.assign(new Error('Lost local preview'),{code:'BRIDGE_TRANSPORT'});return {result:{valid:true}};};
  assert.deepEqual(await client.call('prepare',local),{valid:true});assert.equal(calls,2,'Local-only preparation preserves safe retry behavior');
 }
});
test('browser preparation can finish after consent crosses the old 120s transport deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let finish,requestSignal,calls=0;
 const client=new BridgeClient({fetch:async(_url,options)=>{
  if(JSON.parse(options.body).method==='status')return {ok:true,text:async()=>JSON.stringify({result:{features:['video-watermark-selection']}})};
  calls++;requestSignal=options.signal;return new Promise((resolve,reject)=>{
  finish=()=>resolve({ok:true,text:async()=>JSON.stringify({result:{valid:true,checks:{browser:'passed'}}})});
  requestSignal.addEventListener('abort',()=>reject(requestSignal.reason),{once:true});
 });}});client.connect=async()=>({port:12345,token:'fixture'});
 const pending=client.call('prepare',{model:'omni-1.2-flash-8s-landscape',prompt:'test',accountId:7,checkBrowser:true}).then(value=>({value}),error=>({error}));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 t.mock.timers.tick(120001);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(requestSignal.aborted,false);finish();
 assert.deepEqual(await pending,{value:{valid:true,checks:{browser:'passed'}}});assert.equal(calls,1);
});
test('recover existing job schema rejects paid selectors and transport never retries read-only browser recovery',async()=>{
 const calls=[],client={call:async(...args)=>{calls.push(args);return {jobId:'original',job:{id:'original',status:'running',recovering:true}};}};
 for(const params of [{},{jobId:''},{jobId:'original',requestId:'new'},{jobId:'original',confirmCreditSpend:true},{jobId:'original',model:'override'}])await assert.rejects(dispatch(client,'recover',params),{code:'INVALID_ARGUMENTS'});
 assert.equal(calls.length,0);assert.equal((await dispatch(client,'recover',{jobId:'original'})).jobId,'original');assert.deepEqual(calls[0].slice(0,2),['recover',{jobId:'original'}]);
 const definition=definitions.find(item=>item.method==='recover');assert.equal(definition.name,'flow_studio_recover_job');assert.equal(definition.annotations.readOnlyHint,false);assert.equal(definition.annotations.idempotentHint,false);assert.match(definition.description,/Never uploads/);
 for(const code of ['BRIDGE_TIMEOUT','BRIDGE_TRANSPORT']){const bridge=new BridgeClient();let count=0;bridge.connect=async()=>({});bridge.request=async(...args)=>{count++;assert.equal(args[3],120000);throw Object.assign(new Error('Synthetic recovery failure'),{code});};await assert.rejects(bridge.call('recover',{jobId:'original'}),{code});assert.equal(count,1);}
});
test('manual cooldown reset has one strict account selector and never retries transport failure',async()=>{
 const calls=[],client={call:async(...args)=>{calls.push(args);return {cleared:true,accounts:[]};}};
 for(const params of [{},{accountId:0},{accountId:-1},{accountId:1.5},{accountId:'7'},{accountId:7,requestId:'extra'}])await assert.rejects(dispatch(client,'reset_cooldown',params),{code:'INVALID_ARGUMENTS'});
 await dispatch(client,'reset_cooldown',{accountId:7});assert.deepEqual(calls[0].slice(0,2),['reset_cooldown',{accountId:7}]);
 const tool=definitions.find(item=>item.method==='reset_cooldown');assert.equal(tool.name,'flow_studio_reset_account_cooldown');assert.equal(tool.annotations.readOnlyHint,false);assert.equal(tool.annotations.idempotentHint,false);
 const bridge=new BridgeClient();let count=0;bridge.connect=async()=>({});bridge.request=async()=>{count++;throw Object.assign(new Error('Synthetic transport failure'),{code:'BRIDGE_TRANSPORT'});};await assert.rejects(bridge.call('reset_cooldown',{accountId:7}),{code:'BRIDGE_TRANSPORT'});assert.equal(count,1);
});
test('explicit account participation and connection checks are strict and never transport-retry',async()=>{
 const calls=[],client={call:async(...args)=>{calls.push(args);return {ok:true};}};
 for(const [method,params] of [['set_account_active',{accountId:7,enabled:'false'}],['set_account_active',{accountId:7}],['check_account',{accountId:7,enabled:true}],['check_account',{accountId:-1}]])await assert.rejects(dispatch(client,method,params),{code:'INVALID_ARGUMENTS'});
 await dispatch(client,'set_account_active',{accountId:7,enabled:true});await dispatch(client,'check_account',{accountId:7});assert.deepEqual(calls.map(call=>call.slice(0,2)),[['set_account_active',{accountId:7,enabled:true}],['check_account',{accountId:7}]]);
 for(const method of ['set_account_active','check_account']){const bridge=new BridgeClient();let count=0;bridge.connect=async()=>({});bridge.request=async()=>{count++;throw Object.assign(new Error('Synthetic transport failure'),{code:'BRIDGE_TRANSPORT'});};await assert.rejects(bridge.call(method,method==='set_account_active'?{accountId:7,enabled:true}:{accountId:7}),{code:'BRIDGE_TRANSPORT'});assert.equal(count,1);}
});
test('internal consent handoff uses one 60s bridge call and is absent from MCP tools',async()=>{
 assert.equal(definitions.some(tool=>tool.method.startsWith('upload_rights_')),false);
 for(const method of ['upload_rights_status','upload_rights_respond']){
  const bridge=new BridgeClient();let calls=0;bridge.connect=async()=>({});bridge.request=async(...args)=>{calls++;assert.equal(args[3],60000);throw Object.assign(new Error('Synthetic transport failure'),{code:'BRIDGE_TRANSPORT'});};
  await assert.rejects(bridge.call(method,method==='upload_rights_status'?{}:{token:'00000000-0000-4000-8000-000000000001',accept:false}),{code:'BRIDGE_TRANSPORT'});assert.equal(calls,1);
 }
});
test('batch account check accepts empty input only and never retries its long managed check',async()=>{
 const calls=[],client={call:async(...args)=>{calls.push(args);return {total:2,checked:2,verified:1,failed:1,skipped:0,results:[]};}};
 for(const params of [null,[],{accountId:7},{enabled:true}])await assert.rejects(dispatch(client,'check_enabled_accounts',params),{code:'INVALID_ARGUMENTS'});
 assert.equal((await dispatch(client,'check_enabled_accounts',{})).checked,2);assert.deepEqual(calls[0].slice(0,2),['check_enabled_accounts',{}]);
 const tool=definitions.find(item=>item.method==='check_enabled_accounts');assert.equal(tool.name,'flow_studio_check_enabled_accounts');assert.equal(tool.annotations.idempotentHint,false);
 const bridge=new BridgeClient();let count=0;bridge.connect=async()=>({});bridge.request=async(...args)=>{count++;assert.equal(args[3],600000);throw Object.assign(new Error('Synthetic batch timeout'),{code:'BRIDGE_TIMEOUT'});};await assert.rejects(bridge.call('check_enabled_accounts',{}),{code:'BRIDGE_TIMEOUT'});assert.equal(count,1);
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
    if (body.method === 'status') return { features: ['video-watermark-selection'] };
    if (body.method === 'generate' && ++generated === 1) { req.socket.destroy(); return; }
    if (body.method === 'generate') return { jobId: 'same-durable-job' };
    if (body.method === 'save') { req.socket.destroy(); return; }
    res.statusCode = 400;
    res.end(JSON.stringify({ error: { code: 'MODEL_DENIED', message: 'Requested model is unavailable.' } }));
  });
  const client = new BridgeClient({ bridgePath: bridge.bridgePath, launch: async () => { throw new Error('Unexpected launch'); } });
  const params = { model: 'requested-model', prompt: 'fake', confirmCreditSpend: true, requestId: 'stable-id', videoWatermark: 'without' };
  assert.deepEqual(await dispatch(client, 'generate', params), { jobId: 'same-durable-job' });
  assert.equal(generated, 2);
  assert.deepEqual(bridge.calls.map(call=>call.method), ['status','generate','status','generate']);
  assert.deepEqual(bridge.calls[1], bridge.calls[3]);
  await assert.rejects(dispatch(client, 'save', { jobId: 'same-durable-job', outputPath: '/tmp/fake.png' }), { code: 'BRIDGE_TRANSPORT' });
  assert.equal(bridge.calls.filter(call => call.method === 'save').length, 1);
  await assert.rejects(client.call('models', {}), { code: 'MODEL_DENIED' });
  assert.equal(bridge.calls.filter(call => call.method === 'models').length, 1);
});

test('updated adapter blocks video against an old app while keeping image generation compatible',async t=>{
  const image='example-existing-image-model',video='omni-1.2-flash-8s-landscape';
  const bridge=await fakeBridge(t,body=>{
    if(body.method==='status')return {apiVersion:3,features:['video-visible-watermark-off']};
    if(body.method==='models')return {models:[{id:image,kind:'image'}]};
    return {method:body.method,params:body.params};
  });
  const client=new BridgeClient({bridgePath:bridge.bridgePath,launch:async()=>assert.fail('Existing test bridge must not launch app')});
  const base={prompt:'Exact request',confirmCreditSpend:true,requestId:'legacy-bridge-test'};
  await assert.rejects(dispatch(client,'generate',{...base,model:video}),{code:'FLOW_STUDIO_UPDATE_REQUIRED'});
  await assert.rejects(dispatch(client,'generate',{...base,model:video,videoWatermark:'without'}),{code:'FLOW_STUDIO_UPDATE_REQUIRED'});
  await assert.rejects(dispatch(client,'prepare',{model:video,prompt:base.prompt,accountId:7,checkBrowser:true,videoWatermark:'with'}),{code:'FLOW_STUDIO_UPDATE_REQUIRED'});
  assert.ok(bridge.calls.every(call=>['status','models'].includes(call.method)));
  for(const args of [{...base,model:image},{...base,model:image,method:'image'},{...base,settings:{kind:'image',method:'image',family:'Example image family',aspectRatio:'1:1'}}]){
    assert.deepEqual(await dispatch(client,'generate',args),{method:'generate',params:args});
  }
});

test('MCP prepare resolves UI settings without generation and pins a deduplicated authorized request',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'flow-mcp-prepare-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const start=path.join(root,'start.png'),end=path.join(root,'end.png');await fs.writeFile(start,'start');await fs.writeFile(end,'end');
  const runtime=new Runtime({});runtime.ready=true;
  runtime.models=[{id:'veo-3.1-fast-i2v-8s-landscape'},{id:'veo-3.1-fast-8s-landscape'},{id:'veo-3.1-fast'},{id:'omni-1.1-flash-8s-landscape'}];runtime.attachBrowserEngine({supports:input=>/^veo-3\.1-fast/.test(input.model),generate:async()=>assert.fail('runJob fixture owns submission')});
  let generations=0,persists=0;runtime.start=async()=>runtime.snapshot();runtime.persist=async()=>{persists++;};runtime.runJob=async()=>{generations++;};
  const actions=createAgentActions({runtime});
  const bridge=await fakeBridge(t,async(body,_req,res)=>{try{return await actions(body.method,body.params);}catch(error){res.statusCode=400;res.end(JSON.stringify({error:{code:error.code||'request_failed',message:error.message}}));}});
  const client=new BridgeClient({bridgePath:bridge.bridgePath,launch:async()=>{throw Error('Unexpected launch');}});
  const status=await dispatch(client,'status',{});assert.equal(status.apiVersion,3);assert(status.features.includes('prepare-generation'));assert(status.features.includes('isolated-browser-generation'));assert.equal(status.videoWatermarkPolicy,'selectable');assert(status.features.includes('video-watermark-selection'));
  const settings={kind:'video',method:'frames',family:'Veo 3.1 Fast',durationSeconds:8,aspectRatio:'16:9'};
  const plan=await dispatch(client,'prepare',{settings,prompt:'Local test only',startFramePath:start,endFramePath:end,accountId:7});
  assert.equal(plan.valid,true);assert.equal(plan.model.id,'veo-3.1-fast-i2v-8s-landscape');assert.equal(plan.method,'frames');
  assert.equal(plan.inputs.startFrame,true);assert.equal(plan.inputs.endFrame,true);assert.equal(plan.checks.accountAccess,'not_checked');assert.equal(plan.checks.visibleWatermark,'not_checked');
  assert.equal(plan.generateArguments.settings,undefined);assert.equal(plan.generateArguments.model,plan.model.id);assert.equal(plan.generateArguments.method,'frames');
  assert.equal(plan.generateArguments.videoWatermark,'with');
  assert.equal(plan.generateArguments.accountId,7);assert.equal(plan.model.generationEngine,'isolated-browser');
  assert.equal(JSON.stringify(plan).includes('base64'),false);assert.equal(plan.generateArguments.confirmCreditSpend,undefined);assert.equal(plan.generateArguments.requestId,undefined);
  assert.equal(generations,0);assert.equal(persists,0);assert.equal(runtime.jobs.length,0);
  const args={...plan.generateArguments,confirmCreditSpend:true,requestId:'prepared-stable'};
  const first=await dispatch(client,'generate',args),again=await dispatch(client,'generate',args);
  assert.equal(first.jobId,again.jobId);assert.equal(generations,1);assert.equal(runtime.jobs.length,1);
  await assert.rejects(dispatch(client,'generate',{...args,prompt:'Changed prompt'}),/requestId/);
  await assert.rejects(dispatch(client,'generate',{...args,accountId:8}),/requestId/);
  await assert.rejects(dispatch(client,'generate',{...args,videoWatermark:'without'}),/requestId/);
  assert.equal(generations,1);
  const textPlan=await dispatch(client,'prepare',{settings:{...settings,method:'text'},prompt:'Text only'});
  assert.equal(textPlan.model.id,'veo-3.1-fast-8s-landscape','Only known alias resolves to the canonical variant');
  await assert.rejects(dispatch(client,'prepare',{settings:{...settings,durationSeconds:10},prompt:'No available option',startFramePath:start}));
  assert.equal(generations,1);assert.equal(runtime.jobs.length,1);
});

test('MCP prepare forwards verified watermark modes and exact mandatory errors without generating',async t=>{
  const model='omni-1.2-flash-3s-landscape',runtime={ready:true,models:[{id:model}],jobs:[],start:async()=>{},generate:()=>assert.fail('MCP preparation must not generate'),persist:()=>assert.fail('MCP preparation must not persist')};
  let state;const modes=[];
  const actions=createAgentActions({runtime,checkIsolatedInputs:async({videoWatermark})=>{
    modes.push(videoWatermark);
    if(state==='required'&&videoWatermark==='without')throw Object.assign(new Error('Visible watermarking is required in your region.'),{code:'VISIBLE_WATERMARK_REQUIRED'});
    return {ready:true,accountId:7,model,uploadedImages:0,submitted:false,cleared:true,visibleWatermark:state};
  }});
  const bridge=await fakeBridge(t,async(body,_req,res)=>{try{return await actions(body.method,body.params);}catch(error){res.statusCode=400;res.end(JSON.stringify({error:{code:error.code||'request_failed',message:error.message}}));}}),client=new BridgeClient({bridgePath:bridge.bridgePath,launch:async()=>assert.fail('Existing test bridge must not launch app')}),args={model,method:'text',prompt:'Unchanged prompt',accountId:7,checkBrowser:true};
  const without={...args,videoWatermark:'without'};
  const local=await dispatch(client,'prepare',{...without,checkBrowser:false});assert.equal(local.checks.visibleWatermark,'not_checked');assert.equal(local.generateArguments.videoWatermark,'without');assert.deepEqual(modes,[]);
  await assert.rejects(dispatch(client,'prepare',args),{code:'VISIBLE_WATERMARK_UNVERIFIED'});
  state='required';await assert.rejects(dispatch(client,'prepare',without),error=>error.code==='VISIBLE_WATERMARK_REQUIRED'&&error.message==='Visible watermarking is required in your region.');
  for(const [request,evidence,mode] of [[args,'on','with'],[without,'off','without']]){
    state=evidence;
    const checked=await dispatch(client,'prepare',request);
    assert.equal(checked.checks.visibleWatermark,evidence);assert.equal(checked.browserCheck.visibleWatermark,evidence);assert.equal(checked.browserCheck.submitted,false);
    assert.equal(checked.generateArguments.videoWatermark,mode);assert.equal(Object.hasOwn(checked.generateArguments,'visibleWatermark'),false);assert.equal(Object.hasOwn(checked.generateArguments,'checkBrowser'),false);
  }
  assert.deepEqual(modes,['with','without','with','without']);assert.deepEqual(runtime.jobs,[]);
  const before=bridge.calls.length;await assert.rejects(dispatch(client,'prepare',{...args,visibleWatermark:'off'}),{code:'INVALID_ARGUMENTS'});assert.equal(bridge.calls.length,before,'Policy evidence is output, never a client bypass parameter');
});
