const mysql = require('C:/Users/Administrator/dianxiaoer-server/node_modules/mysql2/promise');
const fs = require('fs');

(async () => {
  // 1. 删除数据库中的 warehouse 列
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });

  try {
    await conn.execute('ALTER TABLE sku_purchase_config DROP COLUMN warehouse');
    console.log('Dropped warehouse column from sku_purchase_config');
  } catch (e) {
    if (e.message.includes("check that column/key exists")) {
      console.log('warehouse column already removed');
    } else {
      console.log('Drop column note:', e.message);
    }
  }
  await conn.end();

  // 2. 更新 index.js 中的路由代码，移除 warehouse 引用
  const filepath = 'C:/Users/Administrator/dianxiaoer-server/index.js';
  let content = fs.readFileSync(filepath, 'utf8');

  // 替换 POST /api/sku-purchase-config 路由中的 warehouse 相关代码
  content = content.replace(
    /const \{ sku_id, warehouse, platform, purchase_link, purchase_price, remark \} = req\.body/g,
    'const { sku_id, platform, purchase_link, purchase_price, remark } = req.body'
  );
  content = content.replace(
    /INSERT INTO sku_purchase_config \(sku_id, warehouse, platform, purchase_link, purchase_price, remark, owner_id\) VALUES \(\?, \?, \?, \?, \?, \?, \?\) ON DUPLICATE KEY UPDATE\s*warehouse = VALUES\(warehouse\),\s*platform = VALUES\(platform\)/g,
    'INSERT INTO sku_purchase_config (sku_id, platform, purchase_link, purchase_price, remark, owner_id) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE platform = VALUES(platform)'
  );
  content = content.replace(
    /\[sku_id, warehouse \|\| '', platform \|\| '', purchase_link \|\| '', purchase_price \|\| null, remark \|\| '', ownerId\]/g,
    "[sku_id, platform || '', purchase_link || '', purchase_price || null, remark || '', ownerId]"
  );

  fs.writeFileSync(filepath, content, 'utf8');
  console.log('Updated routes to remove warehouse references');
  console.log('Done!');
})().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
