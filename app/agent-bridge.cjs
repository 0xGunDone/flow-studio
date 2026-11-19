'use strict';
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes,timingSafeEqual}=require('node:crypto');
const {modelSettings,PREFERRED_VIDEO_FAMILY}=require('./renderer.js');
const {supportsVeoModel}=require('./browser-video-models.cjs');
const {supportsImageModel}=require('./browser-images.cjs');
const {importMedia}=require('./input-files.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const methods=['image','text','ingredients','frames','edit','extend'];
const aliases=new Set(['veo-3.1-lite','veo-3.1-fast','veo-3.1-quality','omni-1.1-flash','omni-1.2-flash']);
const videoWatermarkModes=['with','without'];
const videoWatermarkDefault='with';
const fileLimits={image:{maxBytes:20*1024*1024,extensions:['png','jpg','jpeg','webp','gif']},video:{maxBytes:100*1024*1024,maxDurationSeconds:10,extensions:['mp4','mov','m4v']}};
const failure=(message,code='INVALID_ARGUMENTS')=>Object.assign(new Error(message),{code});
function capabilities(model){
 const settings=modelSettings(model),info=settings.info,inputsByMethod={};
 for(const method of settings.methods){
  const minImages=method==='ingredients'?Math.max(1,info.minImages):['image','frames','edit'].includes(method)?info.minImages:0;
  const maxImages=['image','ingredients','frames','edit'].includes(method)?info.maxImages:0;
  const minVideos=method==='edit'?1:0,maxVideos=method==='edit'?info.maxVideos:0;
  inputsByMethod[method]={minImages,maxImages,minVideos,maxVideos,minReferences:minImages+minVideos,maxReferences:maxImages+maxVideos,supportsStartFrame:method==='frames',supportsEndFrame:method==='frames'&&maxImages>1,requiresSourceVideoId:method==='extend'};
 }
 const generationEngine=model.id==='omni-1.2-flash'||/^omni-1\.2-flash-(?:(?:i2v-)?(?:[3-9]|1[0-5])s-|edit-)(?:landscape|portrait)(?:-360p)?$/.test(model.id)||supportsVeoModel({model:model.id})||supportsImageModel({model:model.id})?'isolated-browser':'server';
 return {id:model.id,description:info.label,kind:info.kind,generationEngine,...(info.kind==='video'?{visibleWatermarkPolicy:'selectable',visibleWatermarkVerification:generationEngine==='isolated-browser'?'supported':'unsupported'}:{}),mode:info.edit?'edit':info.extend?'extend':info.i2v?'frames':info.r2v||info.omni?'references':'text',minImages:info.minImages,maxImages:info.maxImages,maxVideos:info.maxVideos,maxReferences:info.maxReferences,supportsVideoReferences:info.supportsVideoReferences,requiredTier:info.requiredTier,aspectRatio:settings.aspect,durationSeconds:info.kind==='video'&&!info.edit?Number(settings.duration):undefined,resolution:settings.resolution,supportsStartFrame:info.i2v,supportsEndFrame:info.i2v&&info.maxImages>1,family:settings.family,preferred:settings.family===PREFERRED_VIDEO_FAMILY,methods:settings.methods,durationSource:info.edit?'input_video':'model',inputsByMethod,fileLimits:{...fileLimits,video:{...fileLimits.video,maxDurationSeconds:info.maxInputDuration||10}}};
}
function externalJob(job){
 const {requestHash,...result}=job;
 return {...result,media:(job.media||[]).map(m=>{
   let mediaGenerationId=m.mediaGenerationId;
   if(!mediaGenerationId&&m.kind==='video'){
     try{const u=new URL(m.url);if(u.hostname==='flow-content.google')mediaGenerationId=u.pathname.match(/^\/video\/([0-9a-f-]{36})$/i)?.[1];}catch{}
   }
   return {...m,localPath:m.path||null,...(mediaGenerationId?{mediaGenerationId}:{})};
 })};
}
function selection(runtime,params){
 const hasModel=params.model!==undefined,hasSettings=params.settings!==undefined;
 if(hasModel===hasSettings)throw failure('Укажите ровно одно поле: model или settings.');
 let model,method;
 if(hasSettings){
  if(params.method!==undefined)throw failure('При settings укажите method только внутри settings.');
  const settings=params.settings;
  if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(key=>!['kind','method','family','durationSeconds','aspectRatio','resolution'].includes(key)))throw failure('Неверные поля settings.');
  if(!['image','video'].includes(settings.kind)||!methods.includes(settings.method)||typeof settings.family!=='string'||!settings.family.trim()||typeof settings.aspectRatio!=='string'||!settings.aspectRatio.trim()||settings.resolution!==undefined&&(typeof settings.resolution!=='string'||!settings.resolution.trim()))throw failure('Укажите точные kind, method, family и aspectRatio из list_models.');
  if(settings.kind==='image'&&settings.method!=='image'||settings.kind==='video'&&settings.method==='image')throw failure('Метод не соответствует kind.');
  if(settings.kind==='image'||settings.method==='edit'){
   if(settings.durationSeconds!==undefined)throw failure('Изображение и редактирование видео не принимают durationSeconds.');
  }else if(!Number.isInteger(settings.durationSeconds)||settings.durationSeconds<=0)throw failure('Для видео укажите durationSeconds из list_models.');
  let candidates=runtime.models.filter(item=>{
   const info=capabilities(item);
   return info.kind===settings.kind&&info.methods.includes(settings.method)&&info.family===settings.family&&info.aspectRatio===settings.aspectRatio&&info.resolution===(settings.resolution??'standard')&&info.durationSeconds===settings.durationSeconds;
  });
  candidates=candidates.filter(item=>!aliases.has(item.id)||!candidates.some(other=>other.id===item.id+'-8s-landscape'));
  if(!candidates.length)throw failure('Такое сочетание settings отсутствует в текущем каталоге. Сначала вызовите list_models.','MODEL_SELECTION_UNAVAILABLE');
  if(candidates.length>1)throw failure('Неоднозначные settings: '+candidates.map(item=>item.id).join(', ')+'. Укажите точный model.','MODEL_SELECTION_AMBIGUOUS');
  model=candidates[0];method=settings.method;
 }else{
  model=runtime.models.find(item=>item.id===params.model);
  if(!model)throw failure('Модель отсутствует в текущем каталоге. Сначала вызовите list_models.','MODEL_SELECTION_UNAVAILABLE');
  const available=modelSettings(model).methods;
  method=params.method===undefined?(available.length===1?available[0]:params.referencePaths?.length?'ingredients':'text'):params.method;
  if(!available.includes(method))throw failure('Модель не поддерживает метод '+String(method)+'.');
 }
 const info=capabilities(model),settings={kind:info.kind,method,family:info.family,aspectRatio:info.aspectRatio,resolution:info.resolution,...(info.durationSeconds!==undefined?{durationSeconds:info.durationSeconds}:{})};
 return {model,method,info,settings};
}
async function validatedInput(runtime,params){
 if(!params||typeof params!=='object'||Array.isArray(params))throw new Error('Параметры должны быть объектом.');
 if(Object.hasOwn(params,'accountId')&&(!Number.isSafeInteger(params.accountId)||params.accountId<=0))throw failure('accountId должен быть положительным целым числом.');
 if(typeof params.prompt!=='string'||!params.prompt.trim()||params.prompt.length>20000)throw new Error('Введите запрос длиной до 20 000 символов.');
 const {model,method,info,settings}=selection(runtime,params),refs=params.referencePaths??[],videos=params.videoPaths??[];
 const {videoWatermark}=params;
 if(videoWatermark!==undefined){
  if(!videoWatermarkModes.includes(videoWatermark))throw failure('Для videoWatermark укажите with или without.');
  if(info.kind!=='video')throw failure('videoWatermark доступен только для видео.');
 }
 const watermark=info.kind==='video'?{videoWatermark:videoWatermark??videoWatermarkDefault}:{};
 if(!Array.isArray(refs))throw new Error('referencePaths должен быть массивом путей.');
 if(!Array.isArray(videos))throw new Error('videoPaths должен быть массивом путей.');
 const hasReferences=params.referencePaths!==undefined||params.videoPaths!==undefined,hasFrames=params.startFramePath!==undefined||params.endFramePath!==undefined,hasSource=params.sourceVideoId!==undefined;
 if(Number(hasReferences)+Number(hasFrames)+Number(hasSource)>1)throw new Error('Референсы, начальный/конечный кадры и sourceVideoId нельзя смешивать.');
 if(videos.length&&method!=='edit')throw new Error('Видео принимает только модель Omni Редактирование.');
 if(videos.length>info.maxVideos)throw new Error('Модель принимает не больше '+info.maxVideos+' видео.');
 if(method==='edit'&&videos.length!==1)throw new Error('Для редактирования укажите одно исходное видео в videoPaths.');
 if(method==='frames'){
  if(!params.startFramePath)throw new Error('Для этой модели укажите startFramePath и при необходимости endFramePath.');
 }else if(hasFrames)throw new Error('Начальный и конечный кадры поддерживают только модели I2V.');
 if(params.endFramePath&&!params.startFramePath)throw new Error('Конечный кадр требует начального.');
 if(method==='extend'){
  if(typeof params.sourceVideoId!=='string'||!params.sourceVideoId.trim())throw new Error('Продление требует sourceVideoId и не принимает референсы.');
 }else if(hasSource)throw new Error('sourceVideoId предназначен для моделей продления.');
 if(method==='text'&&hasReferences)throw new Error('Метод text не принимает референсы. Выберите ingredients.');
 const files=hasFrames?[params.startFramePath,...(params.endFramePath?[params.endFramePath]:[])]:refs;
 const limits=info.inputsByMethod[method];
 if(files.length<limits.minImages||files.length>limits.maxImages)throw new Error('Модель принимает от '+limits.minImages+' до '+limits.maxImages+' изображений для метода '+method+'.');
 const media=await importMedia([...files,...videos],{allowVideos:method==='edit'});
 if(media.slice(0,files.length).some(item=>item.kind!=='image')||media.slice(files.length).some(item=>item.kind!=='video'))throw new Error('referencePaths и кадры принимают изображения; videoPaths принимает видео MP4, MOV и M4V.');
 const images=media.slice(0,files.length).map(item=>item.dataUrl);
 const inputs=videos.length?{references:[...images.map(dataUrl=>({kind:'image',dataUrl})),...videos.map(file=>({kind:'video',path:file}))]}:{images};
 const generateArguments={model:model.id,method,prompt:params.prompt,...watermark};
 for(const key of ['accountId','referencePaths','videoPaths','startFramePath','endFramePath','sourceVideoId'])if(params[key]!==undefined)generateArguments[key]=params[key];
 return {input:{model:model.id,prompt:params.prompt,...inputs,sourceVideoId:params.sourceVideoId,...(params.accountId!==undefined?{accountId:params.accountId}:{}),...(videoWatermark!==undefined?{videoWatermark}:{})},preview:{valid:true,model:info,method,settings,...watermark,inputs:{images:files.length,videos:videos.length,references:hasFrames?0:refs.length+videos.length,startFrame:params.startFramePath!==undefined,endFrame:params.endFramePath!==undefined,sourceVideo:hasSource},generateArguments,checks:{localFiles:'passed',videoDuration:videos.length?'checked_at_submission':'not_applicable',accountAccess:'not_checked',credits:'not_checked',visibleWatermark:info.kind==='video'?'not_checked':'not_applicable'}}};
}
async function generationInput(runtime,params){
 if(params&&Object.hasOwn(params,'checkBrowser'))throw failure('checkBrowser доступен только для подготовки.');
 if(params?.confirmCreditSpend!==true)throw new Error('Генерация расходует кредиты. Требуется confirmCreditSpend:true для запроса пользователя.');
 if(typeof params.requestId!=='string'||!params.requestId.trim()||params.requestId.length>128)throw new Error('Укажите стабильный requestId длиной до 128 символов.');
 const {input}=await validatedInput(runtime,params);
 return {...input,requestId:params.requestId.trim()};
}
function createAgentActions({runtime,accountManager,getLoginState=()=>null,shell,checkIsolatedInputs,accountCheck=id=>runtime.checkAccount(id)}){
 const jobById=id=>{const job=runtime.jobs.find(j=>j.id===id);if(!job)throw new Error('Задача не найдена.');return job;};
 const serializeJob=job=>{
  const publicJob=runtime.publicJob?.(job),derived={};
  for(const key of ['retryAvailable','retryBlockedReason','recoveryAvailable','recoveryBlockedReason'])if(publicJob&&Object.hasOwn(publicJob,key))derived[key]=publicJob[key];
  return externalJob({...job,...derived});
 };
 const ready=async()=>{await runtime.start();if(!runtime.ready)throw new Error(runtime.message);};
 return async function dispatch(method,params={}){
  switch(method){
   case 'status':
    await ready();return {ready:runtime.ready,message:runtime.message,modelsCount:runtime.models.length,accounts:runtime.accounts,runningJobs:runtime.jobs.filter(j=>j.status==='running').map(j=>({id:j.id,model:j.model,progress:j.progress,...(j.generationEngine?{generationEngine:j.generationEngine}:{})})),countHistory:runtime.jobs.length,login:getLoginState(),apiVersion:3,videoWatermarkPolicy:'selectable',videoWatermarkDefault,videoWatermarkModes,features:['generation-settings','prepare-generation','explicit-methods','isolated-browser-generation','video-watermark-selection']};
   case 'models':{
    await ready();let models=runtime.models.map(capabilities);
    if(params.kind)models=models.filter(m=>m.kind===params.kind);
    if(params.mode)models=models.filter(m=>m.mode===params.mode);
    if(params.method)models=models.filter(m=>m.methods.includes(params.method));
    for(const key of ['family','durationSeconds','aspectRatio','resolution'])if(params[key]!==undefined)models=models.filter(m=>m[key]===params[key]);
    if(params.query){const query=String(params.query).toLowerCase();models=models.filter(m=>(m.id+' '+m.description).toLowerCase().includes(query));}
    return {models,note:'Каталог не гарантирует доступ на конкретном Google-тарифе. Ошибки доступа не переключают модель автоматически.'};
   }
   case 'prepare':{
    if(!params||typeof params!=='object'||Array.isArray(params))throw failure('Параметры должны быть объектом.');
    const {checkBrowser,...localParams}=params;
    if(checkBrowser!==undefined&&typeof checkBrowser!=='boolean')throw failure('checkBrowser должен быть true или false.');
    if(checkBrowser===true&&(!Number.isSafeInteger(localParams.accountId)||localParams.accountId<=0))throw failure('Проверка браузера требует явный accountId.');
    await ready();const {input,preview}=await validatedInput(runtime,localParams);
    if(checkBrowser!==true)return preview;
    if(preview.model.generationEngine!=='isolated-browser')throw failure('Проверка браузера поддерживает доступные режимы Nano Banana, Omni 1.2 Flash и Veo 3.1 из текущего каталога.','BROWSER_MODEL_UNSUPPORTED');
    if(typeof checkIsolatedInputs!=='function')throw failure('Проверка фонового браузера недоступна. Обновите приложение.','BROWSER_CHECK_UNAVAILABLE');
    const {videoWatermark}=preview;
    const checked=await checkIsolatedInputs({model:input.model,prompt:input.prompt,accountId:input.accountId,references:input.references||(input.images||[]).map(dataUrl=>({kind:'image',dataUrl})),...(videoWatermark?{videoWatermark}:{})});
    if(checked?.ready!==true||checked.accountId!==input.accountId||checked.cleared!==true||checked.submitted!==false||checked.uploadedImages!==preview.inputs.images||checked.model!==undefined&&checked.model!==input.model||checked.uploadedVideos!==undefined&&checked.uploadedVideos!==preview.inputs.videos)throw failure('Браузер не подтвердил проверку и очистку подготовленного запроса.','BROWSER_CHECK_UNCONFIRMED');
    const browserCheck=Object.fromEntries(['ready','accountId','accountEmail','projectURL','model','referenceCount','uploadedImages','submitted','cleared'].filter(key=>Object.hasOwn(checked,key)).map(key=>[key,checked[key]]));
    if(videoWatermark){
     const expected=videoWatermark==='with'?'on':'off';
     if(checked.visibleWatermark!==expected)throw failure('Браузер не подтвердил настройку Visible watermarking: '+expected+'.','VISIBLE_WATERMARK_UNVERIFIED');
     browserCheck.visibleWatermark=checked.visibleWatermark;
    }
    if(typeof checked.email==='string'&&!browserCheck.accountEmail)browserCheck.accountEmail=checked.email;
    browserCheck.uploadedVideos=preview.inputs.videos;
    return {...preview,checks:{...preview.checks,visibleWatermark:browserCheck.visibleWatermark??preview.checks.visibleWatermark,browser:'passed',upload:preview.inputs.images||preview.inputs.videos?'passed':'not_applicable'},browserCheck};
   }
   case 'generate':{
    await ready();const input=await generationInput(runtime,params);
    const {jobId}=runtime.generate(input);await runtime.persist();return {jobId,job:serializeJob(jobById(jobId))};
   }
   case 'job':return serializeJob(jobById(params.jobId));
   case 'recover':{
    if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).length!==1||typeof params.jobId!=='string'||!params.jobId||params.jobId.length>128)throw failure('Для проверки результата укажите только jobId.');
    await ready();const result=runtime.recoverGeneration(params.jobId);await runtime.persist();return {...result,job:serializeJob(jobById(result.jobId))};
   }
   case 'wait':{
    const timeout=Math.min(30,Math.max(0,Number(params.timeoutSeconds??20)));
    if(!Number.isFinite(timeout))throw new Error('Неверное время ожидания.');
    const until=Date.now()+timeout*1000;
    while(jobById(params.jobId).status==='running'&&Date.now()<until)await delay(Math.min(300,until-Date.now()));
    const job=jobById(params.jobId);return {job:serializeJob(job),done:job.status!=='running'};
   }
   case 'history':{
    const limit=Number(params.limit??20);if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('limit: 1–100');
    return {jobs:runtime.jobs.slice(0,limit).map(serializeJob)};
   }
   case 'save':{
    const job=jobById(params.jobId),index=params.index??0,media=job.media?.[index];
    if(!Number.isInteger(index)||index<0||!media)throw new Error('Результат не найден.');
    if(typeof params.outputPath!=='string'||!path.isAbsolute(params.outputPath))throw new Error('Нужен абсолютный outputPath.');
    if(!media.path){media.path=await runtime.cacheMedia(job.id,index,media);await runtime.persist();}
    const parent=await fs.stat(path.dirname(params.outputPath));if(!parent.isDirectory())throw new Error('Папка назначения не существует.');
    const destination=path.resolve(params.outputPath);
    if(destination!==path.resolve(media.path))await fs.copyFile(media.path,destination,params.overwrite===true?0:fs.constants.COPYFILE_EXCL);
    media.savedPath=destination;await runtime.persist();runtime.emitJob(job);return {path:destination};
   }
   case 'open_folder':{
    const job=jobById(params.jobId),index=params.index??0,media=job.media?.[index];
    if(!Number.isInteger(index)||!media)throw new Error('Результат не найден.');
    const file=media.savedPath||media.path;if(!file)throw new Error('Результат ещё не сохранён локально.');
    await fs.access(file);shell.showItemInFolder(file);return {opened:true,path:file};
   }
   case 'accounts':await ready();return {accounts:await runtime.refreshAccounts()};
   case 'set_account_active':
   case 'check_account':{
    const set=method==='set_account_active',allowed=set?['accountId','enabled']:['accountId'];
    if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).length!==allowed.length||Object.keys(params).some(key=>!allowed.includes(key))||!Number.isSafeInteger(params.accountId)||params.accountId<=0||set&&typeof params.enabled!=='boolean')throw failure('Укажите точный accountId'+(set?' и enabled: true или false.':'.'));
    await ready();
    if(runtime.accountActionPending||runtime.accountCheckTask||runtime.retryTask||runtime.jobs.some(job=>job.status==='running'))throw new Error('Дождитесь завершения текущей генерации или действия с аккаунтами.');
    runtime.accountActionPending=true;
    try{return set?await runtime.setAccountActive(params.accountId,params.enabled):await accountCheck(params.accountId);}finally{runtime.accountActionPending=false;}
   }
   case 'check_enabled_accounts':{
    if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).length)throw failure('Проверка включенных аккаунтов принимает пустой объект.');
    await ready();
    if(runtime.accountActionPending||runtime.accountCheckTask||runtime.retryTask||runtime.jobs.some(job=>job.status==='running'))throw new Error('Дождитесь завершения текущей генерации или действия с аккаунтами.');
    runtime.accountActionPending=true;
    try{return await runtime.checkEnabledAccounts({checkAccount:accountCheck});}finally{runtime.accountActionPending=false;}
   }
   case 'reset_cooldown':{
    if(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).length!==1||!Number.isSafeInteger(params.accountId)||params.accountId<=0)throw failure('Укажите только положительный целый accountId.');
    await ready();
    if(runtime.accountActionPending||runtime.accountCheckTask||runtime.retryTask||runtime.jobs.some(job=>job.status==='running'))throw new Error('Дождитесь завершения текущей генерации или действия с аккаунтами.');
    runtime.accountActionPending=true;
    try{return {...await runtime.clearCooldown(params.accountId),note:'Снята только локальная пауза аккаунта. Ограничения Google не изменены; генерация автоматически не запускается.'};}finally{runtime.accountActionPending=false;}
   }
   case 'login_start':
    await ready();
    if(params.accountId!=null){
     if(!runtime.accounts.some(a=>a.id===params.accountId))throw new Error('Аккаунт не найден.');
     return accountManager.reconnectAccount(params.accountId);
    }return accountManager.addAccount();
   case 'login_complete':return accountManager.completeLogin();
   case 'login_cancel':return accountManager.cancelLogin();
   case 'cancel':{
    const job=jobById(params.jobId);
    runtime.cancelGeneration(job.id);
    return {job:serializeJob(job),note:'Отмена ожидания не гарантирует отмену задачи Google или возврат кредитов. Не повторяйте автоматически.'};
   }
   default:throw new Error('Неизвестная операция Flow Studio.');
  }
 };
}
async function startAgentBridge({dataDir,dispatch}){
 const token=randomBytes(32).toString('hex'),file=path.join(dataDir,'agent-bridge.json');
 const authorize=value=>{
  const expected='Bearer '+token;
  return typeof value==='string'&&Buffer.byteLength(value)===Buffer.byteLength(expected)&&timingSafeEqual(Buffer.from(value),Buffer.from(expected));
 };
 const server=http.createServer(async(req,res)=>{
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(req.headers.origin||!/^127\.0\.0\.1:\d+$/.test(req.headers.host||''))return send(403,{error:{message:'Invalid local origin'}});
  if(!authorize(req.headers.authorization))return send(401,{error:{message:'Unauthorized'}});
  if(req.method==='GET'&&req.url==='/health')return send(200,{ready:true,version:1});
  if(req.method!=='POST'||req.url!=='/rpc')return send(404,{error:{message:'Not found'}});
  try{
   let raw='',bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>512*1024)throw new Error('Request too large');raw+=chunk;}
   const data=JSON.parse(raw);
   if(!data||typeof data.method!=='string'||data.params!=null&&(typeof data.params!=='object'||Array.isArray(data.params)))throw new Error('Invalid RPC request');
   const result=await dispatch(data.method,data.params||{});send(200,{result});
  }catch(error){send(400,{error:{message:String(error.message||'Request failed'),code:error.code||'request_failed'}});}
 });
 server.requestTimeout=120000;server.headersTimeout=15000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const info={port:server.address().port,token,pid:process.pid,version:1};
 await fs.mkdir(dataDir,{recursive:true,mode:0o700});
 const temp=file+'.'+process.pid;await fs.writeFile(temp,JSON.stringify(info),{mode:0o600});await fs.rename(temp,file);await fs.chmod(file,0o600);
 return {port:info.port,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));try{const stored=JSON.parse(await fs.readFile(file,'utf8'));if(stored.token===token)await fs.unlink(file);}catch{}}};
}
module.exports={startAgentBridge,createAgentActions,generationInput,capabilities,externalJob};
