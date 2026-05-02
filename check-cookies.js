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
    // 1. 查找用户 18851240333
    const [users] = await connection.promise().query('SELECT id FROM users WHERE username = "18851240333"')
    if (users.length === 0) { console.log('用户不存在'); connection.end(); return }
    
    const userId = users[0].id
    
    // 2. 查找该用户的店铺
    const [stores] = await connection.promise().query(
      'SELECT id, name, platform, cookie_data FROM stores WHERE owner_id = ?',
      [userId]
    )
    
    console.log('用户店铺数量:', stores.length)
    stores.forEach(s => {
      console.log('店铺:', s.name, '| ID:', s.id, '| 平台:', s.platform, '| Cookie:', s.cookie_data ? '有 (' + s.cookie_data.substring(0, 50) + '...)' : '无')
    })
    
    // 3. 检查该店铺的订单
    if (stores.length > 0) {
      const storeIds = stores.map(s => s.id)
      const placeholders = storeIds.map(() => '?').join(',')
      const [orders] = await connection.promise().query(
        'SELECT COUNT(*) as count FROM sales_orders WHERE store_id IN (' + placeholders + ')',
        storeIds
      )
      console.log('\\n订单总数:', orders[0].count)
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
    sftp.writeFile('C:/Users/Administrator/dianxiaoer-server/check-cookies.js', script, 'utf8', (err) => {
      if (err) { console.error('Write:', err.message); process.exit(1) }
      conn.exec('cd C:/Users/Administrator/dianxiaoer-server && node check-cookies.js', (err, stream) => {
        let out = '', errOut = ''
        stream.on('data', d => out += d)
        stream.stderr.on('data', d => errOut += d)
        stream.on('close', () => {
          console.log(out)
          if (errOut) console.error(errOut)
          conn.exec('del "C:\\Users\\Administrator\\dianxiaoer-server\\check-cookies.js"', () => conn.end())
        })
      })
    })
  })
})

conn.on('error', err => { console.error('SSH:', err.message); process.exit(1) })
conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', password: 'K9#m2$vL5@zQ' })
