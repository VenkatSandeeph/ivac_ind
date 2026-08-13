const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ivacApi', {
  start: () => ipcRenderer.invoke('automation:start'),
  stop: () => ipcRenderer.invoke('automation:stop'),
  status: () => ipcRenderer.invoke('automation:status'),
  readConfig: () => ipcRenderer.invoke('config:read'),
  saveConfig: (content) => ipcRenderer.invoke('config:save', content),
  validateConfig: (content) => ipcRenderer.invoke('config:validate', content),
  connectChrome: (content) => ipcRenderer.invoke('chrome:connect', content),
  getConfigPath: () => ipcRenderer.invoke('config:path'),
  onLog: (handler) => {
    ipcRenderer.on('automation:log', (_event, message) => handler(message));
  },
  onStatus: (handler) => {
    ipcRenderer.on('automation:status', (_event, status) => handler(status));
  }
});
