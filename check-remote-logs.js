const { Client } = require('ssh2');
const fs = require('fs');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected');

  conn.exec('powershell -Command "Get-Content C:\\Users\\Administrator\\dianxiaoer-server\\logs\\stdout.log | Where-Object { $_ -match \'SUCCESS|Found order|Parsed|Data keys|nested|无更新|sync-single\' }"', (err, stream) => {
    if (err) { console.error('Exec error:', err.message); conn.end(); process.exit(1); }
    let out = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => process.stderr.write(d));
    stream.on('close', () => {
      console.log(out || 'No matching entries found');
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
  readyTimeout: 30000
});
