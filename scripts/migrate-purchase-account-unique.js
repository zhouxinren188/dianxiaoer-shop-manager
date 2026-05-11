const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    password: 'Qwer1234!',
    database: 'dianxiaoer'
  });

  // 先查看现有索引
  const [indexes] = await conn.execute('SHOW INDEX FROM purchase_accounts WHERE Non_unique=0');
  console.log('Current unique indexes:');
  indexes.forEach(x => console.log(`  ${x.Key_name}: ${x.Column_name} (seq=${x.Seq_in_index})`));

  // 删除可能存在的旧唯一索引
  for (const idx of indexes) {
    if (idx.Key_name !== 'PRIMARY') {
      try {
        await conn.execute(`ALTER TABLE purchase_accounts DROP INDEX ${idx.Key_name}`);
        console.log(`Dropped old index: ${idx.Key_name}`);
      } catch (e) {
        console.log(`Failed to drop ${idx.Key_name}: ${e.code}`);
      }
    }
  }

  // 创建新的唯一索引：同平台同账号不可重复
  try {
    await conn.execute('ALTER TABLE purchase_accounts ADD UNIQUE KEY uk_account_platform_owner (account, platform, owner_id)');
    console.log('Created new unique index: uk_account_platform_owner (account, platform, owner_id)');
  } catch (e) {
    console.log('Failed to create index:', e.message);
  }

  // 验证
  const [newIndexes] = await conn.execute('SHOW INDEX FROM purchase_accounts WHERE Non_unique=0');
  console.log('New unique indexes:');
  newIndexes.forEach(x => console.log(`  ${x.Key_name}: ${x.Column_name} (seq=${x.Seq_in_index})`));

  await conn.end();
})();
