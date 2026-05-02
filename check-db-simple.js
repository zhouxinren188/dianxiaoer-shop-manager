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
    // 列出所有表
    const [tables] = await connection.promise().query('SHOW TABLES')
    console.log('数据库表列表:')
    tables.forEach(t => console.log('  - ' + Object.values(t)[0]))
    
    // 检查 stores 表结构
    const [storeCols] = await connection.promise().query('DESCRIBE stores')
    console.log('\\nstores 表字段:')
    storeCols.forEach(c => console.log('  ' + c.Field))
    
    // 检查用户 18851240333
    const [users] = await connection.promise().query('SELECT * FROM users WHERE username = "18851240333"')
    console.log('\\n用户 18851240333 信息:')
    if (users.length > 0) {
      console.log(JSON.stringify(users[0], null, 2))
    } else {
      console.log('用户不存在')
    }
    
    // 检查订单总数
    const [orders] = await connection.promise().query('SELECT COUNT(*) as total FROM sales_orders')
    console.log('\\n销售订单总数:', orders[0].total)
    
  } catch (e) {
    console.error('Error:', e.message)
  } finally {
    connection.end()
  }
})
`

  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP:', err.message); process.exit(1) }
    sftp.writeFile('C:/check.js', script, 'utf8', (err) => {
      if (err) { console.error('Write:', err.message); process.exit(1) }
      conn.exec('cd C:/ && node check.js && del check.js', (err, stream) => {
        let out = '', errOut = ''
        stream.on('data', d => out += d)
        stream.stderr.on('data', d => errOut += d)
        stream.on('close', () => { console.log(out); if(errOut) console.error(errOut); conn.end() })
      })
    })
  })
})

conn.on('error', err => { console.error('SSH:', err.message); process.exit(1) })
conn.connect({ host: '150.158.54.108', port: 22, username: 'administrator', password: 'K9#m2$vL5@zQ' })
