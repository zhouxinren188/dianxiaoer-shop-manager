const { Client } = require('ssh2')

const conn = new Client()

conn.on('ready', () => {
  console.log('SSH connected\n')

  const script = `
const mysql = require('mysql2')

const connection = mysql.createConnection({
  host: '127.0.0.1',
  port: 3307,
  user: 'root',
  password: 'jd123456',
  database: 'dianxiaoer'
})

connection.connect(async (err) => {
  if (err) { console.error('DB error:', err.message); process.exit(1) }
  
  try {
    // 1. 检查同步锁表是否存在
    const [tables] = await connection.promise().query('SHOW TABLES LIKE "sync_locks"')
    
    if (tables.length === 0) {
      console.log('[INFO] sync_locks 表不存在，创建中...')
      await connection.promise().query(\`
        CREATE TABLE IF NOT EXISTS sync_locks (
          id INT PRIMARY KEY AUTO_INCREMENT,
          store_id INT NOT NULL,
          type VARCHAR(50) NOT NULL DEFAULT 'sales',
          device_id VARCHAR(255),
          locked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME,
          INDEX idx_store_type (store_id, type),
          INDEX idx_expires (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      \`)
      console.log('[OK] sync_locks 表已创建')
    } else {
      console.log('[OK] sync_locks 表已存在')
    }
    
    // 2. 清除所有过期的锁
    const [deleted] = await connection.promise().query('DELETE FROM sync_locks WHERE expires_at < NOW()')
    console.log('已清除过期锁:', deleted.affectedRows, '条')
    
    // 3. 显示当前所有锁
    const [locks] = await connection.promise().query('SELECT * FROM sync_locks')
    console.log('\\n当前同步锁数量:', locks.length)
    if (locks.length > 0) {
      console.log('锁列表:')
      locks.forEach(l => {
        console.log('  - store_id:' + l.store_id + ' type:' + l.type + ' device:' + (l.device_id || 'N/A') + ' expires:' + l.expires_at)
      })
      
      // 4. 询问是否清除所有锁（用于修复卡住的同步）
      console.log('\\n[INFO] 如需清除所有锁，请手动执行:')
      console.log('DELETE FROM sync_locks;')
    } else {
      console.log('[OK] 没有活动的同步锁')
    }
    
    // 5. 检查用户 18851240333 的订单
    const [users] = await connection.promise().query('SELECT id FROM users WHERE username = "18851240333"')
    if (users.length > 0) {
      const userId = users[0].id
      const [stores] = await connection.promise().query('SELECT id, name FROM stores WHERE owner_id = ?', [userId])
      console.log('\\n用户 18851240333 的店铺:')
      if (stores.length > 0) {
        stores.forEach(s => console.log('  - ID:' + s.id + ' Name:' + s.name))
        
        // 检查这些店铺的订单
        const storeIds = stores.map(s => s.id)
        const placeholders = storeIds.map(() => '?').join(',')
        const [orderCounts] = await connection.promise().query(
          'SELECT store_id, COUNT(*) as count FROM sales_orders WHERE store_id IN (' + placeholders + ') GROUP BY store_id',
          storeIds
        )
        
        console.log('\\n各店铺订单数:')
        if (orderCounts.length === 0) {
          console.log('  [WARNING] 没有订单')
        } else {
          orderCounts.forEach(o => {
            const store = stores.find(s => s.id === o.store_id)
            console.log('  - ' + (store ? store.name : o.store_id) + ': ' + o.count + ' 条')
          })
        }
      } else {
        console.log('  [WARNING] 该用户没有店铺')
      }
    }
    
  } catch (e) {
    console.error('Error:', e.message)
  } finally {
    connection.end()
  }
})
`

  const remotePath = 'C:/Users/Administrator/dianxiaoer-server/clear-sync-locks.js'

  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message)
      process.exit(1)
    }

    sftp.writeFile(remotePath, script, 'utf8', (err) => {
      if (err) {
        console.error('Write error:', err.message)
        process.exit(1)
      }

      conn.exec('cd C:/Users/Administrator/dianxiaoer-server && node clear-sync-locks.js', (err, stream) => {
        let out = '', errOut = ''
        stream.on('data', d => out += d)
        stream.stderr.on('data', d => errOut += d)
        stream.on('close', (code) => {
          console.log(out)
          if (errOut) console.error('Errors:', errOut)

          conn.exec('del "C:\\Users\\Administrator\\dianxiaoer-server\\clear-sync-locks.js"', () => {
            conn.end()
          })
        })
      })
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
