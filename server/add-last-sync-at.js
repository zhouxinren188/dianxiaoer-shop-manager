// 为 stores 表添加 last_sync_at 字段
const mysql = require('mysql2/promise')
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3307,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'jd123456',
  database: process.env.DB_NAME || 'dianxiaoer'
}

async function addLastSyncAtColumn() {
  let conn
  try {
    console.log('连接到数据库...')
    conn = await mysql.createConnection(dbConfig)
    
    // 检查列是否已存在
    const [columns] = await conn.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'stores' AND COLUMN_NAME = 'last_sync_at'",
      [dbConfig.database]
    )
    
    if (columns.length > 0) {
      console.log('✅ last_sync_at 字段已存在，无需添加')
      return
    }
    
    console.log('添加 last_sync_at 字段...')
    await conn.execute(
      "ALTER TABLE stores ADD COLUMN last_sync_at DATETIME DEFAULT NULL COMMENT '最后同步时间'"
    )
    
    console.log('✅ last_sync_at 字段添加成功')
  } catch (err) {
    console.error('❌ 添加字段失败:', err.message)
    process.exit(1)
  } finally {
    if (conn) await conn.end()
  }
}

addLastSyncAtColumn()
