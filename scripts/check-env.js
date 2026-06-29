const { Client } = require('ssh2')
const conn = new Client()

conn.on('ready', () => {
  conn.exec('type C:\\dianxiaoer-api\\.env', (err, stream) => {
    if (err) { console.error(err); conn.end(); return }
    let out = ''
    stream.on('data', d => out += d.toString())
    stream.stderr.on('data', d => out += d.toString())
    stream.on('close', () => {
      console.log(out)
      conn.end()
      process.exit(0)
    })
  })
}).on('error', e => { console.error(e.message); process.exit(1) })

conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', password: 'K9#m2$vL5@zQ', readyTimeout: 15000 })
