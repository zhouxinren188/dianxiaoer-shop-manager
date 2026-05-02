const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();

// 需要部署的文件
const filesToDeploy = [
  { local: 'server/index.js', remote: 'C:/Users/Administrator/dianxiaoer-server/index.js' },
  { local: 'server/package.json', remote: 'C:/Users/Administrator/dianxiaoer-server/package.json' }
];

console.log('准备部署业务服务器更新...\n');

conn.on('ready', () => {
  console.log('SSH connected\n');
  
  let deployed = 0;
  let errors = 0;
  
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message);
      process.exit(1);
    }
    
    function deployNext(index) {
      if (index >= filesToDeploy.length) {
        // 所有文件部署完成
        console.log('\n=== 部署完成 ===');
        console.log(`成功: ${deployed} 个文件`);
        console.log(`失败: ${errors} 个文件`);
        
        if (errors === 0) {
          console.log('\n正在安装依赖并重启服务...');
          conn.exec('cd C:/Users/Administrator/dianxiaoer-server && npm install && C:\\nssm\\nssm.exe restart dianxiaoer-server', (err, stream) => {
            let out = '', errOut = '';
            stream.on('data', d => out += d);
            stream.stderr.on('data', d => errOut += d);
            stream.on('close', (code) => {
              console.log(out);
              if (errOut && !errOut.includes('信息')) console.error('服务重启错误:', errOut);
              else console.log('服务已成功重启');
              conn.end();
            });
          });
        } else {
          conn.end();
        }
        return;
      }
      
      const file = filesToDeploy[index];
      const localPath = file.local;
      
      console.log(`[${index + 1}/${filesToDeploy.length}] 部署 ${file.local}...`);
      
      fs.readFile(localPath, 'utf8', (err, content) => {
        if (err) {
          console.error(`  读取失败: ${err.message}`);
          errors++;
          deployNext(index + 1);
          return;
        }
        
        sftp.writeFile(file.remote, content, 'utf8', (err) => {
          if (err) {
            console.error(`  写入失败: ${err.message}`);
            errors++;
          } else {
            console.log(`  成功`);
            deployed++;
          }
          deployNext(index + 1);
        });
      });
    }
    
    deployNext(0);
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
