const mysql = require('C:/Users/Administrator/dianxiaoer-server/node_modules/mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });

  await conn.execute(`CREATE TABLE IF NOT EXISTS sku_purchase_config (
    id INT PRIMARY KEY AUTO_INCREMENT,
    sku_id VARCHAR(100) NOT NULL DEFAULT '',
    warehouse VARCHAR(100) DEFAULT '',
    platform VARCHAR(20) DEFAULT '',
    purchase_link TEXT,
    purchase_price DECIMAL(10,2) DEFAULT NULL,
    remark TEXT,
    owner_id INT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_sku_owner (sku_id, owner_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  console.log('sku_purchase_config table created');

  await conn.end();
  console.log('Migration complete!');
})().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
