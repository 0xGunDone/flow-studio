'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const crypto = require('node:crypto');
const http = require('node:http');
const {Readable} = require('node:stream');
const {modelInfo}=require('./renderer.js');
const {stageVideo}=require('./input-files.cjs');
const exec = promisify(execFile);
const BASE = 'http://127.0.0.1:38000';
const COMMAND_ENV = {...process.env, PATH:[process.env.PATH,'/opt/homebrew/bin','/usr/local/bin','/Applications/Docker.app/Contents/Resources/bin','/usr/bin','/bin','/usr/sbin','/sbin'].filter(Boolean).join(':')};
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
function publicAccount(t) {
  const account={id:t.id,email:t.login_account||t.email,credits:t.credits??0,isActive:!!t.is_active,serverActive:!!t.is_active,manualDisabled:t.ban_reason==='manual_disabled',videoEnabled:t.video_enabled!==false};
  const fields={generation_cooldown_until:'cooldownUntil',generation_last_error:'lastGenerationError',generation_last_error_at:'lastGenerationErrorAt',generation_cooldown_remaining_seconds:'cooldownRemainingSeconds',generation_cooldown_reset_allowed:'cooldownResetAllowed'};
  for(const [source,target] of Object.entries(fields))if(Object.hasOwn(t,source))account[target]=t[source];
  return account;
}
function errorMessage(body,fallback) {
  if(typeof body==='string')return body;
  return body?.error?.message||body?.detail||body?.message||fallback;
}
function generationError(body,fallback) {
  const error=new Error(String(errorMessage(body,fallback)));
  if(typeof body?.error?.code==='string')error.code=body.error.code;
  error.generationTerminal=/^(?:generation_failed|account_cooldown|account_unavailable|PUBLIC_ERROR_[A-Z0-9_]+)$/.test(error.code||'');
  error.unknownOutcome=error.code==='outcome_unknown';
  return error;
}
async function readCredentials(databasePath,composePath,command=exec,signal) {
  const script = "import sqlite3,json,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); r=c.execute('SELECT username,password,api_key FROM admin_config WHERE id=1').fetchone(); print(json.dumps(dict(zip(('username','password','apiKey'),r)))); c.close()";
  try{
    const {stdout}=await command('docker',['compose','-f',composePath,'exec','-T','flow2api','python','-c',script,'/app/data/flow.db'],{env:COMMAND_ENV,timeout:15000,maxBuffer:65536,signal});
    const credentials=JSON.parse(stdout);
    if(!credentials||['username','password','apiKey'].some(key=>typeof credentials[key]!=='string'||!credentials[key]))throw new Error('Invalid credentials');
    return credentials;
  }catch(error){
    if(error.name==='AbortError')throw error;
    const stopped=/service ["']?flow2api["']? is not running/i.test(String(error.stderr||error.message||''));
    const failure=new Error(stopped?'Локальный движок Flow не запущен. Дождитесь подключения или нажмите «Повторить».':'Не удалось прочитать настройки локального движка Flow. Проверьте Docker и нажмите «Повторить».');
    failure.code=stopped?'ENGINE_NOT_RUNNING':'ENGINE_CREDENTIALS_UNAVAILABLE';throw failure;
  }
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
    throw generationError(body,'Ошибка сервера: '+response.status);
  }
  if(!response.body)throw new Error('Сервер вернул пустой ответ.');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let pending='',content='',lastProgress='',streamError=null;
  const consume=data=>{
    const account=data.flow_studio?.account;
    if(Number.isSafeInteger(account?.id)&&account.id>0&&typeof account.email==='string')onAccount({id:account.id,email:account.email});
    if(data.error){streamError=generationError(data,'Не удалось выполнить генерацию');return;}
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
      if(streamError)throw streamError;
    }
    pending+=decoder.decode();
    if(pending.trim())splitSSE(pending+'\n\n',consume);
    if(streamError)throw streamError;
    const media=extractMedia(content);
    if(!media.length)throw new Error(lastProgress||'Генерация завершилась без изображения или видео.');
    return media;
  }finally{await reader.cancel().catch(()=>{});}
}
class Runtime {
  constructor({composePath,databasePath,dataDir,onEvent=()=>{}}){
    Object.assign(this,{composePath,databasePath,dataDir,onEvent});
    this.ready=false;this.message='Запускаем Flow Studio…';this.models=[];this.accounts=[];this.accountRefreshVersion=0;this.accountAppliedVersion=0;this.jobs=[];
    this.sessionCookie='';this.startTask=null;this.aborts=new Map();this.persistTask=Promise.resolve();
    this.closing=false;this.closeTask=null;this.engineManaged=false;this.engineContainer=null;this.engineContainerCaptureFailed=false;this.jobTasks=new Set();this.historyTask=null;this.startController=new AbortController();this.retryInputs=new Set();this.retryTask=null;this.browserEngine=null;this.browserAccountState=new Map();this.accountParticipation=new Map();
  }
  attachBrowserEngine(engine){
    if(!engine||typeof engine.supports!=='function'||typeof engine.generate!=='function')throw new Error('Неверный браузерный движок.');
    if(this.closing||this.jobs.some(job=>job.status==='running'))throw new Error('Дождитесь завершения генерации перед подключением браузерного движка.');
    this.browserEngine=engine;
  }
  status(message,ready=this.ready){this.message=message;this.ready=ready;this.onEvent({type:'status',message,ready});}
  initializeHistory(){
    if(this.historyTask)return this.historyTask;
    this.historyTask=(async()=>{
      await fs.mkdir(this.dataDir,{recursive:true,mode:0o700});
      try{this.jobs=JSON.parse(await fs.readFile(path.join(this.dataDir,'history.json'),'utf8')).filter(j=>j&&typeof j.id==='string');}catch{this.jobs=[];}
      try{
        const saved=JSON.parse(await fs.readFile(path.join(this.dataDir,'browser-account-state.json'),'utf8'));
        if(saved.version===1&&Array.isArray(saved.accounts))for(const account of saved.accounts)if(Number.isSafeInteger(account?.id)&&account.id>0&&typeof account.email==='string'&&account.email&&typeof account.lastGenerationError==='string'&&Number.isFinite(Date.parse(account.lastGenerationErrorAt))&&(account.cooldownUntil===null||Number.isFinite(Date.parse(account.cooldownUntil))))this.browserAccountState.set(account.id,{id:account.id,email:account.email,cooldownUntil:account.cooldownUntil,lastGenerationError:account.lastGenerationError.slice(0,1200),lastGenerationErrorAt:account.lastGenerationErrorAt});
      }catch{}
      try{
        const saved=JSON.parse(await fs.readFile(path.join(this.dataDir,'account-participation.json'),'utf8'));
        if(saved.version===1&&Array.isArray(saved.accounts))for(const account of saved.accounts)if(Number.isSafeInteger(account?.id)&&account.id>0&&typeof account.email==='string'&&account.email&&typeof account.enabled==='boolean')this.accountParticipation.set(account.id,{id:account.id,email:account.email,enabled:account.enabled});
      }catch{}
      for(const job of this.jobs)if(job.status==='running'){job.status='failed';job.error='Приложение закрылось до завершения генерации. Проверьте результат в Flow перед новым запросом.';job.unknownOutcome=true;}
      this.jobs=this.jobs.slice(0,100);
      for(const job of this.jobs){
        try{const stat=await fs.lstat(path.join(this.retryFolder(job.id),'input.json'));if(stat.isFile())this.retryInputs.add(job.id);}catch{}
      }
      await this.pruneRetryInputs();
    })();
    return this.historyTask;
  }
  async health(){try{const r=await fetch(BASE+'/health',{signal:AbortSignal.timeout(2000)});const d=await r.json();return r.ok&&d.backend_running;}catch{return false;}}
  async login(){
    this.credentials=await readCredentials(this.databasePath,this.composePath,this.command.bind(this),this.startController.signal);
    const r=await fetch(BASE+'/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:this.credentials.username,password:this.credentials.password}),signal:AbortSignal.any([this.startController.signal,AbortSignal.timeout(10000)])});
    if(!r.ok)throw new Error('Не удалось войти в локальный Flow2API. Проверьте его настройки и нажмите «Повторить».');
    const d=await r.json();this.sessionCookie=d.token;
    if(!this.sessionCookie)throw new Error('Flow2API не вернул сессию.');
  }
  async request(endpoint,{method='GET',body,retry=true,signal,startup=false}={}){
    if(this.closing)throw new Error('Приложение закрывается.');
    if(!startup){await this.start();if(!this.ready)throw new Error(this.message);}
    if(!this.sessionCookie)await this.login();
    let r=await fetch(BASE+endpoint,{method,headers:{'Content-Type':'application/json','Authorization':'Bearer '+this.sessionCookie},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([this.startController.signal,AbortSignal.timeout(60000),...(signal?[signal]:[])])});
    let d;try{d=await r.json();}catch{throw new Error('Локальный сервер вернул неверный ответ.');}
    if(r.status===401&&retry&&!String(d?.detail||'').includes('Google Flow')){await this.login();return this.request(endpoint,{method,body,retry:false,signal,startup});}
    if(!r.ok)throw new Error(String(errorMessage(d,'Ошибка сервера: '+r.status)));
    return d;
  }
  async start(){
    if(this.closing)throw new Error('Приложение закрывается.');
    if(this.startTask)return this.startTask;
    this.startTask=(async()=>{
      if(this.ready&&await this.health()){this.startController.signal.throwIfAborted();return this.snapshot();}
      this.startController.signal.throwIfAborted();
      return this._start();
    })().finally(()=>{this.startTask=null;});
    return this.startTask;
  }
  command(command,args,options){return exec(command,args,{env:COMMAND_ENV,...options});}
  async inspectEngineContainer(id,signal){
    const invalid=()=>new Error('Не удалось подтвердить принадлежащий приложению контейнер движка.');
    if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw invalid();
    const format='{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}}}';
    const {stdout}=await this.command('docker',['inspect','--type','container','--format',format,id],{timeout:15000,maxBuffer:65536,...(signal?{signal}:{})});
    let identity;try{identity=JSON.parse(stdout);}catch{throw invalid();}
    if(identity?.id!==id||identity.service!=='flow2api'||typeof identity.project!=='string'||!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(identity.project))throw invalid();
    return Object.freeze({id,project:identity.project,service:identity.service});
  }
  async captureEngineContainer(signal){
    this.engineContainer=null;this.engineContainerCaptureFailed=true;
    const {stdout}=await this.command('docker',['compose','-f',this.composePath,'ps','-q','flow2api'],{timeout:15000,maxBuffer:65536,signal});
    this.engineContainer=await this.inspectEngineContainer(typeof stdout==='string'?stdout.trim():'',signal);
    this.engineContainerCaptureFailed=false;
  }
  async ensureEngine(){
    const signal=this.startController.signal;
    if(await this.health()){
      try{await this.command('docker',['compose','-f',this.composePath,'exec','-T','flow2api','python','-c','import sys; sys.exit(0)'],{timeout:15000,signal});}
      catch{throw new Error('Порт 38000 занят другим сервером. Остановите его и нажмите «Повторить».');}
    }else{
        try{await this.command('docker',['info','--format','{{.ServerVersion}}'],{timeout:10000,signal});}
        catch{
          this.status('Запускаем локальный движок…',false);
          try{await this.command('colima',['start'],{timeout:240000,maxBuffer:4*1024*1024,signal});}
          catch{throw new Error('Запустите Docker Desktop или установите и запустите Colima с Docker CLI. Затем нажмите «Повторить».');}
        }
    }
    signal.throwIfAborted();this.engineManaged=true;
    this.status('Подготавливаем генератор. Первый запуск скачивает зависимости и может занять 10–20 минут…',false);
    await this.command('docker',['compose','-f',this.composePath,'up','-d','flow2api'],{timeout:1800000,maxBuffer:16*1024*1024,signal});
    await this.captureEngineContainer(signal);
    for(let i=0;i<60;i++){
      signal.throwIfAborted();
      if(await this.health())return;
      await delay(1000);
    }
    throw new Error('Генератор не запустился. Нажмите «Повторить» через минуту.');
  }
  async _start(){
    this.status('Подключаем локальный движок…',false);
    try{
      await this.ensureEngine();
      this.startController.signal.throwIfAborted();
      await this.login();
      const r=await fetch(BASE+'/v1/models',{headers:{Authorization:'Bearer '+this.credentials.apiKey},signal:AbortSignal.any([this.startController.signal,AbortSignal.timeout(10000)])});
      if(!r.ok)throw new Error('Не удалось загрузить модели.');
      this.models=(await r.json()).data.map(m=>({id:m.id,description:m.description||m.id}));
      await this.refreshAccounts({startup:true});
      this.status('Готово',true);
    }catch(e){if(!this.closing)this.status(e.message?.includes('Command failed')?'Не удалось запустить локальный движок. Проверьте, что Colima и Docker установлены, и нажмите «Повторить».':e.message,false);}
    return this.snapshot();
  }
  snapshot(){return {ready:this.ready,message:this.message,models:this.models,accounts:this.accounts,history:this.publicJobs()};}
  publicJobs(){return this.jobs.map(j=>this.publicJob(j));}
  publicJob(job){
    const fields=['id','model','prompt','kind','createdAt','status','progress','error','needsLogin','elapsedSeconds','accountId','accountEmail','retryOf','unknownOutcome','errorCode','generationEngine','recovering'];
    const result=Object.fromEntries(fields.filter(key=>Object.hasOwn(job,key)).map(key=>[key,job[key]]));
    const reason=this.retryBlockedReason(job);
    const recoveryReason=this.recoveryBlockedReason(job);
    return {...result,retryAvailable:!reason,...(reason?{retryBlockedReason:reason}:{}),recoveryAvailable:!recoveryReason,...(job.generationEngine==='isolated-browser'&&job.unknownOutcome&&recoveryReason?{recoveryBlockedReason:recoveryReason}:{}),media:(job.media||[]).map((m,i)=>({...m,url:m.path?'flow-media://'+job.id+'/'+i:m.url}))};
  }
  recoveryBlockedReason(job){
    if(job.generationEngine!=='isolated-browser'||job.status!=='failed'||!job.unknownOutcome)return 'Проверка доступна для незавершенной задачи фонового браузера.';
    if(typeof this.browserEngine?.recover!=='function')return 'Обновите приложение для проверки существующей задачи.';
    if(job.errorCode==='BROWSER_RECEIPT_MISSING')return 'Запись отправки не сохранена. Проверьте прежнюю задачу в Flow вручную.';
    return '';
  }
  retryBlockedReason(job){
    if(job.status==='running')return 'Дождитесь завершения генерации.';
    if(job.unknownOutcome||job.errorCode==='outcome_unknown'||job.cancelRequested&&job.unknownOutcome!==false)return 'Результат запроса неизвестен. Проверьте задачу в Flow перед новым запросом.';
    if(/\bPUBLIC_ERROR_(?:MINOR|UNSAFE_GENERATION|PROMINENT_PEOPLE_FILTER_FAILED)\b/.test([job.errorCode,job.error].join('\n')))return 'Google Flow отклонил содержимое. Измените запрос или исходные файлы перед новой генерацией.';
    if(!this.retryInputs.has(job.id))return 'Исходные файлы для повтора не сохранены. Перенесите запрос в редактор и добавьте их заново.';
    if(!Number.isSafeInteger(job.accountId)||job.accountId<=0||!job.accountEmail)return 'Аккаунт исходного запроса не определён. Перенесите запрос в редактор.';
    const account=this.accounts.find(a=>a.id===job.accountId&&a.email?.toLowerCase()===job.accountEmail.toLowerCase());
    if(!account)return 'Подключите исходный аккаунт перед повтором.';
    if(!account.isActive)return 'Включите исходный аккаунт перед повтором.';
    if(this.models.length&&!this.models.some(m=>m.id===job.model))return 'Исходная модель больше недоступна. Выберите модель в редакторе.';
    return '';
  }
  async getProviderSettings(){
    try{
      const config=await this.request('/api/captcha/config');
      if(typeof config?.captcha_method!=='string'||typeof config.twocaptcha_api_key!=='string')throw new Error();
      return {twoCaptchaKeyConfigured:!!config.twocaptcha_api_key.trim(),captchaMethod:config.captcha_method};
    }catch{throw new Error('Не удалось загрузить настройки 2Captcha.');}
  }
  async saveTwoCaptchaKey(key){
    if(typeof key!=='string'||!key.trim()||key.length>1024)throw new Error('Введите API-ключ 2Captcha длиной до 1024 символов.');
    if(this.jobs.some(job=>job.status==='running'))throw new Error('Дождитесь завершения генерации перед сохранением настроек.');
    try{
      const config=await this.request('/api/captcha/config');
      // This endpoint resets omitted browser fields; preserve them without selecting a provider.
      const fields=['yescaptcha_task_type','remote_browser_timeout','browser_proxy_enabled','browser_proxy_url','browser_count','browser_personal_fresh_restart_every_n_solves'];
      if(typeof config?.captcha_method!=='string'||fields.some(field=>!Object.hasOwn(config,field)))throw new Error();
      const body=Object.fromEntries(fields.map(field=>[field,config[field]]));
      body.twocaptcha_api_key=key.trim();
      const result=await this.request('/api/captcha/config',{method:'POST',body});
      if(result?.success!==true)throw new Error();
      const saved=await this.request('/api/captcha/config');
      if(saved?.twocaptcha_api_key!==body.twocaptcha_api_key||saved.captcha_method!==config.captcha_method)throw new Error();
      return {saved:true,twoCaptchaKeyConfigured:true,captchaMethod:saved.captcha_method};
    }catch{throw new Error('Не удалось сохранить API-ключ 2Captcha. Повторите попытку.');}
  }
  async refreshAccounts(options){
    const version=++this.accountRefreshVersion;
    const rows=await this.request('/api/tokens',options);
    if(version<this.accountAppliedVersion)return this.accounts;
    this.accountAppliedVersion=version;
    const present=new Map(rows.map(row=>[row.id,String(row.login_account||row.email||'').toLowerCase()]));
    for(const [id,intent] of this.accountParticipation)if(present.get(id)!==intent.email.toLowerCase())this.accountParticipation.delete(id);
    this.accounts=rows.map(row=>this.withParticipation(this.withBrowserCooldown(publicAccount(row))));this.onEvent({type:'accounts',accounts:this.accounts,history:this.publicJobs()});return this.accounts;
  }
  withParticipation(account){
    const intent=this.accountParticipation.get(account.id);
    if(!intent||intent.email.toLowerCase()!==account.email?.toLowerCase())return account;
    return {...account,isActive:!account.manualDisabled&&intent.enabled};
  }
  withBrowserCooldown(account){
    const local=this.browserAccountState.get(account.id);
    if(!local||local.email.toLowerCase()!==account.email?.toLowerCase())return account;
    const now=Date.now(),localUntil=Date.parse(local.cooldownUntil)||0,serverUntil=Date.parse(account.cooldownUntil)||0,until=Math.max(localUntil,serverUntil);
    const latest=!(Date.parse(account.lastGenerationErrorAt)>Date.parse(local.lastGenerationErrorAt))?local:account;
    return {...account,cooldownUntil:until?new Date(until).toISOString():null,lastGenerationError:latest.lastGenerationError,lastGenerationErrorAt:latest.lastGenerationErrorAt,cooldownRemainingSeconds:Math.max(0,Math.ceil((until-now)/1000)),cooldownResetAllowed:true};
  }
  recordBrowserAccountFailure(job,error){
    if(error.accountFailure!==true||error.generationTerminal!==true||!Number.isSafeInteger(job.accountId)||!job.accountEmail||/\bPUBLIC_ERROR_(?:MINOR|UNSAFE_GENERATION|PROMINENT_PEOPLE_FILTER_FAILED)\b/.test([error.code,error.publicCode,error.message].join('\n')))return;
    const now=Date.now(),previous=this.browserAccountState.get(job.accountId),sameAccount=previous?.email.toLowerCase()===job.accountEmail.toLowerCase();
    // Keep an active Google unusual-activity hold intact when another error arrives.
    if(sameAccount&&Date.parse(previous.cooldownUntil)>now&&/\bPUBLIC_ERROR_UNUSUAL_ACTIVITY[A-Z0-9_]*\b/.test(previous.lastGenerationError))return;
    const publicCode=[error.publicCode,error.code,error.message].find(value=>typeof value==='string'&&/\bPUBLIC_ERROR_[A-Z0-9_]+\b/.test(value))?.match(/\bPUBLIC_ERROR_[A-Z0-9_]+\b/)?.[0];
    const lastGenerationError=(publicCode?publicCode+': ':'')+String(error.message||error.code||'Google Flow отклонил генерацию.');
    this.browserAccountState.set(job.accountId,{id:job.accountId,email:job.accountEmail,cooldownUntil:new Date(now+30*60*1000).toISOString(),lastGenerationError:lastGenerationError.slice(0,1200),lastGenerationErrorAt:new Date(now).toISOString()});
    this.accounts=this.accounts.map(account=>this.withBrowserCooldown(account));
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
  async setAccountActive(accountId,enabled){
    if(!Number.isSafeInteger(accountId)||accountId<=0||typeof enabled!=='boolean')throw new Error('Неверные параметры аккаунта.');
    const before=(await this.refreshAccounts()).find(a=>a.id===accountId);if(!before)throw new Error('Аккаунт не найден.');
    const result=await this.request('/api/tokens/'+accountId+(enabled?'/enable':'/disable'),{method:'POST'});
    if(result.success!==true)throw new Error('Не удалось изменить состояние аккаунта.');
    const accounts=await this.refreshAccounts();
    const after=accounts.find(a=>a.id===accountId);
    if(!after||after.email?.toLowerCase()!==before.email?.toLowerCase()||(after.serverActive??after.isActive)!==enabled)throw new Error('Сервер не подтвердил состояние аккаунта.');
    const previous=this.accountParticipation.get(accountId);this.accountParticipation.set(accountId,{id:accountId,email:after.email,enabled});
    try{await this.persist();}catch(error){if(previous)this.accountParticipation.set(accountId,previous);else this.accountParticipation.delete(accountId);throw error;}
    this.accounts=accounts.map(account=>this.withParticipation(account));this.onEvent({type:'accounts',accounts:this.accounts,history:this.publicJobs()});
    return {accounts:this.accounts};
  }
  async clearCooldown(accountId){
    if(!Number.isSafeInteger(accountId)||accountId<=0)throw new Error('Аккаунт не найден.');
    if(this.jobs.some(job=>job.status==='running'))throw new Error('Дождитесь завершения генерации перед сбросом паузы.');
    const account=(await this.refreshAccounts()).find(a=>a.id===accountId);
    if(!account)throw new Error('Аккаунт не найден.');
    const result=await this.request('/api/tokens/'+accountId+'/clear-cooldown',{method:'POST'});
    if(result.success!==true)throw new Error('Не удалось сбросить паузу аккаунта.');
    const local=this.browserAccountState.get(accountId);
    if(local&&local.email.toLowerCase()===account.email?.toLowerCase()){
      this.browserAccountState.set(accountId,{...local,cooldownUntil:null});
      try{await this.persist();}catch(error){this.browserAccountState.set(accountId,local);throw error;}
    }
    const accounts=await this.refreshAccounts();
    const after=accounts.find(a=>a.id===accountId);
    if(!after||after.email?.toLowerCase()!==account.email?.toLowerCase()||Date.parse(after.cooldownUntil)>Date.now())throw new Error('Сервер не подтвердил сброс паузы.');
    return {cleared:true,accounts};
  }
  async deleteAccount(accountId){
    if(!Number.isSafeInteger(accountId)||accountId<=0)throw new Error('Аккаунт не найден.');
    if(this.jobs.some(job=>job.status==='running'))throw new Error('Дождитесь завершения генерации перед удалением аккаунта.');
    if(!(await this.refreshAccounts()).some(a=>a.id===accountId))throw new Error('Аккаунт не найден.');
    const result=await this.request('/api/tokens/'+accountId,{method:'DELETE'});
    if(result.success!==true)throw new Error('Не удалось удалить подключение.');
    this.accountAppliedVersion=++this.accountRefreshVersion;
    this.accounts=this.accounts.filter(a=>a.id!==accountId);
    const hadCooldown=this.browserAccountState.delete(accountId),hadParticipation=this.accountParticipation.delete(accountId);
    if(hadCooldown||hadParticipation)await this.persist();
    this.onEvent({type:'accounts',accounts:this.accounts,history:this.publicJobs()});
    return {deleted:true,accounts:this.accounts};
  }
  checkEnabledAccounts({checkAccount=id=>this.checkAccount(id)}={}){
    if(this.accountCheckTask)return this.accountCheckTask;
    this.accountCheckTask=(async()=>{
      const ids=(await this.refreshAccounts()).filter(a=>a.isActive).map(a=>a.id);
      const summary={running:true,total:ids.length,checked:0,verified:0,failed:0,skipped:0,results:[]};
      const emit=extra=>this.onEvent({type:'account-checks',...summary,...extra});
      emit({accountId:null});
      try{
        for(const id of ids){
          this.startController.signal.throwIfAborted();
          if(!(await this.refreshAccounts()).some(a=>a.id===id&&a.isActive)){
            summary.skipped++;summary.checked++;emit({accountId:id,status:'skipped'});continue;
          }
          emit({accountId:id,status:'checking'});
          let result;
          try{
            const checked=await checkAccount(id);
            if(checked?.ok!==true)throw new Error(checked?.message||'Подключение не подтверждено');
            result={accountId:id,status:'verified',checkedAt:checked.checkedAt||new Date().toISOString()};summary.verified++;
          }catch(error){
            this.startController.signal.throwIfAborted();
            result={accountId:id,status:'error',message:error.message};summary.failed++;
          }
          summary.checked++;summary.results.push(result);emit(result);
        }
        return {...summary,running:false};
      }finally{summary.running=false;emit({accountId:null});}
    })().finally(()=>{this.accountCheckTask=null;});
    return this.accountCheckTask;
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
      await fs.writeFile(temp,JSON.stringify(this.jobs.slice(0,100)),{mode:0o600,flush:true});await fs.rename(temp,target);
      const state=path.join(this.dataDir,'browser-account-state.json'),stateTemp=state+'.tmp';
      await fs.writeFile(stateTemp,JSON.stringify({version:1,accounts:[...this.browserAccountState.values()]}),{mode:0o600,flush:true});await fs.rename(stateTemp,state);
      const participation=path.join(this.dataDir,'account-participation.json'),participationTemp=participation+'.tmp';
      await fs.writeFile(participationTemp,JSON.stringify({version:1,accounts:[...this.accountParticipation.values()]}),{mode:0o600,flush:true});await fs.rename(participationTemp,participation);
    };
    this.persistTask=this.persistTask.catch(()=>{}).then(save);
    return this.persistTask;
  }
  emitJob(job){this.onEvent({type:'job',job:this.publicJob(job)});}
  retryFolder(jobId){
    if(typeof jobId!=='string'||!(/^[a-zA-Z0-9_-]{1,128}$/).test(jobId))throw new Error('Задача не найдена.');
    return path.join(this.dataDir,'retry-inputs',jobId);
  }
  async saveRetryInput(job,images,sourceVideoId,videos,videoNames=[]){
    const folder=this.retryFolder(job.id);
    await fs.mkdir(folder,{recursive:true,mode:0o700});
    const copied=[];
    try{
      for(const file of videos)copied.push(await stageVideo(file,folder));
      const input={version:1,model:job.model,prompt:job.prompt,images,sourceVideoId:sourceVideoId||'',videos:copied.map(file=>path.basename(file.target)),videoNames:copied.map((file,i)=>videoNames[i]||file.reference.filename)};
      await fs.writeFile(path.join(folder,'input.json'),JSON.stringify(input),{flag:'wx',mode:0o600});
      this.retryInputs.add(job.id);await this.pruneRetryInputs();
      return copied.map(file=>file.target);
    }catch(error){this.retryInputs.delete(job.id);await fs.rm(folder,{recursive:true,force:true}).catch(()=>{});throw error;}
  }
  async readRetryInput(job){
    try{
      const folder=this.retryFolder(job.id),file=await fs.open(path.join(folder,'input.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      let input;
      try{const stat=await file.stat();if(!stat.isFile()||stat.size>200*1024*1024)throw new Error();input=JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
      if(input.version!==1||input.model!==job.model||input.prompt!==job.prompt||!Array.isArray(input.images)||!Array.isArray(input.videos)||input.videos.some(name=>typeof name!=='string'||path.basename(name)!==name||!/^[-a-zA-Z0-9_]+\.(mp4|mov|m4v)$/i.test(name))||!Array.isArray(input.videoNames)||input.videoNames.length!==input.videos.length||input.videoNames.some(name=>typeof name!=='string'||name.length>256))throw new Error();
      return {model:input.model,prompt:input.prompt,images:input.images,sourceVideoId:input.sourceVideoId,videos:input.videos.map(name=>path.join(folder,name)),videoNames:input.videoNames};
    }catch{this.retryInputs.delete(job.id);throw new Error('Исходные файлы для повтора недоступны. Перенесите запрос в редактор и добавьте их заново.');}
  }
  async pruneRetryInputs(){
    // ponytail: keep 20 jobs / 512 MiB; older requests remain editable in history.
    const root=path.join(this.dataDir,'retry-inputs'),keep=new Set();let bytes=0;
    for(const job of this.jobs.slice(0,20)){
      if(!this.retryInputs.has(job.id))continue;
      const folder=this.retryFolder(job.id);let size=0;
      try{for(const entry of await fs.readdir(folder,{withFileTypes:true}))if(entry.isFile())size+=(await fs.lstat(path.join(folder,entry.name))).size;}catch{this.retryInputs.delete(job.id);continue;}
      if(bytes+size<=512*1024*1024){keep.add(job.id);bytes+=size;}
    }
    let folders;try{folders=await fs.readdir(root,{withFileTypes:true});}catch{return;}
    for(const entry of folders)if(entry.isDirectory()&&/^[a-zA-Z0-9_-]{1,128}$/.test(entry.name)&&!keep.has(entry.name)){
      await fs.rm(path.join(root,entry.name),{recursive:true,force:true});this.retryInputs.delete(entry.name);
    }
  }
  retryGeneration(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['jobId','requestId'].includes(key))||typeof input.jobId!=='string'||typeof input.requestId!=='string'||!input.requestId.trim()||input.requestId.length>128)return Promise.reject(new Error('Неверные параметры повтора.'));
    const original=this.jobs.find(job=>job.id===input.jobId);
    if(!original)return Promise.reject(new Error('Задача не найдена.'));
    const existing=this.jobs.find(job=>job.requestId===input.requestId);
    if(existing)return existing.retryOf===original.id?Promise.resolve({jobId:existing.id}):Promise.reject(new Error('requestId уже использован с другими параметрами.'));
    if(this.retryTask)return this.retryRequestId===input.requestId&&this.retryJobId===original.id?this.retryTask:Promise.reject(new Error('Дождитесь подготовки повтора.'));
    if(this.closing||!this.ready)return Promise.reject(new Error(this.closing?'Приложение закрывается.':'Генератор ещё запускается.'));
    if(this.accountActionPending||this.accountCheckTask)return Promise.reject(new Error('Дождитесь завершения действия с аккаунтами.'));
    if(this.jobs.some(job=>job.status==='running'))return Promise.reject(new Error('Дождитесь текущей генерации.'));
    this.retryRequestId=input.requestId;this.retryJobId=original.id;
    this.retryTask=(async()=>{
      await this.refreshAccounts();
      const reason=this.retryBlockedReason(original);if(reason)throw new Error(reason);
      const account=this.accounts.find(account=>account.id===original.accountId);
      if(Date.parse(account.cooldownUntil)>Date.now())throw new Error('Аккаунт на паузе после ошибки. Дождитесь окончания паузы или сбросьте её вручную.');
      const saved=await this.readRetryInput(original);
      return this.generate({model:saved.model,prompt:saved.prompt,sourceVideoId:saved.sourceVideoId,references:[...saved.images.map(dataUrl=>({kind:'image',dataUrl})),...saved.videos.map(file=>({kind:'video',path:file}))],requestId:input.requestId},{retryOf:original.id,accountId:original.accountId,accountEmail:original.accountEmail,videoNames:saved.videoNames});
    })().finally(()=>{this.retryTask=null;this.retryRequestId=null;this.retryJobId=null;});
    return this.retryTask;
  }
  generate(input,{retryOf,accountId,accountEmail,videoNames}={}){
    if(this.closing)throw new Error('Приложение закрывается.');
    if(this.nativeBrowserPending)throw new Error('Сначала завершите или отмените подготовку в обычном Chrome.');
    if(this.retryTask&&!retryOf)throw new Error('Дождитесь подготовки повтора.');
    if(!this.ready)throw new Error('Генератор ещё запускается.');
    if(!input||!this.models.some(m=>m.id===input.model))throw new Error('Выберите доступную модель.');
    if(Object.hasOwn(input,'accountId')&&(!Number.isSafeInteger(input.accountId)||input.accountId<=0))throw new Error('Неверный аккаунт для генерации.');
    accountId=accountId??input.accountId;
    if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>20000)throw new Error('Введите запрос длиной до 20 000 символов.');
    const info=modelInfo(this.models.find(m=>m.id===input.model));
    if(input.images&&input.references)throw new Error('Передайте images или references.');
    const refs=input.references||(input.images||[]).map(dataUrl=>({kind:'image',dataUrl}));
    if(!Array.isArray(refs)||refs.length>7||refs.some(r=>!r||!['image','video'].includes(r.kind)))throw new Error('Некорректные референсы.');
    const images=refs.filter(r=>r.kind==='image').map(r=>r.dataUrl),videos=refs.filter(r=>r.kind==='video').map(r=>r.path);
    if(images.length>info.maxImages||images.some(s=>typeof s!=='string'||s.length>28*1024*1024||!/^data:image\/(?:png|jpeg|webp|gif);base64,/.test(s)))throw new Error('Слишком много изображений или неверный формат. Изображение: до 20 МБ.');
    if(videos.length>(info.maxVideos||0)||videos.some(p=>typeof p!=='string'||!path.isAbsolute(p)||! /\.(mp4|mov|m4v)$/i.test(p))||info.edit&&videos.length!==1)throw new Error(`Для редактирования Omni нужно одно видео MP4/MOV/M4V до ${info.maxInputDuration} секунд и до 100 МБ.`);
    const browserInput={model:input.model,prompt:input.prompt.trim(),references:refs,...(input.sourceVideoId?{sourceVideoId:input.sourceVideoId}:{})};
    const browserEngine=this.browserEngine?.supports(browserInput)?this.browserEngine:null;
    const requestHash=crypto.createHash('sha256').update(JSON.stringify({model:input.model,prompt:input.prompt.trim(),images,videos,sourceVideoId:input.sourceVideoId||'',...(retryOf?{retryOf}:{}),...(accountId?{accountId}:{})})).digest('hex');
    if(input.requestId){
      const existing=this.jobs.find(j=>j.requestId===input.requestId);
      if(existing){if(existing.requestHash!==requestHash)throw new Error('requestId уже использован с другими параметрами.');return {jobId:existing.id};}
    }
    if(this.accountActionPending||this.accountCheckTask)throw new Error('Дождитесь завершения действия с аккаунтами.');
    if(this.jobs.some(j=>j.status==='running'))throw new Error('Дождитесь текущей генерации.');
    const id=crypto.randomUUID(),job={id,model:input.model,prompt:input.prompt.trim(),kind:input.model.includes('image')?'image':'video',generationEngine:browserEngine?'isolated-browser':'server',createdAt:new Date().toISOString(),status:'running',progress:'Отправляем запрос…',media:[],...(input.requestId?{requestId:input.requestId,requestHash}:{}),...(accountId?{accountId}:{}),...(retryOf?{retryOf,accountEmail}:{})};
    this.jobs.unshift(job);this.emitJob(job);
    const task=this.runJob(job,images,input.sourceVideoId,videos,{accountId,videoNames,browserEngine}).catch(()=>{});
    this.jobTasks.add(task);task.finally(()=>this.jobTasks.delete(task));
    return {jobId:id};
  }
  cancelGeneration(jobId){
    const job=this.jobs.find(job=>job.id===jobId);
    if(!job)throw new Error('Задача не найдена.');
    if(job.status!=='running')return {cancelled:false,jobId};
    job.cancelRequested=true;job.progress='Отменяем ожидание…';this.emitJob(job);this.aborts.get(jobId)?.abort();
    return {cancelled:true,jobId};
  }
  recoverGeneration(jobId){
    if(typeof jobId!=='string'||!jobId||jobId.length>128)throw new Error('Неверный ID задачи.');
    const job=this.jobs.find(job=>job.id===jobId);if(!job)throw new Error('Задача не найдена.');
    if(this.closing||!this.ready)throw new Error(this.closing?'Приложение закрывается.':'Генератор ещё запускается.');
    if(this.accountActionPending||this.accountCheckTask||this.retryTask||this.nativeBrowserPending)throw new Error('Дождитесь завершения текущего действия с аккаунтами или подготовкой.');
    if(this.jobs.some(job=>job.status==='running'))throw new Error('Дождитесь текущей генерации или проверки результата.');
    const reason=this.recoveryBlockedReason(job);if(reason)throw new Error(reason);
    job.status='running';job.recovering=true;job.progress='Проверяем прежний результат в Flow без новой отправки…';delete job.cancelRequested;this.emitJob(job);
    const task=this.runRecovery(job).catch(()=>{});this.jobTasks.add(task);task.finally(()=>this.jobTasks.delete(task));
    return {jobId};
  }
  async browserMedia(job,result){
    if(result?.accountId!==undefined&&result.accountId!==job.accountId||result?.accountEmail!==undefined&&(typeof result.accountEmail!=='string'||result.accountEmail.toLowerCase()!==job.accountEmail?.toLowerCase())){const error=new Error('Браузер подтвердил другой Google-аккаунт. Проверьте подключение.');error.code='account_changed';throw error;}
    if(!Array.isArray(result?.media)||!result.media.length)throw new Error('Генерация завершилась без изображения или видео.');
    const media=[];
    for(const item of result.media){
      if(!item||!['image','video'].includes(item.kind)||!item.path&&!allowedMediaUrl(item.url))throw new Error('Браузер вернул неподдерживаемый результат.');
      const output={kind:item.kind,...(typeof item.mediaGenerationId==='string'?{mediaGenerationId:item.mediaGenerationId}:{}),...(allowedMediaUrl(item.url)?{url:item.url}:{})};
      if(item.path){
        if(typeof item.path!=='string'||!path.isAbsolute(item.path)||item.path.includes('\0'))throw new Error('Браузер вернул неверный путь результата.');
        const file=await fs.open(item.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
        try{const stat=await file.stat();if(!stat.isFile()||stat.size<=0||stat.size>512*1024*1024)throw new Error('Браузер вернул пустой или слишком большой файл.');}finally{await file.close();}
        output.path=item.path;
      }
      media.push(output);
    }
    return media;
  }
  async inspectBrowserVideo(file,{signal}={}){
    signal?.throwIfAborted();
    if(typeof this.databasePath!=='string'||!path.isAbsolute(this.databasePath)||typeof this.composePath!=='string'||!path.isAbsolute(this.composePath))throw new Error('Не настроена проверка исходного видео локальным движком.');
    const staged=await stageVideo(file,path.join(path.dirname(path.dirname(this.databasePath)),'tmp','flow-studio-inputs'));
    try{
      signal?.throwIfAborted();
      const script="import asyncio,json,sys; from src.services.video_inputs import read_video_reference; r=asyncio.run(read_video_reference(json.loads(sys.argv[1]),max_duration_seconds=15)); print(json.dumps({'duration':r['duration_seconds'],'mimeType':r['mime_type'],'filename':r['filename'],'width':r['width'],'height':r['height']}))";
      const {stdout}=await this.command('docker',['compose','-f',this.composePath,'exec','-T','flow2api','python','-c',script,JSON.stringify(staged.reference)],{timeout:30000,maxBuffer:65536,signal});
      signal?.throwIfAborted();let metadata;try{metadata=JSON.parse(stdout);}catch{throw new Error('Локальный движок не подтвердил параметры видео.');}
      if(typeof metadata?.duration!=='number'||!Number.isFinite(metadata.duration)||metadata.duration<=0||metadata.duration>15.02||metadata.mimeType!==staged.reference.mime_type||!Number.isInteger(metadata.width)||metadata.width<=0||metadata.width>32768||!Number.isInteger(metadata.height)||metadata.height<=0||metadata.height>32768)throw new Error('Omni 1.2 Edit принимает видео длительностью до 15 секунд. Проверьте исходный файл.');
      return {duration:metadata.duration,durationSeconds:metadata.duration,mimeType:metadata.mimeType,filename:staged.reference.filename,width:metadata.width,height:metadata.height};
    }finally{await fs.unlink(staged.target).catch(()=>{});}
  }
  async runRecovery(job){
    const start=Date.now(),controller=new AbortController();this.aborts.set(job.id,controller);const timer=setTimeout(()=>controller.abort(),35*60*1000);
    try{
      await this.persist();controller.signal.throwIfAborted();
      const account=(await this.refreshAccounts()).find(account=>account.id===job.accountId&&account.email?.toLowerCase()===job.accountEmail?.toLowerCase());
      if(!account){const error=new Error('Исходный аккаунт изменился или удален. Подключите тот же аккаунт перед проверкой результата.');error.code='account_changed';throw error;}
      const result=await this.browserEngine.recover(job.id,{signal:controller.signal,onProgress:text=>{if(typeof text==='string'&&text.trim()){job.progress=text.slice(-600);this.emitJob(job);}},expected:{accountId:job.accountId,accountEmail:job.accountEmail,model:job.model,prompt:job.prompt}});
      const media=await this.browserMedia(job,result);job.media=media;
      for(let i=0;i<media.length;i++)if(!media[i].path)try{media[i].path=await this.cacheMedia(job.id,i,media[i],controller.signal);}catch{}
      job.status='succeeded';job.unknownOutcome=false;job.progress='Готово';job.needsLogin=false;delete job.error;delete job.errorCode;delete job.cancelRequested;
    }catch(error){
      job.status='failed';job.unknownOutcome=!(error.generationTerminal===true&&error.unknownOutcome!==true&&!job.cancelRequested&&!this.closing&&!controller.signal.aborted);
      if(error.code)job.errorCode=error.code;
      job.error=this.closing?'Проверка прервана при закрытии приложения. Прежняя задача не отправлялась повторно.':job.cancelRequested?'Проверка результата отменена. Прежняя задача не отправлялась повторно.':error.name==='AbortError'?'Время проверки истекло. Прежняя задача не отправлялась повторно.':error.message;
      job.progress=job.error;job.needsLogin=/rpc\s*=\s*[A-Za-z0-9]+\s*,\s*code\s*=\s*401\b|Google Flow[^\n]*авторизац|Токен AT недействителен/i.test(job.error||'');
      this.recordBrowserAccountFailure(job,error);
    }finally{
      clearTimeout(timer);this.aborts.delete(job.id);delete job.recovering;job.elapsedSeconds=(job.elapsedSeconds||0)+Math.round((Date.now()-start)/1000);this.emitJob(job);await this.persist().catch(()=>{});if(!this.closing&&this.ready)await this.refreshAccounts().catch(()=>{});
    }
  }
  async runJob(job,images,sourceVideoId,videos=[],{accountId,videoNames=[],browserEngine=null}={}){
    const start=Date.now(),controller=new AbortController();this.aborts.set(job.id,controller);
    const timer=setTimeout(()=>controller.abort(),35*60*1000);
    const staged=[];let submitted=false;
    try{
      const content=[{type:'text',text:job.prompt},...images.map(url=>({type:'image_url',image_url:{url}}))];
      if(/(?:-|_)extend(?:-|_)/.test(job.model)){
        if(typeof sourceVideoId!=='string'||!sourceVideoId.trim())throw new Error('Укажите ID исходного видео.');
        content.push({type:'image_url',image_url:{url:'extend://'+sourceVideoId.trim().replace(/^extend:\/\//,'')}});
      }
      await this.persist();
      await this.start();
      if(!this.ready)throw new Error(this.message);
      const savedVideos=await this.saveRetryInput(job,images,sourceVideoId,videos,videoNames);
      const onProgress=text=>{if(typeof text==='string'&&text.trim()){job.progress=text.slice(-600);this.emitJob(job);}};
      let media;
      if(browserEngine){
        const accounts=await this.refreshAccounts(),enabled=accounts.filter(account=>Number.isSafeInteger(account.id)&&account.id>0&&typeof account.email==='string'&&account.email&&account.isActive&&(job.kind==='image'||account.videoEnabled!==false)),available=enabled.filter(account=>!(Date.parse(account.cooldownUntil)>Date.now()));
        const account=accountId?accounts.find(account=>account.id===accountId):available.find(account=>account.browserReady!==false)||available[0]||enabled[0];
        if(!account){const error=new Error(accountId?'Исходный аккаунт недоступен для генерации.':'Нет включённого аккаунта, доступного для генерации.');error.code='account_unavailable';throw error;}
        if(job.accountEmail&&account.email?.toLowerCase()!==job.accountEmail.toLowerCase()){const error=new Error('Исходный аккаунт изменился. Подключите его заново.');error.code='account_changed';throw error;}
        job.accountId=account.id;job.accountEmail=account.email;this.emitJob(job);
        if(!enabled.includes(account)){const error=new Error('Исходный аккаунт недоступен для генерации.');error.code='account_unavailable';throw error;}
        if(Date.parse(account.cooldownUntil)>Date.now()){const error=new Error('Аккаунт на паузе после ошибки. Дождитесь окончания паузы или сбросьте её вручную.');error.code='account_cooldown';throw error;}
        const onAccount=value=>{
          if(value?.id!==account.id||typeof value.email!=='string'||value.email.toLowerCase()!==account.email?.toLowerCase()){const error=new Error('Браузер подтвердил другой Google-аккаунт. Проверьте подключение.');error.code='account_changed';throw error;}
        };
        let preparingSubmit=false;
        const beforeSubmit=async()=>{
          controller.signal.throwIfAborted();
          if(preparingSubmit)throw new Error('Запрос уже отправлялся.');
          preparingSubmit=true;job.unknownOutcome=true;await this.persist();controller.signal.throwIfAborted();submitted=true;
        };
        controller.signal.throwIfAborted();
        const result=await browserEngine.generate({jobId:job.id,model:job.model,prompt:job.prompt,references:[...images.map(dataUrl=>({kind:'image',dataUrl})),...savedVideos.map(file=>({kind:'video',path:file}))],...(sourceVideoId?{sourceVideoId}:{}),accountId:account.id,accountEmail:account.email},{signal:controller.signal,onProgress,onAccount,beforeSubmit});
        if(!submitted)throw new Error('Браузер не подтвердил отправку запроса.');
        media=await this.browserMedia(job,result);
      }else{
        for(let i=0;i<savedVideos.length;i++){
          const file=await stageVideo(savedVideos[i],path.join(path.dirname(path.dirname(this.databasePath)),'tmp','flow-studio-inputs'));
          file.reference.filename=videoNames[i]||path.basename(videos[i]).slice(0,256);staged.push(file);
        }
        this.credentials=await readCredentials(this.databasePath,this.composePath,this.command.bind(this),controller.signal);
        controller.signal.throwIfAborted();submitted=true;
        const response=await generationRequest({model:job.model,messages:[{role:'user',content}],stream:true,...(staged.length?{video_references:staged.map(x=>x.reference)}:{}),...(accountId?{flow_studio_account_id:accountId}:{})},this.credentials.apiKey,controller.signal);
        media=await consumeGeneration(response,onProgress,account=>{job.accountId=account.id;job.accountEmail=account.email;this.emitJob(job);});
      }
      job.media=media;
      for(let i=0;i<media.length;i++){
        if(media[i].path)continue;
        try{media[i].path=await this.cacheMedia(job.id,i,media[i],controller.signal);}catch{ /* Original URL remains usable; save can retry. */ }
      }
      job.status='succeeded';job.unknownOutcome=false;delete job.cancelRequested;job.progress='Готово';
    }catch(e){job.status='failed';job.unknownOutcome=submitted&&(!e.generationTerminal||e.unknownOutcome||this.closing||job.cancelRequested||e.name==='AbortError');if(e.code)job.errorCode=e.code;job.error=this.closing?(submitted?'Приложение закрыто. Задача Google могла продолжиться; проверьте Flow перед повтором.':'Приложение закрыто до отправки запроса.'):job.cancelRequested?(submitted?'Ожидание отменено. Задача Google могла продолжиться; проверьте Flow перед повтором.':'Генерация отменена до отправки запроса.'):e.name==='AbortError'?(submitted?'Время ожидания истекло. Проверьте результат в Flow перед повтором.':'Время ожидания истекло до отправки запроса.'):e.message;job.needsLogin=/rpc\s*=\s*[A-Za-z0-9]+\s*,\s*code\s*=\s*401\b|Google Flow[^\n]*авторизац|Токен AT недействителен/i.test(job.error||'');job.progress=job.error;if(browserEngine)this.recordBrowserAccountFailure(job,e);}
    finally{
      for(const file of staged)await fs.unlink(file.target).catch(()=>{});
      clearTimeout(timer);this.aborts.delete(job.id);job.elapsedSeconds=Math.round((Date.now()-start)/1000);this.emitJob(job);await this.persist().catch(()=>{});if(!this.closing&&this.ready)await this.refreshAccounts().catch(()=>{});
    }
  }
  async cacheMedia(jobId,index,media,signal){
    if(!allowedMediaUrl(media.url))throw new Error('Этот адрес результата не поддерживается.');
    const folder=path.join(this.dataDir,'media',jobId);await fs.mkdir(folder,{recursive:true,mode:0o700});
    const ext=media.kind==='video'?'.mp4':media.url.startsWith('data:image/jpeg')?'.jpg':'.png';
    const target=path.join(folder,String(index)+ext),tmp=target+'.part';
    let bytes=0;const handle=await fs.open(tmp,'w',0o600);
    try{
      let url=media.url,response;
      for(let redirects=0;redirects<6;redirects++){
        if(!allowedMediaUrl(url))throw new Error('Неподдерживаемый адрес результата.');
        response=await fetch(url,{redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});
        if(response.status>=300&&response.status<400){url=new URL(response.headers.get('location'),url).href;await response.body?.cancel();continue;}
        break;
      }
      if(!response?.ok||!response.body)throw new Error('Не удалось скачать результат.');
      for await(const chunk of response.body){bytes+=chunk.length;if(bytes>512*1024*1024)throw new Error('Файл больше 512 МБ');await handle.writeFile(chunk);}
      await handle.close();await fs.rename(tmp,target);return target;
    }catch(e){await handle.close().catch(()=>{});await fs.unlink(tmp).catch(()=>{});throw e;}
  }
  mediaFile(jobId,index){return this.jobs.find(j=>j.id===jobId)?.media?.[index]?.path||null;}
  close(){
    if(this.closeTask)return this.closeTask;
    this.closing=true;this.ready=false;this.startController.abort();
    for(const controller of this.aborts.values())controller.abort();
    this.closeTask=(async()=>{
      await this.historyTask?.catch(()=>{});
      await this.startTask?.catch(()=>{});
      await this.retryTask?.catch(()=>{});
      await Promise.allSettled([...this.jobTasks]);
      try{await this.persist();}
      finally{
        if(this.engineManaged){
          if(this.engineContainer){
            const current=await this.inspectEngineContainer(this.engineContainer.id);
            if(current.project!==this.engineContainer.project||current.service!==this.engineContainer.service)throw new Error('Не удалось подтвердить принадлежащий приложению контейнер движка.');
            await this.command('docker',['stop','--timeout','15',this.engineContainer.id],{timeout:45000,maxBuffer:1024*1024});
          }else{
            if(this.engineContainerCaptureFailed)throw new Error('Не удалось подтвердить принадлежащий приложению контейнер движка.');
            await this.command('docker',['compose','-f',this.composePath,'stop','--timeout','15','flow2api'],{timeout:45000,maxBuffer:1024*1024});
          }
          this.engineManaged=false;
          this.engineContainer=null;
        }
      }
    })().catch(error=>{this.closeTask=null;throw error;});
    return this.closeTask;
  }
}
module.exports={Runtime,consumeGeneration,splitSSE,extractMedia,allowedMediaUrl,publicAccount,readCredentials};
