const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected');
  
  const localFile = path.join(__dirname, 'server', 'index.js');
  const remoteFile = 'C:/dianxiaoer-server/index.js';
  
  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP error:', err.message); conn.end(); process.exit(1); }
    
    console.log('Uploading server/index.js...');
    
    sftp.fastPut(localFile, remoteFile, (err) => {
      if (err) { console.error('Upload error:', err.message); conn.end(); process.exit(1); }
      
      console.log('File uploaded, restarting service...');
      
      // 重启 NSSM 服务
      conn.exec('C:\\nssm\\nssm.exe restart dianxiaoer-server', (err, stream) => {
        let out = '';
        stream.on('data', d => out += d);
        stream.on('close', () => {
          console.log('Restart output:', out.trim());
          
          // 等待服务启动
          setTimeout(() => {
            conn.exec('curl -s http://localhost:3002/api/health', (err, stream) => {
              let health = '';
              stream.on('data', d => health += d);
              stream.on('close', () => {
                console.log('Health check:', health.trim());
                console.log('\n=== DEPLOYMENT COMPLETE ===');
                conn.end();
              });
            });
          }, 3000);
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
