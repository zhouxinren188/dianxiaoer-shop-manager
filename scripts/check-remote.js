const { Client } = require('ssh2')

const HOST = '150.158.54.108'
const PORT = 22
const USERNAME = 'administrator'
const PASSWORD = 'K9#m2$vL5@zQ'

const conn = new Client()

conn.on('ready', () => {
  console.log('[Check] Connected')

  const commands = [
    'tasklist /FI "IMAGENAME eq node.exe" /FO TABLE',
    'curl -s http://localhost:3001/health',
    'curl -s http://localhost:3001/api/update/check?version=0.0.0',
    'type C:\\Users\\Administrator\\dianxiaoer-server\\index.js | findstr "api/update/upload"',
    'C:\\nssm\\nssm.exe get dianxiaoer-server Application'
  ]

  let i = 0
  function next() {
    if (i >= commands.length) {
      conn.end()
      process.exit(0)
    }
    const cmd = commands[i++]
    console.log(`\n[Check] >>> ${cmd}`)
    conn.exec(cmd, (err, stream) => {
      if (err) { console.error('Error:', err.message); next(); return }
      let out = ''
      stream.on('data', d => out += d.toString())
      stream.stderr.on('data', d => out += d.toString())
      stream.on('close', () => {
        console.log(out.trim())
        next()
      })
    })
  }

  next()
}).on('error', err => {
  console.error('[Check] Error:', err.message)
  process.exit(1)
})

conn.connect({ host: HOST, port: PORT, username: USERNAME, password: PASSWORD, readyTimeout: 15000 })
