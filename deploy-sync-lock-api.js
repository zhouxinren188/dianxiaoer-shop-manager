const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')

const conn = new Client()

conn.on('ready', () => {
  console.log('SSH connected')

  // 同步锁 API 代码
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
      
      if (isSameDevice) {
        return res.json(ok({ granted: true, message: '同一设备继续同步' }))
      }
      
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
const fs = require('fs')

const serverFile = 'C:/Users/Administrator/dianxiaoer-server/index.js'
let serverCode = fs.readFileSync(serverFile, 'utf8')

// 1. 添加同步锁 API 到公开路径
if (!serverCode.includes("/api/sync-lock")) {
  serverCode = serverCode.replace(
    "const publicPaths = ['/health']",
    "const publicPaths = ['/health', '/api/sync-lock']"
  )
  console.log('[OK] 已添加 /api/sync-lock 到公开路径')
}

// 2. 添加同步锁 API 实现
if (!serverCode.includes("app.post('/api/sync-lock/")) {
  // 在 app.listen 之前插入
  const insertPos = serverCode.indexOf('app.listen')
  if (insertPos !== -1) {
    serverCode = serverCode.slice(0, insertPos) + syncLockAPI + '\\n' + serverCode.slice(insertPos)
    console.log('[OK] 已添加同步锁 API')
  } else {
    console.log('[ERROR] 无法找到插入位置')
    process.exit(1)
  }
} else {
  console.log('[INFO] 同步锁 API 已存在')
}

fs.writeFileSync(serverFile, serverCode, 'utf8')
console.log('[OK] server/index.js 已更新')
`

  const remotePath = 'C:/Users/Administrator/dianxiaoer-server/deploy-sync-lock.js'

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

      conn.exec('cd C:/Users/Administrator/dianxiaoer-server && node deploy-sync-lock.js', (err, stream) => {
        let out = '', errOut = ''
        stream.on('data', d => out += d)
        stream.stderr.on('data', d => errOut += d)
        stream.on('close', (code) => {
          console.log(out)
          if (errOut) console.error('Errors:', errOut)

          // 重启服务
          conn.exec('C:\\nssm\\nssm.exe restart dianxiaoer-server', (err, stream) => {
            let out2 = ''
            stream.on('data', d => out2 += d)
            stream.on('close', () => {
              console.log('服务重启输出:', out2)
              conn.exec('del "C:\\Users\\Administrator\\dianxiaoer-server\\deploy-sync-lock.js"', () => {
                conn.end()
              })
            })
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
