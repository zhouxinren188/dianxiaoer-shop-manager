#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const { Client } = require('ssh2')

const conn = new Client()

conn.on('ready', () => {
  console.log('[SSH] 已连接')

  const cmds = [
    // dianxiaoer-server 启动（3002已释放）
    'C:\\nssm\\nssm.exe start dianxiaoer-server',
    'timeout /t 5 /nobreak >nul',
    'echo === STATUS ===',
    'C:\\nssm\\nssm.exe status dianxiaoer-server',
    'C:\\nssm\\nssm.exe status dianxiaoer-api',
    'echo === PORTS ===',
    'netstat -aon | findstr "LISTENING" | findstr ":300"'
  ]

  conn.exec(cmds.join(' & '), (err, stream) => {
    if (err) { console.error(err); conn.end(); return }
    stream.on('data', d => process.stdout.write(d.toString('utf8')))
    stream.stderr.on('data', d => process.stderr.write(d.toString('utf8')))
    stream.on('close', (code) => {
      console.log('\n[退出码]', code)
      conn.end()
    })
  })
})

conn.on('error', err => console.error('[SSH Error]', err.message))
conn.connect({
  host: '150.158.54.108',
  port: 22,
  username: 'administrator',
  privateKey: fs.readFileSync(path.join(__dirname, '..', 'server-key', 'id_rsa')),
  readyTimeout: 30000
})
