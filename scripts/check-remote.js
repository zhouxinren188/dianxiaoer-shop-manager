const ssh2 = require('ssh2')
const conn = new ssh2.Client()
conn.on('ready', () => {
  conn.exec('findstr /n "admin" C:\\dianxiaoer-api\\update-server.js', (err, stream) => {
    if (err) { console.error(err); conn.end(); return }
    let out = ''
    stream.on('data', d => out += d.toString())
    stream.stderr.on('data', d => out += d.toString())
    stream.on('close', () => {
      console.log('update-server.js admin routes:', out || 'NONE FOUND')
      conn.exec('findstr /n "admin" C:\\dianxiaoer-api\\index.js', (err2, stream2) => {
        if (err2) { console.error(err2); conn.end(); return }
        let out2 = ''
        stream2.on('data', d => out2 += d.toString())
        stream2.stderr.on('data', d => out2 += d.toString())
        stream2.on('close', () => {
          console.log('index.js admin routes:', out2 || 'NONE FOUND')
          conn.end()
          process.exit(0)
        })
      })
    })
  })
}).on('error', e => { console.error(e.message); process.exit(1) })
conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', password: 'K9#m2$vL5@zQ', readyTimeout: 15000 })
