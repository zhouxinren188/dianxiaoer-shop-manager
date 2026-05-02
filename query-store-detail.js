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
  
  // 查询所有京东店铺详细信息
  const [jdStores] = await c.execute(
    'SELECT id, name, platform, store_type, status, online, owner_id FROM stores WHERE platform=? ORDER BY id',
    ['jd']
  );
  
  console.log('\\n=== 京东店铺详情 ===\\n');
  console.log('总数:', jdStores.length);
  jdStores.forEach(s => {
    console.log('  - ID:', s.id);
    console.log('    名称:', s.name);
    console.log('    platform:', s.platform);
    console.log('    store_type:', s.store_type || '(空)');
    console.log('    status:', s.status);
    console.log('    online:', s.online);
    console.log('    owner_id:', s.owner_id);
    console.log('');
  });
  
  // 统计各 store_type 数量
  console.log('\\n=== 京东店铺 store_type 统计 ===\\n');
  const [typeStats] = await c.execute(
    'SELECT store_type, COUNT(*) as count FROM stores WHERE platform=? GROUP BY store_type',
    ['jd']
  );
  typeStats.forEach(s => {
    console.log('  store_type="' + (s.store_type || '(空)') + '":', s.count, '个店铺');
  });
  
  // 统计各 status 数量
  console.log('\\n=== 京东店铺 status 统计 ===\\n');
  const [statusStats] = await c.execute(
    'SELECT status, COUNT(*) as count FROM stores WHERE platform=? GROUP BY status',
    ['jd']
  );
  statusStats.forEach(s => {
    console.log('  status="' + s.status + '":', s.count, '个店铺');
  });
  
  // 查询符合前端条件的店铺
  console.log('\\n=== 符合前端过滤条件的店铺 (platform=jd, store_type=pop, status=enabled) ===\\n');
  const [filtered] = await c.execute(
    'SELECT id, name, store_type, status, online FROM stores WHERE platform=? AND store_type=? AND status=?',
    ['jd', 'pop', 'enabled']
  );
  console.log('符合数量:', filtered.length);
  filtered.forEach(s => {
    console.log('  -', s.name, '(store_type:', s.store_type, ', status:', s.status, ')');
  });
  
  await c.end();
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
`;

  const remotePath = 'C:/Users/Administrator/dianxiaoer-server/temp-query2.js';
  
  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP error:', err.message); conn.end(); process.exit(1); }
    
    sftp.writeFile(remotePath, queryScript, 'utf8', (err) => {
      if (err) { console.error('Write error:', err.message); conn.end(); process.exit(1); }
      
      conn.exec('cd /d C:\\Users\\Administrator\\dianxiaoer-server && node temp-query2.js', (err, stream) => {
        let out = '', errOut = '';
        stream.on('data', d => out += d);
        stream.stderr.on('data', d => errOut += d);
        stream.on('close', () => {
          console.log(out);
          if (errOut) console.error('Errors:', errOut);
          
          conn.exec('del C:\\Users\\Administrator\\dianxiaoer-server\\temp-query2.js', () => {
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
