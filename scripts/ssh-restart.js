const { Client } = require('ssh2')

const conn = new Client()

conn.on('ready', () => {
  console.log('[SSH] Connected to remote server')

  // Find the project directory and running node processes
  conn.exec('where node && dir /s /b C:\\dianxiaoer*\\server\\index.js 2>nul & dir /s /b D:\\dianxiaoer*\\server\\index.js 2>nul & echo ---done---', (err, stream) => {
    if (err) { console.error('Exec error:', err); conn.end(); return }
    let out = ''
    stream.on('data', d => out += d.toString())
    stream.stderr.on('data', d => out += d.toString())
    stream.on('close', () => {
      console.log('[SSH] Output:\n' + out)
      conn.end()
    })
  })
}).on('error', err => {
  console.error('[SSH] Connection error:', err.message)
})

conn.connect({
  host: '150.158.54.108',
  port: 22,
  username: 'administrator',
  password: 'K9#m2$vL5@zQ',
  readyTimeout: 15000
})
