'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dexter', Object.freeze({
  listInstalledApps: () => ipcRenderer.invoke('apps:list'),
  openInstalledApp: (appId) => ipcRenderer.invoke('apps:open', appId),
  chooseAndOpenFolder: () => ipcRenderer.invoke('folder:choose-and-open'),
  readLocalCalendar: () => ipcRenderer.invoke('calendar:read-local-file'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  saveScreenshot: () => ipcRenderer.invoke('screen:save'),
  askLocalModel: (request) => ipcRenderer.invoke('local-model:chat', request),
  querySystem: (kind) => ipcRenderer.invoke('system:query', kind),
  runSystemAction: (action) => ipcRenderer.invoke('system:action', action),
  connectObs: (request) => ipcRenderer.invoke('obs:connect', request),
  disconnectObs: () => ipcRenderer.invoke('obs:disconnect'),
  getObsStatus: () => ipcRenderer.invoke('obs:status'),
  setObsScene: (sceneName) => ipcRenderer.invoke('obs:scene', sceneName),
  setObsOutput: (kind, active) => ipcRenderer.invoke('obs:toggle-output', kind, active),
  setObsMute: (inputName, muted) => ipcRenderer.invoke('obs:toggle-mute', inputName, muted),
  toggleOverlay: () => ipcRenderer.invoke('overlay:toggle'),
  closeOverlay: () => ipcRenderer.invoke('overlay:close'),
  focusMainWindow: () => ipcRenderer.invoke('window:focus-main'),
  sendOverlayCommand: (command) => ipcRenderer.invoke('overlay:command', command),
  onOverlayCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('overlay:command', listener);
    return () => ipcRenderer.removeListener('overlay:command', listener);
  },
  onVoiceToggle: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('voice:toggle', listener);
    return () => ipcRenderer.removeListener('voice:toggle', listener);
  },
  getVersion: () => ipcRenderer.invoke('app:version'),
  openProjectPage: () => ipcRenderer.invoke('app:open-project'),
  exportDiagnostics: () => ipcRenderer.invoke('diagnostics:export'),
}));
