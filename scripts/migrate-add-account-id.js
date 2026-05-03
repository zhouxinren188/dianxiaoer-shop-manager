/**
 * 数据库迁移脚本：为采购订单表添加 account_id 字段
 * 执行：node scripts/migrate-add-account-id.js
 */

const mysql = require('mysql2/promise');

async function migrate() {
  const connection = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });

  try {
    console.log('[Migrate] 开始执行数据库迁移...');
    
    // 检查 account_id 字段是否已存在
    const [columns] = await connection.execute(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = 'dianxiaoer' 
        AND TABLE_NAME = 'purchase_orders' 
        AND COLUMN_NAME = 'account_id'
    `);

    if (columns.length > 0) {
      console.log('[Migrate] account_id 字段已存在，跳过迁移');
    } else {
      // 添加 account_id 字段
      await connection.execute(`
        ALTER TABLE purchase_orders
        ADD COLUMN account_id INT DEFAULT NULL COMMENT '采购账号ID',
        ADD INDEX idx_account_id (account_id)
      `);
      console.log('[Migrate] account_id 字段添加成功');
      console.log('[Migrate] 已创建索引 idx_account_id');
    }

    // 验证迁移结果
    const [result] = await connection.execute(`
      DESCRIBE purchase_orders
    `);
    
    console.log('\n[Migrate] purchase_orders 表结构：');
    result.forEach(col => {
      console.log(`  - ${col.Field} (${col.Type}) ${col.Null === 'YES' ? 'NULL' : 'NOT NULL'}`);
    });

    console.log('\n[Migrate] 数据库迁移完成！');
    
  } catch (error) {
    console.error('[Migrate] 迁移失败:', error.message);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

migrate();
