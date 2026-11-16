'use strict';
const {setTimeout:wait}=require('node:timers/promises');
const {randomUUID}=require('node:crypto');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const issued=new WeakMap(),used=new WeakSet();
const referenceContexts=new WeakMap();
const AGENT_REFERENCE_CONTEXT='For the next message, edit the attached video with Omni 1.2 Flash. Use every attached image as a generation ingredient, preserving attachment order; retain the next user prompt verbatim in the generation request. Make one video only. Do not generate or request approval until the next message supplies the video, images and prompt. If this combination cannot be passed to video editing, say so.';
const inputId=value=>value?.imageResourceId||value?.selectionClaim?.expectedResourceId||null;

// Runs only in Flow's own Agent panel. Ordinary composer helpers stay separate.
function agentEditDOM(op,arg={}){
 const error=(code,message)=>{throw new Error(code+': '+message);};
 const visible=el=>Boolean(el&&el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&!el.closest?.('[aria-hidden="true"],[inert]'));
 const text=el=>(el?.innerText||el?.textContent||'').trim();
 const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.replace(/\r\n/g,'\n').trim()===b.replace(/\r\n/g,'\n').trim();
 const projectURL=location.href;
 if(location.origin!=='https://flow.google.com'||!/^https:\/\/flow\.google\.com\/project\/[a-f0-9-]{36}$/i.test(projectURL)||arg.expected?.projectURL&&arg.expected.projectURL!==projectURL||arg.binding?.projectURL&&arg.binding.projectURL!==projectURL)error('AGENT_PROJECT_CHANGED','Проект помощника Flow изменился.');
 const panels=[...document.querySelectorAll('flow-agent-panel')].filter(visible);
 if(op==='panel-ready')return panels.length===1;
 if(op==='enable'){
  if(panels.length===1)return true;if(panels.length>1)error('AGENT_PANEL_NOT_VERIFIED','Найдено несколько панелей помощника.');
  const toggles=[...document.querySelectorAll('flow-agent-mode-toggle-chip button')].filter(visible).filter(node=>!node.closest('flow-agent-panel'));
  if(toggles.length!==1||text(toggles[0])!=='Agent')error('AGENT_CONTROL_AMBIGUOUS','Не найден собственный переключатель Agent.');
  if(toggles[0].getAttribute('aria-pressed')!=='true'){toggles[0].click();return false;}
  const roots=[...document.querySelectorAll('flow-creative-agent-prompt-box')].filter(visible).filter(node=>!node.closest('flow-agent-panel'));
  if(roots.length!==1)error('AGENT_CONTROL_AMBIGUOUS','Не найден основной редактор Agent.');
  const expands=[...roots[0].querySelectorAll('button[aria-label="Expand"]')].filter(visible);if(expands.length!==1)error('AGENT_CONTROL_AMBIGUOUS','Не найдена кнопка открытия панели Agent.');expands[0].click();return false;
 }
 if(panels.length===0&&op==='settings-open')return false;
 if(panels.length!==1)error('AGENT_PANEL_NOT_VERIFIED','Не удалось однозначно найти панель помощника Flow.');
 const panel=panels[0],owned=(selector,root=panel)=>[...root.querySelectorAll(selector)].filter(node=>node.closest('flow-agent-panel')===panel);
 const one=(selector,root=panel)=>{const values=owned(selector,root);if(values.length!==1)error('AGENT_CONTROL_AMBIGUOUS','Элемент помощника Flow выбран неоднозначно.');return values[0];};
 const click=el=>{if(!visible(el)||el.disabled||el.getAttribute('aria-disabled')==='true')error('AGENT_CONTROL_DISABLED','Элемент помощника Flow недоступен.');el.click();return true;};
 const point=el=>{if(!visible(el)||el.disabled||el.getAttribute('aria-disabled')==='true')error('AGENT_CONTROL_DISABLED','Элемент помощника Flow недоступен.');el.scrollIntoView?.({block:'center',inline:'nearest',behavior:'instant'});const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);if(!(r.width>0&&r.height>0)||!hit||!(hit===el||el.contains(hit)))error('AGENT_CONTROL_OBSCURED','Элемент помощника Flow перекрыт.');return {x,y,left:r.left,top:r.top,width:r.width,height:r.height};};
 const resource=value=>{try{const u=new URL(value);if(u.username||u.password||u.hash)return null;const pattern=u.origin==='https://flow-content.google'?/^\/image\/([A-Za-z0-9_-]{1,256})$/:u.origin==='https://storage.googleapis.com'?/^\/ai-sandbox-videofx\/image\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i:null,match=pattern?.exec(u.pathname);return match?{origin:u.origin,path:u.pathname,imageResourceId:match[1]}:null;}catch{return null;}};
 const inputs=(root,allowPending=false)=>{
  const rows=owned('flow-chat-ingredient-row',root);if(rows.length>1)error('AGENT_INPUTS_NOT_VERIFIED','В сообщении помощника найдено несколько наборов исходников.');
  const container=rows[0]||root,chips=owned('flow-video-ingredient-chip,flow-image-ingredient-chip',container),videos=[],images=[];
  for(const wrapper of owned('flow-ingredient-chip',container))if(chips.filter(chip=>chip.closest('flow-ingredient-chip')===wrapper).length!==1)error('AGENT_INPUTS_NOT_VERIFIED','Тип исходника помощника Flow не подтверждён.');
  for(const chip of chips){
   const video=chip.tagName==='FLOW-VIDEO-INGREDIENT-CHIP',selector=video?'img[alt="Video ingredient image"]':'img[alt="Ingredient image"],img[alt="Изображение ингредиента"]',values=owned(selector,chip).filter(node=>node.closest('flow-video-ingredient-chip,flow-image-ingredient-chip')===chip);
   let value=values.length===1?resource(values[0].getAttribute('src')):null;
   if(!value){
    if(values.length===0&&!allowPending)error('AGENT_INPUTS_NOT_READY','Ресурс отправленного исходника Agent ещё загружается.');
    if(!allowPending||values.length)error('AGENT_INPUTS_NOT_VERIFIED','Не удалось проверить ресурс исходника помощника Flow.');
    const claim=panel.__flowStudioAgentClaims?.get(chip);value={pending:true,imageResourceId:null,...(claim?{selectionClaim:claim}:{})};
   }
   (video?videos:images).push(value);
  }
  if(videos.length>1||images.length>5)error('AGENT_INPUTS_NOT_VERIFIED','Неверное число исходников помощника Flow.');
  return {source:videos[0]||null,ingredients:images};
 };
 const composer=()=>{
  const root=one('flow-agent-panel-prompt-box, .agent-panel-prompt-box'),editors=owned('flow-creative-agent-prompt-box flow-rich-text-editor [role="textbox"]',root);
  if(editors.length!==1)error('AGENT_CONTROL_AMBIGUOUS','Не удалось однозначно найти поле сообщения помощника Flow.');
  return {root,editor:editors[0],prompt:editors[0].innerText||editors[0].textContent||'',...inputs(root,true)};
 };
 const verifyInputs=(value,expected)=>{
  const id=item=>item?.imageResourceId||item?.selectionClaim?.expectedResourceId||null;
  if(!same(value.prompt,expected.prompt)||!value.source||id(value.source)!==expected.sourceImageResourceId||JSON.stringify(value.ingredients.map(id))!==JSON.stringify(expected.ingredientImageResourceIds))error('AGENT_INPUTS_CHANGED','Сообщение или исходники помощника Flow изменились.');
 };
 const settings=()=>{
  const root=one('flow-settings-view'),title=text(one('.agent-panel-header .header-title'));if(title!=='Agent settings')error('AGENT_SETTINGS_NOT_VERIFIED','Не открыты собственные настройки Agent.');
  const confirm=one('[role="radiogroup"][aria-labelledby="agent-settings-confirm-policy-label"]',root),choices=owned('mat-radio-button',confirm).map(chip=>{const labels=owned('.radio-label',chip),inputs=owned('input[type="radio"]',chip);if(labels.length!==1||inputs.length!==1)error('AGENT_SETTINGS_NOT_VERIFIED','Не удалось проверить варианты подтверждения Agent.');return {label:text(labels[0]),input:inputs[0]};});
  if(choices.length!==2||!choices.some(value=>value.label==='Always')||!choices.some(value=>value.label==='Never')||choices.filter(value=>value.input.checked===true).length!==1)error('AGENT_SETTINGS_NOT_VERIFIED','Подтверждение Agent выбрано неоднозначно.');
  const group=name=>one('flow-toggles[aria-label="Video generation default '+name+'"]',root);
  const radios=name=>owned('[role="radio"]',group(name)).map(node=>({node,name:text(node).replace(/^crop_[A-Za-z0-9_]+\s+/,''),checked:node.getAttribute('aria-checked')==='true'}));
  const selected=name=>{const values=radios(name).filter(value=>value.checked);if(values.length!==1)error('AGENT_SETTINGS_NOT_VERIFIED','Параметры видео Agent выбраны неоднозначно.');return values[0].name;};
  return {root,choices,radios,model:one('button[aria-label="Video generation default model"]',root),value:{confirm:choices.find(value=>value.input.checked===true).label,aspect:selected('aspect ratio'),count:selected('output count'),model:text(one('button[aria-label="Video generation default model"]',root)).replace(/\barrow_drop_down\b/g,'').trim()}};
 };
 const picker=()=>{const values=[...document.querySelectorAll('flow-add-menu-popover-content')].filter(visible).filter(node=>node.getAttribute('data-flow-studio-agent-picker')===arg.nonce);if(values.length!==1)error('AGENT_PICKER_NOT_VERIFIED','Не удалось проверить собственный список исходников Agent.');return values[0];};
 const pickerOption=()=>{
  const root=picker(),lists=[...root.querySelectorAll('[role="listbox"][aria-label="Asset list"]')].filter(visible);if(!lists.length)return null;if(lists.length>1)error('AGENT_PICKER_NOT_VERIFIED','Список исходников Agent выбран неоднозначно: '+lists.length+'.');
  const values=[...lists[0].querySelectorAll('button[role="option"]')].filter(visible).filter(node=>node.closest('flow-add-menu-popover-content')===root).filter(node=>{const titles=[...node.querySelectorAll('.asset-title')];return titles.length===1&&text(titles[0])===arg.name;});
  if(values.length>1)error('AGENT_ASSET_AMBIGUOUS','Имя исходника Agent повторяется.');if(!values.length)return null;
  const types=[...values[0].querySelectorAll('.type-subtitle')];if(types.length!==1||text(types[0])!==(arg.kind==='video'?'Video':'Image'))error('AGENT_INPUTS_NOT_VERIFIED','Тип исходника Agent не совпал с выбранным файлом.');return values[0];
 };
 const referenceTurn=(users,agents)=>{
  if(typeof arg.referenceContext!=='string'||!arg.referenceContext)error('AGENT_SESSION_CHANGED','Не сохранена управляющая инструкция текущего запроса.');
  if(!users.length||!agents.length)error('AGENT_PROPOSAL_NOT_READY','Agent ещё готовит ответ на управляющую инструкцию.');
  const user=users[0],agent=agents[0],list=user.parentElement,prompts=owned('flow-structured-prompt-text .prompt-text',user),attached=inputs(user);
  if(!list||agent.parentElement!==list||[...list.children].indexOf(user)>[...list.children].indexOf(agent)||prompts.length!==1||prompts[0].textContent!==arg.referenceContext||attached.source||attached.ingredients.length)error('AGENT_SESSION_CHANGED','Первое сообщение не совпало с собственной управляющей инструкцией без вложений.');
  const content=owned('.agent-message-content',agent);if(!content.length)error('AGENT_PROPOSAL_NOT_READY','Agent ещё готовит ответ на управляющую инструкцию.');
  if(content.length!==1||owned('flow-permission-message,flow-a2ui-video-option',agent).length)error('AGENT_SESSION_CHANGED','Agent запросил генерацию до основного сообщения. Подтверждения нет.');
  if(owned('flow-chat-thinking-indicator',agent).length||owned('flow-chat-message-action-bar',agent).length!==1)error('AGENT_PROPOSAL_NOT_READY','Ответ на управляющую инструкцию ещё не завершён.');
  return {user,agent,list};
 };
 const proposal=(output=false)=>{
  const users=owned('.message-row.user-row'),agents=owned('.message-row.agent-row');
  const expected=arg.expected||arg.binding,prefixed=expected.referenceContext!==undefined,count=prefixed?2:1;
  if(prefixed){if(expected.referenceContext!==arg.referenceContext)error('AGENT_SESSION_CHANGED','Управляющая инструкция текущего запроса изменилась.');referenceTurn(users,agents);}
  if(users.length>count||agents.length>count)error('AGENT_PROPOSAL_CHANGED','В сессии помощника появились дополнительные сообщения.');
  if(users.length!==count||agents.length!==count)error('AGENT_PROPOSAL_NOT_READY','Не появилась единственная новая пара сообщения и предложения помощника.');
  const user=users[count-1],agent=agents[count-1],list=user.parentElement;
  if(!list||agent.parentElement!==list||[...list.children].indexOf(user)>[...list.children].indexOf(agent))error('AGENT_PROPOSAL_CHANGED','Предложение помощника не принадлежит отправленному сообщению.');
  if(prefixed&&(users[0].parentElement!==list||[...list.children].indexOf(agents[0])>[...list.children].indexOf(user)))error('AGENT_SESSION_CHANGED','Управляющая инструкция не предшествует собственному запросу.');
  const promptNode=one('flow-structured-prompt-text .prompt-text',user),prompt=promptNode.textContent;
  if(typeof prompt!=='string'||!prompt.trim()||promptNode.querySelectorAll('button,input,textarea,[role="button"]').length)error('AGENT_INPUTS_NOT_VERIFIED','Не удалось прочитать полный запрос помощника.');
  const message={prompt,...inputs(user)};verifyInputs(message,arg.expected||arg.binding);
  const contents=owned('.agent-message-content',agent);if(!contents.length)error('AGENT_PROPOSAL_NOT_READY','Помощник ещё готовит ответ.');if(contents.length!==1)error('AGENT_PROPOSAL_CHANGED','Ответ помощника выбран неоднозначно.');
  const content=contents[0],permissions=owned('flow-permission-message',content);if(!permissions.length)error('AGENT_PROPOSAL_NOT_READY','Помощник ещё не показал предложение подтверждения.');if(permissions.length!==1)error('AGENT_PROPOSAL_CHANGED','Предложение подтверждения помощника неоднозначно.');
  const permission=permissions[0],titles=owned('.title',permission);if(!titles.length)error('AGENT_PROPOSAL_NOT_READY','Помощник ещё не показал стоимость предложения.');if(titles.length!==1)error('AGENT_PROPOSAL_CHANGED','Стоимость предложения помощника неоднозначна.');const title=text(titles[0]);
  const amount=/^Would you like me to kick off this 1 video generation, costing ([1-9]\d{0,4}) credits\?$/.exec(title);
  if(!amount)error('AGENT_PROPOSAL_CHANGED','Помощник не подтвердил создание одного видео с точной стоимостью.');
  const quoteCredits=Number(amount[1]);
  if(!Number.isSafeInteger(expected.maxCredits)||quoteCredits!==expected.maxCredits)error('AGENT_PROPOSAL_CHANGED','Стоимость предложения помощника не совпала с проверенной стоимостью выбранного режима.');
  const groups=owned('[role="radiogroup"][aria-label="Permission options"]',permission);if(groups.length!==1)error('AGENT_PROPOSAL_CHANGED','Не удалось проверить собственное подтверждение предложения.');
  const radios=owned('[role="radio"]',groups[0]),approve=radios.filter(node=>node.getAttribute('aria-label')==='Approve');
  if(radios.length!==3||approve.length!==1||!radios.some(node=>node.getAttribute('aria-label')==='Reject')||!radios.some(node=>node.getAttribute('aria-label')==='Always approve in project'))error('AGENT_PROPOSAL_CHANGED','Варианты подтверждения Agent изменились.');
  if(output){if(approve[0].getAttribute('aria-checked')!=='true'||radios.some(node=>node.getAttribute('aria-disabled')!=='true')||radios.filter(node=>node.getAttribute('aria-checked')==='true').length!==1)error('AGENT_OUTPUT_NOT_READY','Agent ещё не подтвердил принятую отправку.');}
  else if(radios.some(node=>node.getAttribute('aria-checked')==='true')||radios.some(node=>node.getAttribute('aria-disabled')==='true'||node.disabled))error('AGENT_PROPOSAL_ALREADY_USED','Предложение уже подтверждено или недоступно. Повторного подтверждения нет.');
  if(!output&&owned('flow-a2ui-video-option',content).length)error('AGENT_PROPOSAL_ALREADY_USED','Предложение уже содержит результат. Повторного подтверждения нет.');
  const descriptions=owned('flow-a2ui-text flow-markdown-content .markdown-container',content);if((output?descriptions.length<1:descriptions.length!==1)||!text(descriptions[0])||text(descriptions[0]).length>4000)error('AGENT_PROPOSAL_NOT_READY','Описание предложения помощника ещё не подтверждено.');
  const value={projectURL,prompt:message.prompt,source:message.source,ingredients:message.ingredients,sourceImageResourceId:message.source.imageResourceId,ingredientImageResourceIds:message.ingredients.map(item=>item.imageResourceId),maxCredits:expected.maxCredits,permissionTitle:title,quoteCredits,description:text(descriptions[0]),messageOrdinal:count-1,...(prefixed?{referenceContext:arg.referenceContext}:{})};
  if(arg.binding&&JSON.stringify(value)!==JSON.stringify(arg.binding))error('AGENT_PROPOSAL_CHANGED','Предложение помощника изменилось перед подтверждением.');
  return {value,approve:approve[0],content};
 };
 if(op==='composer'){const value=composer();return {projectURL,prompt:value.prompt,source:value.source,ingredients:value.ingredients};}
 if(op==='open-picker'){
  if([...document.querySelectorAll('flow-add-menu-popover-content')].some(visible))error('AGENT_PICKER_NOT_VERIFIED','Уже открыт другой список исходников.');return click(one('button[aria-label="Add ingredients to the prompt box"]',composer().root));
 }
 if(op==='claim-picker'){
  const values=[...document.querySelectorAll('flow-add-menu-popover-content')].filter(visible);if(values.length===0)return false;if(values.length!==1||one('button[aria-label="Add ingredients to the prompt box"]',composer().root).getAttribute('aria-expanded')!=='true')error('AGENT_PICKER_NOT_VERIFIED','Список не принадлежит редактору Agent.');values[0].setAttribute('data-flow-studio-agent-picker',arg.nonce);return true;
 }
 if(op==='focus-search'){const values=[...picker().querySelectorAll('input[aria-label="Search assets"]')].filter(visible);if(values.length!==1)error('AGENT_PICKER_NOT_VERIFIED','Не найден собственный поиск исходников Agent.');values[0].focus();values[0].select();return document.activeElement===values[0];}
 if(op==='asset-exists')return Boolean(pickerOption());
 if(op==='select-asset'){
  const value=pickerOption();if(!value||typeof arg.expectedResourceId!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(arg.expectedResourceId))error('AGENT_INPUTS_NOT_VERIFIED','Исходник исчез из списка Agent.');
  const current=composer();panel.__flowStudioAgentSelection={nonce:arg.nonce,name:arg.name,kind:arg.kind,expectedResourceId:arg.expectedResourceId,sourceCount:current.source?1:0,imageCount:current.ingredients.length,addClicked:false};return click(value);
 }
 if(op==='add-selected-asset'){
  const root=picker(),option=pickerOption();if(!option||option.getAttribute('aria-selected')!=='true'||panel.__flowStudioAgentSelection?.nonce!==arg.nonce)return false;
  const details=[...root.querySelectorAll('flow-add-menu-detail-pane')];if(details.length!==1)error('AGENT_PICKER_NOT_VERIFIED','Не удалось проверить выбранный исходник Agent.');const buttons=[...details[0].querySelectorAll('button.detail-add-to-prompt-btn')].filter(visible);if(!buttons.length)return false;if(buttons.length!==1||text(buttons[0])!=='Add to prompt')error('AGENT_PICKER_NOT_VERIFIED','Кнопка добавления исходника неоднозначна.');panel.__flowStudioAgentSelection.addClicked=true;return click(buttons[0]);
 }
 if(op==='claim-attached'){
  const selection=panel.__flowStudioAgentSelection;if(selection?.nonce!==arg.nonce||selection.kind!==arg.kind||selection.expectedResourceId!==arg.expectedResourceId)error('AGENT_INPUTS_NOT_VERIFIED','Не сохранён точный выбор исходника Agent.');
  const current=composer(),videos=owned('flow-video-ingredient-chip',current.root),images=owned('flow-image-ingredient-chip',current.root),video=arg.kind==='video';
  if(videos.length!==selection.sourceCount+(video?1:0)||images.length!==selection.imageCount+(video?0:1))return false;
  const chip=video?videos[0]:images.at(-1),value=video?current.source:current.ingredients.at(-1);
  if(value.imageResourceId&&value.imageResourceId!==arg.expectedResourceId)error('AGENT_INPUTS_CHANGED','Прикреплённый ресурс Agent не совпал с выбранным.');
  if(!value.imageResourceId){const buttons=owned('button',chip),placeholders=owned('.chip-placeholder',chip);if(buttons.length!==1||buttons[0].getAttribute('aria-busy')!=='false'||placeholders.length!==1)return false;}
  if(!panel.__flowStudioAgentClaims)panel.__flowStudioAgentClaims=new WeakMap();const claim={nonce:arg.nonce,kind:arg.kind,name:selection.name,expectedResourceId:arg.expectedResourceId};panel.__flowStudioAgentClaims.set(chip,claim);chip.setAttribute('data-flow-studio-agent-selection',arg.nonce);return true;
 }
 if(op==='clear-owned-attachments'){
  const current=composer(),chips=owned('flow-video-ingredient-chip,flow-image-ingredient-chip',current.root),allowed=new Set(arg.nonces||[]);
  if(!same(current.prompt,arg.prompt||'')||!chips.length||chips.some(chip=>!allowed.has(panel.__flowStudioAgentClaims?.get(chip)?.nonce)))return false;
  for(const chip of chips){const buttons=owned('button',chip);if(buttons.length!==1)error('AGENT_INPUTS_NOT_VERIFIED','Кнопка удаления собственного исходника Agent неоднозначна.');click(buttons[0]);}return true;
 }
 if(op==='release-picker'){
  const values=[...document.querySelectorAll('flow-add-menu-popover-content')].filter(node=>node.getAttribute('data-flow-studio-agent-picker')===arg.nonce);for(const value of values)value.removeAttribute('data-flow-studio-agent-picker');
  const button=one('button[aria-label="Add ingredients to the prompt box"]',composer().root);if(values.some(visible)&&button.getAttribute('aria-expanded')==='true')click(button);return true;
 }
 if(op==='open-settings'){return click(one('flow-creative-agent-prompt-box .agent-footer-actions button[aria-label="Settings"]'));}
 if(op==='settings-open')return owned('flow-settings-view').length===1&&text(one('.agent-panel-header .header-title'))==='Agent settings';
 if(op==='settings')return settings().value;
 if(op==='set-settings'){
  const current=settings();if(!['9:16','16:9'].includes(arg.aspect))error('AGENT_SETTINGS_NOT_VERIFIED','Неизвестный формат видео Agent.');
  const always=current.choices.find(value=>value.label==='Always');if(!always.input.checked)always.input.click();
  for(const [groupName,name]of [['aspect ratio',arg.aspect],['output count','x1']]){const matches=current.radios(groupName).filter(value=>value.name===name);if(matches.length!==1)error('AGENT_SETTINGS_NOT_VERIFIED','Нужный параметр Agent отсутствует.');if(!matches[0].checked)click(matches[0].node);}
  return true;
 }
 if(op==='open-video-model')return click(settings().model);
 if(op==='choose-video-model'){
  const control=settings().model,id=control.getAttribute('aria-controls'),menus=typeof id==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(id)?[...document.querySelectorAll('[id]')].filter(node=>node.getAttribute('id')===id&&node.getAttribute('role')==='menu'&&visible(node)):[];
  if(menus.length!==1)error('AGENT_SETTINGS_NOT_VERIFIED','Меню модели Agent не принадлежит настройке видео.');
  const values=[...menus[0].querySelectorAll('[role="menuitem"],[role="option"]')].filter(visible).filter(node=>text(node)==='Omni 1.2 Flash');if(values.length!==1)error('AGENT_SETTINGS_NOT_VERIFIED','Omni 1.2 Flash не найдена в собственном меню Agent.');return click(values[0]);
 }
 if(op==='save-settings')return click(one('button.settings-save-button',settings().root));
 if(op==='back-settings')return click(one('.agent-panel-header button[aria-label="Back"]'));
 if(op==='start-session'){
  const value=composer();if(value.prompt.trim()||value.source||value.ingredients.length)error('BROWSER_DRAFT_PRESENT','В помощнике есть чужой черновик. Он сохранён.');
  const button=one('.agent-panel-header button[aria-label="Start new session"]');if(button.disabled||button.getAttribute('aria-disabled')==='true')error('AGENT_CONTROL_DISABLED','Новая сессия помощника недоступна.');button.click();return true;
 }
 if(op==='session-empty')return owned('.message-row.user-row,.message-row.agent-row').length===0;
 if(op==='reference-context-ready'){
  const users=owned('.message-row.user-row'),agents=owned('.message-row.agent-row');if(users.length>1||agents.length>1)error('AGENT_SESSION_CHANGED','В управляющей сессии появились лишние сообщения.');referenceTurn(users,agents);return {projectURL,referenceContext:arg.referenceContext};
 }
 if(op==='focus-prompt'){const value=composer();value.editor.focus();const range=document.createRange();range.selectNodeContents(value.editor);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return document.activeElement===value.editor;}
 if(op==='send-box'){
  const value=composer();verifyInputs(value,arg.expected);
  if(arg.expected.referenceContext!==undefined){const users=owned('.message-row.user-row'),agents=owned('.message-row.agent-row');if(arg.expected.referenceContext!==arg.referenceContext||users.length!==1||agents.length!==1)error('AGENT_SESSION_CHANGED','Управляющая сессия изменилась до основного сообщения.');referenceTurn(users,agents);}
  else if(owned('.message-row.user-row,.message-row.agent-row').length)error('AGENT_SESSION_CHANGED','В сессии помощника уже есть сообщения. Повторной отправки нет.');return point(one('button[aria-label="Start generation"]',value.root));
 }
 if(op==='reference-send-box'){const value=composer();if(value.prompt!==arg.referenceContext||value.source||value.ingredients.length||owned('.message-row.user-row,.message-row.agent-row').length)error('AGENT_SESSION_CHANGED','Управляющее сообщение не совпало с пустой собственной сессией.');return point(one('button[aria-label="Start generation"]',value.root));}
 if(op==='proposal')return proposal().value;
 if(op==='approve-box')return point(proposal().approve);
 if(op==='result'){
  const current=proposal(true),content=current.content,errors=owned('flow-error-tile',content),options=owned('flow-a2ui-video-option',content);
  if(errors.length){if(errors.length!==1||options.length>1)error('AGENT_PROPOSAL_CHANGED','Результат Agent неоднозначен.');const titles=owned('.error-title',errors[0]),messages=owned('.error-message-text',errors[0]);if(titles.length!==1||messages.length!==1||!text(titles[0])||!text(messages[0]))error('AGENT_PROPOSAL_CHANGED','Сообщение ошибки Agent не подтверждено.');return {failure:(text(titles[0])+'\n'+text(messages[0])).slice(0,1200)};}
  if(options.length>1)error('AGENT_PROPOSAL_CHANGED','Agent создал больше одного результата.');if(!options.length)return false;
  const controls=owned('[role="button"][aria-label="Open video in editor"]',options[0]);if(!controls.length)return false;if(controls.length!==1)error('AGENT_PROPOSAL_CHANGED','Не удалось подтвердить открытие собственного результата Agent.');
  const images=owned('img.video-thumbnail',controls[0]);if(!images.length)return false;if(images.length!==1)error('AGENT_PROPOSAL_CHANGED','Poster результата Agent выбран неоднозначно.');
  if(!images[0].complete||images[0].naturalWidth<=0||!resource(images[0].getAttribute('src')))return false;
  if(images[0].getAttribute('alt')!==arg.binding.prompt)error('AGENT_PROPOSAL_CHANGED','Запрос результата Agent изменился.');
  const poster=resource(images[0].getAttribute('src'));return {poster:poster.origin+poster.path,imageResourceId:poster.imageResourceId,...(arg.open?{openPoint:point(controls[0])}:{})};
 }
 error('INVALID_OPERATION','Неизвестная операция редактирования через помощника.');
}

async function runAgent(page,op,arg={}){
 page.signal?.throwIfAborted();
 if(['reference-send-box','reference-context-ready'].includes(op)||arg.expected?.referenceContext!==undefined||arg.binding?.referenceContext!==undefined)arg={...arg,referenceContext:AGENT_REFERENCE_CONTEXT};
 const result=await page.client.send('Runtime.evaluate',{expression:'('+agentEditDOM.toString()+')('+JSON.stringify(op)+','+JSON.stringify(arg)+')',returnByValue:true,awaitPromise:true,userGesture:true});
 if(result.exceptionDetails){const description=result.exceptionDetails.exception?.description||'',match=description.match(/(?:Error: )?([A-Z][A-Z0-9_]+): ([^\n]+)/);throw fail(match?.[1]||'BROWSER_UI_ERROR',match?.[2]||'Не удалось прочитать помощника Flow.');}return result.result?.value;
}
async function readAgentProposal(page,expected){return runAgent(page,'proposal',{expected});}
async function verifyAgentProposal(page,binding){await runAgent(page,'proposal',{binding});return true;}
async function readAgentEditOutput(page,binding,{open=false}={}){
 try{const result=await runAgent(page,'result',{binding,open});if(result?.failure){const error=fail('FLOW_GENERATION_REJECTED','Flow отклонил редактирование через Agent: '+result.failure);error.generationTerminal=true;error.accountFailure=false;throw error;}return result;}catch(error){if(['AGENT_OUTPUT_NOT_READY','AGENT_PROPOSAL_NOT_READY','AGENT_INPUTS_NOT_READY'].includes(error.code))return false;throw error;}
}
async function observeAgentEditOutput(page,binding,{onProgress=()=>{}}={}){return page.until(async()=>{const result=await readAgentEditOutput(page,binding);if(!result)onProgress('Ожидаем результат подтверждённого предложения Agent. Повторной отправки нет…');return result;},30*60*1000,'agent-edit-result');}
async function openAgentEdit(page){await page.until(async()=>{if(await runAgent(page,'panel-ready'))return true;await runAgent(page,'enable');return false;},15000,'agent-panel');return true;}
async function startAgentSession(page){await openAgentEdit(page);await runAgent(page,'start-session');await page.until(async()=>{try{return await runAgent(page,'session-empty');}catch(error){if(error.code==='AGENT_PANEL_NOT_VERIFIED')return false;throw error;}},10000,'agent-session-empty');referenceContexts.delete(page);return true;}
async function agentSettings(page,plan,configure){
 if(plan?.method!=='edit'||!['9:16','16:9'].includes(plan.aspect))throw fail('AGENT_SETTINGS_NOT_VERIFIED','Нужны точные параметры режима Edit.');
 await runAgent(page,'open-settings');let saved=false,originalError;
 try{
  await page.until(()=>runAgent(page,'settings-open'),10000,'agent-settings');
  if(configure){await runAgent(page,'set-settings',{aspect:plan.aspect});const value=await runAgent(page,'settings');if(value.model!=='Omni 1.2 Flash'){await runAgent(page,'open-video-model');await runAgent(page,'choose-video-model');}}
  const value=await runAgent(page,'settings');if(value.confirm!=='Always'||value.aspect!==plan.aspect||value.count!=='x1'||value.model!=='Omni 1.2 Flash')throw fail('AGENT_SETTINGS_NOT_VERIFIED','Agent не подтвердил Always, Omni 1.2 Flash, x1 и выбранный формат.');
  if(configure){await runAgent(page,'save-settings');saved=true;}return value;
 }catch(error){originalError=error;throw error;}
 finally{if(!page.signal?.aborted)try{if(!saved)await runAgent(page,'back-settings');await page.until(async()=>!await runAgent(page,'settings-open'),10000,'agent-settings-closed');}catch(error){if(!originalError)throw error;}}
}
async function configureAgentEdit(page,plan){return agentSettings(page,plan,true);}
async function verifyAgentEditSettings(page,plan){return agentSettings(page,plan,false);}
async function attachAgentAsset(page,{name,kind,expectedResourceId,previous}={}){
 if(typeof name!=='string'||!name.trim()||name.length>256||/[\r\n\0]/.test(name)||!['video','image'].includes(kind)||typeof expectedResourceId!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(expectedResourceId)||!previous||!Array.isArray(previous.ingredientImageResourceIds))throw fail('AGENT_INPUTS_NOT_VERIFIED','Нужны точный исходник Agent и предыдущий набор вложений.');
 const signature=value=>({sourceImageResourceId:inputId(value.source),ingredientImageResourceIds:value.ingredients.map(inputId)}),prior={sourceImageResourceId:previous.sourceImageResourceId||null,ingredientImageResourceIds:previous.ingredientImageResourceIds};
 const before=await runAgent(page,'composer');if(before.prompt.trim()||JSON.stringify(signature(before))!==JSON.stringify(prior))throw fail('BROWSER_DRAFT_PRESENT','Исходники или текст Agent изменились до прикрепления файла.');
 if(kind==='video'&&prior.sourceImageResourceId||kind==='image'&&prior.ingredientImageResourceIds.length>=5)throw fail('AGENT_INPUTS_NOT_VERIFIED','Лимит исходников Agent достигнут.');
 const target={sourceImageResourceId:kind==='video'?expectedResourceId:prior.sourceImageResourceId,ingredientImageResourceIds:kind==='image'?[...prior.ingredientImageResourceIds,expectedResourceId]:prior.ingredientImageResourceIds},nonce=randomUUID();let opened=false,added=false;
 const args={nonce,name,kind,expectedResourceId};
 try{
  await runAgent(page,'open-picker');opened=true;await page.until(()=>runAgent(page,'claim-picker',{nonce}),10000,'agent-asset-picker');
  if(!await runAgent(page,'focus-search',args))throw fail('PROMPT_FOCUS_FAILED','Не удалось выбрать поиск исходников Agent.');await page.client.send('Input.insertText',{text:name});
  await page.until(()=>runAgent(page,'asset-exists',args),15000,'agent-exact-asset');await runAgent(page,'select-asset',args);
  return await page.until(async()=>{
   await runAgent(page,'claim-attached',args);const current=await runAgent(page,'composer'),value=signature(current);if(current.prompt.trim())throw fail('AGENT_INPUTS_CHANGED','В Agent появился чужой текст при выборе исходника.');
   if(JSON.stringify(value)===JSON.stringify(target))return current;
   const pendingNew=kind==='video'&&current.source?.pending&&!current.source.selectionClaim&&current.ingredients.length===prior.ingredientImageResourceIds.length||kind==='image'&&current.ingredients.length===prior.ingredientImageResourceIds.length+1&&current.ingredients.at(-1)?.pending&&!current.ingredients.at(-1).selectionClaim;
   if(pendingNew)return false;
   if(JSON.stringify(value)!==JSON.stringify(prior))throw fail('AGENT_INPUTS_CHANGED','Прикреплённый исходник Agent не совпал с выбранным.');
   if(!added)added=await runAgent(page,'add-selected-asset',args);return false;
  },20000,'agent-asset-attached');
 }finally{if(opened&&!page.signal?.aborted)await runAgent(page,'release-picker',{nonce}).catch(()=>{});}
}
async function clearOwnedAgentAttachments(page,{nonces,prompt=''}={}){
 if(!Array.isArray(nonces)||!nonces.length||nonces.some(value=>typeof value!=='string'||!/^[a-f0-9-]{36}$/i.test(value)))return false;
 if(!await runAgent(page,'clear-owned-attachments',{nonces,prompt}))return false;
 await page.until(async()=>{const current=await runAgent(page,'composer');return !current.source&&current.ingredients.length===0;},10000,'agent-owned-attachments-cleared');return true;
}
async function trustedAgentPress(page,op,arg,onDispatch){
 await page.client.send('Page.setWebLifecycleState',{state:'active'});await page.client.send('Emulation.setFocusEmulationEnabled',{enabled:true});let position;
 await page.until(async()=>{const before=await runAgent(page,op,arg);await page.client.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'none',buttons:0,modifiers:0,clickCount:0,x:before.x,y:before.y});await wait(50,undefined,{signal:page.signal});const after=await runAgent(page,op,arg);if(!['x','y','left','top','width','height'].every(key=>Number.isFinite(after[key])&&after[key]===before[key]))return false;position={x:after.x,y:after.y};return true;},10000,'agent-control-stable');
 page.signal?.throwIfAborted();onDispatch?.();await page.client.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,force:0.5,modifiers:0,clickCount:1,...position});await page.client.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,modifiers:0,clickCount:1,...position});
}
async function prepareAgentReferenceContext(page,{verifySettings}={}){
 if(typeof verifySettings!=='function')throw fail('AGENT_SETTINGS_NOT_VERIFIED','Перед управляющим сообщением нужны проверенные настройки Agent.');
 if(referenceContexts.has(page))throw fail('AGENT_SESSION_CHANGED','Управляющее сообщение уже отправлялось. Повторной отправки нет.');
 await verifySettings();const composer=await runAgent(page,'composer');if(composer.prompt.trim()||composer.source||composer.ingredients.length||!await runAgent(page,'session-empty'))throw fail('BROWSER_DRAFT_PRESENT','Для управляющего сообщения нужна новая пустая сессия без вложений.');
 referenceContexts.set(page,{status:'pending',projectURL:composer.projectURL});
 if(!await runAgent(page,'focus-prompt'))throw fail('PROMPT_FOCUS_FAILED','Не удалось выбрать поле управляющего сообщения.');await page.client.send('Input.insertText',{text:AGENT_REFERENCE_CONTEXT});
 await verifySettings();await trustedAgentPress(page,'reference-send-box',{});
 const context=await page.until(async()=>{try{return await runAgent(page,'reference-context-ready');}catch(error){if(['AGENT_PROPOSAL_NOT_READY','AGENT_PANEL_NOT_VERIFIED'].includes(error.code))return false;throw error;}},120000,'agent-reference-context');
 referenceContexts.set(page,{status:'ready',projectURL:context.projectURL});return {referenceContext:AGENT_REFERENCE_CONTEXT,submitted:false};
}
async function prepareAgentProposal(page,expected,{verifySettings}={}){
 if(typeof verifySettings!=='function')throw fail('AGENT_SETTINGS_NOT_VERIFIED','Перед отправкой сообщения нужны проверенные настройки помощника.');
 const referenceContext=referenceContexts.get(page);if(referenceContext){if(referenceContext.status!=='ready'||referenceContext.projectURL!==expected.projectURL)throw fail('AGENT_SESSION_CHANGED','Управляющая сессия ещё не проверена.');expected={...expected,referenceContext:AGENT_REFERENCE_CONTEXT};}else if(expected.referenceContext!==undefined)throw fail('AGENT_SESSION_CHANGED','Управляющая сессия не принадлежит этому браузеру.');
 await verifySettings();const composer=await runAgent(page,'composer');if(composer.prompt.trim())throw fail('BROWSER_DRAFT_PRESENT','В помощнике есть чужой текст. Он сохранён.');
 if(inputId(composer.source)!==expected.sourceImageResourceId||JSON.stringify(composer.ingredients.map(inputId))!==JSON.stringify(expected.ingredientImageResourceIds))throw fail('AGENT_INPUTS_CHANGED','Исходники помощника не совпали с подготовленными. Текст не изменён.');
 if(referenceContext)await runAgent(page,'reference-context-ready');else if(!await runAgent(page,'session-empty'))throw fail('AGENT_SESSION_CHANGED','Перед отправкой нужна новая пустая сессия помощника.');
 if(!await runAgent(page,'focus-prompt'))throw fail('PROMPT_FOCUS_FAILED','Не удалось выбрать поле сообщения помощника.');await page.client.send('Input.insertText',{text:expected.prompt});
 await verifySettings();await trustedAgentPress(page,'send-box',{expected});
 const binding=await page.until(async()=>{try{return await readAgentProposal(page,expected);}catch(error){if(['AGENT_PROPOSAL_NOT_READY','AGENT_INPUTS_NOT_READY'].includes(error.code))return false;throw error;}},120000,'agent-edit-proposal');
 Object.freeze(binding.source);binding.ingredients.forEach(Object.freeze);Object.freeze(binding.ingredients);Object.freeze(binding.ingredientImageResourceIds);Object.freeze(binding);issued.set(binding,page);return binding;
}
async function approveAgentEdit(page,binding,{beforeSubmit,verifySettings}={}){
 if(issued.get(binding)!==page||used.has(binding)||typeof beforeSubmit!=='function'||typeof verifySettings!=='function')throw fail('AGENT_PREPARATION_REQUIRED','Нужно неиспользованное предложение и проверенные настройки помощника.');used.add(binding);let dispatched=false;
 try{await verifySettings();await verifyAgentProposal(page,binding);await beforeSubmit();page.signal?.throwIfAborted();await verifySettings();await verifyAgentProposal(page,binding);await trustedAgentPress(page,'approve-box',{binding},()=>{dispatched=true;});return {clicked:true};}
 catch(error){error.unknownOutcome=dispatched;throw error;}
}
module.exports={AGENT_REFERENCE_CONTEXT,agentEditDOM,runAgent,openAgentEdit,startAgentSession,configureAgentEdit,verifyAgentEditSettings,attachAgentAsset,clearOwnedAgentAttachments,prepareAgentReferenceContext,readAgentProposal,verifyAgentProposal,prepareAgentProposal,approveAgentEdit,readAgentEditOutput,observeAgentEditOutput};
