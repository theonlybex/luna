const { chromium } = require('playwright')
const path = require('path')
const fs = require('fs')

const html = `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; }
  body { width: 512px; height: 512px; overflow: hidden; background: transparent; }
</style>
</head>
<body>
<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="moonGlow" cx="42%" cy="50%" r="55%">
      <stop offset="0%" stop-color="#FFF9C4" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#FFF9C4" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="bgGrad" cx="50%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#112244"/>
      <stop offset="100%" stop-color="#060D1F"/>
    </radialGradient>
  </defs>

  <!-- Background -->
  <rect width="512" height="512" fill="url(#bgGrad)" rx="90"/>

  <!-- Stars -->
  <circle cx="85"  cy="62"  r="2.5" fill="white" opacity="0.95"/>
  <circle cx="152" cy="40"  r="1.5" fill="white" opacity="0.70"/>
  <circle cx="310" cy="72"  r="2.0" fill="white" opacity="0.85"/>
  <circle cx="408" cy="55"  r="2.5" fill="white" opacity="0.90"/>
  <circle cx="438" cy="118" r="1.5" fill="white" opacity="0.60"/>
  <circle cx="62"  cy="168" r="1.5" fill="white" opacity="0.75"/>
  <circle cx="448" cy="208" r="2.0" fill="white" opacity="0.80"/>
  <circle cx="390" cy="330" r="1.5" fill="white" opacity="0.70"/>
  <circle cx="428" cy="388" r="2.0" fill="white" opacity="0.85"/>
  <circle cx="72"  cy="390" r="2.5" fill="white" opacity="0.90"/>
  <circle cx="128" cy="448" r="1.5" fill="white" opacity="0.65"/>
  <circle cx="358" cy="458" r="2.0" fill="white" opacity="0.75"/>
  <circle cx="52"  cy="308" r="1.5" fill="white" opacity="0.80"/>
  <circle cx="202" cy="98"  r="1.0" fill="white" opacity="0.55"/>
  <circle cx="462" cy="302" r="1.5" fill="white" opacity="0.65"/>
  <circle cx="322" cy="432" r="2.0" fill="white" opacity="0.70"/>
  <circle cx="172" cy="472" r="1.0" fill="white" opacity="0.50"/>
  <circle cx="490" cy="160" r="1.5" fill="white" opacity="0.60"/>
  <circle cx="30"  cy="240" r="1.0" fill="white" opacity="0.55"/>
  <circle cx="480" cy="440" r="1.5" fill="white" opacity="0.65"/>
  <circle cx="260" cy="50"  r="1.0" fill="white" opacity="0.50"/>
  <circle cx="35"  cy="480" r="1.5" fill="white" opacity="0.55"/>

  <!-- Moon ambient glow -->
  <circle cx="260" cy="258" r="148" fill="url(#moonGlow)"/>

  <!-- Crescent moon: full disk minus shadow -->
  <circle cx="256" cy="256" r="118" fill="#FFF9C4"/>
  <circle cx="308" cy="234" r="100" fill="#060D1F"/>
  <!-- Slight inner-edge brightening on the lit side -->
  <circle cx="256" cy="256" r="118" fill="none" stroke="#FFFDE7" stroke-width="3" opacity="0.4"/>
</svg>
</body>
</html>`

async function generate() {
    if (!fs.existsSync('build')) fs.mkdirSync('build')

    const browser = await chromium.launch()
    const page = await browser.newPage()
    await page.setViewportSize({ width: 512, height: 512 })
    await page.setContent(html, { waitUntil: 'networkidle' })
    await page.screenshot({
        path: path.join('build', 'icon.png'),
        omitBackground: true
    })
    await browser.close()
    console.log('Generated: build/icon.png')
}

generate().catch(err => { console.error(err); process.exit(1) })
