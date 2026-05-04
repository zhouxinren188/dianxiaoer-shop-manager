const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({
    host: '127.0.0.1', port: 3307,
    user: 'root', password: 'jd123456', database: 'dianxiaoer'
  });
  const [users] = await c.query('SELECT id, username, user_type, parent_id FROM users');
  console.log('Users:', JSON.stringify(users));
  const [tokens] = await c.query('SELECT ut.user_id, ut.token, u.username FROM user_tokens ut JOIN users u ON ut.user_id = u.id');
  console.log('Tokens:', JSON.stringify(tokens));
  await c.end();
})().catch(e => console.error('ERROR:', e.message));
