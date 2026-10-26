'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('flowStudio',{
  bootstrap:()=>ipcRenderer.invoke('studio:bootstrap'),
  retryStartup:()=>ipcRenderer.invoke('studio:retryStartup'),
  generate:input=>ipcRenderer.invoke('studio:generate',input),
  pickImages:options=>ipcRenderer.invoke('studio:pickImages',options),
  addAccount:()=>ipcRenderer.invoke('studio:addAccount'),
  reconnectAccount:id=>ipcRenderer.invoke('studio:reconnectAccount',id),
  checkAccount:id=>ipcRenderer.invoke('studio:checkAccount',id),
  cancelLogin:()=>ipcRenderer.invoke('studio:cancelLogin'),
  completeLogin:()=>ipcRenderer.invoke('studio:completeLogin'),
  copyHelpText:text=>ipcRenderer.invoke('studio:copyHelpText',text),
  refreshAccounts:()=>ipcRenderer.invoke('studio:refreshAccounts'),
  revealFile:path=>ipcRenderer.invoke('studio:revealFile',path),
  saveMedia:input=>ipcRenderer.invoke('studio:saveMedia',input),
  onEvent:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('studio:event',listener);return()=>ipcRenderer.removeListener('studio:event',listener);}
});
