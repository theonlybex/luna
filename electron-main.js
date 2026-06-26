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
