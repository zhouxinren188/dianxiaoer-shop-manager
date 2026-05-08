const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')
const http = require('http')

const HOST = '150.158.54.108'
const PORT = 22
const USERNAME = 'administrator'
const KEY_PATH = path.join(__dirname, 'server-key', 'id_rsa')
const NSSM = 'C:/nssm/nssm.exe'

const ROOT = __dirname
const DIST_DIR = path.join(ROOT, 'dist')
const VERSION = '1.3.19'
const REMOTE_UPDATE_DIR = 'C:/Users/Administrator/dianxiaoer-api/updates'

const conn = new Client()

function execCmd(cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let stdout = '', stderr = ''
      stream.on('data', d => stdout += d.toString())
      stream.stderr.on('data', d => stderr += d.toString())
      stream.on('close', code => resolve({ code, stdout, stderr }))
    })
  })
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function sftpUpload(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(localPath)
    const size = fs.statSync(localPath).size
    console.log(`  Uploading ${fileName} (${(size / 1024 / 1024).toFixed(1)} MB)...`)
    const readStream = fs.createReadStream(localPath)
    const writeStream = sftp.createWriteStream(remotePath)
    writeStream.on('close', () => { console.log(`  ${fileName} uploaded`); resolve() })
    writeStream.on('error', reject)
    readStream.on('error', reject)
    readStream.pipe(writeStream)
  })
}

function notifyServer(ver) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      version: ver,
      changelog: `全量更新 v${ver}: PDD商品页浮窗适配、浮窗尺寸统一(220px宽/180x180主图)、淘宝浮窗左侧定位、修复浮窗注入时序问题`
    })
    const req = http.request({
      hostname: HOST, port: 3001,
      path: '/api/update/notify-full', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-admin-password': 'dianxiaoer2026' }
    }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => res.statusCode === 200 ? resolve(data) : reject(new Error(`HTTP ${res.statusCode}: ${data}`)))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

conn.on('ready', async () => {
  console.log('[Deploy] SSH connected')

  try {
    // Step 1: Upload small files
    console.log('\n[1] Uploading small files...')
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => err ? reject(err) : resolve(sftp))
    })

    await sftpUpload(sftp, path.join(DIST_DIR, 'latest.yml'), `${REMOTE_UPDATE_DIR}/latest.yml`)

    const blockmapFile = path.join(DIST_DIR, `dianxiaoer-setup-${VERSION}.exe.blockmap`)
    if (fs.existsSync(blockmapFile)) {
      await sftpUpload(sftp, blockmapFile, `${REMOTE_UPDATE_DIR}/dianxiaoer-setup-${VERSION}.exe.blockmap`)
    }

    sftp.end()
    console.log('[1] Small files uploaded')

    // Step 2: Upload exe
    console.log('\n[2] Uploading installer...')
    await sleep(3000)

    const conn2 = new Client()
    await new Promise((resolve, reject) => {
      conn2.on('ready', resolve)
      conn2.on('error', reject)
      conn2.connect({ host: HOST, port: PORT, username: USERNAME, privateKey: fs.readFileSync(KEY_PATH), readyTimeout: 30000, keepaliveInterval: 10000 })
    })

    const sftp2 = await new Promise((resolve, reject) => {
      conn2.sftp((err, sftp) => err ? reject(err) : resolve(sftp))
    })

    const exeFile = path.join(DIST_DIR, `dianxiaoer-setup-${VERSION}.exe`)
    await sftpUpload(sftp2, exeFile, `${REMOTE_UPDATE_DIR}/dianxiaoer-setup-${VERSION}.exe`)

    sftp2.end()
    conn2.end()
    console.log('[2] Installer uploaded')

    // Step 3: Notify server
    console.log('\n[3] Notifying server...')
    try {
      const result = await notifyServer(VERSION)
      console.log('[3] Server response:', result)
    } catch (e) {
      console.error('[3] Notify failed:', e.message)
    }

    // Step 4: Restart dianxiaoer-api
    console.log('\n[4] Restarting dianxiaoer-api...')
    const restart = await execCmd(NSSM + ' restart dianxiaoer-api 2>&1')
    console.log('[4] Restart:', restart.stdout.trim())

    // Step 5: Verify
    console.log('\n[5] Verifying...')
    await sleep(5000)
    const check = await execCmd(`curl -s "http://localhost:3001/api/update/check?version=1.3.18&appVersion=1.3.18" 2>&1`)
    console.log('[5] Update check:', check.stdout.trim().substring(0, 300))

    console.log('\n[Deploy] Complete!')
  } catch (e) {
    console.error('[Deploy] Error:', e.message)
  } finally {
    conn.end()
    process.exit(0)
  }
})

conn.on('error', err => { console.error('[Deploy] SSH error:', err.message); process.exit(1) })
conn.connect({ host: HOST, port: PORT, username: USERNAME, privateKey: fs.readFileSync(KEY_PATH), readyTimeout: 30000, keepaliveInterval: 10000 })
