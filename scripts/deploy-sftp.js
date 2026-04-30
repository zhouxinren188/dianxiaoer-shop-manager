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

conn.on('ready', () => {
  console.log('[SFTP] Connected')
  conn.sftp((err, sftp) => {
    if (err) { console.error('[SFTP] Error:', err.message); conn.end(); process.exit(1); return }

    console.log('[SFTP] Uploading index.js...')
    sftp.fastPut(localFile, remoteFile, (err) => {
      if (err) { console.error('[SFTP] Upload error:', err.message); conn.end(); process.exit(1); return }
      console.log('[SFTP] Uploaded')

      conn.exec(`${NSSM} restart dianxiaoer-server`, (err, stream) => {
        if (err) { console.error('[SFTP] Restart error:', err.message); conn.end(); process.exit(1); return }
        let out = ''
        stream.on('data', d => out += d.toString())
        stream.stderr.on('data', d => out += d.toString())
        stream.on('close', () => {
          console.log('[SFTP] Restart:', out)
          setTimeout(() => {
            conn.exec('curl -s http://localhost:3001/api/update/check?version=0.0.0', (err, stream2) => {
              if (err) { conn.end(); process.exit(1); return }
              let data = ''
              stream2.on('data', d => data += d.toString())
              stream2.on('close', () => {
                console.log('[SFTP] Update API:', data)
                conn.end()
                process.exit(0)
              })
            })
          }, 5000)
        })
      })
    })
  })
}).on('error', err => {
  console.error('[SFTP] Connection error:', err.message)
  process.exit(1)
})

conn.connect({ host: HOST, port: PORT, username: USERNAME, password: PASSWORD, readyTimeout: 15000 })
