const mysql = require('C:/dianxiaoer-api/node_modules/mysql2/promise');
(async () => {
  const c = await mysql.createConnection({host:'127.0.0.1',port:3307,user:'root',password:'jd123456',database:'dianxiaoer'});
  try {
    await c.execute('ALTER TABLE purchase_orders ADD COLUMN goods_image TEXT AFTER goods_name');
    console.log('OK: goods_image column added');
  } catch(e) {
    if (e.message.includes('Duplicate')) console.log('OK: goods_image column already exists');
    else throw e;
  }
  await c.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
