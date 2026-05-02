const mysql = require('C:/Users/Administrator/dianxiaoer-server/node_modules/mysql2/promise');
(async () => {
  const p = await mysql.createPool({host:'127.0.0.1',port:3307,user:'root',password:'jd123456',database:'dianxiaoer'});
  const [rows] = await p.query('SELECT id, purchase_no, platform_order_no, goods_name, goods_image, status, owner_id, created_at FROM purchase_orders ORDER BY id DESC LIMIT 10');
  console.log(JSON.stringify(rows, null, 2));
  await p.end();
})();
