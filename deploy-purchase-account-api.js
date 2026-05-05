const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected');

  const localIndex = path.join(__dirname, 'server', 'index.js');
  const localDb = path.join(__dirname, 'server', 'db.js');
  const remoteIndex = 'C:/dianxiaoer-server/index.js';
  const remoteDb = 'C:/dianxiaoer-server/db.js';

  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP error:', err.message); conn.end(); process.exit(1); }

    console.log('Uploading server/index.js...');
    sftp.fastPut(localIndex, remoteIndex, (err) => {
      if (err) { console.error('Upload index.js error:', err.message); conn.end(); process.exit(1); }
      console.log('index.js uploaded');

      console.log('Uploading server/db.js...');
      sftp.fastPut(localDb, remoteDb, (err) => {
        if (err) { console.error('Upload db.js error:', err.message); conn.end(); process.exit(1); }
        console.log('db.js uploaded');

        console.log('Restarting service...');
        conn.exec('C:\\nssm\\nssm.exe restart dianxiaoer-server', (err, stream) => {
          let out = '';
          stream.on('data', d => out += d);
          stream.stderr.on('data', d => out += d);
          stream.on('close', () => {
            console.log('Restart output:', out.trim());

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
            }, 4000);
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
  privateKey: fs.readFileSync(path.join(__dirname, 'server-key', 'id_rsa')),
  readyTimeout: 15000
});
