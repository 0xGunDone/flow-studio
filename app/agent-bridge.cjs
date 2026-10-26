'use strict';
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes,timingSafeEqual}=require('node:crypto');
const {modelInfo}=require('./renderer.js');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function capabilities(model){
 const info=modelInfo(model);
 return {id:model.id,description:info.label,kind:info.kind,mode:info.edit?'edit':info.extend?'extend':info.i2v?'frames':info.r2v||info.omni?'references':'text',minImages:info.minImages,maxImages:info.maxImages,maxVideos:info.maxVideos,maxReferences:info.maxReferences,supportsVideoReferences:info.supportsVideoReferences,requiredTier:info.requiredTier,aspectRatio:info.aspect,durationSeconds:info.seconds?Number(info.seconds):undefined,resolution:info.resolution||undefined,supportsStartFrame:info.i2v,supportsEndFrame:info.i2v&&info.maxImages>1};
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
async function readReference(file){
 if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('Путь изображения должен быть абсолютным.');
 const stat=await fs.stat(file);
 if(!stat.isFile()||stat.size>20*1024*1024)throw new Error('Изображение должно быть обычным файлом до 20 МБ.');
 const ext=path.extname(file).slice(1).toLowerCase(),mime=ext==='jpg'?'jpeg':ext;
 if(!['png','jpeg','webp','gif'].includes(mime))throw new Error('Поддерживаются PNG, JPEG, WebP и GIF.');
 return 'data:image/'+mime+';base64,'+(await fs.readFile(file)).toString('base64');
}
async function videoReference(file){
 if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))throw new Error('Путь видео должен быть абсолютным.');
 if(!/\.(mp4|mov|m4v)$/i.test(file))throw new Error('Поддерживаются MP4, MOV и M4V.');
 const stat=await fs.stat(file);
 if(!stat.isFile()||stat.size>100*1024*1024)throw new Error('Видео должно быть обычным файлом до 100 МБ.');
 return {kind:'video',path:file};
}
async function generationInput(runtime,params){
 if(params.confirmCreditSpend!==true)throw new Error('Генерация расходует кредиты. Требуется confirmCreditSpend:true для запроса пользователя.');
 if(typeof params.requestId!=='string'||!params.requestId.trim()||params.requestId.length>128)throw new Error('Укажите стабильный requestId длиной до 128 символов.');
 if(typeof params.prompt!=='string'||!params.prompt.trim()||params.prompt.length>20000)throw new Error('Введите запрос длиной до 20 000 символов.');
 const model=runtime.models.find(m=>m.id===params.model);
 if(!model)throw new Error('Модель отсутствует в текущем каталоге. Сначала вызовите list_models.');
 const info=capabilities(model),refs=params.referencePaths||[],videos=params.videoPaths||[];
 if(!Array.isArray(refs))throw new Error('referencePaths должен быть массивом путей.');
 if(!Array.isArray(videos))throw new Error('videoPaths должен быть массивом путей.');
 const hasFrames=!!(params.startFramePath||params.endFramePath);
 if((refs.length||videos.length)&&hasFrames)throw new Error('Референсы и начальный/конечный кадры нельзя смешивать.');
 if(videos.length&&!info.supportsVideoReferences)throw new Error('Видео принимает только модель Omni Редактирование.');
 if(videos.length>info.maxVideos)throw new Error('Модель принимает не больше '+info.maxVideos+' видео.');
 if(info.mode==='edit'&&videos.length!==1)throw new Error('Для редактирования укажите одно исходное видео в videoPaths.');
 if(info.mode==='frames'){
  if(refs.length||!params.startFramePath)throw new Error('Для этой модели укажите startFramePath и при необходимости endFramePath.');
 }else if(hasFrames)throw new Error('Начальный и конечный кадры поддерживают только модели I2V.');
 if(params.endFramePath&&!params.startFramePath)throw new Error('Конечный кадр требует начального.');
 if(info.mode==='extend'){
  if(refs.length||videos.length||hasFrames||typeof params.sourceVideoId!=='string'||!params.sourceVideoId.trim())throw new Error('Продление требует sourceVideoId и не принимает референсы.');
 }else if(params.sourceVideoId)throw new Error('sourceVideoId предназначен для моделей продления.');
 const files=hasFrames?[params.startFramePath,...(params.endFramePath?[params.endFramePath]:[])]:refs;
 if(files.length<info.minImages||files.length>info.maxImages)throw new Error('Модель принимает от '+info.minImages+' до '+info.maxImages+' изображений.');
 const images=await Promise.all(files.map(readReference));
 const inputs=videos.length?{references:[...images.map(dataUrl=>({kind:'image',dataUrl})),...await Promise.all(videos.map(videoReference))]}:{images};
 return {model:params.model,prompt:params.prompt,...inputs,sourceVideoId:params.sourceVideoId,requestId:params.requestId.trim()};
}
function createAgentActions({runtime,accountManager,getLoginState=()=>null,shell}){
 const jobById=id=>{const job=runtime.jobs.find(j=>j.id===id);if(!job)throw new Error('Задача не найдена.');return job;};
 const ready=async()=>{await runtime.start();if(!runtime.ready)throw new Error(runtime.message);};
 return async function dispatch(method,params={}){
  switch(method){
   case 'status':
    await ready();return {ready:runtime.ready,message:runtime.message,modelsCount:runtime.models.length,accounts:runtime.accounts,runningJobs:runtime.jobs.filter(j=>j.status==='running').map(j=>({id:j.id,model:j.model,progress:j.progress})),countHistory:runtime.jobs.length,login:getLoginState()};
   case 'models':{
    await ready();let models=runtime.models.map(capabilities);
    if(params.kind)models=models.filter(m=>m.kind===params.kind);
    if(params.mode)models=models.filter(m=>m.mode===params.mode);
    if(params.query){const query=String(params.query).toLowerCase();models=models.filter(m=>(m.id+' '+m.description).toLowerCase().includes(query));}
    return {models,note:'Каталог не гарантирует доступ на конкретном Google-тарифе. Ошибки доступа не переключают модель автоматически.'};
   }
   case 'generate':{
    await ready();const input=await generationInput(runtime,params);
    const {jobId}=runtime.generate(input);await runtime.persist();return {jobId,job:externalJob(jobById(jobId))};
   }
   case 'job':return externalJob(jobById(params.jobId));
   case 'wait':{
    const timeout=Math.min(30,Math.max(0,Number(params.timeoutSeconds??20)));
    if(!Number.isFinite(timeout))throw new Error('Неверное время ожидания.');
    const until=Date.now()+timeout*1000;
    while(jobById(params.jobId).status==='running'&&Date.now()<until)await delay(Math.min(300,until-Date.now()));
    const job=jobById(params.jobId);return {job:externalJob(job),done:job.status!=='running'};
   }
   case 'history':{
    const limit=Number(params.limit??20);if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('limit: 1–100');
    return {jobs:runtime.jobs.slice(0,limit).map(externalJob)};
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
    if(job.status==='running'){job.cancelRequested=true;runtime.aborts.get(job.id)?.abort();}
    return {job:externalJob(job),note:'Отмена ожидания не гарантирует отмену задачи Google или возврат кредитов. Не повторяйте автоматически.'};
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
  }catch(error){send(400,{error:{message:String(error.message||'Request failed'),code:'request_failed'}});}
 });
 server.requestTimeout=120000;server.headersTimeout=15000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const info={port:server.address().port,token,pid:process.pid,version:1};
 await fs.mkdir(dataDir,{recursive:true,mode:0o700});
 const temp=file+'.'+process.pid;await fs.writeFile(temp,JSON.stringify(info),{mode:0o600});await fs.rename(temp,file);await fs.chmod(file,0o600);
 return {port:info.port,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));try{const stored=JSON.parse(await fs.readFile(file,'utf8'));if(stored.token===token)await fs.unlink(file);}catch{}}};
}
module.exports={startAgentBridge,createAgentActions,generationInput,capabilities,externalJob};
