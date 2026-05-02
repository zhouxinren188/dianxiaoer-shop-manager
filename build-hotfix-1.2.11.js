const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const AdmZip = require('adm-zip')

const ROOT = path.join(__dirname)
const OUT_DIR = path.join(ROOT, 'out')
const DIST_DIR = path.join(ROOT, 'dist')

const version = '1.2.11'

console.log('=== 店小二热更新打包 ===')
console.log('版本:', version)

// 检查输出目录
const rendererDir = path.join(OUT_DIR, 'renderer')
if (!fs.existsSync(path.join(rendererDir, 'index.html'))) {
  console.error('构建输出不完整')
  process.exit(1)
}

// 打包 zip
console.log('\n打包 zip...')
if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true })

const zip = new AdmZip()
zip.addLocalFolder(rendererDir, 'renderer')
zip.addFile('version.json', Buffer.from(JSON.stringify({
  version,
  buildTime: new Date().toISOString()
}, null, 2)))

const zipFilename = `update-${version}.zip`
const zipPath = path.join(DIST_DIR, zipFilename)
zip.writeZip(zipPath)

const zipSize = fs.statSync(zipPath).size
const zipSha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')
console.log(`打包完成: ${zipPath} (${(zipSize / 1024).toFixed(1)} KB)`)
console.log(`SHA256: ${zipSha256}`)

// 输出上传信息
console.log('\n热更新包信息:')
console.log('版本:', version)
console.log('文件大小:', zipSize)
console.log('SHA256:', zipSha256)
console.log('更新说明: 修复新增店铺后列表不刷新问题')
