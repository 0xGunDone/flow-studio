'use strict';
const {app,BrowserWindow,ipcMain,dialog,Menu,shell,protocol,net,clipboard}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {Runtime}=require('./runtime.cjs');
const {importMedia}=require('./input-files.cjs');
const {saveWithDialog,revealSaved}=require('./exports.cjs');
const {startAgentBridge,createAgentActions}=require('./agent-bridge.cjs');
protocol.registerSchemesAsPrivileged(['flow-media','flow-input'].map(scheme=>({scheme,privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}})));
let window,runtime,accountManager,recoveryManager,managedAccounts,agentBridge,shutdownTask,accountTask,loginState=null,quitting=false;
app.setName('Flow Studio');
if(!app.requestSingleInstanceLock()){app.quit();}
else{
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
app.whenReady().then(async()=>{
 const dataDir=app.getPath('userData');await fs.mkdir(dataDir,{recursive:true,mode:0o700});
 if(shutdownTask||quitting)return;
 const {prepareEngine}=require('./bootstrap.cjs');
 const config=await prepareEngine({dataDir,backendDir:app.isPackaged?path.join(process.resourcesPath,'backend'):path.resolve(__dirname,'../backend'),version:app.getVersion()});
 const send=event=>{if(window&&!window.isDestroyed())window.webContents.send('studio:event',event);};
 runtime=new Runtime({...config,dataDir,onEvent:send});await runtime.initializeHistory();
 if(shutdownTask||quitting)return;
 const {createAccountManager}=require('./accounts.cjs');
 const onLoginState=state=>{loginState=state;send({type:'login',login:state});};
 const chromePath='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 managedAccounts=createAccountManager({dataDir,chromePath,syncAccount:input=>runtime.syncAccount(input),onState:onLoginState,onAccountsChanged:()=>runtime.refreshAccounts()});
 const {createRecoveryManager}=require('./recovery.cjs');
 recoveryManager=createRecoveryManager({chromeDataDir:path.join(app.getPath('appData'),'Google/Chrome'),chromePath,listAccounts:()=>runtime.refreshAccounts(),verifyAccount:(id,options)=>runtime.checkAccount(id,options),onState:onLoginState});
 accountManager={
  addAccount(){if(accountTask||shutdownTask)throw new Error('Дождитесь завершения действия с аккаунтами.');recoveryManager.cancel();return managedAccounts.addAccount();},
  async reconnectAccount(id){
   if(accountTask||shutdownTask)throw new Error('Дождитесь завершения действия с аккаунтами.');
   managedAccounts.cancelLogin();
   if(await managedAccounts.hasAccountProfile(id)){recoveryManager.cancel();return managedAccounts.reconnectAccount(id);}
   return await recoveryManager.begin(id)||managedAccounts.reconnectAccount(id);
  },
  completeLogin:()=>recoveryManager.active?recoveryManager.verify():managedAccounts.completeLogin(),
  cancelLogin:()=>recoveryManager.active?recoveryManager.cancel():managedAccounts.cancelLogin(),
  startAutoSync:()=>managedAccounts.startAutoSync(),
  shutdown(){recoveryManager.shutdown();managedAccounts.shutdown();}
 };
 protocol.handle('flow-media',request=>{
  const url=new URL(request.url),index=Number(url.pathname.slice(1));
  const file=runtime.mediaFile(url.hostname,index);
  if(!file||!Number.isInteger(index)||index<0)return new Response('Not found',{status:404});
  return net.fetch(pathToFileURL(file).href,{headers:request.headers});
 });
 const inputFiles=new Map();
 const importFiles=async(files,options)=>{
  const items=await importMedia(files,options);
  for(const item of items){
   if(item.kind!=='video')continue;
   if(inputFiles.size>=100)inputFiles.delete(inputFiles.keys().next().value);
   const id=require('node:crypto').randomUUID();inputFiles.set(id,item.path);item.previewUrl='flow-input://'+id+'/';
  }
  return items;
 };
 protocol.handle('flow-input',request=>{
  const url=new URL(request.url),file=inputFiles.get(url.hostname);
  if(!file||url.pathname!=='/')return new Response('Not found',{status:404});
  return net.fetch(pathToFileURL(file).href,{headers:request.headers});
 });
 const localPage=pathToFileURL(path.join(__dirname,'index.html')).href;
 const handle=(name,fn)=>ipcMain.handle('studio:'+name,(event,...args)=>{
  if(event.sender!==window?.webContents||event.senderFrame?.url!==localPage)throw new Error('Недопустимый источник запроса');
  return fn(...args);
 });
 handle('bootstrap',async()=>({...await runtime.start(),login:loginState}));
 handle('openFlow',async()=>{await shell.openExternal('https://flow.google.com/');return {opened:true};});
 handle('retryStartup',async()=>({...await runtime.start(),login:loginState}));
 const accountAction=fn=>{
  if(accountTask||shutdownTask||runtime.closing)throw new Error('Дождитесь завершения действия с аккаунтами.');
  if(['opening','waiting','syncing'].includes(loginState?.state))throw new Error('Сначала завершите или отмените вход в Google.');
  runtime.accountActionPending=true;
  accountTask=Promise.resolve().then(fn).finally(()=>{accountTask=null;runtime.accountActionPending=false;});return accountTask;
 };
 handle('getProviderSettings',()=>runtime.getProviderSettings());
 handle('saveTwoCaptchaKey',key=>accountAction(()=>runtime.saveTwoCaptchaKey(key)));
 handle('generate',input=>{if(accountTask)throw new Error('Дождитесь завершения действия с аккаунтами.');return runtime.generate(input);});
 handle('refreshAccounts',()=>{if(accountTask)throw new Error('Дождитесь завершения действия с аккаунтами.');return runtime.refreshAccounts();});
 handle('addAccount',()=>{if(accountTask)throw new Error('Дождитесь завершения действия с аккаунтами.');return accountManager.addAccount();});
 handle('reconnectAccount',id=>{if(accountTask)throw new Error('Дождитесь завершения действия с аккаунтами.');if(!runtime.accounts.some(a=>a.id===id))throw new Error('Аккаунт не найден');return accountManager.reconnectAccount(id);});
 const checkAccount=async id=>{await managedAccounts.syncAccountNow(id);return runtime.checkAccount(id);};
 handle('checkAccount',id=>accountAction(()=>checkAccount(id)));
 handle('checkEnabledAccounts',()=>accountAction(()=>{
  if(runtime.jobs.some(job=>job.status==='running'))throw new Error('Дождитесь завершения генерации перед проверкой аккаунтов.');
  return runtime.checkEnabledAccounts({checkAccount});
 }));
 handle('setAccountActive',(id,enabled)=>accountAction(()=>runtime.setAccountActive(id,enabled)));
 handle('deleteAccount',id=>accountAction(async()=>{
  if(!Number.isSafeInteger(id)||id<=0)throw new Error('Аккаунт не найден.');
  if(runtime.jobs.some(job=>job.status==='running'))throw new Error('Дождитесь завершения генерации перед удалением аккаунта.');
  const account=(await runtime.refreshAccounts()).find(a=>a.id===id);
  if(!account)throw new Error('Аккаунт не найден.');
  const choice=await dialog.showMessageBox(window,{type:'warning',title:'Удалить подключение',message:`Удалить подключение ${account.email}?`,detail:'Подключение будет удалено из Flow Studio. Аккаунт Google, профиль Chrome, сохранённые файлы и история генераций останутся. Для генерации потребуется подключить аккаунт заново.',buttons:['Отмена','Удалить подключение'],defaultId:0,cancelId:0,noLink:true});
  if(choice.response!==1)return {deleted:false};
  return managedAccounts.removeAccount(id,()=>runtime.deleteAccount(id));
 }));
 handle('cancelLogin',()=>accountManager.cancelLogin());
 handle('completeLogin',()=>accountManager.completeLogin());
 handle('copyHelpText',text=>{
  if(typeof text!=='string'||text.length>20000)throw new Error('Не удалось скопировать текст.');
  clipboard.writeText(text);return {copied:true};
 });
 handle('pickImages',async(options={})=>{
  const allowVideos=options?.allowVideos===true;
  const result=await dialog.showOpenDialog(window,{title:allowVideos?'Выбрать фото и видео':'Выбрать изображения',properties:['openFile','multiSelections'],filters:[{name:allowVideos?'Фото и видео':'Изображения',extensions:['png','jpg','jpeg','webp','gif',...(allowVideos?['mp4','mov','m4v']:[])]}]});
  if(result.canceled)return[];
  return importFiles(result.filePaths,{allowVideos});
 });
 handle('dropMedia',importFiles);
 handle('revealFile',file=>revealSaved({runtime,shell},file));
 handle('saveMedia',input=>saveWithDialog({runtime,window,dialog,downloadsDir:app.getPath('downloads')},input));
 function createWindow(){
  window=new BrowserWindow({width:1280,height:860,minWidth:920,minHeight:640,title:'Flow Studio',backgroundColor:'#151916',titleBarStyle:'hiddenInset',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.webContents.on('console-message',details=>{
   if(details.message?.startsWith('FLOW_MEDIA_ERROR '))fs.writeFile(path.join(dataDir,'media-diagnostic.log'),details.message,{mode:0o600}).catch(()=>{});
  });
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(url!==localPage)event.preventDefault();});
  window.webContents.session.setPermissionRequestHandler((_web, _permission, callback)=>callback(false));
  window.loadFile(path.join(__dirname,'index.html'));
  window.on('close',event=>{
   if(!quitting){event.preventDefault();app.quit();}
  });
  window.on('closed',()=>{window=null;});
 }
 Menu.setApplicationMenu(Menu.buildFromTemplate([
 {label:'Flow Studio',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
 {label:'Правка',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
 {label:'Вид',submenu:[{role:'reload'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]},
 {label:'Окно',submenu:[{role:'minimize'},{role:'zoom'},{role:'front'}]}
 ]));
 createWindow();
 agentBridge=await startAgentBridge({dataDir,dispatch:createAgentActions({runtime,accountManager,getLoginState:()=>loginState,shell})});
 if(shutdownTask||quitting){await agentBridge.close();return;}
 app.on('activate',()=>{if(!window)createWindow();else{window.show();window.focus();}});
 runtime.start().then(()=>{if(runtime.ready&&!runtime.closing)accountManager.startAutoSync();}).catch(e=>send({type:'error',message:e.message}));
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{
 if(quitting)return;
 event.preventDefault();if(shutdownTask)return;
 if(runtime?.jobs.some(j=>j.status==='running')){
  const choice=dialog.showMessageBoxSync(window,{type:'question',message:'Генерация ещё идёт',detail:'Закрытие остановит локальный движок и ожидание результата. Задача Google может продолжиться — перед повтором проверьте её в Flow.',buttons:['Вернуться','Закрыть и остановить'],defaultId:0,cancelId:0});
  if(choice!==1)return;
 }
 accountManager?.shutdown();
 shutdownTask=(async()=>{
  await agentBridge?.close();
  await accountTask?.catch(()=>{});
  await runtime?.close();
  quitting=true;app.quit();
 })().catch(()=>{
  shutdownTask=null;
  dialog.showErrorBox('Не удалось завершить Flow Studio','Не удалось остановить локальный движок или сохранить историю. Проверьте Docker и повторите выход из приложения.');
  window?.show();
 });
});
}
