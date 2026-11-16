'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {createReceiptStore}=require('./browser-receipts.cjs');
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'flow-receipt-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,store:createReceiptStore(dir),id:randomUUID()};}
const record=()=>({schema:1,model:'omni-1.2-flash-10s-portrait',prompt:'Exact original prompt\n  Preserve whitespace',accountId:7,accountEmail:'owner@example.test',projectURL:'https://flow.google.com/project/project-id',ingredients:['https://flow-content.google/image/original-asset'],baseline:[{id:'old-public-id'},{name:'Existing image',poster:'https://flow-content.google/image/old-poster'}],createdAt:new Date().toISOString()});
test('receipt persists private exact inputs before return and refuses duplicate or concurrent overwrite',async t=>{
 const {dir,store,id}=await fixture(t),value=record();let flushed=false;
 const writeFile=fs.writeFile.bind(fs);t.mock.method(fs,'writeFile',async(target,data,options)=>{if(String(target).endsWith('.tmp'))flushed=options.flush===true;return writeFile(target,data,options);});
 const saved=await store.write(id,value);assert.equal(flushed,true);assert.equal(saved.jobId,id);assert.equal(saved.nonce,id);assert.equal(saved.prompt,value.prompt);
 const file=path.join(dir,'browser-receipts',id+'.json');assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal((await fs.stat(path.dirname(file))).mode&0o777,0o700);
 assert.deepEqual(await createReceiptStore(dir).read(id),saved);
 await assert.rejects(store.write(id,{...value,prompt:'changed'}),{code:'BROWSER_RECEIPT_EXISTS'});assert.equal((await store.read(id)).prompt,value.prompt);
 const second=randomUUID(),attempts=await Promise.allSettled([store.write(second,value),store.write(second,value)]);
 assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);assert.equal(attempts.filter(result=>result.status==='rejected'&&result.reason.code==='BROWSER_RECEIPT_EXISTS').length,1);
 assert.deepEqual((await fs.readdir(path.dirname(file))).sort(),[id+'.json',second+'.json'].sort());
});
test('invalid key, schema, secrets, noncanonical ingredients and oversized baseline fail before creating receipt',async t=>{
 const {dir,store,id}=await fixture(t);
 for(const key of ['../escape','',7,'not-a-uuid',id+'\n'])await assert.rejects(store.write(key,record()),{code:'BROWSER_RECEIPT_INVALID'});
 for(const patch of [{schema:2},{jobId:randomUUID()},{nonce:'wrong'},{cookies:'private'},{accountId:0},{accountEmail:'wrong'},{projectURL:'https://evil.test/project/a'},{ingredients:['https://flow-content.google/image/a?token=private']},{ingredients:['https://flow-content.google/video/a']},{baseline:[{path:'/private/result'}]},{baseline:[{id:'../escape'}]},{baseline:Array.from({length:150},()=>({name:'x'.repeat(20000)}))}])await assert.rejects(store.write(id,{...record(),...patch}),{code:'BROWSER_RECEIPT_INVALID'});
 await assert.rejects(fs.access(path.join(dir,'browser-receipts')),{code:'ENOENT'});
});
test('read rejects unsafe permissions symlink hardlink corruption and mismatched stored key',async t=>{
 const {dir,store,id}=await fixture(t);await store.write(id,record());const file=path.join(dir,'browser-receipts',id+'.json'),bytes=await fs.readFile(file);
 await fs.chmod(file,0o644);await assert.rejects(store.read(id),{code:'BROWSER_RECEIPT_UNSAFE'});await fs.chmod(file,0o600);
 await fs.writeFile(file,'not-json');await assert.rejects(store.read(id),{code:'BROWSER_RECEIPT_INVALID'});
 await fs.writeFile(file,JSON.stringify(record()));await assert.rejects(store.read(id),{code:'BROWSER_RECEIPT_INVALID'});
 await fs.writeFile(file,JSON.stringify({...record(),jobId:randomUUID()}));await assert.rejects(store.read(id),{code:'BROWSER_RECEIPT_INVALID'});
 await fs.writeFile(file,bytes);const linked=path.join(dir,'hardlink');await fs.link(file,linked);await assert.rejects(store.read(id),{code:'BROWSER_RECEIPT_UNSAFE'});await fs.unlink(linked);
 await fs.unlink(file);await fs.symlink(path.join(dir,'outside.json'),file);await assert.rejects(store.read(id),error=>error.code==='ELOOP');
});
test('unsafe receipt directory and failed atomic write never return a submitted receipt',async t=>{
 const {dir,store,id}=await fixture(t),folder=path.join(dir,'browser-receipts');await fs.mkdir(folder,{mode:0o755});
 await assert.rejects(store.write(id,record()),{code:'BROWSER_RECEIPT_UNSAFE'});await fs.chmod(folder,0o700);
 t.mock.method(fs,'link',async()=>{throw Object.assign(new Error('Synthetic full disk'),{code:'ENOSPC'});});
 await assert.rejects(store.write(id,record()),{code:'ENOSPC'});assert.deepEqual(await fs.readdir(folder),[]);
});
test('optional source video receipt binds canonical video identity duration and image limit while old receipts stay valid',async t=>{
 const {store,id}=await fixture(t),video={...record(),sourceVideo:'https://flow-content.google/video/original-video-id',sourceVideoDuration:3.029333};
 assert.equal((await store.write(id,video)).sourceVideoDuration,3.029333);assert.equal((await store.read(id)).sourceVideo,video.sourceVideo);
 for(const patch of [{sourceVideoDuration:undefined},{sourceVideo:undefined},{sourceVideoDuration:16},{sourceVideoDuration:0},{sourceVideo:'https://flow-content.google/image/wrong'},{sourceVideo:'https://flow-content.google/video/id?private=secret'},{ingredients:Array(6).fill('https://flow-content.google/image/ref')}])await assert.rejects(store.write(randomUUID(),{...video,...patch}),{code:'BROWSER_RECEIPT_INVALID'});
 assert.equal((await store.write(randomUUID(),record())).sourceVideo,undefined);
});

test('source scene receipt stores honest local provenance and exact same-project scene without fabricating media id',async t=>{
 const {store,id}=await fixture(t),projectId='5927b3e9-314b-432f-af56-b76efcd20c51',sceneId='64df1ca9-2566-47cc-aefe-b92454c346ed';
 const value={...record(),model:'omni-1.2-flash-edit-portrait-360p',projectURL:'https://flow.google.com/project/'+projectId,sourceScene:{url:'https://flow.google.com/project/'+projectId+'/edit/'+sceneId,poster:'https://flow.google.com/asb/imported-source-poster',sha256:'a'.repeat(64),durationSeconds:3.029333,width:360,height:640}};
 const saved=await store.write(id,value),read=await store.read(id);
 assert.deepEqual(read.sourceScene,value.sourceScene);assert.equal(saved.schema,1);assert.equal(read.sourceVideo,undefined);
 const canonicalPoster='https://flow-content.google/image/'+sceneId,canonical={...value,sourceScene:{...value.sourceScene,poster:canonicalPoster}};
 assert.deepEqual((await store.write(randomUUID(),canonical)).sourceScene,canonical.sourceScene);
 for(const poster of [canonicalPoster+'?signature=private',canonicalPoster+'#fragment',canonicalPoster+'\n',canonicalPoster.replace('https://','https://user:pass@'),canonicalPoster.replace('flow-content.google','flow-content.google.evil.test'),canonicalPoster.replace('/image/','/video/'),'https://storage.googleapis.com/ai-sandbox-videofx/image/'+sceneId])await assert.rejects(store.write(randomUUID(),{...canonical,sourceScene:{...canonical.sourceScene,poster}}),{code:'BROWSER_RECEIPT_INVALID'});
 for(const sourceScene of [null,{...value.sourceScene,url:value.sourceScene.url+'?token=private'},{...value.sourceScene,url:value.sourceScene.url.replace(projectId,randomUUID())},{...value.sourceScene,poster:'https://evil.example/asb/source'},{...value.sourceScene,poster:value.sourceScene.poster+'?signature=private'},{...value.sourceScene,sha256:'wrong'},{...value.sourceScene,durationSeconds:0},{...value.sourceScene,durationSeconds:16},{...value.sourceScene,width:640,height:360},{...value.sourceScene,cookies:'private'},Object.fromEntries(Object.entries(value.sourceScene).filter(([key])=>key!=='sha256'))])await assert.rejects(store.write(randomUUID(),{...value,sourceScene}),{code:'BROWSER_RECEIPT_INVALID'});
 await assert.rejects(store.write(randomUUID(),{...value,model:'omni-1.2-flash-8s-landscape'}),{code:'BROWSER_RECEIPT_INVALID'});
 await assert.rejects(store.write(randomUUID(),{...value,ingredients:Array(6).fill('https://flow-content.google/image/ref')}),{code:'BROWSER_RECEIPT_INVALID'});
 assert.equal((await store.write(randomUUID(),record())).sourceScene,undefined);
});

test('Agent proposal receipt binds observed image preview quote and exact approval title without invented session or video identity',async t=>{
 const {dir,store}=await fixture(t),projectId='5927b3e9-314b-432f-af56-b76efcd20c51',sceneId='0baaa1e6-f272-4bf7-a75d-5f05231b357e',resource='1091dac2-e2e4-4039-b234-2e90198017a0';
 const approvalText='Would you like me to kick off this 1 video generation, costing 36 credits?',base={...record(),model:'omni-1.2-flash-edit-portrait',projectURL:'https://flow.google.com/project/'+projectId,sourceScene:{url:'https://flow.google.com/project/'+projectId+'/edit/'+sceneId,poster:'https://flow-content.google/image/'+resource,sha256:'a'.repeat(64),durationSeconds:10.026667,width:720,height:1280}};
 for(const sourcePreview of ['https://storage.googleapis.com/ai-sandbox-videofx/image/'+resource,'https://flow-content.google/image/'+resource]){
  const id=randomUUID(),agentProposal={quoteCredits:36,videoCount:1,sourcePreview,approvalText},saved=await store.write(id,{...base,agentProposal}),reopened=await createReceiptStore(dir).read(id);
  assert.deepEqual(saved.agentProposal,agentProposal);assert.deepEqual(reopened.agentProposal,agentProposal);assert.equal(saved.sourceVideo,undefined);assert.equal(saved.schema,1);assert.equal(saved.prompt,base.prompt);assert.deepEqual(saved.ingredients,base.ingredients);
 }
 const valid={quoteCredits:36,videoCount:1,sourcePreview:'https://storage.googleapis.com/ai-sandbox-videofx/image/'+resource,approvalText};
 for(const agentProposal of [null,{},[],{...valid,quoteCredits:0},{...valid,quoteCredits:1.5},{...valid,quoteCredits:100001},{...valid,videoCount:2},{...valid,sourcePreview:valid.sourcePreview+'?Signature=private'},{...valid,sourcePreview:valid.sourcePreview+'#fragment'},{...valid,sourcePreview:valid.sourcePreview.replace(resource,sceneId)},{...valid,sourcePreview:'https://flow-content.google/video/'+resource},{...valid,sourcePreview:'https://flow.google.com/asb/opaque'},{...valid,sourcePreview:valid.sourcePreview.replace('https://','https://user:pass@')},{...valid,sourcePreview:valid.sourcePreview.replace('storage.googleapis.com','storage.googleapis.com.evil')},{...valid,approvalText:''},{...valid,approvalText:'Would you like me to kick off this 2 video generations, costing 36 credits?'},{...valid,approvalText:approvalText.replace('36','30')},{...valid,approvalText:approvalText+'\n'},{...valid,cookies:'private'},{...valid,messageIndex:0}])await assert.rejects(store.write(randomUUID(),{...base,agentProposal}),{code:'BROWSER_RECEIPT_INVALID'});
 for(const patch of [{sourceScene:undefined},{model:'omni-1.2-flash-10s-portrait'},{sourceScene:{...base.sourceScene,poster:'https://flow.google.com/asb/opaque-source'}},{sourceVideo:'https://flow-content.google/video/'+resource,sourceVideoDuration:10.026667}])await assert.rejects(store.write(randomUUID(),{...base,...patch,agentProposal:valid}),{code:'BROWSER_RECEIPT_INVALID'});
 assert.equal((await store.write(randomUUID(),base)).agentProposal,undefined);
});
