const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')

const HOST = '150.158.54.108'
const USER = 'administrator'
const KEY_PATH = path.join(__dirname, 'server-key', 'id_rsa')

const conn = new Client()

conn.on('ready', () => {
  console.log('[OK] SSH connected')
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('[ERR] SFTP error:', err.message)
      conn.end()
      return
    }

    const files = [
      { local: path.join(__dirname, 'server', 'db.js'), remote: 'C:/Users/Administrator/dianxiaoer-api/server/db.js' },
      { local: path.join(__dirname, 'server', 'index.js'), remote: 'C:/Users/Administrator/dianxiaoer-api/server/index.js' }
    ]

    let done = 0
    files.forEach(f => {
      console.log('[UPLOAD] ' + f.local + ' -> ' + f.remote)
      sftp.fastPut(f.local, f.remote, (err) => {
        if (err) {
          console.error('[ERR] Upload failed: ' + f.local + ': ' + err.message)
        } else {
          console.log('[OK] Uploaded: ' + f.remote)
        }
        done++
        if (done === files.length) {
          console.log('[OK] All files uploaded. Restarting service...')
          conn.exec('C:\\nssm\\nssm.exe restart dianxiaoer-api', (err, stream) => {
            if (err) {
              console.error('[ERR] Exec error:', err.message)
              conn.end()
              return
            }
            stream.on('data', d => process.stdout.write(d))
            stream.stderr.on('data', d => process.stderr.write(d))
            stream.on('close', (code) => {
              console.log('\n[OK] Service restart completed (exit code: ' + code + ')')
              conn.exec('C:\\nssm\\nssm.exe status dianxiaoer-api', (err, stream2) => {
                if (err) { conn.end(); return }
                stream2.on('data', d => process.stdout.write(d))
                stream2.stderr.on('data', d => process.stderr.write(d))
                stream2.on('close', () => {
                  console.log('\n[DONE] Deployment complete')
                  conn.end()
                })
              })
            })
          })
        }
      })
    })
  })
})

conn.on('error', err => {
  console.error('[ERR] SSH error:', err.message)
})

conn.on('close', () => {
  console.log('[INFO] SSH connection closed')
})

console.log('[INFO] Connecting to ' + HOST + ' as ' + USER + '...')
conn.connect({
  host: HOST,
  port: 22,
  username: USER,
  privateKey: fs.readFileSync(KEY_PATH),
  readyTimeout: 20000
})
