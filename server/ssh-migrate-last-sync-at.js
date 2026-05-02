const { Client } = require('ssh2')
const conn = new Client()

conn.on('ready', () => {
  console.log('[SSH] Connected to remote server')
  
  // 执行MySQL迁移
  const mysqlCmd = `mysql -u root -p"jd123456" -P 3307 dianxiaoer -e "ALTER TABLE stores ADD COLUMN IF NOT EXISTS last_sync_at DATETIME DEFAULT NULL COMMENT '最后同步时间';"`
  
  conn.exec(mysqlCmd, (err, stream) => {
    if (err) { console.error('Exec error:', err); conn.end(); return }
    let out = ''
    stream.on('data', d => out += d.toString())
    stream.stderr.on('data', d => out += d.toString())
    stream.on('close', () => {
      console.log('[SSH] MySQL ALTER output:\n' + out)
      
      // 验证字段是否添加成功
      const verifyCmd = 'mysql -u root -p"jd123456" -P 3307 dianxiaoer -e "DESCRIBE stores;"'
      conn.exec(verifyCmd, (err2, stream2) => {
        let out2 = ''
        stream2.on('data', d => out2 += d.toString())
        stream2.stderr.on('data', d => out2 += d.toString())
        stream2.on('close', () => {
          console.log('[SSH] Describe stores:\n' + out2)
          conn.end()
        })
      })
    })
  })
}).on('error', err => {
  console.error('[SSH] Connection error:', err.message)
})

conn.connect({
  host: '150.158.54.108',
  port: 22,
  username: 'administrator',
  password: 'K9#m2$vL5@zQ',
  readyTimeout: 15000
})
