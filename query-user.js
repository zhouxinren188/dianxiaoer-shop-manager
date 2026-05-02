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
  
  console.log('=== 查询巨马电商账号信息 ===\\n');
  
  const [users] = await c.execute(
    'SELECT id, username, user_type, parent_id, status FROM users WHERE username LIKE ?',
    ['%巨马%']
  );
  
  if (users.length === 0) {
    console.log('未找到包含"巨马"的账号');
    
    // 查询所有账号
    const [all] = await c.execute(
      'SELECT id, username, user_type, parent_id FROM users ORDER BY id'
    );
    console.log('\\n所有账号列表:');
    console.table(all);
  } else {
    for (const u of users) {
      console.log('账号:', u.username);
      console.log('  ID:', u.id);
      console.log('  类型:', u.user_type === 'master' ? '主账号' : '子账号');
      console.log('  状态:', u.status);
      
      if (u.user_type === 'sub' && u.parent_id) {
        const [parents] = await c.execute(
          'SELECT id, username FROM users WHERE id = ?',
          [u.parent_id]
        );
        if (parents.length) {
          console.log('  所属主账号:', parents[0].username, '(ID:', parents[0].id + ')');
        }
      }
      
      if (u.user_type === 'master') {
        const [stores] = await c.execute(
          'SELECT id, name FROM stores WHERE owner_id = ?',
          [u.id]
        );
        console.log('  名下店铺:', stores.length, '家');
        stores.forEach(s => console.log('    -', s.name));
      }
      console.log('');
    }
  }
  
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
