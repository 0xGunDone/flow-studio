'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vm=require('node:vm');

async function composer(){
 const html=await fs.readFile(path.join(__dirname,'index.html'),'utf8');
 const nodes=new Map(),calls=[];
 function node(id){
  if(nodes.has(id))return nodes.get(id);
  const listeners=new Map();
  const attributes=new Map();
  const element={id,value:'',disabled:false,valid:true,classList:{toggle(){}},setAttribute(name,value){attributes.set(name,String(value));},removeAttribute(name){attributes.delete(name);},addEventListener(type,fn){listeners.set(type,[...(listeners.get(type)||[]),fn]);},reportValidity(){return this.valid;},
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
 const state=vm.runInNewContext(isolated,{document:{getElementById:node,querySelectorAll:()=>[]},window:{addEventListener(){},flowStudio:{async generate(request){calls.push(request);throw new Error('stubbed generation');}}},console},{filename:'renderer.js'});
 Object.assign(state,{ready:true,startupPending:false,models:[{id:'gemini-3.1-flash-image-landscape'}],accounts:[{id:1,isActive:true}]});
 node('model').value=state.models[0].id;node('prompt').value='test prompt';
 return {node,state,calls};
}

test('composer prevents implicit submit from select/input even when browser supplies default submitter',async()=>{
 const h=await composer();
 for(const submitter of [undefined,h.node('generate')]){
  const event=await h.node('generation-form').dispatch('submit',{submitter});
  assert.equal(event.defaultPrevented,true);
  assert.equal(h.calls.length,0);
 }
 assert.equal(h.node('generate').type,'button');
});

test('explicit Create and textarea Cmd/Ctrl+Enter each send once; plain Enter sends nothing',async()=>{
 const h=await composer();
 await h.node('generate').click();
 assert.equal(h.calls.length,1);
 const plain=await h.node('prompt').dispatch('keydown',{key:'Enter'});
 assert.equal(plain.defaultPrevented,false);
 assert.equal(h.calls.length,1);
 for(const modifier of ['metaKey','ctrlKey']){
  const event=await h.node('prompt').dispatch('keydown',{key:'Enter',[modifier]:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(event.defaultPrevented,true);
  assert.equal(h.calls.length,modifier==='metaKey'?2:3);
 }
 h.node('generate').disabled=true;
 await h.node('prompt').dispatch('keydown',{key:'Enter',metaKey:true});
 await h.node('generate').click();
 assert.equal(h.calls.length,3);
});

test('explicit Create retains native form validation',async()=>{
 const h=await composer();h.node('generation-form').valid=false;
 await h.node('generate').click();
 assert.equal(h.calls.length,0);
});
