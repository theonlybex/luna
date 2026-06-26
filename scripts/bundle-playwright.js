const { execSync } = require('child_process')
const path = require('path')

const browsersPath = path.join(__dirname, '..', 'playwright-browsers')
console.log(`Downloading Playwright Chromium to: ${browsersPath}`)

execSync('npx playwright install chromium', {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
    stdio: 'inherit'
})

console.log('Done. playwright-browsers/ is ready for bundling.')
