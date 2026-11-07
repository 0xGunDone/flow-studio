const {test}=require('node:test');
const assert=require('node:assert/strict');
const {consumeGeneration,extractMedia,allowedMediaUrl,publicAccount,readCredentials,Runtime}=require('./runtime.cjs');
function sse(parts){
 return new Response(new ReadableStream({start(controller){for(const part of parts)controller.enqueue(new TextEncoder().encode(part));controller.close();}}));
}
test('SSE error is failed, never a completed empty result',async()=>{
 await assert.rejects(consumeGeneration(sse(['data: {"error":{"message":"Нет сессии","status_code":503}}\n\n','data: [DONE]\n\n']),()=>{}),/Нет сессии/);
});
test('SSE captures selected account before arbitrary RPC auth failure',async()=>{
 const accounts=[];
 await assert.rejects(consumeGeneration(sse([
  'data: {"flow_studio":{"account":{"id":7,"email":"owner@example.test"}}}\n\n',
  'data: {"error":{"message":"rpc=MZZa6b, code=401"}}\n\n'
 ]),()=>{},a=>accounts.push(a)),/MZZa6b/);
 assert.deepEqual(accounts,[{id:7,email:'owner@example.test'}]);
});
test('connection check requires live success and matching unchanged account',async()=>{
 const r=new Runtime({dataDir:'/unused'});let calls=[];
 r.refreshAccounts=async()=>[{id:7,email:'owner@example.test'}];
 r.request=async(endpoint,options)=>{calls.push([endpoint,options]);return {ok:true,accountId:7,email:'owner@example.test',credits:0};};
 const result=await r.checkAccount(7);
 assert.equal(result.ok,true);assert.equal(result.credits,0);
 assert.equal(calls[0][0],'/api/tokens/7/check-session');assert.equal(calls[0][1].method,'POST');
 r.request=async()=>({ok:true,accountId:8,email:'other@example.test'});
 await assert.rejects(r.checkAccount(7),/Аккаунт изменился/);
 r.request=async()=>{throw new Error('Сеанс Google завершён');};
 await assert.rejects(r.checkAccount(7),/Сеанс Google/);
 r.request=async()=>({ok:true,accountId:7,email:'owner@example.test'});
 let reads=0;r.refreshAccounts=async()=>[{id:7,email:++reads===1?'owner@example.test':'other@example.test'}];
 await assert.rejects(r.checkAccount(7),/Аккаунт изменился/);
});
test('split SSE returns actual video and progress',async()=>{
 const progress=[];
 const content='<video controls src="https://flow-content.google/video/result.mp4"></video>';
 const text='data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\ndata: [DONE]\n\n';
 const media=await consumeGeneration(sse(['data: {"choices":[{"delta":{"reasoning_content":"Обработка"}}]}\n\n',text.slice(0,17),text.slice(17)]),m=>progress.push(m));
 assert.equal(media[0].kind,'video');assert.equal(media[0].url,'https://flow-content.google/video/result.mp4');assert(progress.includes('Обработка'));
});
test('no output is failure',async()=>assert.rejects(consumeGeneration(sse(['data: [DONE]\n\n']),()=>{}),/без изображения/));
test('media and public accounts never expose credentials',()=>{
 assert.deepEqual(publicAccount({id:7,email:'test@example.test',credits:42,is_active:1,google_cookies:'secret',st:'secret',login_password:'secret'}),{id:7,email:'test@example.test',credits:42,isActive:true,videoEnabled:true});
 assert.equal(extractMedia('![ok](data:image/png;base64,aGVsbG8=)')[0].kind,'image');
 assert(allowedMediaUrl('https://lh3.googleusercontent.com/video.mp4'));
 assert(!allowedMediaUrl('http://192.168.1.1/private'));
 assert(!allowedMediaUrl('https://google.com.attacker.example/a'));
 assert(!allowedMediaUrl('file:///etc/passwd'));
});
test('generation validates input before spending',()=>{
 const r=new Runtime({dataDir:'/unused'});r.ready=true;r.models=[{id:'veo-3.1-fast'}];
 assert.throws(()=>r.generate({model:'unknown',prompt:'test'}),/модель/);
 assert.throws(()=>r.generate({model:'veo-3.1-fast',prompt:''}),/запрос/);
 assert.throws(()=>r.generate({model:'veo-3.1-fast',prompt:'test',images:['file:///etc/passwd']}),/изображений/);
});
test('known reconnect rejects a different account before saving',async()=>{
 const r=new Runtime({dataDir:'/unused'});r.ready=true;
 r.refreshAccounts=async()=>[{id:1,email:'owner@example.test'}];
 r.request=async()=>{throw new Error('Must not read plugin key or save');};
 await assert.rejects(r.syncAccount({email:'other@example.test',cookies:[],expectedAccountId:1}),/тот Google-аккаунт/);
});
test('import success cannot report connected until saved credentials pass live check',async t=>{
 const r=new Runtime({dataDir:'/unused'});r.ready=true;
 r.refreshAccounts=async()=>[{id:7,email:'owner@example.test',credits:99}];
 r.request=async()=>({config:{connection_token:'test-only'}});
 t.mock.method(globalThis,'fetch',async()=>Response.json({success:true}));
 let verified=false;
 r.checkAccount=async id=>{assert.equal(id,7);verified=true;throw new Error('Сохранённая сессия отклонена');};
 const input={email:'owner@example.test',cookies:[],expectedAccountId:7};
 await assert.rejects(r.syncAccount(input),/сессия отклонена/);assert(verified);
 r.checkAccount=async()=>({ok:true,accountId:7,email:input.email,credits:42});
 assert.deepEqual(await r.syncAccount(input),{accountId:7,email:input.email,credits:42});
});
test('generation stops before credential access or submission when engine restart fails',async()=>{
 const r=new Runtime({dataDir:'/unused'});r.ready=true;
 r.persist=async()=>{};r.refreshAccounts=async()=>[];
 let starts=0;
 r.health=async()=>false;
 r._start=async()=>{starts++;r.ready=false;r.message='Engine restart failed';};
 const job={id:'restart-failed',model:'veo-3.1-fast',prompt:'Test',status:'running',media:[]};
 await r.runJob(job,[]);
 assert.equal(starts,1);
 assert.equal(job.status,'failed');
 assert.equal(job.error,'Engine restart failed');
 assert.equal(r.aborts.size,0);
});
test('pending engine restart preserves single-submission guard',async()=>{
 const r=new Runtime({dataDir:'/unused'});r.ready=true;r.models=[{id:'veo-3.1-fast'}];
 r.persist=async()=>{};r.refreshAccounts=async()=>[];
 let finishRestart,enteredRestart,jobTask,starts=0;
 const restarting=new Promise(resolve=>{enteredRestart=resolve;});
 const restart=new Promise(resolve=>{finishRestart=resolve;});
 r.start=async()=>{starts++;enteredRestart();await restart;r.ready=false;r.message='Engine restart failed';};
 const runJob=r.runJob.bind(r);
 r.runJob=(...args)=>(jobTask=runJob(...args));
 const input={model:'veo-3.1-fast',prompt:'Test'};
 const {jobId}=r.generate(input);
 await restarting;
 try{
  assert.throws(()=>r.generate(input),/текущей генерации/);
  assert.equal(starts,1);
  assert.equal(r.jobs.length,1);
  assert.equal(r.jobs[0].id,jobId);
 }finally{finishRestart();await jobTask;}
 assert.equal(r.jobs[0].status,'failed');
});
test('video result preserves source mediaGenerationId for extension',()=>{
 const media=extractMedia("<video src='https://flow-content.google/video/result' data-media-id='source-id' controls></video>");
 assert.equal(media[0].mediaGenerationId,'source-id');
});
test('parallel history updates serialize without losing exported path',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flow-persist-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const r=new Runtime({dataDir:folder});r.jobs=[{id:'one',status:'running',media:[]}];
 const pending=[r.persist()];r.jobs[0].status='succeeded';r.jobs[0].media=[{savedPath:'/user/export.mp4'}];pending.push(r.persist(),r.persist());
 await Promise.all(pending);
 const history=JSON.parse(await fs.readFile(path.join(folder,'history.json'),'utf8'));assert.equal(history[0].media[0].savedPath,'/user/export.mp4');
});

test('engine startup reconciles its own healthy service and refuses a different server',async()=>{
 const r=new Runtime({composePath:'/own/compose.json'}),calls=[];
 r.health=async()=>true;
 r.command=async(command,args,options)=>{calls.push({command,args,options});};
 await r.ensureEngine();
 assert.deepEqual(calls.map(c=>c.args.slice(3)),[
  ['exec','-T','flow2api','python','-c','import sys; sys.exit(0)'],
  ['up','-d','flow2api'],
 ]);
 assert.equal(r.engineManaged,true);
 const other=new Runtime({composePath:'/own/compose.json'});
 other.health=async()=>true;let attempts=0;
 other.command=async()=>{attempts++;throw new Error('No own compose service');};
 await assert.rejects(other.ensureEngine(),/занят другим сервером/);
 assert.equal(attempts,1);assert.equal(other.engineManaged,false);
});

test('closing waits for startup and jobs, stops only its service, and blocks new work',async()=>{
 const r=new Runtime({composePath:'/own/compose.json'}),events=[],controller=new AbortController();
 r.engineManaged=true;r.ready=true;r.aborts.set('job',controller);
 let finishStart,finishJob;
 r.startTask=new Promise(resolve=>{finishStart=resolve;});
 r.jobTasks.add(new Promise(resolve=>{finishJob=resolve;}));
 r.persist=async()=>events.push('persist');
 r.command=async(command,args)=>events.push([command,args]);
 const closing=r.close();assert.equal(r.close(),closing);
 assert.equal(controller.signal.aborted,true);assert.equal(r.ready,false);
 await assert.rejects(r.start(),/закрывается/);
 finishStart();await new Promise(setImmediate);assert.deepEqual(events,[]);
 finishJob();await closing;
 assert.deepEqual(events,['persist',['docker',['compose','-f','/own/compose.json','stop','--timeout','15','flow2api']]]);
 assert.equal(r.engineManaged,false);
});

test('close cancels startup commands and permits retry after an engine stop failure',async()=>{
 const r=new Runtime({composePath:'/own/compose.json'});r.engineManaged=true;
 r.startTask=new Promise(resolve=>r.startController.signal.addEventListener('abort',resolve,{once:true}));
 r.persist=async()=>{};let attempts=0;
 r.command=async()=>{if(++attempts===1)throw new Error('Docker unavailable');};
 await assert.rejects(r.close(),/Docker unavailable/);
 assert.equal(r.engineManaged,true);
 await r.close();assert.equal(attempts,2);assert.equal(r.engineManaged,false);
});

test('close waits for history load before persisting',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flow-history-close-'));t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const historyPath=path.join(folder,'history.json');
 const expected=[{id:'saved-job',status:'succeeded',media:[]}];
 await fs.writeFile(historyPath,JSON.stringify(expected));
 const originalReadFile=fs.readFile;let readStarted,releaseRead;
 const started=new Promise(resolve=>{readStarted=resolve});
 const release=new Promise(resolve=>{releaseRead=resolve});
 fs.readFile=async(target,...args)=>{const result=await originalReadFile(target,...args);if(target===historyPath){readStarted();await release;}return result;};
 t.after(()=>{fs.readFile=originalReadFile;releaseRead();});
 const r=new Runtime({dataDir:folder});
 const loading=r.initializeHistory();await started;
 let closed=false;const closing=r.close().finally(()=>{closed=true});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
 releaseRead();await loading;await closing;
 assert.deepEqual(JSON.parse(await originalReadFile(historyPath,'utf8')),expected);
});

test('account refresh waits for cold engine startup and shares the pending startup',async t=>{
 const r=new Runtime({}),calls=[];let releaseStart;
 const gate=new Promise(resolve=>{releaseStart=resolve;});
 r._start=async()=>{calls.push('start');await gate;r.ready=true;r.sessionCookie='synthetic-session';};
 r.login=async()=>{throw Error('Credentials must not be read before startup');};
 t.mock.method(globalThis,'fetch',async()=>{calls.push('accounts');return Response.json([{id:7,email:'test@example.invalid',is_active:true}]);});
 const first=r.refreshAccounts(),second=r.refreshAccounts();
 await new Promise(setImmediate);assert.deepEqual(calls,['start']);
 releaseStart();
 assert.equal((await first)[0].id,7);assert.equal((await second)[0].id,7);
 assert.deepEqual(calls,['start','accounts','accounts']);
});

test('failed startup blocks account requests before reading credentials or fetching',async t=>{
 const r=new Runtime({});r._start=async()=>{r.message='Не удалось запустить движок';};
 r.login=async()=>{throw Error('Must not read credentials');};
 const fetch=t.mock.method(globalThis,'fetch',async()=>{throw Error('Must not fetch');});
 await assert.rejects(r.refreshAccounts(),/Не удалось запустить движок/);
 assert.equal(fetch.mock.callCount(),0);
});

test('credential failures show a local-engine message without SQL, paths or secrets',async()=>{
 const raw=new Error('Command failed: docker compose -f /private/compose.yaml exec python SELECT username,password,api_key');
 raw.stderr='service "flow2api" is not running';raw.stdout='synthetic-secret';
 let error;
 try{await readCredentials('/private/flow.db','/private/compose.yaml',async()=>{throw raw;});}catch(value){error=value;}
 assert.equal(error.code,'ENGINE_NOT_RUNNING');assert.match(error.message,/движок.*не запущен/);
 assert.doesNotMatch(error.message,/SELECT|api_key|password|private|synthetic-secret|Command failed/);
 await assert.rejects(readCredentials('/private/flow.db','/private/compose.yaml',async()=>({stdout:'invalid json'})),value=>value.code==='ENGINE_CREDENTIALS_UNAVAILABLE'&&!/invalid json|private/.test(value.message));
});

test('concurrent starts share health probe and restart a stopped engine once',async()=>{
 const r=new Runtime({});r.ready=true;let releaseHealth,checks=0,starts=0;
 r.health=async()=>{checks++;await new Promise(resolve=>{releaseHealth=resolve;});return false;};
 r._start=async()=>{starts++;r.ready=true;return r.snapshot();};
 const first=r.start(),second=r.start();
 await new Promise(setImmediate);assert.equal(checks,1);
 releaseHealth();await Promise.all([first,second]);assert.equal(starts,1);
});

test('startup loads accounts without waiting on itself, including a local login retry',async t=>{
 const r=new Runtime({});let loads=0,accountReads=0;
 r.ensureEngine=async()=>{};
 r.command=async()=>{loads++;return {stdout:JSON.stringify({username:'synthetic',password:'test-only',apiKey:'test-only'})};};
 t.mock.method(globalThis,'fetch',async url=>{
  if(String(url).endsWith('/api/admin/login'))return Response.json({token:'test-only'});
  if(String(url).endsWith('/v1/models'))return Response.json({data:[{id:'test-model'}]});
  if(String(url).endsWith('/api/tokens'))return ++accountReads===1?Response.json({detail:'local expired'},{status:401}):Response.json([{id:7,email:'test@example.invalid',is_active:true}]);
  throw Error('Unexpected request');
 });
 const result=await r.start();assert.equal(result.ready,true);assert.equal(result.accounts[0].id,7);assert.equal(loads,2);assert.equal(accountReads,2);
});


test('account switch and delete use exact account and refresh confirmed state without touching history',async()=>{
 const r=new Runtime({dataDir:'/unused'}),calls=[];
 let rows=[{id:7,email:'owner@example.test',isActive:true}];
 r.jobs=[{id:'history',status:'succeeded'}];
 r.refreshAccounts=async()=>{r.accounts=rows;return rows;};
 r.request=async(endpoint,options)=>{
  calls.push([endpoint,options.method]);
  if(options.method==='DELETE')rows=[];
  else rows=[{...rows[0],isActive:endpoint.endsWith('/enable')}];
  return {success:true};
 };
 assert.equal((await r.setAccountActive(7,false)).accounts[0].isActive,false);
 assert.equal((await r.setAccountActive(7,true)).accounts[0].isActive,true);
 assert.deepEqual(await r.deleteAccount(7),{deleted:true,accounts:[]});
 assert.deepEqual(calls,[['/api/tokens/7/disable','POST'],['/api/tokens/7/enable','POST'],['/api/tokens/7','DELETE']]);
 assert.deepEqual(r.jobs,[{id:'history',status:'succeeded'}]);
 await assert.rejects(r.setAccountActive(7,true),/не найден/);
 await assert.rejects(r.setAccountActive(7,'false'),/Неверные/);
 r.jobs=[{status:'running'}];await assert.rejects(r.deleteAccount(7),/завершения генерации/);
});

test('bulk account check includes enabled only, runs serially, continues failures and skips disabled mid-check',async()=>{
 const events=[],r=new Runtime({onEvent:e=>events.push(e)});
 let rows=[{id:1,isActive:true},{id:2,isActive:false},{id:3,isActive:true},{id:4,isActive:true}];
 r.refreshAccounts=async()=>rows;
 const calls=[];let inflight=0,peak=0,finish;
 const options={checkAccount:async id=>{
  calls.push(id);peak=Math.max(peak,++inflight);
  try{
   if(id===1){await new Promise(resolve=>{finish=resolve;});rows=rows.map(x=>x.id===4?{...x,isActive:false}:x);throw new Error('rpc=nzlxg, code=401');}
   return {ok:true,checkedAt:'checked'};
  }finally{inflight--;}
 }};
 const task=r.checkEnabledAccounts(options);
 assert.equal(r.checkEnabledAccounts(options),task);
 await new Promise(setImmediate);assert.deepEqual(calls,[1]);finish();
 const result=await task;
 assert.deepEqual(calls,[1,3]);assert.equal(peak,1);
 assert.equal(result.total,3);assert.equal(result.checked,3);assert.equal(result.verified,1);assert.equal(result.failed,1);assert.equal(result.skipped,1);
 assert.equal(result.results[0].message,'rpc=nzlxg, code=401');
 assert.equal(events.at(-1).running,false);assert.equal(r.accountCheckTask,null);
 assert.deepEqual(events.filter(e=>e.status==='checking').map(e=>e.accountId),[1,3]);
});


test('late account refresh cannot restore old toggle state or a deleted row',async()=>{
 const events=[],r=new Runtime({onEvent:e=>events.push(e)}),requests=[];
 r.request=async()=>new Promise(resolve=>requests.push(resolve));
 const first=r.refreshAccounts(),second=r.refreshAccounts();
 requests[1]([{id:7,email:'owner@example.test',is_active:false}]);await second;
 requests[0]([{id:7,email:'owner@example.test',is_active:true}]);await first;
 assert.equal(r.accounts[0].isActive,false);assert.equal(events.length,1);
 const stale=r.refreshAccounts();
 r.accountAppliedVersion=++r.accountRefreshVersion;r.accounts=[];
 requests[2]([{id:7,email:'owner@example.test',is_active:true}]);await stale;
 assert.deepEqual(r.accounts,[]);assert.equal(events.length,1);
});
