const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: '127.0.0.1', port: 3307, user: 'root', password: 'jd123456', database: 'dianxiaoer'
  });

  // Check table structure
  const tables = ['sku_purchase_config', 'purchase_accounts', 'purchase_cookies', 'purchase_orders'];
  for (const t of tables) {
    const [exists] = await conn.execute("SHOW TABLES LIKE '" + t + "'");
    if (!exists.length) {
      process.stdout.write(t + ': NOT EXISTS\n');
      continue;
    }
    process.stdout.write('\n=== ' + t + ' ===\n');
    const [cols] = await conn.execute('SHOW COLUMNS FROM ' + t);
    cols.forEach(c => process.stdout.write('  ' + c.Field + ' ' + c.Type + (c.Key ? ' [' + c.Key + ']' : '') + '\n'));
    const [indexes] = await conn.execute('SHOW INDEX FROM ' + t);
    process.stdout.write('  INDEXES:\n');
    indexes.forEach(i => process.stdout.write('    ' + i.Key_name + ': ' + i.Column_name + (i.Non_unique === 0 ? ' (UNIQUE)' : '') + '\n'));
    
    // Check row count
    const [[{ cnt }]] = await conn.execute('SELECT COUNT(*) as cnt FROM ' + t);
    process.stdout.write('  ROWS: ' + cnt + '\n');
  }
  
  // Check sku_purchase_config data
  const [skuRows] = await conn.execute('SELECT * FROM sku_purchase_config ORDER BY id');
  process.stdout.write('\n=== sku_purchase_config DATA ===\n');
  skuRows.forEach(r => process.stdout.write(JSON.stringify(r) + '\n'));
  
  await conn.end();
})();
