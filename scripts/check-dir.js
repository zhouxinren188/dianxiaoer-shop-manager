const { Client } = require('ssh2')

const conn = new Client()

conn.on('ready', () => {
  const cmds = [
    'if exist "C:\\Users\\Administrator\\dianxiaoer-server" (echo EXISTS) else (echo NOT_EXISTS)',
    'dir "C:\\Users\\Administrator\\dianxiaoer-server" 2>nul',
    'if exist "C:\\dianxiaoer-server" (echo EXISTS_C) else (echo NOT_EXISTS_C)',
    'dir "C:\\dianxiaoer-server" 2>nul'
  ]
  let i = 0
  function next() {
    if (i >= cmds.length) { conn.end(); process.exit(0) }
    const cmd = cmds[i++]
    console.log(`\n>>> ${cmd}`)
    conn.exec(cmd, (err, stream) => {
      let out = ''
      stream.on('data', d => out += d.toString())
      stream.stderr.on('data', d => out += d.toString())
      stream.on('close', () => { console.log(out.trim()); next() })
    })
  }
  next()
}).on('error', err => { console.error(err.message); process.exit(1) })

conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', password: 'K9#m2$vL5@zQ', readyTimeout: 15000 })
