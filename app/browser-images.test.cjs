'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {imagePlanFor,supportsImageModel,imageDOM,runImage,prepareImagePage,verifyImagePage}=require('./browser-images.cjs');

const MODEL='gemini-3.1-flash-image-portrait';
const FAMILY='Nano Banana 2.1';
const image={kind:'image',dataUrl:'data:image/png;base64,fixture'};
function element(name,{role='radio',selected=false,text=name,visible=true,disabled=false}={}){
 const attrs={'aria-label':name,'aria-checked':String(selected),role};
 return {innerText:text,disabled,getAttribute:key=>attrs[key]??null,getClientRects:()=>visible?[{}]:[],closest:()=>null,
  click(){this.clicks=(this.clicks||0)+1;attrs['aria-checked']='true';},clicks:0};
}
function context(nodes,{origin='https://flow.google.com'}={}){
 return {location:{origin},getComputedStyle:()=>({visibility:'visible'}),document:{querySelector:()=>null,querySelectorAll:selector=>{
  if(selector==='input[type="radio"],[role="radio"]')return nodes.filter(node=>node.getAttribute('role')==='radio');
  if(selector==='[role="menuitem"],[role="option"]')return nodes.filter(node=>['menuitem','option'].includes(node.getAttribute('role')));
  if(selector==='button,[role="button"]')return nodes.filter(node=>node.getAttribute('role')==='button');
  return [];
 }}};
}
function domRun(nodes,op,arg,options){return vm.runInNewContext('('+imageDOM.toString()+')('+JSON.stringify(op)+','+JSON.stringify(arg||{})+')',context(nodes,options));}
function pageHarness(){
 const nodes=[element('image Image'),element('9:16'),element('Low'),element('Medium'),element('High'),element('x1'),element('Select model family',{role:'button',text:'🍌 Nano Banana 2.1\narrow_drop_down'}),element('🍌 Nano Banana 2.1',{role:'menuitem'})];
 let settingsOpen=false,modelOpen=false;
 const commands=[],clicks=[];
 const page={signal:undefined,client:{send:async(method,args)=>{
  commands.push({method,args});assert.equal(method,'Runtime.evaluate');
  const available=settingsOpen?nodes.filter(node=>node.getAttribute('role')!=='menuitem'||modelOpen):[];
  try{return {result:{value:vm.runInNewContext(args.expression,context(available))}};}catch(error){return {exceptionDetails:{exception:{description:error.message}}};}
 }},click:async name=>{clicks.push(name);if(name==='Триггер настроек')settingsOpen=!settingsOpen;else if(name==='Выбрать семейство моделей')modelOpen=true;else assert.fail('Unexpected control '+name);},until:async fn=>{const result=await fn();assert(result,'Expected immediate fixture state');return result;}};
 return {page,nodes,commands,clicks,isOpen:()=>settingsOpen};
}

test('image plans retain exact model, prompt and ordered references for three observed families and five aspects',()=>{
 const aspects={landscape:'16:9',portrait:'9:16',square:'1:1','four-three':'4:3','three-four':'3:4'};
 for(const [prefix,family] of [['gemini-3.1-flash-image','Nano Banana 2.1'],['gemini-3.1-flash-lite-image','Nano Banana 2 Lite'],['gemini-3.0-pro-image','Nano Banana Pro']])for(const [suffix,aspect] of Object.entries(aspects)){
  const model=prefix+'-'+suffix,refs=[image,{...image,dataUrl:'second'}],plan=imagePlanFor({model,prompt:'  original\nprompt  ',references:refs});
  assert.equal(supportsImageModel({model}),true);assert.equal(plan.model,model);assert.equal(plan.prompt,'  original\nprompt  ');assert.equal(plan.family,family);assert.equal(plan.aspect,aspect);assert.equal(plan.kind,'image');assert.equal(plan.method,'image');assert.equal(plan.quality,'Low');assert.equal(plan.resolution,'standard');assert.deepEqual(plan.refs,refs);assert(Object.isFrozen(plan));
 }
 const plan=imagePlanFor({model:MODEL,prompt:'image',images:['first','second']});assert.deepEqual(plan.refs,[{kind:'image',dataUrl:'first'},{kind:'image',dataUrl:'second'}]);
 assert.deepEqual(imagePlanFor({model:MODEL,prompt:'image'}).refs,[]);
});

test('unsupported aliases, unverified Lite resolutions and cross-method inputs fail before browser actions',()=>{
 for(const model of ['gemini-3.1-flash-image','gemini-3.1-flash-lite-image-portrait-2k','gemini-3.1-flash-lite-image-portrait-4k','gemini-3.1-flash-image-portrait-8k','gemini-3.2-flash-image-portrait','omni-1.2-flash-3s-portrait',null]){
  assert.equal(supportsImageModel({model}),false);assert.throws(()=>imagePlanFor({model,prompt:'image'}),{code:'BROWSER_MODEL_UNSUPPORTED'});
 }
 for(const references of [{},[image,{kind:'video',path:'/source.mp4'}],Array(6).fill(image)])assert.throws(()=>imagePlanFor({model:MODEL,prompt:'image',references}),{code:'BROWSER_INPUT_UNSUPPORTED'});
 for(const input of [{images:'invalid'},{sourceVideoId:'flow-video'},{videoPaths:['/source.mp4']},{startFramePath:'/start.png'},{endFramePath:'/end.png'}])assert.throws(()=>imagePlanFor({model:MODEL,prompt:'image',...input}),{code:'BROWSER_INPUT_UNSUPPORTED'});
 for(const prompt of ['', '   ', 'x'.repeat(20001),null])assert.throws(()=>imagePlanFor({model:MODEL,prompt}),{code:'INVALID_ARGUMENTS'});
});

test('exact 2K and 4K image selectors retain upscale resolution and observed Low generation quality with no model fallback',()=>{
 for(const prefix of ['gemini-3.1-flash-image','gemini-3.0-pro-image'])for(const [suffix,resolution] of [['2k','2K'],['4k','4K']]){
  const model=prefix+'-portrait-'+suffix,plan=imagePlanFor({model,prompt:'High resolution image',references:[image]});
  assert.equal(supportsImageModel({model}),true);assert.equal(plan.model,model);assert.equal(plan.resolution,resolution);assert.equal(plan.quality,'Low');assert.equal(plan.aspect,'9:16');assert.deepEqual(plan.refs,[image]);
 }
});

test('image DOM chooses only exact observed model menu option and ignores selected dropdown text',()=>{
 const trigger=element('Select model family',{role:'button',text:'🍌 Nano Banana 2.1\narrow_drop_down'}),exact=element('🍌 Nano Banana 2.1',{role:'menuitem'}),other=element('🍌 Nano Banana 2 Lite',{role:'menuitem'});
 assert.equal(domRun([trigger,exact,other],'model'),FAMILY);assert.equal(domRun([trigger,exact,other],'choose-model',{family:FAMILY}),true);assert.equal(exact.clicks,1);assert.equal(trigger.clicks,0);assert.equal(other.clicks,0);
 assert.throws(()=>domRun([trigger,other],'choose-model',{family:FAMILY}),/MODEL_NOT_VERIFIED/);
 assert.throws(()=>domRun([exact,element('🍌 Nano Banana 2.1',{role:'option'})],'choose-model',{family:FAMILY}),/MODEL_NOT_VERIFIED/);
 assert.throws(()=>domRun([element('🍌 Nano Banana 2.1 Pro',{role:'menuitem'})],'choose-model',{family:FAMILY}),/MODEL_NOT_VERIFIED/);
});

test('image DOM exact radios reject ambiguity, wrong origin, disabled controls and mutation on read',()=>{
 const radio=element('image Image');assert.equal(domRun([radio],'radio',{name:'Image'}),false);assert.equal(radio.clicks,0);assert.equal(domRun([radio],'radio',{name:'Image',set:true}),true);assert.equal(radio.clicks,1);assert.equal(domRun([radio],'radio',{name:'Image'}),true);
 assert.throws(()=>domRun([radio,element('Image')],'radio',{name:'Image'}),/CONTROL_AMBIGUOUS/);
 assert.throws(()=>domRun([element('Image',{disabled:true})],'radio',{name:'Image',set:true}),/CONTROL_DISABLED/);
 assert.throws(()=>domRun([radio],'radio',{name:'Image'},{origin:'https://evil.example'}),/FLOW_LOGIN_REQUIRED/);
 assert.throws(()=>domRun([radio],'submit'),/INVALID_OPERATION/);
});

test('image settings select exact Image family aspect Low x1 and verify without Generate or uploads',async()=>{
 const h=pageHarness(),plan=imagePlanFor({model:MODEL,prompt:'Image',references:[image,image]});
 await prepareImagePage(h.page,plan);assert.equal(h.isOpen(),false);assert.deepEqual(h.clicks,['Триггер настроек','Выбрать семейство моделей','Триггер настроек']);
 for(const name of ['image Image','9:16','Low','x1'])assert.equal(h.nodes.find(node=>node.getAttribute('aria-label')===name).clicks,1);
 await verifyImagePage(h.page,plan);assert.equal(h.isOpen(),false);assert.equal(h.nodes.find(node=>node.getAttribute('role')==='menuitem').clicks,1,'Verification never changes model');
 assert(h.commands.every(command=>command.method==='Runtime.evaluate'));assert.equal(h.commands.some(command=>/submit|Generate|setFileInputFiles/.test(command.args.expression)),false);
});

test('higher image selectors keep Low generation settings while retaining exact 2K or 4K upscale plan',async()=>{
 for(const suffix of ['2k','4k']){
  const h=pageHarness(),plan=imagePlanFor({model:MODEL+'-'+suffix,prompt:'Image'});await prepareImagePage(h.page,plan);await verifyImagePage(h.page,plan);
  assert.equal(h.isOpen(),false);assert.equal(h.nodes.find(node=>node.getAttribute('aria-label')==='Low').clicks,1);assert.equal(h.nodes.find(node=>node.getAttribute('aria-label')==='Medium').clicks,0);assert.equal(h.nodes.find(node=>node.getAttribute('aria-label')==='High').clicks,0);
 }
});

test('settings verification fails closed on changed model or quality and closes owned settings',async()=>{
 for(const change of ['model','quality']){
  const h=pageHarness(),plan=imagePlanFor({model:MODEL,prompt:'Image'});await prepareImagePage(h.page,plan);
  if(change==='model')h.nodes.find(node=>node.getAttribute('role')==='button').innerText='🍌 Nano Banana Pro\narrow_drop_down';
  else h.nodes.splice(h.nodes.findIndex(node=>node.getAttribute('aria-label')==='Low'),1,element('Low'));
  await assert.rejects(verifyImagePage(h.page,plan),{code:'SETTINGS_CHANGED'});assert.equal(h.isOpen(),false);
 }
});

test('CDP errors preserve structured UI code and aborted helpers send no command',async()=>{
 const controller=new AbortController(),commands=[];controller.abort(new Error('Stop local image preparation'));
 const page={signal:controller.signal,client:{send:async(...args)=>commands.push(args)}};
 await assert.rejects(runImage(page,'model'),/Stop local image preparation/);assert.deepEqual(commands,[]);
 page.signal=undefined;page.client.send=async()=>({exceptionDetails:{exception:{description:'Error: MODEL_NOT_VERIFIED: Exact image family unavailable\n at imageDOM'}}});
 await assert.rejects(runImage(page,'model'),{code:'MODEL_NOT_VERIFIED',message:'Exact image family unavailable'});
});

test('failed settings cleanup preserves original preparation error and tampered plan sends no command',async()=>{
 const h=pageHarness(),plan=imagePlanFor({model:MODEL,prompt:'Image'});let clicks=0;
 h.page.click=async()=>{if(++clicks>1)throw new Error('Cleanup transport failed');};
 const original=Object.assign(new Error('Image controls missing'),{code:'CONTROL_NOT_FOUND'});h.page.until=async()=>{throw original;};
 await assert.rejects(prepareImagePage(h.page,plan),error=>error===original);
 const untouched=pageHarness();await assert.rejects(prepareImagePage(untouched.page,{...plan,family:'Nano Banana Pro'}),{code:'SETTINGS_CHANGED'});assert.deepEqual(untouched.commands,[]);assert.deepEqual(untouched.clicks,[]);
});
