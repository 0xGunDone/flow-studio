'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const {EventEmitter}=require('node:events');
async function launch({ready=true,closing=false,pickedFiles=[]}={}){
 const events=[],windows=[],app=new EventEmitter(),handlers=new Map(),protocols=new Map(),fetches=[];let stopped=false,finishStop,stopError,choice=0,autoSyncs=0;
 const runtime={jobs:[],ready,closing,initializeHistory:async()=>{},start:async()=>{},close:()=>{events.push('stop');return stopError?Promise.reject(stopError):new Promise(resolve=>{finishStop=resolve;});}};
 app.setName=()=>{};app.requestSingleInstanceLock=()=>true;app.getPath=()=>'/unused';app.getVersion=()=>'1.1.0';
 app.whenReady=()=>Promise.resolve();
 app.quit=()=>{let prevented=false;app.emit('before-quit',{preventDefault(){prevented=true;}});if(!prevented)stopped=true;};
 class Window extends EventEmitter{
  constructor(){super();windows.push(this);this.webContents=new EventEmitter();Object.assign(this.webContents,{send(){},setWindowOpenHandler(){},session:{setPermissionRequestHandler(){}}});}
  loadFile(){}show(){events.push('show');}focus(){}isDestroyed(){return false;}
 }
 const manager={shutdown:()=>events.push('accounts'),startAutoSync(){autoSyncs++;}};
 const electron={app,BrowserWindow:Window,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},protocol:{registerSchemesAsPrivileged(){},handle:(name,fn)=>protocols.set(name,fn)},Menu:{buildFromTemplate:x=>x,setApplicationMenu(){}},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:pickedFiles}),showMessageBoxSync:()=>choice,showErrorBox:()=>events.push('error')},shell:{},net:{fetch:(url,options)=>{fetches.push({url,options});return 'preview';}},clipboard:{}};
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
