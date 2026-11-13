// Narrow bridge: the page only gets these calls, never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel) => (fn) => ipcRenderer.on(channel, (_e, data) => fn(data));

contextBridge.exposeInMainWorld("ls", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveTelegram: (keys) => ipcRenderer.invoke("config:telegram", keys),
  setUrl: (url) => ipcRenderer.invoke("config:url", url),
  disconnect: () => ipcRenderer.invoke("config:disconnect"),
  configureTelegram: () => ipcRenderer.invoke("telegram:configure"),
  saveMicrosoft: (clientId, tenant) => ipcRenderer.invoke("config:microsoft", clientId, tenant),
  configureMicrosoft: () => ipcRenderer.invoke("microsoft:configure"),
  msBrowserLogin: () => ipcRenderer.invoke("microsoft:browser-login"),
  msPush: () => ipcRenderer.invoke("microsoft:push"),
  msForget: () => ipcRenderer.invoke("microsoft:forget"),
  api: (method, route, body) => ipcRenderer.invoke("api", method, route, body),
  startColab: () => ipcRenderer.invoke("colab:start"),
  startColabExternal: () => ipcRenderer.invoke("colab:external"),
  copyCell: () => ipcRenderer.invoke("colab:copy"),
  open: (url) => ipcRenderer.invoke("open", url),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: (url) => ipcRenderer.invoke("update:download", url),
  notify: (title, body) => ipcRenderer.invoke("notify", title, body),
  setKeepAwake: (on) => ipcRenderer.invoke("power:keep-awake", Boolean(on)),
  setActive: (on) => ipcRenderer.invoke("jobs:active", Boolean(on)),
  setWindowPrefs: (p) => ipcRenderer.invoke("window:prefs", {
    trayMinimize: Boolean(p && p.trayMinimize), closeToTray: Boolean(p && p.closeToTray),
  }),
  onConnected: listen("colab:connected"),
  onStage: listen("colab:stage"),
  onLinkError: listen("colab:link-error"),
});
