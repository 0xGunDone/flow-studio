'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {AGENT_REFERENCE_CONTEXT,agentEditDOM,prepareAgentReferenceContext,prepareAgentProposal,approveAgentEdit,configureAgentEdit,verifyAgentEditSettings,attachAgentAsset,clearOwnedAgentAttachments,readAgentEditOutput,startAgentSession}=require('./browser-agent-edit.cjs');
const PROJECT='https://flow.google.com/project/5927b3e9-314b-432f-af56-b76efcd20c51';
const SOURCE='1091dac2-e2e4-4039-b234-2e90198017a0',IMAGE1='236b633c-ea4b-4daa-875c-eaef6681476d',IMAGE2='fac397f2-7781-4fd2-aeff-5c730b55a624';
const PROMPT='Keep the blue star character and motion.\nMake the background dark violet. No text.';
const expected=()=>({projectURL:PROJECT,prompt:PROMPT,sourceImageResourceId:SOURCE,ingredientImageResourceIds:[IMAGE1,IMAGE2],maxCredits:36});
function fixture(options={}){
 let panel,hit,selection=0;const actions=[],commands=[],state={messages:options.messages!==false,prompt:options.userPrompt||PROMPT,source:options.source||SOURCE,images:options.images||[IMAGE1,IMAGE2],composerInputs:true,quote:options.quote||36,selected:options.selected||false,disabled:options.disabled||false,description:'Preserve the source character and apply a violet background.',composerPrompt:'',userCount:1,agentCount:1,output:options.hasOutput||false,outputLoaded:true,outputId:IMAGE2,permissionReady:true,prefixSent:false,finalSent:true,prefixPrompt:AGENT_REFERENCE_CONTEXT,prefixPermission:false};
 const element=(tag,attrs={},extra={})=>Object.defineProperties({tagName:tag.toUpperCase(),getAttribute:key=>attrs[key]??null,getClientRects:()=>[1],closest:selector=>selector==='flow-agent-panel'?panel:null,querySelectorAll:()=>[],scrollIntoView(){},getBoundingClientRect(){hit=this;return {left:100,top:100,width:100,height:40};},contains:value=>value===hit},Object.getOwnPropertyDescriptors(extra));
 const chips=(video,id)=>{const chip=element(video?'flow-video-ingredient-chip':'flow-image-ingredient-chip'),image=element('img',{}, {getAttribute:key=>key==='src'?'https://storage.googleapis.com/ai-sandbox-videofx/image/'+id+'?signature=never-log':null,closest:selector=>selector==='flow-agent-panel'?panel:selector==='flow-video-ingredient-chip,flow-image-ingredient-chip'?chip:null});chip.querySelectorAll=selector=>selector.startsWith('img[')&&!(video&&options.userPending)?[image]:[];return chip;};
 const inputRow=()=>element('flow-chat-ingredient-row',{}, {querySelectorAll:selector=>selector==='flow-video-ingredient-chip,flow-image-ingredient-chip'?[chips(true,state.source),...state.images.map(id=>chips(false,id))]:[]});
 const user=element('div'),agent=element('div'),contextUser=element('div'),contextAgent=element('div'),list={children:[user,agent]};for(const row of [user,agent,contextUser,contextAgent])row.parentElement=list;
 const contextPrompt=element('span',{}, {get textContent(){return state.prefixPrompt;}}),contextContent=element('div'),contextDone=element('flow-chat-message-action-bar');
 contextUser.querySelectorAll=selector=>selector==='flow-structured-prompt-text .prompt-text'?[contextPrompt]:[];
 contextAgent.querySelectorAll=selector=>selector==='.agent-message-content'?[contextContent]:selector==='flow-chat-message-action-bar'?[contextDone]:selector==='flow-permission-message,flow-a2ui-video-option'&&state.prefixPermission?[contextDone]:[];
 const userPrompt=element('span',{}, {get textContent(){return state.prompt;}});
 user.querySelectorAll=selector=>selector==='flow-structured-prompt-text .prompt-text'?[userPrompt]:selector==='flow-chat-ingredient-row'?[inputRow()]:[];
 const permission=element('flow-permission-message'),group=element('div'),title=element('p',{}, {get textContent(){return 'Would you like me to kick off this 1 video generation, costing '+state.quote+' credits?';}});
 const radio=label=>element('div',{}, {getAttribute:key=>key==='aria-label'?label:key==='aria-disabled'?String(state.disabled):key==='aria-checked'?String(state.selected&&label==='Approve'):null});const approve=radio('Approve'),always=radio('Always approve in project'),reject=radio('Reject');group.querySelectorAll=selector=>selector==='[role="radio"]'?[approve,always,reject]:[];
 permission.querySelectorAll=selector=>selector==='.title'?[title]:selector==='[role="radiogroup"][aria-label="Permission options"]'?[group]:[];
 const description=element('div',{}, {get textContent(){return state.description;}}),content=element('div');
 const outputImage=element('img',{}, {get complete(){return state.outputLoaded;},naturalWidth:720,getAttribute:key=>key==='src'?'https://storage.googleapis.com/ai-sandbox-videofx/image/'+state.outputId+'?signature=output':key==='alt'?state.outputPrompt||state.prompt:null});
 const outputButton=element('div',{}, {querySelectorAll:selector=>selector==='img.video-thumbnail'?state.outputImageMissing?[]:Array(state.outputImageCount||1).fill(outputImage):[]}),outputOption=element('flow-a2ui-video-option',{}, {querySelectorAll:selector=>selector==='[role="button"][aria-label="Open video in editor"]'?state.outputControlMissing?[]:[outputButton]:[]});
 content.querySelectorAll=selector=>selector==='flow-permission-message'?state.permissionReady?[permission]:[]:selector==='flow-a2ui-text flow-markdown-content .markdown-container'?[description]:selector==='flow-a2ui-video-option'&&state.output?Array(state.outputCount||1).fill(outputOption):[];agent.querySelectorAll=selector=>selector==='.agent-message-content'?[content]:[];
 const editor=element('div',{}, {get innerText(){return state.composerPrompt;},focus(){document.activeElement=editor;}}),send=element('button',{'aria-label':'Start generation'}),composer=element('div');
 composer.querySelectorAll=selector=>selector==='flow-creative-agent-prompt-box flow-rich-text-editor [role="textbox"]'?[editor]:selector==='flow-chat-ingredient-row'&&state.composerInputs?[inputRow()]:selector==='button[aria-label="Start generation"]'?[send]:[];
 const newSession=element('button',{}, {click(){actions.push('new-session');state.messages=false;}});
 const rows=kind=>!state.messages?[]:state.prefixSent?[kind==='user'?contextUser:contextAgent,...(state.finalSent?[kind==='user'?user:agent]:[])]:Array(kind==='user'?state.userCount:state.agentCount).fill(kind==='user'?user:agent);
 panel=element('flow-agent-panel',{}, {querySelectorAll:selector=>selector==='.message-row.user-row'?rows('user'):selector==='.message-row.agent-row'?rows('agent'):selector==='.message-row.user-row,.message-row.agent-row'?state.messages?state.prefixSent?state.finalSent?[contextUser,contextAgent,user,agent]:[contextUser,contextAgent]:[user,agent]:[]:selector==='flow-agent-panel-prompt-box, .agent-panel-prompt-box'?[composer]:selector==='.agent-panel-header button[aria-label="Start new session"]'?[newSession]:[]});
 const document={activeElement:null,querySelectorAll:selector=>selector==='flow-agent-panel'?[panel]:[],createRange:()=>({selectNodeContents(){}}),elementFromPoint:()=>hit};
 const context={location:{origin:'https://flow.google.com',href:PROJECT},URL,getComputedStyle:()=>({visibility:'visible'}),document,getSelection:()=>({removeAllRanges(){selection++;},addRange(){}})};
 const run=(op,arg={})=>vm.runInNewContext('('+agentEditDOM.toString()+')('+JSON.stringify(op)+','+JSON.stringify(arg)+')',context);
 const page={signal:undefined,until:async fn=>{for(let i=0;i<4;i++){const result=await fn();if(result)return result;}throw Object.assign(Error('timeout'),{code:'FLOW_UI_TIMEOUT'});},client:{send:async(method,params={})=>{
  commands.push({method,params});if(method==='Runtime.evaluate'){try{return {result:{value:vm.runInNewContext(params.expression,context)}};}catch(error){return {exceptionDetails:{exception:{description:error.message}}};}}
  if(method==='Input.insertText'){state.composerPrompt=params.text;return {};}
  if(method==='Input.dispatchMouseEvent'&&params.type==='mousePressed'){if(hit===send){actions.push('message');state.messages=true;if(state.composerPrompt===AGENT_REFERENCE_CONTEXT){state.prefixSent=true;state.finalSent=false;list.children=[contextUser,contextAgent];}else{state.prompt=state.composerPrompt;state.finalSent=true;if(state.prefixSent)list.children=[contextUser,contextAgent,user,agent];}state.composerPrompt='';}else if(hit===approve){actions.push('approve');state.selected=true;state.disabled=true;}else assert.fail('Foreign paid target');}
  assert.ok(['Input.dispatchMouseEvent','Page.setWebLifecycleState','Emulation.setFocusEmulationEnabled'].includes(method));return {};
 }}};
 return {run,page,state,actions,commands,context};
}

test('Agent proposal binds its own exact message, ordered image resources, one video and exact credit quote',()=>{
 const h=fixture(),value=h.run('proposal',{expected:expected()});assert.equal(value.prompt,PROMPT);assert.equal(value.source.imageResourceId,SOURCE);assert.deepEqual(Array.from(value.ingredientImageResourceIds),[IMAGE1,IMAGE2]);assert.equal(value.quoteCredits,36);assert.equal(value.messageOrdinal,0);assert.equal(JSON.stringify(value).includes('never-log'),false);assert.deepEqual(h.actions,[]);
});
test('Agent proposal rejects historical approval, foreign input, prompt drift, duplicates and excess quote',()=>{
 for(const patch of [{selected:true,disabled:true},{source:IMAGE1},{images:[IMAGE2,IMAGE1]},{userPrompt:PROMPT+' changed'},{quote:35},{quote:37},{hasOutput:true}])assert.throws(()=>fixture(patch).run('proposal',{expected:expected()}),/AGENT_/);
 for(const kind of ['userCount','agentCount']){const h=fixture();h.state[kind]=2;assert.throws(()=>h.run('proposal',{expected:expected()}),/AGENT_PROPOSAL_CHANGED/);}
});
test('Agent proposal reports unresolved server source as loading and never approves before canonical identity',()=>{
 const h=fixture({userPending:true});assert.throws(()=>h.run('proposal',{expected:expected()}),/AGENT_INPUTS_NOT_READY/);assert.deepEqual(h.actions,[]);
});
test('Agent proposal waits through its thinking response without a permission message and never sends twice',async()=>{
 const h=fixture({messages:false}),send=h.page.client.send;let thinkingRead=false;
 h.page.client.send=async(method,args)=>{if(method==='Runtime.evaluate'&&args.expression.endsWith('("proposal",'+JSON.stringify({expected:expected()})+')')){if(!thinkingRead){h.state.permissionReady=false;thinkingRead=true;}else h.state.permissionReady=true;}return send(method,args);};
 const binding=await prepareAgentProposal(h.page,expected(),{verifySettings:async()=>{}});assert.equal(binding.quoteCredits,36);assert.equal(thinkingRead,true);assert.deepEqual(h.actions,['message']);
});
test('Agent prepares exact message once and approves once after durable callback and fresh verification',async()=>{
 const h=fixture({messages:false});let verified=0,durable=false;const verifySettings=async()=>{verified++;};
 const binding=await prepareAgentProposal(h.page,expected(),{verifySettings});assert.equal(Object.isFrozen(binding),true);assert.deepEqual(h.actions,['message']);assert.equal(h.state.prompt,PROMPT);
 await approveAgentEdit(h.page,binding,{verifySettings,beforeSubmit:async()=>{assert.deepEqual(h.actions,['message']);durable=true;}});assert.equal(durable,true);assert.deepEqual(h.actions,['message','approve']);assert.ok(verified>=4);
 await assert.rejects(approveAgentEdit(h.page,binding,{verifySettings,beforeSubmit:async()=>{}}),{code:'AGENT_PREPARATION_REQUIRED'});assert.deepEqual(h.actions,['message','approve']);
});
test('Agent reference context sends one attachment-free planning turn then binds only the exact final prompt and ordered references',async()=>{
 const h=fixture({messages:false}),verifySettings=async()=>{};h.state.composerInputs=false;
 const prefix=await prepareAgentReferenceContext(h.page,{verifySettings});assert.equal(prefix.referenceContext,AGENT_REFERENCE_CONTEXT);assert.equal(prefix.submitted,false);assert.deepEqual(h.actions,['message']);
 await assert.rejects(prepareAgentReferenceContext(h.page,{verifySettings}),{code:'AGENT_SESSION_CHANGED'});assert.deepEqual(h.actions,['message']);
 h.state.composerInputs=true;const binding=await prepareAgentProposal(h.page,expected(),{verifySettings});assert.equal(binding.prompt,PROMPT);assert.equal(binding.referenceContext,AGENT_REFERENCE_CONTEXT);assert.equal(binding.messageOrdinal,1);assert.deepEqual(h.actions,['message','message']);assert.equal(h.state.prefixPrompt,AGENT_REFERENCE_CONTEXT);assert.equal(h.state.prompt,PROMPT);
 await approveAgentEdit(h.page,binding,{verifySettings,beforeSubmit:async()=>{assert.deepEqual(h.actions,['message','message']);}});assert.deepEqual(h.actions,['message','message','approve']);h.state.output=true;assert.equal((await readAgentEditOutput(h.page,binding)).imageResourceId,IMAGE2);assert.deepEqual(h.actions,['message','message','approve']);
});
test('Agent reference context rejects foreign first turn or premature generation permission and cannot be replayed',async()=>{
 for(const field of ['prefixPrompt','prefixPermission']){const h=fixture({messages:false}),verifySettings=async()=>{};h.state.composerInputs=false;
  await prepareAgentReferenceContext(h.page,{verifySettings});if(field==='prefixPrompt')h.state.prefixPrompt='Foreign instructions';else h.state.prefixPermission=true;h.state.composerInputs=true;
  await assert.rejects(prepareAgentProposal(h.page,expected(),{verifySettings}),{code:'AGENT_SESSION_CHANGED'});assert.deepEqual(h.actions,['message']);
 }
 const foreign=fixture({messages:false});await assert.rejects(prepareAgentReferenceContext(foreign.page,{verifySettings:async()=>{}}),{code:'BROWSER_DRAFT_PRESENT'});assert.deepEqual(foreign.actions,[]);
});
test('Agent receipt failure or proposal drift after durable callback never presses approval or retries',async()=>{
 for(const changed of ['receipt','prompt','source','quote']){const h=fixture({messages:false}),verifySettings=async()=>{},binding=await prepareAgentProposal(h.page,expected(),{verifySettings});
  await assert.rejects(approveAgentEdit(h.page,binding,{verifySettings,beforeSubmit:async()=>{if(changed==='receipt')throw Object.assign(Error('disk full'),{code:'ENOSPC'});if(changed==='prompt')h.state.prompt+=' changed';if(changed==='source')h.state.source=IMAGE1;if(changed==='quote')h.state.quote=35;}}),error=>error.unknownOutcome===false);assert.deepEqual(h.actions,['message']);
  await assert.rejects(approveAgentEdit(h.page,binding,{verifySettings,beforeSubmit:async()=>{}}),{code:'AGENT_PREPARATION_REQUIRED'});
 }
});
test('Agent cancellation after durable callback never presses approval and consumes the binding without replay',async()=>{
 const h=fixture({messages:false}),controller=new AbortController(),verifySettings=async()=>{};h.page.signal=controller.signal;
 const binding=await prepareAgentProposal(h.page,expected(),{verifySettings});let durable=0;
 await assert.rejects(approveAgentEdit(h.page,binding,{verifySettings,beforeSubmit:async()=>{durable++;controller.abort();}}),error=>error.name==='AbortError'&&error.unknownOutcome===false);
 assert.equal(durable,1);assert.deepEqual(h.actions,['message']);assert.equal(h.commands.filter(value=>value.method==='Input.dispatchMouseEvent'&&value.params.type==='mousePressed').length,1);
 await assert.rejects(approveAgentEdit(h.page,binding,{verifySettings,beforeSubmit:async()=>assert.fail('Cancelled binding reached receipt again')}),{code:'AGENT_PREPARATION_REQUIRED'});assert.deepEqual(h.actions,['message']);
});
test('Agent planning preserves a foreign draft and requires checked settings before sending',async()=>{
 const h=fixture({messages:false});h.state.composerPrompt='User draft';await assert.rejects(prepareAgentProposal(h.page,expected(),{verifySettings:async()=>{}}),{code:'BROWSER_DRAFT_PRESENT'});assert.deepEqual(h.actions,[]);await assert.rejects(prepareAgentProposal(h.page,expected()),{code:'AGENT_SETTINGS_NOT_VERIFIED'});assert.deepEqual(h.actions,[]);
 const wrong=fixture({messages:false,source:IMAGE1});await assert.rejects(prepareAgentProposal(wrong.page,expected(),{verifySettings:async()=>{}}),{code:'AGENT_INPUTS_CHANGED'});assert.equal(wrong.commands.some(value=>value.method==='Input.insertText'),false);assert.deepEqual(wrong.actions,[]);
});
test('Agent new session waits for its temporarily absent panel and never repeats Start new session',async()=>{
 const h=fixture(),query=h.context.document.querySelectorAll;let hiddenReads=1,started=false;const panel=query('flow-agent-panel')[0],composer=panel.querySelectorAll('flow-agent-panel-prompt-box, .agent-panel-prompt-box')[0],queryComposer=composer.querySelectorAll;composer.querySelectorAll=selector=>selector==='flow-chat-ingredient-row'?[]:queryComposer(selector);
 h.context.document.querySelectorAll=selector=>{if(selector==='flow-agent-panel'&&started&&hiddenReads>0){hiddenReads--;return [];}return query(selector);};
 const send=h.page.client.send;h.page.client.send=async(method,args)=>{const value=await send(method,args);if(method==='Runtime.evaluate'&&args.expression.endsWith('("start-session",{})'))started=true;return value;};
 await startAgentSession(h.page);assert.deepEqual(h.actions,['new-session']);assert.equal(hiddenReads,0);assert.equal(h.state.messages,false);
});
test('Agent approval cannot move to another browser page or replay after a dispatched press loses acknowledgement',async()=>{
 const h=fixture({messages:false}),other=fixture(),verifySettings=async()=>{},binding=await prepareAgentProposal(h.page,expected(),{verifySettings});
 await assert.rejects(approveAgentEdit(other.page,binding,{verifySettings,beforeSubmit:async()=>assert.fail('Foreign page reached receipt boundary')}),{code:'AGENT_PREPARATION_REQUIRED'});
 const send=h.page.client.send;h.page.client.send=async(method,args)=>{if(method==='Input.dispatchMouseEvent'&&args.type==='mousePressed')throw Object.assign(Error('connection closed'),{code:'CDP_CLOSED'});return send(method,args);};
 await assert.rejects(approveAgentEdit(h.page,binding,{verifySettings,beforeSubmit:async()=>{}}),error=>error.code==='CDP_CLOSED'&&error.unknownOutcome===true);
 await assert.rejects(approveAgentEdit(h.page,binding,{verifySettings,beforeSubmit:async()=>{}}),{code:'AGENT_PREPARATION_REQUIRED'});assert.deepEqual(h.actions,['message']);
});
test('Agent output waits only its approved own gallery and opens a loaded exact-prompt result without another approval',async()=>{
 const h=fixture({messages:false}),verifySettings=async()=>{},binding=await prepareAgentProposal(h.page,expected(),{verifySettings});await approveAgentEdit(h.page,binding,{verifySettings,beforeSubmit:async()=>{}});
 assert.equal(await readAgentEditOutput(h.page,binding),false);h.state.output=true;h.state.outputControlMissing=true;assert.equal(await readAgentEditOutput(h.page,binding),false);h.state.outputControlMissing=false;h.state.outputImageMissing=true;assert.equal(await readAgentEditOutput(h.page,binding),false);h.state.outputImageMissing=false;h.state.outputLoaded=false;assert.equal(await readAgentEditOutput(h.page,binding),false);h.state.outputLoaded=true;
 const result=await readAgentEditOutput(h.page,binding,{open:true});assert.equal(result.poster,'https://storage.googleapis.com/ai-sandbox-videofx/image/'+IMAGE2);assert.equal(result.imageResourceId,IMAGE2);assert.ok(result.openPoint);assert.deepEqual(h.actions,['message','approve']);
 h.state.outputCount=2;await assert.rejects(readAgentEditOutput(h.page,binding),{code:'AGENT_PROPOSAL_CHANGED'});h.state.outputCount=1;h.state.outputImageCount=2;await assert.rejects(readAgentEditOutput(h.page,binding),{code:'AGENT_PROPOSAL_CHANGED'});h.state.outputImageCount=1;h.state.outputPrompt='Foreign output';await assert.rejects(readAgentEditOutput(h.page,binding),{code:'AGENT_PROPOSAL_CHANGED'});
});

function settingsFixture(){
 let panel,open=false,confirm='Never',aspect='16:9',count='x2';const actions=[];
 const el=(tag,attrs={},extra={})=>Object.defineProperties({tagName:tag.toUpperCase(),getAttribute:key=>attrs[key]??null,getClientRects:()=>[1],closest:selector=>selector==='flow-agent-panel'?panel:null,querySelectorAll:()=>[]},Object.getOwnPropertyDescriptors(extra));
 const confirmChoice=name=>{const input=el('input',{}, {get checked(){return confirm===name;},click(){actions.push('confirm:'+name);confirm=name;}}),label=el('span',{}, {textContent:name});return el('mat-radio-button',{}, {querySelectorAll:selector=>selector==='.radio-label'?[label]:selector==='input[type="radio"]'?[input]:[]});};
 const confirmGroup=el('mat-radio-group',{}, {querySelectorAll:selector=>selector==='mat-radio-button'?[confirmChoice('Always'),confirmChoice('Never')]:[]});
 const toggleGroup=kind=>el('flow-toggles',{}, {querySelectorAll:selector=>selector==='[role="radio"]'?(kind==='aspect'?['16:9','9:16']:['x1','x2','x3','x4']).map(value=>el('button',{}, {innerText:kind==='aspect'?'crop_9_16 '+value:value,getAttribute:key=>key==='aria-checked'?String((kind==='aspect'?aspect:count)===value):null,click(){actions.push(kind+':'+value);if(kind==='aspect')aspect=value;else count=value;}})):[]});
 const model=el('button',{}, {innerText:'Omni 1.2 Flash arrow_drop_down'}),save=el('button',{}, {click(){actions.push('save');open=false;}}),back=el('button',{}, {click(){actions.push('back');open=false;}}),settingsButton=el('button',{}, {click(){actions.push('open');open=true;}});
 const root=el('flow-settings-view',{}, {querySelectorAll:selector=>selector==='[role="radiogroup"][aria-labelledby="agent-settings-confirm-policy-label"]'?[confirmGroup]:selector==='flow-toggles[aria-label="Video generation default aspect ratio"]'?[toggleGroup('aspect')]:selector==='flow-toggles[aria-label="Video generation default output count"]'?[toggleGroup('count')]:selector==='button[aria-label="Video generation default model"]'?[model]:selector==='button.settings-save-button'?[save]:[]});
 const title=el('h2',{}, {get innerText(){return open?'Agent settings':'Untitled session';}});
 panel=el('flow-agent-panel',{}, {querySelectorAll:selector=>selector==='flow-settings-view'?open?[root]:[]:selector==='.agent-panel-header .header-title'?[title]:selector==='flow-creative-agent-prompt-box .agent-footer-actions button[aria-label="Settings"]'?[settingsButton]:selector==='.agent-panel-header button[aria-label="Back"]'?[back]:[]});
 const context={location:{origin:'https://flow.google.com',href:PROJECT},getComputedStyle:()=>({visibility:'visible'}),document:{querySelectorAll:selector=>selector==='flow-agent-panel'?[panel]:[]}};
 const page={until:async fn=>{const value=await fn();assert.ok(value);return value;},client:{send:async(method,params)=>{assert.equal(method,'Runtime.evaluate');try{return {result:{value:vm.runInNewContext(params.expression,context)}};}catch(error){return {exceptionDetails:{exception:{description:error.message}}};}}}};
 return {page,actions,state:()=>({open,confirm,aspect,count})};
}
test('Agent settings configure Always and video-only aspect/count without changing image defaults and verify without saving',async()=>{
 const h=settingsFixture(),plan={method:'edit',aspect:'9:16'};
 const configured=await configureAgentEdit(h.page,plan);assert.equal(configured.confirm,'Always');assert.equal(configured.aspect,'9:16');assert.equal(configured.count,'x1');assert.equal(configured.model,'Omni 1.2 Flash');assert.deepEqual(h.actions,['open','confirm:Always','aspect:9:16','count:x1','save']);assert.equal(h.state().open,false);
 await verifyAgentEditSettings(h.page,plan);assert.deepEqual(h.actions.slice(-2),['open','back']);assert.equal(h.actions.filter(value=>value==='save').length,1);assert.equal(h.state().open,false);
});
test('Agent settings mismatch fails before message/approval and leaves settings through own Back control',async()=>{
 const h=settingsFixture();await assert.rejects(verifyAgentEditSettings(h.page,{method:'edit',aspect:'9:16'}),{code:'AGENT_SETTINGS_NOT_VERIFIED'});assert.deepEqual(h.actions,['open','back']);assert.equal(h.state().open,false);
});

function assetFixture(options={}){
 const filename='exact-source-video',h=fixture({messages:false});h.state.source=null;h.state.images=[];let pickerOpen=false,query='',selected=false,optionClicks=0,addClicks=0,railClicks=0,nonce,listReads=0,listCount=1,openClicks=0,searchWrites=0,foreignOpen=false;
 const panel=h.context.document.querySelectorAll('flow-agent-panel')[0],queryPanel=panel.querySelectorAll,composer=queryPanel('flow-agent-panel-prompt-box, .agent-panel-prompt-box')[0],queryComposer=composer.querySelectorAll;
 const node=(tag,extra={})=>Object.defineProperties({tagName:tag.toUpperCase(),getClientRects:()=>[1],getAttribute:()=>null,querySelectorAll:()=>[],closest:selector=>selector==='flow-agent-panel'?panel:null},Object.getOwnPropertyDescriptors(extra));
 const trigger=node('button',{getAttribute:key=>key==='aria-expanded'?String(pickerOpen):null,click(){if(!pickerOpen)openClicks++;pickerOpen=!pickerOpen;}});
 let attached=false,claimNonce;const placeholder=node('div'),remove=node('button',{getAttribute:key=>key==='aria-busy'?'false':null,click(){attached=false;}}),canonicalImage=node('img',{getAttribute:key=>key==='src'?'https://storage.googleapis.com/ai-sandbox-videofx/image/'+SOURCE:null,closest:selector=>selector==='flow-video-ingredient-chip,flow-image-ingredient-chip'?pendingChip:selector==='flow-agent-panel'?panel:null}),pendingChip=node('flow-video-ingredient-chip',{setAttribute(key,value){claimNonce=value;},querySelectorAll:selector=>selector==='button'?[remove]:selector==='.chip-placeholder'?[placeholder]:selector.startsWith('img[')&&options.canonical?[canonicalImage]:[]});
 composer.querySelectorAll=selector=>selector==='button[aria-label="Add ingredients to the prompt box"]'?[trigger]:selector==='flow-chat-ingredient-row'?[]:selector==='flow-video-ingredient-chip,flow-image-ingredient-chip'||selector==='flow-video-ingredient-chip'?attached?[pendingChip]:[]:queryComposer(selector);
 const search=node('input',{get value(){return query;},focus(){h.context.document.activeElement=search;},select(){}}),title=node('span',{innerText:filename}),type=node('span',{innerText:'Video'}),option=node('button',{getAttribute:key=>key==='aria-selected'?String(selected):null,closest:selector=>selector==='flow-add-menu-popover-content'?popover:null,querySelectorAll:selector=>selector==='.asset-title'?[title]:selector==='.type-subtitle'?[type]:[],click(){optionClicks++;selected=true;}});
 const list=node('cdk-virtual-scroll-viewport',{querySelectorAll:selector=>selector==='button[role="option"]'&&query===filename?[option]:[]});
 const add=node('button',{innerText:'Add to prompt',click(){addClicks++;attached=true;pickerOpen=false;}}),details=node('flow-add-menu-detail-pane',{querySelectorAll:selector=>selector==='button.detail-add-to-prompt-btn'?[add]:[]});
 const popover=node('flow-add-menu-popover-content',{getClientRects:()=>pickerOpen?[1]:[],getAttribute:key=>key==='data-flow-studio-agent-picker'?nonce:null,setAttribute(key,value){assert.equal(key,'data-flow-studio-agent-picker');nonce=value;},removeAttribute(){nonce=undefined;},querySelectorAll:selector=>selector==='input[aria-label="Search assets"]'?[search]:selector==='[role="listbox"][aria-label="Asset list"]'?++listReads<=(options.libraryEmptyReads||1)?[]:Array(listCount).fill(list):selector==='flow-add-menu-detail-pane'?[details]:[]});
 const foreign=node('flow-add-menu-popover-content',{getClientRects:()=>foreignOpen?[1]:[]});
 const queryDocument=h.context.document.querySelectorAll;h.context.document.querySelectorAll=selector=>selector==='flow-add-menu-popover-content'?[popover,foreign]:selector==='button,[role="button"]'?[{click:()=>railClicks++}]:queryDocument(selector);
 const send=h.page.client.send;h.page.client.send=async(method,args)=>{if(method==='Input.insertText'&&h.context.document.activeElement===search){query=options.wrongSearch?'wrong':args.text;searchWrites++;if(options.closeOnSearch&&(searchWrites===1||options.closeTwice&&searchWrites===2)){pickerOpen=false;query='';if(options.foreignOnClose)foreignOpen=true;if(options.draftOnClose)h.state.composerPrompt='Foreign draft';if(options.attachmentOnClose)attached=true;}return {};}return send(method,args);};
 return {h,attach:()=>attachAgentAsset(h.page,{name:filename,kind:'video',expectedResourceId:SOURCE,previous:{sourceImageResourceId:null,ingredientImageResourceIds:[]}}),stats:()=>({optionClicks,addClicks,railClicks,pickerOpen,nonce,listReads,openClicks,searchWrites,attached,claimNonce,foreignOpen}),duplicateLists(){pickerOpen=true;nonce='duplicate-list-probe';listCount=2;assert.throws(()=>h.run('asset-exists',{nonce,name:filename,kind:'video'}),/AGENT_PICKER_NOT_VERIFIED.*2/);pickerOpen=false;nonce=undefined;listCount=1;}};
}
test('Agent waits for its claimed picker list to render then selects one exact typed option and claims only its owned placeholder',async()=>{
 const f=assetFixture(),result=await f.attach(),state=f.stats();
 assert.equal(result.source.imageResourceId,null);assert.equal(result.source.pending,true);assert.equal(result.source.selectionClaim.expectedResourceId,SOURCE);assert.equal(result.source.selectionClaim.nonce,state.claimNonce);assert.equal(result.selectionNonce,state.claimNonce);assert.ok(state.listReads>=2);assert.equal(state.optionClicks,1);assert.equal(state.addClicks,1);assert.equal(state.railClicks,0);assert.equal(state.pickerOpen,false);assert.equal(state.nonce,undefined);assert.deepEqual(f.h.actions,[]);
 f.duplicateLists();assert.equal(f.stats().optionClicks,1);
 assert.equal(await clearOwnedAgentAttachments(f.h.page,{nonces:['00000000-0000-4000-8000-000000000000']}),false);assert.equal(f.stats().attached,true);
 assert.equal(await clearOwnedAgentAttachments(f.h.page,{nonces:[state.claimNonce]}),true);assert.equal(f.stats().attached,false);
});
test('Agent returns cleanup ownership for canonical attachments and preserves any later foreign prompt',async()=>{
 const f=assetFixture({canonical:true}),result=await f.attach();assert.equal(result.source.imageResourceId,SOURCE);assert.equal(result.source.selectionClaim,undefined);assert.equal(result.selectionNonce,f.stats().claimNonce);
 f.h.state.composerPrompt='User changed this draft';assert.equal(await clearOwnedAgentAttachments(f.h.page,{nonces:[result.selectionNonce],prompt:''}),false);assert.equal(f.stats().attached,true);
 f.h.state.composerPrompt='';assert.equal(await clearOwnedAgentAttachments(f.h.page,{nonces:[result.selectionNonce],prompt:''}),true);assert.equal(f.stats().attached,false);assert.deepEqual(f.h.actions,[]);
});
test('Agent may reopen its closed unchanged picker once before selecting and never repeats option or Add clicks',async()=>{
 const f=assetFixture({closeOnSearch:true});const result=await f.attach();assert.equal(result.source.selectionClaim.expectedResourceId,SOURCE);const state=f.stats();assert.equal(state.openClicks,2);assert.equal(state.searchWrites,2);assert.equal(state.optionClicks,1);assert.equal(state.addClicks,1);assert.equal(state.railClicks,0);assert.deepEqual(f.h.actions,[]);
});
test('Agent waits up to a minute for a newly uploaded exact library asset without extra search selection or Add actions',async()=>{
 const f=assetFixture({libraryEmptyReads:4}),until=f.h.page.until;let budget;
 f.h.page.until=async(fn,timeout,stage)=>{if(!stage.startsWith('agent-exact-asset'))return until(fn,timeout,stage);budget=timeout;for(let elapsed=0;elapsed<timeout;elapsed+=10000){const value=await fn();if(value)return value;}throw Object.assign(Error('library indexing timeout'),{code:'FLOW_UI_TIMEOUT'});};
 const result=await f.attach();assert.equal(budget,60000);assert.equal(result.source.selectionClaim.expectedResourceId,SOURCE);const state=f.stats();assert.ok(state.listReads>=5);assert.equal(state.openClicks,1);assert.equal(state.searchWrites,1);assert.equal(state.optionClicks,1);assert.equal(state.addClicks,1);assert.deepEqual(f.h.actions,[]);
});
test('Agent search recovery blocks foreign popovers drafts changed inputs or repeated closure and verifies typed search value',async()=>{
 for(const options of [{closeOnSearch:true,foreignOnClose:true},{closeOnSearch:true,draftOnClose:true},{closeOnSearch:true,attachmentOnClose:true},{closeOnSearch:true,closeTwice:true},{wrongSearch:true}]){
  const f=assetFixture(options);await assert.rejects(f.attach(),error=>['AGENT_PICKER_NOT_VERIFIED','AGENT_INPUTS_CHANGED','FLOW_UI_TIMEOUT'].includes(error.code));const state=f.stats();assert.equal(state.optionClicks,0);assert.equal(state.addClicks,0);assert.ok(state.openClicks<=2);assert.equal(state.railClicks,0);if(options.foreignOnClose)assert.equal(state.foreignOpen,true);if(options.draftOnClose)assert.equal(f.h.state.composerPrompt,'Foreign draft');
 }
});
