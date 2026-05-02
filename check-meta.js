const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected');
  
  // 查看 update-meta.json 内容
  conn.exec('type C:\\Users\\Administrator\\dianxiaoer-api\\updates\\update-meta.json', (err, stream) => {
    let out = '', errOut = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => errOut += d);
    stream.on('close', (code) => {
      console.log('update-meta.json 内容:');
      console.log(out);
      if (errOut) console.error('错误:', errOut);
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
