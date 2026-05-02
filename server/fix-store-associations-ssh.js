const { Client } = require('ssh2');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const SSH_CONFIG = {
  host: '150.158.54.108',
  port: 22,
  username: 'root',
  privateKey: fs.readFileSync(path.join(__dirname, '..', 'server-key', 'id_rsa'))
};

const DB_CONFIG = {
  host: '127.0.0.1',
  port: 3307,
  user: 'root',
  password: 'jd123456',
  database: 'dianxiaoer'
};

async function fixStoreAssociations() {
  console.log('=== 开始修复子账号店铺关联 ===\n');
  
  // 通过 SSH 在远程服务器执行
  const conn = new Client();
  
  conn.on('ready', () => {
    console.log('SSH 连接成功');
    
    conn.exec(`cd /c/Users/Administrator/dianxiaoer-server && node -e "
const mysql = require('mysql2/promise');
(async () => {
  const dbConn = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });
  
  // 1. 查询所有子账号
  const [subAccounts] = await dbConn.execute(
    'SELECT id, username, parent_id FROM users WHERE user_type = ? AND parent_id IS NOT NULL',
    ['sub']
  );
  
  console.log('找到 ' + subAccounts.length + ' 个子账号');
  
  if (subAccounts.length === 0) {
    console.log('没有子账号，无需修复');
    process.exit(0);
  }
  
  // 2. 为每个子账号关联其主账号名下的所有店铺
  let totalAdded = 0;
  for (const sub of subAccounts) {
    console.log('处理子账号: ' + sub.username + ' (ID: ' + sub.id + ', 主账号ID: ' + sub.parent_id + ')');
    
    // 查询主账号名下的所有店铺
    const [masterStores] = await dbConn.execute(
      'SELECT id, name FROM stores WHERE owner_id = ?',
      [sub.parent_id]
    );
    
    console.log('  主账号名下有 ' + masterStores.length + ' 家店铺');
    
    // 为每个店铺添加关联（如果不存在）
    for (const store of masterStores) {
      const [existing] = await dbConn.execute(
        'SELECT 1 FROM user_stores WHERE user_id = ? AND store_id = ?',
        [sub.id, store.id]
      );
      
      if (existing.length === 0) {
        await dbConn.execute(
          'INSERT INTO user_stores (user_id, store_id) VALUES (?, ?)',
          [sub.id, store.id]
        );
        console.log('  OK 已关联店铺: ' + store.name + ' (ID: ' + store.id + ')');
        totalAdded++;
      } else {
        console.log('  SKIP 已存在关联: ' + store.name + ' (ID: ' + store.id + ')');
      }
    }
  }
  
  console.log('总共添加了 ' + totalAdded + ' 条店铺关联记录');
  await dbConn.end();
  process.exit(0);
})().catch(err => {
  console.error('Error: ' + err.message);
  process.exit(1);
});
"`, (err, stream) => {
      if (err) {
        console.error('SSH 执行失败:', err.message);
        conn.end();
        process.exit(1);
      }
      
      let output = '';
      stream.on('data', data => {
        output += data.toString();
        console.log(data.toString());
      });
      stream.stderr.on('data', data => {
        console.error(data.toString());
      });
      stream.on('close', (code) => {
        console.log('\n=== 执行完成，退出码:', code, '===');
        conn.end();
        process.exit(code);
      });
    });
  });
  
  conn.on('error', err => {
    console.error('SSH 连接失败:', err.message);
    process.exit(1);
  });
  
  conn.connect(SSH_CONFIG);
}

fixStoreAssociations();
