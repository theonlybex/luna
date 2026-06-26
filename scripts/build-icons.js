const png2icons = require('png2icons')
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs')
const path = require('path')

const buildDir = path.join(__dirname, '..', 'build')
const iconPath = path.join(buildDir, 'icon.png')
const icoPath = path.join(buildDir, 'icon.ico')
const icnsPath = path.join(buildDir, 'icon.icns')

if (!existsSync(iconPath)) {
    throw new Error(`Source file not found: ${iconPath}`)
}

const src = readFileSync(iconPath)

if (!existsSync(buildDir)) {
    mkdirSync(buildDir)
}

const ico = png2icons.createICO(src, png2icons.BILINEAR, 0, false, true)
if (!ico) throw new Error('ICO conversion failed')
writeFileSync(icoPath, ico)
console.log('Generated: build/icon.ico')

const icns = png2icons.createICNS(src, png2icons.BILINEAR, 0)
if (!icns) throw new Error('ICNS conversion failed')
writeFileSync(icnsPath, icns)
console.log('Generated: build/icon.icns')
