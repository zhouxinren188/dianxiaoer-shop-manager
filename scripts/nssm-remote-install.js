#!/usr/bin/env node
/**
 * 远程注册 NSSM 服务
 */
const fs = require('fs')
const path = require('path')
const { Client } = require('ssh2')

const conn = new Client()

conn.on('ready', () => {
  console.log('[SSH] 已连接')

  const cmds = [
    'echo === 安装 dianxiaoer-server 服务 ===',
    'C:\\nssm\\nssm.exe install dianxiaoer-server "C:\\Program Files\\nodejs\\node.exe" "index.js"',
    'C:\\nssm\\nssm.exe set dianxiaoer-server AppDirectory "C:\\Users\\Administrator\\dianxiaoer-server"',
    'C:\\nssm\\nssm.exe set dianxiaoer-server AppEnvironmentExtra DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=root DB_PASSWORD=jd123456 DB_NAME=dianxiaoer PORT=3002 NODE_ENV=production',
    'if not exist "C:\\Users\\Administrator\\dianxiaoer-server\\logs" mkdir "C:\\Users\\Administrator\\dianxiaoer-server\\logs"',
    'C:\\nssm\\nssm.exe set dianxiaoer-server AppStdout "C:\\Users\\Administrator\\dianxiaoer-server\\logs\\stdout.log"',
    'C:\\nssm\\nssm.exe set dianxiaoer-server AppStderr "C:\\Users\\Administrator\\dianxiaoer-server\\logs\\stderr.log"',
    'C:\\nssm\\nssm.exe set dianxiaoer-server AppStdoutCreationDisposition 4',
    'C:\\nssm\\nssm.exe set dianxiaoer-server AppStderrCreationDisposition 4',
    'C:\\nssm\\nssm.exe set dianxiaoer-server AppRotateFiles 1',
    'C:\\nssm\\nssm.exe set dianxiaoer-server AppRotateOnline 1',
    'C:\\nssm\\nssm.exe set dianxiaoer-server AppRotateBytes 5242880',
    'C:\\nssm\\nssm.exe set dianxiaoer-server AppExit Default Restart',
    'C:\\nssm\\nssm.exe set dianxiaoer-server AppRestartDelay 3000',
    'C:\\nssm\\nssm.exe set dianxiaoer-server Start SERVICE_AUTO_START',
    'C:\\nssm\\nssm.exe set dianxiaoer-server DisplayName "dianxiaoer-main-api"',
    'C:\\nssm\\nssm.exe start dianxiaoer-server',

    'echo === 安装 dianxiaoer-api 服务 ===',
    'C:\\nssm\\nssm.exe install dianxiaoer-api "C:\\Program Files\\nodejs\\node.exe" "index.js"',
    'C:\\nssm\\nssm.exe set dianxiaoer-api AppDirectory "C:\\dianxiaoer-api"',
    'C:\\nssm\\nssm.exe set dianxiaoer-api AppEnvironmentExtra NODE_ENV=production',
    'if not exist "C:\\dianxiaoer-api\\logs" mkdir "C:\\dianxiaoer-api\\logs"',
    'C:\\nssm\\nssm.exe set dianxiaoer-api AppStdout "C:\\dianxiaoer-api\\logs\\stdout.log"',
    'C:\\nssm\\nssm.exe set dianxiaoer-api AppStderr "C:\\dianxiaoer-api\\logs\\stderr.log"',
    'C:\\nssm\\nssm.exe set dianxiaoer-api AppStdoutCreationDisposition 4',
    'C:\\nssm\\nssm.exe set dianxiaoer-api AppStderrCreationDisposition 4',
    'C:\\nssm\\nssm.exe set dianxiaoer-api AppRotateFiles 1',
    'C:\\nssm\\nssm.exe set dianxiaoer-api AppRotateOnline 1',
    'C:\\nssm\\nssm.exe set dianxiaoer-api AppRotateBytes 5242880',
    'C:\\nssm\\nssm.exe set dianxiaoer-api AppExit Default Restart',
    'C:\\nssm\\nssm.exe set dianxiaoer-api AppRestartDelay 3000',
    'C:\\nssm\\nssm.exe set dianxiaoer-api Start SERVICE_AUTO_START',
    'C:\\nssm\\nssm.exe set dianxiaoer-api DisplayName "dianxiaoer-auth-api"',
    'C:\\nssm\\nssm.exe start dianxiaoer-api',

    'echo === 检查服务状态 ===',
    'C:\\nssm\\nssm.exe status dianxiaoer-server',
    'C:\\nssm\\nssm.exe status dianxiaoer-api'
  ]

  const fullCmd = cmds.join(' & ')

  conn.exec(fullCmd, (err, stream) => {
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
