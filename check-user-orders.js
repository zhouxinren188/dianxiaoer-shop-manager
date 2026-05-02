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
  if (err) {
    console.error('数据库连接失败:', err.message)
    process.exit(1)
  }
  
  try {
    // 1. 查找用户 18851240333
    const [users] = await connection.promise().query(
      'SELECT id, username, role FROM users WHERE username = ?',
      ['18851240333']
    )
    
    if (users.length === 0) {
      console.log('[ERROR] 用户 18851240333 不存在')
      connection.end()
      process.exit(1)
    }
    
    const user = users[0]
    console.log('用户信息:')
    console.log('  ID:', user.id)
    console.log('  Username:', user.username)
    console.log('  Role:', user.role)
    
    // 2. 查找该用户拥有的店铺
    const [stores] = await connection.promise().query(
      'SELECT id, name, platform FROM stores WHERE owner_id = ? OR id IN (SELECT store_id FROM store_permissions WHERE user_id = ?)',
      [user.id, user.id]
    )
    
    console.log('\\n该用户可访问的店铺数量:', stores.length)
    if (stores.length > 0) {
      console.log('店铺列表:')
      stores.forEach(s => console.log('  - ID:', s.id, 'Name:', s.name, 'Platform:', s.platform))
    }
    
    // 3. 检查该用户店铺的订单数量
    if (stores.length > 0) {
      const storeIds = stores.map(s => s.id)
      const placeholders = storeIds.map(() => '?').join(',')
      const [orderCounts] = await connection.promise().query(
        \`SELECT store_id, COUNT(*) as count FROM sales_orders WHERE store_id IN (\${placeholders}) GROUP BY store_id\`,
        storeIds
      )
      
      console.log('\\n各店铺订单数量:')
      if (orderCounts.length === 0) {
        console.log('  [WARNING] 该用户的所有店铺都没有订单！')
      } else {
        orderCounts.forEach(o => {
          const store = stores.find(s => s.id === o.store_id)
          console.log(\`  - \${store ? store.name : 'Unknown'} (ID:\${o.store_id}): \${o.count} 条订单\`)
        })
      }
      
      // 4. 显示最新的几条订单
      const [recentOrders] = await connection.promise().query(
        \`SELECT order_id, status_text, order_time, buyer_name FROM sales_orders WHERE store_id IN (\${placeholders}) ORDER BY order_time DESC LIMIT 5\`,
        storeIds
      )
      
      if (recentOrders.length > 0) {
        console.log('\\n最近 5 条订单:')
        recentOrders.forEach(o => {
          console.log(\`  - \${o.order_id} | \${o.status_text} | \${o.order_time} | \${o.buyerName}\`)
        })
      }
    }
    
    // 5. 检查同步锁
    const [lockTables] = await connection.promise().query('SHOW TABLES LIKE "sync_locks"')
    if (lockTables.length > 0) {
      const [locks] = await connection.promise().query('SELECT * FROM sync_locks ORDER BY created_at DESC LIMIT 10')
      console.log('\\n最近的同步锁记录:')
      locks.forEach(l => {
        console.log(\`  - store_id:\${l.store_id} type:\${l.type} device:\${l.device_id?.substring(0, 20)}... created:\${l.created_at}\`)
      })
    } else {
      console.log('\\n[INFO] sync_locks 表不存在，同步锁使用降级模式')
    }
    
  } catch (err) {
    console.error('Error:', err.message)
  } finally {
    connection.end()
  }
})
`

  const remotePath = 'C:/Users/Administrator/dianxiaoer-server/check-user-orders.js'

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

      conn.exec('cd C:/Users/Administrator/dianxiaoer-server && node check-user-orders.js', (err, stream) => {
        let out = '', errOut = ''
        stream.on('data', d => out += d)
        stream.stderr.on('data', d => errOut += d)
        stream.on('close', (code) => {
          console.log(out)
          if (errOut) console.error('Errors:', errOut)

          conn.exec('del C:\\Users\\Administrator\\dianxiaoer-server\\check-user-orders.js', () => {
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
