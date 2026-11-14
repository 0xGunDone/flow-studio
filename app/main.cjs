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
let window,runtime,accountManager,recoveryManager,managedAccounts,agentBridge,browserTransport,preparedBrowser,shutdownTask,shutdownErrorDialog,accountTask,uploadRightsPending,loginState=null,quitting=false,terminationRequested=false;
app.setName('Flow Studio');
if(!app.requestSingleInstanceLock()){app.quit();}
else{
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{terminationRequested=true;app.quit();});
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
 managedAccounts=createAccountManager({dataDir,chromePath,chromeDataDir:path.join(app.getPath('appData'),'Google/Chrome'),getAccount:id=>runtime.accounts.find(a=>a.id===id),syncAccount:input=>runtime.syncAccount(input),onState:onLoginState,onAccountsChanged:()=>runtime.refreshAccounts()});
 const {createBrowserEngine}=require('./browser-engine.cjs');
 const isolatedEngine=createBrowserEngine({accounts:managedAccounts,dataDir,inspectVideo:({path:file,signal})=>runtime.inspectBrowserVideo(file,{signal}),confirmUploadRights:async({accountEmail,text,signal})=>{
  signal?.throwIfAborted();
  if(uploadRightsPending)throw new Error('Дождитесь подтверждения текущих условий Google.');
  const controller=new AbortController();let respond,rejectAbort,timer;
  const response=new Promise(resolve=>{respond=resolve;}),aborted=new Promise((_,reject)=>{rejectAbort=reject;});
  const abort=()=>rejectAbort(signal.reason||new Error('Подтверждение загрузки отменено.'));
  const pending={token:require('node:crypto').randomUUID(),accountEmail,text,createdAt:Date.now(),respond,consumed:false};uploadRightsPending=pending;
  signal?.addEventListener('abort',abort,{once:true});
  const expired=new Promise(resolve=>{timer=setTimeout(()=>resolve(false),10*60*1000);});
  try{
   const native=dialog.showMessageBox(window,{type:'question',title:'Права на медиа',message:'Google просит подтвердить права на загрузку медиа',detail:'Аккаунт: '+accountEmail+'\n\n'+text+'\n\nПодтвердив, вы разрешаете Flow Studio нажать «I agree» только в этом запросе Google. Это не запускает генерацию и не расходует кредиты.',buttons:['Отмена','Подтверждаю права'],defaultId:0,cancelId:0,noLink:true,signal:controller.signal}).then(choice=>choice.response===1);
   return await Promise.race([native,response,aborted,expired]);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();if(uploadRightsPending===pending)uploadRightsPending=null;}
 }});
 runtime.attachBrowserEngine(isolatedEngine);
 const refreshAccounts=runtime.refreshAccounts.bind(runtime);
 runtime.refreshAccounts=async(...args)=>{const accounts=await refreshAccounts(...args);for(const account of accounts)account.browserReady=await managedAccounts.hasAccountProfile(account.id);if(runtime.accounts===accounts)send({type:'accounts',accounts,history:runtime.publicJobs()});return accounts;};
 const {createRecoveryManager}=require('./recovery.cjs');
 recoveryManager=createRecoveryManager({chromeDataDir:path.join(app.getPath('appData'),'Google/Chrome'),chromePath,listAccounts:()=>runtime.refreshAccounts(),verifyAccount:(id,options)=>runtime.checkAccount(id,options),onState:onLoginState});
 accountManager={
  addAccount(){if(accountTask||shutdownTask||runtime.retryTask)throw new Error('Дождитесь завершения действия с аккаунтами.');recoveryManager.cancel();return managedAccounts.addAccount();},
  async reconnectAccount(id){
   if(accountTask||shutdownTask||runtime.retryTask)throw new Error('Дождитесь завершения действия с аккаунтами.');
   managedAccounts.cancelLogin();
   recoveryManager.cancel();return managedAccounts.reconnectAccount(id);
  },
  completeLogin:()=>recoveryManager.active?recoveryManager.verify():managedAccounts.completeLogin(),
  cancelLogin:()=>recoveryManager.active?recoveryManager.cancel():managedAccounts.cancelLogin(),
  startAutoSync:()=>managedAccounts.startAutoSync(),
  shutdown(){recoveryManager.shutdown();return managedAccounts.shutdown();}
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
 handle('cancelGeneration',id=>runtime.cancelGeneration(id));
 handle('recoverGeneration',id=>{
  if(accountTask||shutdownTask||runtime.closing)throw new Error('Дождитесь завершения текущего действия.');
  if(['opening','waiting','syncing'].includes(loginState?.state))throw new Error('Сначала завершите или отмените вход в Google.');
  return runtime.recoverGeneration(id);
 });
 const inspectIsolatedBrowser=id=>accountAction(async()=>{
  if(!Number.isSafeInteger(id)||id<=0||runtime.jobs.some(j=>j.status==='running'))throw new Error('Выберите аккаунт после завершения генерации.');
  const account=(await runtime.refreshAccounts()).find(a=>a.id===id&&a.isActive);if(!account)throw new Error('Аккаунт недоступен.');
  return isolatedEngine.inspect(id,{email:account.email});
 });
 handle('inspectIsolatedBrowser',inspectIsolatedBrowser);
 const checkIsolatedInputs=input=>accountAction(async()=>{
  if(!Number.isSafeInteger(input?.accountId)||input.accountId<=0||runtime.jobs.some(j=>j.status==='running'))throw new Error('Выберите аккаунт после завершения генерации.');
  const account=(await runtime.refreshAccounts()).find(a=>a.id===input.accountId&&a.isActive);
  if(!account)throw new Error('Аккаунт недоступен.');
  return isolatedEngine.check({...input,accountEmail:account.email});
 });
 const accountAction=fn=>{
  if(accountTask||runtime.accountActionPending||shutdownTask||runtime.closing||runtime.retryTask)throw new Error('Дождитесь завершения действия с аккаунтами.');
  if(['opening','waiting','syncing'].includes(loginState?.state))throw new Error('Сначала завершите или отмените вход в Google.');
  runtime.accountActionPending=true;
  accountTask=Promise.resolve().then(fn).finally(()=>{accountTask=null;runtime.accountActionPending=false;});return accountTask;
 };
 const handoffChrome=async()=>{if(await shell.openPath('/Applications/Google Chrome.app'))throw new Error('Не удалось открыть Google Chrome.');};
 const nativeBrowser=()=>{
  if(!browserTransport){
   const {NativeBrowser,createBrowserTransport}=require('./browser-native.cjs');
   const binaryPath=app.isPackaged&&app.getAppPath().endsWith('.asar')?path.join(process.resourcesPath,'native','flow-browser-'+process.arch):path.join(__dirname,'native','bin','flow-browser-'+process.arch);
   browserTransport=createBrowserTransport({native:new NativeBrowser({binaryPath}),accounts:managedAccounts,dataDir});
  }
  return browserTransport;
 };
 const browserAction=async fn=>{try{return await fn(nativeBrowser());}catch(error){if(['NATIVE_CLOSED','NATIVE_TIMEOUT','NATIVE_UNAVAILABLE','NATIVE_TRANSPORT','NATIVE_PROTOCOL'].includes(error.code)){const previous=browserTransport;browserTransport=null;await previous?.close().catch(()=>{});}throw error;}};
 handle('browserStatus',()=>browserAction(browser=>browser.status()));
 handle('requestBrowserAccess',async()=>{
  if(accountTask||shutdownTask||runtime.jobs.some(j=>j.status==='running'))throw new Error('Дождитесь завершения текущего действия.');
  const choice=await dialog.showMessageBox(window,{type:'question',title:'Управление Chrome',message:'Разрешить Flow Studio управлять интерфейсом Chrome?',detail:'macOS попросит доступ в разделе «Конфиденциальность и безопасность → Универсальный доступ». Он позволит приложению читать элементы окна Chrome, заполнять запрос и нажимать кнопки. Пароли и проверки Google выполняете вы. Генерация сейчас не запускается.',buttons:['Отмена','Открыть запрос macOS'],defaultId:0,cancelId:0,noLink:true});
  if(choice.response===1)await nativeBrowser().requestPermission();
  return nativeBrowser().status();
 });
 handle('requestBrowserScreenAccess',async()=>{
  if(accountTask||shutdownTask||runtime.jobs.some(j=>j.status==='running'))throw new Error('Дождитесь завершения текущего действия.');
  const choice=await dialog.showMessageBox(window,{type:'question',title:'Чтение выбранной модели',message:'Разрешить Flow Studio читать подпись выбранной модели на экране?',detail:'Flow не раскрывает название выбранной модели через универсальный доступ. Помощник распознает только область кнопки модели в окне Chrome. Снимок только этой области обрабатывается на Mac во временном закрытом файле и сразу удаляется. macOS может запросить разрешение на запись экрана.',buttons:['Отмена','Запросить разрешение macOS'],defaultId:0,cancelId:0,noLink:true});
  if(choice.response!==1)return nativeBrowser().status();
  await nativeBrowser().requestScreenPermission();return nativeBrowser().status();
 });
 const inspectBrowser=id=>accountAction(async()=>{
  if(!Number.isSafeInteger(id)||id<=0||runtime.jobs.some(j=>j.status==='running'))throw new Error('Выберите аккаунт после завершения генерации.');
  const account=(await runtime.refreshAccounts()).find(a=>a.id===id&&a.isActive);
  if(!account)throw new Error('Выбранный аккаунт отключён или удалён.');
  await handoffChrome();
  const result=await browserAction(browser=>browser.inspect(id,{expectedEmail:account.email}));
  return {...result,message:result.accountMatch?'Аккаунт подтверждён. Интерфейс прочитан; генерация не запускалась.':'Окно прочитано, аккаунт или редактор не подтверждён. Генерация не запускалась.'};
 });
 handle('inspectBrowser',inspectBrowser);
 const nativeImages=value=>{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>7)throw new Error('Поддерживается до семи изображений PNG, JPEG, WEBP или GIF.');
  return value.map((image,index)=>{
   if(!image||typeof image!=='object'||Array.isArray(image)||Object.keys(image).some(key=>!['dataUrl','name'].includes(key))||typeof image.name!=='string'||!image.name||image.name.length>256||path.basename(image.name)!==image.name||image.name.includes('\0')||typeof image.dataUrl!=='string'||image.dataUrl.length>28*1024*1024)throw new Error('Некорректное изображение-референс.');
   const match=/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
   if(!match)throw new Error('Нужен PNG, JPEG, WEBP или GIF в формате base64.');
   const bytes=Buffer.from(match[2],'base64');
   if(!bytes.length||bytes.length>20*1024*1024||bytes.toString('base64')!==match[2])throw new Error('Изображение должно быть корректным base64 размером до 20 МБ.');
   const valid=match[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):match[1]==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:match[1]==='webp'?bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP':['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6));
   if(!valid)throw new Error('Содержимое изображения не совпадает с форматом.');
   const sha256=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
   return {bytes,originalName:image.name,name:'ref-'+sha256.slice(0,16)+'-'+index+'-'+require('node:crypto').randomUUID().slice(0,8)+'.'+(match[1]==='jpeg'?'jpg':match[1]),sha256};
  });
 };
 const releasePrepared=async current=>{try{if(current.plan)await nativeBrowser().release(current.plan.lease,{close:false});}finally{if(current.inputFolder)await fs.rm(current.inputFolder,{recursive:true,force:true});}};
 const prepareNativeBrowser=async input=>{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['accountId','model','prompt','images'].includes(k))||!Number.isSafeInteger(input.accountId)||input.accountId<=0||runtime.jobs.some(j=>j.status==='running'))throw new Error('Выберите аккаунт и завершите текущую генерацию.');
  const images=nativeImages(input.images);
  if(preparedBrowser){const prior=preparedBrowser;preparedBrowser=null;runtime.nativeBrowserPending=false;await releasePrepared(prior);}
  const account=(await runtime.refreshAccounts()).find(a=>a.id===input.accountId&&a.isActive);
  if(!account)throw new Error('Выбранный аккаунт отключён или удалён.');
  let inputFolder,result;
  try{
   const staged=[];
   if(images.length){
    inputFolder=await fs.mkdtemp(path.join(dataDir,'native-inputs-'));await fs.chmod(inputFolder,0o700);
    for(const image of images){const file=path.join(inputFolder,image.name);await fs.writeFile(file,image.bytes,{mode:0o600,flag:'wx'});staged.push({path:file,name:image.name,sha256:image.sha256});}
   }
   await handoffChrome();
   result=await browserAction(browser=>browser.prepare({...input,images:staged,expectedEmail:account.email}));
   if(result.readyToSubmit!==true||images.length&&(!Array.isArray(result.images)||result.images.length!==staged.length||result.images.some((image,index)=>image.path!==staged[index].path||image.name!==staged[index].name||image.sha256!==staged[index].sha256)))throw new Error('Flow не подтвердил подготовку всех вложений.');
   const references=images.map(({originalName,sha256})=>({name:originalName,sha256}));
   const token=require('node:crypto').randomUUID();runtime.nativeBrowserPending=true;preparedBrowser={token,plan:result,inputFolder,references,accountId:account.id,accountEmail:account.email,createdAt:Date.now()};
   return {token,readyToSubmit:true,projectURL:result.projectURL,model:result.model,settings:result.settings,references,message:images.length?'Запрос подготовлен в Chrome. Вложений подтверждено: '+images.length+'. Кнопка генерации не нажималась.':'Текст и настройки подготовлены в Chrome. Кнопка генерации не нажималась.'};
  }catch(error){await releasePrepared({plan:result,inputFolder});throw error;}
 };
 handle('prepareNativeBrowser',input=>accountAction(()=>prepareNativeBrowser(input)));
 const cancelNativeBrowser=()=>accountAction(async()=>{
  const current=preparedBrowser;preparedBrowser=null;runtime.nativeBrowserPending=false;
  if(current)await releasePrepared(current);
  return {cancelled:true};
 });
 handle('cancelNativeBrowser',cancelNativeBrowser);
 const submitNativeBrowser=input=>accountAction(async()=>{
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['token'].includes(k))||typeof input.token!=='string'||input.token!==preparedBrowser?.token)throw new Error('Подготовленный запрос устарел. Подготовьте его снова без генерации.');
  const current=preparedBrowser;preparedBrowser=null;runtime.nativeBrowserPending=false;
  try{
   if(Date.now()-current.createdAt>10*60*1000)throw new Error('Подготовленный запрос устарел. Подготовьте его снова без генерации.');
   const account=(await runtime.refreshAccounts()).find(a=>a.id===current.accountId&&a.isActive&&a.email?.toLowerCase()===current.accountEmail.toLowerCase());
   if(!account)throw new Error('Исходный аккаунт изменился или отключён.');
   if(Date.parse(account.cooldownUntil)>Date.now())throw new Error('Аккаунт на паузе после ошибки. Дождитесь окончания паузы.');
   await handoffChrome();
   let persisted=false;
   const result=await browserAction(browser=>browser.submit(current.plan,{beforeSubmit:async()=>{
    if(persisted)throw new Error('Запрос уже отправлялся.');persisted=true;
    const record={version:1,accountId:current.accountId,model:current.plan.model,prompt:current.plan.prompt,projectURL:current.plan.projectURL,settings:current.plan.settings,references:current.references,submitStartedAt:new Date().toISOString(),outcome:'unknown'};
    const folder=path.join(dataDir,'native-submissions');await fs.mkdir(folder,{recursive:true,mode:0o700});
    await fs.writeFile(path.join(folder,current.token+'.json'),JSON.stringify(record),{mode:0o600,flag:'wx',flush:true});
   }}));
   return {...result,message:'Кнопка генерации нажата один раз. Проверяйте эту задачу в открытом проекте; повторной отправки нет.'};
  }finally{await releasePrepared(current);}
 });
 handle('submitNativeBrowser',submitNativeBrowser);
 handle('getProviderSettings',()=>runtime.getProviderSettings());
 handle('saveTwoCaptchaKey',key=>accountAction(()=>runtime.saveTwoCaptchaKey(key)));
 handle('generate',input=>{if(accountTask||shutdownTask||runtime.closing)throw new Error('Дождитесь завершения текущего действия.');return runtime.generate(input);});
 handle('retryGeneration',input=>{
  if(accountTask||shutdownTask||runtime.closing)throw new Error('Дождитесь завершения действия с аккаунтами.');
  if(['opening','waiting','syncing'].includes(loginState?.state))throw new Error('Сначала завершите или отмените вход в Google.');
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['jobId','requestId'].includes(key))||typeof input.jobId!=='string'||!input.jobId||input.jobId.length>128||typeof input.requestId!=='string'||!input.requestId.trim()||input.requestId.length>128)throw new Error('Неверные параметры повтора.');
  return runtime.retryGeneration({jobId:input.jobId,requestId:input.requestId});
 });
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
 handle('clearCooldown',id=>accountAction(()=>runtime.clearCooldown(id)));
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
 const agentActions=createAgentActions({runtime,accountManager,getLoginState:()=>loginState,shell,checkIsolatedInputs,accountCheck:checkAccount});
 agentBridge=await startAgentBridge({dataDir,dispatch:async(method,params)=>{
  if(shutdownTask||runtime.closing)throw new Error('Приложение закрывается.');
  if(method==='upload_rights_status'){
   if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).length)throw Object.assign(new Error('Ожидаются пустые параметры.'),{code:'INVALID_ARGUMENTS'});
   const pending=uploadRightsPending;
   return {pending:pending&&!pending.consumed&&Date.now()-pending.createdAt<10*60*1000?{token:pending.token,accountEmail:pending.accountEmail,text:pending.text,createdAt:new Date(pending.createdAt).toISOString()}:null};
  }
  if(method==='upload_rights_respond'){
   if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).length!==2||Object.keys(params).some(key=>!['token','accept'].includes(key))||typeof params.token!=='string'||!(/^[a-f0-9-]{36}$/i).test(params.token)||typeof params.accept!=='boolean')throw Object.assign(new Error('Укажите token текущего запроса и accept: true или false.'),{code:'INVALID_ARGUMENTS'});
   const pending=uploadRightsPending;
   if(!pending||pending.consumed||pending.token!==params.token||Date.now()-pending.createdAt>=10*60*1000)throw Object.assign(new Error('Запрос согласия отсутствует, устарел или уже использован.'),{code:'UPLOAD_RIGHTS_NOT_PENDING'});
   pending.consumed=true;pending.respond(params.accept);return {responded:true,accepted:params.accept};
  }
  if(method==='native_inspect'){
   if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).length!==1||!Object.hasOwn(params,'accountId'))throw new Error('Для проверки Chrome укажите только accountId.');
   return inspectBrowser(params.accountId);
  }
  if(method==='isolated_inspect')return accountAction(async()=>{
   if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).length!==1||!Number.isSafeInteger(params.accountId)||params.accountId<=0)throw new Error('Укажите accountId подключённого аккаунта.');
   if(runtime.jobs.some(j=>j.status==='running'))throw new Error('Дождитесь текущей генерации.');
   const account=(await runtime.refreshAccounts()).find(a=>a.id===params.accountId&&a.isActive);if(!account)throw new Error('Аккаунт недоступен.');
   return isolatedEngine.inspect(account.id,{email:account.email});
  });
  if(method==='native_prepare')return accountAction(async()=>{
   if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).some(key=>!['accountId','model','prompt','referencePaths'].includes(key))||!Number.isSafeInteger(params.accountId)||params.accountId<=0||typeof params.model!=='string'||!/^omni-1\.2-flash-([3-9]|1[0-5])s-(landscape|portrait)(-360p)?$/.test(params.model)||typeof params.prompt!=='string'||!params.prompt.trim()||params.prompt.length>20000||params.prompt.includes('\0')||!Array.isArray(params.referencePaths)||params.referencePaths.length>7||params.referencePaths.some(file=>typeof file!=='string'||!path.isAbsolute(file)||file.length>4096||/[\x00-\x1f\x7f]/.test(file)||!/\.(png|jpe?g|webp|gif)$/i.test(file)))throw new Error('Укажите аккаунт, точную модель Omni 1.2 Flash, описание и до семи абсолютных путей изображений в referencePaths.');
   const images=await importMedia(params.referencePaths,{allowVideos:false});
   if(images.some(image=>image.kind!=='image'))throw new Error('Нативная подготовка принимает только изображения.');
   return prepareNativeBrowser({accountId:params.accountId,model:params.model,prompt:params.prompt,images:images.map(({dataUrl,name})=>({dataUrl,name}))});
  });
  if(method==='native_submit'){
   if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).some(key=>!['token','confirmCreditSpend'].includes(key))||typeof params.token!=='string'||!params.token||params.token.length>128||params.confirmCreditSpend!==true)throw new Error('Для отправки подготовленного запроса нужны token и confirmCreditSpend:true.');
   return submitNativeBrowser({token:params.token});
  }
  if(method==='native_cancel'){
   if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).length)throw new Error('Отмена подготовки принимает пустой объект.');
   return cancelNativeBrowser();
  }
  return agentActions(method,params);
 }});
 if(shutdownTask||quitting){await agentBridge.close();return;}
 app.on('activate',()=>{if(!window)createWindow();else{window.show();window.focus();}});
 runtime.start().then(()=>{if(runtime.ready&&!runtime.closing)accountManager.startAutoSync();}).catch(e=>send({type:'error',message:e.message}));
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{
 if(quitting)return;
 event.preventDefault();if(shutdownTask)return;
 if(!terminationRequested&&runtime?.jobs.some(j=>j.status==='running')){
  const choice=dialog.showMessageBoxSync(window,{type:'question',message:'Генерация ещё идёт',detail:'Закрытие остановит локальный движок и ожидание результата. Задача Google может продолжиться — перед повтором проверьте её в Flow.',buttons:['Вернуться','Закрыть и остановить'],defaultId:0,cancelId:0});
  if(choice!==1)return;
 }
 shutdownErrorDialog?.abort();shutdownErrorDialog=null;
 uploadRightsPending?.respond(false);
 const accountShutdown=accountManager?.shutdown();
 shutdownTask=(async()=>{
  await accountShutdown;
  await browserTransport?.close();
  await agentBridge?.close();
  await accountTask?.catch(()=>{});
  if(preparedBrowser?.inputFolder)await fs.rm(preparedBrowser.inputFolder,{recursive:true,force:true});
  await runtime?.close();
  quitting=true;app.quit();
 })().catch(()=>{
  shutdownTask=null;
  if(window&&!window.isDestroyed())window.show();
  const controller=new AbortController();shutdownErrorDialog=controller;
  void Promise.resolve().then(()=>{
   if(controller.signal.aborted)return;
   const options={type:'error',title:'Не удалось завершить Flow Studio',message:'Не удалось остановить локальный движок или сохранить историю. Проверьте Docker и повторите выход из приложения.',buttons:['Понятно'],defaultId:0,cancelId:0,noLink:true,signal:controller.signal};
   return window&&!window.isDestroyed()?dialog.showMessageBox(window,options):dialog.showMessageBox(options);
  }).catch(()=>{}).finally(()=>{if(shutdownErrorDialog===controller)shutdownErrorDialog=null;});
 });
});
}
