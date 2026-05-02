const { Client } = require('ssh2')

const conn = new Client()

conn.on('ready', () => {
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
    // 清除所有同步锁
    const [result] = await connection.promise().query('DELETE FROM sync_locks')
    console.log('已清除同步锁:', result.affectedRows, '条')
    
    // 检查用户 18851240333 的订单
    const [users] = await connection.promise().query('SELECT id FROM users WHERE username = "18851240333"')
    if (users.length > 0) {
      const userId = users[0].id
      const [stores] = await connection.promise().query('SELECT id, name FROM stores WHERE owner_id = ?', [userId])
      console.log('\\n用户 18851240333 的店铺:', stores.length, '个')
      
      if (stores.length > 0) {
        const storeIds = stores.map(s => s.id)
        const placeholders = storeIds.map(() => '?').join(',')
        
        // 检查订单
        const [orders] = await connection.promise().query(
          'SELECT COUNT(*) as count FROM sales_orders WHERE store_id IN (' + placeholders + ')',
          storeIds
        )
        console.log('订单总数:', orders[0].count)
        
        // 显示最近几条
        if (orders[0].count > 0) {
          const [recent] = await connection.promise().query(
            'SELECT order_id, status_text, order_time FROM sales_orders WHERE store_id IN (' + placeholders + ') ORDER BY created_at DESC LIMIT 5',
            storeIds
          )
          console.log('\\n最近订单:')
          recent.forEach(o => console.log('  ' + o.order_id + ' | ' + o.status_text + ' | ' + o.order_time))
        }
      }
    }
    
  } catch (e) {
    console.error('Error:', e.message)
  } finally {
    connection.end()
  }
})
`

  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP:', err.message); process.exit(1) }
    sftp.writeFile('C:/Users/Administrator/dianxiaoer-server/clear-locks.js', script, 'utf8', (err) => {
      if (err) { console.error('Write:', err.message); process.exit(1) }
      conn.exec('cd C:/Users/Administrator/dianxiaoer-server && node clear-locks.js', (err, stream) => {
        let out = '', errOut = ''
        stream.on('data', d => out += d)
        stream.stderr.on('data', d => errOut += d)
        stream.on('close', () => {
          console.log(out)
          if (errOut) console.error('Errors:', errOut)
          conn.exec('del "C:\\Users\\Administrator\\dianxiaoer-server\\clear-locks.js"', () => conn.end())
        })
      })
    })
  })
})

conn.on('error', err => { console.error('SSH:', err.message); process.exit(1) })
conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', password: 'K9#m2$vL5@zQ' })
