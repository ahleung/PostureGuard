const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  showOverlay: (payload) => ipcRenderer.send('overlay:show', payload),
  hideOverlay: () => ipcRenderer.send('overlay:hide'),
  onOverlayContent: (cb) => ipcRenderer.on('overlay:content', (_e, d) => cb(d)),
  onWorkTime: (cb) => ipcRenderer.on('worktime', (_e, v) => cb(v)),
  getWorkTime: () => ipcRenderer.invoke('worktime:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  saveBaseline: (base) => ipcRenderer.invoke('baseline:save', base),
  clearBaseline: () => ipcRenderer.invoke('baseline:clear'),
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  previewOverlay: (opacity) => ipcRenderer.send('overlay:preview', opacity),
  onHotkey: (cb) => ipcRenderer.on('hotkey:pause', () => cb()),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  logSitEvent: (e) => ipcRenderer.send('sit:event', e),
});
