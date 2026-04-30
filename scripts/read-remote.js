const { Client } = require('ssh2')

const conn = new Client()

conn.on('ready', () => {
  conn.exec('type "C:\\Users\\Administrator\\dianxiaoer-server\\index.js" | more +770', (err, stream) => {
    let out = ''
    stream.on('data', d => out += d.toString())
    stream.stderr.on('data', d => out += d.toString())
    stream.on('close', () => {
      console.log(out.trim())
      conn.end()
      process.exit(0)
    })
  })
}).on('error', err => { console.error(err.message); process.exit(1) })

conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', password: 'K9#m2$vL5@zQ', readyTimeout: 15000 })
