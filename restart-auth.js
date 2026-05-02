const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected');
  
  // 重启认证服务器
  conn.exec('C:\\nssm\\nssm.exe restart dianxiaoer-api', (err, stream) => {
    let out = '', errOut = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => errOut += d);
    stream.on('close', (code) => {
      console.log('重启结果:', out);
      if (errOut && !errOut.includes('信息')) console.error('重启错误:', errOut);
      else console.log('服务已重启');
      
      // 等待 2 秒后测试 API
      setTimeout(() => {
        console.log('\n测试 API...');
        conn.exec('curl http://127.0.0.1:3001/api/update/check?version=1.2.9^&appVersion=1.2.9', (err2, stream2) => {
          let out2 = '', errOut2 = '';
          stream2.on('data', d => out2 += d);
          stream2.stderr.on('data', d => errOut2 += d);
          stream2.on('close', (code2) => {
            console.log('API 返回:', out2);
            if (errOut2) console.error('API 错误:', errOut2);
            conn.end();
          });
        });
      }, 2000);
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
