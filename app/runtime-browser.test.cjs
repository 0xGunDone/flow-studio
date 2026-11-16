'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {Runtime}=require('./runtime.cjs');
const MODEL='omni-1.2-flash-8s-landscape';
const IMAGE='data:image/png;base64,aW5ncmVkaWVudA==';
const account=(id,extra={})=>({id,email:`account-${id}@example.test`,isActive:true,videoEnabled:true,...extra});
const deferred=()=>{let resolve;const promise=new Promise(value=>{resolve=value;});return {promise,resolve};};
async function fixture(t,accounts=[account(7)]){
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'flow-browser-runtime-'));
 t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const events=[],r=new Runtime({dataDir:folder,onEvent:event=>events.push(event)});
 r.ready=true;r.models=[{id:MODEL},{id:'gemini-3.1-flash-image-landscape'}];r.accounts=accounts;
 r.start=async()=>r.snapshot();r.refreshAccounts=async()=>r.accounts;
 r.command=async()=>{throw new Error('Browser generation must not read legacy credentials or submit to the server');};
 const file=path.join(folder,'download.mp4');await fs.writeFile(file,'synthetic-video-result');
 return {r,folder,file,events,settle:()=>Promise.all([...r.jobTasks])};
}
const localResult=(file,id=7)=>({media:[{path:file,kind:'video',mediaGenerationId:'source-generation-id'}],accountId:id,accountEmail:account(id).email});

test('supported generation routes automatically, selects one eligible profile and retains normal history/media',async t=>{
 const paused=new Date(Date.now()+60000).toISOString();
 const {r,file,folder,events,settle}=await fixture(t,[account(1,{isActive:false}),account(2,{videoEnabled:false}),account(3,{cooldownUntil:paused}),account(4,{browserReady:false}),account(7)]);
 let calls=0,cacheCalls=0;
 r.cacheMedia=async()=>{cacheCalls++;throw new Error('Must not download an already local file');};
 r.attachBrowserEngine({supports:input=>input.model===MODEL,generate:async(input,{signal,onProgress,onAccount,beforeSubmit})=>{
  calls++;assert.equal(signal.aborted,false);assert.equal(input.prompt,'Exact prompt');
  assert.deepEqual(input.references,[{kind:'image',dataUrl:IMAGE}]);assert.equal(input.accountId,7);
  onAccount({id:7,email:'ACCOUNT-7@example.test'});onProgress('Rendering');await beforeSubmit();
  const saved=JSON.parse(await fs.readFile(path.join(folder,'history.json'),'utf8'))[0];
  assert.equal(saved.status,'running');assert.equal(saved.unknownOutcome,true);assert.equal(saved.accountId,7);
  return localResult(file);
 }});
 const {jobId}=r.generate({model:MODEL,prompt:'  Exact prompt  ',references:[{kind:'image',dataUrl:IMAGE}]});await settle();
 const job=r.publicJob(r.jobs[0]);assert.equal(job.id,jobId);assert.equal(job.status,'succeeded');assert.equal(job.unknownOutcome,false);assert.equal(job.generationEngine,'isolated-browser');
 assert.equal(job.retryAvailable,true);assert.equal(job.media[0].url,`flow-media://${jobId}/0`);
 assert.equal(job.media[0].mediaGenerationId,'source-generation-id');assert.equal(r.mediaFile(jobId,0),file);
 assert.equal(calls,1);assert.equal(cacheCalls,0);assert(events.some(event=>event.job?.progress==='Rendering'));
 assert.doesNotMatch(JSON.stringify(r.publicJobs()),/base64/);
 const disk=JSON.parse(await fs.readFile(path.join(folder,'history.json'),'utf8'))[0];assert.equal(disk.media[0].path,file);assert.equal(disk.unknownOutcome,false);
});

test('pre-submit guard durably writes unknown outcome before allowing one click and deduplicates UUID',async t=>{
 const {r,file,folder,settle}=await fixture(t),persisted=deferred(),release=deferred();
 t.after(()=>release.resolve());
 const persist=r.persist.bind(r);let writes=0,clicks=0,flush=false;
 const writeFile=fs.writeFile.bind(fs);
 t.mock.method(fs,'writeFile',async(target,data,options)=>{if(String(target).endsWith('history.json.tmp'))flush=options.flush===true;return writeFile(target,data,options);});
 r.persist=async()=>{await persist();if(++writes===2){persisted.resolve();await release.promise;}};
 r.attachBrowserEngine({supports:()=>true,generate:async(_input,{beforeSubmit})=>{await beforeSubmit();clicks++;return localResult(file);}});
 const input={model:MODEL,prompt:'One click',requestId:'request-uuid',accountId:7},first=r.generate(input);
 await persisted.promise;
 assert.equal(clicks,0);assert.equal(flush,true);assert.equal(r.jobs[0].status,'running');
 assert.equal(JSON.parse(await fs.readFile(path.join(folder,'history.json'),'utf8'))[0].unknownOutcome,true);
 assert.deepEqual(r.generate(input),first);assert.equal(r.jobs.length,1);
 assert.throws(()=>r.generate({...input,accountId:8}),/requestId/);
 assert.throws(()=>r.generate({...input,requestId:'another-uuid'}),/текущей генерации/);
 release.resolve();await settle();assert.equal(clicks,1);assert.deepEqual(r.generate(input),first);
});

test('failed pre-submit persistence blocks click and remains a known unsent result',async t=>{
 const {r,settle}=await fixture(t);let writes=0,clicks=0;
 const persist=r.persist.bind(r);r.persist=async()=>{if(++writes===2)throw new Error('Synthetic disk full');return persist();};
 r.attachBrowserEngine({supports:()=>true,generate:async(_input,{beforeSubmit})=>{await beforeSubmit();clicks++;throw new Error('Must not click');}});
 r.generate({model:MODEL,prompt:'Never submit'});await settle();
 assert.equal(clicks,0);assert.equal(r.jobs[0].status,'failed');assert.equal(r.jobs[0].unknownOutcome,false);assert.match(r.jobs[0].error,/disk full/);
 assert.equal(r.publicJob(r.jobs[0]).retryAvailable,true);
});

test('browser failure keeps exact account/error, never invokes legacy fallback, and retry survives restart pinned',async t=>{
 const {r,file,folder,settle}=await fixture(t),inputs=[];let legacy=0;
 t.mock.method(http,'request',()=>{legacy++;throw new Error('Must not fall back to legacy');});
 const engine={supports:input=>input.model===MODEL,generate:async(input,{beforeSubmit})=>{
  inputs.push(input);await beforeSubmit();
  if(inputs.length===1){const error=new Error('rpc=MZZa6b, code=401');error.code='generation_failed';error.generationTerminal=true;throw error;}
  return localResult(file);
 }};
 r.attachBrowserEngine(engine);const original=r.generate({model:MODEL,prompt:'Pinned retry',references:[{kind:'image',dataUrl:IMAGE}],requestId:'original-uuid'}).jobId;await settle();
 assert.equal(r.jobs[0].status,'failed');assert.equal(r.jobs[0].unknownOutcome,false);assert.equal(r.jobs[0].needsLogin,true);
 assert.equal(r.jobs[0].errorCode,'generation_failed');assert.equal(r.jobs[0].accountId,7);assert.equal(r.jobs[0].accountEmail,account(7).email);assert.equal(legacy,0);
 const reloaded=new Runtime({dataDir:folder});await reloaded.initializeHistory();
 reloaded.ready=true;reloaded.models=r.models;reloaded.accounts=[account(9),account(7)];reloaded.start=async()=>{};reloaded.refreshAccounts=async()=>reloaded.accounts;
 reloaded.command=r.command;reloaded.attachBrowserEngine(engine);
 const input={jobId:original,requestId:'retry-uuid'},first=reloaded.retryGeneration(input);
 assert.equal(first,reloaded.retryGeneration(input));const retry=await first;await Promise.all([...reloaded.jobTasks]);
 assert.deepEqual(await reloaded.retryGeneration(input),retry);assert.equal(inputs.length,2);assert.equal(inputs[1].accountId,7);
 assert.deepEqual(inputs[1].references,inputs[0].references);assert.equal(inputs[1].prompt,inputs[0].prompt);assert.equal(inputs[1].model,MODEL);
 assert.equal(reloaded.jobs[0].retryOf,original);assert.equal(reloaded.jobs[0].status,'succeeded');assert.equal(legacy,0);
});

for(const submitted of [false,true])test(`cancellation ${submitted?'after':'before'} submission waits for engine and records ${submitted?'unknown':'known'} outcome`,async t=>{
 const {r,settle}=await fixture(t),entered=deferred(),release=deferred();let engineSignal;
 t.after(()=>release.resolve());
 r.attachBrowserEngine({supports:()=>true,generate:async(_input,{signal,beforeSubmit})=>{
  engineSignal=signal;if(submitted)await beforeSubmit();entered.resolve();await release.promise;signal.throwIfAborted();throw new Error('Must be aborted');
 }});
 const {jobId}=r.generate({model:MODEL,prompt:'Cancel this'});await entered.promise;
 assert.deepEqual(r.cancelGeneration(jobId),{cancelled:true,jobId});assert.equal(engineSignal.aborted,true);
 assert.equal(r.jobs[0].status,'running');assert.throws(()=>r.generate({model:MODEL,prompt:'Next'}),/текущей генерации/);
 release.resolve();await settle();assert.equal(r.jobs[0].status,'failed');assert.equal(r.jobs[0].unknownOutcome,submitted);
 assert.equal(r.publicJob(r.jobs[0]).retryAvailable,!submitted);assert.match(r.jobs[0].error,submitted?/могла продолжиться/:/до отправки/);
 assert.deepEqual(r.cancelGeneration(jobId),{cancelled:false,jobId});assert.throws(()=>r.cancelGeneration('missing'),/не найдена/);
});

test('closing awaits submitted browser work and preserves unknown history without server shutdown access',async t=>{
 const {r,folder}=await fixture(t),entered=deferred(),release=deferred();let signal;
 t.after(()=>release.resolve());
 r.attachBrowserEngine({supports:()=>true,generate:async(_input,options)=>{signal=options.signal;await options.beforeSubmit();entered.resolve();await release.promise;signal.throwIfAborted();}});
 r.generate({model:MODEL,prompt:'Close after submission'});await entered.promise;
 let closed=false;const closing=r.close().then(()=>{closed=true;});
 await new Promise(setImmediate);assert.equal(signal.aborted,true);assert.equal(closed,false);assert.equal(r.jobs[0].status,'running');
 release.resolve();await closing;
 assert.equal(r.jobs[0].unknownOutcome,true);assert.equal(r.jobs[0].status,'failed');assert.equal(r.publicJob(r.jobs[0]).retryAvailable,false);
 assert.equal(JSON.parse(await fs.readFile(path.join(folder,'history.json'),'utf8'))[0].unknownOutcome,true);
});

test('selection honors explicit account/cooldown and missing profile fails once without rotating',async t=>{
 const {r,settle}=await fixture(t,[account(7,{cooldownUntil:new Date(Date.now()+60000).toISOString()}),account(9,{browserReady:false})]);
 const inputs=[];r.attachBrowserEngine({supports:()=>true,generate:async input=>{inputs.push(input);const error=new Error('Подключите профиль Google для этого аккаунта.');error.code='PROFILE_REQUIRED';throw error;}});
 r.generate({model:MODEL,prompt:'Pinned paused account',accountId:7});await settle();
 assert.equal(inputs.length,0);assert.equal(r.jobs[0].errorCode,'account_cooldown');assert.equal(r.jobs[0].unknownOutcome,false);
 r.generate({model:MODEL,prompt:'Only missing profile remains'});await settle();
 assert.deepEqual(inputs.map(input=>input.accountId),[9]);assert.equal(r.jobs[0].accountId,9);assert.equal(r.jobs[0].errorCode,'PROFILE_REQUIRED');assert.equal(r.jobs[0].unknownOutcome,false);
 r.accounts=[account(9,{cooldownUntil:new Date(Date.now()+60000).toISOString()}),account(10)];
 await assert.rejects(r.retryGeneration({jobId:r.jobs[0].id,requestId:'paused-retry'}),/паузе/);assert.equal(inputs.length,1);
 for(const accountId of [null,0,-1,1.5,'7'])assert.throws(()=>r.generate({model:MODEL,prompt:'Invalid account',accountId}),/аккаунт/);
});

test('browser account mismatch and invalid results remain attributed without silent resubmission',async t=>{
 const {r,file,settle}=await fixture(t);let calls=0;
 for(const mode of ['mismatched-account','unsubmitted-output','empty','invalid-url','second-submit']){
  r.attachBrowserEngine({supports:()=>true,generate:async(_input,{onAccount,beforeSubmit})=>{
   calls++;if(mode==='mismatched-account')onAccount({id:9,email:account(9).email});
   if(mode==='unsubmitted-output')return localResult(file);
   await beforeSubmit();
   if(mode==='second-submit')await beforeSubmit();
   return {media:mode==='empty'?[]:[{kind:'video',url:'http://192.168.1.1/private'}]};
  }});
  r.generate({model:MODEL,prompt:mode});await settle();
  assert.equal(r.jobs[0].status,'failed');assert.equal(r.jobs[0].accountId,7);assert.equal(r.jobs[0].unknownOutcome,!['mismatched-account','unsubmitted-output'].includes(mode));
  if(mode==='mismatched-account')assert.equal(r.jobs[0].errorCode,'account_changed');
 }
 assert.equal(calls,5);
});

test('allowed browser URL uses existing download cache and local file path skips downloads',async t=>{
 const {r,settle}=await fixture(t);let downloads=0;
 t.mock.method(globalThis,'fetch',async url=>{downloads++;assert.equal(url,'https://flow-content.google/result.mp4');return new Response('synthetic-video-result');});
 r.attachBrowserEngine({supports:()=>true,generate:async(_input,{beforeSubmit})=>{await beforeSubmit();return {accountId:7,media:[{kind:'video',url:'https://flow-content.google/result.mp4',mediaGenerationId:'result-id'}]};}});
 const {jobId}=r.generate({model:MODEL,prompt:'Download result'});await settle();
 assert.equal(r.jobs[0].status,'succeeded');assert.equal(downloads,1);
 assert.equal(await fs.readFile(r.mediaFile(jobId,0),'utf8'),'synthetic-video-result');assert.equal(r.jobs[0].media[0].mediaGenerationId,'result-id');
});

test('browser output paths must be absolute nonempty regular files without symlinks',async t=>{
 const {r,file,folder,settle}=await fixture(t);
 const empty=path.join(folder,'empty.mp4'),symlink=path.join(folder,'link.mp4');await fs.writeFile(empty,'');await fs.symlink(file,symlink);
 for(const output of ['relative.mp4',empty,symlink,folder]){
  r.attachBrowserEngine({supports:()=>true,generate:async(_input,{beforeSubmit})=>{await beforeSubmit();return {media:[{kind:'video',path:output}]};}});
  r.generate({model:MODEL,prompt:'Validate local output'});await settle();assert.equal(r.jobs[0].status,'failed');assert.equal(r.jobs[0].unknownOutcome,true);assert.deepEqual(r.jobs[0].media,[]);
 }
});

test('unsupported models retain legacy route and engine attachment cannot change an active route',async t=>{
 const {r,file,settle}=await fixture(t);let browserCalls=0,route;
 const unsupported={supports:()=>false,generate:async()=>{browserCalls++;throw new Error('Must not be used');}};
 r.attachBrowserEngine(unsupported);
 const runJob=r.runJob;r.runJob=async(...args)=>{route=args[4].browserEngine;};
 r.generate({model:'gemini-3.1-flash-image-landscape',prompt:'Legacy image'});await settle();assert.equal(route,null);assert.equal(browserCalls,0);
 assert.equal(r.publicJob(r.jobs[0]).generationEngine,'server');
 r.jobs[0].status='succeeded';r.runJob=runJob;
 const entered=deferred(),release=deferred();t.after(()=>release.resolve());r.attachBrowserEngine({supports:()=>true,generate:async(_input,{beforeSubmit})=>{await beforeSubmit();entered.resolve();await release.promise;return localResult(file);}});
 r.generate({model:MODEL,prompt:'Keep selected route'});await entered.promise;
 assert.throws(()=>r.attachBrowserEngine(unsupported),/завершения/);release.resolve();await settle();assert.equal(browserCalls,0);
 assert.throws(()=>r.attachBrowserEngine({}),/Неверный/);
});

test('verified browser account failure persists private cooldown across restart and supports confirmed manual reset',async t=>{
 const {r,folder,settle}=await fixture(t),rows=[{id:7,email:account(7).email,is_active:true,video_enabled:true}],calls=[];let submissions=0;
 const request=async(endpoint,options)=>{calls.push([endpoint,options?.method||'GET']);if(endpoint==='/api/tokens')return rows;if(endpoint==='/api/tokens/7/clear-cooldown')return {success:true};assert.fail(endpoint);};
 r.request=request;r.refreshAccounts=Runtime.prototype.refreshAccounts.bind(r);
 r.attachBrowserEngine({supports:()=>true,generate:async(_input,{beforeSubmit})=>{await beforeSubmit();submissions++;throw Object.assign(new Error('Google Flow отклонил запрос аккаунта.'),{code:'FLOW_GENERATION_REJECTED',generationTerminal:true,accountFailure:true});}});
 const before=Date.now(),original=r.generate({model:MODEL,prompt:'Known account failure'}).jobId;await settle();
 assert.equal(submissions,1);assert.equal(r.jobs[0].unknownOutcome,false);assert.equal(r.accounts[0].cooldownResetAllowed,true);
 assert(Date.parse(r.accounts[0].cooldownUntil)>=before+30*60*1000);assert(r.accounts[0].cooldownRemainingSeconds>=1799);
 const statePath=path.join(folder,'browser-account-state.json'),state=JSON.parse(await fs.readFile(statePath,'utf8'));
 assert.equal((await fs.stat(statePath)).mode&0o777,0o600);assert.equal(state.version,1);assert.equal(state.accounts[0].id,7);
 assert.doesNotMatch(JSON.stringify(state),/prompt|base64|privateInput/);
 const reloaded=new Runtime({dataDir:folder});await reloaded.initializeHistory();reloaded.ready=true;reloaded.models=r.models;reloaded.start=async()=>{};reloaded.request=request;
 await reloaded.refreshAccounts();assert.equal(reloaded.accounts[0].cooldownUntil,r.accounts[0].cooldownUntil);
 await assert.rejects(reloaded.retryGeneration({jobId:original,requestId:'cooling-retry'}),/паузе/);assert.equal(submissions,1);
 const result=await reloaded.clearCooldown(7);assert.equal(result.cleared,true);assert.equal(result.accounts[0].cooldownUntil,null);
 assert.match(result.accounts[0].lastGenerationError,/отклонил/);assert.equal(result.accounts[0].cooldownRemainingSeconds,0);
 assert.equal(calls.filter(([endpoint])=>endpoint.endsWith('/clear-cooldown')).length,1);
 const afterReset=new Runtime({dataDir:folder});await afterReset.initializeHistory();afterReset.request=request;await afterReset.refreshAccounts();assert.equal(afterReset.accounts[0].cooldownUntil,null);
});

test('Google unusual activity keeps automatic cooldown across restart until explicit reset preserves error and account disable',async t=>{
 const {r,folder,settle}=await fixture(t),row={id:7,email:account(7).email,is_active:true};let resets=0;
 const request=async(endpoint)=>{if(endpoint==='/api/tokens')return [{...row}];if(endpoint.endsWith('/clear-cooldown')){resets++;return {success:true};}assert.fail(endpoint);};
 r.request=request;r.refreshAccounts=Runtime.prototype.refreshAccounts.bind(r);
 r.attachBrowserEngine({supports:()=>true,generate:async(_input,{beforeSubmit})=>{await beforeSubmit();throw Object.assign(new Error('Google Flow сообщил о необычной активности.'),{code:'FLOW_GENERATION_REJECTED',publicCode:'PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC',generationTerminal:true,accountFailure:true});}});
 r.generate({model:MODEL,prompt:'Unusual activity'});await settle();const until=r.accounts[0].cooldownUntil;
 assert.equal(r.accounts[0].cooldownResetAllowed,true);assert.match(r.accounts[0].lastGenerationError,/PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC/);assert.equal(resets,0);
 const reloaded=new Runtime({dataDir:folder});await reloaded.initializeHistory();reloaded.request=request;await reloaded.refreshAccounts();
 assert.equal(reloaded.accounts[0].cooldownUntil,until);assert.equal(reloaded.accounts[0].cooldownResetAllowed,true);assert.equal(resets,0);
 const previous=reloaded.browserAccountState.get(7);reloaded.recordBrowserAccountFailure({accountId:7,accountEmail:account(7).email},Object.assign(new Error('Later generic error'),{generationTerminal:true,accountFailure:true}));
 assert.deepEqual(reloaded.browserAccountState.get(7),previous,'Later error cannot shorten or unlock unusual activity hold');
 row.is_active=false;
 const reset=await reloaded.clearCooldown(7);assert.equal(reset.accounts[0].cooldownResetAllowed,true);assert.equal(reset.accounts[0].cooldownUntil,null);assert.equal(resets,1);
 assert.equal(reset.accounts[0].isActive,false);assert.match(reset.accounts[0].lastGenerationError,/PUBLIC_ERROR_UNUSUAL_ACTIVITY/);
});

test('local/browser preparation errors and content rejections never create account cooldown',async t=>{
 const {r,settle}=await fixture(t);
 for(const error of [
  Object.assign(new Error('Local upload failed'),{code:'INVALID_REFERENCE'}),
  Object.assign(new Error('Local preparation failed'),{code:'PREPARED_INPUT_CHANGED',generationTerminal:true}),
  Object.assign(new Error('Unclassified browser error'),{code:'FLOW_GENERATION_REJECTED',generationTerminal:true}),
  ...['PUBLIC_ERROR_MINOR','PUBLIC_ERROR_UNSAFE_GENERATION','PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED'].map(publicCode=>Object.assign(new Error(publicCode),{code:'FLOW_GENERATION_REJECTED',publicCode,generationTerminal:true,accountFailure:true})),
 ]){
  r.attachBrowserEngine({supports:()=>true,generate:async()=>{throw error;}});
  r.generate({model:MODEL,prompt:'No cooldown for '+error.code});await settle();assert.equal(r.browserAccountState.size,0);assert.equal(r.accounts[0].cooldownUntil,undefined);
 }
});

test('browser cooldown overlay preserves later backend expiry and lock and never follows account id to another email',async()=>{
 const r=new Runtime({}),now=Date.now(),localUntil=new Date(now+30*60*1000).toISOString();
 r.browserAccountState.set(7,{id:7,email:account(7).email,cooldownUntil:localUntil,lastGenerationError:'Local account failure',lastGenerationErrorAt:new Date(now).toISOString()});
 const backendUntil=new Date(now+60*60*1000).toISOString(),row={id:7,email:account(7).email,cooldownUntil:backendUntil,cooldownResetAllowed:false,lastGenerationError:'PUBLIC_ERROR_UNUSUAL_ACTIVITY',lastGenerationErrorAt:new Date(now+1000).toISOString()};
 const merged=r.withBrowserCooldown(row);assert.equal(merged.cooldownUntil,backendUntil);assert.equal(merged.cooldownResetAllowed,true);assert.equal(merged.lastGenerationError,row.lastGenerationError);
 const changed={...row,email:'changed@example.test',cooldownUntil:null,cooldownResetAllowed:true};assert.deepEqual(r.withBrowserCooldown(changed),changed);
 const backendShorter={...row,cooldownUntil:new Date(now+60000).toISOString(),cooldownResetAllowed:true};assert.equal(r.withBrowserCooldown(backendShorter).cooldownUntil,localUntil);
});

test('unknown browser job recovers same durable identity/media without new generation, inputs or request',async t=>{
 const {r,file,folder,settle}=await fixture(t),entered=deferred(),release=deferred();t.after(()=>release.resolve());let recoveries=0;
 const job={id:'existing-unknown',model:MODEL,prompt:'Original exact request',status:'failed',unknownOutcome:true,generationEngine:'isolated-browser',accountId:7,accountEmail:account(7).email,requestId:'original-request',error:'Old tracking timeout',errorCode:'FLOW_UI_TIMEOUT',media:[]};r.jobs=[job];
 r.saveRetryInput=async()=>assert.fail('Recovery cannot create new inputs');
 r.attachBrowserEngine({supports:()=>true,generate:()=>assert.fail('Recovery cannot submit generation'),recover:async(id,{signal,onProgress,expected})=>{recoveries++;assert.equal(id,job.id);assert.deepEqual(expected,{accountId:7,accountEmail:account(7).email,model:MODEL,prompt:job.prompt});assert.equal(signal.aborted,false);onProgress('Found existing video');entered.resolve();await release.promise;return localResult(file);}});
 assert.equal(r.publicJob(job).recoveryAvailable,true);const result=r.recoverGeneration(job.id);assert.deepEqual(result,{jobId:job.id});await entered.promise;
 assert.equal(job.status,'running');assert.equal(job.recovering,true);assert.equal(job.unknownOutcome,true);assert.equal(r.jobs.length,1);
 assert.throws(()=>r.recoverGeneration(job.id),/текущей генерации/);assert.throws(()=>r.generate({model:MODEL,prompt:'New request'}),/текущей генерации/);
 release.resolve();await settle();assert.equal(recoveries,1);assert.equal(r.jobs.length,1);assert.equal(job.requestId,'original-request');assert.equal(job.status,'succeeded');assert.equal(job.unknownOutcome,false);assert.equal(job.media[0].path,file);assert.equal(job.error,undefined);assert.equal(job.errorCode,undefined);assert.equal(job.recovering,undefined);
 assert.equal(JSON.parse(await fs.readFile(path.join(folder,'history.json'),'utf8'))[0].id,job.id);assert.equal(r.retryInputs.size,0);
});

test('recovery failure or cancellation preserves unknown outcome and never generates again',async t=>{
 const {r,settle}=await fixture(t);let calls=0;
 const job={id:'unknown-recovery',model:MODEL,prompt:'same',status:'failed',unknownOutcome:true,generationEngine:'isolated-browser',accountId:7,accountEmail:account(7).email,media:[]};r.jobs=[job];
 r.attachBrowserEngine({supports:()=>true,generate:()=>assert.fail('Must not generate'),recover:async()=>{calls++;throw Object.assign(new Error('Receipt missing'),{code:'BROWSER_RECEIPT_MISSING'});}});
 r.recoverGeneration(job.id);await settle();assert.equal(job.unknownOutcome,true);assert.equal(job.errorCode,'BROWSER_RECEIPT_MISSING');assert.equal(r.publicJob(job).recoveryAvailable,false);assert.throws(()=>r.recoverGeneration(job.id),/не сохранена/);assert.equal(calls,1);
 delete job.errorCode;const entered=deferred(),release=deferred();t.after(()=>release.resolve());
 r.attachBrowserEngine({supports:()=>true,generate:()=>assert.fail('Must not generate'),recover:async(_id,{signal})=>{entered.resolve();await release.promise;signal.throwIfAborted();}});
 r.recoverGeneration(job.id);await entered.promise;r.cancelGeneration(job.id);assert.equal(job.status,'running');release.resolve();await settle();assert.equal(job.unknownOutcome,true);assert.equal(job.status,'failed');assert.match(job.error,/не отправлялась повторно/);assert.equal(r.jobs.length,1);
});

test('recovery guards active work and identity mismatch; only confirmed provider terminal outcome resolves uncertainty',async t=>{
 const {r,file,settle}=await fixture(t);const job={id:'guarded',model:MODEL,prompt:'same',status:'failed',unknownOutcome:true,generationEngine:'isolated-browser',accountId:7,accountEmail:account(7).email,media:[]};r.jobs=[job];
 r.attachBrowserEngine({supports:()=>true,generate:()=>assert.fail('Must not generate'),recover:async()=>localResult(file,9)});
 for(const key of ['accountActionPending','accountCheckTask','retryTask','nativeBrowserPending']){r[key]=true;assert.throws(()=>r.recoverGeneration(job.id),/текущего действия/);r[key]=null;}
 r.ready=false;assert.throws(()=>r.recoverGeneration(job.id),/запускается/);r.ready=true;
 r.recoverGeneration(job.id);await settle();assert.equal(job.errorCode,'account_changed');assert.equal(job.unknownOutcome,true);assert.deepEqual(job.media,[]);
 r.attachBrowserEngine({supports:()=>true,generate:()=>assert.fail('Must not generate'),recover:async()=>{throw Object.assign(new Error('PUBLIC_ERROR_UNSAFE_GENERATION'),{code:'PUBLIC_ERROR_UNSAFE_GENERATION',generationTerminal:true,unknownOutcome:false});}});
 r.recoverGeneration(job.id);await settle();assert.equal(job.unknownOutcome,false);assert.equal(r.publicJob(job).recoveryAvailable,false);assert.equal(r.jobs.length,1);
});
test('read-only recovery permits paused or disabled original account but rejects changed identity before opening engine',async t=>{
 const {r,file,settle}=await fixture(t,[account(7,{isActive:false,cooldownUntil:new Date(Date.now()+60000).toISOString()})]);let calls=0;
 const job={id:'read-existing',model:MODEL,prompt:'original',status:'failed',unknownOutcome:true,generationEngine:'isolated-browser',accountId:7,accountEmail:account(7).email,media:[]};r.jobs=[job];
 r.attachBrowserEngine({supports:()=>true,generate:()=>assert.fail('Must not generate'),recover:async()=>{calls++;return localResult(file);}});
 r.recoverGeneration(job.id);await settle();assert.equal(calls,1);assert.equal(job.status,'succeeded');
 job.status='failed';job.unknownOutcome=true;r.accounts[0].email='changed@example.test';
 r.recoverGeneration(job.id);await settle();assert.equal(calls,1);assert.equal(job.unknownOutcome,true);assert.equal(job.errorCode,'account_changed');
});
test('browser video metadata inspects immutable staged file through existing local module and always removes staging',async t=>{
 const {r,folder}=await fixture(t),source=path.join(folder,'source.mov'),inputFolder=path.join(folder,'engine','tmp','flow-studio-inputs');await fs.writeFile(source,'immutable-video-bytes');
 r.databasePath=path.join(folder,'engine','data','flow.db');r.composePath=path.join(folder,'compose.json');let calls=0;
 r.command=async(command,args,options)=>{
  calls++;assert.equal(command,'docker');assert.deepEqual(args.slice(0,8),['compose','-f',r.composePath,'exec','-T','flow2api','python','-c']);assert.match(args[8],/read_video_reference/);assert.match(args[8],/max_duration_seconds=15/);assert.doesNotMatch(args[8],/print.*\['bytes'\]/);
  const reference=JSON.parse(args[9]);assert.match(reference.file_id,/^[a-f0-9-]{36}\.mov$/);assert.equal(reference.mime_type,'video/quicktime');const staged=path.join(inputFolder,reference.file_id);assert.equal(await fs.readFile(staged,'utf8'),'immutable-video-bytes');assert.equal((await fs.stat(staged)).mode&0o777,0o600);assert.equal(options.maxBuffer,65536);assert.equal(options.timeout,30000);
  await fs.writeFile(source,'changed-after-staging');assert.equal(await fs.readFile(staged,'utf8'),'immutable-video-bytes');return {stdout:JSON.stringify({duration:3.029333,mimeType:reference.mime_type,filename:reference.filename,width:360,height:640})};
 };
 assert.deepEqual(await r.inspectBrowserVideo(source),{duration:3.029333,durationSeconds:3.029333,mimeType:'video/quicktime',filename:'source.mov',width:360,height:640});assert.equal(calls,1);assert.deepEqual(await fs.readdir(inputFolder),[]);
 for(const response of ['invalid-json',JSON.stringify({duration:16,mimeType:'video/quicktime'}),JSON.stringify({duration:3,mimeType:'video/mp4'})]){r.command=async()=>({stdout:response});await assert.rejects(r.inspectBrowserVideo(source));assert.deepEqual(await fs.readdir(inputFolder),[]);}
 r.command=async()=>{throw Object.assign(new Error('Synthetic local probe failed'),{code:'PROBE_FAILED'});};await assert.rejects(r.inspectBrowserVideo(source),{code:'PROBE_FAILED'});assert.deepEqual(await fs.readdir(inputFolder),[]);
 const controller=new AbortController();controller.abort();await assert.rejects(r.inspectBrowserVideo(source,{signal:controller.signal}),{name:'AbortError'});assert.deepEqual(await fs.readdir(inputFolder),[]);
});
test('background image generation accepts active image account even when video is disabled',async t=>{
 const {r,file,settle}=await fixture(t,[account(7,{videoEnabled:false})]);const model='gemini-3.1-flash-image-landscape';let inputs=0;
 r.attachBrowserEngine({supports:input=>input.model===model,generate:async(input,{beforeSubmit})=>{inputs++;assert.equal(input.accountId,7);assert.deepEqual(input.references,[{kind:'image',dataUrl:IMAGE}]);await beforeSubmit();return {media:[{kind:'image',path:file}],accountId:7,accountEmail:account(7).email};}});
 r.generate({model,prompt:'image with source',images:[IMAGE]});await settle();assert.equal(inputs,1);assert.equal(r.jobs[0].status,'succeeded');assert.equal(r.jobs[0].kind,'image');assert.equal(r.jobs[0].generationEngine,'isolated-browser');assert.equal(r.accounts[0].videoEnabled,false);
});
test('explicit participation persists browser eligibility through server automatic disable without enabling backend',async t=>{
 const {r,folder,file,settle}=await fixture(t);let row={id:7,email:account(7).email,is_active:false,ban_reason:null},mutations=0;
 r.refreshAccounts=Runtime.prototype.refreshAccounts.bind(r);r.request=async(endpoint,options)=>{if(endpoint==='/api/tokens')return [{...row}];if(options?.method==='POST'&&endpoint.endsWith('/enable')){mutations++;row.is_active=true;row.ban_reason=null;return {success:true};}assert.fail(endpoint);};
 await r.refreshAccounts();assert.equal(r.accounts[0].isActive,false,'Unknown inactive account stays inactive without explicit intent');
 await r.setAccountActive(7,true);row.is_active=false;await r.refreshAccounts();assert.equal(r.accounts[0].serverActive,false);assert.equal(r.accounts[0].isActive,true);assert.equal(r.accounts[0].manualDisabled,false);assert.equal(mutations,1);
 const state=path.join(folder,'account-participation.json');assert.equal((await fs.stat(state)).mode&0o777,0o600);assert.deepEqual(JSON.parse(await fs.readFile(state,'utf8')).accounts,[{id:7,email:row.email,enabled:true}]);
 const reloaded=new Runtime({dataDir:folder});await reloaded.initializeHistory();reloaded.ready=true;reloaded.models=r.models;reloaded.start=async()=>{};reloaded.request=r.request;
 await reloaded.refreshAccounts();assert.equal(reloaded.accounts[0].isActive,true);assert.equal(reloaded.accounts[0].serverActive,false);
 reloaded.attachBrowserEngine({supports:()=>true,generate:async(_input,{beforeSubmit})=>{await beforeSubmit();return localResult(file);}});reloaded.generate({model:MODEL,prompt:'Browser uses explicit intent'});await Promise.all([...reloaded.jobTasks]);assert.equal(reloaded.jobs[0].status,'succeeded');assert.equal(mutations,1,'Browser eligibility never reenables server automatically');
 row.ban_reason='manual_disabled';await reloaded.refreshAccounts();assert.equal(reloaded.accounts[0].isActive,false,'Explicit backend manual disable always wins');
 row.email='changed@example.test';row.ban_reason=null;await reloaded.refreshAccounts();assert.equal(reloaded.accountParticipation.size,0);assert.equal(reloaded.accounts[0].isActive,false);
});
test('participation records only confirmed changes and preserves explicit disabled state and removal across restart',async t=>{
 const {r,folder}=await fixture(t);let rows=[{id:7,email:account(7).email,is_active:true,ban_reason:null}],confirm=true;
 r.refreshAccounts=Runtime.prototype.refreshAccounts.bind(r);r.request=async(endpoint,options)=>{if(endpoint==='/api/tokens')return rows.map(row=>({...row}));if(options?.method==='DELETE'){rows=[];return {success:true};}if(options?.method==='POST'){if(confirm)rows[0]={...rows[0],is_active:endpoint.endsWith('/enable'),ban_reason:endpoint.endsWith('/disable')?'manual_disabled':null};return {success:true};}assert.fail(endpoint);};
 await r.setAccountActive(7,false);assert.equal(r.accounts[0].isActive,false);assert.equal(r.accountParticipation.get(7).enabled,false);
 rows[0]={...rows[0],is_active:true,ban_reason:null};await r.refreshAccounts();assert.equal(r.accounts[0].serverActive,true);assert.equal(r.accounts[0].isActive,false,'Explicit disabled intent survives server refresh');
 confirm=false;await assert.rejects(r.setAccountActive(7,false),/Сервер не подтвердил/);assert.equal(r.accountParticipation.get(7).enabled,false);
 const restarted=new Runtime({dataDir:folder});await restarted.initializeHistory();assert.equal(restarted.accountParticipation.get(7).enabled,false);
 await r.deleteAccount(7);assert.equal(r.accountParticipation.size,0);assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder,'account-participation.json'),'utf8')).accounts,[]);
 const fresh=new Runtime({dataDir:folder});fresh.request=r.request;rows=[{id:7,email:account(7).email,is_active:false,ban_reason:null}];await assert.rejects(fresh.setAccountActive(7,true),/Сервер не подтвердил/);assert.equal(fresh.accountParticipation.size,0);
});
