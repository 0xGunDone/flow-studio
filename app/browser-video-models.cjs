'use strict';
const {modelSettings}=require('./renderer.js');

// Only the current listed standard Veo variants; hidden legacy IDs stay on their explicit route.
const VEO=/^veo-3\.1-(lite|fast|quality)(?:(?:-(i2v|r2v))?-(4|6|8)s-(landscape|portrait))?$/;
const fail=(code,message)=>Object.assign(new Error(message),{code});
function supportsVeoModel(input){
 const match=VEO.exec(input?.model||'');
 return Boolean(match&&!(match[2]==='r2v'&&(match[1]==='quality'||match[3]!=='8')));
}
function veoPlanFor(input){
 if(!supportsVeoModel(input))throw fail('BROWSER_MODEL_UNSUPPORTED','Фоновая генерация Veo принимает точные стандартные модели текущего каталога: текст, кадры или ингредиенты.');
 if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>20000)throw fail('INVALID_ARGUMENTS','Введите запрос длиной до 20 000 символов.');
 if(input.images!==undefined&&!Array.isArray(input.images)||input.sourceVideoId!==undefined||input.videoPaths!==undefined||input.startFramePath!==undefined||input.endFramePath!==undefined)throw fail('BROWSER_INPUT_UNSUPPORTED','Этот режим Veo принимает только изображения с назначенными заранее ролями.');
 const settings=modelSettings({id:input.model}),info=settings.info,method=settings.methods[0];
 const refs=input.references??(input.images||[]).map(dataUrl=>({kind:'image',dataUrl}));
 if(!Array.isArray(refs)||refs.some(reference=>reference?.kind!=='image')||refs.length<info.minImages||refs.length>info.maxImages)throw fail('BROWSER_INPUT_UNSUPPORTED',method==='text'?'Текстовый Veo не принимает изображения. Выберите точную модель с нужным методом.':method==='frames'?'Для Veo нужен начальный и при необходимости конечный кадр, не больше двух изображений.':'Veo принимает от одного до трёх изображений-ингредиентов.');
 return Object.freeze({kind:'video',method,model:input.model,prompt:input.prompt,refs,family:settings.family,seconds:Number(settings.duration),aspect:settings.aspect,resolution:'720p',minImages:info.minImages,maxImages:info.maxImages,requiredTier:info.requiredTier});
}

module.exports={supportsVeoModel,veoPlanFor};
