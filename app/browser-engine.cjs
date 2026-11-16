'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {setTimeout:wait}=require('node:timers/promises');
const {createReceiptStore}=require('./browser-receipts.cjs');
const {stageVideo}=require('./input-files.cjs');
const {imagePlanFor,supportsImageModel,prepareImagePage,verifyImagePage}=require('./browser-images.cjs');
const {veoPlanFor,supportsVeoModel}=require('./browser-video-models.cjs');
const agentEditDefault=require('./browser-agent-edit.cjs');

const MODEL=/^omni-1\.2-flash-(i2v-)?([3-9]|1[0-5])s-(landscape|portrait)(-360p)?$/;
const EDIT=/^omni-1\.2-flash-edit-(landscape|portrait)(-360p)?$/;
const fail=(code,message)=>Object.assign(new Error(message),{code});
const samePrompt=(a,b)=>a.replace(/\r\n/g,'\n').replace(/\n+/g,'\n')===b.replace(/\r\n/g,'\n').replace(/\n+/g,'\n');
const exactHistoryPrompt=(actual,expected)=>typeof actual==='string'&&typeof expected==='string'&&samePrompt(actual.trim(),expected.trim());
async function abortable(work,signal){signal?.throwIfAborted();const running=Promise.resolve().then(()=>{signal?.throwIfAborted();return work();});if(!signal)return running;let onAbort;const cancelled=new Promise((_,reject)=>{onAbort=()=>reject(signal.reason||fail('CANCELLED','Действие отменено.'));signal.addEventListener('abort',onAbort,{once:true});});try{return await Promise.race([running,cancelled]);}finally{signal.removeEventListener('abort',onAbort);}}
function planFor(input){
 if(supportsImageModel(input))return imagePlanFor(input);
 if(supportsVeoModel(input))return veoPlanFor(input);
 const match=MODEL.exec(input?.model==='omni-1.2-flash'?'omni-1.2-flash-8s-landscape':input?.model||'');
 const edit=EDIT.exec(input?.model||'');
 if(edit){
  if(input.sourceVideoId!==undefined)throw fail('BROWSER_INPUT_UNSUPPORTED','Редактирование исходного видео нельзя смешивать с продлением видео.');
  const refs=input.references||[],videos=refs.filter(r=>r?.kind==='video'),images=refs.filter(r=>r?.kind==='image');
  if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>20000)throw fail('INVALID_ARGUMENTS','Введите запрос длиной до 20 000 символов.');
  if(videos.length!==1||images.length>5||refs.length!==videos.length+images.length||typeof videos[0].path!=='string'||!path.isAbsolute(videos[0].path))throw fail('BROWSER_INPUT_UNSUPPORTED','Для редактирования нужно одно видео и до пяти изображений.');
  return Object.freeze({model:input.model,prompt:input.prompt,refs:images,video:videos[0],method:'edit',aspect:edit[1]==='portrait'?'9:16':'16:9',resolution:edit[2]?'360p':'720p'});
 }
 if(!match)throw fail('BROWSER_MODEL_UNSUPPORTED','Фоновый браузер пока поддерживает Omni 1.2 Flash: текст и изображения-ингредиенты.');
 if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>20000)throw fail('INVALID_ARGUMENTS','Введите запрос длиной до 20 000 символов.');
 const refs=input.references??(input.images||[]).map(dataUrl=>({kind:'image',dataUrl}));
 const frames=Boolean(match[1]),seconds=Number(match[2]);
 if(!Array.isArray(refs)||refs.length>(frames?seconds>10?1:2:7)||frames&&!refs.length||refs.some(r=>r?.kind!=='image'))throw fail('BROWSER_INPUT_UNSUPPORTED',frames?'Для кадров нужен начальный и, при поддержке моделью, конечный кадр.':'Для этого режима нужны только изображения-ингредиенты, до семи файлов.');
 if(input.sourceVideoId)throw fail('BROWSER_INPUT_UNSUPPORTED','Продолжение видео использует отдельный режим.');
 return Object.freeze({model:input.model,prompt:input.prompt,refs,method:frames?'frames':'ingredients',seconds,aspect:match[3]==='portrait'?'9:16':'16:9',resolution:match[4]?'360p':'720p'});
}
function decodeImage(dataUrl){
 const m=/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl||'');
 if(!m)throw fail('INVALID_REFERENCE','Нужен PNG, JPEG, WebP или GIF.');
 const bytes=Buffer.from(m[2],'base64');
 if(!bytes.length||bytes.length>20*1024*1024||bytes.toString('base64')!==m[2])throw fail('INVALID_REFERENCE','Некорректное изображение или размер больше 20 МБ.');
 const valid=m[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):m[1]==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:m[1]==='webp'?bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP':['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6));
 if(!valid)throw fail('INVALID_REFERENCE','Формат изображения не совпадает с содержимым.');
 return {bytes,ext:m[1]==='jpeg'?'jpg':m[1],sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
function mediaIdentity(value,kind='image'){
 try{const u=new URL(value);return u.origin==='https://flow-content.google'&&!u.username&&!u.password&&new RegExp('^/'+kind+'/[A-Za-z0-9_-]{1,256}$').test(u.pathname)?u.origin+u.pathname:null;}catch{return null;}
}
function allowedDownload(value,kind='video'){try{const u=new URL(value);if(u.username||u.password)return false;if(u.origin==='https://flow-content.google'&&new RegExp('^/'+(kind==='image'?'image':'video')+'/[A-Za-z0-9_-]{1,256}$').test(u.pathname))return true;return u.protocol==='blob:'&&!u.search&&!u.hash&&/^https:\/\/flow\.google\.com\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(u.pathname);}catch{return false;}}

// This function runs in the app-owned Flow page. It reads DOM and uses ordinary controls only.
function flowDOM(op,arg={}){
 const error=(code,message)=>{throw new Error(code+': '+message);};
 const samePrompt=(a,b)=>a.replace(/\r\n/g,'\n').replace(/\n+/g,'\n')===b.replace(/\r\n/g,'\n').replace(/\n+/g,'\n');
 if(op==='diagnostic'){
  const raw=[...document.querySelectorAll('button,[role="button"]')];
  const isVisible=el=>Boolean(el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden');
  const name=el=>el.getAttribute('aria-label')||el.getAttribute('title')||(el.innerText||el.textContent||'').trim();
  const count=(pattern,shown=false)=>Math.min(1000,raw.filter(el=>(!shown||isVisible(el))&&pattern.test(name(el))).length);
  const bounded=n=>Number.isFinite(n)?Math.max(0,Math.min(10000,Math.round(n))):null;
  return {origin:location.origin==='https://flow.google.com'?'flow':location.origin==='https://accounts.google.com'?'accounts':location.href==='about:blank'?'blank':'other',path:location.pathname==='/'?'home':/^\/project\//.test(location.pathname)?'project':/\/edit\//.test(location.pathname)?'edit':'other',readyState:document.readyState,lang:/^ru(?:-|$)/i.test(document.documentElement.lang)?'ru':/^en(?:-|$)/i.test(document.documentElement.lang)?'en':'other',visibility:document.visibilityState,width:bounded(innerWidth),height:bounded(innerHeight),buttonCount:Math.min(1000,raw.length),accountRu:count(/^Сведения об аккаунте$/),accountRuVisible:count(/^Сведения об аккаунте$/,true),accountEn:count(/^(Account information|Account info|Account details)$/),accountEnVisible:count(/^(Account information|Account info|Account details)$/,true),signIn:count(/^(Sign in|Войти|Sign in with Google|Войти через Google)$/)>0,password:Boolean(document.querySelector('input[type="password"]')),projectLinkCount:Math.min(1000,[...document.querySelectorAll('a[href]')].filter(a=>/^\/project\//.test(a.getAttribute('href'))).length)};
 }
 if(location.origin!=='https://flow.google.com')error('FLOW_LOGIN_REQUIRED','Войдите в аккаунт через Flow Studio.');
 const aliases={
  'Сведения об аккаунте':['Account information','Account info','Account details'],
  'Настройки аккаунта':['Account settings'],
  'Закрыть панель аккаунта':['Close account panel'],
  'Открыть проект':['Open project'],
  'Что вы хотите создать?':['What do you want to create?'],
  'Триггер настроек':['Settings trigger','Settings'],
  'Видео':['Video'],'Ингредиенты':['Ingredients'],'Кадры':['Frames'],'Изображение':['Image'],
  'Старт':['Start'],'Конец':['End'],
  'Выбрать семейство моделей':['Select model family'],
  'Длительность':['Duration','Length'],'Начать генерацию':['Start generation'],
  'Ингредиент':['Ingredient','Image ingredient'],'Изображение ингредиента':['Ingredient image'],
  'Добавить ингредиенты в окно запроса':['Add ingredients to prompt','Add ingredients to the prompt box'],
  'Загрузить':['Upload','Upload media'],'Добавить в запрос':['Add to prompt'],'Добавить медиа':['Add media menu'],
  'Значок сгенерированного видео':['Generated video thumbnail'],
  'История':['History'],'Скачать медиаконтент':['Download media'],
  '720p Исходный размер':['720p Original size'],
  '360p Исходный размер':['360p Original size'],
  '360p 360p: видео генерируется быстрее, но разрешение ниже':['360p 360p: faster generation, lower resolution']
 };
 const canonical=value=>{const clean=value.replace(/^(?:image|videocam|upload|crop_free|chrome_extension|crop_16_9|crop_landscape|crop_square|crop_portrait|crop_9_16)\s+/,'');if(/^360p\s+info$/.test(clean))return '360p 360p: видео генерируется быстрее, но разрешение ниже';if(/^(360p|720p|1K|2K|4K)\s+(Original size|Исходный размер)$/.test(clean))return clean.match(/^(360p|720p|1K|2K|4K)/)[1]+' Исходный размер';return Object.entries(aliases).find(([,values])=>values.includes(clean))?.[0]||clean;};
 const visible=el=>{if(!el||!el.getClientRects().length||getComputedStyle(el).visibility==='hidden'||el.closest?.('[aria-hidden="true"],[inert]'))return false;if(typeof innerWidth==='number'&&innerWidth>0&&el.getBoundingClientRect){const r=el.getBoundingClientRect();if(r.bottom<=0||r.right<=0||r.top>=innerHeight||r.left>=innerWidth)return false;}return true;};
 const text=el=>(el?.innerText||el?.textContent||'').trim();
 const label=el=>canonical(el.getAttribute('aria-label')||el.getAttribute('title')||text(el));
 const all=(role,root=document)=>[...root.querySelectorAll(role==='button'?'button,[role="button"]':role==='radio'?'input[type="radio"],[role="radio"]':role==='option'?'[role="option"]':role==='menuitem'?'[role="menuitem"]':role==='textbox'?'[role="textbox"],textarea,input[type="text"]':role==='group'?'[role="group"]':'[role="'+role+'"]')].filter(visible);
 const one=(role,name,root=document)=>{
  if(role==='button'&&['Триггер настроек','Agent'].includes(name)&&root===document){
   const prompts=all('textbox').filter(el=>label(el)==='Что вы хотите создать?'&&!el.closest?.('flow-agent-panel'));
   if(prompts.length!==1)error('CONTROL_AMBIGUOUS','Не удалось однозначно найти редактор Flow.');
   let container=prompts[0].parentElement;
   while(container&&container!==document.body&&!all('button',container).some(el=>label(el)==='Начать генерацию'))container=container.parentElement;
   if(!container||container===document.body)error('CONTROL_NOT_FOUND','Не удалось проверить настройки редактора Flow.');
   root=container;
  }
  let xs=all(role,root).filter(el=>label(el)===name);if(role==='textbox'&&name==='Что вы хотите создать?'){const main=xs.filter(el=>!el.closest?.('flow-agent-panel'));if(main.length)xs=main;}if(xs.length!==1)error(xs.length?'CONTROL_AMBIGUOUS':'CONTROL_NOT_FOUND','Не удалось однозначно найти '+name);return xs[0];
 };
 const click=el=>{if(el.disabled||el.getAttribute('aria-disabled')==='true')error('CONTROL_DISABLED','Элемент пока недоступен.');el.click();};
 const point=el=>{if(el.disabled||el.getAttribute('aria-disabled')==='true')error('CONTROL_DISABLED','Элемент пока недоступен.');const r=el.getBoundingClientRect();if(r.width<=0||r.height<=0)error('CONTROL_HIDDEN','Элемент недоступен в окне Flow.');const x=r.left+r.width/2,y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);if(!hit||!(hit===el||el.contains(hit)))error('CONTROL_OBSCURED','Кнопку Flow перекрывает другой элемент.');return {x,y};};
 const prompt=()=>{const edit=all('textbox').filter(el=>['Describe how to edit this video…','Опишите, как изменить это видео…','Describe how to edit this video...'].includes(el.getAttribute('aria-label')));return edit.length===1?edit[0]:one('textbox','Что вы хотите создать?');};
 const promptValue=()=>{const value=prompt().innerText;return /^[\r\n]*$/.test(value)?'':value;};
 const chips=()=>all('button').filter(el=>label(el)==='Ингредиент').map(el=>{const images=[...el.querySelectorAll('img[alt="Изображение ингредиента"],img[alt="Ingredient image"]')];if(images.length!==1)error('INGREDIENT_NOT_VERIFIED','Не удалось прочитать изображение ингредиента.');const u=new URL(images[0].currentSrc||images[0].src);if(u.origin!=='https://flow-content.google'||!/^\/image\/[A-Za-z0-9_-]{1,256}$/.test(u.pathname))error('INGREDIENT_NOT_VERIFIED','Не удалось проверить ресурс ингредиента.');return u.origin+u.pathname;});
 const blocked=[...document.querySelectorAll('[role="dialog"]')].filter(visible).some(el=>/подтвердите|verify|captcha|войти|sign in|consent/i.test(label(el)));
 if(blocked||document.querySelector('input[type="password"]'))error('FLOW_VERIFICATION_REQUIRED','Подтвердите вход или проверку Google в окне входа Flow Studio.');
 const uploadRights=()=>{const dialogs=[...document.querySelectorAll('[role="dialog"],mat-dialog-container')].filter(visible).filter(el=>all('button',el).some(button=>['I agree','Я согласен','Принимаю'].includes(label(button))));if(dialogs.length!==1)return null;const dialog=dialogs[0];const value=text(dialog);if(value.length>8192||!/Rights to use this (?:image|video)|Права на использование (?:этого )?(?:изображения|видео)/i.test(value))return null;return {dialog,text:value};};
 if(op==='upload-rights'){const rights=uploadRights();if(!rights)error('UPLOAD_RIGHTS_NOT_VERIFIED','Не удалось проверить запрос согласия Google.');return {text:rights.text};}
 if(op==='upload-rights-pending')return Boolean(uploadRights());
 if(op==='accept-upload-rights'){const rights=uploadRights();if(!rights||rights.text!==arg.text)error('UPLOAD_RIGHTS_CHANGED','Условия Google изменились после подтверждения.');const buttons=all('button',rights.dialog).filter(el=>['I agree','Я согласен','Принимаю'].includes(label(el)));if(buttons.length!==1)error('CONTROL_AMBIGUOUS','Не удалось однозначно найти согласие Google.');click(buttons[0]);return true;}
 if(op==='controls'){
  const known=value=>Object.hasOwn(aliases,value)||['Agent','16:9','9:16','x1','x2','x3','x4','720p','360p','Omni 1.2 Flash','Search','Search assets','Поиск','Поиск ресурсов'].includes(value);
  const labels=role=>all(role).map(el=>canonical(el.getAttribute('aria-label')||el.getAttribute('title')||(role==='textbox'?el.getAttribute('placeholder')||'':text(el)))).filter(known);
  const bounded=value=>/^\d{1,5}$/.test(value)?Number(value):null;
  return {buttons:labels('button').slice(0,100),radios:labels('radio').slice(0,40),textboxes:labels('textbox').slice(0,10),ranges:[...document.querySelectorAll('input[type="range"]')].filter(visible).filter(el=>canonical(el.getAttribute('aria-label')||'')==='Длительность').map(el=>({label:'Длительность',min:bounded(el.min),max:bounded(el.max),value:bounded(el.value)})).slice(0,10)};
 }
 if(op==='state')return {url:location.href,accountButtons:all('button').filter(el=>label(el)==='Сведения об аккаунте').length,projectLinks:[...document.querySelectorAll('a[href]')].filter(visible).map(a=>({href:a.getAttribute('href')})).filter(a=>/^\/project\/[A-Za-z0-9_-]+$/.test(a.href))};
 const sourcePosterIdentity=value=>{if(typeof value!=='string'||value!==value.trim()||/[\r\n]/.test(value))return null;if(/^https:\/\/flow\.google\.com\/asb\/[A-Za-z0-9_-]{1,4096}$/.test(value))return value;try{const u=new URL(value);return !u.username&&!u.password&&!u.hash&&u.origin==='https://flow-content.google'&&/^\/image\/[A-Za-z0-9_-]{1,256}$/.test(u.pathname)?u.origin+u.pathname:null;}catch{return null;}};
 const recoveryGroups=()=>[...document.querySelectorAll('flow-grid-tile-container[role="group"]')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&!el.closest?.('[aria-hidden="true"],[inert]'));
 if(op==='recovery-candidates')return recoveryGroups().filter(el=>el.querySelector(arg.kind==='image'?'flow-image-tile':'flow-video-tile,img[alt="Значок сгенерированного видео"],img[alt="Generated video thumbnail"]')).filter(el=>arg.kind!=='image'||Boolean(el.querySelector('img')?.complete&&el.querySelector('img').naturalWidth>0)).map(el=>({name:label(el),poster:el.querySelector('img')?.getAttribute('src')||''})).filter(el=>el.poster).slice(0,30);
 if(op==='open-recovery-candidate'){
  const xs=recoveryGroups().filter(el=>label(el)===arg.name&&(el.querySelector('img')?.getAttribute('src')||'')===arg.poster&&el.querySelector(arg.kind==='image'?'flow-image-tile':'flow-video-tile'));
  if(xs.length!==1)error('RESULT_AMBIGUOUS','Не удалось однозначно открыть готовое видео.');
  xs[0].scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
  const target=xs[0].querySelector(arg.kind==='image'?'flow-image-tile img':'flow-video-tile');if(!target)error('RESULT_NOT_READY','Изображение ещё не загрузилось.');if(!visible(target))return false;if(arg.kind==='image')return {openPoint:point(target)};click(target);target.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}));return true;
 }
 if(op==='failure-state')return {url:location.href,regions:[...document.querySelectorAll('[role="region"],aside')].filter(visible).map(el=>({name:el.getAttribute('aria-label'),tag:el.tagName,chars:text(el).length})).slice(0,20),buttons:all('button').map(el=>({name:label(el).slice(0,100),tag:el.tagName})).slice(-30),videos:document.querySelectorAll('video').length};
 if(op==='video-uploaded'){
  if(uploadRights())error('FLOW_UPLOAD_CONSENT_REQUIRED','Google просит подтвердить права на исходное видео. Генерация не запускалась.');
  if(typeof arg.name!=='string'||!/^[-A-Za-z0-9_]+\.(mp4|mov|m4v)$/i.test(arg.name))error('SOURCE_VIDEO_NOT_VERIFIED','Имя загруженного исходного видео не подтверждено.');
  const names=[arg.name,arg.name.replace(/\.(mp4|mov|m4v)$/i,'')];
  const xs=recoveryGroups().filter(el=>names.includes(label(el))&&el.querySelector('flow-video-tile'));
  if(xs.length>1)error('SOURCE_VIDEO_AMBIGUOUS','Имя исходного видео повторяется.');
  if(!xs.length)return false;
  xs[0].scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
  const image=xs[0].querySelector('img'),poster=sourcePosterIdentity(image?.getAttribute('src'));if(!poster||!image.complete||image.naturalWidth<=0)return false;
  if(arg.open){const video=xs[0].querySelector('flow-video-tile');if(!visible(video))return false;click(video);video.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}));}
  return {name:label(xs[0]),poster};
 }
 if(op==='source-scene')return sourceSceneState(arg.sourceScene||{poster:arg.poster,durationSeconds:arg.durationSeconds},Boolean(arg.output),arg.projectURL,Boolean(arg.loading),arg);
 if(op==='agent-scene-result')return agentSceneResult(arg);
 if(op==='edit-settings'){
  const model=one('button','Выбрать семейство моделей');
  if(arg.choose){click(model);return true;}
  if(arg.close){if(model.getAttribute('aria-expanded')==='true')click(model);return true;}
  const selected=text(model).replace(/arrow_drop_down/g,'').trim();
  if(selected!=='Omni 1.2 Flash')error('SETTINGS_CHANGED','Модель редактирования видео изменилась.');
  const clips=[...document.querySelectorAll('flow-scene-timeline .clip')];if(clips.length!==1)error('SOURCE_VIDEO_AMBIGUOUS','В сцене должно быть одно исходное видео.');
  if(arg.quote){
   const id=model.getAttribute('aria-controls'),menus=typeof id==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(id)?[...document.querySelectorAll('[id]')].filter(el=>el.getAttribute('id')===id&&el.getAttribute('role')==='menu'&&visible(el)):[];
   if(menus.length>1)error('MODEL_SETTINGS_NOT_VERIFIED','Меню стоимости Edit выбрано неоднозначно.');if(model.getAttribute('aria-expanded')!=='true'||menus.length===0)return false;
   const costs=[...menus[0].querySelectorAll('flow-credit-cost-label .credit-cost-link')].filter(visible);if(costs.length===0)return false;
   const cost=costs.length===1?/^([1-9]\d{0,4})\s+(?:credits?|кредит[а-я]*)$/i.exec(text(costs[0])):null;if(!cost)error('MODEL_SETTINGS_NOT_VERIFIED','Не удалось однозначно проверить стоимость Edit.');
   return {model:selected,clipCount:clips.length,url:location.href,credits:Number(cost[1])};
  }
  return {model:selected,clipCount:clips.length,url:location.href};
 }
 if(op==='composer-mode')return {agent:Boolean(prompt().closest('flow-agent-panel')),creative:Boolean(prompt().closest('flow-creative-agent-prompt-box')),ready:true};
 if(op==='close-empty-agent-panel'){
  const panels=[...document.querySelectorAll('flow-agent-panel')].filter(visible);if(!panels.length)return false;if(panels.length!==1)error('CONTROL_AMBIGUOUS','Найдено несколько панелей помощника Flow.');
  const panel=panels[0],roots=[...panel.querySelectorAll('flow-base-prompt-box')].filter(root=>root.closest('flow-agent-panel')===panel);
  if(roots.length!==1)error('CONTROL_AMBIGUOUS','Не удалось однозначно проверить редактор помощника Flow.');
  const root=roots[0],editors=[...root.querySelectorAll('flow-rich-text-editor [role="textbox"],textarea')].filter(node=>node.closest('flow-agent-panel')===panel&&node.closest('flow-base-prompt-box')===root),editable=[...root.querySelectorAll('[role="textbox"],textarea,[contenteditable="true"],input[type="text"]')].filter(node=>node.closest('flow-agent-panel')===panel&&node.closest('flow-base-prompt-box')===root);
  if(editors.length!==1||editable.some(node=>!editors.includes(node)))error('CONTROL_AMBIGUOUS','Не удалось проверить поле сообщения помощника Flow.');
  if(editors.some(node=>String(node.value??node.innerText??'').trim())||root.querySelectorAll('flow-ingredient-chip,flow-image-ingredient-chip,flow-video-ingredient-chip,button[aria-label="Ingredient"],button[aria-label="Image ingredient"],button[aria-label="Ингредиент"]').length)error('BROWSER_DRAFT_PRESENT','В помощнике Flow остался запрос или вложения. Они сохранены без изменений.');
  const buttons=[...panel.querySelectorAll('button,[role="button"]')].filter(node=>node.closest('flow-agent-panel')===panel&&node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden'&&!node.closest('[aria-hidden="true"],[inert]')&&['Close','Закрыть'].includes(node.getAttribute('aria-label')));if(buttons.length!==1)error('CONTROL_AMBIGUOUS','Не удалось однозначно закрыть пустую панель помощника Flow.');click(buttons[0]);return true;
 }
 if(op==='manual-mode'){
  const editor=prompt();if(!editor.closest('flow-creative-agent-prompt-box'))return false;
  if(editor.innerText.trim())error('BROWSER_DRAFT_PRESENT','В помощнике Flow остался незавершённый запрос. Он сохранён без изменений.');
  click(one('button','Agent'));return true;
 }
 if(op==='close-agent'){
  const editor=prompt();if(!editor.closest('flow-agent-panel'))return false;
  if(editor.innerText.trim())error('BROWSER_DRAFT_PRESENT','В помощнике Flow остался незавершённый запрос. Он сохранён без изменений.');
  const panel=editor.closest('flow-agent-panel');if(!panel)error('CONTROL_NOT_FOUND','Не удалось проверить панель помощника Flow.');
  const buttons=all('button',panel).filter(el=>['Close','Закрыть'].includes(el.getAttribute('aria-label')));
  if(buttons.length!==1)error('CONTROL_AMBIGUOUS','Не удалось однозначно закрыть помощник Flow.');click(buttons[0]);return true;
 }
 if(op==='click'){click(one(arg.role||'button',arg.name));return true;}
 if(op==='control-point')return point(one(arg.role||'button',arg.name));
 if(op==='control-box'){const element=one(arg.role||'button',arg.name),position=point(element),rect=element.getBoundingClientRect();return {...position,left:rect.left,top:rect.top,width:rect.width,height:rect.height};}
 if(op==='focus-control'){const el=one(arg.role||'button',arg.name);el.focus();return document.activeElement===el;}
 if(op==='hover-control'){const el=one(arg.role||'button',arg.name);el.dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}));el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));return true;}
 function downloadOptions(){
  if(!arg.menuId)return [...new Set([...all('button'),...all('menuitem')])];
  const menu=historyDownloadMenu(arg.binding,true);
  if(!menu||menu.getAttribute('id')!==arg.menuId)error('RESULT_INPUT_MISMATCH','Меню скачивания больше не связано с выбранной записью.');
  return all('menuitem',menu);
 }
 const optionText=element=>{if(!arg.menuId)return element.getAttribute('aria-label')||text(element);const labels=[...element.querySelectorAll('.item-text .label')],captions=[...element.querySelectorAll('.item-text .caption')];return labels.length===1&&captions.length===1?text(labels[0])+' '+text(captions[0]):'';};
 if(op==='download-option'){const name=arg.resolution+' Исходный размер';const xs=downloadOptions().filter(el=>canonical(optionText(el).replace(/\s+/g,' ').trim())===name);if(xs.length>1)error('CONTROL_AMBIGUOUS','Исходный размер видео выбран неоднозначно.');if(arg.click){if(xs.length!==1)error('CONTROL_NOT_FOUND','Исходный размер ещё не появился.');click(xs[0]);}return xs.length===1;}
 if(op==='image-download-option'){const options=downloadOptions();const pattern=arg.resolution==='1K'?/^1K\s+(Original size|Исходный размер)$/:new RegExp('^'+arg.resolution+'\\s+(Upscaled|Увеличенное|Увеличено|Увеличенный размер)(?:\\s+Upgrade)?$');const xs=options.filter(el=>pattern.test(optionText(el).replace(/\s+/g,' ').trim()));if(xs.length>1)error('CONTROL_AMBIGUOUS','Разрешение изображения выбрано неоднозначно.');if(xs.length&&((xs[0].disabled||xs[0].getAttribute('aria-disabled')==='true')||/Upgrade/.test(text(xs[0]))))error('IMAGE_RESOLUTION_UNAVAILABLE','Выбранное разрешение изображения недоступно для этого Google-тарифа.');if(arg.click){if(xs.length!==1)error('CONTROL_NOT_FOUND','Разрешение изображения ещё не появилось.');click(xs[0]);}return xs.length===1;}
 if(op==='exists')return all(arg.role||'button').filter(el=>label(el)===arg.name).length===1;
 if(op==='editor-account'){
  if(!/^\/project\/[A-Za-z0-9_-]+\/edit\/[a-f0-9-]{36}$/i.test(location.pathname))return null;
  const avatars=all('button').map(el=>el.getAttribute('aria-label')||'').filter(name=>/^Google Account:/.test(name));
  if(!avatars.length)return null;
  const found=avatars.length===1?avatars[0].match(/^Google Account:[^()]*\(\s*([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\s*\), Google membership$/):null;
  if(!found)error('ACCOUNT_MISMATCH','Не удалось однозначно подтвердить аккаунт редактора Flow.');
  return found[1].toLowerCase();
 }
 if(op==='account'){
  const panels=[...document.querySelectorAll('[role="dialog"],[aria-label="Настройки аккаунта"],[aria-label="Account settings"]')].filter(visible);
  const panel=panels.find(el=>label(el)==='Настройки аккаунта'||el.querySelector('[aria-label="Закрыть панель аккаунта"],[aria-label="Close account panel"]'));
  if(!panel)return null;
  const emails=[...text(panel).matchAll(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map(m=>m[0].toLowerCase());
  return [...new Set(emails)].length===1?emails[0]:null;
 }
 if(op==='project'){
  const links=[...document.querySelectorAll('a[href]')].filter(visible).filter(a=>/^\/project\/[A-Za-z0-9_-]+$/.test(a.getAttribute('href')));
  if(!links.length)error('FLOW_PROJECT_REQUIRED','Создайте проект в Flow через окно входа.');
  click(links[0]);return true;
 }
 if(op==='radio'){
  const el=one('radio',arg.name);const selected=el.checked===true||el.getAttribute('aria-checked')==='true';
  if(arg.set&&!selected)click(el);
  return arg.set?true:selected;
 }
 if(op==='model')return text(one('button','Выбрать семейство моделей')).replace(/arrow_drop_down/g,'').trim();
 if(op==='settings-summary')return text(one('button','Триггер настроек')).replace(/\s+/g,' ').trim();
 if(op==='model-option'){
  const family=arg.family||'Omni 1.2 Flash';const xs=[...document.querySelectorAll('[role="menuitem"],[role="option"]')].filter(visible).filter(el=>[family,family+'\nLeaving 5 Dec'].includes(label(el))||[family,family+'\nLeaving 5 Dec'].includes(text(el)));
  if(xs.length!==1)error('MODEL_NOT_VERIFIED','Omni 1.2 Flash отсутствует или выбран неоднозначно.');click(xs[0]);return true;
 }
 if(op==='duration'){
  const xs=[...document.querySelectorAll('input[type="range"][aria-label="Длительность"],input[type="range"][aria-label="Duration"],input[type="range"][aria-label="Length"]')].filter(visible);
  if(xs.length!==1||xs[0].min!=='0'||!['7','12'].includes(xs[0].max)||arg.seconds>Number(xs[0].max)+3)error('DURATION_NOT_VERIFIED','Не удалось проверить длительность Omni 1.2 Flash.');
  if(arg.set!==undefined){const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(xs[0],String(arg.set));xs[0].dispatchEvent(new Event('input',{bubbles:true}));xs[0].dispatchEvent(new Event('change',{bubbles:true}));}
  return {value:Number(xs[0].value),text:[arg.seconds+' сек.',arg.seconds+' sec.',arg.seconds+' sec',arg.seconds+'s'].some(value=>document.body.innerText.includes(value))};
 }
 if(op==='composer')return {prompt:promptValue(),ingredients:chips(),generateEnabled:!one('button','Начать генерацию').disabled};
 if(op==='prompt-state'){const actual=prompt().innerText,expected=arg.expected;let firstDifference=0;while(firstDifference<actual.length&&firstDifference<expected.length&&actual[firstDifference]===expected[firstDifference])firstDifference++;return {actualLength:actual.length,expectedLength:expected.length,firstDifference,actualCode:actual.charCodeAt(firstDifference)||null,expectedCode:expected.charCodeAt(firstDifference)||null,trimEqual:actual.trim()===expected.trim(),paragraphEqual:samePrompt(actual,expected),lineBreakEqual:actual.replace(/\r\n/g,'\n')===expected.replace(/\r\n/g,'\n')};}
 if(op==='focus-prompt'){const el=prompt();el.focus();const range=document.createRange();range.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(range);return document.activeElement===el;}
 if(op==='clear-owned'){
  const c={prompt:promptValue(),ingredients:chips()};
  if(!samePrompt(c.prompt,arg.prompt)||JSON.stringify(c.ingredients)!==JSON.stringify(arg.ingredients))return false;
  for(const el of all('button').filter(el=>label(el)==='Ингредиент'))click(el);
  return true;
 }
 if(op==='file-input'){
  const xs=[...document.querySelectorAll('input[type="file"]')];if(xs.length!==1)error('FILE_INPUT_AMBIGUOUS','Не удалось найти поле загрузки изображения.');return xs[0];
 }
 if(op==='asset'){
  if(all('button').some(el=>['I agree','Я согласен','Принимаю'].includes(label(el))))error('FLOW_UPLOAD_CONSENT_REQUIRED','Google просит подтвердить права на изображение. Подтвердите запрос в Flow Studio. Генерация не запускалась.');
  const xs=[...new Set([...all('option'),...all('button')])].filter(el=>!el.closest?.('flow-navigation-rail,flow-navigation-rail-thumbnail')).filter(el=>[arg.name,arg.name+' Изображение',arg.name+' Image'].includes(label(el).replace(/\s+/g,' ')));
  if(xs.length>1)error('INGREDIENT_AMBIGUOUS','Повтор имени загруженного изображения.');
  if(arg.select&&xs.length===1)click(xs[0]);
  const preview=[...document.querySelectorAll('img')].find(el=>visible(el)&&['Предпросмотр ресурса "'+arg.name+'"','Asset preview "'+arg.name+'"','Preview of '+arg.name].includes(el.alt));
  return {exists:xs.length===1,preview:preview?(preview.currentSrc||preview.src):null,ingredients:chips()};
 }
 if(op==='baseline')return all('group').map(el=>{const poster=el.querySelector('img')?.getAttribute('src')||'';if(el.querySelector('flow-pending-tile')&&!poster)error('FLOW_EXISTING_GENERATION','В проекте уже есть незавершённая генерация. Дождитесь результата перед новым запуском.');el.setAttribute('data-flow-studio-baseline',arg.job);return {name:label(el),poster};});
 if(op==='bind-result'){
  const existing=[...document.querySelectorAll('[data-flow-studio-baseline]')].filter(el=>el.getAttribute('data-flow-studio-baseline')===arg.job);
  const reused=new Set();
  if(existing.length!==arg.baseline.length){
   const current=all('group');
   for(const previous of arg.baseline){
    if(!previous.poster)error('RESULT_BINDING_CHANGED','Flow изменил незавершённую карточку. Проверьте проект перед повторной отправкой.');
    const matches=current.filter(el=>label(el)===previous.name&&(el.querySelector('img')?.getAttribute('src')||'')===previous.poster);
    if(matches.length!==1||reused.has(matches[0]))error('RESULT_BINDING_CHANGED','Flow перестроил прежние карточки. Проверьте проект перед повторной отправкой.');
    reused.add(matches[0]);
   }
  }
  const matches=all('group').filter(el=>el.querySelector(arg.kind==='image'?'flow-image-tile,flow-pending-tile':'flow-video-tile,flow-pending-tile,img[alt="Значок сгенерированного видео"],img[alt="Generated video thumbnail"]')||[...el.querySelectorAll('mat-icon,[role="alert"]')].some(n=>/^(warning|error)$/.test(text(n)))).filter(el=>{
   return el.getAttribute('data-flow-studio-baseline')!==arg.job&&!reused.has(el);
  });
  if(matches.length>1)error('RESULT_AMBIGUOUS','Flow вернул несколько задач вместо одного результата.');
  if(!matches.length)return false;
  matches[0].setAttribute('data-flow-studio-job',arg.job);matches[0].setAttribute('data-flow-studio-provisional',existing.length===arg.baseline.length?'false':'true');return true;
 }
 if(op==='result'){
  const xs=[...document.querySelectorAll('[data-flow-studio-job]')].filter(el=>el.getAttribute('data-flow-studio-job')===arg.job);
  if(xs.length!==1)return null;
  const el=xs[0],value=text(el),percent=value.match(/(?:^|\s)(\d{1,3})\s*%/);
  const complete=Boolean(el.querySelector(arg.kind==='image'?'flow-image-tile img':'img[alt="Значок сгенерированного видео"],img[alt="Generated video thumbnail"]'));
  const statusText=value.replace(arg.prompt||'','');
  const warning=[...el.querySelectorAll('mat-icon,[role="alert"]')].some(n=>/^(warning|error)$/.test(text(n))||n.getAttribute('role')==='alert');
  const errorText=!complete&&warning?statusText.slice(0,1200):null;
  let openPoint;if(arg.open&&complete){const target=el.querySelector(arg.kind==='image'?'flow-image-tile img':'flow-video-tile')||el;if(arg.kind==='image')openPoint=point(target);else{click(target);target.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}));}}
  return {progress:percent?Number(percent[1]):null,error:errorText,complete,provisional:el.getAttribute('data-flow-studio-provisional')==='true',...(openPoint?{openPoint}:{})};
 }
 if(op==='result-poster'){const xs=[...document.querySelectorAll('[data-flow-studio-job]')].filter(el=>el.getAttribute('data-flow-studio-job')===arg.job);return xs.length===1?xs[0].querySelector(arg.kind==='image'?'flow-image-tile img':'img[alt="Значок сгенерированного видео"],img[alt="Generated video thumbnail"]')?.getAttribute('src')||null:null;}
 function sourceSceneState(expected,output=false,projectURL,loading=false,request){
  const stepSelector='flow-editor-history-step-video,flow-editor-history-step-image';
  const sceneURL=location.href;
  if(!/^https:\/\/flow\.google\.com\/project\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/edit\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sceneURL)||expected?.url&&sceneURL!==expected.url||projectURL&&sceneURL.slice(0,sceneURL.lastIndexOf('/edit/'))!==projectURL||!sourcePosterIdentity(expected?.poster)||sourcePosterIdentity(expected.poster)!==expected.poster)error('SOURCE_VIDEO_NOT_VERIFIED','Не удалось подтвердить сцену исходного видео.');
  const notReady=()=>error('SOURCE_VIDEO_NOT_READY','Исходная сцена ещё загружается.');
  const clips=document.querySelectorAll('flow-scene-timeline .clip').length;if(loading&&clips===0)notReady();if(clips!==1)error('SOURCE_VIDEO_NOT_VERIFIED','Исходная сцена должна содержать одно видео.');
  const regions=all('region').filter(element=>label(element)==='История');if(loading&&regions.length===0)notReady();
  const region=one('region','История'),entries=[...region.querySelectorAll(stepSelector)];
  if(loading&&entries.length===0)notReady();
  if(loading&&output&&entries.length===1){sourceSceneState(expected,false,projectURL,true);notReady();}
  if(entries.length!==(output?2:1)||entries.some(entry=>entry.tagName!=='FLOW-EDITOR-HISTORY-STEP-VIDEO'))error('SOURCE_VIDEO_NOT_VERIFIED','История сцены не подтверждает единственный исходник и его результат.');
  const versions=entries.map(entry=>{
   const owned=selector=>[...entry.querySelectorAll(selector)].filter(node=>node.closest(stepSelector)===entry);
   const tiles=owned('flow-tile-container'),selected=owned('flow-tile-container.selected.high-emphasis'),prompts=owned('flow-expandable-prompt .prompt-text');
   const images=tiles.length===1?[...tiles[0].querySelectorAll('flow-video-tile img[alt="Generated video thumbnail"],flow-video-tile img[alt="Значок сгенерированного видео"]')]:[],posters=images.map(image=>prompts.length===0?sourcePosterIdentity(image.getAttribute('src')):image.getAttribute('src'));
   const pending=output?owned('flow-pending-tile'):[];
   const failures=output?owned('flow-error-tile'):[];
   if(failures.length){
    if(failures.length!==1||pending.length||tiles.length!==1||posters.length||prompts.length!==1||selected.length>1||selected.length===1&&selected[0]!==tiles[0])error('SOURCE_VIDEO_NOT_VERIFIED','Не удалось однозначно проверить ошибку версии исходной сцены.');
    const fullPrompt=prompts[0].textContent,titles=[...failures[0].querySelectorAll('.error-title')].filter(node=>node.closest(stepSelector)===entry),messages=[...failures[0].querySelectorAll('.error-message-text')].filter(node=>node.closest(stepSelector)===entry);
    if(typeof fullPrompt!=='string'||!fullPrompt.trim()||prompts[0].querySelectorAll('button,mat-icon,input,textarea,[role="button"]').length||titles.length!==1||messages.length!==1||typeof titles[0].textContent!=='string'||typeof messages[0].textContent!=='string'||!titles[0].textContent.trim()||!messages[0].textContent.trim())error('RESULT_INPUT_MISMATCH','Не удалось прочитать запрос и сообщение ошибки выбранной версии.');
    const message=titles[0].textContent.trim()+'\n'+messages[0].textContent.trim();if(message.length>1200)error('RESULT_INPUT_MISMATCH','Сообщение ошибки версии не подтверждено.');
    return {promptCount:1,selected:selected.length===1,failure:{message,prompt:fullPrompt,...historyInputs(entry)}};
   }
   if(pending.length){
    if(!loading||pending.length!==1||tiles.length!==1||prompts.length>1||selected.length>1||selected.length===1&&selected[0]!==tiles[0])error('SOURCE_VIDEO_NOT_VERIFIED','Не удалось однозначно проверить ожидающую версию исходной сцены.');
    return {pending:true,selected:selected.length===1};
   }
   if(loading&&!output&&(tiles.length===0||posters.length===0||posters.length===1&&(!posters[0]||!images[0].complete||images[0].naturalWidth<=0)||selected.length===0))notReady();
   if(tiles.length!==1||posters.length!==1||!posters[0]||selected.length>1||selected.length===1&&selected[0]!==tiles[0]||output&&(!images[0].complete||images[0].naturalWidth<=0))error('SOURCE_VIDEO_NOT_VERIFIED','Не удалось однозначно проверить версии исходной сцены.');
   return {poster:posters[0],promptCount:prompts.length,selected:selected.length===1};
  });
  const imported=versions.filter(version=>version.promptCount===0);
  if(imported.length!==1||imported[0].poster!==expected.poster||!output&&!imported[0].selected)error('SOURCE_VIDEO_NOT_VERIFIED','Исходное видео сцены изменилось.');
  if(!output){
   const values=[...document.querySelectorAll('.duration-timecode-label .duration-timecode-value')].filter(visible);
   if(loading&&values.length===0)notReady();
   const time=values.length===1?/^(\d{2}):([0-5]\d):([0-5]\d)$/.exec(text(values[0])):null;
   if(!time)error('SOURCE_VIDEO_NOT_VERIFIED','Не удалось однозначно проверить длительность исходного видео в плеере.');
   const seconds=Number(time[1])*60+Number(time[2]);
   if(seconds===0&&Number(time[3])===0){if(loading)notReady();error('SOURCE_VIDEO_NOT_VERIFIED','Плеер исходного видео ещё не готов.');}
   // Flow displays MM:SS:FF; unknown frame rate leaves a one-second readiness comparison.
   if(!Number.isFinite(expected.durationSeconds)||expected.durationSeconds<=0||expected.durationSeconds>15.02||Math.abs(seconds-expected.durationSeconds)>1)error('SOURCE_VIDEO_NOT_VERIFIED','Длительность плеера не совпала с исходным видео.');
  }
  if(output){
   const generated=versions.filter(version=>version!==imported[0]);
   if(generated.length===1&&generated[0].failure){
    const failure=generated[0].failure;
    if(versions.filter(version=>version.selected).length>1||typeof request?.prompt!=='string'||!Array.isArray(request.ingredients)||!samePrompt(failure.prompt.trim(),request.prompt.trim())||failure.ingredientsReady!==true||JSON.stringify(failure.ingredients)!==JSON.stringify(request.ingredients))error('RESULT_INPUT_MISMATCH','Ошибка исходной сцены не совпала с запросом и изображениями.');
    const source=new URL(expected.poster),video=failure.sourceVideos?.length===1?new URL(failure.sourceVideos[0]):null;
    if(source.origin!=='https://flow-content.google'||!/^\/image\/[A-Za-z0-9_-]{1,256}$/.test(source.pathname)||!video||video.origin!=='https://flow-content.google'||video.pathname!=='/video/'+source.pathname.slice('/image/'.length))error('SOURCE_VIDEO_NOT_VERIFIED','Не удалось связать ошибку редактирования с исходным видео сцены.');
    return {url:sceneURL,poster:expected.poster,failure:{message:failure.message}};
   }
   if(loading&&generated.length===1&&generated[0].pending&&versions.filter(version=>version.selected).length<=1)notReady();
   if(imported[0].selected||generated.length!==1||generated[0].promptCount!==1||!generated[0].selected||generated[0].poster===expected.poster||sourcePosterIdentity(generated[0].poster)===expected.poster)error('SOURCE_VIDEO_NOT_VERIFIED','Выбранный результат не является новой версией исходного видео.');
   return {url:sceneURL,poster:expected.poster,outputPoster:generated[0].poster};
  }
  return {url:sceneURL,poster:expected.poster};
 }
 function historyInputs(entry){
  const stepSelector='flow-editor-history-step-video,flow-editor-history-step-image';
  const buttons=[...entry.querySelectorAll('button[aria-label="Ingredient"],button[aria-label="Image ingredient"],button[aria-label="Ингредиент"]')].filter(node=>node.closest(stepSelector)===entry);
  const canonical=(value,kind)=>{if(typeof value!=='string'||value!==value.trim()||/[\r\n]/.test(value))return null;try{const u=new URL(value);return !u.username&&!u.password&&!u.hash&&u.origin==='https://flow-content.google'&&new RegExp('^/'+kind+'/[A-Za-z0-9_-]{1,256}$').test(u.pathname)?u.origin+u.pathname:null;}catch{return null;}};
  const previewIdentity=value=>{if(typeof value!=='string'||value!==value.trim()||/[\r\n]/.test(value))return null;try{const u=new URL(value);return !u.username&&!u.password&&!u.hash&&((u.origin==='https://flow-content.google'&&/^\/image\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(u.pathname))||(u.origin==='https://storage.googleapis.com'&&/^\/ai-sandbox-videofx\/image\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(u.pathname)))?u.origin+u.pathname:null;}catch{return null;}};
  const ingredients=[],sourceVideos=[],sourcePreviews=[];let videoCount=0,sourcesReady=true;
  for(const button of buttons){
   const imageChip=button.closest?.('flow-image-ingredient-chip'),videoChip=button.closest?.('flow-video-ingredient-chip'),wrapper=button.closest?.('flow-ingredient-chip');
   if(imageChip&&videoChip||wrapper&&!imageChip&&!videoChip||imageChip&&imageChip.closest(stepSelector)!==entry||videoChip&&videoChip.closest(stepSelector)!==entry)error('RESULT_INPUT_MISMATCH','Не удалось определить тип исходника выбранной записи истории.');
   if(videoChip){
    const videos=[...button.querySelectorAll('video[src],source[src]')].filter(node=>node.closest(stepSelector)===entry&&node.closest('flow-video-ingredient-chip')===videoChip);
    const previews=[...button.querySelectorAll('img[alt="Video ingredient image"]')].filter(node=>node.closest(stepSelector)===entry&&node.closest('flow-video-ingredient-chip')===videoChip);
    if(++videoCount>1||videos.length>1||previews.length>1)error('RESULT_INPUT_MISMATCH','Исходное видео записи истории выбрано неоднозначно.');
    const video=videos.length===1?canonical(videos[0].getAttribute('src'),'video'):null,preview=previews.length===1?previewIdentity(previews[0].getAttribute('src')):null;
    if(videos.length)sourceVideos.push(video);if(previews.length)sourcePreviews.push(preview);
    if(video&&preview&&new URL(video).pathname.slice('/video/'.length)!==new URL(preview).pathname.split('/').pop())error('RESULT_INPUT_MISMATCH','Видео и его изображение в записи истории не совпали.');
    sourcesReady=sourcesReady&&button.getAttribute('aria-busy')==='false'&&Boolean(videos.length||previews.length)&&(!videos.length||Boolean(video))&&(!previews.length||Boolean(preview));
   }else{
    const images=[...button.querySelectorAll('img[alt="Изображение ингредиента"],img[alt="Ingredient image"]')];
    ingredients.push(images.length===1?canonical(images[0].currentSrc||images[0].src,'image'):null);
   }
  }
  return {ingredients,sourceVideos,sourcePreviews,ingredientsReady:ingredients.every(Boolean)&&sourcesReady};
 }
 function selectedHistory(kind,poster){
  const stepSelector='flow-editor-history-step-video,flow-editor-history-step-image',entryTag=kind==='image'?'FLOW-EDITOR-HISTORY-STEP-IMAGE':'FLOW-EDITOR-HISTORY-STEP-VIDEO';
  const region=one('region','История');
  const selected=[...region.querySelectorAll(stepSelector)].map(entry=>({entry,tiles:[...entry.querySelectorAll('flow-tile-container.selected.high-emphasis')].filter(tile=>tile.closest(stepSelector)===entry)})).filter(value=>value.tiles.length);
  if(selected.length!==1||selected[0].tiles.length!==1||selected[0].entry.tagName!==entryTag)error('RESULT_INPUT_MISMATCH','Не удалось однозначно определить выбранную запись истории.');
  const {entry,tiles}=selected[0],tile=tiles[0];
  const posters=[...tile.querySelectorAll(kind==='image'?'flow-image-tile img[data-media-id]':'flow-video-tile img[alt="Generated video thumbnail"],flow-video-tile img[alt="Значок сгенерированного видео"]')].map(image=>image.getAttribute('src'));
  if(posters.length!==1||!posters[0]||poster!==undefined&&posters[0]!==poster)error('RESULT_INPUT_MISMATCH','Выбранная запись истории не совпадает с результатом.');
  const promptNodes=[...entry.querySelectorAll('flow-expandable-prompt .prompt-text')].filter(node=>node.closest(stepSelector)===entry);
  if(promptNodes.length!==1||promptNodes[0].querySelectorAll('button,mat-icon,input,textarea,[role="button"]').length||typeof promptNodes[0].textContent!=='string'||!promptNodes[0].textContent.trim())error('RESULT_INPUT_MISMATCH','Не удалось прочитать полный запрос выбранной записи истории.');
  const prompt=promptNodes[0].textContent;
  const {ingredients,sourceVideos,sourcePreviews,ingredientsReady}=historyInputs(entry);
  const ownedButtons=[...entry.querySelectorAll('button[aria-label="Download"],button[aria-label="More options"]')].filter(button=>button.closest(stepSelector)===entry&&tile.contains(button));
  const download=ownedButtons.filter(button=>button.getAttribute('aria-label')==='Download');
  const more=ownedButtons.filter(button=>button.getAttribute('aria-label')==='More options');
  if(download.length>1||!download.length&&more.length>1)error('RESULT_INPUT_MISMATCH','Не удалось связать скачивание с выбранной записью истории.');
  const data={prompt,ingredients,ingredientsReady,sourceVideos,sourcePreviews,posters,url:location.href};
  return {entry,trigger:download[0]||more[0],submenu:!download.length,data};
 }
 if(op==='history')return selectedHistory(arg.kind,arg.poster).data;
 function agentSceneResult(request){
  const expected=request?.sourceScene,stepSelector='flow-editor-history-step-video,flow-editor-history-step-image';
  const previewID=value=>typeof value==='string'?/^https:\/\/(?:flow-content\.google\/image\/|storage\.googleapis\.com\/ai-sandbox-videofx\/image\/)([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(value)?.[1]:null;
  const sourceID=previewID(expected?.poster),expectedID=previewID(request?.sourcePreview);
  if(!expected||typeof expected.url!=='string'||!/^https:\/\/flow\.google\.com\/project\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/edit\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(expected.url)||location.href!==expected.url||!sourceID||sourceID!==expectedID||typeof request.prompt!=='string'||!request.prompt.trim()||!Array.isArray(request.ingredients))error('SOURCE_VIDEO_NOT_VERIFIED','Не сохранена точная связь результата помощника с исходной сценой.');
  const clips=document.querySelectorAll('flow-scene-timeline .clip').length;if(!clips)return false;if(clips!==1)error('SOURCE_VIDEO_NOT_VERIFIED','Сцена помощника должна содержать одно видео.');
  const regions=all('region').filter(node=>label(node)==='История');if(!regions.length)return false;if(regions.length!==1)error('SOURCE_VIDEO_NOT_VERIFIED','История сцены помощника выбрана неоднозначно.');
  const entries=[...regions[0].querySelectorAll(stepSelector)];if(!entries.length)return false;if(entries.length>2||entries.some(entry=>entry.tagName!=='FLOW-EDITOR-HISTORY-STEP-VIDEO'))error('SOURCE_VIDEO_NOT_VERIFIED','История помощника не подтверждает единственный исходник и один новый результат.');
  const versions=entries.map(entry=>{
   const owned=selector=>[...entry.querySelectorAll(selector)].filter(node=>node.closest(stepSelector)===entry),tiles=owned('flow-tile-container'),selected=owned('flow-tile-container.selected.high-emphasis'),prompts=owned('flow-expandable-prompt .prompt-text'),pending=owned('flow-pending-tile'),failures=owned('flow-error-tile');
   if(tiles.length!==1||selected.length>1||selected.length===1&&selected[0]!==tiles[0]||prompts.length>1||pending.length>1||failures.length>1||pending.length&&failures.length)error('SOURCE_VIDEO_NOT_VERIFIED','Версия сцены помощника выбрана неоднозначно.');
   const images=[...tiles[0].querySelectorAll('flow-video-tile img[alt="Generated video thumbnail"],flow-video-tile img[alt="Значок сгенерированного видео"]')];
   return {entry,tile:tiles[0],selected:selected.length===1,prompts,pending:pending.length===1,failure:failures[0],images};
  });
  if(versions.filter(version=>version.selected).length>1)error('SOURCE_VIDEO_NOT_VERIFIED','В сцене помощника выбрано несколько версий.');
  const imported=versions.filter(version=>!version.prompts.length&&!version.failure);
  if(!imported.length)return false;
  if(imported.length!==1){if(versions.some(version=>version.pending||!version.images.length||version.images.some(image=>!image.complete||image.naturalWidth<=0)))return false;error('SOURCE_VIDEO_NOT_VERIFIED','Исходная версия сцены помощника не подтверждена.');}
  if(!imported[0].images.length||imported[0].pending)return false;
  if(imported[0].images.length!==1)error('SOURCE_VIDEO_NOT_VERIFIED','Исходная версия сцены помощника не подтверждена.');
  const importedImage=imported[0].images[0],rawImportedPoster=importedImage.getAttribute('src'),importedPoster=sourcePosterIdentity(rawImportedPoster);
  if(!importedImage.complete||importedImage.naturalWidth<=0)return false;
  if(!importedPoster){
   let temporary=!rawImportedPoster||/^data:image\//i.test(rawImportedPoster);try{const value=new URL(rawImportedPoster);if(value.protocol==='blob:'&&value.origin==='https://flow.google.com')temporary=true;}catch{}
   if(temporary)return false;error('SOURCE_VIDEO_NOT_VERIFIED','Исходная версия сцены помощника изменилась (reason=unrecognized-source-poster).');
  }
  if(!/^https:\/\/flow\.google\.com\/asb\//.test(importedPoster)&&previewID(importedPoster)!==sourceID)error('SOURCE_VIDEO_NOT_VERIFIED','Исходная версия сцены помощника изменилась (reason=recognized-resource-mismatch).');
  if(versions.length===1)return false;
  const generated=versions.find(version=>version!==imported[0]);
  if(!generated.prompts.length){if(generated.pending)return false;error('RESULT_INPUT_MISMATCH','Не прочитан запрос новой версии помощника.');}
  const prompt=generated.prompts[0];if(typeof prompt.textContent!=='string'||!prompt.textContent.trim()||prompt.querySelectorAll('button,mat-icon,input,textarea,[role="button"]').length||!samePrompt(prompt.textContent.trim(),request.prompt.trim()))error('RESULT_INPUT_MISMATCH','Запрос результата помощника не совпал с исходным.');
  const inputs=historyInputs(generated.entry);if(!inputs.ingredientsReady)return false;
  if(JSON.stringify(inputs.ingredients)!==JSON.stringify(request.ingredients))error('RESULT_INPUT_MISMATCH','Изображения результата помощника не совпали с исходными.');
  if(inputs.sourcePreviews.length!==1||previewID(inputs.sourcePreviews[0])!==expectedID)error('SOURCE_VIDEO_NOT_VERIFIED','Изображение исходного видео результата помощника не совпало с сохранённым.');
  if(generated.failure){
   if(generated.images.length)error('SOURCE_VIDEO_NOT_VERIFIED','Ошибка помощника содержит неоднозначный результат.');
   const titles=[...generated.failure.querySelectorAll('.error-title')].filter(node=>node.closest(stepSelector)===generated.entry),messages=[...generated.failure.querySelectorAll('.error-message-text')].filter(node=>node.closest(stepSelector)===generated.entry);
   if(titles.length!==1||messages.length!==1||typeof titles[0].textContent!=='string'||typeof messages[0].textContent!=='string'||!titles[0].textContent.trim()||!messages[0].textContent.trim())error('RESULT_INPUT_MISMATCH','Ошибка результата помощника не подтверждена.');
   const message=titles[0].textContent.trim()+'\n'+messages[0].textContent.trim();if(message.length>1200)error('RESULT_INPUT_MISMATCH','Ошибка результата помощника не подтверждена.');return {failure:{message},url:location.href};
  }
  if(generated.pending)return false;
  if(generated.images.length!==1||!generated.images[0].complete||generated.images[0].naturalWidth<=0)return false;
  const resultPoster=generated.images[0].getAttribute('src');let resultPreviewID;try{const url=new URL(resultPoster);if(!url.username&&!url.password&&!url.hash)resultPreviewID=previewID(url.origin+url.pathname);}catch{}
  if(!resultPoster||resultPoster===importedImage.getAttribute('src')||sourcePosterIdentity(resultPoster)===expected.poster||resultPreviewID===expectedID)error('SOURCE_VIDEO_NOT_VERIFIED','Результат помощника не является новой версией.');
  if(!generated.selected){if(request.open)click(generated.tile);return false;}
  const selected=selectedHistory('video',resultPoster).data;return {ready:true,...selected};
 }
 function boundHistory(binding){
  if(!binding||typeof binding.prompt!=='string'||!Array.isArray(binding.ingredients)||!Array.isArray(binding.sourceVideos)||binding.sourcePreviews!==undefined&&!Array.isArray(binding.sourcePreviews)||typeof binding.poster!=='string'||typeof binding.url!=='string')error('RESULT_INPUT_MISMATCH','Не сохранена связь выбранной записи истории.');
  const current=selectedHistory(binding.kind,binding.poster),value=current.data;
  if(value.url!==binding.url||!samePrompt(value.prompt.trim(),binding.prompt.trim())||!value.ingredientsReady||JSON.stringify(value.ingredients)!==JSON.stringify(binding.ingredients)||JSON.stringify(value.sourceVideos)!==JSON.stringify(binding.sourceVideos)||JSON.stringify(value.sourcePreviews)!==JSON.stringify(binding.sourcePreviews||[]))error('RESULT_INPUT_MISMATCH','Выбранная запись истории изменилась перед скачиванием.');
  if(binding.agentSource){const state=agentSceneResult({...binding.agentSource,prompt:binding.prompt,ingredients:binding.ingredients});if(!state?.ready||state.posters[0]!==binding.poster)error('RESULT_INPUT_MISMATCH','Не подтверждена исходная сцена скачивания результата помощника.');}
  else if(binding.sourceScene)sourceSceneState(binding.sourceScene,true);
  return current;
 }
 function controlledMenu(trigger){
  const id=trigger?.getAttribute('aria-controls');if(trigger?.getAttribute('aria-expanded')!=='true'||typeof id!=='string'||!id||/\s/.test(id))return null;
  const menus=[...document.querySelectorAll('[id]')].filter(element=>element.getAttribute('id')===id);
  if(menus.length!==1||menus[0].getAttribute('role')!=='menu'||!visible(menus[0]))return null;return menus[0];
 }
 function historyDownloadMenu(binding,submenu=false,open=false){
  const current=boundHistory(binding),menu=controlledMenu(current.trigger);if(!menu)return null;if(!current.submenu)return menu;
  const downloads=all('menuitem',menu).filter(item=>{const labels=[...item.querySelectorAll('.item-text .label')];return labels.length===1&&text(labels[0])==='Download';});
  if(downloads.length!==1)error('RESULT_INPUT_MISMATCH','Меню выбранной записи не подтверждает скачивание.');
  if(open){click(downloads[0]);return null;}
  return submenu?controlledMenu(downloads[0]):menu;
 }
 if(op==='history-download'){
  const current=boundHistory(arg.binding);if(arg.click){if(!current.trigger)error('DOWNLOAD_CONTROL_UNVERIFIED','Кнопка скачивания выбранной записи истории ещё не подтверждена.');click(current.trigger);}return true;
 }
 if(op==='history-download-menu'){
  const menu=historyDownloadMenu(arg.binding,arg.submenu,arg.open);if(!menu)return false;return {menuId:menu.getAttribute('id'),needsSubmenu:boundHistory(arg.binding).submenu&&!arg.submenu};
 }
 if(op==='submit'){const c={prompt:promptValue(),ingredients:chips()};if(!samePrompt(c.prompt,arg.prompt)||JSON.stringify(c.ingredients)!==JSON.stringify(arg.ingredients))error('PREPARED_INPUT_CHANGED','Описание или ингредиенты изменились перед отправкой.');const button=one('button','Начать генерацию'),position=point(button);if(arg.trusted)return position;click(button);return {clicked:true};}
 error('INVALID_OPERATION','Неизвестная операция фонового браузера.');
}

class FlowPage{
 constructor(client,signal,{pollMs=250,confirmUploadRights,leaseSignal}={}){Object.assign(this,{client,requestSignal:signal,signal:leaseSignal?(signal?AbortSignal.any([signal,leaseSignal]):leaseSignal):signal,pollMs,confirmUploadRights});}
 async run(op,arg,returnByValue=true){
  this.signal?.throwIfAborted();
  const result=await this.client.send('Runtime.evaluate',{expression:'('+flowDOM.toString()+')('+JSON.stringify(op)+','+JSON.stringify(arg||{})+')',returnByValue,awaitPromise:true,userGesture:true});
  if(result.exceptionDetails){const description=result.exceptionDetails.exception?.description||'';const m=description.match(/(?:Error: )?([A-Z][A-Z0-9_]+): ([^\n]+)/);throw fail(m?.[1]||'BROWSER_UI_ERROR',m?.[2]||'Не удалось прочитать интерфейс Flow.');}
  return returnByValue?result.result?.value:result.result;
 }
 async until(fn,timeout=15000,stage='ui'){const end=Date.now()+timeout;do{this.signal?.throwIfAborted();const value=await fn();if(value)return value;await wait(this.pollMs,undefined,{signal:this.signal});}while(Date.now()<end);let detail;try{detail=await this.run('diagnostic');}catch{}throw fail('FLOW_UI_TIMEOUT','Flow не подтвердил изменение интерфейса ('+stage+'). Генерация не повторялась.'+(detail?' '+JSON.stringify(detail):''));}
 async ready(){await this.client.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await this.until(async()=>{try{const r=await this.client.send('Runtime.evaluate',{expression:'location.href',returnByValue:true});const value=r.result?.value;if(value==='about:blank'||!value)return false;const u=new URL(value);if(u.origin==='https://flow.google.com')return true;let detail;try{detail=await this.run('diagnostic');}catch{}throw fail('FLOW_LOGIN_REQUIRED','Войдите в Google через подключение аккаунта Flow Studio.'+(detail?' '+JSON.stringify(detail):''));}catch(e){if(e.code==='CDP_COMMAND')return false;throw e;}},30000,'page-ready');}
 async click(name,role='button'){return this.run('click',{name,role});}
 async trustedClick(position,double=false){await this.client.send('Page.setWebLifecycleState',{state:'active'});await this.client.send('Emulation.setFocusEmulationEnabled',{enabled:true});await this.client.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'none',buttons:0,modifiers:0,clickCount:0,...position});await wait(50,undefined,{signal:this.signal});for(let clickCount=1;clickCount<=(double?2:1);clickCount++){await this.client.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,force:0.5,modifiers:0,clickCount,...position});await this.client.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,modifiers:0,clickCount,...position});}}
 async trustedControlClick(name,role='button',timeout=15000){
  await this.client.send('Page.setWebLifecycleState',{state:'active'});await this.client.send('Emulation.setFocusEmulationEnabled',{enabled:true});let position;
  await this.until(async()=>{
   try{
    const before=await this.run('control-box',{name,role});
    await this.client.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'none',buttons:0,modifiers:0,clickCount:0,x:before.x,y:before.y});
    await wait(50,undefined,{signal:this.signal});const current=await this.run('control-box',{name,role});
    if(!['x','y','left','top','width','height'].every(key=>Number.isFinite(current[key])&&current[key]===before[key]))return false;
    position={x:current.x,y:current.y};return true;
   }catch(error){if(['CONTROL_OBSCURED','CONTROL_HIDDEN','CONTROL_NOT_FOUND'].includes(error.code))return false;throw error;}
  },timeout,'upload-control-stable');
  this.signal?.throwIfAborted();await this.client.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,force:0.5,modifiers:0,clickCount:1,...position});
  await this.client.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,modifiers:0,clickCount:1,...position});
 }
 async bind(baseline,prompt,job,timeout=60000,kind='video'){let lastError;try{return await this.until(async()=>{try{return await this.run('bind-result',{baseline,prompt,job,kind});}catch(error){if(error.code==='RESULT_BINDING_CHANGED'){lastError=error;return false;}throw error;}},timeout,'generation-card');}catch(error){if(error.code==='FLOW_UI_TIMEOUT'&&lastError)throw lastError;throw error;}}
 async verifyAccount(email){
  const editorAccount=await this.run('editor-account');
  if(editorAccount){if(editorAccount!==email.toLowerCase())throw fail('ACCOUNT_MISMATCH','Окно Flow открыто под другим аккаунтом.');return;}
  const editorURL=(await this.run('state')).url;
  if(/^https:\/\/flow\.google\.com\/project\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/edit\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(editorURL)){
   if(typeof this.client.withVerificationPage!=='function')throw fail('ACCOUNT_VERIFICATION_UNAVAILABLE','Не удалось подтвердить аккаунт редактора Flow. Обновите подключение фонового браузера.');
   await this.client.withVerificationPage(async client=>{const verification=new FlowPage(client,this.requestSignal,{pollMs:this.pollMs,leaseSignal:this.signal});await verification.ready();await verification.verifyAccount(email);});
   if((await this.run('state')).url!==editorURL)throw fail('ACCOUNT_MISMATCH','Редактор Flow изменился во время проверки аккаунта.');
   return;
  }
  await this.until(()=>this.run('exists',{name:'Сведения об аккаунте'}),15000,'account-button');
  await this.click('Сведения об аккаунте');const actual=await this.until(()=>this.run('account'),15000,'account-identity');
  if(actual!==email.toLowerCase())throw fail('ACCOUNT_MISMATCH','Окно Flow открыто под другим аккаунтом.');
  await this.click('Закрыть панель аккаунта');await this.until(async()=>!(await this.run('account')));
 }
 async project(email){await this.ready();await this.verifyAccount(email);if(!/^https:\/\/flow\.google\.com\/project\/[A-Za-z0-9_-]+$/.test((await this.run('state')).url)){await this.until(async()=>(await this.run('state')).projectLinks.length>0,20000,'project-links');await this.run('project');await this.until(async()=>/^https:\/\/flow\.google\.com\/project\/[A-Za-z0-9_-]+$/.test((await this.run('state')).url),20000,'project-navigation');}await this.verifyAccount(email);await this.run('close-empty-agent-panel');const mode=await this.until(async()=>{try{return await this.run('composer-mode');}catch(e){if(e.code==='CONTROL_NOT_FOUND')return false;throw e;}},20000,'composer-ready');if(mode.agent){await this.run('close-agent');await this.until(async()=>{try{return !(await this.run('composer-mode')).agent;}catch(e){if(e.code==='CONTROL_NOT_FOUND')return false;throw e;}},15000,'generation-composer');}if((await this.run('composer-mode')).creative){await this.run('manual-mode');await this.until(async()=>!(await this.run('composer-mode')).creative,15000,'manual-composer');}return (await this.run('state')).url;}
 async radio(name){await this.run('radio',{name,set:true});await this.until(()=>this.run('radio',{name}));}
 async settings(plan){
  await this.click('Триггер настроек');await this.until(()=>this.run('exists',{role:'radio',name:'Видео'}));
  await this.radio('Видео');await this.radio(plan.method==='frames'?'Кадры':'Ингредиенты');
  const family=plan.family?.startsWith('Veo ')?plan.family.replace('Veo 3.1 ','Veo 3.1 - '):'Omni 1.2 Flash';
  await this.click('Выбрать семейство моделей');await this.run('model-option',{family});
  await this.until(async()=>(await this.run('model')).split('\n')[0]===family);
  await this.radio(plan.aspect);if(!plan.family?.startsWith('Veo '))await this.radio(plan.resolution==='720p'?'720p':'360p 360p: видео генерируется быстрее, но разрешение ниже');await this.radio('x1');
  if(plan.family?.startsWith('Veo ')){if(plan.seconds!==8)throw fail('MODEL_DURATION_UNAVAILABLE','Короткие Veo 4/6 секунд требуют Google AI Ultra. Выбранная длительность недоступна в этом профиле.');await this.click('Триггер настроек');const summary=await this.run('settings-summary');if(!/720p/.test(summary)||!/(?:8s|8 сек\.|8 sec)/.test(summary))throw fail('SETTINGS_CHANGED','Flow не подтвердил 8 секунд и 720p для Veo.');return;}
  await this.run('duration',{set:plan.seconds-3,seconds:plan.seconds});await this.until(async()=>{const s=await this.run('duration',{seconds:plan.seconds});return s.value===plan.seconds-3&&s.text;});
  await this.click('Триггер настроек');await this.until(async()=>!(await this.run('exists',{role:'radio',name:'Видео'})));
 }
 async verifySettings(plan){
  await this.click('Триггер настроек');await this.until(()=>this.run('exists',{role:'radio',name:'Видео'}));
  const names=['Видео',plan.method==='frames'?'Кадры':'Ингредиенты',plan.aspect,...(!plan.family?.startsWith('Veo ')?[plan.resolution==='720p'?'720p':'360p 360p: видео генерируется быстрее, но разрешение ниже']:[]),'x1'];
  for(const name of names)if(!await this.run('radio',{name}))throw fail('SETTINGS_CHANGED','Параметры Flow изменились перед отправкой.');
  if(plan.family?.startsWith('Veo ')){const family=plan.family.replace('Veo 3.1 ','Veo 3.1 - ');if((await this.run('model')).split('\n')[0]!==family)throw fail('SETTINGS_CHANGED','Модель Veo изменилась.');await this.click('Триггер настроек');const summary=await this.run('settings-summary');if(!/720p/.test(summary)||!/(?:8s|8 сек\.|8 sec)/.test(summary))throw fail('SETTINGS_CHANGED','Параметры Veo изменились.');return;}
  const duration=await this.run('duration',{seconds:plan.seconds});if(duration.value!==plan.seconds-3||!duration.text||!/^Omni 1\.2 Flash$/.test((await this.run('model')).trim()))throw fail('SETTINGS_CHANGED','Модель или длительность Flow изменилась.');
  await this.click('Триггер настроек');await this.until(async()=>!(await this.run('exists',{role:'radio',name:'Видео'})));
 }
 async verifyEditSettings(plan,sourceScene){
  const seconds=Math.round(sourceScene.durationSeconds),rate=plan.resolution==='360p'?1:plan.resolution==='720p'?3:null;
  if(!rate||!Number.isFinite(sourceScene.durationSeconds)||sourceScene.durationSeconds<=0||sourceScene.durationSeconds>15.02||seconds<1||seconds>15)throw fail('MODEL_SETTINGS_NOT_VERIFIED','Не удалось проверить стоимость выбранного режима Edit.');
  // Fail closed if Flow's quote differs from Google's published Omni 1.2 schedule (2026-11-15).
  // https://support.google.com/flow/answer/16526234?hl=en
  const expected=(Math.min(seconds,10)+Math.max(0,seconds-10)*2)*rate;
  await this.run('edit-settings');await this.run('edit-settings',{choose:true});let quote;
  try{quote=await this.until(()=>this.run('edit-settings',{quote:true}),10000,'edit-credit-quote');}
  catch(error){if(error.code==='FLOW_UI_TIMEOUT')throw fail('MODEL_SETTINGS_NOT_VERIFIED','Flow не показал подтверждённую стоимость режима '+plan.resolution+'. Генерация не запускалась.');throw error;}
  finally{await this.run('edit-settings',{close:true});}
  if(quote.url!==sourceScene.url||quote.credits!==expected)throw fail('MODEL_SETTINGS_NOT_VERIFIED','Flow не подтвердил режим '+plan.resolution+': меню показывает '+quote.credits+' кредитов для '+seconds+' с, ожидается '+expected+'. Генерация не запускалась.');
 }
 async fillPrompt(prompt){if(!await this.run('focus-prompt'))throw fail('PROMPT_FOCUS_FAILED','Не удалось выбрать поле запроса.');await this.client.send('Input.insertText',{text:prompt});try{await this.until(async()=>samePrompt((await this.run('composer')).prompt,prompt),15000,'prompt-value');}catch(error){try{error.message+=' '+JSON.stringify(await this.run('prompt-state',{expected:prompt}));}catch{}throw error;}}
 async uploadSourceVideo(file){
  const expectedURL=(await this.run('state')).url,frame=await this.client.send('Page.getFrameTree'),frameId=frame.frameTree?.frame?.id;
  if(!/^https:\/\/flow\.google\.com\/project\/[A-Za-z0-9_-]+$/.test(expectedURL||'')||typeof frameId!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(frameId))throw fail('SOURCE_VIDEO_NOT_VERIFIED','Не удалось подтвердить вкладку загрузки исходного видео.');
  await this.client.send('Page.enable');let chooser,chooserError,object,intercept=false,clicked=false;
  const off=this.client.onEvent(event=>{
   if(event.method!=='Page.fileChooserOpened')return;const value=event.params;
   if(!clicked||chooser||!value||value.frameId!==frameId||!Number.isSafeInteger(value.backendNodeId)||value.backendNodeId<=0||!['selectSingle','selectMultiple'].includes(value.mode)){chooserError=fail('FILE_INPUT_AMBIGUOUS','Flow не подтвердил единственное поле загрузки исходного видео.');return;}
   chooser=value;
  });
  try{
   intercept=true;await this.client.send('Page.setInterceptFileChooserDialog',{enabled:true});clicked=true;await this.trustedControlClick('Загрузить');
   await this.until(()=>{if(chooserError)throw chooserError;return chooser;},15000,'video-file-chooser');
   const node=await this.client.send('DOM.resolveNode',{backendNodeId:chooser.backendNodeId});object=node.object;
   if(!object?.objectId||object.subtype!=='node')throw fail('SOURCE_VIDEO_NOT_VERIFIED','Flow не подтвердил узел загрузки исходного видео.');
   const verified=await this.client.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:function(expectedURL,ext){
    const file=this instanceof HTMLInputElement&&this.type==='file',tokens=String(this.getAttribute?.('accept')||'').toLowerCase().split(',').map(value=>value.trim()),mime=ext==='.mp4'?'video/mp4':ext==='.mov'?'video/quicktime':'video/x-m4v';
    const root=this.getRootNode();
    return {file,connected:this.isConnected===true,sameDocument:this.ownerDocument===document,sameWindow:this.ownerDocument?.defaultView===globalThis,rootDocument:root===document,rootSelf:root===this,flowOrigin:location.origin==='https://flow.google.com',acceptVideo:tokens.includes(ext)||tokens.includes('video/*')||tokens.includes(mime),url:location.href};
   }.toString(),arguments:[{value:expectedURL},{value:path.extname(file).toLowerCase()}],returnByValue:true,awaitPromise:true,userGesture:true});
   const input=verified.result?.value;if(verified.exceptionDetails||!input?.file||!input.sameDocument||!input.sameWindow||!input.flowOrigin||!input.acceptVideo||input.url!==expectedURL)throw fail('SOURCE_VIDEO_NOT_VERIFIED','Поле загрузки исходного видео изменилось или не принимает этот формат.');
   if(chooserError)throw chooserError;await this.client.send('DOM.setFileInputFiles',{files:[file],objectId:object.objectId});
  }finally{
   off();if(object?.objectId)await this.client.send('Runtime.releaseObject',{objectId:object.objectId}).catch(()=>{});if(intercept)await this.client.send('Page.setInterceptFileChooserDialog',{enabled:false}).catch(()=>{});
  }
 }
 async upload(file,expected,frameRole){
  await this.click(frameRole||'Добавить ингредиенты в окно запроса');await this.until(()=>this.run('exists',{name:'Загрузить'}),15000,'upload-menu');
  await this.client.send('Page.enable');await this.client.send('Page.setInterceptFileChooserDialog',{enabled:true});
  let object;
  try{await this.click('Загрузить');object=await this.until(async()=>{try{return await this.run('file-input',{},false);}catch(e){if(e.code==='FILE_INPUT_AMBIGUOUS')return null;throw e;}});if(!object?.objectId)throw fail('FILE_INPUT_UNAVAILABLE','Поле загрузки файла недоступно.');await this.client.send('DOM.setFileInputFiles',{files:[file.path],objectId:object.objectId});}
  finally{if(object?.objectId)await this.client.send('Runtime.releaseObject',{objectId:object.objectId}).catch(()=>{});await this.client.send('Page.setInterceptFileChooserDialog',{enabled:false}).catch(()=>{});}
  const waitForAsset=()=>this.until(async()=>(await this.run('asset',{name:file.name})).exists,45000,'uploaded-asset');
  try{await waitForAsset();}catch(error){
   if(error.code!=='FLOW_UPLOAD_CONSENT_REQUIRED'||typeof this.confirmUploadRights!=='function')throw error;
   const rights=await this.run('upload-rights'),accepted=await abortable(()=>this.confirmUploadRights({text:rights.text,signal:this.signal}),this.signal);this.signal?.throwIfAborted();
   if(accepted!==true)throw fail('FLOW_UPLOAD_CONSENT_REQUIRED','Права на загрузку не подтверждены. Генерация не запускалась.');
   await this.run('accept-upload-rights',{text:rights.text});await this.until(async()=>!(await this.run('upload-rights-pending')),10000,'upload-rights-close');await waitForAsset();
  }
  await this.run('asset',{name:file.name,select:true});
  const selected=await this.until(async()=>{const a=await this.run('asset',{name:file.name});return a.preview||a.ingredients.length===expected.length+1?a:null;},15000,'asset-selection');
  let identity=mediaIdentity(selected.preview);
  if(selected.ingredients.length===expected.length){if(!identity)throw fail('INGREDIENT_NOT_VERIFIED','Не удалось проверить ресурс загруженного изображения.');await this.click('Добавить в запрос');}
  const composer=await this.until(async()=>{const c=await this.run('composer');return c.ingredients.length===expected.length+1?c:null;},15000,'ingredient-chip');
  if(JSON.stringify(composer.ingredients.slice(0,-1))!==JSON.stringify(expected))throw fail('INGREDIENT_CHANGED','Предыдущие ингредиенты изменились.');
  identity=frameRole?composer.ingredients.at(-1):identity||composer.ingredients.at(-1);if(!mediaIdentity(identity)||composer.ingredients.at(-1)!==identity)throw fail('INGREDIENT_CHANGED','Вложенный ресурс не совпадает с выбранным файлом.');
  return Object.freeze([...expected,identity]);
 }
}

function createBrowserEngine({accounts,dataDir,pollMs=250,confirmUploadRights,bindingTimeoutMs=60000,inspectVideo,agentEdit=agentEditDefault,observationRefreshMs=30000}){
 if(!accounts?.acquireIsolatedGenerationBrowser||!path.isAbsolute(dataDir||''))throw new TypeError('Managed accounts and absolute dataDir required.');
 const prepared=new WeakSet(),used=new WeakSet(),receipts=createReceiptStore(dataDir);
 async function diagnose(page,jobId,error){try{const folder=path.join(dataDir,'browser-diagnostics');await fs.mkdir(folder,{recursive:true,mode:0o700});const detail={at:new Date().toISOString(),code:error.code,message:error.message,state:await page.run('failure-state')};await fs.writeFile(path.join(folder,jobId+'.json'),JSON.stringify(detail,null,2),{mode:0o600});const shot=await page.client.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});if(shot.data)await fs.writeFile(path.join(folder,jobId+'.png'),Buffer.from(shot.data,'base64'),{mode:0o600});}catch{}}
 async function waitForSourceScene(page,expected,projectURL){return page.until(async()=>{try{return await page.run('source-scene',{sourceScene:expected,projectURL,loading:true});}catch(error){if(error.code==='SOURCE_VIDEO_NOT_READY')return false;throw error;}},30000,'source-video-scene');}
 async function prepare(input,{signal,onProgress=()=>{}}={}){
  const plan=planFor(input);
  if(!Number.isSafeInteger(input.accountId)||input.accountId<=0||typeof input.accountEmail!=='string')throw fail('ACCOUNT_REQUIRED','Выберите подключённый аккаунт для фоновой генерации.');
  const decoded=plan.refs.map(ref=>decodeImage(ref.dataUrl));
  let videoMetadata;
  if(plan.video){if(typeof inspectVideo!=='function')throw fail('VIDEO_METADATA_UNAVAILABLE','Обновите локальный движок проверки видео.');videoMetadata=await inspectVideo({path:plan.video.path,signal});if(!Number.isFinite(videoMetadata?.durationSeconds)||videoMetadata.durationSeconds<=0||videoMetadata.durationSeconds>15.02||!['video/mp4','video/quicktime','video/x-m4v'].includes(videoMetadata.mimeType))throw fail('VIDEO_METADATA_INVALID','Не удалось подтвердить исходное видео длительностью до 15 секунд.');const expected=plan.resolution==='360p'?(plan.aspect==='9:16'?[360,640]:[640,360]):plan.aspect==='9:16'?[720,1280]:[1280,720];if(videoMetadata.width!==expected[0]||videoMetadata.height!==expected[1])throw fail('MODEL_SETTINGS_NOT_VERIFIED','Для выбранного режима редактирования исходное видео должно иметь формат '+expected[0]+'×'+expected[1]+'. Измените выбранную модель или подготовьте исходник нужного размера.');}
  const lease=await accounts.acquireIsolatedGenerationBrowser(input.accountId,{signal,...(plan.video||plan.kind==='image'?{windowMode:'offscreen'}:{})});let folder,page,ingredients=Object.freeze([]),ownedDraft=false,sourceScene,sourceAssetName;const imageAssetNames=[];
  try{
   if(lease.email.toLowerCase()!==input.accountEmail.toLowerCase())throw fail('ACCOUNT_MISMATCH','Аккаунт изменился до начала генерации.');
   page=new FlowPage(lease.client,signal,{pollMs,leaseSignal:lease.signal,confirmUploadRights:typeof confirmUploadRights==='function'?details=>confirmUploadRights({...details,accountId:lease.accountId,accountEmail:lease.email}):undefined});onProgress('Подключаем фоновый браузер…');const projectURL=await page.project(lease.email);
   if(plan.video){
    folder=await fs.mkdtemp(path.join(dataDir,'browser-inputs-'));await fs.chmod(folder,0o700);
    const staged=await stageVideo(plan.video.path,folder),file=staged.target,name=path.basename(file);sourceAssetName=name.replace(/\.(mp4|mov|m4v)$/i,'');
    // This digest records the bytes assigned to Flow's input; it is not a Google media ID.
    const sourceHash=crypto.createHash('sha256'),sourceFile=await fs.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{for await(const chunk of sourceFile.createReadStream({autoClose:false}))sourceHash.update(chunk);}finally{await sourceFile.close();}
    const sha256=sourceHash.digest('hex');
    await page.click('Добавить медиа');await page.uploadSourceVideo(file);
    const uploaded=()=>page.until(()=>page.run('video-uploaded',{name}),120000,'source-video-upload');let source;try{source=await uploaded();}catch(error){if(error.code!=='FLOW_UPLOAD_CONSENT_REQUIRED'||typeof page.confirmUploadRights!=='function')throw error;const rights=await page.run('upload-rights');if(await abortable(()=>page.confirmUploadRights({text:rights.text,signal:page.signal}),page.signal)!==true)throw error;await page.run('accept-upload-rights',{text:rights.text});await page.until(async()=>!(await page.run('upload-rights-pending')),10000,'video-rights-close');source=await uploaded();}await page.until(()=>page.run('video-uploaded',{name,open:true}),15000,'source-video-visible');await page.until(async()=>/\/edit\//.test((await page.run('state')).url),30000,'source-video-editor');
    const scene=await waitForSourceScene(page,{poster:source.poster,durationSeconds:videoMetadata.durationSeconds},projectURL);
    sourceScene=Object.freeze({...scene,sha256,durationSeconds:videoMetadata.durationSeconds,width:videoMetadata.width,height:videoMetadata.height});
    page.settings=async value=>{await page.run('edit-settings',{choose:true});await page.run('model-option');await page.verifyEditSettings(value,sourceScene);};page.verifySettings=value=>page.verifyEditSettings(value,sourceScene);
   }
   const original=await page.run('composer');if(original.prompt.trim()||original.ingredients.length){let detail;try{detail=await page.run('prompt-state',{expected:plan.prompt});}catch{}throw fail('BROWSER_DRAFT_PRESENT','В профиле остался незавершённый запрос. Откройте Flow через подключение аккаунта и сохраните или очистите черновик.'+(detail?' '+JSON.stringify(detail):''));}
   if(plan.kind==='image'){page.settings=value=>prepareImagePage(page,value);page.verifySettings=value=>verifyImagePage(page,value);}
   await page.settings(plan);ownedDraft=true;await page.fillPrompt(plan.prompt);
   if(plan.refs.length&&!folder){folder=await fs.mkdtemp(path.join(dataDir,'browser-inputs-'));await fs.chmod(folder,0o700);}
   for(let i=0;i<plan.refs.length;i++){
    const image=decoded[i],name='ref-'+image.sha256.slice(0,16)+'-'+i+'-'+crypto.randomUUID().slice(0,8)+'.'+image.ext,file=path.join(folder,name);
    imageAssetNames.push(name);await fs.writeFile(file,image.bytes,{flag:'wx',mode:0o600});onProgress('Прикрепляем изображение '+(i+1)+' из '+plan.refs.length+'…');ingredients=await page.upload({path:file,name},ingredients,plan.method==='frames'?(i===0?'Старт':'Конец'):undefined);
   }
   await page.verifySettings(plan);await page.verifyAccount(lease.email);const c=await page.run('composer');if(!samePrompt(c.prompt,plan.prompt)||JSON.stringify(c.ingredients)!==JSON.stringify(ingredients))throw fail('PREPARED_INPUT_CHANGED','Flow изменил подготовленный запрос.');
   const result=Object.freeze({lease,page,plan,ingredients,projectURL,folder,jobId:input.jobId,...(sourceScene?{sourceScene,sourceAssetName,imageAssetNames}:{})});prepared.add(result);return result;
  }catch(error){if(page&&!page.signal?.aborted)await diagnose(page,input.jobId||'preparation',error);if(ownedDraft&&!signal?.aborted)await clearOwned(page,plan.prompt,ingredients).catch(()=>{});try{if(folder)await fs.rm(folder,{recursive:true,force:true});}finally{await accounts.releaseIsolatedGenerationBrowser(lease).catch(()=>{});}throw error;}
 }
 async function clearOwned(page,prompt,ingredients){if(!await page.run('clear-owned',{prompt,ingredients}))return false;await page.until(async()=>{const c=await page.run('composer');return samePrompt(c.prompt,prompt)&&c.ingredients.length===0;},15000,'clear-owned-ingredients');await page.fillPrompt('');try{await page.until(async()=>{const c=await page.run('composer');return c.prompt===''&&c.ingredients.length===0;},15000,'clear-owned');}catch(error){try{const c=await page.run('composer');error.message+=' '+JSON.stringify({promptLength:c.prompt.length,ingredientCount:c.ingredients.length});}catch{}throw error;}return true;}
 async function release(result){try{await accounts.releaseIsolatedGenerationBrowser(result.lease);}finally{if(result.folder)await fs.rm(result.folder,{recursive:true,force:true});}}
 async function submit(result,{signal,beforeSubmit,onProgress=()=>{}}={}){
  if(!prepared.has(result)||used.has(result)||typeof beforeSubmit!=='function')throw fail('PREPARATION_REQUIRED','Нужна неиспользованная подготовка запроса.');used.add(result);
  const {page,plan,ingredients,lease}=result,job=result.jobId||crypto.randomUUID();let clicked=false;
  if(signal!==page.requestSignal)throw fail('PREPARATION_SIGNAL_CHANGED','Подготовка и отправка должны принадлежать одной задаче.');
  if(result.sourceScene&&agentEdit)return submitAgentEdit(result,{signal,beforeSubmit,onProgress});
  try{
   await page.verifyAccount(lease.email);await page.verifySettings(plan);const baseline=result.sourceScene?[]:await page.run('baseline',{job});
   const c=await page.run('composer');if(!samePrompt(c.prompt,plan.prompt)||JSON.stringify(c.ingredients)!==JSON.stringify(ingredients))throw fail('PREPARED_INPUT_CHANGED','Подготовленный запрос изменился.');
   if(result.sourceScene)await waitForSourceScene(page,result.sourceScene);
   signal?.throwIfAborted();await receipts.write(job,{model:plan.model,prompt:plan.prompt,accountId:lease.accountId,accountEmail:lease.email,projectURL:result.projectURL,ingredients:[...ingredients],baseline,createdAt:new Date().toISOString(),...(result.sourceScene?{sourceScene:result.sourceScene}:{}),...(result.sourceVideo?{sourceVideo:result.sourceVideo,sourceVideoDuration:result.sourceVideoDuration}:{})});await beforeSubmit();signal?.throwIfAborted();
   if(result.sourceScene)await waitForSourceScene(page,result.sourceScene);
   // The sole paid action. Every error after this point is outcome-unknown until Flow proves otherwise.
   if(plan.kind==='image'){await page.client.send('Page.setWebLifecycleState',{state:'active'});await page.client.send('Emulation.setFocusEmulationEnabled',{enabled:true});}
   clicked=true;let submitted=await page.run('submit',{prompt:plan.prompt,ingredients,trusted:plan.kind==='image'||plan.method==='edit'});
   if(plan.kind==='image'){await page.trustedClick(submitted);submitted={clicked:true};}
   else if(plan.method==='edit'){await page.trustedControlClick('Начать генерацию');submitted={clicked:true};}
   if(submitted?.clicked!==true)throw fail('SUBMIT_CONTROL_UNAVAILABLE','Не удалось подтвердить нажатие создания видео.');onProgress('Запрос отправлен в Flow. Ожидаем подтверждение…');
   if(result.sourceScene)return await observeSourceScene({page,plan,ingredients,lease,projectURL:result.projectURL,sourceScene:result.sourceScene,onProgress,waitForResult:true});
   await page.bind(baseline,plan.prompt,job,bindingTimeoutMs,plan.kind);
   return await collectResult({page,plan,ingredients,lease,job,projectURL:result.projectURL,onProgress,sourceVideo:result.sourceVideo,sourceScene:result.sourceScene});
  }catch(error){if(!clicked&&!signal?.aborted)await clearOwned(page,plan.prompt,ingredients).catch(()=>{});if(!page.signal?.aborted)await diagnose(page,job,error);error.unknownOutcome=clicked&&!error.generationTerminal;throw error;}
 }
 async function submitAgentEdit(result,{signal,beforeSubmit,onProgress}){
  const {page,plan,ingredients,lease,sourceScene,projectURL}=result,job=result.jobId||crypto.randomUUID();let approved=false;const selectionNonces=[];
  const resourceId=value=>{const match=/\/image\/([A-Za-z0-9_-]{1,256})$/.exec(value||'');if(!match)throw fail('SOURCE_VIDEO_NOT_VERIFIED','Не удалось прочитать ресурс исходника Agent.');return match[1];};
  try{
   await page.verifyAccount(lease.email);await page.verifySettings(plan);await waitForSourceScene(page,sourceScene);
   if(!await clearOwned(page,plan.prompt,ingredients))throw fail('PREPARED_INPUT_CHANGED','Исходный черновик изменился перед подготовкой Agent.');
   await page.client.send('Page.navigate',{url:projectURL});await page.until(async()=>(await page.run('state')).url===projectURL,30000,'agent-project');await page.client.send('Page.reload',{ignoreCache:true});await page.ready();await page.verifyAccount(lease.email);
   await page.client.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});await agentEdit.startAgentSession(page);await agentEdit.configureAgentEdit(page,plan);
   if(ingredients.length)await agentEdit.prepareAgentReferenceContext(page,{verifySettings:()=>agentEdit.verifyAgentEditSettings(page,plan)});
   let previous={sourceImageResourceId:null,ingredientImageResourceIds:[]};
   const sourceImageResourceId=resourceId(sourceScene.poster),ingredientImageResourceIds=ingredients.map(resourceId);
   {const selected=await agentEdit.attachAgentAsset(page,{name:result.sourceAssetName,kind:'video',expectedResourceId:sourceImageResourceId,previous});if(selected?.selectionNonce)selectionNonces.push(selected.selectionNonce);}previous={sourceImageResourceId,ingredientImageResourceIds:[]};
   for(let index=0;index<ingredients.length;index++){const selected=await agentEdit.attachAgentAsset(page,{name:result.imageAssetNames[index],kind:'image',expectedResourceId:ingredientImageResourceIds[index],previous});if(selected?.selectionNonce)selectionNonces.push(selected.selectionNonce);previous={sourceImageResourceId,ingredientImageResourceIds:ingredientImageResourceIds.slice(0,index+1)};}
   const seconds=Math.ceil(sourceScene.durationSeconds),rate=plan.resolution==='360p'?1:3,maxCredits=rate*(Math.min(seconds,10)+Math.max(0,seconds-10)*2);
   const expected={projectURL,prompt:plan.prompt,sourceImageResourceId,ingredientImageResourceIds,maxCredits};
   onProgress('Готовим редактирование через Flow Agent…');const verifySettings=()=>agentEdit.verifyAgentEditSettings(page,plan),binding=await agentEdit.prepareAgentProposal(page,expected,{verifySettings});
   await agentEdit.approveAgentEdit(page,binding,{verifySettings,beforeSubmit:async()=>{await page.verifyAccount(lease.email);await receipts.write(job,{model:plan.model,prompt:plan.prompt,accountId:lease.accountId,accountEmail:lease.email,projectURL,ingredients:[...ingredients],baseline:[],createdAt:new Date().toISOString(),sourceScene,agentProposal:{quoteCredits:binding.quoteCredits,videoCount:1,sourcePreview:binding.source.origin+binding.source.path,approvalText:binding.permissionTitle}});await beforeSubmit();}});approved=true;
   onProgress('Редактирование отправлено в Flow Agent. Ожидаем видео…');await page.client.send('Page.navigate',{url:sourceScene.url});
   await page.until(async()=>(await page.run('state')).url===sourceScene.url,30000,'agent-output-scene');
   return await observeAgentScene({page,plan,ingredients,lease,projectURL,sourceScene,sourcePreview:binding.source.origin+binding.source.path,onProgress,waitForResult:true});
  }catch(error){if(!approved&&error.unknownOutcome!==true&&!page.signal?.aborted&&typeof agentEdit.clearOwnedAgentAttachments==='function'){if(error.agentSelectionNonce)selectionNonces.push(error.agentSelectionNonce);await agentEdit.clearOwnedAgentAttachments(page,{nonces:selectionNonces,prompt:''}).catch(()=>{});}if(!page.signal?.aborted)await diagnose(page,job,error);error.unknownOutcome=!error.generationTerminal&&(approved||error.unknownOutcome===true);throw error;}
 }
 async function observeAgentScene({page,plan,ingredients,lease,projectURL,sourceScene,sourcePreview,onProgress=()=>{},waitForResult=false}){
  const read=async()=>{const value=await page.run('agent-scene-result',{sourceScene,sourcePreview,prompt:plan.prompt,ingredients,open:true});if(value?.failure){const error=fail('FLOW_GENERATION_REJECTED','Flow отклонил редактирование: '+value.failure.message);error.generationTerminal=true;error.accountFailure=false;throw error;}return value?.ready?value:false;};
  let lastRefresh=Date.now(),refreshDelay=observationRefreshMs;const poll=async()=>{const value=await read();if(value)return value;if(Date.now()-lastRefresh>=refreshDelay){if((await page.run('state')).url!==sourceScene.url)throw fail('SOURCE_VIDEO_NOT_VERIFIED','Сцена редактирования изменилась во время ожидания.');await page.client.send('Page.reload',{});lastRefresh=Date.now();refreshDelay=Math.min(refreshDelay*2,120000);onProgress('Обновляем состояние отправленного видео. Повторной генерации нет…');}return false;};
  let history;try{history=await page.until(poll,waitForResult?30*60*1000:30000,'agent-source-scene-result');}catch(error){if(error.code==='FLOW_UI_TIMEOUT'&&!waitForResult)throw fail('RESULT_NOT_READY','Редактирование ещё не завершено. Новая отправка не запускалась.');throw error;}if(!history)throw fail('RESULT_NOT_READY','Редактирование ещё не завершено. Новая отправка не запускалась.');
  const folder=await fs.mkdtemp(path.join(dataDir,'browser-result-'));await fs.chmod(folder,0o700);
  try{const filename=await downloadOriginal(lease.client,page,folder,plan.resolution,page.signal,'video',{kind:'video',poster:history.posters[0],prompt:history.prompt,ingredients:history.ingredients,sourceVideos:history.sourceVideos||[],sourcePreviews:history.sourcePreviews||[],url:history.url,agentSource:{sourceScene,sourcePreview}}),file=path.join(folder,filename);
   if(typeof inspectVideo!=='function'||(await fs.stat(file)).size>100*1024*1024)throw fail('OUTPUT_METADATA_UNAVAILABLE','Не удалось проверить параметры результата Agent: локальная проверка доступна для видео до 100 МБ. Повторной генерации нет.');
   const metadata=await inspectVideo({path:file,signal:page.signal});
   if(metadata?.width!==sourceScene.width||metadata?.height!==sourceScene.height||!Number.isFinite(metadata?.durationSeconds)||metadata.durationSeconds<=0||metadata.durationSeconds>15.02||Math.abs(metadata.durationSeconds-sourceScene.durationSeconds)>0.15)throw fail('MODEL_SETTINGS_NOT_VERIFIED','Размер или длительность результата Agent не совпали с выбранными параметрами. Повторной генерации нет.');
   onProgress('Готово');return {media:[{kind:'video',path:file}],accountId:lease.accountId,accountEmail:lease.email,projectURL};
  }catch(error){await fs.rm(folder,{recursive:true,force:true});throw error;}
 }
 async function observeSourceScene({page,plan,ingredients,lease,projectURL,sourceScene,onProgress=()=>{},waitForResult=false}){
  const read=async()=>{
   try{
    const state=await page.run('source-scene',{sourceScene,output:true,loading:true,prompt:plan.prompt,ingredients});
    if(state.failure){const rejection=fail('FLOW_GENERATION_REJECTED','Flow отклонил редактирование: '+state.failure.message);rejection.generationTerminal=true;rejection.accountFailure=false;throw rejection;}
    const history=await page.run('history',{kind:'video',...(state.outputPoster?{poster:state.outputPoster}:{})});
    if(history.ingredientsReady===false)return false;
    if(history.url!==sourceScene.url||!exactHistoryPrompt(history.prompt,plan.prompt)||JSON.stringify(history.ingredients)!==JSON.stringify(ingredients)||history.posters?.length!==1||history.posters[0]===sourceScene.poster||state.outputPoster&&history.posters[0]!==state.outputPoster)throw fail('RESULT_INPUT_MISMATCH','Выбранная версия исходной сцены не совпала с запросом и изображениями.');
    return history;
   }catch(error){if(error.code==='SOURCE_VIDEO_NOT_READY')return false;throw error;}
  };
  const history=waitForResult?await page.until(async()=>{const result=await read();if(!result)onProgress('Ожидаем новую версию в исходной сцене. Повторной отправки нет…');return result;},30*60*1000,'source-scene-result'):await read();
  if(!history)throw fail('RESULT_NOT_READY','Новая версия исходной сцены ещё не готова. Повторная генерация не запускалась.');
  await page.run('source-scene',{sourceScene,output:true});
  const folder=await fs.mkdtemp(path.join(dataDir,'browser-result-'));await fs.chmod(folder,0o700);
  try{
   const filename=await downloadOriginal(lease.client,page,folder,plan.resolution,page.signal,'video',{kind:'video',poster:history.posters[0],prompt:history.prompt,ingredients:history.ingredients,sourceVideos:history.sourceVideos||[],url:history.url,sourceScene});
   const file=path.join(folder,filename);
   if(typeof inspectVideo!=='function'||(await fs.stat(file)).size>100*1024*1024)throw fail('OUTPUT_METADATA_UNAVAILABLE','Не удалось проверить параметры результата Edit: локальная проверка доступна для видео до 100 МБ. Успех не подтверждён; повторная генерация не запускалась.');
   const metadata=await inspectVideo({path:file,signal:page.signal});
   if(metadata?.width!==sourceScene.width||metadata?.height!==sourceScene.height||!Number.isFinite(metadata?.durationSeconds)||metadata.durationSeconds<=0||metadata.durationSeconds>15.02||Math.abs(metadata.durationSeconds-sourceScene.durationSeconds)>0.15)throw fail('MODEL_SETTINGS_NOT_VERIFIED','Параметры результата Edit не совпали с выбранным режимом '+sourceScene.width+'×'+sourceScene.height+' и длительностью исходника '+sourceScene.durationSeconds+' с. Успех не подтверждён; повторная генерация не запускалась.');
   onProgress('Готово');return {media:[{kind:'video',path:file}],accountId:lease.accountId,accountEmail:lease.email,projectURL,sceneId:new URL(sourceScene.url).pathname.split('/edit/')[1]};
  }catch(error){await fs.rm(folder,{recursive:true,force:true});throw error;}
 }
 async function collectResult({page,plan,ingredients,lease,job,projectURL,onProgress=()=>{},sourceVideo,sourceScene}){
   const outcome=await page.until(async()=>{const state=await page.run('result',{job,prompt:plan.prompt,kind:plan.kind});if(!state)throw fail('RESULT_LOST','Карточка задачи недоступна. Проверьте проект Flow перед повтором.');if(state.error){const code=state.error.match(/\bPUBLIC_ERROR_[A-Z_]+\b/)?.[0];const e=fail(code||'FLOW_GENERATION_REJECTED',state.error);e.generationTerminal=!state.provisional;e.accountFailure=Boolean(e.generationTerminal&&code&&!/MINOR|UNSAFE|PROMINENT|CONTENT/.test(code));throw e;}if(state.progress!==null)onProgress('Генерация: '+state.progress+'%');return state.complete?state:null;},30*60*1000);
   if(!outcome.complete)throw fail('RESULT_NOT_READY','Flow ещё не завершил генерацию.');const resultPoster=await page.run('result-poster',{job,kind:plan.kind});if(!resultPoster)throw fail('RESULT_NOT_VERIFIED','Не удалось проверить карточку результата.');const opened=await page.run('result',{job,open:true,kind:plan.kind});if(opened?.openPoint)await page.trustedClick(opened.openPoint,true);
   const history=await page.until(async()=>{try{const value=await page.run('history',{kind:plan.kind,poster:resultPoster});return value.ingredientsReady===false?false:value;}catch(e){if(e.code==='CONTROL_NOT_FOUND')return null;throw e;}},60000,'result-history');
   if(!exactHistoryPrompt(history.prompt,plan.prompt)||JSON.stringify(history.ingredients)!==JSON.stringify(ingredients)||history.posters?.length!==1||history.posters[0]!==resultPoster)throw fail('RESULT_INPUT_MISMATCH','Не удалось связать результат с исходным запросом и изображениями.');
   if(sourceVideo&&!history.sourceVideos?.includes(sourceVideo))throw fail('SOURCE_VIDEO_NOT_VERIFIED','Flow не подтвердил связь результата с исходным видео. Новая генерация не запускалась.');
   if(sourceScene)await page.run('source-scene',{sourceScene,output:true});
   const sceneId=new URL(history.url).pathname.match(/\/edit\/([a-f0-9-]{36})$/i)?.[1];
   const folder=await fs.mkdtemp(path.join(dataDir,'browser-result-'));await fs.chmod(folder,0o700);
   try{
    const downloaded=await downloadOriginal(lease.client,page,folder,plan.resolution,page.signal,plan.kind,{kind:plan.kind,poster:resultPoster,prompt:history.prompt,ingredients:history.ingredients,sourceVideos:history.sourceVideos||[],url:history.url,...(sourceScene?{sourceScene}:{})});const file=path.join(folder,downloaded);
    onProgress('Готово');return {media:[{kind:plan.kind||'video',path:file}],accountId:lease.accountId,accountEmail:lease.email,projectURL:projectURL,...(sceneId?{sceneId}:{})};
   }catch(e){await fs.rm(folder,{recursive:true,force:true});throw e;}
 }
 async function generate(input,options={}){
  let result,observationError;
  try{result=await prepare(input,options);options.onAccount?.({id:result.lease.accountId,email:result.lease.email});return await submit(result,options);}
  catch(error){if(!input.jobId||options.signal?.aborted||!error.unknownOutcome||!['RESULT_BINDING_CHANGED','RESULT_LOST','FLOW_UI_TIMEOUT','DOWNLOAD_FAILED','CDP_TIMEOUT'].includes(error.code))throw error;observationError=error;}
  finally{if(result)await release(result);}
  if(observationError){options.onProgress?.('Восстанавливаем наблюдение за отправленной задачей. Новая генерация не запускается…');return recover(input.jobId,{signal:options.signal,onProgress:options.onProgress,expected:{accountId:input.accountId,accountEmail:input.accountEmail,model:input.model,prompt:input.prompt},waitForResult:true});}
 }
 async function inspect(accountId,{signal,email}={}){const lease=await accounts.acquireIsolatedGenerationBrowser(accountId,{signal});const page=new FlowPage(lease.client,signal,{pollMs,leaseSignal:lease.signal});try{const projectURL=await page.project(email||lease.email);await page.click('Триггер настроек');let controls;try{controls=await page.until(async()=>{const c=await page.run('controls');return c.radios.length?c:null;},15000,'settings-inspection');}finally{await page.click('Триггер настроек').catch(()=>{});}return {ready:true,accountId:lease.accountId,accountEmail:lease.email,projectURL,engine:'isolated-browser',usesDesktopFocus:false,controls};}finally{await accounts.releaseIsolatedGenerationBrowser(lease);}}
 async function check(input,options={}){let result;try{result=await prepare(input,options);const cleared=await clearOwned(result.page,result.plan.prompt,result.ingredients);if(!cleared)throw fail('PREPARED_INPUT_CHANGED','Черновик изменился во время проверки. Он сохранён в Flow.');return {ready:true,accountId:result.lease.accountId,accountEmail:result.lease.email,projectURL:result.projectURL,model:result.plan.model,referenceCount:result.ingredients.length,uploadedImages:result.ingredients.length,submitted:false,cleared};}finally{if(result)await release(result);}}
 async function recover(jobId,{signal,onProgress=()=>{},expected,waitForResult=false}={}){
  let receipt;try{receipt=await receipts.read(jobId);}catch(error){if(error.code==='ENOENT')throw fail('BROWSER_RECEIPT_MISSING','Для этой старой задачи нет записи отправки. Проверьте результат вручную в Flow. Повторная генерация не запускалась.');throw error;}
  if(expected&&['accountId','accountEmail','model','prompt'].some(key=>expected[key]!==receipt[key]))throw fail('BROWSER_RECEIPT_MISMATCH','Запись отправки не совпадает с исходной задачей.');
  const plan=planFor({model:receipt.model,prompt:receipt.prompt,references:[...receipt.ingredients.map(()=>({kind:'image'})),...(receipt.sourceVideo||receipt.sourceScene?[{kind:'video',path:path.join(dataDir,'receipt-video.mp4')}]:[])]}),lease=await accounts.acquireIsolatedGenerationBrowser(receipt.accountId,{signal,...(supportsImageModel({model:receipt.model})||receipt.sourceScene||receipt.sourceVideo?{windowMode:'offscreen'}:{})});let page;
  try{
   if(lease.email.toLowerCase()!==receipt.accountEmail.toLowerCase())throw fail('ACCOUNT_MISMATCH','Исходный аккаунт изменился.');
   page=new FlowPage(lease.client,signal,{pollMs,leaseSignal:lease.signal});await page.ready();await page.verifyAccount(receipt.accountEmail);
   if(receipt.sourceScene){
    if((await page.run('state')).url!==receipt.sourceScene.url){await lease.client.send('Page.navigate',{url:receipt.sourceScene.url});await page.until(async()=>(await page.run('state')).url===receipt.sourceScene.url,30000,'recovery-source-scene');await page.verifyAccount(receipt.accountEmail);}
    if(receipt.agentProposal)return await observeAgentScene({page,plan,ingredients:receipt.ingredients,lease,projectURL:receipt.projectURL,sourceScene:receipt.sourceScene,sourcePreview:receipt.agentProposal.sourcePreview,onProgress,waitForResult});
    return await observeSourceScene({page,plan,ingredients:receipt.ingredients,lease,projectURL:receipt.projectURL,sourceScene:receipt.sourceScene,onProgress,waitForResult});
   }
   if((await page.run('state')).url!==receipt.projectURL){await lease.client.send('Page.navigate',{url:receipt.projectURL});await page.until(async()=>(await page.run('state')).url===receipt.projectURL,30000,'recovery-project');await page.verifyAccount(receipt.accountEmail);}
   onProgress('Проверяем уже отправленную задачу в Flow…');
   const checked=new Set();let sawCandidate=false;
   const find=async()=>{
    if((await page.run('state')).url!==receipt.projectURL){await lease.client.send('Page.navigate',{url:receipt.projectURL});await page.until(async()=>(await page.run('state')).url===receipt.projectURL,30000,'recovery-project');}
    const candidates=await page.run('recovery-candidates',{kind:plan.kind});
    onProgress('Проверяем готовые результаты: '+candidates.length+' · '+(plan.kind||'video'));
    const candidatesToCheck=candidates.filter(candidate=>!receipt.baseline.some(old=>old.name===candidate.name&&old.poster===candidate.poster)&&!checked.has(candidate.name+'\n'+candidate.poster));
    for(const current of candidatesToCheck){
     sawCandidate=true;page.signal?.throwIfAborted();
     if((await page.run('state')).url!==receipt.projectURL){await lease.client.send('Page.navigate',{url:receipt.projectURL});await page.until(async()=>(await page.run('state')).url===receipt.projectURL,30000,'recovery-project');}
     await page.until(async()=>{const xs=await page.run('recovery-candidates',{kind:plan.kind});return xs.some(item=>item.name===current.name&&item.poster===current.poster);},30000,'recovery-candidate-ready');
     const opened=await page.until(()=>page.run('open-recovery-candidate',{...current,kind:plan.kind}),15000,'recovery-candidate-visible');if(opened?.openPoint)await page.trustedClick(opened.openPoint,true);
     let detail;
     try{detail=await page.until(async()=>{try{const value=await page.run('history',{kind:plan.kind,poster:current.poster});return value.ingredientsReady===false?false:value;}catch(error){if(error.code==='CONTROL_NOT_FOUND')return false;throw error;}},60000,'recovered-result-history');}
     catch(error){if(error.code!=='RESULT_INPUT_MISMATCH')throw error;checked.add(current.name+'\n'+current.poster);continue;}
     if(exactHistoryPrompt(detail.prompt,receipt.prompt)&&JSON.stringify(detail.ingredients)===JSON.stringify(receipt.ingredients)&&detail.posters?.length===1&&detail.posters[0]===current.poster){if(receipt.sourceVideo&&!detail.sourceVideos?.includes(receipt.sourceVideo))throw fail('SOURCE_VIDEO_NOT_VERIFIED','Flow не подтвердил исходное видео этого результата. Новая генерация не запускалась.');if(receipt.sourceScene)await page.run('source-scene',{sourceScene:receipt.sourceScene,output:true});return {candidate:current,history:detail};}
     checked.add(current.name+'\n'+current.poster);
    }
    return false;
   };
   const matched=waitForResult?await page.until(async()=>{checked.clear();const found=await find();if(!found){onProgress('Ожидаем готовое видео в исходном проекте. Повторной отправки нет…');await wait(3000,undefined,{signal:page.signal});}return found;},30*60*1000,'recover-existing-generation'):await find();
   if(!matched)throw fail(sawCandidate?'RESULT_INPUT_MISMATCH':'RESULT_NOT_READY',sawCandidate?'Готовые результаты не совпали с исходным запросом и референсами. Новая генерация не запускалась.':'Готовый результат ещё не появился в проекте. Новая генерация не запускалась.');
   const folder=await fs.mkdtemp(path.join(dataDir,'browser-result-'));await fs.chmod(folder,0o700);try{const detail=matched.history,filename=await downloadOriginal(lease.client,page,folder,plan.resolution,page.signal,plan.kind,{kind:plan.kind,poster:matched.candidate.poster,prompt:detail.prompt,ingredients:detail.ingredients,sourceVideos:detail.sourceVideos||[],url:detail.url,...(receipt.sourceScene?{sourceScene:receipt.sourceScene}:{})});return {media:[{kind:plan.kind||'video',path:path.join(folder,filename)}],accountId:lease.accountId,accountEmail:lease.email,projectURL:receipt.projectURL};}catch(error){await fs.rm(folder,{recursive:true,force:true});throw error;}
  }catch(error){if(page&&!page.signal?.aborted)await diagnose(page,jobId,error);error.unknownOutcome=!error.generationTerminal;throw error;}finally{await accounts.releaseIsolatedGenerationBrowser(lease);}
 }
 return {supports:input=>input?.model==='omni-1.2-flash'||MODEL.test(input?.model||'')||EDIT.test(input?.model||'')||supportsImageModel(input)||supportsVeoModel(input),prepare,submit,release,generate,inspect,check,recover};
}

async function downloadOriginal(client,page,folder,resolution,signal,kind='video',binding){
 if(typeof client.browserSend!=='function')throw fail('DOWNLOAD_UNAVAILABLE','Обновите подключение фонового браузера.');
 await client.browserSend('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:folder,eventsEnabled:true});
 const frame=await client.send('Page.getFrameTree');const frameId=frame.frameTree?.frame?.id;if(!frameId)throw fail('DOWNLOAD_UNAVAILABLE','Не удалось проверить вкладку результата.');
 let guid,completed=false,downloadError;const off=client.onEvent(event=>{if(event.method==='Browser.downloadWillBegin'){if(event.params.frameId!==frameId||!allowedDownload(event.params.url,kind)){void client.browserSend('Browser.cancelDownload',{guid:event.params.guid}).catch(()=>{});return;}if(guid&&guid!==event.params.guid){downloadError=fail('DOWNLOAD_AMBIGUOUS','Flow начал несколько загрузок.');void client.browserSend('Browser.cancelDownload',{guid:event.params.guid}).catch(()=>{});return;}guid=event.params.guid;}if(event.method==='Browser.downloadProgress'&&event.params.guid===guid){if(event.params.state==='completed')completed=true;if(event.params.state==='canceled')downloadError=fail('DOWNLOAD_FAILED','Загрузка результата остановлена.');}});
 try{
  let menuId;if(binding){await page.run('history-download',{binding,click:true});let menu=await page.until(()=>page.run('history-download-menu',{binding}),15000,'history-download-menu');if(menu.needsSubmenu){await page.run('history-download-menu',{binding,open:true});menu=await page.until(()=>page.run('history-download-menu',{binding,submenu:true}),15000,'history-download-submenu');}menuId=menu.menuId;}else await page.click('Скачать медиаконтент');const original=kind==='image'?resolution==='standard'?'1K':resolution.toUpperCase():resolution,option=kind==='image'?'image-download-option':'download-option',selectors={resolution:original,...(binding?{binding,menuId}:{})};await page.until(()=>page.run(option,selectors),15000,'download-original-option');await page.run(option,{...selectors,click:true});
  await page.until(async()=>{if(downloadError)throw downloadError;if(!completed)return false;if(!/^[a-f0-9-]{36}$/i.test(guid||''))throw fail('DOWNLOAD_INVALID','Браузер вернул неверный файл.');const stat=await fs.lstat(path.join(folder,guid));if(!stat.isFile()||stat.isSymbolicLink()||stat.size<12||stat.size>512*1024*1024)throw fail('DOWNLOAD_INVALID','Некорректный размер скачанного видео.');return true;},120000,'download-completed');
  const from=path.join(folder,guid);let to='result.mp4';const handle=await fs.open(from,'r');try{const header=Buffer.alloc(12);await handle.read(header,0,12,0);if(kind==='image'){if(header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))to='result.png';else if(header[0]===255&&header[1]===216&&header[2]===255)to='result.jpg';else if(header.toString('ascii',0,4)==='RIFF'&&header.toString('ascii',8,12)==='WEBP')to='result.webp';else throw fail('DOWNLOAD_INVALID','Flow вернул файл, который не является изображением.');}else if(header.toString('ascii',4,8)!=='ftyp')throw fail('DOWNLOAD_INVALID','Flow вернул файл, который не является MP4.');}finally{await handle.close();}await fs.rename(from,path.join(folder,to));return to;
 }finally{off?.();if(guid&&!completed)await client.browserSend('Browser.cancelDownload',{guid}).catch(()=>{});}
}
module.exports={createBrowserEngine,FlowPage,planFor,decodeImage,mediaIdentity,flowDOM,downloadOriginal,allowedDownload};
