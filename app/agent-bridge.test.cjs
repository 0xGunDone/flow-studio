const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {startAgentBridge,createAgentActions,generationInput,capabilities}=require('./agent-bridge.cjs');
const {Runtime}=require('./runtime.cjs');
const settings={kind:'video',method:'text',family:'Veo 3.1 Fast',durationSeconds:8,aspectRatio:'16:9'};
test('catalog distinguishes official watermark verification support without claiming account entitlement',()=>{
 for(const id of ['omni-1.2-flash-3s-landscape','veo-3.1-fast-i2v-8s-landscape','omni-1.2-flash-edit-portrait']){const model=capabilities({id});assert.equal(model.visibleWatermarkPolicy,'require_off');assert.equal(model.visibleWatermarkVerification,'supported');assert.equal(model.generationEngine,'isolated-browser');}
 const legacy=capabilities({id:'omni-1.1-flash-extend-landscape'});assert.equal(legacy.visibleWatermarkPolicy,'require_off');assert.equal(legacy.visibleWatermarkVerification,'unsupported');assert.equal(legacy.generationEngine,'server');
 const image=capabilities({id:'gemini-3.1-flash-image-landscape'});assert.equal(image.visibleWatermarkPolicy,undefined);assert.equal(image.visibleWatermarkVerification,undefined);
});
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'flow-agent-settings-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const start=path.join(dir,'start.png'),end=path.join(dir,'end.jpg'),video=path.join(dir,'source.mp4');
 await fs.writeFile(start,'start');await fs.writeFile(end,'end');await fs.writeFile(video,'video');
 return {dir,start,end,video};
}
test('catalog exposes separate settings, explicit input roles, alias duration and source-video duration',()=>{
 const omni=capabilities({id:'omni-1.1-flash'});
 assert.equal(omni.mode,'references');assert.deepEqual(omni.methods,['text','ingredients']);
 assert.equal(omni.family,'Omni 1.1 Flash');assert.equal(omni.durationSeconds,8);assert.equal(omni.resolution,'standard');
 assert.equal(omni.inputsByMethod.text.maxImages,0);assert.equal(omni.inputsByMethod.ingredients.minImages,1);
 assert.equal(omni.inputsByMethod.ingredients.maxImages,7);
 const frames=capabilities({id:'veo-3.1-lite-i2v-8s-landscape'}).inputsByMethod.frames;
 assert.equal(frames.minImages,1);assert.equal(frames.maxImages,2);assert.equal(frames.supportsEndFrame,true);
 const edit=capabilities({id:'omni-1.1-flash-edit-landscape'});
 assert.equal(edit.durationSeconds,undefined);assert.equal(edit.durationSource,'input_video');
 assert.equal(edit.inputsByMethod.edit.minVideos,1);assert.equal(edit.fileLimits.video.maxDurationSeconds,10);
});
test('settings resolve only exact catalog combinations and collapse only known aliases',async()=>{
 const runtime={models:[{id:'veo-3.1-fast'},{id:'veo-3.1-fast-8s-landscape'}]};
 const base={prompt:'move',requestId:'resolved',confirmCreditSpend:true};
 assert.equal((await generationInput(runtime,{...base,settings})).model,'veo-3.1-fast-8s-landscape');
 runtime.models.reverse();assert.equal((await generationInput(runtime,{...base,settings})).model,'veo-3.1-fast-8s-landscape');
 assert.equal((await generationInput(runtime,{...base,model:'veo-3.1-fast'})).model,'veo-3.1-fast');
 await assert.rejects(generationInput(runtime,{...base,settings:{...settings,aspectRatio:'1:1'}}),{code:'MODEL_SELECTION_UNAVAILABLE'});
 runtime.models.push({id:'veo-3.1-fast-8s-landscape-other'});
 await assert.rejects(generationInput(runtime,{...base,settings}),error=>{
  assert.equal(error.code,'MODEL_SELECTION_AMBIGUOUS');assert.match(error.message,/неоднознач|нескольк/i);assert.match(error.message,/veo-3\.1-fast-8s-landscape-other/);return true;
 });
});
test('settings reject ambiguous selectors, missing dimensions and irrelevant duration',async()=>{
 const runtime={models:[{id:'veo-3.1-fast-8s-landscape'},{id:'gemini-3.1-flash-image-landscape'},{id:'omni-1.1-flash-edit-landscape'}]};
 const base={prompt:'move',requestId:'invalid-settings',confirmCreditSpend:true};
 const image={kind:'image',method:'image',family:'Nano Banana 2.1',aspectRatio:'16:9'};
 for(const selection of [
  {},{model:runtime.models[0].id,settings},{settings,method:'text'},
  {settings:{...settings,kind:'image'}},{settings:{...settings,method:'image'}},
  {settings:{...settings,family:'veo 3.1 fast'}},{settings:{...settings,family:undefined}},
  {settings:{...settings,aspectRatio:undefined}},{settings:{...settings,durationSeconds:undefined}},
  {settings:{...settings,resolution:'4K'}},{settings:{...settings,unexpected:true}},
  {settings:{...image,durationSeconds:8}},
  {settings:{kind:'video',method:'edit',family:'Omni 1.1 Flash',aspectRatio:'16:9',durationSeconds:8}},
 ])await assert.rejects(generationInput(runtime,{...base,...selection}),error=>{
  assert.ok(['INVALID_ARGUMENTS','MODEL_SELECTION_UNAVAILABLE'].includes(error.code));return true;
 });
});
test('explicit methods preserve text, ingredients and frame roles',async t=>{
 const {start,end}=await fixture(t),models=['omni-1.1-flash','veo-3.1-fast-i2v-8s-landscape','gemini-3.1-flash-image-landscape'].map(id=>({id}));
 const runtime={models},base={model:models[0].id,prompt:'move',requestId:'roles',confirmCreditSpend:true};
 await assert.rejects(generationInput(runtime,{...base,method:'text',referencePaths:[start]}),/текст|text|референс/i);
 await assert.rejects(generationInput(runtime,{...base,method:'ingredients'}),/изображен|ингредиент/i);
 await assert.rejects(generationInput(runtime,{...base,method:'frames',startFramePath:start}),/метод|способ|поддерж/i);
 await assert.rejects(generationInput(runtime,{...base,model:models[1].id,method:'frames',endFramePath:end}),/начальн|startFramePath/i);
 const input=await generationInput(runtime,{...base,model:models[1].id,method:'frames',startFramePath:start,endFramePath:end});
 assert.deepEqual(input.images,['data:image/png;base64,c3RhcnQ=','data:image/jpeg;base64,ZW5k']);
 assert.equal((await generationInput(runtime,{...base,model:models[2].id,method:'image',referencePaths:[start]})).images.length,1);
});
test('prepare validates local files and returns exact reusable arguments without starting or storing jobs',async t=>{
 const {start,end,video}=await fixture(t),jobs=[{id:'existing',status:'succeeded'}];
 const runtime={ready:true,models:[{id:'veo-3.1-fast-i2v-8s-landscape'},{id:'omni-1.1-flash-edit-landscape'},{id:'omni-1.1-flash'}],jobs,start:async()=>{},generate:()=>assert.fail('prepare generated'),persist:()=>assert.fail('prepare persisted'),refreshAccounts:()=>assert.fail('prepare read accounts')};
 const call=createAgentActions({runtime});
 const prepared=await call('prepare',{settings:{...settings,method:'frames'},prompt:' preserve spaces ',startFramePath:start,endFramePath:end});
 assert.equal(prepared.valid,true);assert.equal(prepared.model.id,'veo-3.1-fast-i2v-8s-landscape');assert.equal(prepared.method,'frames');
 assert.deepEqual(prepared.generateArguments,{model:'veo-3.1-fast-i2v-8s-landscape',method:'frames',prompt:' preserve spaces ',startFramePath:start,endFramePath:end});
 assert.deepEqual(prepared.settings,{...settings,method:'frames',resolution:'standard'});
 assert.deepEqual(prepared.inputs,{images:2,videos:0,references:0,startFrame:true,endFrame:true,sourceVideo:false});
 assert.deepEqual(prepared.checks,{localFiles:'passed',videoDuration:'not_applicable',accountAccess:'not_checked',credits:'not_checked',visibleWatermark:'not_checked'});
 assert.ok(!JSON.stringify(prepared).includes('base64'));assert.deepEqual(runtime.jobs,jobs);
 assert.equal((await call('prepare',{model:'omni-1.1-flash',prompt:'move',referencePaths:[start]})).method,'ingredients');
 assert.equal((await call('prepare',{model:'omni-1.1-flash',prompt:'move'})).method,'text');
 const edit=await call('prepare',{model:'omni-1.1-flash-edit-landscape',prompt:'edit',videoPaths:[video]});
 assert.equal(edit.checks.videoDuration,'checked_at_submission');assert.equal(edit.inputs.videos,1);
 await assert.rejects(call('prepare',{model:'omni-1.1-flash',prompt:'move',referencePaths:[path.join(path.dirname(start),'missing.png')]}));
});
test('prepare shares native regular-file checks with generation',async t=>{
 const {dir,start}=await fixture(t),link=path.join(dir,'link.png'),folder=path.join(dir,'folder.png'),huge=path.join(dir,'huge.png');
 await fs.symlink(start,link);await fs.mkdir(folder);await fs.writeFile(huge,'');await fs.truncate(huge,20*1024*1024+1);
 const runtime={ready:true,models:[{id:'gemini-3.1-flash-image-landscape'}],start:async()=>{}},call=createAgentActions({runtime});
 for(const file of [link,folder,huge]){
  const params={model:runtime.models[0].id,prompt:'image',referencePaths:[file]};
  await assert.rejects(call('prepare',params));
  await assert.rejects(generationInput(runtime,{...params,requestId:'files',confirmCreditSpend:true}));
 }
});
test('optional browser preparation uploads only when requested and returns after clear without paid jobs or diagnostic replay flags',async t=>{
 const {start}=await fixture(t),model='omni-1.2-flash-8s-landscape',calls=[];let finish,entered;
 const checking=new Promise(resolve=>{entered=resolve;});
 const runtime={ready:true,models:[{id:model}],jobs:[],start:async()=>{},generate:()=>assert.fail('Browser check generated'),persist:()=>assert.fail('Browser check persisted job')};
 const result={ready:true,accountId:7,email:'owner@example.test',projectURL:'https://flow.google.com/project/fixture',model,referenceCount:1,uploadedImages:1,submitted:false,cleared:true,visibleWatermark:'off',privateInput:'must-not-return'};
 const call=createAgentActions({runtime,checkIsolatedInputs:async input=>{calls.push(input);await new Promise(resolve=>{finish=resolve;entered();});return result;}});
 const input={model,prompt:' original prompt ',method:'ingredients',referencePaths:[start],accountId:7};
 assert.equal((await call('prepare',input)).checks.browser,undefined);assert.equal((await call('prepare',{...input,checkBrowser:false})).checks.browser,undefined);assert.equal(calls.length,0);
 let settled=false;const pending=call('prepare',{...input,checkBrowser:true}).then(value=>{settled=true;return value;});
 await checking;assert.equal(settled,false);assert.equal(calls.length,1);
 assert.deepEqual(calls[0],{model,prompt:input.prompt,accountId:7,references:[{kind:'image',dataUrl:'data:image/png;base64,c3RhcnQ='}]});
 finish();const plan=await pending;assert.equal(plan.checks.browser,'passed');assert.equal(plan.checks.upload,'passed');assert.equal(plan.checks.credits,'not_checked');assert.equal(plan.checks.visibleWatermark,'off');assert.equal(plan.browserCheck.visibleWatermark,'off');
 assert.equal(plan.browserCheck.accountEmail,'owner@example.test');assert.equal(plan.browserCheck.submitted,false);assert.equal(plan.browserCheck.cleared,true);
 assert.equal(plan.generateArguments.checkBrowser,undefined);assert.equal(Object.hasOwn(plan.generateArguments,'checkBrowser'),false);
 assert.doesNotMatch(JSON.stringify(plan),/must-not-return|base64/);assert.deepEqual(runtime.jobs,[]);
});
test('browser preparation validates explicit account and supported route before hook and preserves hook errors exactly',async t=>{
 const {start}=await fixture(t),model='omni-1.2-flash-8s-landscape';let checks=0;
 const runtime={ready:true,models:[{id:model},{id:'veo-3.1-fast-8s-landscape'}],jobs:[],start:async()=>{}};
 const original=Object.assign(new Error('Exact upload error'),{code:'INGREDIENT_NOT_VERIFIED'});
 const call=createAgentActions({runtime,checkIsolatedInputs:async()=>{checks++;throw original;}}),input={model,prompt:'test',accountId:7,referencePaths:[start],checkBrowser:true};
 for(const patch of [{accountId:undefined},{accountId:null},{checkBrowser:'true'},{checkBrowser:1}])await assert.rejects(call('prepare',{...input,...patch}),{code:'INVALID_ARGUMENTS'});
 await assert.rejects(call('prepare',{model:'veo-3.1-fast-extend-8s-landscape',prompt:'test',method:'extend',sourceVideoId:'original',accountId:7,checkBrowser:true}),{code:'MODEL_SELECTION_UNAVAILABLE'});assert.equal(checks,0);
 await assert.rejects(call('prepare',input),error=>error===original);assert.equal(checks,1);
 await assert.rejects(createAgentActions({runtime})('prepare',input),{code:'BROWSER_CHECK_UNAVAILABLE'});
 for(const patch of [{cleared:false},{submitted:true},{uploadedImages:0},{accountId:9}]){
  const unchecked=createAgentActions({runtime,checkIsolatedInputs:async()=>({ready:true,accountId:7,uploadedImages:1,submitted:false,cleared:true,...patch})});
  await assert.rejects(unchecked('prepare',input),{code:'BROWSER_CHECK_UNCONFIRMED'});
 }
 await assert.rejects(generationInput(runtime,{...input,confirmCreditSpend:true,requestId:'bad-diagnostic-flag'}),{code:'INVALID_ARGUMENTS'});
});
test('local watermark preparation reports unverified video policy without reading browser state while images remain not applicable',async()=>{
 const video='omni-1.2-flash-8s-landscape',serverVideo='omni-1.1-flash-8s-landscape',image='gemini-3.1-flash-image-landscape',runtime={ready:true,models:[video,serverVideo,image].map(id=>({id})),accounts:[{id:7,email:'owner@example.test',isActive:true}],jobs:[],start:async()=>{},generate:()=>assert.fail('Local prepare must not generate'),persist:()=>assert.fail('Local prepare must not persist')};let browserChecks=0;
 const call=createAgentActions({runtime,checkIsolatedInputs:async()=>{browserChecks++;assert.fail('Local prepare must not inspect account setting');}});
 const status=await call('status');assert.equal(status.videoWatermarkPolicy,'require_off');assert.ok(status.features.includes('video-visible-watermark-off'));assert.equal(status.accounts[0].visibleWatermark,undefined);
 for(const model of [video,serverVideo]){const plan=await call('prepare',{model,prompt:'Exact user request',accountId:7});assert.equal(plan.checks.visibleWatermark,'not_checked');assert.equal(plan.browserCheck,undefined);assert.equal(Object.hasOwn(plan.generateArguments,'visibleWatermark'),false);}
 await assert.rejects(call('prepare',{model:serverVideo,prompt:'Same server route',accountId:7,checkBrowser:true}),{code:'BROWSER_MODEL_UNSUPPORTED'});
 const plan=await call('prepare',{model:image,prompt:'Image request'});assert.equal(plan.checks.visibleWatermark,'not_applicable');assert.equal(browserChecks,0);assert.deepEqual(runtime.jobs,[]);
});
test('browser watermark preparation accepts only exact off evidence and preserves mandatory errors without generation',async()=>{
 const model='omni-1.2-flash-3s-portrait-360p',runtime={ready:true,models:[{id:model}],jobs:[],start:async()=>{},generate:()=>assert.fail('Browser check must not generate'),persist:()=>assert.fail('Browser check must not persist')},args={model,prompt:'Exact user request',method:'text',accountId:7,checkBrowser:true};let browserChecks=0;
 for(const state of [undefined,null,'on','required','not_checked','OFF',false,{checked:false}]){
  const call=createAgentActions({runtime,checkIsolatedInputs:async()=>{browserChecks++;return {ready:true,accountId:7,model,uploadedImages:0,submitted:false,cleared:true,...(state!==undefined?{visibleWatermark:state}:{})};}});
  await assert.rejects(call('prepare',args),{code:'VISIBLE_WATERMARK_UNVERIFIED'});assert.deepEqual(runtime.jobs,[]);
 }
 const call=createAgentActions({runtime,checkIsolatedInputs:async()=>{browserChecks++;return {ready:true,accountId:7,model,uploadedImages:0,submitted:false,cleared:true,visibleWatermark:'off'};}}),plan=await call('prepare',args);
 assert.equal(plan.checks.visibleWatermark,'off');assert.equal(plan.browserCheck.visibleWatermark,'off');assert.equal(plan.browserCheck.accountId,7);assert.equal(plan.browserCheck.submitted,false);assert.equal(plan.generateArguments.visibleWatermark,undefined);assert.equal(browserChecks,9);
 const mandatory=Object.assign(new Error('Google requires visible watermarking for this account'),{code:'VISIBLE_WATERMARK_REQUIRED'}),required=createAgentActions({runtime,checkIsolatedInputs:async()=>{throw mandatory;}});await assert.rejects(required('prepare',args),error=>error===mandatory);assert.deepEqual(runtime.jobs,[]);
});
test('model filters combine new settings with legacy mode and status advertises API features',async()=>{
 const runtime={ready:true,message:'ready',models:[{id:'veo-3.1-fast-r2v-8s-landscape'},{id:'omni-1.1-flash'},{id:'gemini-3.1-flash-image-landscape-4k'}],accounts:[],jobs:[],start:async()=>{}};
 const call=createAgentActions({runtime});
 assert.deepEqual((await call('models',{kind:'video',mode:'references',method:'ingredients',family:'Veo 3.1 Fast',durationSeconds:8,aspectRatio:'16:9',resolution:'standard'})).models.map(model=>model.id),['veo-3.1-fast-r2v-8s-landscape']);
 assert.deepEqual((await call('models',{method:'frames'})).models,[]);
 assert.equal((await call('models',{method:'text',family:'Omni 1.1 Flash',durationSeconds:8})).models.length,1);
 const status=await call('status');assert.equal(status.apiVersion,3);assert.equal(status.videoWatermarkPolicy,'require_off');assert.deepEqual(status.features,['generation-settings','prepare-generation','explicit-methods','isolated-browser-generation','video-visible-watermark-off']);
});
test('catalog advertises isolated browser for exact Omni 1.2 text ingredients and frame variants without extending edit route',()=>{
 for(const id of ['omni-1.2-flash-3s-landscape','omni-1.2-flash-8s-portrait','omni-1.2-flash-15s-portrait-360p']){
  const model=capabilities({id});assert.equal(model.generationEngine,'isolated-browser');assert.deepEqual(model.methods,['text','ingredients']);
 }
 for(const id of ['omni-1.2-flash-i2v-8s-landscape','omni-1.2-flash-i2v-15s-portrait-360p']){const model=capabilities({id});assert.equal(model.generationEngine,'isolated-browser');assert.deepEqual(model.methods,['frames']);}
 for(const id of ['omni-1.2-flash-edit-landscape','omni-1.2-flash-edit-portrait-360p']){const model=capabilities({id});assert.equal(model.generationEngine,'isolated-browser');assert.deepEqual(model.methods,['edit']);}
 assert.equal(capabilities({id:'omni-1.2-flash'}).generationEngine,'isolated-browser');
 for(const id of ['omni-1.1-flash-8s-landscape','omni-1.1-flash-edit-landscape','omni-1.2-flash-16s-landscape','veo-3.1-fast-extend-8s-landscape'])assert.equal(capabilities({id}).generationEngine,'server',id);
});
test('exact Omni 1.2 alias keeps its requested model id through browser check and generation input',async()=>{
 const model='omni-1.2-flash',runtime={ready:true,models:[{id:model}],jobs:[],start:async()=>{}},calls=[];
 const call=createAgentActions({runtime,checkIsolatedInputs:async input=>{calls.push(input);return {ready:true,accountId:7,uploadedImages:0,submitted:false,cleared:true,visibleWatermark:'off'};}});
 const plan=await call('prepare',{model,prompt:'exact alias',accountId:7,checkBrowser:true});assert.equal(plan.model.generationEngine,'isolated-browser');assert.equal(plan.generateArguments.model,model);assert.equal(calls[0].model,model);assert.equal(plan.settings.durationSeconds,8);assert.equal(plan.settings.aspectRatio,'16:9');
 const input=await generationInput(runtime,{...plan.generateArguments,requestId:'same-model-alias',confirmCreditSpend:true});assert.equal(input.model,model);
});
test('Nano Banana routes exact standard and supported upscale variants while Lite keeps standard only',async t=>{
 const ids=[];for(const family of ['gemini-3.1-flash-image','gemini-3.1-flash-lite-image','gemini-3.0-pro-image'])for(const aspect of ['landscape','portrait','square','four-three','three-four']){const id=family+'-'+aspect;ids.push(id);const model=capabilities({id});assert.equal(model.generationEngine,'isolated-browser');assert.equal(model.kind,'image');assert.deepEqual(model.methods,['image']);for(const resolution of ['2k','4k'])assert.equal(capabilities({id:id+'-'+resolution}).generationEngine,family.includes('lite')?'server':'isolated-browser');}
 assert.equal(ids.length,15);const {start}=await fixture(t);let checked;
 const runtime={ready:true,models:[{id:ids[0]}],jobs:[],start:async()=>{}},call=createAgentActions({runtime,checkIsolatedInputs:async input=>{checked=input;return {ready:true,accountId:7,uploadedImages:2,submitted:false,cleared:true};}});
 const preview=await call('prepare',{model:ids[0],method:'image',prompt:'image exact',referencePaths:[start,start],accountId:7,checkBrowser:true});assert.equal(preview.model.generationEngine,'isolated-browser');assert.equal(checked.references.length,2);assert(checked.references.every(ref=>ref.kind==='image'));assert.equal(preview.generateArguments.startFramePath,undefined);assert.equal(preview.checks.visibleWatermark,'not_applicable');assert.equal(preview.browserCheck.visibleWatermark,undefined);
 await assert.rejects(call('prepare',{model:ids[0],prompt:'too many',referencePaths:Array(6).fill(start)}),/до 5/);
});
test('Veo catalog uses shared exact forty-three variants and keeps frame roles for no-spend browser check',async t=>{
 const ids=[];for(const family of ['lite','fast','quality']){ids.push('veo-3.1-'+family);for(const method of ['','i2v-'])for(const seconds of [4,6,8])for(const aspect of ['landscape','portrait'])ids.push(`veo-3.1-${family}-${method}${seconds}s-${aspect}`);if(family!=='quality')for(const aspect of ['landscape','portrait'])ids.push(`veo-3.1-${family}-r2v-8s-${aspect}`);}
 assert.equal(ids.length,43);for(const id of ids)assert.equal(capabilities({id}).generationEngine,'isolated-browser',id);
 for(const id of ['veo-3.1-quality-r2v-8s-landscape','veo-3.1-fast-r2v-4s-landscape','veo-3.1-fast-extend-8s-landscape','veo-3.1-fast-8s-square'])assert.equal(capabilities({id}).generationEngine,'server',id);
 const {start,end}=await fixture(t),model='veo-3.1-fast-i2v-8s-portrait',runtime={ready:true,models:[{id:model},{id:'veo-3.1-fast-4s-landscape'}],jobs:[],start:async()=>{}},calls=[];
 const call=createAgentActions({runtime,checkIsolatedInputs:async input=>{calls.push(input);if(input.model.includes('-4s-'))throw Object.assign(new Error('Exact duration unavailable'),{code:'MODEL_DURATION_UNAVAILABLE'});return {ready:true,accountId:7,uploadedImages:2,submitted:false,cleared:true,visibleWatermark:'off'};}});
 const plan=await call('prepare',{model,method:'frames',prompt:'exact frames',startFramePath:start,endFramePath:end,accountId:7,checkBrowser:true});assert.equal(plan.generateArguments.model,model);assert.equal(plan.generateArguments.startFramePath,start);assert.equal(plan.generateArguments.endFramePath,end);assert.equal(calls[0].references[0].dataUrl,'data:image/png;base64,c3RhcnQ=');assert.equal(calls[0].references[1].dataUrl,'data:image/jpeg;base64,ZW5k');
 await assert.rejects(call('prepare',{model:'veo-3.1-fast-4s-landscape',method:'text',prompt:'exact 4s',accountId:7,checkBrowser:true}),{code:'MODEL_DURATION_UNAVAILABLE'});assert.equal(calls[1].model,'veo-3.1-fast-4s-landscape');assert.equal(capabilities({id:calls[1].model}).requiredTier,'Ultra');
});
test('optional Omni 1.2 edit check forwards video source and images without frame conversion or generation flags',async t=>{
 const {start,video}=await fixture(t),model='omni-1.2-flash-edit-portrait-360p';let checked;
 const runtime={ready:true,models:[{id:model}],jobs:[],start:async()=>{}},call=createAgentActions({runtime,checkIsolatedInputs:async input=>{checked=input;return {ready:true,accountId:7,uploadedImages:1,submitted:false,cleared:true,visibleWatermark:'off'};}});
 const plan=await call('prepare',{model,method:'edit',prompt:'Edit original video',videoPaths:[video],referencePaths:[start],accountId:7,checkBrowser:true});
 assert.equal(plan.model.generationEngine,'isolated-browser');assert.deepEqual(checked.references,[{kind:'image',dataUrl:'data:image/png;base64,c3RhcnQ='},{kind:'video',path:video}]);assert.equal(plan.generateArguments.videoPaths[0],video);assert.equal(plan.generateArguments.startFramePath,undefined);assert.equal(plan.generateArguments.checkBrowser,undefined);assert.equal(plan.checks.browser,'passed');assert.equal(runtime.jobs.length,0);
});
test('browser check reports one uploaded Edit video with no images while local prepare stays inert and text has no upload',async t=>{
 const {video}=await fixture(t),model='omni-1.2-flash-edit-portrait-360p',textModel='omni-1.2-flash-3s-portrait-360p',calls=[];
 const runtime={ready:true,models:[{id:model},{id:textModel}],jobs:[],start:async()=>{},generate:()=>assert.fail('Upload check generated'),persist:()=>assert.fail('Upload check persisted job')};
 const call=createAgentActions({runtime,checkIsolatedInputs:async input=>{calls.push(input);return {ready:true,accountId:7,model:input.model,uploadedImages:input.references.filter(ref=>ref.kind==='image').length,submitted:false,cleared:true,visibleWatermark:'off'};}});
 const args={model,method:'edit',prompt:'Edit exactly this video',videoPaths:[video],accountId:7};
 for(const local of [args,{...args,checkBrowser:false}]){
  const plan=await call('prepare',local);assert.equal(plan.checks.browser,undefined);assert.equal(plan.checks.upload,undefined);assert.equal(plan.browserCheck,undefined);
 }
 assert.equal(calls.length,0);
 const plan=await call('prepare',{...args,checkBrowser:true});
 assert.equal(plan.checks.browser,'passed');assert.equal(plan.checks.upload,'passed');assert.equal(plan.browserCheck.uploadedImages,0);assert.equal(plan.browserCheck.uploadedVideos,1);
 assert.deepEqual(calls[0].references,[{kind:'video',path:video}]);assert.equal(plan.generateArguments.videoPaths[0],video);assert.equal(Object.hasOwn(plan.generateArguments,'checkBrowser'),false);assert.equal(calls.length,1);
 const text=await call('prepare',{model:textModel,method:'text',prompt:'Text only',accountId:7,checkBrowser:true});
 assert.equal(text.checks.upload,'not_applicable');assert.equal(text.browserCheck.uploadedImages,0);assert.equal(text.browserCheck.uploadedVideos,0);assert.equal(calls.length,2);assert.deepEqual(runtime.jobs,[]);
});
test('browser check rejects a different returned model or explicit video upload count',async t=>{
 const {video}=await fixture(t),model='omni-1.2-flash-edit-portrait-360p';
 const runtime={ready:true,models:[{id:model}],jobs:[],start:async()=>{}};
 for(const patch of [{model:'omni-1.2-flash-edit-landscape'},{uploadedVideos:0}]){
  const call=createAgentActions({runtime,checkIsolatedInputs:async()=>({ready:true,accountId:7,model,uploadedImages:0,submitted:false,cleared:true,...patch})});
  await assert.rejects(call('prepare',{model,method:'edit',prompt:'Exact source',videoPaths:[video],accountId:7,checkBrowser:true}),{code:'BROWSER_CHECK_UNCONFIRMED'});
 }
 assert.deepEqual(runtime.jobs,[]);
});
test('optional Omni 1.2 browser frame check keeps start/end roles and rejects ingredients or unsupported end frame',async t=>{
 const {start,end}=await fixture(t),models=[{id:'omni-1.2-flash-i2v-8s-landscape'},{id:'omni-1.2-flash-i2v-15s-portrait-360p'}],calls=[];
 const runtime={ready:true,models,jobs:[],start:async()=>{}},call=createAgentActions({runtime,checkIsolatedInputs:async input=>{calls.push(input);return {ready:true,accountId:7,uploadedImages:input.references.length,submitted:false,cleared:true,visibleWatermark:'off'};}});
 const args={model:models[0].id,method:'frames',prompt:'frame transition',startFramePath:start,endFramePath:end,accountId:7,checkBrowser:true};
 const plan=await call('prepare',args);assert.equal(plan.model.generationEngine,'isolated-browser');assert.equal(plan.method,'frames');
 assert.deepEqual(calls[0].references,[{kind:'image',dataUrl:'data:image/png;base64,c3RhcnQ='},{kind:'image',dataUrl:'data:image/jpeg;base64,ZW5k'}]);
 assert.equal(plan.generateArguments.startFramePath,start);assert.equal(plan.generateArguments.endFramePath,end);assert.equal(plan.generateArguments.method,'frames');assert.equal(plan.generateArguments.checkBrowser,undefined);
 await assert.rejects(call('prepare',{...args,referencePaths:[start]}),/нельзя смешивать/);
 await assert.rejects(call('prepare',{...args,model:models[1].id}),/до 1 изображений/);
 assert.equal(calls.length,1);
});
test('prepare and generation preserve optional exact account without checking account access or starting jobs',async t=>{
 const {start}=await fixture(t),model='omni-1.2-flash-8s-landscape';let generations=0;
 const runtime={ready:true,models:[{id:model}],jobs:[],start:async()=>{},refreshAccounts:()=>assert.fail('prepare checked account access'),generate:input=>{generations++;assert.equal(input.accountId,7);runtime.jobs.push({id:'pinned',status:'running',generationEngine:'isolated-browser',accountId:7,media:[]});return {jobId:'pinned'};},persist:async()=>{}};
 const call=createAgentActions({runtime}),params={model,prompt:' exact prompt ',referencePaths:[start],accountId:7};
 const plan=await call('prepare',params);assert.equal(plan.model.generationEngine,'isolated-browser');assert.equal(plan.generateArguments.accountId,7);
 assert.equal(plan.checks.accountAccess,'not_checked');assert.equal(generations,0);assert.deepEqual(runtime.jobs,[]);
 const generation={...plan.generateArguments,requestId:'stable-account',confirmCreditSpend:true};
 const input=await generationInput(runtime,generation);assert.equal(input.accountId,7);assert.equal(input.prompt,params.prompt);
 const result=await call('generate',generation);assert.equal(generations,1);assert.equal(result.job.generationEngine,'isolated-browser');assert.equal(result.job.accountId,7);
 const ordinary=await generationInput(runtime,{model,prompt:'automatic account',requestId:'automatic',confirmCreditSpend:true});assert.equal(Object.hasOwn(ordinary,'accountId'),false);
 for(const accountId of [null,0,-1,1.2,Number.MAX_SAFE_INTEGER+1,'7']){
  await assert.rejects(call('prepare',{...params,accountId}),{code:'INVALID_ARGUMENTS'});
  await assert.rejects(generationInput(runtime,{...generation,accountId}),{code:'INVALID_ARGUMENTS'});
 }
 assert.equal(generations,1);
});
test('cancel delegates shared runtime semantics and keeps running job until engine settles',async()=>{
 const runtime=new Runtime({}),controller=new AbortController(),job={id:'pending',model:'omni-1.2-flash-8s-landscape',status:'running',generationEngine:'isolated-browser',unknownOutcome:true,media:[]};
 runtime.jobs=[job];runtime.aborts.set(job.id,controller);
 const call=createAgentActions({runtime}),cancel=runtime.cancelGeneration.bind(runtime);let calls=0;
 runtime.cancelGeneration=id=>{calls++;return cancel(id);};
 const result=await call('cancel',{jobId:job.id});assert.equal(calls,1);assert.equal(controller.signal.aborted,true);
 assert.equal(result.job.status,'running');assert.equal(result.job.cancelRequested,true);assert.equal(result.job.unknownOutcome,true);assert.equal(result.job.generationEngine,'isolated-browser');
 assert.equal(job.progress,'Отменяем ожидание…');assert.match(result.note,/Не повторяйте автоматически/);
 job.status='failed';await call('cancel',{jobId:job.id});assert.equal(calls,2);assert.equal(job.status,'failed');
 await assert.rejects(call('cancel',{jobId:'missing'}),/не найдена/);assert.equal(calls,2);
});
test('recover bridge targets existing history id and rejects any new generation override',async()=>{
 const job={id:'original',status:'failed',unknownOutcome:true,media:[]},calls=[];
 const runtime={ready:true,start:async()=>{},jobs:[job],persist:async()=>{},recoverGeneration:id=>{calls.push(id);job.status='running';return {jobId:id};}};
 const call=createAgentActions({runtime});for(const params of [{},{jobId:'original',model:'other'},{jobId:'original',confirmCreditSpend:true}])await assert.rejects(call('recover',params),{code:'INVALID_ARGUMENTS'});
 assert.equal(calls.length,0);const result=await call('recover',{jobId:'original'});assert.equal(result.jobId,'original');assert.equal(result.job.status,'running');assert.deepEqual(calls,['original']);assert.equal(runtime.jobs.length,1);
});
test('explicit MCP cooldown reset validates account and serializes without generation or credential mutation',async()=>{
 const calls=[];let finish;
 const runtime={ready:true,start:async()=>{},jobs:[],clearCooldown:async id=>{calls.push(id);await new Promise(resolve=>{finish=resolve;});return {cleared:true,accounts:[{id,isActive:false,lastGenerationError:'PUBLIC_ERROR_UNUSUAL_ACTIVITY',cooldownUntil:null}]};}};
 const call=createAgentActions({runtime});for(const params of [{},{accountId:0},{accountId:'7'},{accountId:7,generate:true}])await assert.rejects(call('reset_cooldown',params),{code:'INVALID_ARGUMENTS'});
 const pending=call('reset_cooldown',{accountId:7});await new Promise(setImmediate);assert.equal(runtime.accountActionPending,true);
 await assert.rejects(call('reset_cooldown',{accountId:7}),/Дождитесь/);finish();const result=await pending;assert.equal(runtime.accountActionPending,false);assert.equal(result.accounts[0].isActive,false);assert.match(result.accounts[0].lastGenerationError,/UNUSUAL_ACTIVITY/);assert.match(result.note,/Google не изменены/);assert.deepEqual(calls,[7]);
 runtime.jobs=[{status:'running'}];await assert.rejects(call('reset_cooldown',{accountId:7}),/Дождитесь/);assert.deepEqual(calls,[7]);
});
test('explicit account enable/check tools validate and serialize without automatic enable or generation',async()=>{
 let finish;const calls=[],runtime={ready:true,start:async()=>{},jobs:[],setAccountActive:async(id,enabled)=>{calls.push(['set',id,enabled]);await new Promise(resolve=>{finish=resolve;});return {accounts:[{id,isActive:enabled}]};},checkAccount:async id=>{calls.push(['check',id]);return {ok:true,accountId:id,email:'owner@example.test'};}};
 const call=createAgentActions({runtime});
 for(const [method,params] of [['set_account_active',{accountId:7,enabled:'true'}],['set_account_active',{accountId:7}],['check_account',{accountId:7,enabled:true}],['check_account',{accountId:0}]])await assert.rejects(call(method,params),{code:'INVALID_ARGUMENTS'});
 const changing=call('set_account_active',{accountId:7,enabled:false});await new Promise(setImmediate);assert.equal(runtime.accountActionPending,true);await assert.rejects(call('check_account',{accountId:7}),/Дождитесь/);finish();assert.equal((await changing).accounts[0].isActive,false);assert.equal(runtime.accountActionPending,false);
 const checked=await call('check_account',{accountId:7});assert.equal(checked.ok,true);assert.deepEqual(calls,[['set',7,false],['check',7]]);
 runtime.checkAccount=async()=>{throw Object.assign(new Error('Exact session failure'),{code:'AUTH_REJECTED'});};await assert.rejects(call('check_account',{accountId:7}),{code:'AUTH_REJECTED'});assert.equal(runtime.accountActionPending,false);
});
test('MCP batch account check uses managed hook serially skips disabled and continues exact failures',async()=>{
 const runtime=new Runtime({}),calls=[],events=[];runtime.ready=true;runtime.start=async()=>{};runtime.onEvent=event=>events.push(event);
 runtime.accounts=[{id:1,isActive:true},{id:2,isActive:false},{id:3,isActive:true}];runtime.refreshAccounts=async()=>runtime.accounts;
 runtime.checkAccount=async()=>assert.fail('Injected managed hook must replace stale server-only check');
 const call=createAgentActions({runtime,accountCheck:async id=>{calls.push(id);if(id===1)throw new Error('Exact account1 failure');return {ok:true,accountId:id,checkedAt:'verified-now'};}});
 for(const params of [null,[],{accountId:1}])await assert.rejects(call('check_enabled_accounts',params),{code:'INVALID_ARGUMENTS'});
 const result=await call('check_enabled_accounts',{});assert.deepEqual(calls,[1,3]);assert.equal(result.total,2);assert.equal(result.checked,2);assert.equal(result.failed,1);assert.equal(result.verified,1);assert.equal(result.results[0].message,'Exact account1 failure');assert.equal(runtime.accountActionPending,false);assert.equal(runtime.accounts[1].isActive,false);assert.equal(events.at(-1).running,false);assert.equal(runtime.jobs.length,0);
 calls.length=0;await call('check_account',{accountId:3});assert.deepEqual(calls,[3],'Single check shares the managed synchronization hook');
});
test('MCP job wait and history expose live derived retry/recovery availability while preserving source media URL',async()=>{
 const runtime=new Runtime({});runtime.ready=true;runtime.models=[{id:'omni-1.2-flash-8s-landscape'}];runtime.accounts=[{id:7,email:'owner@example.test',isActive:true}];
 runtime.attachBrowserEngine({supports:()=>true,generate:()=>assert.fail('Must not generate'),recover:()=>assert.fail('Metadata reads never recover')});
 const job={id:'unknown',model:runtime.models[0].id,prompt:'original',status:'failed',unknownOutcome:true,generationEngine:'isolated-browser',accountId:7,accountEmail:'owner@example.test',media:[{kind:'video',url:'https://flow-content.google/video/original',path:'/local/result.mp4'}]};runtime.jobs=[job];
 const call=createAgentActions({runtime});for(const result of [await call('job',{jobId:job.id}),(await call('wait',{jobId:job.id,timeoutSeconds:0})).job,(await call('history',{})).jobs[0]]){
  assert.equal(result.recoveryAvailable,true);assert.equal(result.retryAvailable,false);assert.match(result.retryBlockedReason,/неизвестен/);assert.equal(result.media[0].url,'https://flow-content.google/video/original');
 }
 job.errorCode='BROWSER_RECEIPT_MISSING';const missing=await call('job',{jobId:job.id});assert.equal(missing.recoveryAvailable,false);assert.match(missing.recoveryBlockedReason,/не сохранена/);
});
test('MCP frame and reference inputs map to correct model payload',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'flow-agent-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const start=path.join(dir,'start.png'),end=path.join(dir,'end.jpg');
 await fs.writeFile(start,'start');await fs.writeFile(end,'end');
 const runtime={models:[{id:'veo-3.1-fast-i2v-4s-landscape'},{id:'omni-1.1-flash'},{id:'gemini-3.1-flash-image-landscape-4k'},{id:'veo-3.1-fast-extend-8s-landscape'}]};
 const base={prompt:'move',requestId:'one',confirmCreditSpend:true};
 const frames=await generationInput(runtime,{...base,model:runtime.models[0].id,startFramePath:start,endFramePath:end});
 assert.equal(frames.images[0],'data:image/png;base64,c3RhcnQ=');assert.equal(frames.images[1],'data:image/jpeg;base64,ZW5k');
 await assert.rejects(generationInput(runtime,{...base,model:runtime.models[0].id,endFramePath:end}),/startFramePath/);
 const omni=await generationInput(runtime,{...base,model:runtime.models[1].id,referencePaths:Array(7).fill(start)});
 assert.equal(omni.images.length,7);
 await assert.rejects(generationInput(runtime,{...base,model:runtime.models[1].id,referencePaths:Array(8).fill(start)}),/до 7 изображений/);
 await assert.rejects(generationInput(runtime,{...base,model:runtime.models[2].id,referencePaths:Array(6).fill(start)}),/от 0 до 5/);
 await assert.rejects(generationInput(runtime,{...base,model:runtime.models[1].id,confirmCreditSpend:false}),/confirmCreditSpend/);
 assert.equal(capabilities(runtime.models[2]).resolution,'4K');
 assert.equal(capabilities(runtime.models[0]).requiredTier,'Ultra');
});
test('Omni edit forwards source video path with image references and advertises input limits',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'flow-agent-edit-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const photo=path.join(dir,'photo.png'),video=path.join(dir,'source.MOV');
 await fs.writeFile(photo,'image');await fs.writeFile(video,'fake video bytes; backend validates media');
 const model={id:'omni-1.1-flash-edit-landscape'},runtime={models:[model]};
 const params={model:model.id,prompt:'change light',requestId:'edit-one',confirmCreditSpend:true,videoPaths:[video]};
 const info=capabilities(model);
 assert.equal(info.mode,'edit');assert.equal(info.maxImages,5);assert.equal(info.maxVideos,1);assert.equal(info.maxReferences,6);assert.equal(info.supportsVideoReferences,true);
 const input=await generationInput(runtime,{...params,referencePaths:Array(5).fill(photo)});
 assert.equal(input.images,undefined);assert.equal(input.references.length,6);
 assert.deepEqual(input.references[0],{kind:'image',dataUrl:'data:image/png;base64,aW1hZ2U='});
 assert.deepEqual(input.references[5],{kind:'video',path:video});
 assert.deepEqual((await generationInput(runtime,params)).references,[{kind:'video',path:video}]);
 await assert.rejects(generationInput(runtime,{...params,videoPaths:undefined}),/исходное видео/);
 await assert.rejects(generationInput(runtime,{...params,referencePaths:Array(6).fill(photo)}),/от 0 до 5/);
 await assert.rejects(generationInput(runtime,{...params,videoPaths:[video,video]}),/не больше 1 видео/);
 await assert.rejects(generationInput(runtime,{...params,startFramePath:photo}),/нельзя смешивать/);
 await assert.rejects(generationInput(runtime,{...params,sourceVideoId:'existing-id'}),/sourceVideoId/);
});
test('video references reject unsupported models, invalid paths, directories, and oversized files',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'flow-agent-video-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const video=path.join(dir,'source.mp4'),huge=path.join(dir,'large.m4v'),directory=path.join(dir,'folder.mp4');
 await fs.writeFile(video,'fake');await fs.writeFile(huge,'');await fs.truncate(huge,100*1024*1024+1);await fs.mkdir(directory);
 const models=['omni-1.1-flash-edit-portrait','omni-1.1-flash','veo-3.1-fast-r2v-8s-landscape','veo-3.1-fast-i2v-8s-landscape','gemini-3.1-flash-image-landscape-4k'].map(id=>({id}));
 const runtime={models},base={model:models[0].id,prompt:'edit',requestId:'video-test',confirmCreditSpend:true};
 for(const model of models.slice(1))await assert.rejects(generationInput(runtime,{...base,model:model.id,videoPaths:[video]}),/только модель Omni/);
 await assert.rejects(generationInput(runtime,{...base,videoPaths:'source.mp4'}),/массивом/);
 await assert.rejects(generationInput(runtime,{...base,videoPaths:['relative.mp4']}),/файл с диска/);
 await assert.rejects(generationInput(runtime,{...base,videoPaths:[path.join(dir,'bad.avi')]}),/MP4.*MOV.*M4V/);
 await assert.rejects(generationInput(runtime,{...base,videoPaths:[huge]}),/100 МБ/);
 await assert.rejects(generationInput(runtime,{...base,videoPaths:[directory]}),/обычный файл/);
});
test('stable requestId never submits same paid task twice and rejects changed input',()=>{
 const runtime=new Runtime({});runtime.ready=true;runtime.models=[{id:'omni-1.2-flash'}];runtime.attachBrowserEngine({supports:input=>input.model==='omni-1.2-flash',generate:async()=>assert.fail('runJob fixture owns submission')});let count=0;runtime.runJob=async()=>{count++;};
 const p={model:'omni-1.2-flash',prompt:'move',requestId:'stable'};
 const a=runtime.generate(p),b=runtime.generate(p);assert.deepEqual(a,b);assert.equal(count,1);
 assert.throws(()=>runtime.generate({...p,prompt:'different'}),/другими параметрами/);
});
test('mixed references retain stable requestId dedup and reject changed source video',()=>{
 const runtime=new Runtime({});runtime.ready=true;runtime.models=[{id:'omni-1.2-flash-edit-landscape'}];runtime.attachBrowserEngine({supports:input=>input.model==='omni-1.2-flash-edit-landscape',generate:async()=>assert.fail('runJob fixture owns submission')});let count=0;runtime.runJob=async()=>{count++;};
 const p={model:runtime.models[0].id,prompt:'edit',requestId:'stable-edit',references:[{kind:'image',dataUrl:'data:image/png;base64,aW1hZ2U='},{kind:'video',path:'/tmp/source.mp4'}]};
 assert.deepEqual(runtime.generate(p),runtime.generate(p));assert.equal(count,1);
 assert.throws(()=>runtime.generate({...p,references:[...p.references.slice(0,1),{kind:'video',path:'/tmp/different.mp4'}]}),/другими параметрами/);
});
test('bridge accepts only authenticated local requests, stores private discovery file',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'flow-bridge-'));
 const bridge=await startAgentBridge({dataDir:dir,dispatch:async(method,params)=>{
  if(method==='invalid')throw Object.assign(new Error('Unsupported settings'),{code:'MODEL_SELECTION_UNAVAILABLE'});
  return {method,params};
 }});
 t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
 const file=path.join(dir,'agent-bridge.json'),info=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal((await fs.stat(file)).mode&0o777,0o600);
 const url='http://127.0.0.1:'+info.port;
 assert.equal((await fetch(url+'/health')).status,401);
 const headers={Authorization:'Bearer '+info.token,'Content-Type':'application/json'};
 assert.equal((await fetch(url+'/health',{headers:{...headers,Origin:'http://evil.example'}})).status,403);
 const response=await fetch(url+'/rpc',{method:'POST',headers,body:JSON.stringify({method:'status',params:{}})});
 assert.deepEqual(await response.json(),{result:{method:'status',params:{}}});
 const failure=await fetch(url+'/rpc',{method:'POST',headers,body:JSON.stringify({method:'invalid',params:{}})});
 assert.deepEqual(await failure.json(),{error:{message:'Unsupported settings',code:'MODEL_SELECTION_UNAVAILABLE'}});
});
test('MCP save records exported path, refuses overwrite and open folder uses export',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'flow-save-agent-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const cached=path.join(dir,'cache.mp4'),dest=path.join(dir,'out.mp4');await fs.writeFile(cached,'media');
 const job={id:'one',status:'succeeded',media:[{path:cached,kind:'video',url:'https://flow-content.google/test'}]};
 let opened;
 const runtime={jobs:[job],persist:async()=>{},emitJob:()=>{}};
 const call=createAgentActions({runtime,shell:{showItemInFolder:p=>opened=p}});
 assert.deepEqual(await call('save',{jobId:'one',outputPath:dest}),{path:dest});assert.equal(job.media[0].savedPath,dest);
 await assert.rejects(call('save',{jobId:'one',outputPath:dest}),/exist/i);
 await call('open_folder',{jobId:'one'});assert.equal(opened,dest);
});
