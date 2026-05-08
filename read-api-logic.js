const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')

const conn = new Client()
const KEY = fs.readFileSync(path.join(__dirname, 'server-key', 'id_rsa'))

conn.on('ready', () => {
  process.stdout.write('SSH OK\n')
  conn.sftp((err, sftp) => {
    if (err) { process.stdout.write('SFTP err: ' + err.message + '\n'); conn.end(); return }
    process.stdout.write('SFTP OK\n')

    const filePath = 'C:/Users/Administrator/dianxiaoer-api/index.js'
    sftp.readFile(filePath, 'utf8', (err, data) => {
      if (err) { process.stdout.write('Read err: ' + err.message + '\n'); conn.end(); return }
      
      const lines = data.split('\n')
      process.stdout.write('Lines: ' + lines.length + '\n')

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].toLowerCase()
        if (line.includes('needupdate') || line.includes('updatetype') || line.includes('update/check')) {
          const start = Math.max(0, i - 2)
          const end = Math.min(lines.length, i + 8)
          process.stdout.write('\n--- line ' + (i+1) + ' ---\n')
          for (let j = start; j < end; j++) {
            process.stdout.write((j+1) + ': ' + lines[j] + '\n')
          }
        }
      }
      conn.end()
    })
  })
})

conn.on('error', err => { process.stdout.write('SSH err: ' + err.message + '\n'); process.exit(1) })
conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', privateKey: KEY, readyTimeout: 15000, keepaliveInterval: 5000 })
