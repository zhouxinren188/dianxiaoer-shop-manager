const mysql = require('mysql2/promise');
(async () => {
  const pool = mysql.createPool({
    host: 'localhost', port: 3307, user: 'root',
    password: 'jd123456', database: 'dianxiaoer'
  });
  const [rows] = await pool.execute('SELECT * FROM warehouses');
  console.log(JSON.stringify(rows, null, 2));
  await pool.end();
})();
