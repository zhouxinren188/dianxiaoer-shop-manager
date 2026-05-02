const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected');
  
  conn.exec('node -e "const fs = require(\'fs\'); const users = JSON.parse(fs.readFileSync(\'C:/Users/Administrator/dianxiaoer-api/data/users.json\', \'utf8\')); console.log(\'用户列表:\'); Object.keys(users).forEach(u => console.log(\'- \' + u)); console.log(\'\'); console.log(\'用户详情:\'); console.log(JSON.stringify(users, null, 2));"', (err, stream) => {
    let out = '', errOut = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => errOut += d);
    stream.on('close', (code) => {
      console.log(out);
      if (errOut) console.error('Errors:', errOut);
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
  password: 'K9#m2$vL5@zQ',
  readyTimeout: 15000
});
