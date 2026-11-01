const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {startAgentBridge,createAgentActions,generationInput,capabilities}=require('./agent-bridge.cjs');
const {Runtime}=require('./runtime.cjs');
const settings={kind:'video',method:'text',family:'Veo 3.1 Fast',durationSeconds:8,aspectRatio:'16:9'};
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
 assert.deepEqual(prepared.checks,{localFiles:'passed',videoDuration:'not_applicable',accountAccess:'not_checked',credits:'not_checked'});
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
test('model filters combine new settings with legacy mode and status advertises API features',async()=>{
 const runtime={ready:true,message:'ready',models:[{id:'veo-3.1-fast-r2v-8s-landscape'},{id:'omni-1.1-flash'},{id:'gemini-3.1-flash-image-landscape-4k'}],accounts:[],jobs:[],start:async()=>{}};
 const call=createAgentActions({runtime});
 assert.deepEqual((await call('models',{kind:'video',mode:'references',method:'ingredients',family:'Veo 3.1 Fast',durationSeconds:8,aspectRatio:'16:9',resolution:'standard'})).models.map(model=>model.id),['veo-3.1-fast-r2v-8s-landscape']);
 assert.deepEqual((await call('models',{method:'frames'})).models,[]);
 assert.equal((await call('models',{method:'text',family:'Omni 1.1 Flash',durationSeconds:8})).models.length,1);
 const status=await call('status');assert.equal(status.apiVersion,2);assert.deepEqual(status.features,['generation-settings','prepare-generation','explicit-methods']);
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
 const runtime=new Runtime({});runtime.ready=true;runtime.models=[{id:'omni-1.1-flash'}];let count=0;runtime.runJob=async()=>{count++;};
 const p={model:'omni-1.1-flash',prompt:'move',requestId:'stable'};
 const a=runtime.generate(p),b=runtime.generate(p);assert.deepEqual(a,b);assert.equal(count,1);
 assert.throws(()=>runtime.generate({...p,prompt:'different'}),/другими параметрами/);
});
test('mixed references retain stable requestId dedup and reject changed source video',()=>{
 const runtime=new Runtime({});runtime.ready=true;runtime.models=[{id:'omni-1.1-flash-edit-landscape'}];let count=0;runtime.runJob=async()=>{count++;};
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
