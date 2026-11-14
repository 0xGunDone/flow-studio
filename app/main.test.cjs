'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const {EventEmitter}=require('node:events');
async function launch({ready=true,closing=false,pickedFiles=[],accountRuntime={},managedOverrides={},nativeOverrides={},isolatedOverrides={},showMessageBox}={}){
 const events=[],sent=[],windows=[],app=new EventEmitter(),signalProcess=new EventEmitter(),handlers=new Map(),protocols=new Map(),fetches=[];let stopped=false,finishStop,stopError,choice=0,autoSyncs=0,bridgeDispatch,engineOptions,now=Date.now();
 Object.assign(signalProcess,{arch:process.arch,platform:process.platform,env:process.env});
 const runtime={jobs:[],accounts:[],ready,closing,initializeHistory:async()=>{},start:async()=>{},refreshAccounts:async()=>runtime.accounts,publicJobs:()=>runtime.jobs,attachBrowserEngine(engine){this.browserEngine=engine;},cancelGeneration:id=>{events.push(['cancel-generation',id]);return {cancelled:true,jobId:id};},close:()=>{events.push('stop');return stopError?Promise.reject(stopError):new Promise(resolve=>{finishStop=resolve;});}};
 app.setName=()=>{};app.requestSingleInstanceLock=()=>true;app.getPath=()=>'/unused';app.getVersion=()=>'1.1.0';app.getAppPath=()=>__dirname;
 app.whenReady=()=>Promise.resolve();
 app.quit=()=>{let prevented=false;app.emit('before-quit',{preventDefault(){prevented=true;}});if(!prevented)stopped=true;};
 class Window extends EventEmitter{
  constructor(){super();windows.push(this);this.webContents=new EventEmitter();Object.assign(this.webContents,{send:(...args)=>sent.push(args),setWindowOpenHandler(){},session:{setPermissionRequestHandler(){}}});}
  loadFile(){}show(){events.push('show');}focus(){}isDestroyed(){return this.destroyed===true;}
 }
 Object.assign(runtime,accountRuntime);
 const manager={hasAccountProfile:async()=>true,...managedOverrides,shutdown:()=>events.push('accounts'),startAutoSync(){autoSyncs++;}};
 const isolated={supports:()=>false,generate:async()=>assert.fail('Fixture must not generate media'),inspect:async(id,options)=>({ready:true,accountId:id,accountEmail:options.email,engine:'isolated-browser',usesDesktopFocus:false}),...isolatedOverrides};
 const electron={app,BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},protocol:{registerSchemesAsPrivileged(){},handle:(name,fn)=>protocols.set(name,fn)},Menu:{buildFromTemplate:x=>x,setApplicationMenu(){}},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:pickedFiles}),showMessageBoxSync:()=>choice,showMessageBox:async(parent,options)=>{if(options===undefined){options=parent;parent=undefined;}events.push({dialog:options,parent});return showMessageBox?showMessageBox(options):{response:choice};},showErrorBox:()=>events.push('error')},shell:{openExternal:async url=>events.push(['external',url]),openPath:async target=>{events.push(['open-path',target]);return ''; }},net:{fetch:(url,options)=>{fetches.push({url,options});return 'preview';}},clipboard:{}};
 const replacements={electron,'node:fs/promises':{mkdir:async()=>{}},'./runtime.cjs':{Runtime:class{constructor(){return runtime;}}},'./bootstrap.cjs':{prepareEngine:async()=>({})},'./exports.cjs':{},'./agent-bridge.cjs':{createAgentActions:require('./agent-bridge.cjs').createAgentActions,startAgentBridge:async({dispatch})=>{bridgeDispatch=dispatch;return {close:async()=>events.push('bridge')};}},'./browser-engine.cjs':{createBrowserEngine:options=>{engineOptions=options;assert.equal(options.accounts,manager);assert.equal(options.dataDir,'/unused');return isolated;}},'./browser-native.cjs':{NativeBrowser:class{},createBrowserTransport:()=>({status:async()=>({trusted:false,locked:false}),requestPermission:async()=>{events.push('native-permission');return {trusted:false};},inspect:async(id,options)=>{events.push(['native-inspect',id,options.expectedEmail]);return {trusted:true,accountMatch:true};},close:async()=>events.push('native-close'),...nativeOverrides})},'./accounts.cjs':{createAccountManager:()=>manager},'./recovery.cjs':{createRecoveryManager:()=>({shutdown(){}})}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'main.cjs'),'utf8'),{require:name=>replacements[name]??require(name),__dirname,URL,Response,process:signalProcess,AbortController,AbortSignal,setTimeout,clearTimeout,Date:class extends Date{static now(){return now;}}});
 await new Promise(setImmediate);
 return {app,signalProcess,runtime,events,sent,isolated,bridgeDispatch,engineOptions,advance:ms=>{now+=ms;},window:windows[0],handlers,protocols,fetches,get stopped(){return stopped;},get autoSyncs(){return autoSyncs;},finish:()=>finishStop(),setChoice:value=>{choice=value;},failStop:error=>{stopError=error;}};
}
test('automatic Google account sync starts only after successful startup',async()=>{
 const failed=await launch({ready:false});assert.equal(failed.autoSyncs,0);
 const ready=await launch();assert.equal(ready.autoSyncs,1);
 const closing=await launch({closing:true});assert.equal(closing.autoSyncs,0);
});
test('main attaches isolated engine once and trusted cancellation delegates shared runtime',async()=>{
 const calls=[],h=await launch({accountRuntime:{cancelGeneration:id=>{calls.push(id);return {cancelled:true,jobId:id};}}});
 assert.strictEqual(h.runtime.browserEngine,h.isolated);assert.equal(h.events.length,0,'Attaching engine never opens a browser or generates');
 const event={sender:h.window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}};
 assert.deepEqual(h.handlers.get('studio:cancelGeneration')(event,'pending'),{cancelled:true,jobId:'pending'});assert.deepEqual(calls,['pending']);
 for(const invalid of [{sender:{},senderFrame:event.senderFrame},{sender:event.sender,senderFrame:{url:'https://example.test'}}])assert.throws(()=>h.handlers.get('studio:cancelGeneration')(invalid,'pending'),/Недопустимый источник/);
 assert.deepEqual(calls,['pending']);
});
test('internal upload-rights response is strict exact pending token one-use and preserves native cancel',async()=>{
 let finishNative;const h=await launch({showMessageBox:()=>new Promise(resolve=>{finishNative=resolve;})}),text='Rights to use this video\nExact Google terms';
 assert.equal((await h.bridgeDispatch('upload_rights_status',{})).pending,null);
 for(const params of [null,[],{extra:true}])await assert.rejects(h.bridgeDispatch('upload_rights_status',params),{code:'INVALID_ARGUMENTS'});
 await assert.rejects(h.bridgeDispatch('upload_rights_respond',{token:require('node:crypto').randomUUID(),accept:true}),{code:'UPLOAD_RIGHTS_NOT_PENDING'});
 const pending=h.engineOptions.confirmUploadRights({accountEmail:'owner@example.test',text});
 const state=(await h.bridgeDispatch('upload_rights_status',{})).pending;assert.equal(state.text,text);assert.equal(state.accountEmail,'owner@example.test');assert.match(state.token,/^[a-f0-9-]{36}$/);assert(Number.isFinite(Date.parse(state.createdAt)));
 for(const params of [null,[],{}, {token:state.token,accept:'true'},{token:state.token,accept:true,extra:true}])await assert.rejects(h.bridgeDispatch('upload_rights_respond',params),{code:'INVALID_ARGUMENTS'});
 await assert.rejects(h.bridgeDispatch('upload_rights_respond',{token:require('node:crypto').randomUUID(),accept:true}),{code:'UPLOAD_RIGHTS_NOT_PENDING'});
 assert.equal((await h.bridgeDispatch('upload_rights_respond',{token:state.token,accept:false})).accepted,false);
 await assert.rejects(h.bridgeDispatch('upload_rights_respond',{token:state.token,accept:true}),{code:'UPLOAD_RIGHTS_NOT_PENDING'});assert.equal(await pending,false);
 assert.equal(h.events.find(event=>event.dialog).dialog.signal.aborted,true);assert.equal((await h.bridgeDispatch('upload_rights_status',{})).pending,null);
 const native=h.engineOptions.confirmUploadRights({accountEmail:'owner@example.test',text});finishNative({response:0});assert.equal(await native,false);
 const affirmative=h.engineOptions.confirmUploadRights({accountEmail:'owner@example.test',text});const next=(await h.bridgeDispatch('upload_rights_status',{})).pending;assert.notEqual(next.token,state.token);await h.bridgeDispatch('upload_rights_respond',{token:next.token,accept:true});assert.equal(await affirmative,true);
});
test('upload rights abort expiry and shutdown cannot consume a stale token or accept without human result',async()=>{
 let finishNative;const h=await launch({showMessageBox:()=>new Promise(resolve=>{finishNative=resolve;})}),text='Rights to use this video';
 const controller=new AbortController(),pending=h.engineOptions.confirmUploadRights({accountEmail:'owner@example.test',text,signal:controller.signal});
 controller.abort(new Error('User cancelled existing upload'));await assert.rejects(pending,/User cancelled/);assert.equal((await h.bridgeDispatch('upload_rights_status',{})).pending,null);
 const already=new AbortController();already.abort();await assert.rejects(h.engineOptions.confirmUploadRights({accountEmail:'owner@example.test',text,signal:already.signal}),{name:'AbortError'});
 const expired=h.engineOptions.confirmUploadRights({accountEmail:'owner@example.test',text}),state=(await h.bridgeDispatch('upload_rights_status',{})).pending;h.advance(10*60*1000);
 assert.equal((await h.bridgeDispatch('upload_rights_status',{})).pending,null);await assert.rejects(h.bridgeDispatch('upload_rights_respond',{token:state.token,accept:true}),{code:'UPLOAD_RIGHTS_NOT_PENDING'});finishNative({response:0});assert.equal(await expired,false);
 const closing=h.engineOptions.confirmUploadRights({accountEmail:'owner@example.test',text});h.app.quit();assert.equal(await closing,false);await new Promise(setImmediate);h.finish();await new Promise(setImmediate);assert.equal(h.stopped,true);
});
test('result recovery uses trusted IPC and shared guard without account action or a paid request',async()=>{
 const calls=[],h=await launch({accountRuntime:{recoverGeneration:id=>{assert.equal(h.runtime.accountActionPending,undefined);calls.push(id);return {jobId:id};}}});
 const event={sender:h.window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}},recover=h.handlers.get('studio:recoverGeneration');
 assert.deepEqual(recover(event,'unknown-original'),{jobId:'unknown-original'});assert.deepEqual(calls,['unknown-original']);
 assert.throws(()=>recover({sender:{},senderFrame:event.senderFrame},'unknown-original'),/Недопустимый источник/);
 h.runtime.closing=true;assert.throws(()=>recover(event,'unknown-original'),/Дождитесь/);assert.equal(calls.length,1);
});
test('isolated inspection pins active account and shares account lock across IPC and bridge without desktop focus',async()=>{
 const calls=[],rows=[{id:7,email:'owner@example.test',isActive:true},{id:9,email:'disabled@example.test',isActive:false}];let finish;
 const h=await launch({accountRuntime:{accounts:rows},managedOverrides:{hasAccountProfile:async id=>id===7},isolatedOverrides:{inspect:async(id,options)=>{calls.push([id,options.email]);await new Promise(resolve=>{finish=resolve;});return {ready:true,accountId:id,accountEmail:options.email,engine:'isolated-browser',usesDesktopFocus:false};}}});
 const event={sender:h.window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}},inspect=h.handlers.get('studio:inspectIsolatedBrowser');
 assert.throws(()=>inspect({sender:{},senderFrame:event.senderFrame},7),/Недопустимый источник/);
 const pending=inspect(event,7);await new Promise(setImmediate);assert.equal(h.runtime.accountActionPending,true);
 assert.throws(()=>h.handlers.get('studio:generate')(event,{}),/Дождитесь/);
 assert.throws(()=>h.handlers.get('studio:setAccountActive')(event,7,false),/Дождитесь/);
 await assert.rejects(h.bridgeDispatch('isolated_inspect',{accountId:7}),/Дождитесь/);
 assert.equal(h.runtime.accounts[0].browserReady,true);assert.equal(h.runtime.accounts[1].browserReady,false);
 finish();assert.equal((await pending).usesDesktopFocus,false);assert.equal(h.runtime.accountActionPending,false);
 for(const params of [{},[],{accountId:7,extra:true},{accountId:0},{accountId:'7'},{accountId:1.5}])await assert.rejects(h.bridgeDispatch('isolated_inspect',params),/accountId/);
 await assert.rejects(inspect(event,9),/недоступен/);h.runtime.jobs=[{status:'running'}];
 await assert.rejects(inspect(event,7),/завершения генерации/);await assert.rejects(h.bridgeDispatch('isolated_inspect',{accountId:7}),/текущей генерации/);
 h.runtime.jobs=[];const bridgePending=h.bridgeDispatch('isolated_inspect',{accountId:7});await new Promise(setImmediate);finish();
 assert.equal((await bridgePending).accountEmail,'owner@example.test');assert.deepEqual(calls,[[7,'owner@example.test'],[7,'owner@example.test']]);
 assert.equal(h.events.some(event=>typeof event==='string'&&event.startsWith('native-')||Array.isArray(event)&&['open-path','external','native-inspect'].includes(event[0])),false,'Background inspection never requests native access or focuses Chrome');
});
test('profile enrichment cannot publish a stale enabled or deleted account list',async()=>{
 let release,profileReads=0;
 const h=await launch({managedOverrides:{hasAccountProfile:async()=>{if(++profileReads===1)await new Promise(resolve=>{release=resolve;});return true;}}});
 const old=[{id:7,email:'owner@example.test',isActive:true}],fresh=[{id:7,email:'owner@example.test',isActive:false}];h.runtime.accounts=old;
 const first=h.runtime.refreshAccounts();await new Promise(setImmediate);h.runtime.accounts=fresh;await h.runtime.refreshAccounts();release();await first;
 const events=h.sent.filter(([channel,event])=>channel==='studio:event'&&event.type==='accounts');
 assert.equal(events.length,1);assert.strictEqual(events[0][1].accounts,fresh);assert.equal(events[0][1].accounts[0].isActive,false);
});
test('window close quits only after backend shutdown; repeated quit does not duplicate cleanup',async()=>{
 const h=await launch();let prevented=false;
 h.window.emit('close',{preventDefault(){prevented=true;}});
 await new Promise(setImmediate);
 assert.equal(prevented,true);assert.equal(h.stopped,false);
 assert.deepEqual(h.events,['accounts','bridge','stop']);
 h.app.quit();await new Promise(setImmediate);assert.deepEqual(h.events,['accounts','bridge','stop']);
 h.finish();await new Promise(setImmediate);assert.equal(h.stopped,true);
});
test('accepted quit blocks renderer generation and all bridge dispatch while shutdown still drains accounts',async()=>{
 let generated=0;const h=await launch({accountRuntime:{generate:()=>{generated++;return {jobId:'must-not-start'};}}});
 const event={sender:h.window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}};
 h.app.quit();assert.equal(h.runtime.closing,false,'Account/browser draining precedes runtime close');
 assert.throws(()=>h.handlers.get('studio:generate')(event,{model:'exact',prompt:'never paid'}),/Дождитесь/);
 for(const method of ['generate','recover','prepare','native_prepare','isolated_inspect','status'])await assert.rejects(h.bridgeDispatch(method,{}),/закрывается/);
 assert.equal(generated,0);await new Promise(setImmediate);h.finish();await new Promise(setImmediate);assert.equal(h.stopped,true);
});
test('SIGTERM and SIGINT drain ordinary shutdown once without interactive confirmation or early process exit',async()=>{
 for(const signal of ['SIGTERM','SIGINT']){
  const h=await launch();h.runtime.jobs=[{status:'running'}];
  h.signalProcess.emit(signal);h.signalProcess.emit(signal);await new Promise(setImmediate);
  assert.deepEqual(h.events,['accounts','bridge','stop']);assert.equal(h.stopped,false,'Signal waits for backend/history close');
  const event={sender:h.window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}};assert.throws(()=>h.handlers.get('studio:generate')(event,{}),/Дождитесь/);
  h.finish();await new Promise(setImmediate);assert.equal(h.stopped,true);
 }
});
test('active generation can keep the window open or explicitly close and stop, never hide',async()=>{
 const h=await launch();h.runtime.jobs=[{status:'running'}];
 h.app.quit();await new Promise(setImmediate);assert.deepEqual(h.events,[]);assert.equal(h.stopped,false);
 h.setChoice(1);h.app.quit();await new Promise(setImmediate);
 assert.deepEqual(h.events,['accounts','bridge','stop']);h.finish();await new Promise(setImmediate);assert.equal(h.stopped,true);
});
test('failed backend stop keeps app open and permits another quit attempt',async()=>{
 const h=await launch();h.failStop(new Error('Docker unavailable'));h.app.quit();await new Promise(setImmediate);
 assert.equal(h.stopped,false);assert.deepEqual(h.events.filter(event=>typeof event==='string'),['accounts','bridge','stop','show']);
 const failure=h.events.find(event=>event.dialog);assert.equal(failure.parent,h.window);assert.equal(failure.dialog.type,'error');assert.equal(failure.dialog.title,'Не удалось завершить Flow Studio');assert.equal(failure.dialog.message,'Не удалось остановить локальный движок или сохранить историю. Проверьте Docker и повторите выход из приложения.');
 h.failStop(null);h.app.quit();await new Promise(setImmediate);h.finish();await new Promise(setImmediate);assert.equal(h.stopped,true);
});

test('second termination signal retries cleanup while asynchronous shutdown error dialog still awaits response',async()=>{
 let resolveDialog;
 const h=await launch({showMessageBox:()=>new Promise(resolve=>{resolveDialog=resolve;})});
 h.failStop(new Error('Docker timeout'));h.signalProcess.emit('SIGTERM');await new Promise(setImmediate);
 const failure=h.events.find(event=>event.dialog);assert.ok(failure);assert.equal(failure.dialog.signal.aborted,false);
 assert.equal(h.events.includes('error'),false,'Synchronous native error alert must never run');assert.equal(h.stopped,false);
 let ran=false;await new Promise(resolve=>setImmediate(()=>{ran=true;resolve();}));assert.equal(ran,true,'Pending native dialog must leave Node callbacks running');
 h.failStop(null);h.signalProcess.emit('SIGTERM');await new Promise(setImmediate);
 assert.equal(failure.dialog.signal.aborted,true,'Retry dismisses stale error dialog');
 assert.equal(h.events.filter(event=>event==='stop').length,2);assert.equal(h.stopped,false,'Second attempt still waits for backend/history cleanup');
 assert.equal(h.events.filter(event=>event.dialog).length,1,'No duplicate failure dialog while retry is running');
 h.finish();await new Promise(setImmediate);assert.equal(h.stopped,true);
 resolveDialog({response:0});await new Promise(setImmediate);assert.equal(h.events.filter(event=>event==='stop').length,2);
});

test('shutdown error uses parentless asynchronous dialog if app window was destroyed',async()=>{
 const h=await launch();h.window.destroyed=true;h.failStop(new Error('Stop failed'));h.signalProcess.emit('SIGINT');await new Promise(setImmediate);
 const failure=h.events.find(event=>event.dialog);assert.equal(failure.parent,undefined);assert.equal(failure.dialog.type,'error');
 assert.equal(h.events.includes('show'),false);assert.equal(h.events.includes('error'),false);assert.equal(h.stopped,false);
 h.failStop(null);h.signalProcess.emit('SIGINT');await new Promise(setImmediate);h.finish();await new Promise(setImmediate);assert.equal(h.stopped,true);
});
test('picker and drop share import validation while registered videos keep native previews',async t=>{
 const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),'flow-main-import-'));t.after(()=>fs.promises.rm(root,{recursive:true,force:true}));
 const image=path.join(root,'image.png'),video=path.join(root,'clip.mov');await fs.promises.writeFile(image,'image');await fs.promises.writeFile(video,'video');
 const h=await launch({pickedFiles:[image,video]}),event={sender:h.window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}};
 const dropped=await h.handlers.get('studio:dropMedia')(event,[image,video],{allowVideos:true});
 const picked=await h.handlers.get('studio:pickImages')(event,{allowVideos:true});
 for(const items of [dropped,picked]){
  assert.equal(items[0].dataUrl,'data:image/png;base64,aW1hZ2U=');
  assert.equal(items[1].kind,'video');assert.equal(items[1].name,'clip.mov');assert.equal(items[1].path,video);
  assert.match(items[1].previewUrl,/^flow-input:\/\/[a-f0-9-]{36}\/$/);
  assert.equal(await h.protocols.get('flow-input')({url:items[1].previewUrl,headers:{range:'bytes=0-1'}}),'preview');
 }
 assert.equal(h.fetches.length,2);for(const fetch of h.fetches){assert.equal(fetch.url,pathToFileURL(video).href);assert.equal(fetch.options.headers.range,'bytes=0-1');}
 await assert.rejects(h.handlers.get('studio:dropMedia')(event,[video]),/формат|MP4|видео/i);
 await assert.rejects(h.handlers.get('studio:pickImages')(event),/формат|MP4|видео/i);
 assert.throws(()=>h.handlers.get('studio:dropMedia')({sender:{},senderFrame:event.senderFrame},[image]),/Недопустимый источник/);
 assert.throws(()=>h.handlers.get('studio:dropMedia')({sender:event.sender,senderFrame:{url:'https://example.com'}},[image]),/Недопустимый источник/);
});


test('account removal requires native confirmation and unlinks managed profile only after acceptance',async()=>{
 const actions=[];
 const h=await launch({accountRuntime:{accounts:[{id:7,email:'owner@example.test'}],refreshAccounts:async()=>[{id:7,email:'owner@example.test'}],deleteAccount:async id=>{actions.push(['delete',id]);return {deleted:true,accounts:[]};}},managedOverrides:{removeAccount:async(id,fn)=>{actions.push(['unlink',id]);return fn();}}});
 const event={sender:h.window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}};
 const remove=()=>h.handlers.get('studio:deleteAccount')(event,7);
 assert.equal((await remove()).deleted,false);assert.deepEqual(actions,[]);
 const options=h.events.find(x=>x.dialog).dialog;
 assert.equal(options.defaultId,0);assert.equal(options.cancelId,0);assert.match(options.message,/owner@example.test/);assert.match(options.detail,/история генераций останутся/);
 h.setChoice(1);assert.equal((await remove()).deleted,true);assert.deepEqual(actions,[['unlink',7],['delete',7]]);
 h.runtime.jobs=[{status:'running'}];await assert.rejects(remove(),/завершения генерации/);
});

test('bulk check goes through managed session sync and serial account action blocks concurrent mutation',async()=>{
 const calls=[];let finish;
 const h=await launch({accountRuntime:{checkEnabledAccounts:async({checkAccount})=>{await new Promise(resolve=>{finish=resolve;});await checkAccount(7);return {verified:1};},checkAccount:async id=>{calls.push(['check',id]);return {ok:true};}},managedOverrides:{syncAccountNow:async id=>calls.push(['sync',id])}});
 const event={sender:h.window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}};
 const task=h.handlers.get('studio:checkEnabledAccounts')(event);await new Promise(setImmediate);
 assert.throws(()=>h.handlers.get('studio:setAccountActive')(event,7,false),/Дождитесь/);
 finish();assert.deepEqual(await task,{verified:1});assert.deepEqual(calls,[['sync',7],['check',7]]);
});
test('UI account actions honor deferred MCP mutation lock until the original action finishes',async()=>{
 let finish;const calls=[],h=await launch({accountRuntime:{setAccountActive:async(id,enabled)=>{calls.push(['set',id,enabled]);await new Promise(resolve=>{finish=resolve;});return {accounts:[]};},clearCooldown:async()=>assert.fail('UI reset entered during MCP action'),checkAccount:async()=>assert.fail('UI check entered during MCP action')}});
 const pending=h.bridgeDispatch('set_account_active',{accountId:7,enabled:false});await new Promise(setImmediate);assert.equal(h.runtime.accountActionPending,true);
 const event={sender:h.window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}};
 assert.throws(()=>h.handlers.get('studio:clearCooldown')(event,7),/Дождитесь/);assert.throws(()=>h.handlers.get('studio:checkAccount')(event,7),/Дождитесь/);assert.equal(h.runtime.accountActionPending,true);
 await assert.rejects(h.bridgeDispatch('reset_cooldown',{accountId:7}),/Дождитесь/);assert.equal(h.runtime.accountActionPending,true);
 finish();await pending;assert.equal(h.runtime.accountActionPending,false);assert.deepEqual(calls,[['set',7,false]]);
});


test('quitting waits for an accepted account removal to persist before stopping backend',async()=>{
 let finish;
 const h=await launch({accountRuntime:{accounts:[{id:7,email:'owner@example.test'}],refreshAccounts:async()=>[{id:7,email:'owner@example.test'}],deleteAccount:async()=>new Promise(resolve=>{finish=()=>resolve({deleted:true,accounts:[]});})},managedOverrides:{removeAccount:async(_id,fn)=>{const result=await fn();h.events.push('unlink-persisted');return result;}}});
 const event={sender:h.window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}};
 h.setChoice(1);const removal=h.handlers.get('studio:deleteAccount')(event,7);await new Promise(setImmediate);
 h.app.quit();await new Promise(setImmediate);
 assert.equal(h.events.includes('stop'),false,'Stopping the engine cannot interrupt accepted delete');
 assert.equal(h.runtime.accountActionPending,true);
 finish();await removal;await new Promise(setImmediate);
 assert(h.events.indexOf('unlink-persisted')<h.events.indexOf('stop'));
 h.finish();await new Promise(setImmediate);assert.equal(h.stopped,true);
});


test('manual Flow handoff opens only fixed official URL from trusted renderer',async()=>{
 const h=await launch(),event={sender:h.window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}};
 assert.equal((await h.handlers.get('studio:openFlow')(event,'https://attacker.invalid')).opened,true);
 assert(h.events.some(e=>Array.isArray(e)&&e[0]==='external'&&e[1]==='https://flow.google.com/'));
 assert.throws(()=>h.handlers.get('studio:openFlow')({sender:{},senderFrame:event.senderFrame}),/Недопустимый источник/);
});

test('provider settings IPC trusts only local renderer and serializes saves with account actions and shutdown',async()=>{
 const calls=[];let finish;
 const h=await launch({accountRuntime:{getProviderSettings:async(...args)=>{calls.push(['get',...args]);return {twoCaptchaKeyConfigured:false,captchaMethod:'personal'};},saveTwoCaptchaKey:async(...args)=>{calls.push(['save',...args]);await new Promise(resolve=>{finish=resolve;});return {saved:true,twoCaptchaKeyConfigured:true,captchaMethod:'personal'};}}});
 const event={sender:h.window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}};
 const read=h.handlers.get('studio:getProviderSettings'),save=h.handlers.get('studio:saveTwoCaptchaKey');
 assert.deepEqual(await read(event,'/arbitrary/endpoint'),{twoCaptchaKeyConfigured:false,captchaMethod:'personal'});
 for(const invalid of [{sender:{},senderFrame:event.senderFrame},{sender:event.sender,senderFrame:{url:'https://example.test'}}]){
  assert.throws(()=>read(invalid),/Недопустимый источник/);
  assert.throws(()=>save(invalid,'synthetic-key'),/Недопустимый источник/);
 }
 const pending=save(event,'synthetic-key',{captcha_method:'twocaptcha'});await new Promise(setImmediate);
 assert.equal(h.runtime.accountActionPending,true);
 assert.deepEqual(calls,[['get'],['save','synthetic-key']]);
 assert.throws(()=>save(event,'synthetic-other-key'),/Дождитесь/);
 assert.throws(()=>h.handlers.get('studio:generate')(event,{}),/Дождитесь/);
 assert.throws(()=>h.handlers.get('studio:setAccountActive')(event,7,false),/Дождитесь/);
 h.app.quit();await new Promise(setImmediate);assert.equal(h.events.includes('stop'),false);
 finish();assert.deepEqual(await pending,{saved:true,twoCaptchaKeyConfigured:true,captchaMethod:'personal'});
 await new Promise(setImmediate);assert.equal(h.runtime.accountActionPending,false);assert.equal(h.events.includes('stop'),true);
 h.finish();await new Promise(setImmediate);assert.equal(h.stopped,true);
});

test('retry IPC accepts only original job id and stable request id and serializes with cooldown reset',async()=>{
 const calls=[];let finish;
 const h=await launch({accountRuntime:{retryGeneration:async input=>{calls.push(['retry',input]);return {jobId:'new-job'};},clearCooldown:async id=>{calls.push(['clear',id]);await new Promise(resolve=>{finish=resolve;});return {cleared:true,accounts:[]};}}});
 const event={sender:h.window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}};
 const retry=h.handlers.get('studio:retryGeneration'),clear=h.handlers.get('studio:clearCooldown');
 assert.deepEqual(await retry(event,{jobId:'original',requestId:'click-id'}),{jobId:'new-job'});
 for(const input of [{jobId:'original',requestId:'click-id',model:'override'},{jobId:'original',requestId:''},{jobId:'original',requestId:'x'.repeat(129)},null,[]])assert.throws(()=>retry(event,input),/параметры повтора/);
 for(const invalid of [{sender:{},senderFrame:event.senderFrame},{sender:event.sender,senderFrame:{url:'https://example.test'}}]){
  assert.throws(()=>retry(invalid,{jobId:'original',requestId:'click-id'}),/Недопустимый источник/);
  assert.throws(()=>clear(invalid,7),/Недопустимый источник/);
 }
 const pending=clear(event,7);await new Promise(setImmediate);assert.equal(h.runtime.accountActionPending,true);
 assert.throws(()=>retry(event,{jobId:'original',requestId:'second-click'}),/Дождитесь/);
 assert.throws(()=>clear(event,8),/Дождитесь/);
 finish();await pending;assert.equal(h.runtime.accountActionPending,false);
 h.runtime.retryTask=Promise.resolve();assert.throws(()=>clear(event,7),/Дождитесь/);
 assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['retry',{jobId:'original',requestId:'click-id'}],['clear',7]]);
});


test('native browser access needs native confirmation and inspection pins active account',async()=>{
 const h=await launch({accountRuntime:{refreshAccounts:async()=>[{id:7,email:'owner@example.test',isActive:true}]} });
 const event={sender:h.window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}};
 assert.throws(()=>h.handlers.get('studio:browserStatus')({sender:{},senderFrame:event.senderFrame}),/Недопустимый источник/);
 assert.throws(()=>h.handlers.get('studio:requestBrowserAccess')({sender:event.sender,senderFrame:{url:'https://example.test'}}),/Недопустимый источник/);
 await assert.rejects(h.handlers.get('studio:inspectBrowser')(event,99),/отключён или удалён/);
 assert.equal((await h.handlers.get('studio:browserStatus')(event)).trusted,false);
 await h.handlers.get('studio:requestBrowserAccess')(event);assert(!h.events.includes('native-permission'),'Cancel never requests OS access');
 h.setChoice(1);await h.handlers.get('studio:requestBrowserAccess')(event);assert(h.events.includes('native-permission'));
 const result=await h.handlers.get('studio:inspectBrowser')(event,7,{pid:999});assert.equal(result.accountMatch,true);
 assert(h.events.some(e=>Array.isArray(e)&&e[0]==='native-inspect'&&e[1]===7&&e[2]==='owner@example.test'));

 h.runtime.jobs=[{status:'running'}];
 await assert.rejects(h.handlers.get('studio:inspectBrowser')(event,7),/завершения генерации/);
});


test('native submit rejects unknown preparation token before any browser or generation work',async()=>{
 const h=await launch(),event={sender:h.window.webContents,senderFrame:{url:pathToFileURL(path.join(__dirname,'index.html')).href}};
 await assert.rejects(h.handlers.get('studio:submitNativeBrowser')(event,{token:'not-issued'}),/устарел/);
 assert.throws(()=>h.handlers.get('studio:submitNativeBrowser')({sender:{},senderFrame:event.senderFrame},{token:'not-issued'}),/Недопустимый источник/);
});
