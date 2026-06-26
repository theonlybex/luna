# Luna Desktop Installer — Design Spec
Date: 2026-04-19

## Goal
Make Luna installable for non-technical users on Windows and Mac. Download, double-click, done. No terminal, no Node.js, no npm required.

## Approach: Thin Electron Shell (OpenClaw pattern)
Zero changes to existing Luna source code. A new `electron-main.js` file acts as a launcher — it sets up the environment and loads the existing `dist/app.js` inside Electron's Node.js runtime. `electron-builder` produces the platform installers.

## New Files
- `electron-main.js` — Electron entry point (~60 lines). Sets `PLAYWRIGHT_BROWSERS_PATH` to the bundled Chromium location, then requires `dist/app.js`. Creates a system tray icon with a Quit option.
- `scripts/generate-icon.js` — Already created. Generates `build/icon.png` using Playwright.
- `build/icon.png` — Already generated. Dark navy + crescent moon + stars.
- `scripts/build-icons.js` — Converts `build/icon.png` → `build/icon.ico` (Windows) and `build/icon.icns` (Mac) using `png2icons`.
- `scripts/bundle-playwright.js` — Runs `playwright install chromium` with `PLAYWRIGHT_BROWSERS_PATH=./playwright-browsers` to pre-download Chromium into the repo for bundling.

## Changes to Existing Files
- `package.json` — Add `electron` + `electron-builder` + `png2icons` as devDependencies. Change `"main"` to `"electron-main.js"`. Add `"build"` config block. Add build scripts.

## electron-builder Config
```json
{
  "appId": "com.luna.app",
  "productName": "Luna",
  "files": ["dist/**", "electron-main.js", "node_modules/**"],
  "extraResources": [{ "from": "playwright-browsers/", "to": "browsers/" }],
  "win": { "target": "nsis", "icon": "build/icon.ico" },
  "mac": { "target": "dmg", "icon": "build/icon.icns" },
  "nsis": {
    "oneClick": false,
    "createDesktopShortcut": true,
    "createStartMenuShortcut": true
  }
}
```

## Playwright Chromium Bundling
Playwright downloads its Chromium to a user's home directory by default. Packaged apps can't rely on that. Solution:
1. Pre-download Chromium to `./playwright-browsers/` (via `scripts/bundle-playwright.js`)
2. Include that folder as `extraResources` in electron-builder
3. In `electron-main.js`, set `PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'browsers')` before loading the app

## Build Scripts Added to package.json
| Script | What it does |
|---|---|
| `npm run build:icons` | PNG → ICO + ICNS |
| `npm run bundle:playwright` | Download Chromium to ./playwright-browsers/ |
| `npm run build:win` | Full Windows build → dist-electron/LunaSetup.exe |
| `npm run build:mac` | Full Mac build → dist-electron/Luna.dmg |
| `npm run electron:dev` | Run in Electron without packaging (for testing) |

## Output
- `dist-electron/LunaSetup.exe` — Windows NSIS installer with Start Menu + Desktop shortcut
- `dist-electron/Luna.dmg` — Mac disk image

## App Size Estimate
~350–450 MB (Electron ~120MB + Playwright Chromium ~200MB + Luna app ~30MB)

## What Is NOT Changed
- `src/` — untouched
- `dist/` — untouched (still compiled by `tsc` as before)
- `.env` handling — untouched
- All agent/browser/settings logic — untouched
