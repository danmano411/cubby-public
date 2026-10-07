const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cubby', {
  on: (channel, fn) => ipcRenderer.on(channel, (_, ...args) => fn(...args)),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
});
