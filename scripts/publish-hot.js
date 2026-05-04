/**
 * 热更新发布脚本（仅渲染层代码，无需重新打包 exe）
 * 用法: node scripts/publish-hot.js [--skip-build] [--changelog "修复说明"]
 *
 * 流程：
 * 1. 只构建渲染层代码 (electron-vite build)
 * 2. 将 out/renderer/ 打包成 zip
 * 3. 通过 /api/update/upload 上传到服务器
 * 4. 客户端检测到热更新后下载 zip 并解压到 hot-update 目录
 *
 * 优势：包体小（通常 < 2MB），下载快，无需安装 exe
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const https = require('http')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'out')
const RENDERER_DIR = path.join(OUT_DIR, 'renderer')

const UPDATE_SERVER = 'http://150.158.54.108:3001'
const ADMIN_PASSWORD = 'dianxiaoer2026'

async function main() {
  // 从 package.json 读取版本，热更新版本用 z+1
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
  const baseVersion = pkg.version

  // 解析参数
  const skipBuild = process.argv.includes('--skip-build')
  const changelogIdx = process.argv.indexOf('--changelog')
  const changelog = changelogIdx !== -1 ? process.argv[changelogIdx + 1] : `热更新 ${baseVersion}`

  console.log('=== 店小二热更新发布 ===')
  console.log('基础版本:', baseVersion)
  console.log('更新说明:', changelog)

  // 1. 只构建渲染层（不打包 exe）
  if (skipBuild) {
    console.log('\n[1/4] 跳过构建（使用已有产物）')
  } else {
    console.log('\n[1/4] 构建渲染层代码...')
    execSync('npx electron-vite build', { cwd: ROOT, stdio: 'inherit' })
  }

  // 检查产物
  const indexHtml = path.join(RENDERER_DIR, 'index.html')
  if (!fs.existsSync(indexHtml)) {
    console.error('构建失败：未找到', indexHtml)
    process.exit(1)
  }

  // 2. 打包 renderer 目录为 zip
  console.log('\n[2/4] 打包渲染层代码...')
  const zipPath = path.join(OUT_DIR, `hot-update-${baseVersion}.zip`)

  // 使用 adm-zip 或系统 zip 命令
  try {
    const AdmZip = require('adm-zip')
    const zip = new AdmZip()
    // 添加 version.json
    const versionData = { version: baseVersion, baseVersion, changelog, updatedAt: new Date().toISOString() }
    zip.addFile('version.json', Buffer.from(JSON.stringify(versionData, null, 2)))
    // 添加 renderer 目录
    zip.addLocalFolder(RENDERER_DIR, 'renderer')
    zip.writeZip(zipPath)
  } catch (e) {
    // fallback: 用 powershell 压缩
    console.log('  使用 PowerShell 压缩...')
    const versionData = { version: baseVersion, baseVersion, changelog, updatedAt: new Date().toISOString() }
    const versionFile = path.join(OUT_DIR, 'version.json')
    fs.writeFileSync(versionFile, JSON.stringify(versionData, null, 2))

    // 临时目录结构
    const tempDir = path.join(OUT_DIR, 'hot-update-staging')
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
    fs.mkdirSync(tempDir, { recursive: true })
    fs.copyFileSync(versionFile, path.join(tempDir, 'version.json'))

    const stagingRenderer = path.join(tempDir, 'renderer')
    fs.cpSync(RENDERER_DIR, stagingRenderer, { recursive: true })

    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath)
    execSync(`powershell -Command "Compress-Archive -Path '${tempDir}\\*' -DestinationPath '${zipPath}' -Force"`, { stdio: 'inherit' })

    // 清理临时目录
    fs.rmSync(tempDir, { recursive: true, force: true })
    fs.unlinkSync(versionFile)
  }

  const zipSize = fs.statSync(zipPath).size
  console.log(`  热更新包: ${zipPath} (${(zipSize / 1024).toFixed(1)} KB)`)

  // 计算 SHA256
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(zipPath))
  const sha256 = hash.digest('hex')
  console.log(`  SHA256: ${sha256}`)

  // 3. 上传到服务器
  console.log('\n[3/4] 上传热更新包到服务器...')
  await uploadHotUpdate(zipPath, baseVersion, changelog, sha256)

  // 4. 清理
  console.log('\n[4/4] 清理临时文件...')
  try { fs.unlinkSync(zipPath) } catch (e) {}

  console.log('\n=== 热更新发布完成 v' + baseVersion + ' ===')
  console.log('客户端启动后会自动检测到热更新并提示下载。')
  console.log('热更新包大小:', (zipSize / 1024).toFixed(1), 'KB（远小于全量包的 ~106MB）')
}

function uploadHotUpdate(zipPath, version, changelog, sha256) {
  return new Promise((resolve, reject) => {
    const fileData = fs.readFileSync(zipPath)
    const fileName = path.basename(zipPath)

    // 构建 multipart/form-data
    const boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex')
    const parts = []

    // version 字段
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="version"\r\n\r\n${version}\r\n`))
    // changelog 字段
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="changelog"\r\n\r\n${changelog}\r\n`))
    // sha256 字段
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="sha256"\r\n\r\n${sha256}\r\n`))
    // baseVersion 字段
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="baseVersion"\r\n\r\n${version}\r\n`))
    // file 字段
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`))
    parts.push(fileData)
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    const url = new URL(`${UPDATE_SERVER}/api/update/upload`)
    const req = https.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'x-admin-password': ADMIN_PASSWORD
      }
    }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('  上传成功:', data)
          resolve()
        } else {
          reject(new Error(`上传失败: HTTP ${res.statusCode} ${data}`))
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

main().catch(e => {
  console.error('[HotDeploy] 发布失败:', e.message, e.stack)
  process.exit(1)
})
