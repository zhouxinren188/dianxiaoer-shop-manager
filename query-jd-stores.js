const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });
  
  const [rows] = await c.execute(
    'SELECT id, name, store_type, status, online FROM stores WHERE platform=? ORDER BY id',
    ['jd']
  );
  
  console.log('京东店铺总数:', rows.length);
  console.log('\n详细列表:');
  rows.forEach(s => {
    console.log('  ID:', s.id, '| 名称:', s.name, '| store_type:', s.store_type || '(空)', '| status:', s.status, '| online:', s.online);
  });
  
  console.log('\n筛选条件统计:');
  const [popEnabled] = await c.execute(
    'SELECT COUNT(*) as cnt FROM stores WHERE platform=? AND store_type=? AND status=?',
    ['jd', 'pop', 'enabled']
  );
  console.log('  platform=jd, store_type=pop, status=enabled:', popEnabled[0].cnt, '个');
  
  const [popAll] = await c.execute(
    'SELECT COUNT(*) as cnt FROM stores WHERE platform=? AND store_type=?',
    ['jd', 'pop']
  );
  console.log('  platform=jd, store_type=pop:', popAll[0].cnt, '个');
  
  const [allJd] = await c.execute(
    'SELECT COUNT(*) as cnt FROM stores WHERE platform=?',
    ['jd']
  );
  console.log('  platform=jd (所有):', allJd[0].cnt, '个');
  
  await c.end();
})().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
