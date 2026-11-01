const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {stageVideo,importMedia}=require('./input-files.cjs');
test('video staging copies original bytes privately and never exposes host path in request',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'flow-inputs-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'source.mp4'),bytes=Buffer.from('original media bytes');await fs.writeFile(file,bytes);
 const result=await stageVideo(file,path.join(root,'staged'));
 assert.deepEqual(await fs.readFile(result.target),bytes);
 assert.match(result.reference.file_id,/^[a-f0-9-]{36}\.mp4$/);
 assert.equal(result.reference.mime_type,'video/mp4');assert(!JSON.stringify(result.reference).includes(root));
 assert.equal((await fs.stat(result.target)).mode&0o777,0o600);
 await assert.rejects(stageVideo(path.join(root,'source.txt'),root),/MP4/);
 const big=path.join(root,'large.mp4');const handle=await fs.open(big,'w');await handle.truncate(100*1024*1024+1);await handle.close();
 await assert.rejects(stageVideo(big,path.join(root,'staged')),/100 МБ/);
 const link=path.join(root,'link.mp4');await fs.symlink(file,link);
 await assert.rejects(stageVideo(link,path.join(root,'staged')),/символической ссылкой/);
 assert.equal((await fs.readdir(path.join(root,'staged'))).length,1);
});
test('media import preserves mixed file order and original image bytes',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'flow-import-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const files=['first.JPG','clip.MOV','last.webp'].map(name=>path.join(root,name));
 for(const file of files)await fs.writeFile(file,Buffer.from('original'));
 const items=await importMedia(files,{allowVideos:true});
 assert.deepEqual(items,[
  {kind:'image',name:'first.JPG',dataUrl:'data:image/jpeg;base64,b3JpZ2luYWw='},
  {kind:'video',name:'clip.MOV',path:files[1]},
  {kind:'image',name:'last.webp',dataUrl:'data:image/webp;base64,b3JpZ2luYWw='}
 ]);
});
test('media import enforces native regular files, formats, count and size limits',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'flow-import-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const image=path.join(root,'image.png'),video=path.join(root,'clip.mp4'),folder=path.join(root,'folder.png'),link=path.join(root,'link.png');
 await fs.writeFile(image,'image');await fs.writeFile(video,'video');await fs.mkdir(folder);await fs.symlink(image,link);
 for(const files of [image,Array(8).fill(image),['image.png'],['https://example.com/image.png'],['file://'+image],[{}],[folder],[link],[path.join(root,'unsupported.svg')]]){
  await assert.rejects(importMedia(files),Error);
 }
 for(const name of ['unsupported.svg','unsupported.constructor','unsupported.__proto__']){
  const file=path.join(root,name);await fs.writeFile(file,'unsupported');await assert.rejects(importMedia([file]),/формат/);
 }
 await assert.rejects(importMedia([video]),/формат|MP4|видео/i);
 await assert.rejects(importMedia([video],{allowVideos:'true'}),/формат|MP4|видео/i);
 for(const [name,size,options,limit] of [['large.png',20*1024*1024+1,{},/20 МБ/],['large.mp4',100*1024*1024+1,{allowVideos:true},/100 МБ/]]){
  const file=path.join(root,name),handle=await fs.open(file,'w');await handle.truncate(size);await handle.close();
  await assert.rejects(importMedia([file],options),limit);
 }
 await assert.rejects(importMedia([path.join(root,'missing.png')]),error=>{
  assert.match(error.message,/файл/i);assert(!error.message.includes(root));assert(!error.message.includes('ENOENT'));return true;
 });
});
