'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
async function launch(){
 const events=[],windows=[],app=new EventEmitter();let stopped=false,finishStop,stopError,choice=0;
 const runtime={jobs:[],initializeHistory:async()=>{},start:async()=>{},close:()=>{events.push('stop');return stopError?Promise.reject(stopError):new Promise(resolve=>{finishStop=resolve;});}};
 app.setName=()=>{};app.requestSingleInstanceLock=()=>true;app.getPath=()=>'/unused';app.getVersion=()=>'1.1.0';
 app.whenReady=()=>Promise.resolve();
 app.quit=()=>{let prevented=false;app.emit('before-quit',{preventDefault(){prevented=true;}});if(!prevented)stopped=true;};
 class Window extends EventEmitter{
  constructor(){super();windows.push(this);this.webContents=new EventEmitter();Object.assign(this.webContents,{send(){},setWindowOpenHandler(){},session:{setPermissionRequestHandler(){}}});}
  loadFile(){}show(){events.push('show');}focus(){}isDestroyed(){return false;}
 }
 const manager={shutdown:()=>events.push('accounts'),startAutoSync(){}};
 const electron={app,BrowserWindow:Window,ipcMain:{handle(){}},protocol:{registerSchemesAsPrivileged(){},handle(){}},Menu:{buildFromTemplate:x=>x,setApplicationMenu(){}},dialog:{showMessageBoxSync:()=>choice,showErrorBox:()=>events.push('error')},shell:{},net:{},clipboard:{}};
 const replacements={electron,'node:fs/promises':{mkdir:async()=>{}},'./runtime.cjs':{Runtime:class{constructor(){return runtime;}}},'./bootstrap.cjs':{prepareEngine:async()=>({})},'./exports.cjs':{},'./agent-bridge.cjs':{createAgentActions(){},startAgentBridge:async()=>({close:async()=>events.push('bridge')})},'./accounts.cjs':{createAccountManager:()=>manager},'./recovery.cjs':{createRecoveryManager:()=>({shutdown(){}})}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'main.cjs'),'utf8'),{require:name=>replacements[name]??require(name),__dirname});
 await new Promise(setImmediate);
 return {app,runtime,events,window:windows[0],get stopped(){return stopped;},finish:()=>finishStop(),setChoice:value=>{choice=value;},failStop:error=>{stopError=error;}};
}
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
