const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')

const KEY_PATH = path.join(__dirname, 'server-key', 'id_rsa')
const HOST = '150.158.54.108'

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

conn.on('ready', async () => {
  console.log('SSH connected')

  try {
    // 上传 server/index.js
    const sftp = await new Promise((res, rej) => conn.sftp((err, s) => err ? rej(err) : res(s)))

    const localFile = path.join(__dirname, 'server', 'index.js')
    const remotePath = 'C:/Users/Administrator/dianxiaoer-api/server/index.js'
    console.log('Uploading server/index.js...')
    await new Promise((res, rej) => {
      const rs = fs.createReadStream(localFile)
      const ws = sftp.createWriteStream(remotePath)
      ws.on('close', () => { console.log('Upload done'); res() })
      ws.on('error', rej)
      rs.on('error', rej)
      rs.pipe(ws)
    })
    // sftp.end() — do not close, it kills the connection

    // 重启服务 - 先检查 nssm 是否存在
    console.log('Checking nssm...')
    const nssmCheck = await execCmd('dir C:\\nssm\\nssm.exe 2>&1')
    console.log('nssm check:', nssmCheck.stdout.trim().substring(0, 200))

    console.log('Restarting dianxiaoer-api...')
    try {
      const restart = await execCmd('C:\\nssm\\nssm.exe restart dianxiaoer-api')
      console.log('Restart result:', restart.stdout.trim(), restart.stderr.trim())
    } catch (restartErr) {
      console.error('nssm restart failed:', restartErr.message)
      // 尝试其他路径
      const restart2 = await execCmd('nssm restart dianxiaoer-api')
      console.log('Restart2 result:', restart2.stdout.trim(), restart2.stderr.trim())
    }

    // 等待并验证
    console.log('Waiting 8s for service to start...')
    await new Promise(r => setTimeout(r, 8000))

    console.log('Verifying API...')
    const verify = await execCmd('curl -s "http://localhost:3002/api/store-sales-stats?period=today"')
    console.log('API response:', verify.stdout.substring(0, 500))

    console.log('\nDeploy complete!')
  } catch (e) {
    console.error('Error:', e.message)
  } finally {
    conn.end()
    process.exit(0)
  }
})

conn.on('error', err => { console.error('SSH error:', err.message); process.exit(1) })
conn.connect({ host: HOST, port: 22, username: 'administrator', privateKey: fs.readFileSync(KEY_PATH), readyTimeout: 30000 })
