const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')
const conn = new Client()

const keyPath = path.join(__dirname, 'server-key/id_rsa')

conn.on('ready', () => {
  conn.exec('node -e "const http=require(\'http\');http.get(\'http://127.0.0.1:3002/health\',r=>{let d=\'\';r.on(\'data\',c=>d+=c);r.on(\'end\',()=>{console.log(\'health:\',d)})}).on(\'error\',e=>console.log(e.message))"', (err, stream) => {
    if (err) { console.log('Error:', err.message); conn.end(); process.exit() }
    let out = ''
    stream.on('data', d => out += d.toString())
    stream.stderr.on('data', d => out += d.toString())
    stream.on('close', () => {
      console.log(out.trim())
      conn.end()
    })
  })
})
conn.on('error', err => { console.log('SSH error:', err.message); process.exit(1) })
conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', privateKey: fs.readFileSync(keyPath), readyTimeout: 30000 })
