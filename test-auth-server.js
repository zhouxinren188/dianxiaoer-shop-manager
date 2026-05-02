const https = require('https');
const fs = require('fs');

// 禁用证书验证（仅用于测试）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const options = {
  hostname: '150.158.54.108',
  port: 3001,
  path: '/api/me',
  method: 'GET',
  headers: {
    'Authorization': 'Bearer test' // 会返回 401，但可以测试服务是否运行
  },
  rejectUnauthorized: false
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log('服务状态码:', res.statusCode);
    console.log('响应:', data);
    if (res.statusCode === 401) {
      console.log('\n✅ 认证服务器运行正常（401 是预期的，因为 token 无效）');
    } else if (res.statusCode === 200) {
      console.log('\n✅ 认证服务器运行正常');
    } else {
      console.log('\n⚠️ 服务可能有问题');
    }
  });
});

req.on('error', (error) => {
  console.error('❌ 服务连接失败:', error.message);
});

req.end();
