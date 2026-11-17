'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {pathToFileURL}=require('node:url');

async function loadMain(t,{writeFile=fs.writeFile,openPath=async()=>'',importMedia=async()=>[]}={}){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'flow-main-native-'));
 t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const handlers=new Map(),events=[],openPaths=[],inspectInputs=[],prepareInputs=[],releases=[],submitCalls=[],submissions=[],writes=[],fileOperations=[],delegated=[],agentResult={delegated:true};
 let runtime,window,ready,agentDispatch,now=1_000_000;
 class Runtime{
  constructor(){runtime=this;this.accounts=[{id:1,email:'test@example.com',isActive:true}];this.jobs=[];}
  async initializeHistory(){}
  async refreshAccounts(){events.push('accounts');return this.accounts;}
  async start(){return {};}
  attachBrowserEngine(engine){this.browserEngine=engine;}
  publicJobs(){return this.jobs;}
 }
 class BrowserWindow{
  constructor(){window=this;this.webContents={on(){},send(){},setWindowOpenHandler(){},session:{setPermissionRequestHandler(){}}};}
  loadFile(){}
  on(){}
  isDestroyed(){return false;}
 }
 const browser={
  async inspect(...args){events.push('inspect');inspectInputs.push(args);return {accountMatch:true};},
  async prepare(input){events.push('prepare');prepareInputs.push(input);return {...input,lease:{id:'lease-'+releases.length},projectURL:'https://flow.google.com/project/test',settings:{},readyToSubmit:true};},
  async release(lease,options){events.push('release');releases.push({lease,options,pending:runtime.nativeBrowserPending});},
  async submit(plan,{beforeSubmit}){events.push('submit');submitCalls.push(plan);await beforeSubmit();submissions.push(plan);return {submitted:true};}
 };
 const electron={
  app:{setName(){},requestSingleInstanceLock:()=>true,on(){},getPath:()=>dataDir,getVersion:()=> '1.0.0',whenReady:()=>({then(fn){ready=Promise.resolve().then(fn);return ready;}})},
  BrowserWindow,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{},shell:{async openPath(file){events.push('handoff');openPaths.push(file);return openPath(file);}},net:{},clipboard:{},
  Menu:{buildFromTemplate:()=>[],setApplicationMenu(){}},protocol:{registerSchemesAsPrivileged(){},handle(){}}
 };
 const modules={
  electron,'./machine.json':{},'./runtime.cjs':{Runtime},'./input-files.cjs':{importMedia},'./exports.cjs':{},
  './bootstrap.cjs':{prepareEngine:async()=>({})},'./accounts.cjs':{createAccountManager:()=>({hasAccountProfile:async()=>true})},
  './recovery.cjs':{createRecoveryManager:()=>({})},
  './agent-bridge.cjs':{startAgentBridge:async({dispatch})=>{agentDispatch=dispatch;return {};},createAgentActions:()=>async(...args)=>{delegated.push(args);return agentResult;}},
  './browser-native.cjs':{NativeBrowser:class{},createBrowserTransport:()=>browser},
  './browser-engine.cjs':{createBrowserEngine:()=>({supports:()=>true,generate:async()=>{throw new Error('No generation in lifecycle fixture');},inspect:async()=>({ready:true,accountEmail:'test@example.com'})})},
  'node:fs/promises':new Proxy(fs,{get(target,key){if(key==='writeFile')return async(file,body,options)=>{fileOperations.push(key);events.push('write');writes.push({file,body,options});await writeFile(file,body,options);};if(['mkdir','mkdtemp','open','readFile','copyFile','unlink','rm','stat','lstat','access','chmod','rename'].includes(key))return async(...args)=>{fileOperations.push(key);return target[key](...args);};return target[key];}})
 };
 const source=await fs.readFile(path.join(__dirname,'main.cjs'),'utf8');
 vm.runInNewContext(source,{require:name=>Object.hasOwn(modules,name)?modules[name]:require(name),__dirname,process:{arch:process.arch,platform:process.platform,env:process.env,on(){}},console,Buffer,Date:class extends Date{static now(){return now;}}},{filename:'main.cjs'});
 await ready;
 fileOperations.length=0;
 return {dataDir,runtime,browser,events,openPaths,inspectInputs,prepareInputs,releases,submitCalls,submissions,writes,fileOperations,delegated,agentResult,dispatch:(...args)=>agentDispatch(...args),advance:ms=>{now+=ms;},invoke(name,input){return handlers.get('studio:'+name)({sender:window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}},input);}};
}

test('agent native_inspect and UI inspect share account checks, handoff and read-only result',async t=>{
 const h=await loadMain(t),ui=await h.invoke('inspectBrowser',1);
 h.events.length=0;
 const agent=await h.dispatch('native_inspect',{accountId:1});
 assert.deepEqual(agent,ui);
 assert.deepEqual(h.events,['accounts','handoff','inspect']);
 assert.equal(h.inspectInputs.length,2);
 for(const [id,options] of h.inspectInputs){assert.equal(id,1);assert.equal(options.expectedEmail,'test@example.com');}
 assert.equal(h.prepareInputs.length,0);assert.equal(h.submitCalls.length,0);assert.equal(h.writes.length,0);assert.equal(h.delegated.length,0);
 assert.equal(h.runtime.accountActionPending,false);
});

test('agent native_inspect accepts only accountId and rejects invalid, unknown, inactive or busy accounts before Chrome',async t=>{
 const h=await loadMain(t);
 for(const params of [undefined,null,[],{},1,{accountId:1,extra:true},{accountId:'1'},{accountId:0},{accountId:-1},{accountId:1.5}]){
  await assert.rejects(async()=>h.dispatch('native_inspect',params));
 }
 await assert.rejects(h.dispatch('native_inspect',{accountId:2}),/отключён или удалён/);
 h.runtime.accounts[0].isActive=false;
 await assert.rejects(h.dispatch('native_inspect',{accountId:1}),/отключён или удалён/);
 h.runtime.accounts[0].isActive=true;h.runtime.jobs=[{status:'running'}];
 await assert.rejects(h.dispatch('native_inspect',{accountId:1}),/после завершения генерации/);
 assert.equal(h.openPaths.length,0);assert.equal(h.inspectInputs.length,0);assert.equal(h.prepareInputs.length,0);assert.equal(h.submitCalls.length,0);assert.equal(h.writes.length,0);assert.equal(h.delegated.length,0);
});

test('agent native_inspect holds existing account action lock across Chrome handoff and UI actions',async t=>{
 let allowHandoff,started;
 const blocked=new Promise(resolve=>{allowHandoff=resolve;}),handingOff=new Promise(resolve=>{started=resolve;});
 const h=await loadMain(t,{async openPath(){started();await blocked;return '';}});
 const inspecting=h.dispatch('native_inspect',{accountId:1});
 await Promise.race([handingOff,inspecting]);
 assert.equal(h.runtime.accountActionPending,true);
 await assert.rejects(async()=>h.dispatch('native_inspect',{accountId:1}),/Дождитесь завершения действия с аккаунтами/);
 await assert.rejects(async()=>h.invoke('inspectBrowser',1),/Дождитесь завершения действия с аккаунтами/);
 await assert.rejects(async()=>h.invoke('setAccountActive',1),/Дождитесь завершения действия с аккаунтами/);
 assert.deepEqual(h.events,['accounts','handoff']);
 allowHandoff();await inspecting;
 assert.equal(h.runtime.accountActionPending,false);
 assert.deepEqual(h.events,['accounts','handoff','inspect']);
 await h.invoke('inspectBrowser',1);
 assert.equal(h.inspectInputs.length,2);
});

test('agent native_inspect retains closing and retry guards; other bridge actions delegate unchanged',async t=>{
 const h=await loadMain(t);
 for(const field of ['closing','retryTask']){
  h.runtime[field]=true;
  await assert.rejects(async()=>h.dispatch('native_inspect',{accountId:1}),field==='closing'?/закрывается/:/Дождитесь завершения действия с аккаунтами/);
  h.runtime[field]=false;
 }
 const params={unchanged:true};
 for(const method of ['status','accounts','prepare','generate','unknown']){
  assert.strictEqual(await h.dispatch(method,params),h.agentResult);
  const args=h.delegated.at(-1);assert.equal(args[0],method);assert.strictEqual(args[1],params);
 }
 assert.equal(h.openPaths.length,0);assert.equal(h.inspectInputs.length,0);assert.equal(h.prepareInputs.length,0);assert.equal(h.submitCalls.length,0);assert.equal(h.writes.length,0);
});

const nativeInput={accountId:1,model:'omni-1.2-flash-10s-portrait',prompt:'Exact native request'};
const bridgeInput={...nativeInput,referencePaths:['/tmp/unread-native-reference.png']};
const routeBlocked=error=>error.code==='VISIBLE_WATERMARK_ROUTE_UNVERIFIED'&&/не проверяет отключение видимого водяного знака/.test(error.message)&&/не запускалась/.test(error.message);
async function assertNoNativePreparation(h){
 assert.equal(h.openPaths.length,0);assert.equal(h.inspectInputs.length,0);assert.equal(h.prepareInputs.length,0);assert.equal(h.submitCalls.length,0);assert.equal(h.submissions.length,0);assert.equal(h.releases.length,0);assert.equal(h.writes.length,0);assert.deepEqual(h.fileOperations,[]);assert.deepEqual(h.runtime.jobs,[]);assert.equal(h.runtime.nativeBrowserPending===true,false);assert.equal(h.runtime.accountActionPending,false);assert.equal(h.delegated.length,0);assert.deepEqual(await fs.readdir(h.dataDir),[]);
}

test('native IPC preparation and submission reject unverified watermark routes before handoff file staging or jobs',async t=>{
 const h=await loadMain(t,{async importMedia(){assert.fail('Blocked native route must not import media');}});
 for(const [action,input] of [['prepareNativeBrowser',{...nativeInput,images:[{name:'never-read.png',dataUrl:'data:image/png;base64,unread'}]}],['submitNativeBrowser',{token:'not-issued'}]]){
  await assert.rejects(h.invoke(action,input),routeBlocked);assert.deepEqual(h.events,[]);await assertNoNativePreparation(h);
 }
});

test('MCP native preparation rejects before importing requested files or calling browser preparation',async t=>{
 let imports=0;const h=await loadMain(t,{async importMedia(){imports++;assert.fail('Blocked native route must not read requested media');}});
 for(const referencePaths of [[],bridgeInput.referencePaths]){
  await assert.rejects(h.dispatch('native_prepare',{...bridgeInput,referencePaths}),routeBlocked);assert.equal(imports,0);assert.deepEqual(h.events,[]);await assertNoNativePreparation(h);
 }
});

test('MCP native spend confirmation never bypasses the watermark route guard or creates a submission record',async t=>{
 const h=await loadMain(t);
 for(const params of [undefined,null,[],{},{token:'never-issued'},{token:'never-issued',confirmCreditSpend:false},{token:'never-issued',confirmCreditSpend:true,extra:true}])await assert.rejects(async()=>h.dispatch('native_submit',params));
 await assert.rejects(h.dispatch('native_submit',{token:'never-issued',confirmCreditSpend:true}),routeBlocked);assert.deepEqual(h.events,[]);await assertNoNativePreparation(h);
});

test('MCP native preparation retains strict argument validation without media import or native actions',async t=>{
 let imports=0;const h=await loadMain(t,{async importMedia(){imports++;assert.fail('Invalid native preparation must not import media');}});
 const invalid=[undefined,null,[],{}, {...bridgeInput,extra:true},{...bridgeInput,accountId:0},{...bridgeInput,accountId:'1'},
  {...bridgeInput,model:'omni-1.2-flash'},{...bridgeInput,model:'omni-1.1-flash-10s-portrait'},
  {...bridgeInput,prompt:''},{...bridgeInput,prompt:'   '},{...bridgeInput,prompt:'x'.repeat(20001)},
  {...bridgeInput,startFramePath:'/tmp/a.png'},{...bridgeInput,videoPaths:['/tmp/a.mp4']},
  {...bridgeInput,referencePaths:undefined},{...bridgeInput,referencePaths:['relative.png']},
  {...bridgeInput,referencePaths:['/tmp/video.mp4']},{...bridgeInput,referencePaths:Array(8).fill('/tmp/a.png')},
  {...bridgeInput,referencePaths:['/tmp/a\0.png']}];
 for(const params of invalid)await assert.rejects(async()=>h.dispatch('native_prepare',params));assert.equal(imports,0);await assertNoNativePreparation(h);
});

test('blocked native entry points preserve closing retry and account action locks without side effects',async t=>{
 const h=await loadMain(t);
 for(const field of ['closing','retryTask','accountActionPending']){
  h.runtime[field]=true;
  for(const action of [()=>h.invoke('prepareNativeBrowser',nativeInput),()=>h.invoke('submitNativeBrowser',{token:'not-issued'}),()=>h.dispatch('native_prepare',bridgeInput),()=>h.dispatch('native_submit',{token:'not-issued',confirmCreditSpend:true})])await assert.rejects(async()=>action(),error=>error.code!=='VISIBLE_WATERMARK_ROUTE_UNVERIFIED'&&/закрывается|Дождитесь завершения действия с аккаунтами/.test(error.message));
  h.runtime[field]=false;
 }
 await assertNoNativePreparation(h);
});

test('native cancel remains strict and idempotent after blocked preparation without releasing an unowned lease',async t=>{
 const h=await loadMain(t);await assert.rejects(h.invoke('prepareNativeBrowser',nativeInput),routeBlocked);
 for(const params of [undefined,null,[],{extra:true}])await assert.rejects(async()=>h.dispatch('native_cancel',params));
 assert.equal((await h.dispatch('native_cancel',{})).cancelled,true);assert.equal((await h.invoke('cancelNativeBrowser')).cancelled,true);await assertNoNativePreparation(h);
});

test('native inspection still stops at a failed parent Chrome handoff without fallback or preparation',async t=>{
 const h=await loadMain(t,{openPath:async()=> 'Launch denied'});
 await assert.rejects(h.invoke('inspectBrowser',1),/Не удалось открыть Google Chrome/);assert.deepEqual(h.events,['accounts','handoff']);assert.equal(h.inspectInputs.length,0);assert.equal(h.prepareInputs.length,0);assert.equal(h.submitCalls.length,0);assert.equal(h.writes.length,0);assert.deepEqual(h.fileOperations,[]);assert.deepEqual(h.runtime.jobs,[]);assert.equal(h.runtime.accountActionPending,false);
});
