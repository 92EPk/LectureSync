// Narrow bridge: the page only gets these calls, never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel) => (fn) => ipcRenderer.on(channel, (_e, data) => fn(data));

contextBridge.exposeInMainWorld("ls", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveTelegram: (keys) => ipcRenderer.invoke("config:telegram", keys),
  setUrl: (url) => ipcRenderer.invoke("config:url", url),
  configureTelegram: () => ipcRenderer.invoke("telegram:configure"),
  api: (method, route, body) => ipcRenderer.invoke("api", method, route, body),
  startColab: () => ipcRenderer.invoke("colab:start"),
  startColabExternal: () => ipcRenderer.invoke("colab:external"),
  copyCell: () => ipcRenderer.invoke("colab:copy"),
  open: (url) => ipcRenderer.invoke("open", url),
  notify: (title, body) => ipcRenderer.invoke("notify", title, body),
  onConnected: listen("colab:connected"),
  onStage: listen("colab:stage"),
  onLinkError: listen("colab:link-error"),
});
