const { Client } = require('ssh2');
const fs = require('fs');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected');
  
  // 上传脚本
  const fixScript = `
const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });
  
  console.log('=== Fixing store associations ===');
  
  const [subs] = await c.execute(
    'SELECT id, username, parent_id FROM users WHERE user_type = ? AND parent_id IS NOT NULL',
    ['sub']
  );
  
  console.log('Found', subs.length, 'sub accounts');
  
  let total = 0;
  for (const sub of subs) {
    console.log('Processing:', sub.username, '(ID:', sub.id + ')');
    
    const [stores] = await c.execute(
      'SELECT id, name FROM stores WHERE owner_id = ?',
      [sub.parent_id]
    );
    
    console.log('  Master has', stores.length, 'stores');
    
    for (const store of stores) {
      const [exists] = await c.execute(
        'SELECT 1 FROM user_stores WHERE user_id = ? AND store_id = ?',
        [sub.id, store.id]
      );
      
      if (!exists.length) {
        await c.execute(
          'INSERT INTO user_stores (user_id, store_id) VALUES (?, ?)',
          [sub.id, store.id]
        );
        console.log('  Added:', store.name, '(ID:', store.id + ')');
        total++;
      }
    }
  }
  
  console.log('Total added:', total);
  await c.end();
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
`;

  const remotePath = 'C:/Users/Administrator/dianxiaoer-server/temp-fix.js';
  
  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP error:', err.message); conn.end(); process.exit(1); }
    
    sftp.writeFile(remotePath, fixScript, 'utf8', (err) => {
      if (err) { console.error('Write error:', err.message); conn.end(); process.exit(1); }
      
      console.log('Script uploaded, executing...');
      
      conn.exec('cd /d C:\\Users\\Administrator\\dianxiaoer-server && node temp-fix.js', (err, stream) => {
        let out = '', errOut = '';
        stream.on('data', d => out += d);
        stream.stderr.on('data', d => errOut += d);
        stream.on('close', () => {
          console.log('\n=== Result ===');
          console.log(out);
          if (errOut) console.error('Errors:', errOut);
          
          // 清理临时文件
          conn.exec('del C:\\Users\\Administrator\\dianxiaoer-server\\temp-fix.js', () => {
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
