import { contextBridge, ipcRenderer } from 'electron'

// Minimal surface: one request channel (validated in main) and one state push.
contextBridge.exposeInMainWorld('api', {
  call: (channel: string, arg?: unknown) => ipcRenderer.invoke('stacktok:' + channel, arg),
  onState: (cb: (s: unknown) => void) => {
    const h = (_: unknown, s: unknown) => cb(s)
    ipcRenderer.on('stacktok:state', h)
    return () => ipcRenderer.removeListener('stacktok:state', h)
  }
})
