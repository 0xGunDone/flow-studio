'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');

async function loadMain(t,{writeFile=fs.writeFile,openPath=async()=>'',importMedia=async()=>[]}={}){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'flow-main-native-'));
 t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const handlers=new Map(),events=[],openPaths=[],inspectInputs=[],prepareInputs=[],releases=[],submitCalls=[],submissions=[],writes=[],delegated=[],agentResult={delegated:true};
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
  'node:fs/promises':{...fs,async writeFile(file,body,options){events.push('write');writes.push({file,body,options});await writeFile(file,body,options);}}
 };
 const source=await fs.readFile(path.join(__dirname,'main.cjs'),'utf8');
 vm.runInNewContext(source,{require:name=>Object.hasOwn(modules,name)?modules[name]:require(name),__dirname,process:{arch:process.arch,platform:process.platform,env:process.env,on(){}},console,Buffer,Date:class extends Date{static now(){return now;}}},{filename:'main.cjs'});
 await ready;
 return {dataDir,runtime,browser,events,openPaths,inspectInputs,prepareInputs,releases,submitCalls,submissions,writes,delegated,agentResult,dispatch:(...args)=>agentDispatch(...args),advance:ms=>{now+=ms;},invoke(name,input){return handlers.get('studio:'+name)({sender:window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}},input);}};
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

test('expired matching token clears pending state and releases lease; invalid input preserves it',async t=>{
 const h=await loadMain(t),prepared=await h.invoke('prepareNativeBrowser',{accountId:1,model:'test-model',prompt:'test prompt'});
 h.advance(10*60*1000+1);
 for(const input of [null,[],{},{token:1},{token:'wrong'},{token:prepared.token,extra:true}]){
  await assert.rejects(h.invoke('submitNativeBrowser',input),/Подготовленный запрос устарел/);
  assert.equal(h.runtime.nativeBrowserPending,true);
  assert.equal(h.releases.length,0);
 }
 await assert.rejects(h.invoke('submitNativeBrowser',{token:prepared.token}),/Подготовленный запрос устарел/);
 assert.equal(h.runtime.nativeBrowserPending,false);
 assert.equal(h.releases.length,1);
 assert.equal(h.releases[0].lease.id,'lease-0');
 assert.equal(h.releases[0].pending,false);
 assert.equal(h.releases[0].options.close,false);
 assert.equal(h.submissions.length,0);
 assert.equal(h.writes.length,0);
 await h.invoke('cancelNativeBrowser');
 assert.equal(h.releases.length,1);
 await h.invoke('prepareNativeBrowser',{accountId:1,model:'test-model',prompt:'next prompt'});
 assert.equal(h.runtime.nativeBrowserPending,true);
});

test('submission awaits durable private record before browser click',async t=>{
 let unblock,started;
 const blocked=new Promise(resolve=>{unblock=resolve;}),writing=new Promise(resolve=>{started=resolve;});
 const h=await loadMain(t,{async writeFile(file,body,options){started();await blocked;await fs.writeFile(file,body,options);}});
 const prepared=await h.invoke('prepareNativeBrowser',{accountId:1,model:'test-model',prompt:'test prompt'});
 h.advance(10*60*1000);
 const submitting=h.invoke('submitNativeBrowser',{token:prepared.token});
 await writing;
 assert.equal(h.submissions.length,0);
 assert.equal(h.releases.length,0);
 unblock();
 assert.equal((await submitting).submitted,true);
 assert.equal(h.writes[0].options.flush,true);
 assert.equal(h.writes[0].options.flag,'wx');
 assert.equal(h.writes[0].options.mode,0o600);
 const file=path.join(h.dataDir,'native-submissions',prepared.token+'.json');
 const record=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(record.outcome,'unknown');
 assert.equal(record.accountId,1);
 assert.equal(record.prompt,'test prompt');
 assert.equal((await fs.stat(file)).mode&0o777,0o600);
 assert.equal(h.submissions.length,1);
 assert.equal(h.releases.length,1);
});

test('record write failure prevents browser click and releases lease',async t=>{
 const h=await loadMain(t,{async writeFile(){throw new Error('disk failure');}});
 const prepared=await h.invoke('prepareNativeBrowser',{accountId:1,model:'test-model',prompt:'test prompt'});
 await assert.rejects(h.invoke('submitNativeBrowser',{token:prepared.token}),/disk failure/);
 assert.equal(h.runtime.nativeBrowserPending,false);
 assert.equal(h.submissions.length,0);
 assert.equal(h.releases.length,1);
});

test('active account cooldown permits preparation but blocks native submit before browser or record write',async t=>{
 const h=await loadMain(t);
 h.runtime.accounts[0].cooldownUntil=new Date(1_000_001).toISOString();
 const prepared=await h.invoke('prepareNativeBrowser',{accountId:1,model:'test-model',prompt:'test prompt'});
 assert.equal(h.runtime.nativeBrowserPending,true);
 h.events.length=0;
 await assert.rejects(h.invoke('submitNativeBrowser',{token:prepared.token}),/Аккаунт на паузе после ошибки/);
 assert.deepEqual(h.events,['accounts','release']);
 assert.equal(h.submitCalls.length,0);
 assert.equal(h.submissions.length,0);
 assert.equal(h.writes.length,0);
 assert.equal(h.runtime.nativeBrowserPending,false);
 assert.equal(h.releases.length,1);
 assert.equal(h.releases[0].pending,false);
 assert.equal(h.releases[0].options.close,false);
});

test('expired, boundary, malformed and absent account cooldown keep native submission available',async t=>{
 const h=await loadMain(t);
 for(const cooldownUntil of [new Date(999_999).toISOString(),new Date(1_000_000).toISOString(),'invalid',undefined]){
  h.runtime.accounts[0].cooldownUntil=cooldownUntil;
  const prepared=await h.invoke('prepareNativeBrowser',{accountId:1,model:'test-model',prompt:'test prompt'});
  assert.equal((await h.invoke('submitNativeBrowser',{token:prepared.token})).submitted,true);
  assert.equal(h.runtime.nativeBrowserPending,false);
 }
 assert.equal(h.submitCalls.length,4);
 assert.equal(h.submissions.length,4);
 assert.equal(h.writes.length,4);
 assert.equal(h.releases.length,4);
});

test('native UI actions await parent Chrome handoff after account checks and before browser actions',async t=>{
 let allowHandoff,started;
 const blocked=new Promise(resolve=>{allowHandoff=resolve;}),handingOff=new Promise(resolve=>{started=resolve;});
 const h=await loadMain(t,{async openPath(){started();await blocked;return '';}});
 const inspecting=h.invoke('inspectBrowser',1);
 await Promise.race([handingOff,inspecting]);
 assert.deepEqual(h.events,['accounts','handoff']);
 allowHandoff();await inspecting;
 assert.deepEqual(h.events,['accounts','handoff','inspect']);
 h.events.length=0;
 const prepared=await h.invoke('prepareNativeBrowser',{accountId:1,model:'test-model',prompt:'test prompt'});
 assert.deepEqual(h.events,['accounts','handoff','prepare']);
 h.events.length=0;
 await h.invoke('submitNativeBrowser',{token:prepared.token});
 assert.deepEqual(h.events,['accounts','handoff','submit','write','release']);
 assert.deepEqual(h.openPaths,Array(3).fill('/Applications/Google Chrome.app'));
});

test('failed parent handoff stops inspect, prepare and submit without fallback or record write',async t=>{
 let error='Launch denied';
 const h=await loadMain(t,{openPath:async()=>error});
 for(const [action,input] of [['inspectBrowser',1],['prepareNativeBrowser',{accountId:1,model:'test-model',prompt:'test prompt'}]]){
  h.events.length=0;
  await assert.rejects(h.invoke(action,input),/Не удалось открыть Google Chrome/);
  assert.deepEqual(h.events,['accounts','handoff']);
 }
 error='';
 const prepared=await h.invoke('prepareNativeBrowser',{accountId:1,model:'test-model',prompt:'test prompt'});
 error='Launch denied';h.events.length=0;
 await assert.rejects(h.invoke('submitNativeBrowser',{token:prepared.token}),/Не удалось открыть Google Chrome/);
 assert.deepEqual(h.events,['accounts','handoff','release']);
 assert.equal(h.submitCalls.length,0);
 assert.equal(h.writes.length,0);
 assert.equal(h.runtime.nativeBrowserPending,false);
 assert.equal(h.releases.length,1);
});

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=','base64');
const image={name:'mascot original.png',dataUrl:'data:image/png;base64,'+png.toString('base64')};
const referenceInput={accountId:1,model:'omni-1.2-flash-10s-portrait',prompt:'exact original prompt',images:[image]};
const bridgeReferenceInput={accountId:1,model:referenceInput.model,prompt:referenceInput.prompt,referencePaths:['/tmp/original reference.png']};

test('agent native_prepare imports only requested images then shares private reference staging with UI',async t=>{
 const imports=[],h=await loadMain(t,{async importMedia(...args){imports.push(args);return [{...image,kind:'image',path:'/private/source'}];}});
 const prepared=await h.dispatch('native_prepare',bridgeReferenceInput),input=h.prepareInputs[0];
 assert.equal(imports.length,1);assert.strictEqual(imports[0][0],bridgeReferenceInput.referencePaths);assert.equal(imports[0][1].allowVideos,false);
 assert.equal(input.model,bridgeReferenceInput.model);assert.equal(input.prompt,bridgeReferenceInput.prompt);
 assert.equal(input.accountId,1);assert.equal(input.expectedEmail,'test@example.com');assert.equal(input.images.length,1);
 assert.deepEqual(await fs.readFile(input.images[0].path),png);
 assert.equal(prepared.references[0].name,image.name);assert.equal(prepared.references[0].sha256,crypto.createHash('sha256').update(png).digest('hex'));
 assert.equal(prepared.readyToSubmit,true);assert.equal(h.runtime.nativeBrowserPending,true);
 assert.equal(JSON.stringify(prepared).includes('data:image/'),false);assert.equal(JSON.stringify(prepared).includes(h.dataDir),false);assert.equal(JSON.stringify(prepared).includes('/private/source'),false);
 assert.equal(h.submitCalls.length,0);assert.equal(h.submissions.length,0);assert.equal(h.delegated.length,0);
 await h.invoke('cancelNativeBrowser');
 assert.equal(h.releases.length,1);assert.equal(h.runtime.nativeBrowserPending,false);
 await assert.rejects(fs.stat(path.dirname(input.images[0].path)),{code:'ENOENT'});
});

test('agent native_prepare rejects extra fields, frames, video, aliases and invalid inputs before import or browser',async t=>{
 let imports=0;const h=await loadMain(t,{async importMedia(){imports++;return [];}});
 const invalid=[undefined,null,[],{}, {...bridgeReferenceInput,extra:true},{...bridgeReferenceInput,accountId:0},{...bridgeReferenceInput,accountId:'1'},
  {...bridgeReferenceInput,model:'omni-1.2-flash'},{...bridgeReferenceInput,model:'omni-1.1-flash-10s-portrait'},
  {...bridgeReferenceInput,prompt:''},{...bridgeReferenceInput,prompt:'   '},{...bridgeReferenceInput,prompt:'x'.repeat(20001)},
  {...bridgeReferenceInput,startFramePath:'/tmp/a.png'},{...bridgeReferenceInput,videoPaths:['/tmp/a.mp4']},
  {...bridgeReferenceInput,referencePaths:undefined},{...bridgeReferenceInput,referencePaths:['relative.png']},
  {...bridgeReferenceInput,referencePaths:['/tmp/video.mp4']},{...bridgeReferenceInput,referencePaths:Array(8).fill('/tmp/a.png')},
  {...bridgeReferenceInput,referencePaths:['/tmp/a\0.png']}];
 for(const params of invalid)await assert.rejects(async()=>h.dispatch('native_prepare',params));
 assert.equal(imports,0);assert.equal(h.openPaths.length,0);assert.equal(h.prepareInputs.length,0);assert.equal(h.submitCalls.length,0);assert.equal(h.writes.length,0);assert.equal(h.delegated.length,0);
});

test('agent native_prepare owns account action lock during file import and rejects nonimage import results',async t=>{
 let unblock,started;const blocked=new Promise(resolve=>{unblock=resolve;}),importing=new Promise(resolve=>{started=resolve;});
 const h=await loadMain(t,{async importMedia(){started();await blocked;return [{...image,kind:'image'}];}});
 const preparing=h.dispatch('native_prepare',bridgeReferenceInput);
 await Promise.race([preparing,importing]);
 assert.equal(h.runtime.accountActionPending,true);
 await assert.rejects(async()=>h.invoke('prepareNativeBrowser',referenceInput),/Дождитесь завершения действия с аккаунтами/);
 await assert.rejects(async()=>h.dispatch('native_cancel',{}),/Дождитесь завершения действия с аккаунтами/);
 assert.equal(h.openPaths.length,0);
 unblock();await preparing;
 assert.equal(h.runtime.accountActionPending,false);
 await h.dispatch('native_cancel',{});
 const invalid=await loadMain(t,{async importMedia(){return [{kind:'video',name:'video.mp4',path:'/tmp/video.mp4'}];}});
 await assert.rejects(invalid.dispatch('native_prepare',bridgeReferenceInput),/изображения/);
 assert.equal(invalid.prepareInputs.length,0);assert.equal(invalid.writes.length,0);assert.equal(invalid.submitCalls.length,0);
});

test('agent native_submit requires exact spend confirmation and consumes same UI token once after durable write',async t=>{
 let unblock,started;const blocked=new Promise(resolve=>{unblock=resolve;}),writing=new Promise(resolve=>{started=resolve;});
 const h=await loadMain(t,{async writeFile(file,body,options){started();await blocked;await fs.writeFile(file,body,options);}});
 const prepared=await h.invoke('prepareNativeBrowser',{accountId:1,model:referenceInput.model,prompt:referenceInput.prompt});
 for(const params of [undefined,null,[],{},{token:prepared.token},{token:prepared.token,confirmCreditSpend:false},{token:prepared.token,confirmCreditSpend:'true'},{token:prepared.token,confirmCreditSpend:true,extra:true},{token:'',confirmCreditSpend:true},{token:'wrong',confirmCreditSpend:true}]){
  await assert.rejects(async()=>h.dispatch('native_submit',params));
  assert.equal(h.runtime.nativeBrowserPending,true);
 }
 assert.equal(h.submitCalls.length,0);assert.equal(h.writes.length,0);
 const submitting=h.dispatch('native_submit',{token:prepared.token,confirmCreditSpend:true});
 await Promise.race([submitting,writing]);
 assert.equal(h.runtime.accountActionPending,true);assert.equal(h.submissions.length,0);assert.equal(h.writes.length,1);
 assert.equal(h.writes[0].options.flush,true);assert.equal(h.writes[0].options.flag,'wx');assert.equal(h.writes[0].options.mode,0o600);
 unblock();assert.equal((await submitting).submitted,true);
 assert.equal(h.submissions.length,1);assert.equal(h.releases.length,1);assert.equal(h.runtime.nativeBrowserPending,false);
 await assert.rejects(h.dispatch('native_submit',{token:prepared.token,confirmCreditSpend:true}),/устарел/);
 await assert.rejects(h.invoke('submitNativeBrowser',{token:prepared.token}),/устарел/);
 assert.equal(h.submissions.length,1);assert.equal(h.writes.length,1);
});

test('agent native_submit preserves cooldown and record failure guards while native_cancel invalidates UI token',async t=>{
 for(const scenario of ['cooldown','write-failure','cancel']){
  const h=await loadMain(t,scenario==='write-failure'?{async writeFile(){throw new Error('disk failure');}}:{});
  const prepared=await h.dispatch('native_prepare',{...bridgeReferenceInput,referencePaths:[]});
  if(scenario==='cancel'){
   for(const params of [undefined,null,[],{extra:true}])await assert.rejects(async()=>h.dispatch('native_cancel',params));
   assert.equal(h.runtime.nativeBrowserPending,true);
   assert.equal((await h.dispatch('native_cancel',{})).cancelled,true);
   await assert.rejects(h.invoke('submitNativeBrowser',{token:prepared.token}),/устарел/);
  }else{
   if(scenario==='cooldown')h.runtime.accounts[0].cooldownUntil=new Date(1_000_001).toISOString();
   await assert.rejects(h.dispatch('native_submit',{token:prepared.token,confirmCreditSpend:true}),scenario==='cooldown'?/Аккаунт на паузе/:/disk failure/);
  }
  assert.equal(h.submissions.length,0);assert.equal(h.releases.length,1);assert.equal(h.runtime.nativeBrowserPending,false);assert.equal(h.delegated.length,0);
 }
});

test('references stage exact private files and persist original names and hashes without paths or data URLs',async t=>{
 const h=await loadMain(t),prepared=await h.invoke('prepareNativeBrowser',referenceInput),input=h.prepareInputs[0],file=input.images[0];
 const hash=crypto.createHash('sha256').update(png).digest('hex');
 assert.equal(input.prompt,referenceInput.prompt);assert.equal(input.model,referenceInput.model);
 assert.match(file.name,new RegExp('^ref-'+hash.slice(0,16)+'-0-[a-f0-9]{8}\\.png$'));assert.equal(file.sha256,hash);
 assert.equal(path.basename(file.path),file.name);assert.equal(path.dirname(path.dirname(file.path)),h.dataDir);
 assert.deepEqual(await fs.readFile(file.path),png);
 assert.equal((await fs.stat(file.path)).mode&0o777,0o600);assert.equal((await fs.stat(path.dirname(file.path))).mode&0o777,0o700);
 assert.equal(prepared.references[0].name,image.name);assert.equal(prepared.references[0].sha256,hash);
 assert.equal(prepared.readyToSubmit,true);assert.match(prepared.message,/Вложений подтверждено: 1/);
 await h.invoke('submitNativeBrowser',{token:prepared.token});
 const recordFile=h.writes.find(item=>item.file.endsWith('.json')),record=JSON.parse(recordFile.body);
 assert.deepEqual(record.references,[{name:image.name,sha256:hash}]);
 assert.equal(recordFile.body.includes(file.path),false);assert.equal(recordFile.body.includes('data:image/'),false);
 await assert.rejects(fs.stat(path.dirname(file.path)),{code:'ENOENT'});
 await h.invoke('prepareNativeBrowser',referenceInput);
 assert.notEqual(h.prepareInputs[1].images[0].name,file.name);
 await h.invoke('cancelNativeBrowser');
});

test('malformed, noncanonical, wrong magic, oversized and too many references fail before browser or disk staging',async t=>{
 const h=await loadMain(t);
 const tooBig=Buffer.alloc(20*1024*1024+1);png.copy(tooBig);
 const invalid=[null,{},Array(8).fill(image),[{...image,path:'/tmp/other.png'}],[{...image,name:'../other.png'}],[{...image,dataUrl:image.dataUrl+'\n'}],[{...image,dataUrl:'data:image/png;base64,AB=='}],[{...image,dataUrl:'data:image/jpeg;base64,'+png.toString('base64')}],[{...image,dataUrl:'data:image/png;base64,'+tooBig.toString('base64')}]];
 for(const images of invalid)await assert.rejects(h.invoke('prepareNativeBrowser',{...referenceInput,images}));
 assert.equal(h.prepareInputs.length,0);assert.equal(h.openPaths.length,0);assert.equal(h.writes.length,0);
 assert.equal((await fs.readdir(h.dataDir)).length,0);
});

test('reference files clean up on cancel, expiry, replacement, prepare failure and submission failure',async t=>{
 for(const action of ['cancel','expiry','replacement','prepare-failure','submit-failure','release-failure','handoff-failure','write-failure','unverified']){
  const h=await loadMain(t);let input;
  if(action==='handoff-failure'||action==='write-failure'){
   const failed=await loadMain(t,action==='handoff-failure'?{openPath:async()=> 'Launch denied'}:{writeFile:async()=>{throw new Error('staging write failure');}});
   await assert.rejects(failed.invoke('prepareNativeBrowser',referenceInput));
   assert.equal((await fs.readdir(failed.dataDir)).length,0);assert.equal(failed.prepareInputs.length,0);continue;
  }
  if(action==='prepare-failure')h.browser.prepare=async value=>{input=value;throw new Error('prepare failure');};
  if(action==='unverified')h.browser.prepare=async value=>{input=value;return {...value,lease:{},images:[],readyToSubmit:true};};
  let prepared;
  if(['prepare-failure','unverified'].includes(action))await assert.rejects(h.invoke('prepareNativeBrowser',referenceInput));
  else{prepared=await h.invoke('prepareNativeBrowser',referenceInput);input=h.prepareInputs[0];}
  const folder=path.dirname(input.images[0].path);
  if(action==='cancel')await h.invoke('cancelNativeBrowser');
  if(action==='expiry'){h.advance(600_001);await assert.rejects(h.invoke('submitNativeBrowser',{token:prepared.token}),/устарел/);}
  if(action==='replacement')await h.invoke('prepareNativeBrowser',{accountId:1,model:'test-model',prompt:'next prompt'});
  if(action==='submit-failure'){h.browser.submit=async()=>{throw new Error('submit failure');};await assert.rejects(h.invoke('submitNativeBrowser',{token:prepared.token}),/submit failure/);}
  if(action==='release-failure'){h.browser.release=async()=>{throw new Error('release failure');};await assert.rejects(h.invoke('cancelNativeBrowser'),/release failure/);}
  await assert.rejects(fs.stat(folder),{code:'ENOENT'});
 }
});
