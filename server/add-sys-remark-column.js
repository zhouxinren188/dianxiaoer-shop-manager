const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });

  console.log('=== 检查 sales_orders 表 sys_remark 列 ===');
  const [cols] = await conn.query('DESCRIBE sales_orders');
  const colNames = cols.map(c => c.Field);

  if (!colNames.includes('sys_remark')) {
    console.log('>>> 添加 sys_remark 列...');
    await conn.query("ALTER TABLE sales_orders ADD COLUMN sys_remark TEXT DEFAULT NULL COMMENT '系统备注（采购绑定等自动写入）' AFTER remark");
    console.log('  Added: sys_remark');
  } else {
    console.log('>>> sys_remark 列已存在');
  }

  const [newCols] = await conn.query('DESCRIBE sales_orders');
  const remarkCol = newCols.find(c => c.Field === 'sys_remark');
  if (remarkCol) {
    console.log(`  sys_remark: ${remarkCol.Type} | ${remarkCol.Null} | ${remarkCol.Default}`);
  }

  await conn.end();
  console.log('\nDone!');
})().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
