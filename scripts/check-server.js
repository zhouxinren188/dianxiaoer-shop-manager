const { Client } = require('ssh2')

const conn = new Client()

conn.on('ready', () => {
  const cmds = [
    'type "C:\\Users\\Administrator\\dianxiaoer-server\\index.js" | findstr "api/update/upload"',
    'C:\\nssm\\nssm.exe status dianxiaoer-server',
    'type "C:\\Users\\Administrator\\dianxiaoer-server\\logs\\server-stderr.log" 2>nul | tail -20',
    'tasklist /FI "PID eq 4568" /FO LIST 2>nul',
    'wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:list 2>nul | findstr /C:"dianxiaoer"'
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
      stream.on('close', () => { console.log(out.trim() || '(empty)'); next() })
    })
  }
  next()
}).on('error', err => { console.error(err.message); process.exit(1) })

conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', password: 'K9#m2$vL5@zQ', readyTimeout: 15000 })
