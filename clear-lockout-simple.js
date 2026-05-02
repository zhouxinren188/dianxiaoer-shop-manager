const { Client } = require('ssh2')
const conn = new Client()

conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message)
      process.exit(1)
    }
    
    // 直接清空 lockout.json 文件
    sftp.writeFile('C:/Users/Administrator/dianxiaoer-api/data/lockout.json', '{}', 'utf8', (err) => {
      if (err) {
        console.error('Write error:', err.message)
      } else {
        console.log('已清空 lockout.json')
      }
      conn.end()
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
