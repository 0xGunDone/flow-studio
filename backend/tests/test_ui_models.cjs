// No browser, dependencies, credentials or generation requests needed.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '../static/test.html'), 'utf8');
const sampleIds = [
  'gemini-3.1-flash-image-landscape', 'veo-3.1-fast',
  'veo-3.1-fast-8s-landscape', 'veo-3.1-lite-6s-portrait',
  'veo-3.1-quality-i2v-4s-landscape', 'veo-3.1-fast-r2v-8s-portrait',
  'veo-3.1-fast-extend-8s-landscape', 'omni-1.1-flash',
  'omni-1.1-flash-10s-portrait', 'veo_3_1_t2v_fast',
  'veo_3_1_interpolation_lite_8s', 'veo_3_1_i2v_s_4k'
];
const models = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : sampleIds.map(id => ({id,description:id}));
class Element {
  constructor(){ this.children=[]; this.dataset={}; this.style={}; this.value=''; this.textContent=''; this.classList={toggle(){},add(){},remove(){}}; }
  set innerHTML(value){this.html=value;this.children=[];}
  get innerHTML(){return this.html||'';}
  appendChild(child){this.children.push(child);return child;}
  addEventListener(){}
}
const elements=new Map();
const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
const all=()=>{const result=[];const walk=n=>{result.push(n);n.children.forEach(walk);};walk(get('modelSidebar'));return result;};
get('apiKey').value='test-only';get('promptInput').value='Test';
const requests=[];const alerts=[];
const sandbox={console,TextDecoder,Date,alert:m=>alerts.push(m),STATE:{selectedModel:null,images:[],generating:false},window:{location:{origin:'http://localhost'}},
  document:{getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>all().filter(n=>n.dataset.model)},
  fetch:async(url,opts={})=>{if(opts.method==='POST'){requests.push(JSON.parse(opts.body));return {ok:true,body:{getReader:()=>({read:async()=>({done:true})})}};}return {ok:true,json:async()=>({data:models})};}
};
vm.createContext(sandbox);
for(const [,script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(script,sandbox);
(async()=>{
  await sandbox.loadModels();
  const rendered=all().filter(n=>n.dataset.model).map(n=>n.dataset.model);
  assert.deepEqual(rendered.slice().sort(),models.map(m=>m.id).sort(),'Every API model must render exactly once');
  vm.runInContext('ALL_MODELS = {...FALLBACK_MODELS}; renderSidebar()',sandbox);
  const fallback=Array.from(vm.runInContext('Object.keys(FALLBACK_MODELS)',sandbox));
  assert.deepEqual(all().filter(n=>n.dataset.model).map(n=>n.dataset.model).sort(),fallback.sort(),'Every fallback model must render once');
  sandbox.selectModel('omni-1.1-flash');
  assert.equal(get('imageUploadGroup').style.display,'block');
  assert.equal(sandbox.getModelMeta('omni-1.1-flash').maxImages,3);
  sandbox.selectModel('veo-3.1-fast-8s-landscape');
  assert.equal(get('imageUploadGroup').style.display,'none');
  sandbox.selectModel('veo-3.1-quality-i2v-4s-landscape');
  assert.equal(get('imageUploadGroup').style.display,'block');
  sandbox.selectModel('veo-3.1-fast-extend-8s-landscape');
  assert.equal(get('sourceVideoGroup').style.display,'block');
  await sandbox.generate();
  assert.equal(requests.length,0,'Extend needs a source before sending');
  get('sourceVideoId').value='12345678-1234-1234-1234-123456789abc';
  await sandbox.generate();
  assert.equal(requests[0].messages[0].content[1].image_url.url,'extend://12345678-1234-1234-1234-123456789abc');
  assert.equal(requests[0].model,'veo-3.1-fast-extend-8s-landscape');
  console.log(`PASS: ${models.length} API models + ${fallback.length} fallback models rendered; video inputs and extend request checked`);
})().catch(error=>{console.error(error);process.exitCode=1;});
