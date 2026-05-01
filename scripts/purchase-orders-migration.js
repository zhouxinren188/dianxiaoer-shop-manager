const mysql = require('C:/Users/Administrator/dianxiaoer-server/node_modules/mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });

  await conn.execute(`CREATE TABLE IF NOT EXISTS purchase_orders (
    id INT PRIMARY KEY AUTO_INCREMENT,
    purchase_no VARCHAR(50) NOT NULL DEFAULT '',
    sales_order_id VARCHAR(50) DEFAULT '',
    sales_order_no VARCHAR(100) DEFAULT '',
    goods_name VARCHAR(500) DEFAULT '',
    goods_image TEXT,
    sku VARCHAR(200) DEFAULT '',
    quantity INT DEFAULT 1,
    source_url TEXT,
    platform VARCHAR(20) DEFAULT '',
    purchase_price DECIMAL(10,2) DEFAULT NULL,
    remark TEXT,
    platform_order_no VARCHAR(100) DEFAULT '',
    status VARCHAR(20) DEFAULT 'pending',
    owner_id INT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_purchase_no (purchase_no)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  console.log('purchase_orders table created');

  // 补充 goods_image 字段（已有表可能缺少此字段）
  try {
    await conn.execute(`ALTER TABLE purchase_orders ADD COLUMN goods_image TEXT AFTER goods_name`);
    console.log('goods_image column added');
  } catch (e) {
    if (e.message.includes('Duplicate column')) {
      console.log('goods_image column already exists, skipped');
    } else {
      throw e;
    }
  }

  await conn.end();
  console.log('Done!');
})().catch(e => {
  console.error('Failed:', e.message);
  process.exit(1);
});
