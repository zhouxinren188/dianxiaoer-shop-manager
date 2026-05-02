const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected');
  
  // 读取并修改 update-meta.json
  const script = `
const fs = require('fs');
const path = require('path');

const metaPath = 'C:/Users/Administrator/dianxiaoer-api/updates/update-meta.json';
let meta;

try {
  meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
} catch (e) {
  console.error('读取失败:', e.message);
  process.exit(1);
}

console.log('当前配置:');
console.log(JSON.stringify(meta, null, 2));

// 修改热更新版本号为 1.2.10
meta.hotfixVersion = '1.2.10';
if (meta.hot) {
  meta.hot.version = '1.2.10';
}
if (meta.hotfix) {
  meta.hotfix.version = '1.2.10';
}

meta.releaseDate = new Date().toISOString();
meta.changelog = '热更新 v1.2.10 - 修复登录验证问题，统一用户数据源为MySQL数据库';
if (meta.hotfix) {
  meta.hotfix.changelog = '热更新 v1.2.10 - 修复登录验证问题，统一用户数据源为MySQL数据库';
}

fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
console.log('\\n更新后配置:');
console.log(JSON.stringify(meta, null, 2));
`;

  const remotePath = 'C:/Users/Administrator/dianxiaoer-api/fix-meta.js';
  
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message);
      process.exit(1);
    }
    
    sftp.writeFile(remotePath, script, 'utf8', (err) => {
      if (err) {
        console.error('Write error:', err.message);
        process.exit(1);
      }
      
      conn.exec('node C:/Users/Administrator/dianxiaoer-api/fix-meta.js', (err, stream) => {
        let out = '', errOut = '';
        stream.on('data', d => out += d);
        stream.stderr.on('data', d => errOut += d);
        stream.on('close', (code) => {
          console.log(out);
          if (errOut) console.error('错误:', errOut);
          
          // 清理临时文件
          conn.exec('del C:\\Users\\Administrator\\dianxiaoer-api\\fix-meta.js', () => {
            conn.end();
            console.log('\n✅ 完成');
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
  password: 'K9#m2$vL5@zQ',
  readyTimeout: 15000
});
