const { Client } = require('ssh2')

const conn = new Client()

conn.on('ready', () => {
  console.log('SSH connected\n')

  // 1. 创建同步锁表
  const createTableSQL = `
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
`

  // 2. 添加同步锁 API 到服务器
  const syncLockAPI = `

// ============ 同步锁 API ============

// 请求同步锁
app.post('/api/sync-lock/:storeId', async (req, res) => {
  try {
    const { storeId } = req.params
    const { deviceId, type = 'sales' } = req.body
    
    // 清理过期锁
    await pool.execute('DELETE FROM sync_locks WHERE expires_at < NOW()')
    
    // 检查是否已有锁
    const [locks] = await pool.execute(
      'SELECT * FROM sync_locks WHERE store_id = ? AND type = ?',
      [storeId, type]
    )
    
    if (locks.length > 0) {
      const lock = locks[0]
      const isSameDevice = lock.device_id === deviceId
      
      // 如果是同一设备，允许继续
      if (isSameDevice) {
        return res.json(ok({ granted: true, message: '同一设备继续同步' }))
      }
      
      // 否则拒绝
      return res.json(ok({ 
        granted: false, 
        message: '该店铺正在同步中',
        lastSyncAt: lock.locked_at
      }))
    }
    
    // 创建新锁（30 分钟超时）
    await pool.execute(
      'INSERT INTO sync_locks (store_id, type, device_id, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))',
      [storeId, type, deviceId]
    )
    
    res.json(ok({ granted: true, message: '锁获取成功' }))
  } catch (err) {
    console.error('[SyncLock] Error:', err.message)
    res.status(500).json(fail(err.message))
  }
})

// 释放同步锁
app.delete('/api/sync-lock/:storeId', async (req, res) => {
  try {
    const { storeId } = req.params
    const { type = 'sales' } = req.body
    
    await pool.execute(
      'DELETE FROM sync_locks WHERE store_id = ? AND type = ?',
      [storeId, type]
    )
    
    res.json(ok({ message: '锁已释放' }))
  } catch (err) {
    console.error('[SyncLock] Release Error:', err.message)
    res.status(500).json(fail(err.message))
  }
})

`

  const script = `
const mysql = require('mysql2')
const fs = require('fs')

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
    // 1. 创建同步锁表
    await connection.promise().query(\`${createTableSQL.replace(/`/g, '\\\\`')}\`)
    console.log('[OK] sync_locks 表已创建或已存在')
    
    // 2. 读取当前 server/index.js
    const serverFile = 'C:/Users/Administrator/dianxiaoer-server/server/index.js'
    let serverCode = fs.readFileSync(serverFile, 'utf8')
    
    // 检查是否已添加同步锁 API
    if (serverCode.includes('/api/sync-lock/')) {
      console.log('[INFO] 同步锁 API 已存在，跳过添加')
    } else {
      // 在文件末尾（最后一个 } 之前）添加同步锁 API
      const insertPos = serverCode.lastIndexOf('\\n})')
      if (insertPos !== -1) {
        serverCode = serverCode.slice(0, insertPos) + syncLockAPI + '\\n' + serverCode.slice(insertPos)
        fs.writeFileSync(serverFile, serverCode, 'utf8')
        console.log('[OK] 同步锁 API 已添加到 server/index.js')
      } else {
        console.log('[ERROR] 无法找到插入位置')
      }
    }
    
    console.log('\\n完成！请重启 3002 端口服务。')
    
  } catch (e) {
    console.error('Error:', e.message)
  } finally {
    connection.end()
  }
})
`

  const remotePath = 'C:/Users/Administrator/dianxiaoer-server/setup-sync-lock.js'

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

      conn.exec('cd C:/Users/Administrator/dianxiaoer-server && node setup-sync-lock.js', (err, stream) => {
        let out = '', errOut = ''
        stream.on('data', d => out += d)
        stream.stderr.on('data', d => errOut += d)
        stream.on('close', (code) => {
          console.log(out)
          if (errOut) console.error('Errors:', errOut)

          conn.exec('del "C:\\Users\\Administrator\\dianxiaoer-server\\setup-sync-lock.js"', () => {
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
