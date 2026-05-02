// 为本地开发数据库的 stores 表添加 last_sync_at 字段
const { execSync } = require('child_process')
const path = require('path')

console.log('为本地开发数据库添加 last_sync_at 字段...')

try {
  // 使用 sqlite3 命令行工具（如果本地使用 SQLite）
  // 或者使用 mysql 命令行工具（如果本地使用 MySQL）
  
  // 这里我们直接通过 Electron API 来执行 SQL
  // 但由于我们在 Node.js 环境中，需要直接连接数据库
  
  const mysql = require('mysql2/promise')
  
  const dbConfig = {
    host: '127.0.0.1',
    port: 3306,  // 本地开发数据库端口
    user: 'root',
    password: '',
    database: 'dianxiaoer'
  }
  
  async function addColumn() {
    let conn
    try {
      conn = await mysql.createConnection(dbConfig)
      
      // 检查列是否已存在
      const [columns] = await conn.execute(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'stores' AND COLUMN_NAME = 'last_sync_at'",
        [dbConfig.database]
      )
      
      if (columns.length > 0) {
        console.log('✅ last_sync_at 字段已存在')
        return
      }
      
      console.log('添加 last_sync_at 字段...')
      await conn.execute(
        "ALTER TABLE stores ADD COLUMN last_sync_at DATETIME DEFAULT NULL COMMENT '最后同步时间'"
      )
      
      console.log('✅ last_sync_at 字段添加成功')
    } catch (err) {
      if (err.code === 'ECONNREFUSED') {
        console.log('⚠️  本地数据库未启动，跳过字段添加')
        console.log('提示：请在远程服务器数据库中手动执行以下 SQL:')
        console.log('ALTER TABLE stores ADD COLUMN last_sync_at DATETIME DEFAULT NULL;')
      } else {
        console.error('❌ 添加字段失败:', err.message)
      }
    } finally {
      if (conn) await conn.end()
    }
  }
  
  addColumn()
} catch (err) {
  console.log('无法连接本地数据库，请确保：')
  console.log('1. 远程服务器数据库已添加 last_sync_at 字段')
  console.log('2. 或手动执行 SQL: ALTER TABLE stores ADD COLUMN last_sync_at DATETIME DEFAULT NULL;')
}
