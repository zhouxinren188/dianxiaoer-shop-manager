/**
 * 热更新打包脚本
 * 用法: node scripts/build-hot-update.js [version] [--main] [--main-only] [--upload] [--base=x.y.z]
 *
 * 参数：
 *   [version]     版本号，默认取 package.json
 *   --main        包含主进程热更新（同时包含 renderer）
 *   --main-only   仅包含主进程热更新（不含 renderer）
 *   --upload      自动上传到更新服务器
 *   --base=x.y.z  指定 baseVersion
 *
 * 流程：
 * 1. 运行 electron-vite build 构建前端（+ 主进程如果 --main）
 * 2. 可选 bytenode 编译主进程
 * 3. 将输出打包为 zip
 * 4. 写入 version.json
 * 5. 可选上传到更新服务器
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const AdmZip = require('adm-zip')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'out')
const DIST_DIR = path.join(ROOT, 'dist')

const UPDATE_SERVER = 'http://150.158.54.108:3001'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Dxe@2026!Admin'

// 从命令行参数或 package.json 读取版本
const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
let version = args[0] || pkg.version

// 解析 --main / --main-only / --upload 标志
const includeMain = process.argv.includes('--main') || process.argv.includes('--main-only')
const mainOnly = process.argv.includes('--main-only')
const shouldUpload = process.argv.includes('--upload')

// baseVersion: 热更新所依赖的最低基础版本，支持 --base=1.3.11 指定
let baseVersion = pkg.version
const baseArg = process.argv.find(arg => arg.startsWith('--base='))
if (baseArg) {
  baseVersion = baseArg.split('=')[1]
  console.log('baseVersion override:', baseVersion)
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('版本号格式错误，应为 x.y.z，当前:', version)
  process.exit(1)
}

console.log('=== 店小二热更新打包 ===')
console.log('版本:', version)
console.log('包含主进程:', includeMain ? '是' : '否')
if (mainOnly) console.log('仅主进程: 是')

// 1. 构建
if (includeMain) {
  console.log('\n[1/5] 构建全部（main + preload + renderer）...')
  execSync('npx electron-vite build', { cwd: ROOT, stdio: 'inherit' })
} else {
  console.log('\n[1/5] 构建前端...')
  execSync('npx electron-vite build', { cwd: ROOT, stdio: 'inherit' })
}

// 2. 主进程字节码编译（如果 --main）
let mainJscSha256 = ''
let preloadJscSha256 = ''
if (includeMain) {
  console.log('\n[2/5] 编译主进程字节码...')
  execSync('node ' + path.join(ROOT, 'scripts', 'compile-bytecode.js'), { cwd: ROOT, stdio: 'inherit' })

  // 计算 .jsc 文件的 SHA256
  const mainJscPath = path.join(OUT_DIR, 'main', 'index.jsc')
  const preloadJscPath = path.join(OUT_DIR, 'preload', 'index.jsc')

  if (fs.existsSync(mainJscPath)) {
    mainJscSha256 = crypto.createHash('sha256').update(fs.readFileSync(mainJscPath)).digest('hex')
    console.log('main/index.jsc SHA256:', mainJscSha256)
  } else {
    console.error('错误: 编译后未找到 out/main/index.jsc')
    process.exit(1)
  }

  if (fs.existsSync(preloadJscPath)) {
    preloadJscSha256 = crypto.createHash('sha256').update(fs.readFileSync(preloadJscPath)).digest('hex')
    console.log('preload/index.jsc SHA256:', preloadJscSha256)
  }
} else {
  console.log('\n[2/5] 跳过主进程编译（非 --main 模式）')
}

// 3. 检查输出目录
const rendererDir = path.join(OUT_DIR, 'renderer')
const hasRenderer = !mainOnly && fs.existsSync(path.join(rendererDir, 'index.html'))

if (!hasRenderer && !includeMain) {
  console.error('构建输出不完整，未找到 out/renderer/index.html')
  process.exit(1)
}

// 4. 打包 zip
console.log('\n[3/5] 打包 zip...')
if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true })

const zip = new AdmZip()

// 添加 renderer
if (hasRenderer) {
  zip.addLocalFolder(rendererDir, 'renderer')
}

// 添加主进程文件
if (includeMain) {
  // main/index.jsc + main/index.js (loader stub)
  const mainJscPath = path.join(OUT_DIR, 'main', 'index.jsc')
  const mainJsPath = path.join(OUT_DIR, 'main', 'index.js')
  const purchasePreloadPath = path.join(OUT_DIR, 'main', 'purchase-preload.js')

  if (fs.existsSync(mainJscPath)) {
    zip.addLocalFile(mainJscPath, 'main')
    console.log('  添加 main/index.jsc')
  }
  if (fs.existsSync(mainJsPath)) {
    zip.addLocalFile(mainJsPath, 'main')
    console.log('  添加 main/index.js (loader stub)')
  }
  if (fs.existsSync(purchasePreloadPath)) {
    zip.addLocalFile(purchasePreloadPath, 'main')
    console.log('  添加 main/purchase-preload.js')
  }

  // preload/index.jsc + preload/index.js
  const preloadJscPath = path.join(OUT_DIR, 'preload', 'index.jsc')
  const preloadJsPath = path.join(OUT_DIR, 'preload', 'index.js')

  if (fs.existsSync(preloadJscPath)) {
    zip.addLocalFile(preloadJscPath, 'preload')
    console.log('  添加 preload/index.jsc')
  }
  if (fs.existsSync(preloadJsPath)) {
    zip.addLocalFile(preloadJsPath, 'preload')
    console.log('  添加 preload/index.js (loader stub)')
  }
}

// 写入 version.json
const versionData = {
  version,
  baseVersion,
  buildTime: new Date().toISOString()
}
if (includeMain) {
  versionData.mainUpdate = true
  versionData.electronVersion = pkg.devDependencies?.electron || process.versions?.electron || ''
  versionData.mainSha256 = mainJscSha256
  versionData.preloadSha256 = preloadJscSha256
}

zip.addFile('version.json', Buffer.from(JSON.stringify(versionData, null, 2)))

const zipFilename = `update-${version}.zip`
const zipPath = path.join(DIST_DIR, zipFilename)
zip.writeZip(zipPath)

const zipSize = fs.statSync(zipPath).size
const zipSha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')
console.log(`\n打包完成: ${zipPath} (${(zipSize / 1024).toFixed(1)} KB)`)
console.log(`SHA256: ${zipSha256}`)

// 5. 上传到服务器
if (shouldUpload) {
  console.log('\n[4/5] 上传到更新服务器...')
  uploadToServer(zipPath, version, zipSha256)
} else {
  console.log('\n[4/5] 跳过上传（添加 --upload 参数自动上传）')
  console.log('\n[5/5] 完成！')
  console.log('\n手动上传命令:')
  console.log(`  node scripts/build-hot-update.js${includeMain ? ' --main' : ''} --upload`)
}

function uploadToServer(filePath, ver, sha256) {
  const http = require('http')
  const url = new URL(`${UPDATE_SERVER}/api/update/upload`)

  const boundary = '----FormBoundary' + Date.now().toString(16)
  const fileData = fs.readFileSync(filePath)
  const fileName = path.basename(filePath)

  const parts = []
  // version 字段
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="version"\r\n\r\n${ver}`)
  // changelog 字段
  const changelog = includeMain ? `主进程+渲染层热更新 v${ver}` : `热更新 v${ver}`
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="changelog"\r\n\r\n${changelog}`)
  // sha256 字段
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="sha256"\r\n\r\n${sha256}`)
  // baseVersion 字段
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="baseVersion"\r\n\r\n${baseVersion}`)
  // type 字段（主进程热更新标记）
  if (includeMain) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\nmain`)
  }
  // electronVersion 字段
  if (includeMain && versionData.electronVersion) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="electronVersion"\r\n\r\n${versionData.electronVersion}`)
  }
  // mainSha256 字段
  if (includeMain && mainJscSha256) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="mainSha256"\r\n\r\n${mainJscSha256}`)
  }
  // preloadSha256 字段
  if (includeMain && preloadJscSha256) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="preloadSha256"\r\n\r\n${preloadJscSha256}`)
  }
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
    rejectUnauthorized: false,
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
        console.log('\n[5/5] 完成！热更新已发布 v' + ver)
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
