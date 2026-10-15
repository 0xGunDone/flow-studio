const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {startAgentBridge,createAgentActions,generationInput,capabilities}=require('./agent-bridge.cjs');
const {Runtime}=require('./runtime.cjs');
test('MCP frame and reference inputs map to correct model payload',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'flow-agent-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const start=path.join(dir,'start.png'),end=path.join(dir,'end.jpg');
 await fs.writeFile(start,'start');await fs.writeFile(end,'end');
 const runtime={models:[{id:'veo-3.1-fast-i2v-4s-landscape'},{id:'omni-1.1-flash'},{id:'gemini-3.1-flash-image-landscape-4k'},{id:'veo-3.1-fast-extend-8s-landscape'}]};
 const base={prompt:'move',requestId:'one',confirmCreditSpend:true};
 const frames=await generationInput(runtime,{...base,model:runtime.models[0].id,startFramePath:start,endFramePath:end});
 assert.equal(frames.images[0],'data:image/png;base64,c3RhcnQ=');assert.equal(frames.images[1],'data:image/jpeg;base64,ZW5k');
 await assert.rejects(generationInput(runtime,{...base,model:runtime.models[0].id,endFramePath:end}),/startFramePath/);
 await assert.rejects(generationInput(runtime,{...base,model:runtime.models[1].id,referencePaths:Array(4).fill(start)}),/от 0 до 3/);
 await assert.rejects(generationInput(runtime,{...base,model:runtime.models[1].id,confirmCreditSpend:false}),/confirmCreditSpend/);
 assert.equal(capabilities(runtime.models[2]).resolution,'4K');
});
test('stable requestId never submits same paid task twice and rejects changed input',()=>{
 const runtime=new Runtime({});runtime.ready=true;runtime.models=[{id:'omni-1.1-flash'}];let count=0;runtime.runJob=async()=>{count++;};
 const p={model:'omni-1.1-flash',prompt:'move',requestId:'stable'};
 const a=runtime.generate(p),b=runtime.generate(p);assert.deepEqual(a,b);assert.equal(count,1);
 assert.throws(()=>runtime.generate({...p,prompt:'different'}),/другими параметрами/);
});
test('bridge accepts only authenticated local requests, stores private discovery file',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'flow-bridge-'));
 const bridge=await startAgentBridge({dataDir:dir,dispatch:async(method,params)=>({method,params})});
 t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
 const file=path.join(dir,'agent-bridge.json'),info=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal((await fs.stat(file)).mode&0o777,0o600);
 const url='http://127.0.0.1:'+info.port;
 assert.equal((await fetch(url+'/health')).status,401);
 const headers={Authorization:'Bearer '+info.token,'Content-Type':'application/json'};
 assert.equal((await fetch(url+'/health',{headers:{...headers,Origin:'http://evil.example'}})).status,403);
 const response=await fetch(url+'/rpc',{method:'POST',headers,body:JSON.stringify({method:'status',params:{}})});
 assert.deepEqual(await response.json(),{result:{method:'status',params:{}}});
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
