const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });

  // 1. Show purchase_orders table structure
  console.log('=== purchase_orders 表结构 ===');
  const [cols] = await conn.query('DESCRIBE purchase_orders');
  cols.forEach(c => console.log(`  ${c.Field} | ${c.Type} | ${c.Null} | Key:${c.Key}`));

  // 2. Check if logistics columns exist
  const colNames = cols.map(c => c.Field);
  const needLogisticsNo = !colNames.includes('logistics_no');
  const needLogisticsCompany = !colNames.includes('logistics_company');

  if (needLogisticsNo || needLogisticsCompany) {
    console.log('\n>>> 缺少物流列，正在添加...');
    if (needLogisticsNo) {
      await conn.query("ALTER TABLE purchase_orders ADD COLUMN logistics_no VARCHAR(100) DEFAULT '' COMMENT '物流单号' AFTER shipping_address");
      console.log('  Added: logistics_no');
    }
    if (needLogisticsCompany) {
      await conn.query("ALTER TABLE purchase_orders ADD COLUMN logistics_company VARCHAR(100) DEFAULT '' COMMENT '物流公司' AFTER logistics_no");
      console.log('  Added: logistics_company');
    }
  } else {
    console.log('\n>>> 物流列已存在');
  }

  // 3. Show updated structure
  const [newCols] = await conn.query('DESCRIBE purchase_orders');
  console.log('\n=== 更新后表结构 ===');
  newCols.forEach(c => console.log(`  ${c.Field} | ${c.Type} | ${c.Null} | Key:${c.Key}`));

  await conn.end();
  console.log('\nDone!');
})().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
