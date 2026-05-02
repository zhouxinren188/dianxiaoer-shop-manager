const { Client } = require('ssh2')
const conn = new Client()

conn.on('ready', () => {
  console.log('SSH connected')

  // 重启认证服务器
  conn.exec('C:\\nssm\\nssm.exe restart dianxiaoer-api', (err, stream) => {
    let out = '', errOut = ''
    stream.on('data', d => out += d)
    stream.stderr.on('data', d => errOut += d)
    stream.on('close', (code) => {
      console.log('重启命令输出:', out)
      if (errOut) console.error('错误:', errOut)

      // 等待服务启动
      setTimeout(() => {
        conn.exec('curl -sk http://localhost:3001/api/health', (err, stream) => {
          let health = ''
          stream.on('data', d => health += d)
          stream.on('close', () => {
            console.log('Health check:', health)
            conn.end()
          })
        })
      }, 3000)
    })
  })
})

conn.on('error', err => {
  console.error('SSH error:', err.message)
  process.exit(1)
})

conn.connect({
  host: '150.158.54.108',
  port: 22,
  username: 'administrator',
  password: 'K9#m2$vL5@zQ',
  readyTimeout: 15000
})
