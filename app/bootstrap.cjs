'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');

async function writePrivateOnce(file,contents){
  try{await fs.writeFile(file,contents,{flag:'wx',mode:0o600});}
  catch(error){if(error.code!=='EEXIST')throw error;}
}

async function prepareEngine({dataDir,backendDir,version='1.0.0'}){
  if(!path.isAbsolute(dataDir)||!path.isAbsolute(backendDir))throw new Error('Нужны абсолютные пути приложения.');
  const engine=path.join(dataDir,'engine');
  for(const folder of [dataDir,engine,path.join(engine,'data'),path.join(engine,'tmp')])await fs.mkdir(folder,{recursive:true,mode:0o700});
  const configPath=path.join(engine,'setting.toml');
  let template=await fs.readFile(path.join(backendDir,'config','setting_example.toml'),'utf8');
  template=template.replace(/^api_key\s*=.*$/m,`api_key = "${crypto.randomBytes(32).toString('hex')}"`)
    .replace(/^admin_password\s*=.*$/m,`admin_password = "${crypto.randomBytes(24).toString('hex')}"`)
    .replace(/^captcha_method\s*=.*$/m,'captcha_method = "browser"')
    .replace(/^personal_project_pool_size\s*=.*$/m,'personal_project_pool_size = 1');
  await writePrivateOnce(configPath,template);
  const composePath=path.join(engine,'compose.json');
  // Compose interpolates dollar signs even in JSON. Escape filesystem paths.
  const source=value=>value.replace(/\$/g,()=> '$$');
  const compose={name:'flow-studio',services:{flow2api:{
    init:true,image:`flow-studio-engine:${version}`,
    build:{context:source(backendDir),dockerfile:'Dockerfile.headed'},
    ports:['127.0.0.1:38000:8000'],
    volumes:[
      {type:'bind',source:source(path.join(engine,'data')),target:'/app/data'},
      {type:'bind',source:source(path.join(engine,'tmp')),target:'/app/tmp'},
      {type:'bind',source:source(configPath),target:'/app/config/setting.toml',read_only:true},
    ],
    environment:{PYTHONUNBUFFERED:'1',ALLOW_DOCKER_HEADED_CAPTCHA:'true',DISPLAY:':99',XVFB_SCREEN:'1440x900x24'},
    shm_size:'2gb',restart:'no',
    healthcheck:{test:['CMD','python','-c',"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5).read()"],interval:'30s',timeout:'10s',start_period:'60s',retries:3},
  }}};
  await fs.writeFile(composePath,JSON.stringify(compose,null,2),{mode:0o600});
  return {composePath,databasePath:path.join(engine,'data','flow.db')};
}

module.exports={prepareEngine};
