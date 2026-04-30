const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({host:'localhost',port:3307,user:'root',password:'jd123456',database:'dianxiaoer'});
  const [rows] = await c.query('SELECT id,purchase_no,platform_order_no,sales_order_no,goods_name,status,owner_id,created_at FROM purchase_orders ORDER BY id DESC LIMIT 10');
  console.log(JSON.stringify(rows, null, 2));
  await c.end();
})();
