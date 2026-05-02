const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();
const pubKey = fs.readFileSync(path.join(__dirname, 'server-key', 'id_rsa.pub'), 'utf8').trim();

conn.on('ready', () => {
  console.log('SSH connected, trying SFTP...');
  
  conn.sftp((err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message);
      conn.end();
      process.exit(1);
    }
    
    console.log('SFTP connected');
    
    const remoteDir = 'C:/Users/Administrator/.ssh';
    const remotePath = remoteDir + '/authorized_keys';
    
    // 先创建目录
    sftp.mkdir(remoteDir, { mode: 0o700 }, (err) => {
      if (err) console.log('mkdir note:', err.message);
      
      // 写入文件
      sftp.writeFile(remotePath, pubKey, 'utf8', (err) => {
        if (err) {
          console.error('Write error:', err.message);
          conn.end();
          process.exit(1);
        }
        console.log('File written successfully');
        
        // 验证
        sftp.readFile(remotePath, 'utf8', (err, data) => {
          if (err) {
            console.error('Read error:', err.message);
          } else {
            console.log('Verified length:', data.length);
            console.log('Has ssh-rsa:', data.includes('ssh-rsa'));
            if (data.includes('ssh-rsa')) {
              console.log('\n=== SSH KEY SUCCESSFULLY CONFIGURED ===');
              console.log('Test with: ssh -i server-key/id_rsa administrator@150.158.54.108');
            }
          }
          conn.end();
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
  host: '150.158.54.108', port: 22, username: 'administrator',
  password: 'K9#m2$vL5@zQ', readyTimeout: 15000
});
