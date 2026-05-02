const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected');
  
  // 检查服务状态和日志
  conn.exec('C:\\nssm\\nssm.exe status dianxiaoer-api', (err, stream) => {
    let out = '', errOut = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => errOut += d);
    stream.on('close', (code) => {
      console.log('服务状态:', out);
      
      // 查看最近的日志
      conn.exec('cd C:/Users/Administrator/dianxiaoer-api && type pm2-logs\\dianxiaoer-api-out.log 2>nul || echo "No PM2 logs"', (err2, stream2) => {
        let out2 = '', errOut2 = '';
        stream2.on('data', d => out2 += d);
        stream2.stderr.on('data', d => errOut2 += d);
        stream2.on('close', (code2) => {
          console.log('最近日志:', out2);
          if (errOut2) console.log('日志错误:', errOut2);
          
          // 测试本地 node 服务
          conn.exec('cd C:/Users/Administrator/dianxiaoer-api && node -e "console.log(\'Node works\')"', (err3, stream3) => {
            let out3 = '', errOut3 = '';
            stream3.on('data', d => out3 += d);
            stream3.stderr.on('data', d => errOut3 += d);
            stream3.on('close', (code3) => {
              console.log('Node 测试:', out3);
              conn.end();
            });
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
  password: 'K9#m2$vL5@zQ',
  readyTimeout: 15000
});
