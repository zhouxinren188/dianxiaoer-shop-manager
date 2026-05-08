const mysql = require('../server/node_modules/mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });

  // 添加 birthday 字段到 purchase_accounts 表
  try {
    await conn.execute(`ALTER TABLE purchase_accounts ADD COLUMN birthday VARCHAR(20) DEFAULT '' AFTER password`);
    console.log('birthday column added to purchase_accounts');
  } catch (e) {
    if (e.message.includes('Duplicate column')) {
      console.log('birthday column already exists, skipped');
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
