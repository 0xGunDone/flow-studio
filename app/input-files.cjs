'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const VIDEO_MIME={mp4:'video/mp4',mov:'video/quicktime',m4v:'video/x-m4v'};
async function stageVideo(file,root){
 if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('Нужен абсолютный путь видео.');
 const ext=path.extname(file).slice(1).toLowerCase(),mime_type=VIDEO_MIME[ext];
 if(!mime_type)throw new Error('Видео: MP4, MOV или M4V.');
 let handle;
 try{handle=await fs.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch(error){
  if(error?.code==='ELOOP')throw new Error('Видео не должно быть символической ссылкой.');
  throw error;
 }let target;
 try{
  const stat=await handle.stat();if(!stat.isFile()||stat.size<=0||stat.size>100*1024*1024)throw new Error('Видео должно быть обычным файлом до 100 МБ.');
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const file_id=crypto.randomUUID()+'.'+ext;target=path.join(root,file_id);
  const output=await fs.open(target,'wx',0o600);
  try{
   let bytes=0;
   for await(const chunk of handle.createReadStream({autoClose:false})){
    bytes+=chunk.length;if(bytes>100*1024*1024)throw new Error('Видео изменилось или превышает 100 МБ.');
    await output.writeFile(chunk);
   }
   if(bytes!==stat.size)throw new Error('Видеофайл изменился во время чтения.');
  }
  finally{await output.close();}
  return {target,reference:{file_id,mime_type,filename:path.basename(file).slice(0,256)}};
 }catch(error){if(target)await fs.unlink(target).catch(()=>{});throw error;}
 finally{await handle.close();}
}
module.exports={stageVideo,VIDEO_MIME};
