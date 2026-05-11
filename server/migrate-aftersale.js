/**
 * 售后纠纷指标 - 数据库迁移脚本
 * 在远程服务器上运行此脚本，创建 store_aftersale_metrics 表
 * 运行方式: node migrate-aftersale.js
 */

const mysql = require('mysql2/promise')

const dbConfig = {
  host: '127.0.0.1',
  port: 3307,
  user: 'root',
  password: 'jd123456',
  database: 'dianxiaoer'
}

async function migrate() {
  const connection = await mysql.createConnection(dbConfig)

  try {
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS store_aftersale_metrics (
        id INT PRIMARY KEY AUTO_INCREMENT,
        store_id INT NOT NULL,
        platform VARCHAR(20) DEFAULT '',
        overdue_orders INT DEFAULT 0,
        pending_follow_ups INT DEFAULT 0,
        cancelled_orders INT DEFAULT 0,
        pending_review_aftersales INT DEFAULT 0,
        pending_process_aftersales INT DEFAULT 0,
        pending_receive_aftersales INT DEFAULT 0,
        pending_reply_disputes INT DEFAULT 0,
        pending_evidence_disputes INT DEFAULT 0,
        pending_execute_disputes INT DEFAULT 0,
        pending_compensation INT DEFAULT 0,
        pending_warnings INT DEFAULT 0,
        pending_violations INT DEFAULT 0,
        pending_industry_complaints INT DEFAULT 0,
        pending_task_orders INT DEFAULT 0,
        raw_data LONGTEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_store_platform (store_id, platform)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    console.log('[迁移] store_aftersale_metrics 表创建成功')

    // 验证表结构
    const [cols] = await connection.execute('DESCRIBE store_aftersale_metrics')
    console.log('[迁移] 表结构:')
    cols.forEach(c => console.log(`  ${c.Field} ${c.Type} ${c.Null} ${c.Key}`))

  } catch (err) {
    console.error('[迁移] 错误:', err.message)
    throw err
  } finally {
    await connection.end()
  }
}

migrate().then(() => {
  console.log('[迁移] 完成')
  process.exit(0)
}).catch(err => {
  console.error('[迁移] 失败:', err.message)
  process.exit(1)
})