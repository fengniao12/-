'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function on(channel) {
  return (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('dsh', {
  app: {
    info: () => ipcRenderer.invoke('app:info')
  },
  win: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    onState: on('window:state')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (patch) => ipcRenderer.invoke('settings:save', patch)
  },
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    save: (payload) => ipcRenderer.invoke('providers:save', payload),
    remove: (id) => ipcRenderer.invoke('providers:remove', id),
    activate: (id) => ipcRenderer.invoke('providers:activate', id),
    test: (payload) => ipcRenderer.invoke('providers:test', payload)
  },
  voices: {
    list: () => ipcRenderer.invoke('voices:list'),
    upload: (payload) => ipcRenderer.invoke('voices:upload', payload),
    remove: (id) => ipcRenderer.invoke('voices:remove', id),
    audio: (id) => ipcRenderer.invoke('voice:audio', id),
    onProgress: on('voice:progress')
  },
  tts: {
    generate: (payload) => ipcRenderer.invoke('tts:generate', payload),
    cancel: () => ipcRenderer.invoke('tts:cancel'),
    onProgress: on('tts:progress')
  },
  audio: {
    pick: () => ipcRenderer.invoke('audio:pick')
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    audio: (id) => ipcRenderer.invoke('history:audio', id),
    remove: (id) => ipcRenderer.invoke('history:delete', id),
    clear: () => ipcRenderer.invoke('history:clear'),
    reveal: (id) => ipcRenderer.invoke('history:reveal', id)
  },
  file: {
    saveAs: (payload) => ipcRenderer.invoke('file:saveAs', payload)
  },
  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
    showItem: (p) => ipcRenderer.invoke('shell:showItem', p)
  }
});
