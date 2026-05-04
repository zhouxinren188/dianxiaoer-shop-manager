const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({
    host: '127.0.0.1', port: 3307,
    user: 'root', password: 'jd123456', database: 'dianxiaoer'
  });
  const [rows] = await c.query(
    'SELECT id, purchase_no, status, logistics_no, logistics_company, platform, platform_order_no, account_id FROM purchase_orders ORDER BY id DESC LIMIT 10'
  );
  rows.forEach(r => console.log(JSON.stringify(r)));
  await c.end();
})().catch(e => console.error('ERROR:', e.message));
