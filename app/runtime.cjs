'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const crypto = require('node:crypto');
const http = require('node:http');
const {Readable} = require('node:stream');
const exec = promisify(execFile);
const BASE = 'http://127.0.0.1:38000';
const COMMAND_ENV = {...process.env, PATH:[process.env.PATH,'/opt/homebrew/bin','/usr/local/bin','/Applications/Docker.app/Contents/Resources/bin','/usr/bin','/bin','/usr/sbin','/sbin'].filter(Boolean).join(':')};
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
function publicAccount(t) {
  return {id:t.id,email:t.login_account||t.email,credits:t.credits??0,isActive:!!t.is_active,videoEnabled:t.video_enabled!==false};
}
function errorMessage(body,fallback) {
  if(typeof body==='string')return body;
  return body?.error?.message||body?.detail||body?.message||fallback;
}
async function readCredentials(databasePath,composePath) {
  const script = "import sqlite3,json,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); r=c.execute('SELECT username,password,api_key FROM admin_config WHERE id=1').fetchone(); print(json.dumps(dict(zip(('username','password','apiKey'),r)))); c.close()";
  const {stdout} = await exec('docker',['compose','-f',composePath,'exec','-T','flow2api','python','-c',script,'/app/data/flow.db'],{env:COMMAND_ENV,timeout:15000,maxBuffer:65536});
  return JSON.parse(stdout);
}
function splitSSE(buffer,onData) {
  const events=buffer.split(/\r?\n\r?\n/);
  const tail=events.pop();
  for(const event of events) {
    const data=event.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(data && data!=='[DONE]')onData(JSON.parse(data));
  }
  return tail;
}
function extractMedia(content) {
  const found=[];
  const append=(url,kind)=>{
    if(!url || found.some(x=>x.url===url))return;
    if(!/^https?:\/\//.test(url)&&!/^data:image\/(?:png|jpeg|webp|gif);base64,/.test(url))return;
    found.push({url:url.replace(/&amp;/g,'&'),kind});
  };
  for(const m of content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g))append(m[1],'image');
  for(const m of content.matchAll(/<video\b[^>]*>/gi)){
    const source=m[0].match(/\bsrc=['"]([^'"]+)['"]/i)?.[1];
    const mediaId=m[0].match(/\bdata-media-id=['"]([^'"]+)['"]/i)?.[1];
    append(source,'video');
    if(source&&mediaId&&found.length)found[found.length-1].mediaGenerationId=mediaId;
  }
  return found;
}
function allowedMediaUrl(value) {
  try {
    const url=new URL(value);
    if(url.protocol==='data:')return /^data:image\/(?:png|jpeg|webp|gif);base64,/.test(value);
    if(url.protocol==='http:')return url.origin===BASE&&url.pathname.startsWith('/tmp/');
    if(url.protocol!=='https:')return false;
    return ['google.com','googleusercontent.com','googlevideo.com','flow-content.google','gstatic.com','googleapis.com'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host));
  }catch{return false;}
}
function generationRequest(payload,apiKey,signal) {
  // Native HTTP avoids fetch's five-minute idle cutoff during long Flow jobs.
  return new Promise((resolve,reject)=>{
    const request=http.request(BASE+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+apiKey},signal},incoming=>{
      resolve(new Response(Readable.toWeb(incoming),{status:incoming.statusCode,headers:incoming.headers}));
    });
    request.on('error',reject);
    request.end(JSON.stringify(payload));
  });
}
async function consumeGeneration(response,onProgress,onAccount=()=>{}) {
  if(!response.ok){
    let body;try{body=await response.json();}catch{}
    throw new Error(errorMessage(body,'Ошибка сервера: '+response.status));
  }
  if(!response.body)throw new Error('Сервер вернул пустой ответ.');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let pending='',content='',lastProgress='',streamError=null;
  const consume=data=>{
    const account=data.flow_studio?.account;
    if(Number.isSafeInteger(account?.id)&&account.id>0&&typeof account.email==='string')onAccount({id:account.id,email:account.email});
    if(data.error){streamError=errorMessage(data,'Не удалось выполнить генерацию');return;}
    for(const choice of data.choices||[]){
      const delta=choice.delta||choice.message||{};
      const fragment=delta.reasoning_content||delta.content||'';
      if(typeof fragment==='string'&&fragment){
        if(typeof delta.content==='string')content+=delta.content;
        if(content.length>64*1024*1024)throw new Error('Ответ сервера слишком большой.');
        const text=fragment.replace(/!\[[^\]]*\]\([^)]*\)|<video[\s\S]*?<\/video>/g,'').trim();
        if(text){lastProgress=text.slice(-600);onProgress(lastProgress);}
      }
    }
  };
  try{
    while(true){
      const {done,value}=await reader.read();if(done)break;
      pending+=decoder.decode(value,{stream:true});
      pending=splitSSE(pending,consume);
      if(streamError)throw new Error(streamError);
    }
    pending+=decoder.decode();
    if(pending.trim())splitSSE(pending+'\n\n',consume);
    if(streamError)throw new Error(streamError);
    const media=extractMedia(content);
    if(!media.length)throw new Error(lastProgress||'Генерация завершилась без изображения или видео.');
    return media;
  }finally{await reader.cancel().catch(()=>{});}
}
class Runtime {
  constructor({composePath,databasePath,dataDir,onEvent=()=>{}}){
    Object.assign(this,{composePath,databasePath,dataDir,onEvent});
    this.ready=false;this.message='Запускаем Flow Studio…';this.models=[];this.accounts=[];this.jobs=[];
    this.sessionCookie='';this.startTask=null;this.aborts=new Map();this.persistTask=Promise.resolve();
  }
  status(message,ready=this.ready){this.message=message;this.ready=ready;this.onEvent({type:'status',message,ready});}
  async initializeHistory(){
    await fs.mkdir(this.dataDir,{recursive:true,mode:0o700});
    try{this.jobs=JSON.parse(await fs.readFile(path.join(this.dataDir,'history.json'),'utf8')).filter(j=>j&&typeof j.id==='string');}catch{this.jobs=[];}
    for(const job of this.jobs)if(job.status==='running'){job.status='failed';job.error='Приложение закрылось до завершения генерации.';}
    this.jobs=this.jobs.slice(0,100);
  }
  async health(){try{const r=await fetch(BASE+'/health',{signal:AbortSignal.timeout(2000)});const d=await r.json();return r.ok&&d.backend_running;}catch{return false;}}
  async login(){
    this.credentials=await readCredentials(this.databasePath,this.composePath);
    const r=await fetch(BASE+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:this.credentials.username,password:this.credentials.password}),signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error('Не удалось войти в локальный Flow2API. Проверьте его настройки и нажмите «Повторить».');
    const d=await r.json();this.sessionCookie=d.token;
    if(!this.sessionCookie)throw new Error('Flow2API не вернул сессию.');
  }
  async request(endpoint,{method='GET',body,retry=true,signal}={}){
    if(!this.sessionCookie)await this.login();
    let r=await fetch(BASE+endpoint,{method,headers:{'Content-Type':'application/json','Authorization':'Bearer '+this.sessionCookie},body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)});
    let d;try{d=await r.json();}catch{throw new Error('Локальный сервер вернул неверный ответ.');}
    if(r.status===401&&retry&&!String(d?.detail||'').includes('Google Flow')){await this.login();return this.request(endpoint,{method,body,retry:false,signal});}
    if(!r.ok)throw new Error(String(errorMessage(d,'Ошибка сервера: '+r.status)));
    return d;
  }
  async start(){
    if(this.ready&&await this.health())return this.snapshot();
    if(this.startTask)return this.startTask;
    this.startTask=this._start().finally(()=>{this.startTask=null;});
    return this.startTask;
  }
  async _start(){
    this.status('Подключаем локальный движок…',false);
    try{
      if(!await this.health()){
        try{await exec('docker',['info','--format','{{.ServerVersion}}'],{env:COMMAND_ENV,timeout:10000});}
        catch{
          this.status('Запускаем локальный движок…',false);
          try{await exec('colima',['start'],{env:COMMAND_ENV,timeout:240000,maxBuffer:4*1024*1024});}
          catch{throw new Error('Запустите Docker Desktop или установите и запустите Colima с Docker CLI. Затем нажмите «Повторить».');}
        }
        this.status('Подготавливаем генератор. Первый запуск скачивает зависимости и может занять 10–20 минут…',false);
        await exec('docker',['compose','-f',this.composePath,'up','-d','--build'],{env:COMMAND_ENV,timeout:1800000,maxBuffer:16*1024*1024});
        let healthy=false;
        for(let i=0;i<60;i++){if(await this.health()){healthy=true;break;}await delay(1000);}
        if(!healthy)throw new Error('Генератор не запустился. Нажмите «Повторить» через минуту.');
      }
      // Do not attach a different locally running backend or its accounts.
      try{await exec('docker',['compose','-f',this.composePath,'exec','-T','flow2api','python','-c','import sys; sys.exit(0)'],{env:COMMAND_ENV,timeout:15000});}
      catch{throw new Error('Порт 38000 занят другим сервером. Остановите его и нажмите «Повторить».');}
      await this.login();
      const r=await fetch(BASE+'/v1/models',{headers:{Authorization:'Bearer '+this.credentials.apiKey},signal:AbortSignal.timeout(10000)});
      if(!r.ok)throw new Error('Не удалось загрузить модели.');
      this.models=(await r.json()).data.map(m=>({id:m.id,description:m.description||m.id}));
      await this.refreshAccounts();
      this.status('Готово',true);
    }catch(e){this.status(e.message?.includes('Command failed')?'Не удалось запустить локальный движок. Проверьте, что Colima и Docker установлены, и нажмите «Повторить».':e.message,false);}
    return this.snapshot();
  }
  snapshot(){return {ready:this.ready,message:this.message,models:this.models,accounts:this.accounts,history:this.publicJobs()};}
  publicJobs(){return this.jobs.map(j=>this.publicJob(j));}
  publicJob(job){return {...job,media:(job.media||[]).map((m,i)=>({...m,url:m.path?'flow-media://'+job.id+'/'+i:m.url}))};}
  async refreshAccounts(){
    const rows=await this.request('/api/tokens');
    this.accounts=rows.map(publicAccount);this.onEvent({type:'accounts',accounts:this.accounts});return this.accounts;
  }
  async checkAccount(accountId,{signal}={}){
    if(!Number.isSafeInteger(accountId)||accountId<=0)throw new Error('Аккаунт не найден.');
    const before=(await this.refreshAccounts()).find(a=>a.id===accountId);
    if(!before)throw new Error('Аккаунт не найден.');
    const result=await this.request('/api/tokens/'+accountId+'/check-session',{method:'POST',signal});
    if(result.ok!==true||result.accountId!==accountId||typeof result.email!=='string'||result.email.toLowerCase()!==before.email.toLowerCase())throw new Error('Аккаунт изменился. Выберите аккаунт заново.');
    const after=(await this.refreshAccounts()).find(a=>a.id===accountId);
    if(!after||after.email.toLowerCase()!==before.email.toLowerCase())throw new Error('Аккаунт изменился. Выберите аккаунт заново.');
    return {...result,checkedAt:new Date().toISOString(),message:'Подключение проверено'};
  }
  async syncAccount({email,cookies,expectedAccountId,signal}){
    if(!this.ready)await this.start();
    if(!this.ready)throw new Error(this.message);
    if(expectedAccountId!=null){
      const target=(await this.refreshAccounts()).find(a=>a.id===expectedAccountId);
      if(!target||target.email.toLowerCase()!==email.toLowerCase())throw new Error('Войдите в тот Google-аккаунт, который выбран для переподключения.');
    }
    let cfg=(await this.request('/api/plugin/config')).config;
    if(!cfg.connection_token){await this.request('/api/plugin/config',{method:'POST',body:{connection_token:'',auto_enable_on_update:true}});cfg=(await this.request('/api/plugin/config')).config;}
    signal?.throwIfAborted();
    const r=await fetch(BASE+'/api/plugin/update-token',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.connection_token},body:JSON.stringify({google_cookies:JSON.stringify(cookies),login_account:email,protocol_mode:'protocol'}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000)});
    const d=await r.json();if(!r.ok||!d.success)throw new Error(String(errorMessage(d,'Не удалось подключить аккаунт')));
    const accounts=await this.refreshAccounts();const account=accounts.find(a=>a.email.toLowerCase()===email.toLowerCase());
    if(!account)throw new Error('Сервер не подтвердил добавление аккаунта.');
    // Import success alone does not prove that the persisted session still works.
    const verified=await this.checkAccount(account.id,{signal});
    return {accountId:account.id,email:verified.email,credits:verified.credits};
  }
  async persist(){
    const save=async()=>{
      const target=path.join(this.dataDir,'history.json'),temp=target+'.tmp';
      await fs.writeFile(temp,JSON.stringify(this.jobs.slice(0,100)),{mode:0o600});await fs.rename(temp,target);
    };
    this.persistTask=this.persistTask.catch(()=>{}).then(save);
    return this.persistTask;
  }
  emitJob(job){this.onEvent({type:'job',job:this.publicJob(job)});}
  generate(input){
    if(!this.ready)throw new Error('Генератор ещё запускается.');
    if(!input||!this.models.some(m=>m.id===input.model))throw new Error('Выберите доступную модель.');
    if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>20000)throw new Error('Введите запрос длиной до 20 000 символов.');
    const images=input.images||[];
    if(!Array.isArray(images)||images.length>5||images.some(s=>typeof s!=='string'||s.length>28*1024*1024||!/^data:image\/(?:png|jpeg|webp|gif);base64,/.test(s)))throw new Error('Поддерживаются до пяти изображений PNG, JPEG, WebP или GIF, не более 20 МБ каждое.');
    const requestHash=crypto.createHash('sha256').update(JSON.stringify({model:input.model,prompt:input.prompt.trim(),images,sourceVideoId:input.sourceVideoId||''})).digest('hex');
    if(input.requestId){
      const existing=this.jobs.find(j=>j.requestId===input.requestId);
      if(existing){if(existing.requestHash!==requestHash)throw new Error('requestId уже использован с другими параметрами.');return {jobId:existing.id};}
    }
    if(this.jobs.some(j=>j.status==='running'))throw new Error('Дождитесь текущей генерации.');
    const id=crypto.randomUUID(),job={id,model:input.model,prompt:input.prompt.trim(),kind:input.model.includes('image')?'image':'video',createdAt:new Date().toISOString(),status:'running',progress:'Отправляем запрос…',media:[],...(input.requestId?{requestId:input.requestId,requestHash}:{})};
    this.jobs.unshift(job);this.emitJob(job);
    this.runJob(job,images,input.sourceVideoId).catch(()=>{});
    return {jobId:id};
  }
  async runJob(job,images,sourceVideoId){
    const start=Date.now(),controller=new AbortController();this.aborts.set(job.id,controller);
    const timer=setTimeout(()=>controller.abort(),35*60*1000);
    try{
      const content=[{type:'text',text:job.prompt},...images.map(url=>({type:'image_url',image_url:{url}}))];
      if(/(?:-|_)extend(?:-|_)/.test(job.model)){
        if(typeof sourceVideoId!=='string'||!sourceVideoId.trim())throw new Error('Укажите ID исходного видео.');
        content.push({type:'image_url',image_url:{url:'extend://'+sourceVideoId.trim().replace(/^extend:\/\//,'')}});
      }
      await this.persist();
      await this.start();
      if(!this.ready)throw new Error(this.message);
      this.credentials=await readCredentials(this.databasePath,this.composePath);
      const response=await generationRequest({model:job.model,messages:[{role:'user',content}],stream:true},this.credentials.apiKey,controller.signal);
      const media=await consumeGeneration(response,text=>{job.progress=text;this.emitJob(job);},account=>{job.accountId=account.id;job.accountEmail=account.email;this.emitJob(job);});
      job.media=media;
      for(let i=0;i<media.length;i++){
        try{media[i].path=await this.cacheMedia(job.id,i,media[i]);}catch{ /* Original URL remains usable; save can retry. */ }
      }
      job.status='succeeded';job.progress='Готово';
    }catch(e){job.status='failed';job.error=job.cancelRequested?'Ожидание отменено. Задача Google могла продолжиться; проверьте Flow перед повтором.':e.name==='AbortError'?'Время ожидания истекло. Проверьте результат в Flow перед повтором.':e.message;job.needsLogin=/rpc\s*=\s*[A-Za-z0-9]+\s*,\s*code\s*=\s*401\b|Google Flow[^\n]*авторизац|Токен AT недействителен/i.test(job.error||'');job.progress=job.error;}
    finally{
      clearTimeout(timer);this.aborts.delete(job.id);job.elapsedSeconds=Math.round((Date.now()-start)/1000);this.emitJob(job);await this.persist().catch(()=>{});await this.refreshAccounts().catch(()=>{});
    }
  }
  async cacheMedia(jobId,index,media){
    if(!allowedMediaUrl(media.url))throw new Error('Этот адрес результата не поддерживается.');
    const folder=path.join(this.dataDir,'media',jobId);await fs.mkdir(folder,{recursive:true,mode:0o700});
    const ext=media.kind==='video'?'.mp4':media.url.startsWith('data:image/jpeg')?'.jpg':'.png';
    const target=path.join(folder,String(index)+ext),tmp=target+'.part';
    let bytes=0;const handle=await fs.open(tmp,'w',0o600);
    try{
      let url=media.url,response;
      for(let redirects=0;redirects<6;redirects++){
        if(!allowedMediaUrl(url))throw new Error('Неподдерживаемый адрес результата.');
        response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(120000)});
        if(response.status>=300&&response.status<400){url=new URL(response.headers.get('location'),url).href;await response.body?.cancel();continue;}
        break;
      }
      if(!response?.ok||!response.body)throw new Error('Не удалось скачать результат.');
      for await(const chunk of response.body){bytes+=chunk.length;if(bytes>512*1024*1024)throw new Error('Файл больше 512 МБ');await handle.writeFile(chunk);}
      await handle.close();await fs.rename(tmp,target);return target;
    }catch(e){await handle.close().catch(()=>{});await fs.unlink(tmp).catch(()=>{});throw e;}
  }
  mediaFile(jobId,index){return this.jobs.find(j=>j.id===jobId)?.media?.[index]?.path||null;}
  close(){for(const controller of this.aborts.values())controller.abort();}
}
module.exports={Runtime,consumeGeneration,splitSSE,extractMedia,allowedMediaUrl,publicAccount,readCredentials};
