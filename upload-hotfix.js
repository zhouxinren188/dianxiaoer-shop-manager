const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();

const zipPath = path.join(__dirname, 'dist/update-1.2.9.zip');
const remotePath = 'C:/Users/Administrator/dianxiaoer-api/updates/hot/update-1.2.9.zip';

console.log('上传热更新包到服务器...');
console.log('本地文件:', zipPath);
console.log('远程路径:', remotePath);

// 读取 zip 文件
const zipData = fs.readFileSync(zipPath);
console.log('文件大小:', (zipData.length / 1024).toFixed(1), 'KB');

conn.on('ready', () => {
  console.log('SSH connected\n');
  
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message);
      process.exit(1);
    }
    
    console.log('正在上传文件...');
    
    sftp.writeFile(remotePath, zipData, (err) => {
      if (err) {
        console.error('上传失败:', err.message);
        conn.end();
        process.exit(1);
      }
      
      console.log('文件上传成功');
      
      // 更新 update-meta.json
      const metaScript = `
const fs = require('fs');
const path = require('path');

const metaPath = 'C:/Users/Administrator/dianxiaoer-api/updates/update-meta.json';
const meta = {
  latestVersion: '1.2.9',
  hotfixVersion: '1.2.9',
  releaseDate: new Date().toISOString(),
  changelog: '热更新 v1.2.9 - 修复登录验证问题，统一用户数据源为MySQL数据库',
  sha256: '8828a15d464f2fd5e4062083f328502ff48513639fcc21ff1d4d4fb7dc43048a',
  size: ${zipData.length},
  fullUpdate: {
    version: '1.2.9',
    url: 'https://150.158.54.108:3001/updates/店小二网店管家-Setup-1.2.9.exe',
    sha256: '',
    size: 0,
    changelog: 'v1.2.9'
  },
  hotfix: {
    version: '1.2.9',
    url: 'https://150.158.54.108:3001/updates/hot/update-1.2.9.zip',
    sha256: '8828a15d464f2fd5e4062083f328502ff48513639fcc21ff1d4d4fb7dc43048a',
    size: ${zipData.length},
    changelog: '热更新 v1.2.9 - 修复登录验证问题，统一用户数据源为MySQL数据库'
  }
};

fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
console.log('update-meta.json 已更新');
console.log(JSON.stringify(meta, null, 2));
`;
      
      const metaPath = 'C:/Users/Administrator/dianxiaoer-api/update-meta.js';
      
      sftp.writeFile(metaPath, metaScript, 'utf8', (err) => {
        if (err) {
          console.error('写入脚本失败:', err.message);
          conn.end();
          process.exit(1);
        }
        
        console.log('更新 metadata...');
        
        conn.exec('node C:/Users/Administrator/dianxiaoer-api/update-meta.js', (err, stream) => {
          let out = '', errOut = '';
          stream.on('data', d => out += d);
          stream.stderr.on('data', d => errOut += d);
          stream.on('close', (code) => {
            console.log('\n=== 结果 ===');
            console.log(out);
            if (errOut) console.error('错误:', errOut);
            
            // 清理临时文件
            conn.exec('del C:\\Users\\Administrator\\dianxiaoer-api\\update-meta.js', () => {
              conn.end();
              console.log('\n✅ 热更新发布完成！');
            });
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
