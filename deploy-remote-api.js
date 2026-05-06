const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected');

  const localFile = path.join(__dirname, 'remote-index-current.js');
  const remoteFile = 'C:/dianxiaoer-api/remote-index-current.js';

  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP error:', err.message); conn.end(); process.exit(1); }

    console.log('Uploading remote-index-current.js...');
    sftp.fastPut(localFile, remoteFile, (err) => {
      if (err) { console.error('Upload error:', err.message); conn.end(); process.exit(1); }
      console.log('remote-index-current.js uploaded');

      console.log('Restarting dianxiaoer-api...');
      conn.exec('C:\\nssm\\nssm.exe restart dianxiaoer-api', (err, stream) => {
        let out = '';
        stream.on('data', d => out += d);
        stream.stderr.on('data', d => out += d);
        stream.on('close', () => {
          console.log('Restart output:', out.trim());

          setTimeout(() => {
            conn.exec('curl -s http://localhost:3001/api/update/check?version=1.3.7', (err, stream) => {
              let health = '';
              stream.on('data', d => health += d);
              stream.on('close', () => {
                console.log('Update check:', health.trim().substring(0, 300));
                console.log('\n=== DEPLOYMENT COMPLETE ===');
                conn.end();
              });
            });
          }, 4000);
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
  privateKey: fs.readFileSync(path.join(__dirname, 'server-key', 'id_rsa')),
  readyTimeout: 15000
});
