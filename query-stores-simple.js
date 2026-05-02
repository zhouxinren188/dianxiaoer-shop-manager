const { Client } = require('ssh2');
const fs = require('fs');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected');
  
  const cmd = `mysql -h 127.0.0.1 -P 3307 -u root -pjd123456 dianxiaoer -e "SELECT id, name, platform, store_type, status, online FROM stores WHERE platform='jd' ORDER BY id;"`;
  
  conn.exec(cmd, (err, stream) => {
    let out = '', errOut = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => errOut += d);
    stream.on('close', (code) => {
      console.log('Output:', out);
      if (errOut) console.error('Errors:', errOut);
      console.log('Exit code:', code);
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
