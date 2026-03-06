const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  openFolder:   ()           => ipcRenderer.invoke('dialog:openFolder'),
  readFolder:   (p, rec)     => ipcRenderer.invoke('fs:readFolder', p, rec),
  readFile:     (p)          => ipcRenderer.invoke('fs:readFile', p),
  trashFile:    (p)          => ipcRenderer.invoke('fs:trashFile', p),
  deleteFile:   (p)          => ipcRenderer.invoke('fs:deleteFile', p),
  moveFile:     (src, dest)  => ipcRenderer.invoke('fs:moveFile', src, dest),
  openFolder2:  (p)          => ipcRenderer.invoke('shell:openFolder', p),
  writeCsv:     (csv, name)  => ipcRenderer.invoke('fs:writeCsv', csv, name),
})
