const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected');

  const sftpCallback = (err, sftp) => {
    if (err) { console.error('SFTP error:', err.message); conn.end(); process.exit(1); }

    // Step 1: Upload server/index.js
    const localServerFile = path.join(__dirname, 'server', 'index.js');
    const remoteServerFile = 'C:/Users/Administrator/dianxiaoer-server/index.js';
    console.log('Uploading server/index.js...');
    sftp.fastPut(localServerFile, remoteServerFile, (err) => {
      if (err) { console.error('Upload server error:', err.message); conn.end(); process.exit(1); }
      console.log('Server code uploaded');

      // Step 2: Upload hotfix zip
      const zipPath = path.join(__dirname, 'dist', 'update-1.2.12.zip');
      const remoteZipPath = 'C:/Users/Administrator/dianxiaoer-api/updates/hot/update-1.2.12.zip';
      if (fs.existsSync(zipPath)) {
        console.log('Uploading hotfix zip...');
        sftp.fastPut(zipPath, remoteZipPath, (err) => {
          if (err) { console.error('Upload hotfix error:', err.message); }
          else { console.log('Hotfix zip uploaded'); }
          restartAndUpdateMeta(sftp, zipPath);
        });
      } else {
        console.log('No hotfix zip found, skipping');
        restartAndUpdateMeta(sftp, null);
      }
    });
  };

  function restartAndUpdateMeta(sftp, zipPath) {
    // Step 3: Restart server
    console.log('Restarting server service...');
    conn.exec('C:\\nssm\\nssm.exe restart dianxiaoer-server', (err, stream) => {
      let out = '';
      stream.on('data', d => out += d);
      stream.on('close', () => {
        console.log('Restart output:', out.trim());

        // Step 4: Update update-meta.json if we have a zip
        if (zipPath) {
          const zipSize = fs.statSync(zipPath).size;
          const zipSha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');

          const meta = {
            latestVersion: '1.2.12',
            hotfixVersion: '1.2.12',
            releaseDate: new Date().toISOString(),
            changelog: '热更新 v1.2.12 - 修复淘宝H5会话过期自动刷新cookies机制',
            sha256: zipSha256,
            size: zipSize,
            fullUpdate: {
              version: '1.2.12',
              url: 'https://150.158.54.108:3001/updates/店小二网店管家-Setup-1.2.12.exe',
              sha256: '',
              size: 0,
              changelog: 'v1.2.12'
            },
            hotfix: {
              version: '1.2.12',
              url: 'https://150.158.54.108:3001/updates/hot/update-1.2.12.zip',
              sha256: zipSha256,
              size: zipSize,
              changelog: '热更新 v1.2.12 - 修复淘宝H5会话过期自动刷新cookies机制'
            }
          };

          const metaJson = JSON.stringify(meta, null, 2);
          const remoteMetaPath = 'C:/Users/Administrator/dianxiaoer-api/updates/update-meta.json';

          sftp.writeFile(remoteMetaPath, metaJson, 'utf8', (err) => {
            if (err) { console.error('Write meta error:', err.message); }
            else { console.log('update-meta.json updated'); }
            healthCheck();
          });
        } else {
          healthCheck();
        }
      });
    });
  }

  function healthCheck() {
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
  }

  conn.sftp(sftpCallback);
});

conn.on('error', err => { console.error('SSH error:', err.message); process.exit(1); });

conn.connect({
  host: '150.158.54.108',
  port: 22,
  username: 'administrator',
  privateKey: fs.readFileSync(path.join(__dirname, 'server-key', 'id_rsa')),
  readyTimeout: 15000
});
