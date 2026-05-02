const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')

// 使用SSH密钥连接
const conn = new Client()

const sshConfig = {
  host: '150.158.54.108',
  port: 22,
  username: 'administrator',
  privateKey: fs.readFileSync(path.join(__dirname, '..', '.ssh', 'id_rsa')),
  passphrase: '',
  readyTimeout: 15000
}

conn.on('ready', () => {
  console.log('[SSH] Connected to remote server')
  
  // 检查服务器上的脚本是否存在
  conn.exec('dir C:\\dianxiaoer-shop-manager\\server\\add-last-sync-at.js', (err, stream) => {
    let out = ''
    stream.on('data', d => out += d.toString())
    stream.stderr.on('data', d => out += d.toString())
    stream.on('close', () => {
      console.log('Script exists check:')
      console.log(out)
      
      // 执行迁移脚本
      if (!out.includes('找不到文件')) {
        console.log('\n[SSH] Executing migration script...')
        conn.exec('node C:\\dianxiaoer-shop-manager\\server\\add-last-sync-at.js', (err2, stream2) => {
          let out2 = ''
          let err2Out = ''
          
          stream2.on('data', d => {
            out2 += d.toString()
            console.log('[STDOUT]', d.toString())
          })
          
          stream2.stderr.on('data', d => {
            err2Out += d.toString()
            console.error('[STDERR]', d.toString())
          })
          
          stream2.on('close', () => {
            console.log('\n=== Migration Complete ===')
            console.log(out2)
            if (err2Out) console.error(err2Out)
            conn.end()
          })
        })
      } else {
        console.log('Script not found, creating and executing inline SQL...')
        // 如果脚本不存在，直接通过Node.js连接数据库执行
        executeInlineSQL(conn)
      }
    })
  })
}).on('error', err => {
  console.error('[SSH] Connection error:', err.message)
})

function executeInlineSQL(sshConn) {
  // 通过SSH执行远程Node.js命令来连接数据库
  const nodeScript = `
    const mysql = require('mysql2/promise');
    (async () => {
      try {
        const conn = await mysql.createConnection({
          host: '127.0.0.1',
          port: 3307,
          user: 'root',
          password: 'jd123456',
          database: 'dianxiaoer'
        });
        
        const [columns] = await conn.execute(
          "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'dianxiaoer' AND TABLE_NAME = 'stores' AND COLUMN_NAME = 'last_sync_at'"
        );
        
        if (columns.length > 0) {
          console.log('last_sync_at field already exists');
        } else {
          await conn.execute(
            "ALTER TABLE stores ADD COLUMN last_sync_at DATETIME DEFAULT NULL COMMENT '最后同步时间'"
          );
          console.log('last_sync_at field added successfully');
        }
        
        const [result] = await conn.execute('DESCRIBE stores');
        console.log('\\nTable structure:');
        console.table(result);
        
        await conn.end();
      } catch (err) {
        console.error('Error:', err.message);
      }
    })();
  `
  
  sshConn.exec(`node -e "${nodeScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, (err, stream) => {
    let out = ''
    stream.on('data', d => out += d.toString())
    stream.stderr.on('data', d => out += d.toString())
    stream.on('close', () => {
      console.log(out)
      sshConn.end()
    })
  })
}

conn.connect(sshConfig)
