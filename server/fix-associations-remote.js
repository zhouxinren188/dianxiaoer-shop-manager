const mysql = require('mysql2/promise');

(async () => {
  const dbConn = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });
  
  const [subAccounts] = await dbConn.execute(
    'SELECT id, username, parent_id FROM users WHERE user_type = ? AND parent_id IS NOT NULL',
    ['sub']
  );
  
  console.log('Found ' + subAccounts.length + ' sub accounts');
  
  let totalAdded = 0;
  for (const sub of subAccounts) {
    console.log('Processing: ' + sub.username + ' (ID: ' + sub.id + ')');
    
    const [masterStores] = await dbConn.execute(
      'SELECT id, name FROM stores WHERE owner_id = ?',
      [sub.parent_id]
    );
    
    console.log('  Master has ' + masterStores.length + ' stores');
    
    for (const store of masterStores) {
      const [existing] = await dbConn.execute(
        'SELECT 1 FROM user_stores WHERE user_id = ? AND store_id = ?',
        [sub.id, store.id]
      );
      
      if (existing.length === 0) {
        await dbConn.execute(
          'INSERT INTO user_stores (user_id, store_id) VALUES (?, ?)',
          [sub.id, store.id]
        );
        console.log('  Added: ' + store.name + ' (ID: ' + store.id + ')');
        totalAdded++;
      }
    }
  }
  
  console.log('Total added: ' + totalAdded);
  await dbConn.end();
})().catch(err => console.error('Error: ' + err.message));
