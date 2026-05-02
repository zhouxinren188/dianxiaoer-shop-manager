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

connection.connect((err) => {
  if (err) {
    console.error('数据库连接失败:', err.message)
    process.exit(1)
  }
  
  // 1. 检查 sales_orders 表是否存在
  connection.query('SHOW TABLES LIKE "sales_orders"', (err, results) => {
    if (err) {
      console.error('检查表失败:', err.message)
      connection.end()
      process.exit(1)
    }
    
    if (results.length === 0) {
      console.log('[ERROR] sales_orders 表不存在！')
      connection.end()
      process.exit(1)
    }
    
    console.log('[OK] sales_orders 表存在')
    
    // 2. 检查表结构
    connection.query('DESCRIBE sales_orders', (err, columns) => {
      if (err) {
        console.error('检查表结构失败:', err.message)
      } else {
        console.log('\\n表结构字段数:', columns.length)
        console.log('主要字段:', columns.map(c => c.Field).join(', '))
      }
      
      // 3. 检查订单数量
      connection.query('SELECT COUNT(*) as count FROM sales_orders', (err, results) => {
        if (err) {
          console.error('查询订单数失败:', err.message)
        } else {
          console.log('\\n当前订单总数:', results[0].count)
        }
        
        // 4. 检查店铺 Cookie
        connection.query('SELECT id, name, platform FROM stores WHERE platform = "jd"', (err, jdStores) => {
          if (err) {
            console.error('查询店铺失败:', err.message)
          } else {
            console.log('\\n京东店铺数量:', jdStores.length)
            if (jdStores.length > 0) {
              console.log('京东店铺列表:')
              jdStores.forEach(s => console.log('  - ID:', s.id, 'Name:', s.name))
            }
          }
          
          // 5. 检查同步锁表
          connection.query('SHOW TABLES LIKE "sync_locks"', (err, results) => {
            if (err) {
              console.error('检查同步锁表失败:', err.message)
            } else {
              if (results.length > 0) {
                console.log('\\n[OK] sync_locks 表存在')
                connection.query('SELECT COUNT(*) as count FROM sync_locks', (err, results) => {
                  console.log('当前同步锁数量:', results[0].count)
                })
              } else {
                console.log('\\n[WARNING] sync_locks 表不存在')
              }
              
              connection.end()
            }
          })
        })
      })
    })
  })
})
`

  const remotePath = 'C:/Users/Administrator/dianxiaoer-server/check-sales-sync.js'

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

      conn.exec('cd C:/Users/Administrator/dianxiaoer-server && node check-sales-sync.js', (err, stream) => {
        let out = '', errOut = ''
        stream.on('data', d => out += d)
        stream.stderr.on('data', d => errOut += d)
        stream.on('close', (code) => {
          console.log(out)
          if (errOut) console.error('Errors:', errOut)

          conn.exec('del C:\\Users\\Administrator\\dianxiaoer-server\\check-sales-sync.js', () => {
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
