// 通过 SSH 执行远程查询
const { Client } = require('ssh2');
const fs = require('fs');

const conn = new Client();

const script = `
const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });
  
  // 查询用户5名下的京东店铺
  const [rows] = await c.execute(
    'SELECT id, name, store_type, status, online FROM stores WHERE owner_id=5 AND platform=? ORDER BY id',
    ['jd']
  );
  
  console.log('用户5名下的京东店铺:');
  console.log('总数:', rows.length);
  rows.forEach(s => {
    console.log('  ID:', s.id, '| 名称:', s.name, '| store_type:', JSON.stringify(s.store_type), '| status:', s.status);
  });
  
  // 统计 store_type
  console.log('\\nstore_type 分布:');
  const [stats] = await c.execute(
    'SELECT store_type, COUNT(*) as cnt FROM stores WHERE owner_id=5 AND platform=? GROUP BY store_type',
    ['jd']
  );
  stats.forEach(s => {
    console.log('  store_type=' + JSON.stringify(s.store_type) + ': ' + s.cnt + ' 个');
  });
  
  await c.end();
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
`;

conn.on('ready', () => {
  console.log('SSH connected');
  const remotePath = 'C:/Users/Administrator/dianxiaoer-server/check-store-types.js';
  
  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP error:', err.message); process.exit(1); }
    
    sftp.writeFile(remotePath, script, 'utf8', (err) => {
      if (err) { console.error('Write error:', err.message); process.exit(1); }
      
      conn.exec('cd /d C:\\Users\\Administrator\\dianxiaoer-server && node check-store-types.js', (err, stream) => {
        let out = '', errOut = '';
        stream.on('data', d => out += d);
        stream.stderr.on('data', d => errOut += d);
        stream.on('close', (code) => {
          console.log(out);
          if (errOut) console.error('Errors:', errOut);
          
          // 清理临时文件
          conn.exec('del C:\\Users\\Administrator\\dianxiaoer-server\\check-store-types.js', () => {
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

// 使用密码连接
conn.connect({
  host: '150.158.54.108',
  port: 22,
  username: 'administrator',
  password: 'K9#m2$vL5@zQ',
  readyTimeout: 15000
});
