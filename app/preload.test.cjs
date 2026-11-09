'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function loadPreload(getPathForFile){
 let api,apiName;const calls=[];
 const electron={contextBridge:{exposeInMainWorld(name,value){apiName=name;api=value;}},webUtils:{getPathForFile},ipcRenderer:{invoke(...args){calls.push(args);return Promise.resolve([]);}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'preload.cjs'),'utf8'),{require:name=>{assert.equal(name,'electron');return electron;}});
 return {api,apiName,calls};
}
test('drop bridge resolves native File paths in order and sends only import options',async()=>{
 const image={},video={},h=loadPreload(file=>file===image?'/native/image.png':file===video?'/native/clip.mov':'');
 await h.api.dropMedia([image,video],{allowVideos:true,ignored:'value'});
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls)),[['studio:dropMedia',['/native/image.png','/native/clip.mov'],{allowVideos:true}]]);
});
test('drop bridge rejects synthetic files and oversized lists before IPC without leaking paths',async()=>{
 let resolutions=0;const h=loadPreload(file=>{resolutions++;if(file.synthetic)return '';throw new Error('not a File: /private/host-path');});
 for(const files of [[{synthetic:true}],[{}],['/private/host-path'],null,Array(8).fill({})]){
  await assert.rejects(h.api.dropMedia(files),error=>{assert(!error.message.includes('/private'));assert.match(error.message,/[а-яё]/i);return true;});
 }
 assert.equal(resolutions,3);assert.equal(h.calls.length,0);
});


test('account controls forward only exact id and boolean to trusted IPC',async()=>{
 const h=loadPreload(()=>{});
 await h.api.setAccountActive(7,false);await h.api.deleteAccount(7);await h.api.checkEnabledAccounts();
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls)),[['studio:setAccountActive',7,false],['studio:deleteAccount',7],['studio:checkEnabledAccounts']]);
});


test('Flow handoff forwards no arbitrary URL or account data',async()=>{
 const h=loadPreload(()=>{});await h.api.openFlow('https://attacker.invalid');
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls)),[['studio:openFlow']]);
});

test('provider settings bridge exposes only fixed IPC methods on flowStudio',async()=>{
 const h=loadPreload(()=>{});assert.equal(h.apiName,'flowStudio');
 await h.api.getProviderSettings('/arbitrary/endpoint');
 await h.api.saveTwoCaptchaKey('synthetic-key',{captcha_method:'twocaptcha'});
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls)),[['studio:getProviderSettings'],['studio:saveTwoCaptchaKey','synthetic-key']]);
});
