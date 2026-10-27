const {test}=require('node:test');
const assert=require('node:assert/strict');
const {consumeGeneration,extractMedia,allowedMediaUrl,publicAccount,Runtime}=require('./runtime.cjs');
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
  ['up','-d','--build','flow2api'],
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
