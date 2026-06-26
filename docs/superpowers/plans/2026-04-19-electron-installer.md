# Luna Desktop Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the existing Luna Node.js app in a thin Electron shell so it produces a one-click `LunaSetup.exe` (Windows) and `Luna.dmg` (Mac) installer — no changes to existing source code.

**Architecture:** A new `electron-main.js` sets `PLAYWRIGHT_BROWSERS_PATH` to the bundled Chromium location, then loads the existing `dist/app.js` inside Electron's Node.js runtime. `electron-builder` packages everything — including a pre-downloaded Playwright Chromium — into platform installers. A system tray icon provides the only UI the Electron layer adds.

**Tech Stack:** Electron 36, electron-builder 26, png2icons, Playwright (already present), TypeScript (already present)

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `electron-main.js` | **Create** | Electron entry point — sets env, creates tray, loads app |
| `scripts/build-icons.js` | **Create** | Converts `build/icon.png` → `build/icon.ico` + `build/icon.icns` |
| `scripts/bundle-playwright.js` | **Create** | Downloads Playwright Chromium to `./playwright-browsers/` |
| `package.json` | **Modify** | Add deps, change `main`, add `build` config + scripts |

---

### Task 1: Install devDependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install electron, electron-builder, png2icons**

```bash
npm install --save-dev electron@^36.0.0 electron-builder@^26.0.0 png2icons@^2.0.1
```

Expected output ends with: `added N packages`

- [ ] **Step 2: Verify installs**

```bash
npx electron --version
npx electron-builder --version
```

Expected: prints version numbers without errors (e.g. `v36.x.x`)

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add electron, electron-builder, png2icons devDeps"
```

---

### Task 2: Generate ICO and ICNS icon formats

**Files:**
- Create: `scripts/build-icons.js`
- Produces: `build/icon.ico`, `build/icon.icns`

- [ ] **Step 1: Create `scripts/build-icons.js`**

```js
const png2icons = require('png2icons')
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs')
const path = require('path')

const src = readFileSync(path.join(__dirname, '..', 'build', 'icon.png'))

if (!existsSync(path.join(__dirname, '..', 'build'))) {
    mkdirSync(path.join(__dirname, '..', 'build'))
}

const ico = png2icons.createICO(src, png2icons.BILINEAR, 0, false, true)
if (!ico) throw new Error('ICO conversion failed')
writeFileSync(path.join(__dirname, '..', 'build', 'icon.ico'), ico)
console.log('Generated: build/icon.ico')

const icns = png2icons.createICNS(src, png2icons.BILINEAR, 0)
if (!icns) throw new Error('ICNS conversion failed')
writeFileSync(path.join(__dirname, '..', 'build', 'icon.icns'), icns)
console.log('Generated: build/icon.icns')
```

- [ ] **Step 2: Run the script**

```bash
node scripts/build-icons.js
```

Expected:
```
Generated: build/icon.ico
Generated: build/icon.icns
```

- [ ] **Step 3: Verify files exist**

```bash
ls build/
```

Expected: `icon.icns  icon.ico  icon.png`

- [ ] **Step 4: Commit**

```bash
git add scripts/build-icons.js build/icon.ico build/icon.icns
git commit -m "chore: add icon conversion script and generated ico/icns"
```

---

### Task 3: Bundle Playwright Chromium locally

**Files:**
- Create: `scripts/bundle-playwright.js`
- Produces: `playwright-browsers/` directory (~200 MB)

- [ ] **Step 1: Create `scripts/bundle-playwright.js`**

```js
const { execSync } = require('child_process')
const path = require('path')

const browsersPath = path.join(__dirname, '..', 'playwright-browsers')
console.log(`Downloading Playwright Chromium to: ${browsersPath}`)

execSync('npx playwright install chromium', {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
    stdio: 'inherit'
})

console.log('Done. playwright-browsers/ is ready for bundling.')
```

- [ ] **Step 2: Run the script**

```bash
node scripts/bundle-playwright.js
```

Expected: Playwright download progress, ends with `Done. playwright-browsers/ is ready for bundling.`
This downloads ~200 MB — takes 1–3 minutes depending on connection.

- [ ] **Step 3: Verify Chromium downloaded**

```bash
ls playwright-browsers/
```

Expected: a folder like `chromium-NNNN/` containing `chrome-win/` or `chrome-mac/`

- [ ] **Step 4: Add playwright-browsers to .gitignore**

Open `.gitignore` (create it if it doesn't exist) and add:
```
playwright-browsers/
dist-electron/
```

- [ ] **Step 5: Commit**

```bash
git add scripts/bundle-playwright.js .gitignore
git commit -m "chore: add playwright chromium bundler script, ignore browser binaries"
```

---

### Task 4: Create electron-main.js

**Files:**
- Create: `electron-main.js`

- [ ] **Step 1: Create `electron-main.js`**

```js
const { app, Tray, Menu, nativeImage } = require('electron')
const path = require('path')

// Set before any playwright import — points to bundled Chromium in production,
// or the local playwright-browsers/ folder in dev mode
if (app.isPackaged) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'browsers')
} else {
    process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, 'playwright-browsers')
}

app.whenReady().then(() => {
    const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'build', 'icon.png')
        : path.join(__dirname, 'build', 'icon.png')

    const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    const tray = new Tray(trayIcon)

    tray.setToolTip('Luna')
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Luna is running', enabled: false },
        { type: 'separator' },
        { label: 'Quit Luna', click: () => app.quit() }
    ]))

    // Load existing Luna app — runs in Electron's Node.js runtime
    require('./dist/app.js')
})

// Keep process alive when Playwright window is closed by the OS
// (Luna handles its own window lifecycle via Playwright)
app.on('window-all-closed', () => { /* intentionally empty */ })
```

- [ ] **Step 2: Commit**

```bash
git add electron-main.js
git commit -m "feat: add electron-main.js launcher with tray icon"
```

---

### Task 5: Update package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Replace `package.json` with the following**

```json
{
  "name": "luna",
  "version": "1.0.0",
  "description": "",
  "main": "electron-main.js",
  "scripts": {
    "start": "tsc && node dist/app.js",
    "electron:dev": "tsc && electron .",
    "build:icons": "node scripts/build-icons.js",
    "bundle:playwright": "node scripts/bundle-playwright.js",
    "build:win": "tsc && electron-builder --win",
    "build:mac": "tsc && electron-builder --mac"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "type": "commonjs",
  "build": {
    "appId": "com.luna.app",
    "productName": "Luna",
    "directories": {
      "output": "dist-electron"
    },
    "files": [
      "dist/**",
      "electron-main.js",
      "node_modules/**",
      "build/icon.png"
    ],
    "extraResources": [
      { "from": "playwright-browsers/", "to": "browsers/" },
      { "from": "build/", "to": "build/" }
    ],
    "win": {
      "target": "nsis",
      "icon": "build/icon.ico"
    },
    "mac": {
      "target": "dmg",
      "icon": "build/icon.icns"
    },
    "nsis": {
      "oneClick": false,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    }
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.89.0",
    "playwright": "^1.59.1"
  },
  "devDependencies": {
    "@types/node": "^25.5.2",
    "electron": "^36.0.0",
    "electron-builder": "^26.0.0",
    "png2icons": "^2.0.1",
    "ts-node": "^10.9.2",
    "typescript": "^6.0.2"
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "chore: update package.json — electron main, build config, scripts"
```

---

### Task 6: Smoke test in Electron dev mode

**Files:** none — verification only

- [ ] **Step 1: Compile TypeScript**

```bash
npm run build 2>/dev/null || npx tsc
```

Expected: no errors, `dist/` folder updated

- [ ] **Step 2: Run in Electron dev mode**

```bash
npm run electron:dev
```

Expected:
- A Chromium window opens (Playwright) and navigates to the homepage
- A Luna tray icon appears in the system tray
- Right-clicking the tray shows "Luna is running" + "Quit Luna"
- "Quit Luna" closes the window and exits

If the window doesn't open, check the terminal for errors. Common issues:
- `Cannot find module './dist/app.js'` → run `npx tsc` first
- `PLAYWRIGHT_BROWSERS_PATH` errors → re-run `node scripts/bundle-playwright.js`

- [ ] **Step 3: Commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: resolve electron dev mode issues"
```

---

### Task 7: Build Windows installer

**Files:** produces `dist-electron/LunaSetup.exe`
> Run this on Windows

- [ ] **Step 1: Build**

```bash
npm run build:win
```

Expected: progress logs, ends with something like:
```
  • building        target=nsis file=dist-electron/LunaSetup.exe
  • build           success
```
Takes 3–10 minutes (packing ~400 MB).

- [ ] **Step 2: Verify output**

```bash
ls dist-electron/
```

Expected: `LunaSetup.exe` present

- [ ] **Step 3: Install and test**

Double-click `dist-electron/LunaSetup.exe`. Walk through the wizard:
- Choose install directory
- Verify Start Menu entry "Luna" appears
- Verify Desktop shortcut appears
- Launch Luna from Start Menu → Chromium window opens, tray icon appears

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build: windows installer working"
```

---

### Task 8: Build Mac installer

**Files:** produces `dist-electron/Luna.dmg`
> Must be run on a Mac

- [ ] **Step 1: Build**

```bash
npm run build:mac
```

Expected:
```
  • building        target=dmg file=dist-electron/Luna.dmg
  • build           success
```

- [ ] **Step 2: Verify output**

```bash
ls dist-electron/
```

Expected: `Luna.dmg` present

- [ ] **Step 3: Install and test**

Open `Luna.dmg`, drag Luna to `/Applications`. Launch from Spotlight or Applications folder:
- Chromium window opens
- Tray icon appears in menu bar
- Right-click tray → "Quit Luna" exits cleanly

- [ ] **Step 4: Commit**

```bash
git commit -m "build: mac installer working"
```
