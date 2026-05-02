const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')

const conn = new Client()

// SSH配置 - 使用密码认证
const sshConfig = {
  host: '150.158.54.108',
  port: 22,
  username: 'administrator',
  password: String.raw`K9#m2$vL5@zQ`,
  readyTimeout: 15000
}

conn.on('ready', () => {
  console.log('[SSH] Connected to remote server')
  
  // 直接在远程服务器上执行Node.js命令
  const nodeCommand = `node -e "const mysql=require('mysql2/promise');(async()=>{try{const c=await mysql.createConnection({host:'127.0.0.1',port:3307,user:'root',password:'jd123456',database:'dianxiaoer'});const[col]=await c.execute(\\"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dianxiaoer' AND TABLE_NAME='stores' AND COLUMN_NAME='last_sync_at'\\");if(col.length>0){console.log('last_sync_at already exists')}else{await c.execute(\\"ALTER TABLE stores ADD COLUMN last_sync_at DATETIME DEFAULT NULL COMMENT '最后同步时间'\\");console.log('last_sync_at added successfully')}await c.end()}catch(e){console.error('Error:',e.message)}})();"`
  
  conn.exec(nodeCommand, (err, stream) => {
    if (err) {
      console.error('Exec error:', err)
      conn.end()
      return
    }
    
    let stdout = ''
    let stderr = ''
    
    stream.on('data', data => {
      stdout += data.toString()
    })
    
    stream.stderr.on('data', data => {
      stderr += data.toString()
    })
    
    stream.on('close', code => {
      console.log('\n=== Execution Result ===')
      console.log('Exit code:', code)
      console.log('STDOUT:', stdout)
      if (stderr) console.error('STDERR:', stderr)
      conn.end()
    })
  })
}).on('error', err => {
  console.error('[SSH] Connection error:', err.message)
  console.error('Trying with different auth method...')
})

conn.connect(sshConfig)
