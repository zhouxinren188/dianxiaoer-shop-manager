/**
 * 全量发布脚本
 * 用法: node scripts/publish-full.js
 *
 * 流程：
 * 1. 构建 + 打包安装程序 (electron-vite build && electron-builder --win)
 * 2. 通过 SFTP 上传 .exe + latest.yml + .blockmap 到服务器 /updates/ 目录
 * 3. 部署最新 server-api/index.js 到 dianxiaoer-api 服务器
 * 4. 调用 /api/update/notify-full 通知服务器登记全量版本
 */
const { execSync } = require('child_process')
const { Client } = require('ssh2')
const https = require('https')
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..')
const DIST_DIR = path.join(ROOT, 'dist')

const HOST = '150.158.54.108'
const SSH_PORT = 22
const USERNAME = 'administrator'
const PASSWORD = 'K9#m2$vL5@zQ'
const REMOTE_DIR = 'C:/Users/Administrator/dianxiaoer-api'
const REMOTE_UPDATE_DIR = `${REMOTE_DIR}/updates`
const NSSM = 'C:/nssm/nssm.exe'
const UPDATE_SERVER = 'https://150.158.54.108:3001'
const ADMIN_PASSWORD = 'dianxiaoer2026'

// 从 package.json 读取版本
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
const version = pkg.version

console.log('=== 店小二全量发布 ===')
console.log('版本:', version)

// 1. 构建
console.log('\n[1/5] 构建安装程序...')
execSync('npx electron-vite build && npx electron-builder --win', { cwd: ROOT, stdio: 'inherit' })

// 检查产物
const exeFile = path.join(DIST_DIR, `dianxiaoer-setup-${version}.exe`)
const ymlFile = path.join(DIST_DIR, 'latest.yml')
const blockmapFile = path.join(DIST_DIR, `dianxiaoer-setup-${version}.exe.blockmap`)

if (!fs.existsSync(exeFile)) {
  console.error('构建失败：未找到', exeFile)
  process.exit(1)
}
if (!fs.existsSync(ymlFile)) {
  console.error('构建失败：未找到 latest.yml')
  process.exit(1)
}

const exeSize = fs.statSync(exeFile).size
console.log(`安装包: ${exeFile} (${(exeSize / 1024 / 1024).toFixed(1)} MB)`)

// 2. SFTP 上传
console.log('\n[2/5] 连接服务器...')

const conn = new Client()

function exec(cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      stream.on('data', d => stdout += d.toString())
      stream.stderr.on('data', d => stderr += d.toString())
      stream.on('close', () => resolve({ stdout, stderr }))
    })
  })
}

function sftpUpload(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(localPath)
    const size = fs.statSync(localPath).size
    console.log(`  上传 ${fileName} (${(size / 1024 / 1024).toFixed(1)} MB)...`)
    sftp.fastPut(localPath, remotePath, (err) => {
      if (err) return reject(err)
      console.log(`  ${fileName} 上传完成`)
      resolve()
    })
  })
}

function notifyServer(ver) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ version: ver, changelog: `全量更新 v${ver}` })
    const url = new URL(`${UPDATE_SERVER}/api/update/notify-full`)
    const req = https.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-admin-password': ADMIN_PASSWORD
      }
    }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data)
        else reject(new Error(`HTTP ${res.statusCode}: ${data}`))
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

conn.on('ready', async () => {
  console.log('[Deploy] 已连接服务器')

  try {
    // 确保远程 updates 目录存在
    await exec(`powershell -Command "New-Item -ItemType Directory -Force -Path '${REMOTE_UPDATE_DIR}'"`)

    // 获取 SFTP 通道
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => err ? reject(err) : resolve(sftp))
    })

    // 3. 上传安装包文件
    console.log('\n[3/5] 上传安装包到服务器...')
    await sftpUpload(sftp, exeFile, `${REMOTE_UPDATE_DIR}/dianxiaoer-setup-${version}.exe`)
    await sftpUpload(sftp, ymlFile, `${REMOTE_UPDATE_DIR}/latest.yml`)
    if (fs.existsSync(blockmapFile)) {
      await sftpUpload(sftp, blockmapFile, `${REMOTE_UPDATE_DIR}/dianxiaoer-setup-${version}.exe.blockmap`)
    }

    // 4. 上传最新 server-api/index.js 并重启服务
    console.log('\n[4/5] 部署服务端代码...')
    const localServerFile = path.join(ROOT, 'server-api', 'index.js')
    await sftpUpload(sftp, localServerFile, `${REMOTE_DIR}/index.js`)
    const localPkgFile = path.join(ROOT, 'server-api', 'package.json')
    await sftpUpload(sftp, localPkgFile, `${REMOTE_DIR}/package.json`)

    // 远程安装依赖
    console.log('  安装依赖...')
    await exec(`cd /d "${REMOTE_DIR}" && npm install --production`)

    console.log('  重启服务...')
    await exec(`${NSSM} restart dianxiaoer-api`)
    await new Promise(r => setTimeout(r, 5000))

    // 验证服务健康
    const health = await exec('curl -sk https://localhost:3001/api/health')
    console.log('  Health:', health.stdout.trim())

    // 5. 通知服务器登记全量版本（如果失败则手动更新）
    console.log('\n[5/5] 通知服务器登记全量版本...')
    try {
      const result = await notifyServer(version)
      console.log('  服务器响应:', result)
    } catch (e) {
      console.log('  通知服务器失败（SSL 错误），使用 SSH 手动更新 update-meta.json...')
      
      // 读取当前 meta 并更新 fullUpdate
      const metaFile = path.join(ROOT, 'server-api', 'updates', 'update-meta.json')
      let meta = {}
      try {
        meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
      } catch (err) {
        console.log('  本地 meta 文件不存在，创建新的...')
      }
      
      meta.fullUpdate = {
        version: version,
        url: `http://${HOST}:3001/updates/dianxiaoer-setup-${version}.exe`,
        sha512: '',
        size: exeSize,
        changelog: `全量更新 v${version}`
      }
      meta.latestVersion = version
      meta.releaseDate = new Date().toISOString()
      
      // 通过 SSH 更新远程 meta 文件
      const remoteMetaPath = `${REMOTE_UPDATE_DIR}/update-meta.json`
      const metaContent = JSON.stringify(meta, null, 2)
      
      await new Promise((resolve, reject) => {
        conn.sftp((err, sftp) => {
          if (err) return reject(err)
          sftp.writeFile(remoteMetaPath, metaContent, 'utf8', (err) => {
            if (err) return reject(err)
            console.log('  已手动更新服务器上的 update-meta.json')
            resolve()
          })
        })
      })
    }

    console.log('\n=== 全量发布完成 v' + version + ' ===')
    console.log('客户端启动后会自动检测到全量更新并提示安装。')

    conn.end()
    process.exit(0)
  } catch (e) {
    console.error('[Deploy] 发布失败:', e.message)
    conn.end()
    process.exit(1)
  }
}).on('error', (err) => {
  console.error('[Deploy] 连接失败:', err.message)
  process.exit(1)
})

conn.connect({ host: HOST, port: SSH_PORT, username: USERNAME, password: PASSWORD, readyTimeout: 30000 })
