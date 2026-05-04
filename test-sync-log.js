const { Client } = require('ssh2');
const fs = require('fs');

const conn = new Client();

conn.on('ready', () => {
  console.log('=== Checking Sync Logs ===\n');
  
  // 查看NSSM日志输出
  conn.exec('Get-Content C:\\Users\\Administrator\\dianxiaoer-server\\nohup.out -Tail 50', (err, stream) => {
    let out = '';
    stream.on('data', d => out += d);
    stream.on('close', () => {
      console.log('--- Recent Logs (nohup.out) ---');
      console.log(out || '(no log data)');
      console.log('\n--- Checking for [Sync] messages ---');
      
      const lines = out.split('\n');
      const syncLines = lines.filter(l => l.includes('[Sync]'));
      if (syncLines.length > 0) {
        syncLines.forEach(l => console.log(l));
      } else {
        console.log('No [Sync] logs found. Please try syncing in the app first.');
      }
      
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
