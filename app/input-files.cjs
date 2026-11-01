'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const IMAGE_MIME={__proto__:null,png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'};
const VIDEO_MIME={__proto__:null,mp4:'video/mp4',mov:'video/quicktime',m4v:'video/x-m4v'};
async function importMedia(files,options={}){
 if(!Array.isArray(files))throw new Error('Выберите файлы с диска.');
 if(files.length>7)throw new Error('Выберите не больше семи файлов.');
 const allowVideos=options?.allowVideos===true,items=[];
 for(const file of files){
  if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))throw new Error('Нужен обычный файл с диска.');
  const ext=path.extname(file).slice(1).toLowerCase(),mime=IMAGE_MIME[ext],video=VIDEO_MIME[ext];
  if(!mime&&!(allowVideos&&video))throw new Error('Неподдерживаемый формат. Выберите PNG, JPG, JPEG, WEBP или GIF'+(allowVideos?', либо видео MP4, MOV или M4V.':'.'));
  let handle;
  try{handle=await fs.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}catch{throw new Error('Не удалось открыть обычный файл с диска.');}
  try{
   let stat;try{stat=await handle.stat();}catch{throw new Error('Не удалось прочитать файл с диска.');}
   if(!stat.isFile())throw new Error('Выберите обычный файл.');
   const limit=(video?100:20)*1024*1024,message=video?'Видео больше 100 МБ.':'Изображение больше 20 МБ.';
   if(stat.size>limit)throw new Error(message);
   if(video){items.push({kind:'video',name:path.basename(file),path:file});continue;}
   let bytes;try{bytes=await handle.readFile();}catch{throw new Error('Не удалось прочитать файл с диска.');}
   if(bytes.length>limit)throw new Error(message);
   items.push({kind:'image',name:path.basename(file),dataUrl:'data:'+mime+';base64,'+bytes.toString('base64')});
  }finally{await handle.close().catch(()=>{});}
 }
 return items;
}
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
module.exports={stageVideo,importMedia,VIDEO_MIME};
