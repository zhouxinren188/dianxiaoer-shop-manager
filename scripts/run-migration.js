const mysql = require('C:/Users/Administrator/dianxiaoer-server/node_modules/mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });

  await conn.execute(`CREATE TABLE IF NOT EXISTS purchase_accounts (
    id INT PRIMARY KEY AUTO_INCREMENT,
    account VARCHAR(100) DEFAULT '',
    password VARCHAR(200) DEFAULT '',
    platform VARCHAR(20) DEFAULT '',
    online TINYINT DEFAULT 0,
    owner_id INT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  console.log('purchase_accounts table created');

  await conn.execute(`CREATE TABLE IF NOT EXISTS purchase_cookies (
    id INT PRIMARY KEY AUTO_INCREMENT,
    account_id INT NOT NULL,
    cookie_data LONGTEXT,
    platform VARCHAR(20) DEFAULT '',
    saved_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_account_id (account_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  console.log('purchase_cookies table created');

  await conn.end();
  console.log('Migration complete!');
})().catch(e => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
