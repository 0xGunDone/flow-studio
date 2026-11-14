'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {supportsVeoModel,veoPlanFor}=require('./browser-video-models.cjs');
const image={kind:'image',dataUrl:'data:image/png;base64,first'};

test('Veo plans preserve each exact current standard model, family, method, duration, aspect and ordered frame roles',()=>{
 let count=0;
 for(const family of ['lite','fast','quality'])for(const seconds of [4,6,8])for(const orientation of ['landscape','portrait'])for(const operation of ['', 'i2v-']){
  const model=`veo-3.1-${family}-${operation}${seconds}s-${orientation}`,refs=operation?[image,{kind:'image',dataUrl:'data:image/png;base64,last'}]:[],plan=veoPlanFor({model,prompt:'  Original\nprompt  ',references:refs});
  assert.equal(supportsVeoModel({model}),true);assert.equal(plan.model,model);assert.equal(plan.kind,'video');assert.equal(plan.family,'Veo 3.1 '+family[0].toUpperCase()+family.slice(1));assert.equal(plan.method,operation?'frames':'text');assert.equal(plan.seconds,seconds);assert.equal(plan.aspect,orientation==='portrait'?'9:16':'16:9');assert.equal(plan.resolution,'720p');assert.equal(plan.requiredTier,seconds===8?'':'Ultra');assert.equal(plan.prompt,'  Original\nprompt  ');assert.deepEqual(plan.refs,refs);assert(Object.isFrozen(plan));count++;
 }
 assert.equal(count,36);
});

test('Veo ingredients accept exactly one to three images only for listed Lite/Fast eight-second variants',()=>{
 for(const family of ['lite','fast'])for(const orientation of ['portrait','landscape']){
  const model=`veo-3.1-${family}-r2v-8s-${orientation}`;
  for(const count of [1,2,3]){const refs=Array.from({length:count},(_,i)=>({...image,dataUrl:'reference-'+i})),plan=veoPlanFor({model,prompt:'Animate ingredients',references:refs});assert.equal(plan.method,'ingredients');assert.equal(plan.minImages,1);assert.equal(plan.maxImages,3);assert.deepEqual(plan.refs,refs);assert.equal(plan.seconds,8);}
  for(const count of [0,4])assert.throws(()=>veoPlanFor({model,prompt:'Animate ingredients',references:Array(count).fill(image)}),{code:'BROWSER_INPUT_UNSUPPORTED'});
 }
});

test('known default aliases retain exact chosen ID with eight-second landscape text semantics',()=>{
 for(const family of ['lite','fast','quality']){
  const model='veo-3.1-'+family,plan=veoPlanFor({model,prompt:'Default alias'});
  assert.equal(plan.model,model);assert.equal(plan.seconds,8);assert.equal(plan.aspect,'16:9');assert.equal(plan.method,'text');assert.deepEqual(plan.refs,[]);
 }
});

test('unsupported Veo IDs never select a nearby family duration method resolution or legacy spelling',()=>{
 for(const model of ['veo-3.1-quality-r2v-8s-landscape','veo-3.1-lite-r2v-4s-landscape','veo-3.1-fast-extend-8s-landscape','veo-3.1-fast-edit-landscape','veo-3.1-fast-i2v-10s-portrait','veo-3.1-fast-8s-square','veo-3.1-fast-8s-landscape-1080p','veo-3.1-fast-8s-landscape-4k','veo_3_1_t2v_fast_portrait','veo-3.2-fast-8s-portrait','omni-1.2-flash-8s-landscape',null]){
  assert.equal(supportsVeoModel({model}),false);assert.throws(()=>veoPlanFor({model,prompt:'Requested exact model'}),{code:'BROWSER_MODEL_UNSUPPORTED'});
 }
});

test('Veo text never infers ingredients and frames require start before optional end',()=>{
 const text='veo-3.1-fast-8s-portrait',frames='veo-3.1-fast-i2v-8s-portrait';
 assert.throws(()=>veoPlanFor({model:text,prompt:'Text',references:[image]}),{code:'BROWSER_INPUT_UNSUPPORTED'});
 assert.throws(()=>veoPlanFor({model:frames,prompt:'Frames',references:[]}),{code:'BROWSER_INPUT_UNSUPPORTED'});
 assert.throws(()=>veoPlanFor({model:frames,prompt:'Frames',references:Array(3).fill(image)}),{code:'BROWSER_INPUT_UNSUPPORTED'});
 const plan=veoPlanFor({model:frames,prompt:'Frames',images:['start','end']});assert.deepEqual(plan.refs,[{kind:'image',dataUrl:'start'},{kind:'image',dataUrl:'end'}]);assert.equal(plan.minImages,1);assert.equal(plan.maxImages,2);
 for(const count of [1,2])assert.equal(veoPlanFor({model:frames,prompt:'Frames',references:Array(count).fill(image)}).refs.length,count);
});

test('invalid input kinds, source videos and malformed prompts fail locally before any browser work',()=>{
 const model='veo-3.1-fast-i2v-8s-portrait';
 for(const input of [{references:{}},{images:'not-array'},{references:[{kind:'video',path:'/source.mp4'}]},{sourceVideoId:'existing-video',references:[image]},{videoPaths:['/source.mp4'],references:[image]},{startFramePath:'/start.png',references:[image]},{endFramePath:'/end.png',references:[image]}])assert.throws(()=>veoPlanFor({model,prompt:'Frames',...input}),{code:'BROWSER_INPUT_UNSUPPORTED'});
 for(const prompt of ['', '   ', null, 'x'.repeat(20001)])assert.throws(()=>veoPlanFor({model,prompt,references:[image]}),{code:'INVALID_ARGUMENTS'});
});
