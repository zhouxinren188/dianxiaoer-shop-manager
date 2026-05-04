const { Client } = require('ssh2');
const fs = require('fs');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected, executing test sync...\n');
  
  // 执行同步命令，查看日志输出
  conn.exec('C:\\nssm\\nssm.exe status dianxiaoer-server', (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      console.log('Service status:', out.trim());
      console.log('\nNow please try sync in the app, then run:');
      console.log('node test-sync-log.js');
      conn.end();
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
