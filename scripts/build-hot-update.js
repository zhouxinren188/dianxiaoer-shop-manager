/**
 * 热更新打包脚本
 * 用法: node scripts/build-hot-update.js [version]
 * 示例: node scripts/build-hot-update.js 1.0.1
 *
 * 流程：
 * 1. 运行 electron-vite build 构建前端
 * 2. 将 out/renderer 打包为 zip
 * 3. 写入 version.json
 * 4. 可选上传到更新服务器
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const AdmZip = require('adm-zip')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'out')
const DIST_DIR = path.join(ROOT, 'dist')

const UPDATE_SERVER = 'http://150.158.54.108:3001'
const ADMIN_PASSWORD = 'dianxiaoer2026'

// 从命令行参数或 package.json 读取版本
let version = process.argv[2]
if (!version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
  version = pkg.version
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('版本号格式错误，应为 x.y.z，当前:', version)
  process.exit(1)
}

console.log('=== 店小二热更新打包 ===')
console.log('版本:', version)

// 1. 构建前端
console.log('\n[1/4] 构建前端...')
execSync('npx electron-vite build', { cwd: ROOT, stdio: 'inherit' })

// 2. 检查输出目录
const rendererDir = path.join(OUT_DIR, 'renderer')
if (!fs.existsSync(path.join(rendererDir, 'index.html'))) {
  console.error('构建输出不完整，未找到 out/renderer/index.html')
  process.exit(1)
}

// 3. 打包 zip
console.log('\n[2/4] 打包 zip...')
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
console.log(`打包完成: ${zipPath} (${(zipSize / 1024).toFixed(1)} KB)`)

// 4. 上传到服务器
const shouldUpload = process.argv.includes('--upload')
if (shouldUpload) {
  console.log('\n[3/4] 上传到更新服务器...')
  uploadToServer(zipPath, version)
} else {
  console.log('\n[3/4] 跳过上传（添加 --upload 参数自动上传）')
  console.log('\n[4/4] 完成！')
  console.log('\n手动上传命令:')
  console.log(`  curl -X POST ${UPDATE_SERVER}/api/update/upload \\`)
  console.log(`    -H "x-admin-password: ${ADMIN_PASSWORD}" \\`)
  console.log(`    -F "file=@${zipPath}" \\`)
  console.log(`    -F "version=${version}" \\`)
  console.log(`    -F "changelog=热更新 v${version}"`)
}

function uploadToServer(filePath, ver) {
  const http = require('http')
  const url = new URL(`${UPDATE_SERVER}/api/update/upload`)

  const boundary = '----FormBoundary' + Date.now().toString(16)
  const fileData = fs.readFileSync(filePath)
  const fileName = path.basename(filePath)

  const parts = []
  // version 字段
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="version"\r\n\r\n${ver}`)
  // changelog 字段
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="changelog"\r\n\r\n热更新 v${ver}`)
  // file 字段
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`)

  const tail = `\r\n--${boundary}--\r\n`
  const head = parts.join('\r\n') + '\r\n'
  const headBuf = Buffer.from(head, 'utf-8')
  const tailBuf = Buffer.from(tail, 'utf-8')
  const bodyLength = headBuf.length + fileData.length + tailBuf.length

  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': bodyLength,
      'x-admin-password': ADMIN_PASSWORD
    }
  }

  const req = http.request(options, (res) => {
    let data = ''
    res.on('data', (chunk) => (data += chunk))
    res.on('end', () => {
      if (res.statusCode === 200) {
        console.log('上传成功:', data)
        console.log('\n[4/4] 完成！热更新已发布 v' + ver)
      } else {
        console.error('上传失败:', res.statusCode, data)
        process.exit(1)
      }
    })
  })

  req.on('error', (e) => {
    console.error('上传请求失败:', e.message)
    process.exit(1)
  })

  req.write(headBuf)
  req.write(fileData)
  req.write(tailBuf)
  req.end()
}
