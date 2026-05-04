const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({
    host: '127.0.0.1', port: 3307,
    user: 'root', password: 'jd123456', database: 'dianxiaoer'
  });
  // Check if the server has the 'local' source fallback
  const [rows] = await c.query('SELECT token FROM user_tokens LIMIT 1');
  console.log(JSON.stringify(rows));
  await c.end();
})().catch(e => console.error('ERROR:', e.message));
