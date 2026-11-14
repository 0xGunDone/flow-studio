'use strict';

const IMAGE=/^(gemini-3\.1-flash-image|gemini-3\.1-flash-lite-image|gemini-3\.0-pro-image)-(landscape|portrait|square|four-three|three-four)(?:-(2k|4k))?$/;
const families={'gemini-3.1-flash-image':'Nano Banana 2.1','gemini-3.1-flash-lite-image':'Nano Banana 2 Lite','gemini-3.0-pro-image':'Nano Banana Pro'};
const aspects={landscape:'16:9',portrait:'9:16',square:'1:1','four-three':'4:3','three-four':'3:4'};
const fail=(code,message)=>Object.assign(new Error(message),{code});

function supportsImageModel(input){const match=IMAGE.exec(input?.model||'');return Boolean(match&&!(match[1]==='gemini-3.1-flash-lite-image'&&match[3]));}
function imagePlanFor(input){
 const match=IMAGE.exec(input?.model||'');
 if(!match||!supportsImageModel(input))throw fail('BROWSER_MODEL_UNSUPPORTED','Фоновая генерация изображений поддерживает точные модели Nano Banana из каталога; Nano Banana 2 Lite принимает стандартное разрешение.');
 if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>20000)throw fail('INVALID_ARGUMENTS','Введите запрос длиной до 20 000 символов.');
 if(input.images!==undefined&&!Array.isArray(input.images)||input.sourceVideoId!==undefined||input.videoPaths!==undefined||input.startFramePath!==undefined||input.endFramePath!==undefined)throw fail('BROWSER_INPUT_UNSUPPORTED','Генерация изображения принимает только изображения-референсы, до пяти файлов.');
 const refs=input.references??(input.images||[]).map(dataUrl=>({kind:'image',dataUrl}));
 if(!Array.isArray(refs)||refs.length>5||refs.some(reference=>reference?.kind!=='image'))throw fail('BROWSER_INPUT_UNSUPPORTED','Генерация изображения принимает только изображения-референсы, до пяти файлов.');
 // Flow exposes 2K/4K as download upscales; generation quality stays on the observed Low setting.
 return Object.freeze({kind:'image',method:'image',model:input.model,prompt:input.prompt,refs,family:families[match[1]],aspect:aspects[match[2]],resolution:match[3]?match[3].toUpperCase():'standard',quality:'Low'});
}

// Runs inside Flow's managed page; only observed settings controls are allowed.
function imageDOM(op,arg={}){
 const error=(code,message)=>{throw new Error(code+': '+message);};
 if(location.origin!=='https://flow.google.com')error('FLOW_LOGIN_REQUIRED','Войдите в аккаунт через Flow Studio.');
 const visible=element=>Boolean(element?.getClientRects().length&&getComputedStyle(element).visibility!=='hidden'&&!element.closest?.('[aria-hidden="true"],[inert]'));
 const text=element=>(element?.innerText||element?.textContent||'').trim();
 const clean=value=>value.replace(/^(?:image|videocam|crop_free|crop_16_9|crop_landscape|crop_square|crop_portrait|crop_9_16)\s+/,'').replace(/^🍌\s*/,'').replace(/\s*arrow_drop_down\s*$/,'').replace(/\s+/g,' ').trim();
 const label=element=>clean(element.getAttribute('aria-label')||element.getAttribute('title')||text(element));
 const all=role=>[...document.querySelectorAll(role==='radio'?'input[type="radio"],[role="radio"]':role==='model-option'?'[role="menuitem"],[role="option"]':'button,[role="button"]')].filter(visible);
 const one=(role,name)=>{
  const found=all(role).filter(element=>label(element)===name);
  if(found.length!==1)error(found.length?'CONTROL_AMBIGUOUS':'CONTROL_NOT_FOUND','Не удалось однозначно найти '+name);
  return found[0];
 };
 const click=element=>{if(element.disabled||element.getAttribute('aria-disabled')==='true')error('CONTROL_DISABLED','Элемент пока недоступен.');element.click();};
 if(document.querySelector('input[type="password"]'))error('FLOW_VERIFICATION_REQUIRED','Подтвердите вход Google в окне входа Flow Studio.');
 if(op==='exists')return all(arg.role||'button').filter(element=>label(element)===arg.name).length===1;
 if(op==='radio'){
  if(!['Image','16:9','4:3','1:1','3:4','9:16','Low','x1'].includes(arg.name))error('CONTROL_NOT_FOUND','Параметр изображения не подтверждён.');
  const element=one('radio',arg.name),selected=element.checked===true||element.getAttribute('aria-checked')==='true';
  if(arg.set&&!selected)click(element);
  return arg.set?true:selected;
 }
 if(op==='model')return clean(text(one('button','Select model family')));
 if(op==='choose-model'){
  if(!['Nano Banana 2.1','Nano Banana 2 Lite','Nano Banana Pro'].includes(arg.family))error('MODEL_NOT_VERIFIED','Семейство изображения не подтверждено.');
  const found=all('model-option').filter(element=>label(element)===arg.family||clean(text(element))===arg.family);
  if(found.length!==1)error('MODEL_NOT_VERIFIED','Выбранное семейство Nano Banana отсутствует или неоднозначно.');
  click(found[0]);return true;
 }
 error('INVALID_OPERATION','Неизвестная операция настроек изображения.');
}

async function runImage(page,op,arg){
 page.signal?.throwIfAborted();
 const result=await page.client.send('Runtime.evaluate',{expression:'('+imageDOM.toString()+')('+JSON.stringify(op)+','+JSON.stringify(arg||{})+')',returnByValue:true,awaitPromise:true,userGesture:true});
 if(result.exceptionDetails){const description=result.exceptionDetails.exception?.description||'',match=description.match(/(?:Error: )?([A-Z][A-Z0-9_]+): ([^\n]+)/);throw fail(match?.[1]||'BROWSER_UI_ERROR',match?.[2]||'Не удалось прочитать настройки изображения Flow.');}
 return result.result?.value;
}

function checkedPlan(plan){
 const expected=imagePlanFor({model:plan?.model,prompt:plan?.prompt,references:plan?.refs});
 if(['kind','method','family','aspect','resolution','quality'].some(key=>plan[key]!==expected[key]))throw fail('SETTINGS_CHANGED','Настройки изображения не совпадают с точной моделью.');
 return expected;
}
async function withSettings(page,work){
 page.signal?.throwIfAborted();
 await page.click('Триггер настроек');
 let originalError;
 try{
  await page.until(()=>runImage(page,'exists',{role:'radio',name:'Image'}),15000,'image-settings');
  return await work();
 }catch(error){originalError=error;throw error;
 }finally{
  if(!page.signal?.aborted)try{await page.click('Триггер настроек');await page.until(async()=>!await runImage(page,'exists',{role:'radio',name:'Image'}),15000,'image-settings-closed');}catch(error){if(!originalError)throw error;}
 }
}
async function prepareImagePage(page,plan){
 const exact=checkedPlan(plan);
 await withSettings(page,async()=>{
  await runImage(page,'radio',{name:'Image',set:true});await page.until(()=>runImage(page,'radio',{name:'Image'}));
  await page.click('Выбрать семейство моделей');await runImage(page,'choose-model',{family:exact.family});
  await page.until(async()=>await runImage(page,'model')===exact.family,15000,'image-model');
  for(const name of [exact.aspect,exact.quality,'x1']){await runImage(page,'radio',{name,set:true});await page.until(()=>runImage(page,'radio',{name}));}
 });
}
async function verifyImagePage(page,plan){
 const exact=checkedPlan(plan);
 await withSettings(page,async()=>{
  for(const name of ['Image',exact.aspect,exact.quality,'x1'])if(!await runImage(page,'radio',{name}))throw fail('SETTINGS_CHANGED','Параметры изображения Flow изменились перед отправкой.');
  if(await runImage(page,'model')!==exact.family)throw fail('SETTINGS_CHANGED','Модель изображения Flow изменилась перед отправкой.');
 });
}

module.exports={imagePlanFor,supportsImageModel,imageDOM,runImage,prepareImagePage,verifyImagePage};
