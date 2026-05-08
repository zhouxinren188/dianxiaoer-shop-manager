const { Client } = require('ssh2')
const fs = require('fs')
const conn = new Client()

const cmds = [
  'findstr "warehouse_name" C:\\dianxiaoer-server\\db.js',
  'findstr "warehouse_name" C:\\dianxiaoer-server\\index.js',
  'sc query dianxiaoer-server | findstr STATE',
  'netstat -an | findstr 3307'
]

let idx = 0

function runNext() {
  if (idx >= cmds.length) { conn.end(); return }
  const cmd = cmds[idx]
  console.log(`\n[${idx+1}] ${cmd}`)
  conn.exec(cmd, (err, stream) => {
    if (err) { console.log('  Error:', err.message); idx++; runNext(); return }
    let out = ''
    stream.on('data', d => out += d.toString())
    stream.stderr.on('data', d => out += d.toString())
    stream.on('close', () => {
      console.log('  Result:', out.trim() || '(empty)')
      idx++
      runNext()
    })
  })
}

conn.on('ready', () => {
  console.log('SSH connected')
  runNext()
})
conn.on('error', err => { console.log('SSH error:', err.message); process.exit(1) })
conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', privateKey: fs.readFileSync('server-key/id_rsa'), readyTimeout: 30000 })
