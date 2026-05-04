/**
 * 全量发布脚本
 * 用法: node scripts/publish-full.js [--skip-build]
 *
 * 流程：
 * 1. 构建 + 打包安装程序 (electron-vite build && electron-builder --win)
 * 2. 通过 SFTP 上传 .exe + latest.yml + .blockmap 到服务器 /updates/ 目录
 * 3. 部署最新 server-api/index.js 到 dianxiaoer-api 服务器
 * 4. 调用 /api/update/notify-full 通知服务器登记全量版本
 *
 * --skip-build: 跳过构建步骤，使用 dist/ 下已有的产物直接发布
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

// SSH 连接配置
const SSH_CONFIG = { host: HOST, port: SSH_PORT, username: USERNAME, password: PASSWORD, readyTimeout: 60000, keepaliveInterval: 10000 }

// 创建新的 SSH 连接
function createConnection() {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    conn.on('ready', () => resolve(conn))
    conn.on('error', reject)
    conn.connect({ ...SSH_CONFIG })
  })
}

// 通过 SSH 执行命令
function execCmd(conn, cmd) {
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

// SFTP 上传单个文件
function sftpUpload(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(localPath)
    const size = fs.statSync(localPath).size
    console.log(`  上传 ${fileName} (${(size / 1024 / 1024).toFixed(1)} MB)...`)
    const readStream = fs.createReadStream(localPath)
    const writeStream = sftp.createWriteStream(remotePath)
    writeStream.on('close', () => {
      console.log(`  ${fileName} 上传完成`)
      resolve()
    })
    writeStream.on('error', reject)
    readStream.on('error', reject)
    readStream.pipe(writeStream)
  })
}

// 在一个 SSH 连接上执行一组上传任务，完成后关闭连接
async function uploadFiles(files) {
  const conn = await createConnection()
  console.log('[Deploy] 已连接服务器')
  try {
    // 确保远程 updates 目录存在
    await execCmd(conn, `powershell -Command "New-Item -ItemType Directory -Force -Path '${REMOTE_UPDATE_DIR}'"`)

    // 获取 SFTP 通道
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => err ? reject(err) : resolve(sftp))
    })

    for (const { local, remote } of files) {
      await sftpUpload(sftp, local, remote)
    }

    sftp.end()
  } finally {
    conn.end()
  }
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

async function main() {
  // 从 package.json 读取版本
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
  const version = pkg.version

  console.log('=== 店小二全量发布 ===')
  console.log('版本:', version)

  // 1. 构建
  const skipBuild = process.argv.includes('--skip-build')
  if (skipBuild) {
    console.log('\n[1/5] 跳过构建（使用已有产物）')
  } else {
    console.log('\n[1/5] 构建安装程序...')
    execSync('npx electron-vite build && npx electron-builder --win', { cwd: ROOT, stdio: 'inherit' })
  }

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

  // 2. SFTP 上传安装包（独立连接，上传后关闭避免连接不稳）
  console.log('\n[2/5] 连接服务器...')
  console.log('\n[3/5] 上传安装包到服务器...')
  await uploadFiles([
    { local: exeFile, remote: `${REMOTE_UPDATE_DIR}/dianxiaoer-setup-${version}.exe` }
  ])
  console.log('  安装包上传完成，断开连接')

  // 等待连接完全释放
  await new Promise(r => setTimeout(r, 3000))

  // 3. 上传小文件 + 服务端代码（新连接）
  console.log('\n[4/5] 部署服务端代码及更新文件...')
  const smallFiles = [
    { local: ymlFile, remote: `${REMOTE_UPDATE_DIR}/latest.yml` }
  ]
  if (fs.existsSync(blockmapFile)) {
    smallFiles.push({ local: blockmapFile, remote: `${REMOTE_UPDATE_DIR}/dianxiaoer-setup-${version}.exe.blockmap` })
  }
  const localServerFile = path.join(ROOT, 'server-api', 'index.js')
  const localPkgFile = path.join(ROOT, 'server-api', 'package.json')
  smallFiles.push({ local: localServerFile, remote: `${REMOTE_DIR}/index.js` })
  smallFiles.push({ local: localPkgFile, remote: `${REMOTE_DIR}/package.json` })

  await uploadFiles(smallFiles)

  // 4. 远程安装依赖 + 重启服务（新连接）
  console.log('  安装依赖并重启服务...')
  const conn3 = await createConnection()
  try {
    await execCmd(conn3, `cd /d "${REMOTE_DIR}" && npm install --production`)
    console.log('  重启服务...')
    await execCmd(conn3, `${NSSM} restart dianxiaoer-api`)
    await new Promise(r => setTimeout(r, 5000))
    const health = await execCmd(conn3, 'curl -sk https://localhost:3001/api/health')
    console.log('  Health:', health.stdout.trim())
  } finally {
    conn3.end()
  }

  // 5. 通知服务器登记全量版本
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

    // 通过新 SSH 连接更新远程 meta 文件
    const conn4 = await createConnection()
    try {
      const remoteMetaPath = `${REMOTE_UPDATE_DIR}/update-meta.json`
      const metaContent = JSON.stringify(meta, null, 2)
      const sftp = await new Promise((resolve, reject) => {
        conn4.sftp((err, sftp) => err ? reject(err) : resolve(sftp))
      })
      await new Promise((resolve, reject) => {
        sftp.writeFile(remoteMetaPath, metaContent, 'utf8', (err) => {
          if (err) return reject(err)
          console.log('  已手动更新服务器上的 update-meta.json')
          resolve()
        })
      })
      sftp.end()
    } finally {
      conn4.end()
    }
  }

  console.log('\n=== 全量发布完成 v' + version + ' ===')
  console.log('客户端启动后会自动检测到全量更新并提示安装。')
}

main().catch(e => {
  console.error('[Deploy] 发布失败:', e.message, e.stack)
  process.exit(1)
})
