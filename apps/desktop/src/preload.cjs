// The only surface the page gets from the desktop shell. Sandboxed preloads must be CommonJS.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rig", {
  isDesktop: true,
  pickFolder: () => ipcRenderer.invoke("rig:pickFolder"),
  openPath: (p) => ipcRenderer.invoke("rig:openPath", String(p)),
});
