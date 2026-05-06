const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const conn = new Client();

function execCmd(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('data', d => stdout += d.toString());
      stream.stderr.on('data', d => stderr += d.toString());
      stream.on('close', code => resolve({ code, stdout, stderr }));
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

conn.on('ready', async () => {
  console.log('[Deploy] SSH connected');

  try {
    const localFile = path.join(__dirname, 'server', 'index.js');
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => err ? reject(err) : resolve(sftp));
    });

    // 部署到两个可能的远程目录
    const remoteDirs = [
      'C:/Users/Administrator/dianxiaoer-server',
      'C:/dianxiaoer-server'
    ];

    for (const remoteDir of remoteDirs) {
      const remoteFile = `${remoteDir}/index.js`;
      console.log(`[Deploy] Uploading to ${remoteFile}...`);
      try {
        await new Promise((resolve, reject) => {
          sftp.fastPut(localFile, remoteFile, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        console.log(`[Deploy] Uploaded to ${remoteFile}`);
      } catch (err) {
        console.log(`[Deploy] Upload to ${remoteFile} failed (directory may not exist): ${err.message}`);
      }
    }

    sftp.end();

    // 重启 NSSM 服务
    console.log('[Deploy] Restarting dianxiaoer-server...');
    const restart = await execCmd(conn, 'C:\\nssm\\nssm.exe restart dianxiaoer-server');
    console.log('[Deploy] Restart:', restart.stdout.trim() || restart.stderr.trim());

    // 等待服务启动
    console.log('[Deploy] Waiting 4s for service startup...');
    await sleep(4000);

    // 健康检查（正确路径是 /health 不是 /api/health）
    const health = await execCmd(conn, 'curl -s http://localhost:3002/health');
    console.log('[Deploy] Health check (port 3002):', health.stdout.trim());

    // 验证 store-sales-stats 路由是否存在（无 token 应返回 401 JSON）
    const routeCheck = await execCmd(conn, 'curl -s -w "\\nHTTP_CODE:%{http_code}" http://localhost:3002/api/store-sales-stats');
    console.log('[Deploy] Route check (/api/store-sales-stats):', routeCheck.stdout.trim());

    console.log('\n=== DEPLOYMENT COMPLETE ===');
  } catch (err) {
    console.error('[Deploy] Error:', err.message);
  } finally {
    conn.end();
  }
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
