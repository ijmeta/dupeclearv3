const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path  = require('path')
const fs    = require('fs')

// ── Keep a global reference so window isn't garbage-collected ──────────────
let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width:          1280,
    height:         800,
    minWidth:       960,
    minHeight:      600,
    title:          'Dedupix — Photo Duplicate Remover',
    backgroundColor: '#F0EDE8',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    // Native Windows look
    frame:          true,
    autoHideMenuBar: true,
  })

  // In production load the built Vite bundle; in dev connect to Vite dev server
  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  } else {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  }
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// ── IPC: Open folder picker dialog ────────────────────────────────────────
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select folder to scan for duplicate photos',
  })
  return result.canceled ? null : result.filePaths[0]
})

// ── IPC: Read all image files from a folder (recursive option) ────────────
ipcMain.handle('fs:readFolder', async (_e, folderPath, recursive) => {
  const IMAGE_EXTS = new Set([
    '.jpg','.jpeg','.png','.gif','.bmp',
    '.tiff','.tif','.webp','.heic','.heif',
    '.raw','.cr2','.nef','.arw','.dng'
  ])
  const files = []

  function walk(dir) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
    catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory() && recursive) { walk(full); continue }
      if (!e.isFile()) continue
      const ext = path.extname(e.name).toLowerCase()
      if (!IMAGE_EXTS.has(ext)) continue
      try {
        const stat = fs.statSync(full)
        files.push({
          path:     full,
          name:     e.name,
          size:     stat.size,
          modified: stat.mtimeMs,
          ext,
        })
      } catch {}
    }
  }

  walk(folderPath)
  return files
})

// ── IPC: Read file as buffer for hashing ──────────────────────────────────
ipcMain.handle('fs:readFile', async (_e, filePath) => {
  try {
    const buf = fs.readFileSync(filePath)
    // Transfer as Uint8Array so it survives the IPC bridge
    return { ok: true, data: new Uint8Array(buf) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ── IPC: Move file to Recycle Bin (safe delete) ───────────────────────────
ipcMain.handle('fs:trashFile', async (_e, filePath) => {
  try {
    await shell.trashItem(filePath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ── IPC: Permanently delete a file ────────────────────────────────────────
ipcMain.handle('fs:deleteFile', async (_e, filePath) => {
  try {
    fs.unlinkSync(filePath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ── IPC: Move file to a chosen folder ─────────────────────────────────────
ipcMain.handle('fs:moveFile', async (_e, src, destDir) => {
  try {
    const dest = path.join(destDir, path.basename(src))
    fs.renameSync(src, dest)
    return { ok: true, dest }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ── IPC: Open folder in Windows Explorer ──────────────────────────────────
ipcMain.handle('shell:openFolder', async (_e, folderPath) => {
  shell.openPath(folderPath)
})

// ── IPC: Write CSV log to disk ─────────────────────────────────────────────
ipcMain.handle('fs:writeCsv', async (_e, csv, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title:       'Save Report',
    defaultPath: defaultName,
    filters:     [{ name: 'CSV Files', extensions: ['csv'] }],
  })
  if (result.canceled) return { ok: false }
  try {
    fs.writeFileSync(result.filePath, csv, 'utf8')
    return { ok: true, filePath: result.filePath }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})
