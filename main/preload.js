'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only surface the UI gets. No node, no fs, no direct network — the
 * renderer is a pure view over snapshots produced in the main process.
 */
contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('app:getState'),
  sources: () => ipcRenderer.invoke('app:sources'),
  detectType: (url) => ipcRenderer.invoke('app:detectType', url),
  testMode: () => ipcRenderer.invoke('app:testMode'),

  slot: {
    update: (id, patch) => ipcRenderer.invoke('slot:update', id, patch),
    connect: (id) => ipcRenderer.invoke('slot:connect', id),
    connectAll: () => ipcRenderer.invoke('slot:connectAll'),
    disconnect: (id) => ipcRenderer.invoke('slot:disconnect', id),
    clear: (id) => ipcRenderer.invoke('slot:clear', id),
    manual: (id, on) => ipcRenderer.invoke('slot:manual', id, on)
  },

  ladder: {
    preview: (text) => ipcRenderer.invoke('ladder:preview', text),
    set: (text) => ipcRenderer.invoke('ladder:set', text)
  },

  settings: {
    poll: (ms) => ipcRenderer.invoke('settings:poll', ms),
    round: (label) => ipcRenderer.invoke('settings:round', label)
  },

  clearLog: () => ipcRenderer.invoke('log:clear'),
  overlay: {
    toggle: () => ipcRenderer.invoke('overlay:toggle'),
    onCommand: (handler) => {
      const listener = (_e, command) => handler(command);
      ipcRenderer.on('overlay-command', listener);
      return () => ipcRenderer.removeListener('overlay-command', listener);
    }
  },
  toggleFullscreen: () => ipcRenderer.invoke('window:fullscreen'),

  onState: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  }
});
