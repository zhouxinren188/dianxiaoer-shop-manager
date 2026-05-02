const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH connected');
  
  // 用 PM2 重启服务（推荐方式）
  conn.exec('cd C:/Users/Administrator/dianxiaoer-api && pm2 restart dianxiaoer-api', (err, stream) => {
    let out = '', errOut = '';
    stream.on('data', d => out += d);
    stream.stderr.on('data', d => errOut += d);
    stream.on('close', (code) => {
      console.log('PM2 重启结果:', out);
      if (errOut && !errOut.includes('信息')) {
        console.error('PM2 重启错误:', errOut);
        console.log('尝试使用 NSSM 重启...');
        
        // 备用方案：NSSM
        conn.exec('C:\\nssm\\nssm.exe restart dianxiaoer-api 2>nul || C:\\Program Files\\nssm\\nssm.exe restart dianxiaoer-api 2>nul || echo "NSSM not found"', (err2, stream2) => {
          let out2 = '', errOut2 = '';
          stream2.on('data', d => out2 += d);
          stream2.stderr.on('data', d => errOut2 += d);
          stream2.on('close', (code2) => {
            console.log('NSSM 重启结果:', out2);
            if (out2.includes('NSSM not found')) {
              console.log('请手动重启服务：在服务管理器中重启 dianxiaoer-api 服务');
            }
            conn.end();
          });
        });
      } else {
        console.log('服务已成功重启');
        conn.end();
      }
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
