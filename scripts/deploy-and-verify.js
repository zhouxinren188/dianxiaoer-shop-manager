const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')

const HOST = '150.158.54.108'
const PORT = 22
const USERNAME = 'administrator'
const PASSWORD = 'K9#m2$vL5@zQ'
const REMOTE_DIR = 'C:/Users/Administrator/dianxiaoer-server'
const NSSM = 'C:/nssm/nssm.exe'

const localFile = path.join(__dirname, '..', 'server', 'index.js')
const remoteFile = `${REMOTE_DIR}/index.js`

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

conn.on('ready', async () => {
  console.log('[Deploy] Connected')

  try {
    // Upload
    console.log('[Deploy] Uploading index.js...')
    await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err)
        sftp.fastPut(localFile, remoteFile, (err) => {
          if (err) return reject(err)
          resolve()
        })
      })
    })
    console.log('[Deploy] Uploaded')

    // Verify content
    console.log('[Deploy] Verifying content...')
    const verify = await exec(`powershell -Command "(Select-String -Path '${remoteFile}' -Pattern 'api/update/upload').Count"`)
    const matchCount = parseInt(verify.stdout.trim(), 10)
    console.log(`[Deploy] Upload API found: ${matchCount} time(s)`)
    if (matchCount === 0) {
      console.error('[Deploy] ERROR: upload API not found in remote file!')
      conn.end()
      process.exit(1)
    }

    // Restart
    console.log('[Deploy] Restarting service...')
    const restart = await exec(`${NSSM} restart dianxiaoer-server`)
    console.log('[Deploy] Restart:', restart.stdout)

    // Wait and verify API
    console.log('[Deploy] Waiting 5s...')
    await new Promise(r => setTimeout(r, 5000))

    const health = await exec('curl -s http://localhost:3001/health')
    console.log('[Deploy] Health:', health.stdout)

    const updateCheck = await exec('curl -s http://localhost:3001/api/update/check?version=0.0.0')
    console.log('[Deploy] Update check:', updateCheck.stdout)

    if (updateCheck.stdout.includes('Cannot GET')) {
      console.error('[Deploy] ERROR: Update API still 404!')
      conn.end()
      process.exit(1)
    }

    console.log('[Deploy] SUCCESS')
    conn.end()
    process.exit(0)
  } catch (e) {
    console.error('[Deploy] Error:', e.message)
    conn.end()
    process.exit(1)
  }
}).on('error', err => {
  console.error('[Deploy] Connection error:', err.message)
  process.exit(1)
})

conn.connect({ host: HOST, port: PORT, username: USERNAME, password: PASSWORD, readyTimeout: 15000 })
