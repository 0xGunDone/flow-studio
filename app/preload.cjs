'use strict';
const {contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('flowStudio',{
  bootstrap:()=>ipcRenderer.invoke('studio:bootstrap'),
  openFlow:()=>ipcRenderer.invoke('studio:openFlow'),
  retryStartup:()=>ipcRenderer.invoke('studio:retryStartup'),
  getProviderSettings:()=>ipcRenderer.invoke('studio:getProviderSettings'),
  saveTwoCaptchaKey:key=>ipcRenderer.invoke('studio:saveTwoCaptchaKey',key),
  generate:input=>ipcRenderer.invoke('studio:generate',input),
  pickImages:options=>ipcRenderer.invoke('studio:pickImages',options),
  dropMedia:async(files,options={})=>{
    if(!Array.isArray(files))throw new Error('Перетащите файлы с диска.');
    if(files.length>7)throw new Error('Выберите не больше семи файлов.');
    const paths=Array.from(files,file=>{
      let filePath;try{filePath=webUtils.getPathForFile(file);}catch{throw new Error('Перетащите обычные файлы с диска.');}
      if(typeof filePath!=='string'||!filePath)throw new Error('Перетащите обычные файлы с диска.');
      return filePath;
    });
    return ipcRenderer.invoke('studio:dropMedia',paths,{allowVideos:options?.allowVideos===true});
  },
  addAccount:()=>ipcRenderer.invoke('studio:addAccount'),
  reconnectAccount:id=>ipcRenderer.invoke('studio:reconnectAccount',id),
  checkAccount:id=>ipcRenderer.invoke('studio:checkAccount',id),
  checkEnabledAccounts:()=>ipcRenderer.invoke('studio:checkEnabledAccounts'),
  setAccountActive:(id,enabled)=>ipcRenderer.invoke('studio:setAccountActive',id,enabled),
  deleteAccount:id=>ipcRenderer.invoke('studio:deleteAccount',id),
  cancelLogin:()=>ipcRenderer.invoke('studio:cancelLogin'),
  completeLogin:()=>ipcRenderer.invoke('studio:completeLogin'),
  copyHelpText:text=>ipcRenderer.invoke('studio:copyHelpText',text),
  refreshAccounts:()=>ipcRenderer.invoke('studio:refreshAccounts'),
  revealFile:path=>ipcRenderer.invoke('studio:revealFile',path),
  saveMedia:input=>ipcRenderer.invoke('studio:saveMedia',input),
  onEvent:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('studio:event',listener);return()=>ipcRenderer.removeListener('studio:event',listener);}
});
