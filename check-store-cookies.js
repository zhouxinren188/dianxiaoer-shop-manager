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
    // 1. 查找用户
    const [users] = await connection.promise().query('SELECT id FROM users WHERE username = "18851240333"')
    if (users.length === 0) { console.log('用户不存在'); connection.end(); return }
    
    const userId = users[0].id
    
    // 2. 查找该用户的店铺
    const [stores] = await connection.promise().query(
      'SELECT id, name, platform FROM stores WHERE owner_id = ?',
      [userId]
    )
    
    console.log('用户店铺:')
    for (const store of stores) {
      console.log('店铺:', store.name, '| ID:', store.id, '| 平台:', store.platform)
      
      // 检查 Cookie
      const [cookies] = await connection.promise().query(
        'SELECT id, domain, LENGTH(cookie_data) as cookie_len, saved_at FROM cookies WHERE store_id = ?',
        [store.id]
      )
      
      if (cookies.length > 0) {
        console.log('  Cookie: 有 (' + cookies.length + '条, 最后更新:' + cookies[0].saved_at + ')')
      } else {
        console.log('  Cookie: 无')
      }
      
      // 检查订单
      const [orders] = await connection.promise().query(
        'SELECT COUNT(*) as count FROM sales_orders WHERE store_id = ?',
        [store.id]
      )
      console.log('  订单数:', orders[0].count)
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
    sftp.writeFile('C:/Users/Administrator/dianxiaoer-server/check-store-cookies.js', script, 'utf8', (err) => {
      if (err) { console.error('Write:', err.message); process.exit(1) }
      conn.exec('cd C:/Users/Administrator/dianxiaoer-server && node check-store-cookies.js', (err, stream) => {
        let out = '', errOut = ''
        stream.on('data', d => out += d)
        stream.stderr.on('data', d => errOut += d)
        stream.on('close', () => {
          console.log(out)
          if (errOut) console.error(errOut)
          conn.exec('del "C:\\Users\\Administrator\\dianxiaoer-server\\check-store-cookies.js"', () => conn.end())
        })
      })
    })
  })
})

conn.on('error', err => { console.error('SSH:', err.message); process.exit(1) })
conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', password: 'K9#m2$vL5@zQ' })
