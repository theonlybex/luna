/**
 * patch-chromium-icon.js
 * Stamps the Luna icon and product name onto the Playwright Chromium binary
 * so Windows shows the correct icon and name in the taskbar.
 *
 * Run once after `npm install` or whenever playwright browsers are updated:
 *   node scripts/patch-chromium-icon.js
 */

const { execFileSync } = require('child_process')
const path = require('path')
const fs   = require('fs')

const root     = path.resolve(__dirname, '..')
const rcedit   = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe')
const iconPath = path.join(root, 'build', 'icon.ico')

// Find the Playwright Chromium binary
const browsersDir = path.join(root, 'playwright-browsers')
let chromiumExe = null

if (fs.existsSync(browsersDir)) {
  for (const dir of fs.readdirSync(browsersDir)) {
    const candidate = path.join(browsersDir, dir, 'chrome-win64', 'chrome.exe')
    if (fs.existsSync(candidate)) { chromiumExe = candidate; break }
    const candidate2 = path.join(browsersDir, dir, 'chrome-win', 'chrome.exe')
    if (fs.existsSync(candidate2)) { chromiumExe = candidate2; break }
  }
}

if (!chromiumExe) {
  console.error('[patch] Chromium binary not found in playwright-browsers/. Run `npx playwright install chromium` first.')
  process.exit(1)
}

if (!fs.existsSync(rcedit)) {
  console.error('[patch] rcedit.exe not found. Run `npm install` first.')
  process.exit(1)
}

if (!fs.existsSync(iconPath)) {
  console.error('[patch] build/icon.ico not found. Run `npm run build:icons` first.')
  process.exit(1)
}

console.log(`[patch] Patching: ${chromiumExe}`)

try {
  execFileSync(rcedit, [
    chromiumExe,
    '--set-icon', iconPath,
    '--set-version-string', 'FileDescription', 'Luna Chroma',
    '--set-version-string', 'ProductName',     'Luna Chroma',
  ])
  console.log('[patch] Done — restart the app to see the new icon.')
} catch (err) {
  console.error('[patch] rcedit failed:', err.message)
  process.exit(1)
}
