const mysql = require('mysql2/promise');
(async () => {
  const pool = mysql.createPool({
    host: 'localhost', port: 3307, user: 'root',
    password: 'jd123456', database: 'dianxiaoer'
  });
  // 检查 user_tokens 表
  const [tokens] = await pool.execute('SELECT ut.token, ut.user_id, u.username, u.user_type, u.parent_id FROM user_tokens ut JOIN users u ON ut.user_id = u.id ORDER BY ut.id DESC LIMIT 10');
  console.log('=== recent tokens ===');
  tokens.forEach(t => console.log('user_id=' + t.user_id + ' username=' + t.username + ' type=' + t.user_type + ' parent=' + t.parent_id + ' token=' + t.token.substring(0,20) + '...'));

  // 模拟 API 调用：用最新的店小二 token 查询
  var dxeToken = tokens.find(t => t.username === '店小二');
  if (dxeToken) {
    console.log('\n=== simulating API for dianxiaoer ===');
    console.log('user_id:', dxeToken.user_id, 'user_type:', dxeToken.user_type);
    var ownerId = dxeToken.user_type === 'master' ? dxeToken.user_id : dxeToken.parent_id;
    console.log('owner_id:', ownerId);
    var [accounts] = await pool.execute('SELECT id, account, platform FROM purchase_accounts WHERE owner_id=?', [ownerId]);
    console.log('purchase_accounts:', JSON.stringify(accounts));
    var [wh] = await pool.execute('SELECT id, name FROM warehouses WHERE owner_id=?', [ownerId]);
    console.log('warehouses:', JSON.stringify(wh));
  } else {
    console.log('No token found for dianxiaoer');
  }
  await pool.end();
})();
