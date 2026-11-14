'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vm=require('node:vm');

async function composer({result={token:'prepared-token',readyToSubmit:true,message:'Verified 1 reference'}}={}){
 const html=await fs.readFile(path.join(__dirname,'index.html'),'utf8');
 const nodes=new Map(),calls=[],prepareCalls=[];
 function node(id){
  if(nodes.has(id))return nodes.get(id);
  const listeners=new Map();
  const element={id,value:'',disabled:false,valid:true,replaceChildren(){},append(){},classList:{toggle(){}},addEventListener(type,fn){listeners.set(type,[...(listeners.get(type)||[]),fn]);},reportValidity(){return this.valid;},
   async dispatch(type,details={}){const event={target:this,currentTarget:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...details};for(const fn of listeners.get(type)||[])await fn(event);return event;},
   async click(){if(this.disabled)return;const event=await this.dispatch('click');if(this.type==='submit'&&!event.defaultPrevented)await node('generation-form').requestSubmit(this);},
   requestSubmit(submitter){return this.reportValidity()?this.dispatch('submit',{submitter}):Promise.resolve();}};
  nodes.set(id,element);return element;
 }
 node('generate').type=html.match(/<button\b[^>]*\bid="generate"[^>]*>/)?.[0].match(/\btype="([^"]+)"/)?.[1]||'submit';
 const source=await fs.readFile(path.join(__dirname,'renderer.js'),'utf8');
 const startup='  renderResult(); renderHistory(); renderAccounts();\n';
 assert.equal(source.split(startup).length,2);
 // Run real initialization and listeners; omit display/bootstrap startup, which needs live state.
 const isolated=source.slice(0,source.indexOf(startup)).replace("if (typeof document !== 'undefined') initialize();",'')+'  return state;\n}\ninitialize();';
 const state=vm.runInNewContext(isolated,{document:{getElementById:node,querySelectorAll:()=>[],createElement:()=>({})},window:{addEventListener(){},flowStudio:{async prepareNativeBrowser(input){prepareCalls.push(input);return result;},async generate(request){calls.push(request);throw new Error('stubbed generation');}}},console},{filename:'renderer.js'});
 Object.assign(state,{ready:true,startupPending:false,models:[{id:'gemini-3.1-flash-image-landscape'}],accounts:[{id:1,isActive:true}]});
 node('model').value=state.models[0].id;node('prompt').value='test prompt';
 return {node,state,calls,prepareCalls};
}

test('native preparation forwards ingredients without prompt/model changes and requires verified readiness',async()=>{
 for(const readyToSubmit of [true,false]){
  const h=await composer({result:{token:'prepared-token',readyToSubmit,message:'attachment verification result'}});
  const image={kind:'image',name:'original mascot.png',dataUrl:'data:image/png;base64,aGVsbG8='};
  Object.assign(h.state,{mode:'video',videoMethod:'ingredients',references:[image]});
  h.node('model').value='omni-1.2-flash-10s-portrait';h.node('prompt').value='exact prompt';h.node('browser-account').value='1';
  await h.node('browser-prepare').click();
  assert.equal(h.prepareCalls.length,1);
  const input=h.prepareCalls[0];
  assert.equal(input.model,'omni-1.2-flash-10s-portrait');assert.equal(input.prompt,'exact prompt');
  assert.equal(input.images.length,1);assert.equal(input.images[0].name,image.name);assert.equal(input.images[0].dataUrl,image.dataUrl);
  assert.equal(h.state.browserPreparedToken,readyToSubmit?'prepared-token':null);
  assert.equal(h.node('browser-submit').disabled,!readyToSubmit);
  assert.equal(h.calls.length,0);
 }
});

test('native preparation refuses frames, unsupported model and video references without API call',async()=>{
 for(const mode of ['frames','video','model']){
  const h=await composer();Object.assign(h.state,{mode:'video',videoMethod:mode==='frames'?'frames':'ingredients',references:mode==='video'?[{kind:'video',path:'/tmp/input.mp4'}]:[]});
  h.node('model').value=mode==='model'?'veo-3.1-fast-r2v-8s-portrait':'omni-1.2-flash-10s-portrait';h.node('browser-account').value='1';
  await h.node('browser-prepare').click();
  assert.equal(h.prepareCalls.length,0);assert.equal(h.state.browserPreparedToken,null);assert.equal(h.node('browser-check-error').hidden,false);
 }
});
