const { Client } = require('ssh2');
const fs = require('fs');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected');
  
  const queryScript = `
const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });
  
  console.log('=== 查询"元瑞直购店" ===\\n');
  
  const [stores] = await c.execute(
    'SELECT id, name, owner_id FROM stores WHERE name LIKE ?',
    ['%元瑞%']
  );
  
  if (stores.length === 0) {
    console.log('未找到包含"元瑞"的店铺');
    
    // 查询所有店铺
    console.log('\\n当前所有店铺:');
    const [all] = await c.execute('SELECT id, name, owner_id FROM stores ORDER BY id');
    all.forEach(s => console.log('  ID:', s.id, '名称:', s.name, 'owner_id:', s.owner_id));
  } else {
    for (const store of stores) {
      console.log('店铺:', store.name);
      console.log('  ID:', store.id);
      console.log('  owner_id:', store.owner_id);
      
      if (store.owner_id) {
        const [users] = await c.execute(
          'SELECT id, username, user_type FROM users WHERE id = ?',
          [store.owner_id]
        );
        if (users.length) {
          console.log('  所属账号:', users[0].username);
          console.log('  账号类型:', users[0].user_type === 'master' ? '主账号' : '子账号');
        } else {
          console.log('  所属账号: 未找到 (ID:', store.owner_id + ')');
        }
      } else {
        console.log('  所属账号: NULL (没有 owner_id)');
      }
      console.log('');
    }
  }
  
  // 查询所有店铺及其归属
  console.log('\\n=== 所有店铺归属情况 ===\\n');
  const [allStores] = await c.execute(
    'SELECT s.id, s.name, s.owner_id, u.username, u.user_type FROM stores s LEFT JOIN users u ON s.owner_id = u.id ORDER BY s.owner_id, s.id'
  );
  
  console.log('店铺总数:', allStores.length);
  allStores.forEach(s => {
    console.log('  -', s.name, '| owner_id:', s.owner_id || 'NULL', '| 账号:', s.username || '无', '(' + (s.user_type === 'master' ? '主' : s.user_type === 'sub' ? '子' : '无') + ')');
  });
  
  await c.end();
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
`;

  const remotePath = 'C:/Users/Administrator/dianxiaoer-server/temp-query.js';
  
  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP error:', err.message); conn.end(); process.exit(1); }
    
    sftp.writeFile(remotePath, queryScript, 'utf8', (err) => {
      if (err) { console.error('Write error:', err.message); conn.end(); process.exit(1); }
      
      conn.exec('cd /d C:\\Users\\Administrator\\dianxiaoer-server && node temp-query.js', (err, stream) => {
        let out = '', errOut = '';
        stream.on('data', d => out += d);
        stream.stderr.on('data', d => errOut += d);
        stream.on('close', () => {
          console.log(out);
          if (errOut) console.error('Errors:', errOut);
          
          conn.exec('del C:\\Users\\Administrator\\dianxiaoer-server\\temp-query.js', () => {
            conn.end();
          });
        });
      });
    });
  });
});

conn.on('error', err => {
  console.error('SSH error:', err.message);
  process.exit(1);
});

conn.connect({
  host: '150.158.54.108',
  port: 22,
  username: 'administrator',
  privateKey: fs.readFileSync('server-key/id_rsa'),
  readyTimeout: 15000
});
