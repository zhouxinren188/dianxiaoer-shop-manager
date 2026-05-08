const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')
const http = require('http')

const HOST = '150.158.54.108'
const KEY_PATH = path.join(__dirname, 'server-key', 'id_rsa')
const NSSM = 'C:/nssm/nssm.exe'

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

function notifyServer(ver) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      version: ver,
      changelog: '全量更新 v1.3.22: 二次同步进度展示、采购类型+仓库名列、关联销售查询修复、备注字段修复'
    })
    const req = http.request({
      hostname: HOST, port: 3001,
      path: '/api/update/notify-full', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-admin-password': 'dianxiaoer2026' }
    }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => res.statusCode === 200 ? resolve(data) : reject(new Error('HTTP ' + res.statusCode + ': ' + data)))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

conn.on('ready', async () => {
  console.log('[1] SSH connected')

  try {
    // Verify files
    const verify = await execCmd('dir "C:\\Users\\Administrator\\dianxiaoer-api\\updates\\dianxiaoer-setup-1.3.22.exe" "C:\\Users\\Administrator\\dianxiaoer-api\\updates\\latest.yml" 2>&1')
    console.log('[2] File verify:', verify.stdout.trim().substring(0, 600))

    // Notify server
    console.log('[3] Notifying server...')
    try {
      const result = await notifyServer('1.3.22')
      console.log('[3] Notify result:', result)
    } catch (e) {
      console.error('[3] Notify failed:', e.message)
    }

    // Restart api
    console.log('[4] Restarting dianxiaoer-api...')
    const restart = await execCmd(NSSM + ' restart dianxiaoer-api 2>&1')
    console.log('[4] Restart:', restart.stdout.trim())

    // Verify update check
    console.log('[5] Verifying update check...')
    await sleep(5000)
    const check = await execCmd('curl -s "http://localhost:3001/api/update/check?version=1.3.21&appVersion=1.3.21" 2>&1')
    console.log('[5] Old version check:', check.stdout.trim().substring(0, 300))

    const check2 = await execCmd('curl -s "http://localhost:3001/api/update/check?version=1.3.22&appVersion=1.3.22" 2>&1')
    console.log('[5] New version check:', check2.stdout.trim().substring(0, 300))

    console.log('\n[Deploy] Complete!')
  } catch (e) {
    console.error('[Deploy] Error:', e.message)
  } finally {
    conn.end()
    process.exit(0)
  }
})

conn.on('error', err => { console.error('SSH error:', err.message); process.exit(1) })
conn.connect({ host: HOST, port: 22, username: 'administrator', privateKey: fs.readFileSync(KEY_PATH), readyTimeout: 30000, keepaliveInterval: 10000 })
