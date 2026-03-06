# Dedupix — Build Guide

## Requirements
- **Node.js 18+**: https://nodejs.org (click "LTS" download)
- **Windows 10 or 11** (building on Windows produces a Windows .exe directly)

## Steps

Open **PowerShell** (or Command Prompt) in the unzipped `dupeclear/` folder.

### Step 1 — Install dependencies
```
npm install
```
Expected: installs ~200MB into node_modules/. Takes 1-3 min depending on connection.

### Step 2 — Build the .exe
```
npm run dist
```
Expected output (last few lines):
```
  • building        target=NSIS file=release\Dedupix Setup 1.0.0.exe
  • building        target=portable file=release\Dedupix-Portable-1.0.0.exe
  • build success
```

### Step 3 — Find your files
Look in the `release\` folder:
- `Dedupix Setup 1.0.0.exe` — installer with Start Menu shortcut
- `Dedupix-Portable-1.0.0.exe` — single .exe, no install needed

---

## Troubleshooting

### "release\ folder is empty" or build ends with no output
Run this instead to see the actual error:
```
npm run build
npx electron-builder --win --x64 --verbose
```

### "Cannot find module" errors after npm install
```
rm -rf node_modules
npm cache clean --force
npm install
```

### Windows Defender blocks the .exe on first run
Right-click → "Run anyway" or Properties → "Unblock". 
This is normal for unsigned apps — no certificate was purchased.

### Icon error during build
Edit `package.json`, find the `"win"` section, remove the `"icon"` line entirely.
The app will use a default Electron icon.

### Build works but app shows blank window
Make sure `npm run build` succeeded before `electron-builder`.
Check the `dist/` folder exists and contains `index.html`.

---

## Run in dev mode (no .exe needed)
```
npm install
npx vite &
npx electron .
```
