/**
 * 修复子账号店铺关联脚本
 * 为所有子账号自动关联其主账号名下的所有店铺
 */

const mysql = require('mysql2/promise');

async function fixStoreAssociations() {
  console.log('=== 开始修复子账号店铺关联 ===\n');
  
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });
  
  try {
    // 1. 查询所有子账号
    const [subAccounts] = await conn.execute(
      'SELECT id, username, parent_id FROM users WHERE user_type = "sub" AND parent_id IS NOT NULL'
    );
    
    console.log('找到', subAccounts.length, '个子账号');
    
    if (subAccounts.length === 0) {
      console.log('没有子账号，无需修复');
      return;
    }
    
    // 2. 为每个子账号关联其主账号名下的所有店铺
    let totalAdded = 0;
    for (const sub of subAccounts) {
      console.log(`\n处理子账号: ${sub.username} (ID: ${sub.id}, 主账号ID: ${sub.parent_id})`);
      
      // 查询主账号名下的所有店铺
      const [masterStores] = await conn.execute(
        'SELECT id, name FROM stores WHERE owner_id = ?',
        [sub.parent_id]
      );
      
      console.log(`  主账号名下有 ${masterStores.length} 家店铺`);
      
      // 为每个店铺添加关联（如果不存在）
      for (const store of masterStores) {
        const [existing] = await conn.execute(
          'SELECT 1 FROM user_stores WHERE user_id = ? AND store_id = ?',
          [sub.id, store.id]
        );
        
        if (existing.length === 0) {
          await conn.execute(
            'INSERT INTO user_stores (user_id, store_id) VALUES (?, ?)',
            [sub.id, store.id]
          );
          console.log(`  ✅ 已关联店铺: ${store.name} (ID: ${store.id})`);
          totalAdded++;
        } else {
          console.log(`  ⏭️  已存在关联: ${store.name} (ID: ${store.id})`);
        }
      }
    }
    
    console.log(`\n=== 修复完成 ===`);
    console.log(`总共添加了 ${totalAdded} 条店铺关联记录`);
    
  } finally {
    await conn.end();
  }
}

fixStoreAssociations().catch(err => {
  console.error('修复失败:', err.message);
  process.exit(1);
});
