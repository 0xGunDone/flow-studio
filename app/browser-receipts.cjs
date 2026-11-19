'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {modelSettings}=require('./renderer.js');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const validId=value=>typeof value==='string'&&value.length===36&&UUID.test(value);
const MAX_BYTES=2*1024*1024;
const fail=(message,code='BROWSER_RECEIPT_INVALID')=>Object.assign(new Error(message),{code});
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
function validate(jobId,value){
 if(!validId(jobId)||!plain(value)||Object.keys(value).some(key=>!['schema','jobId','nonce','model','prompt','accountId','accountEmail','projectURL','ingredients','baseline','createdAt','sourceVideo','sourceVideoDuration','sourceScene','agentProposal'].includes(key)))throw fail('Некорректная запись отправки браузера.');
 const record={schema:1,jobId,nonce:jobId,...value};
 if(record.schema!==1||record.jobId!==jobId||!validId(record.nonce)||typeof record.model!=='string'||!record.model||record.model.length>200||typeof record.prompt!=='string'||!record.prompt.trim()||record.prompt.length>20000||!Number.isSafeInteger(record.accountId)||record.accountId<=0||typeof record.accountEmail!=='string'||record.accountEmail.length>320||!/^[^\s@]+@[^\s@]+$/.test(record.accountEmail)||typeof record.projectURL!=='string'||/[\r\n]/.test(record.projectURL)||!/^https:\/\/flow\.google\.com\/project\/[A-Za-z0-9_-]+$/.test(record.projectURL)||typeof record.createdAt!=='string'||!Number.isFinite(Date.parse(record.createdAt)))throw fail('Некорректные данные отправки браузера.');
 const frames=modelSettings({id:record.model}).methods.includes('frames');
 const verifiedIngredient=value=>typeof value==='string'&&!/[\r\n]/.test(value)&&(/^https:\/\/flow-content\.google\/image\/[A-Za-z0-9_-]{1,256}$/.test(value)||frames&&/^https:\/\/flow\.google\.com\/asb\/[A-Za-z0-9_=\-]{1,4096}$/.test(value));
 if(!Array.isArray(record.ingredients)||record.ingredients.length>7||record.ingredients.some(value=>!verifiedIngredient(value)))throw fail('Некорректные ингредиенты записи отправки.');
 if(record.sourceVideo!==undefined||record.sourceVideoDuration!==undefined){if(typeof record.sourceVideo!=='string'||/[\r\n]/.test(record.sourceVideo)||!/^https:\/\/flow-content\.google\/video\/[A-Za-z0-9_-]{1,256}$/.test(record.sourceVideo)||typeof record.sourceVideoDuration!=='number'||!Number.isFinite(record.sourceVideoDuration)||record.sourceVideoDuration<=0||record.sourceVideoDuration>15.02||record.ingredients.length>5)throw fail('Некорректное исходное видео записи отправки.');}
 if(record.sourceScene!==undefined){
  const scene=record.sourceScene,model=/^omni-1\.2-flash-edit-(landscape|portrait)(-360p)?$/.exec(record.model);
  const dimensions=model?(model[2]?(model[1]==='portrait'?[360,640]:[640,360]):model[1]==='portrait'?[720,1280]:[1280,720]):[];
  const scenePath=typeof scene?.url==='string'&&scene.url.startsWith(record.projectURL+'/edit/')?scene.url.slice((record.projectURL+'/edit/').length):null;
  if(!plain(scene)||Object.keys(scene).length!==6||Object.keys(scene).some(key=>!['url','poster','sha256','durationSeconds','width','height'].includes(key))||!model||!validId(scenePath)||!validId(record.projectURL.slice('https://flow.google.com/project/'.length))||typeof scene.poster!=='string'||/[\r\n]/.test(scene.poster)||!/^https:\/\/(?:flow\.google\.com\/asb\/[A-Za-z0-9_-]{1,4096}|flow-content\.google\/image\/[A-Za-z0-9_-]{1,256})$/.test(scene.poster)||typeof scene.sha256!=='string'||!/^[a-f0-9]{64}$/.test(scene.sha256)||!Number.isFinite(scene.durationSeconds)||scene.durationSeconds<=0||scene.durationSeconds>15.02||scene.width!==dimensions[0]||scene.height!==dimensions[1]||record.ingredients.length>5)throw fail('Некорректная привязка исходной сцены редактирования.');
 }
 if(record.agentProposal!==undefined){
  const proposal=record.agentProposal,preview=typeof proposal?.sourcePreview==='string'?/^https:\/\/(?:flow-content\.google\/image\/|storage\.googleapis\.com\/ai-sandbox-videofx\/image\/)([a-f0-9-]{36})$/i.exec(proposal.sourcePreview):null,source=typeof record.sourceScene?.poster==='string'?/^https:\/\/flow-content\.google\/image\/([a-f0-9-]{36})$/i.exec(record.sourceScene.poster):null;
  if(!plain(proposal)||Object.keys(proposal).length!==4||Object.keys(proposal).some(key=>!['quoteCredits','videoCount','sourcePreview','approvalText'].includes(key))||!/^omni-1\.2-flash-edit-(landscape|portrait)(-360p)?$/.test(record.model)||!record.sourceScene||record.sourceVideo!==undefined||record.sourceVideoDuration!==undefined||!Number.isSafeInteger(proposal.quoteCredits)||proposal.quoteCredits<=0||proposal.quoteCredits>100000||proposal.videoCount!==1||!preview||!validId(preview[1])||!source||!validId(source[1])||preview[1]!==source[1]||proposal.approvalText!=='Would you like me to kick off this 1 video generation, costing '+proposal.quoteCredits+' credits?')throw fail('Некорректное подтверждение предложения помощника Flow.');
 }
 if(!Array.isArray(record.baseline)||record.baseline.length>2000||record.baseline.some(value=>!plain(value)||!Object.keys(value).length||Object.keys(value).some(key=>!['id','name','poster'].includes(key))||Object.values(value).some(text=>typeof text!=='string'||text.length>20000)||value.id!==undefined&&!/^[A-Za-z0-9_-]{1,256}$/.test(value.id)))throw fail('Некорректная исходная история Flow.');
 const safe=JSON.parse(JSON.stringify(record));
 if(Buffer.byteLength(JSON.stringify(safe),'utf8')>MAX_BYTES)throw fail('Запись отправки браузера больше 2 МБ.');
 return safe;
}
function privateEntry(stat,directory=false){
 if((directory?!stat.isDirectory():!stat.isFile())||stat.isSymbolicLink()||process.getuid&&stat.uid!==process.getuid()||(stat.mode&0o077)!==0||!directory&&(stat.nlink!==1||stat.size>MAX_BYTES))throw fail('Недопустимый файл записи отправки.','BROWSER_RECEIPT_UNSAFE');
}
function createReceiptStore(dataDir){
 if(typeof dataDir!=='string'||!path.isAbsolute(dataDir)||dataDir.includes('\0'))throw new TypeError('Absolute dataDir required.');
 const folder=path.join(dataDir,'browser-receipts');
 const fileFor=jobId=>{if(!validId(jobId))throw fail('Некорректный ID записи отправки.');return path.join(folder,jobId+'.json');};
 const ensureFolder=async()=>{await fs.mkdir(folder,{recursive:true,mode:0o700});privateEntry(await fs.lstat(folder),true);};
 return {
  async write(jobId,value){
   const target=fileFor(jobId),record=validate(jobId,value);await ensureFolder();
   const temporary=path.join(folder,'.'+jobId+'.'+randomUUID()+'.tmp');
   try{
    await fs.writeFile(temporary,JSON.stringify(record),{flag:'wx',mode:0o600,flush:true});
    await fs.link(temporary,target);await fs.unlink(temporary);
    const directory=await fs.open(folder,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    try{await directory.sync();}finally{await directory.close();}
    return record;
   }catch(error){if(error.code==='EEXIST')throw fail('Запись этой отправки уже существует. Повторная отправка запрещена.','BROWSER_RECEIPT_EXISTS');throw error;}
   finally{await fs.unlink(temporary).catch(()=>{});}
  },
  async read(jobId){
   const target=fileFor(jobId);privateEntry(await fs.lstat(folder),true);
   const file=await fs.open(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
   try{privateEntry(await file.stat());const bytes=await file.readFile();if(bytes.length>MAX_BYTES)throw fail('Запись отправки браузера больше 2 МБ.');let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw fail('Запись отправки браузера повреждена.');}if(value?.schema!==1||value.jobId!==jobId||!validId(value.nonce))throw fail('Некорректная сохраненная запись отправки.');return validate(jobId,value);}finally{await file.close();}
  },
 };
}
module.exports={createReceiptStore};
