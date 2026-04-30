const mysql = require('mysql2/promise');
const fs = require('fs');

(async () => {
  const conn = await mysql.createConnection({
    host: '127.0.0.1', port: 3307, user: 'root', password: 'jd123456', database: 'dianxiaoer'
  });

  // Get a valid token
  const [tokens] = await conn.execute(
    'SELECT ut.token, u.id, u.username, u.user_type FROM user_tokens ut INNER JOIN users u ON ut.user_id = u.id WHERE u.status = "enabled" ORDER BY ut.created_at DESC LIMIT 1'
  );
  
  if (tokens.length) {
    const t = tokens[0];
    process.stdout.write(JSON.stringify({ token: t.token, userId: t.id, username: t.username, userType: t.user_type }));
  } else {
    process.stdout.write(JSON.stringify({ error: 'No valid token found' }));
  }
  
  await conn.end();
})();
