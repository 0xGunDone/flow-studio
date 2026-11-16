'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {BridgeClient,BridgeError}=require('./bridge-client.cjs');
const zod=require(require.resolve('zod',{paths:[process.env.FLOW_STUDIO_TEST_APP_DIR||__dirname]}));

function loadMcp(){
 const module={exports:{}};
 class McpServer{
  constructor(){this.tools=new Map();}
  registerTool(name,metadata,handler){this.tools.set(name,{metadata,handler});}
 }
 const modules={zod,'@modelcontextprotocol/sdk/server/mcp.js':{McpServer},'@modelcontextprotocol/sdk/server/stdio.js':{},'./bridge-client.cjs':{BridgeClient,BridgeError}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'mcp-server.cjs'),'utf8'),{module,require:name=>Object.hasOwn(modules,name)?modules[name]:require(name),process},{filename:'mcp-server.cjs'});
 return module.exports;
}

test('bridge client allows native inspection with one 120s RPC and no live connection or credential read',async()=>{
 const client=new BridgeClient(),calls=[];
 client.connect=async()=>({fixture:true});
 client.request=async(...args)=>{calls.push(args);return {result:{accountMatch:true}};};
 assert.deepEqual(await client.call('native_inspect',{accountId:1}),{accountMatch:true});
 assert.equal(calls.length,1);assert.equal(calls[0][1],'/rpc');assert.equal(calls[0][3],120000);
 assert.deepEqual(JSON.parse(calls[0][2]),{method:'native_inspect',params:{accountId:1}});
});

test('native browser methods never retry transport failure or timeout',async()=>{
 for(const [method,params] of [['native_inspect',{accountId:1}],['native_prepare',{accountId:1,model:'omni-1.2-flash-10s-portrait',prompt:'exact prompt',referencePaths:[]}],['native_submit',{token:'prepared-token',confirmCreditSpend:true}],['native_cancel',{}]])for(const code of ['BRIDGE_TRANSPORT','BRIDGE_TIMEOUT']){
  const client=new BridgeClient();let connections=0,requests=0;
  client.connect=async()=>{connections++;return {};};
  client.request=async()=>{requests++;throw new BridgeError(code,'fixture failure');};
  await assert.rejects(client.call(method,params),error=>error.code===code);
  assert.equal(connections,1);assert.equal(requests,1);
 }
});

test('native submit client rejects missing credit confirmation without any bridge access',async()=>{
 const client=new BridgeClient();let connections=0;
 client.connect=async()=>{connections++;return {};};
 for(const params of [undefined,null,{}, {token:'prepared-token'},{token:'prepared-token',confirmCreditSpend:false},{token:'',confirmCreditSpend:true}]){
  await assert.rejects(client.call('native_submit',params),error=>error.code==='INVALID_ARGUMENTS');
 }
 assert.equal(connections,0);
});

test('MCP native preparation schemas reject frames, video and extras; submission uses strict one-use token confirmation',async()=>{
 const {dispatch,definitions}=loadMcp(),calls=[],client={async call(...args){calls.push(args);return {prepared:true};}};
 const input={accountId:1,model:'omni-1.2-flash-10s-portrait',prompt:'exact original prompt',referencePaths:['/tmp/original reference.png']};
 const invalid=[{},null,[],{...input,extra:true},{...input,accountId:0},{...input,accountId:Number.MAX_SAFE_INTEGER+1},
  {...input,model:'omni-1.2-flash'},{...input,model:'veo-3.1-fast'},{...input,prompt:' '},{...input,prompt:'x'.repeat(20001)},
  {...input,referencePaths:['relative.png']},{...input,referencePaths:['/tmp/a.mp4']},{...input,referencePaths:Array(8).fill('/tmp/a.png')},
  {...input,videoPaths:['/tmp/a.mp4']},{...input,startFramePath:'/tmp/a.png'},{...input,endFramePath:'/tmp/a.png'}];
 for(const params of invalid)await assert.rejects(dispatch(client,'native_prepare',params),error=>error.code==='INVALID_ARGUMENTS');
 for(const params of [{},{token:'prepared-token'},{token:'prepared-token',confirmCreditSpend:false},{token:'prepared-token',confirmCreditSpend:true,requestId:'extra'}]){
  await assert.rejects(dispatch(client,'native_submit',params),error=>error.code==='INVALID_ARGUMENTS');
 }
 await assert.rejects(dispatch(client,'native_cancel',{extra:true}),error=>error.code==='INVALID_ARGUMENTS');
 assert.equal(calls.length,0);
 await dispatch(client,'native_prepare',input);assert.equal(calls[0][0],'native_prepare');assert.deepEqual(calls[0][1],input);
 await dispatch(client,'native_prepare',{...input,referencePaths:[]});
 await dispatch(client,'native_submit',{token:'prepared-token',confirmCreditSpend:true});
 await dispatch(client,'native_cancel',{});
 assert.equal(calls.length,4);
 for(const [name,method] of [['prepare_browser','native_prepare'],['submit_browser','native_submit'],['cancel_browser_preparation','native_cancel']]){
  const definition=definitions.find(item=>item.name==='flow_studio_'+name);assert.ok(definition);assert.equal(definition.method,method);assert.equal(definition.annotations.readOnlyHint,false);assert.match(definition.description,/never automatically retry/i);
 }
});

test('MCP native inspection accepts exactly one positive safe integer accountId',async()=>{
 const {dispatch,schemas}=loadMcp(),calls=[],signal=new AbortController().signal;
 const client={async call(...args){calls.push(args);return {accountMatch:true};}};
 for(const params of [undefined,null,[],{},1,{accountId:1,extra:true},{accountId:'1'},{accountId:0},{accountId:-1},{accountId:1.5},{accountId:Number.MAX_SAFE_INTEGER+1}]){
  await assert.rejects(dispatch(client,'native_inspect',params),error=>error.code==='INVALID_ARGUMENTS');
 }
 assert.equal(calls.length,0);
 assert.equal(schemas.native_inspect.safeParse({accountId:Number.MAX_SAFE_INTEGER}).success,true);
 assert.deepEqual(await dispatch(client,'native_inspect',{accountId:1},{signal}),{accountMatch:true});
 assert.equal(calls.length,1);assert.equal(calls[0][0],'native_inspect');assert.deepEqual(calls[0][1],{accountId:1});assert.strictEqual(calls[0][2].signal,signal);
});

test('MCP exposes read-only browser inspection and describes browser focus, account drawer and no generation',async()=>{
 const {definitions,createServer}=loadMcp(),definition=definitions.find(item=>item.name==='flow_studio_inspect_browser');
 assert.ok(definition);assert.equal(definition.method,'native_inspect');
 assert.equal(definition.annotations.readOnlyHint,true);assert.equal(definition.annotations.destructiveHint,false);assert.equal(definition.annotations.idempotentHint,false);
 assert.match(definition.description,/opens or focuses/i);assert.match(definition.description,/account drawer/i);assert.match(definition.description,/does not upload/i);assert.match(definition.description,/spend/i);
 const signal=new AbortController().signal,calls=[],server=createServer({async call(...args){calls.push(args);return {accountMatch:true};}});
 const tool=server.tools.get(definition.name);
 assert.ok(tool);assert.equal(tool.metadata.inputSchema.safeParse({accountId:1,extra:true}).success,false);
 const result=await tool.handler({accountId:1},{signal});
 assert.equal(result.structuredContent.accountMatch,true);assert.equal(calls.length,1);assert.equal(calls[0][0],'native_inspect');assert.strictEqual(calls[0][2].signal,signal);
});
