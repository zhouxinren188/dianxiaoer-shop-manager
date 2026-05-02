const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: '150.158.54.108',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });
  
  console.log('=== 巨马电商账号信息 ===');
  
  const [users] = await conn.execute(
    'SELECT id, username, user_type, parent_id, status FROM users WHERE username = ?',
    ['巨马电商']
  );
  
  if (users.length === 0) {
    console.log('未找到该账号');
    await conn.end();
    return;
  }
  
  const user = users[0];
  console.log('ID:', user.id);
  console.log('用户名:', user.username);
  console.log('账号类型:', user.user_type);
  console.log('父账号ID:', user.parent_id);
  console.log('状态:', user.status);
  
  if (user.user_type !== 'master' && user.parent_id) {
    const [parents] = await conn.execute(
      'SELECT id, username FROM users WHERE id = ?',
      [user.parent_id]
    );
    if (parents.length > 0) {
      console.log('所属主账号:', parents[0].username, '(ID:', parents[0].id + ')');
    }
  }
  
  console.log('\n=== 店铺关联信息 ===');
  
  if (user.user_type === 'master') {
    const [stores] = await conn.execute(
      'SELECT id, name, platform, owner_id FROM stores WHERE owner_id = ? ORDER BY id DESC',
      [user.id]
    );
    console.log('该主账号名下的店铺 (' + stores.length + ' 家):');
    stores.forEach(s => console.log('  - ID:', s.id, '名称:', s.name, '平台:', s.platform, 'owner_id:', s.owner_id));
  } else {
    const [stores] = await conn.execute(
      `SELECT s.id, s.name, s.platform, s.owner_id 
       FROM stores s
       INNER JOIN user_stores us ON s.id = us.store_id
       WHERE us.user_id = ? AND s.owner_id = ?
       ORDER BY s.id DESC`,
      [user.id, user.parent_id]
    );
    console.log('该子账号可访问的店铺 (' + stores.length + ' 家):');
    if (stores.length === 0) {
      console.log('  无店铺关联！');
    }
    stores.forEach(s => console.log('  - ID:', s.id, '名称:', s.name, '平台:', s.platform, 'owner_id:', s.owner_id));
    
    const [allStores] = await conn.execute(
      'SELECT id, name, owner_id FROM stores WHERE owner_id = ? ORDER BY id DESC',
      [user.parent_id]
    );
    console.log('\n主账号名下的所有店铺 (' + allStores.length + ' 家):');
    allStores.forEach(s => console.log('  - ID:', s.id, '名称:', s.name, 'owner_id:', s.owner_id));
  }
  
  console.log('\n=== user_stores 关联表 ===');
  const [userStores] = await conn.execute(
    'SELECT us.user_id, u.username, us.store_id, s.name FROM user_stores us JOIN users u ON us.user_id = u.id JOIN stores s ON us.store_id = s.id WHERE us.user_id = ? ORDER BY us.store_id',
    [user.id]
  );
  if (userStores.length === 0) {
    console.log('该账号没有店铺关联记录');
  } else {
    userStores.forEach(us => console.log('  - 用户:', us.username, '(ID:', us.user_id + ')', '店铺:', us.name, '(ID:', us.store_id + ')'));
  }
  
  await conn.end();
  console.log('\n查询完成');
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
