const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {stageVideo}=require('./input-files.cjs');
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
