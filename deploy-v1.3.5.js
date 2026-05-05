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
const VERSION = '1.3.5'
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
      changelog: `全量更新 v${ver}: 采购账号分配功能、upsert去重、订单列表UI优化`
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
    // Step 1: 确保 updates 目录存在
    console.log('\n[1] Ensuring remote updates directory...')
    await execCmd(`if not exist "${REMOTE_UPDATE_DIR}" mkdir "${REMOTE_UPDATE_DIR}"`)

    // Step 2: 上传小文件 (latest.yml, blockmap)
    console.log('\n[2] Uploading small files...')
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => err ? reject(err) : resolve(sftp))
    })

    await sftpUpload(sftp, path.join(DIST_DIR, 'latest.yml'), `${REMOTE_UPDATE_DIR}/latest.yml`)

    const blockmapFile = path.join(DIST_DIR, `dianxiaoer-setup-${VERSION}.exe.blockmap`)
    if (fs.existsSync(blockmapFile)) {
      await sftpUpload(sftp, blockmapFile, `${REMOTE_UPDATE_DIR}/dianxiaoer-setup-${VERSION}.exe.blockmap`)
    }

    sftp.end()
    console.log('[2] Small files uploaded')

    // Step 3: 上传 exe (大文件)
    console.log('\n[3] Uploading installer (~106 MB, please wait)...')
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
    console.log('[3] Installer uploaded')

    // Step 4: 验证文件
    console.log('\n[4] Verifying remote files...')
    await sleep(2000)
    const verify = await execCmd(`dir "${REMOTE_UPDATE_DIR}\\dianxiaoer-setup-${VERSION}.exe" "${REMOTE_UPDATE_DIR}\\latest.yml" 2>&1`)
    console.log(verify.stdout.trim().substring(0, 500))

    // Step 5: 通知更新服务器
    console.log('\n[5] Notifying server of full update...')
    try {
      const result = await notifyServer(VERSION)
      console.log('[5] Server response:', result)
    } catch (e) {
      console.error('[5] Notify failed:', e.message)
    }

    // Step 6: 重启 dianxiaoer-api
    console.log('\n[6] Restarting dianxiaoer-api...')
    const restart = await execCmd(NSSM + ' restart dianxiaoer-api 2>&1')
    console.log('[6] Restart:', restart.stdout.trim())

    // Step 7: 验证更新检查
    console.log('\n[7] Verifying update check...')
    await sleep(5000)
    const check = await execCmd('curl -s http://localhost:3001/api/update/check?version=1.3.4\\&appVersion=1.3.4 2>&1')
    console.log('[7] Update check:', check.stdout.trim().substring(0, 300))

    console.log('\n[Deploy] Full package deployment complete!')
  } catch (e) {
    console.error('[Deploy] Error:', e.message)
  } finally {
    conn.end()
    process.exit(0)
  }
})

conn.on('error', err => { console.error('[Deploy] SSH error:', err.message); process.exit(1) })
conn.connect({ host: HOST, port: PORT, username: USERNAME, privateKey: fs.readFileSync(KEY_PATH), readyTimeout: 30000, keepaliveInterval: 10000 })
