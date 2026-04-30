const mysql = require('C:/Users/Administrator/dianxiaoer-server/node_modules/mysql2/promise');
const fs = require('fs');

(async () => {
  // 1. 数据库：增加 purchase_type 和 shipping_address 字段
  const conn = await mysql.createConnection({
    host: '127.0.0.1', port: 3307, user: 'root', password: 'jd123456', database: 'dianxiaoer'
  });

  try {
    await conn.execute("ALTER TABLE purchase_orders ADD COLUMN purchase_type VARCHAR(20) DEFAULT 'dropship' AFTER remark");
    console.log('Added purchase_type column');
  } catch (e) {
    if (e.message.includes('Duplicate column')) console.log('purchase_type already exists');
    else console.log('purchase_type note:', e.message);
  }

  try {
    await conn.execute("ALTER TABLE purchase_orders ADD COLUMN shipping_name VARCHAR(50) DEFAULT '' AFTER purchase_type");
    console.log('Added shipping_name column');
  } catch (e) {
    if (e.message.includes('Duplicate column')) console.log('shipping_name already exists');
    else console.log('shipping_name note:', e.message);
  }

  try {
    await conn.execute("ALTER TABLE purchase_orders ADD COLUMN shipping_phone VARCHAR(30) DEFAULT '' AFTER shipping_name");
    console.log('Added shipping_phone column');
  } catch (e) {
    if (e.message.includes('Duplicate column')) console.log('shipping_phone already exists');
    else console.log('shipping_phone note:', e.message);
  }

  try {
    await conn.execute("ALTER TABLE purchase_orders ADD COLUMN shipping_address VARCHAR(500) DEFAULT '' AFTER shipping_phone");
    console.log('Added shipping_address column');
  } catch (e) {
    if (e.message.includes('Duplicate column')) console.log('shipping_address already exists');
    else console.log('shipping_address note:', e.message);
  }

  await conn.end();
  console.log('DB migration done');

  // 2. 更新路由：POST /api/purchase-orders 增加新字段
  const filepath = 'C:/Users/Administrator/dianxiaoer-server/index.js';
  let content = fs.readFileSync(filepath, 'utf8');

  // 更新 POST 路由的字段列表
  content = content.replace(
    "const { purchase_no, sales_order_id, sales_order_no, goods_name, sku, quantity, source_url, platform, purchase_price, remark } = req.body",
    "const { purchase_no, sales_order_id, sales_order_no, goods_name, sku, quantity, source_url, platform, purchase_price, remark, purchase_type, shipping_name, shipping_phone, shipping_address } = req.body"
  );

  content = content.replace(
    "INSERT INTO purchase_orders (purchase_no, sales_order_id, sales_order_no, goods_name, sku, quantity, source_url, platform, purchase_price, remark, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE goods_name=VALUES(goods_name), source_url=VALUES(source_url), platform=VALUES(platform), purchase_price=VALUES(purchase_price), remark=VALUES(remark)",
    "INSERT INTO purchase_orders (purchase_no, sales_order_id, sales_order_no, goods_name, sku, quantity, source_url, platform, purchase_price, remark, purchase_type, shipping_name, shipping_phone, shipping_address, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE goods_name=VALUES(goods_name), source_url=VALUES(source_url), platform=VALUES(platform), purchase_price=VALUES(purchase_price), remark=VALUES(remark), purchase_type=VALUES(purchase_type), shipping_name=VALUES(shipping_name), shipping_phone=VALUES(shipping_phone), shipping_address=VALUES(shipping_address)"
  );

  content = content.replace(
    "[purchase_no, sales_order_id || '', sales_order_no || '', goods_name || '', sku || '', quantity || 1, source_url || '', platform || '', purchase_price || null, remark || '', ownerId]",
    "[purchase_no, sales_order_id || '', sales_order_no || '', goods_name || '', sku || '', quantity || 1, source_url || '', platform || '', purchase_price || null, remark || '', purchase_type || 'dropship', shipping_name || '', shipping_phone || '', shipping_address || '', ownerId]"
  );

  fs.writeFileSync(filepath, content, 'utf8');
  console.log('Routes updated');
  console.log('All done!');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
