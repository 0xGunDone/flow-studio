'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const {EventEmitter}=require('node:events');
async function launch({ready=true,closing=false,pickedFiles=[],accountRuntime={},managedOverrides={}}={}){
 const events=[],windows=[],app=new EventEmitter(),handlers=new Map(),protocols=new Map(),fetches=[];let stopped=false,finishStop,stopError,choice=0,autoSyncs=0;
 const runtime={jobs:[],ready,closing,initializeHistory:async()=>{},start:async()=>{},close:()=>{events.push('stop');return stopError?Promise.reject(stopError):new Promise(resolve=>{finishStop=resolve;});}};
 app.setName=()=>{};app.requestSingleInstanceLock=()=>true;app.getPath=()=>'/unused';app.getVersion=()=>'1.1.0';
 app.whenReady=()=>Promise.resolve();
 app.quit=()=>{let prevented=false;app.emit('before-quit',{preventDefault(){prevented=true;}});if(!prevented)stopped=true;};
 class Window extends EventEmitter{
  constructor(){super();windows.push(this);this.webContents=new EventEmitter();Object.assign(this.webContents,{send(){},setWindowOpenHandler(){},session:{setPermissionRequestHandler(){}}});}
  loadFile(){}show(){events.push('show');}focus(){}isDestroyed(){return false;}
 }
 Object.assign(runtime,accountRuntime);
 const manager={...managedOverrides,shutdown:()=>events.push('accounts'),startAutoSync(){autoSyncs++;}};
 const electron={app,BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},protocol:{registerSchemesAsPrivileged(){},handle:(name,fn)=>protocols.set(name,fn)},Menu:{buildFromTemplate:x=>x,setApplicationMenu(){}},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:pickedFiles}),showMessageBoxSync:()=>choice,showMessageBox:async(_window,options)=>{events.push({dialog:options});return {response:choice};},showErrorBox:()=>events.push('error')},shell:{openExternal:async url=>events.push(['external',url])},net:{fetch:(url,options)=>{fetches.push({url,options});return 'preview';}},clipboard:{}};
 const replacements={electron,'node:fs/promises':{mkdir:async()=>{}},'./runtime.cjs':{Runtime:class{constructor(){return runtime;}}},'./bootstrap.cjs':{prepareEngine:async()=>({})},'./exports.cjs':{},'./agent-bridge.cjs':{createAgentActions(){},startAgentBridge:async()=>({close:async()=>events.push('bridge')})},'./accounts.cjs':{createAccountManager:()=>manager},'./recovery.cjs':{createRecoveryManager:()=>({shutdown(){}})}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'main.cjs'),'utf8'),{require:name=>replacements[name]??require(name),__dirname,URL,Response});
 await new Promise(setImmediate);
 return {app,runtime,events,window:windows[0],handlers,protocols,fetches,get stopped(){return stopped;},get autoSyncs(){return autoSyncs;},finish:()=>finishStop(),setChoice:value=>{choice=value;},failStop:error=>{stopError=error;}};
}
test('automatic Google account sync starts only after successful startup',async()=>{
 const failed=await launch({ready:false});assert.equal(failed.autoSyncs,0);
 const ready=await launch();assert.equal(ready.autoSyncs,1);
 const closing=await launch({closing:true});assert.equal(closing.autoSyncs,0);
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
test('active generation can keep the window open or explicitly close and stop, never hide',async()=>{
 const h=await launch();h.runtime.jobs=[{status:'running'}];
 h.app.quit();await new Promise(setImmediate);assert.deepEqual(h.events,[]);assert.equal(h.stopped,false);
 h.setChoice(1);h.app.quit();await new Promise(setImmediate);
 assert.deepEqual(h.events,['accounts','bridge','stop']);h.finish();await new Promise(setImmediate);assert.equal(h.stopped,true);
});
test('failed backend stop keeps app open and permits another quit attempt',async()=>{
 const h=await launch();h.failStop(new Error('Docker unavailable'));h.app.quit();await new Promise(setImmediate);
 assert.equal(h.stopped,false);assert.deepEqual(h.events,['accounts','bridge','stop','error','show']);
 h.failStop(null);h.app.quit();await new Promise(setImmediate);h.finish();await new Promise(setImmediate);assert.equal(h.stopped,true);
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
