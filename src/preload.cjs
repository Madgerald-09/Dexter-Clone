'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dexter', Object.freeze({
  listInstalledApps: () => ipcRenderer.invoke('apps:list'),
  openInstalledApp: (appId) => ipcRenderer.invoke('apps:open', appId),
  chooseAndOpenFolder: () => ipcRenderer.invoke('folder:choose-and-open'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  saveScreenshot: () => ipcRenderer.invoke('screen:save'),
  askLocalModel: (request) => ipcRenderer.invoke('local-model:chat', request),
  getVersion: () => ipcRenderer.invoke('app:version'),
}));
