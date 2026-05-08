const mysql = require('mysql2/promise');
(async () => {
  try {
    const c = await mysql.createConnection({
      host: '127.0.0.1', port: 3307,
      user: 'root', password: 'jd123456', database: 'dianxiaoer'
    });
    const [rows] = await c.execute('DESCRIBE user_tokens');
    console.log(JSON.stringify(rows, null, 2));
    await c.end();
  } catch (e) {
    console.error('ERROR:', e.message);
  }
})();
