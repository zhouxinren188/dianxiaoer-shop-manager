const https = require('https');

// 禁用证书验证
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const postData = JSON.stringify({
  username: '店小二',
  password: 'jd123456'
});

const options = {
  hostname: '150.158.54.108',
  port: 3001,
  path: '/api/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  },
  rejectUnauthorized: false
};

console.log('测试登录: 店小二 / jd123456\n');

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log('状态码:', res.statusCode);
    try {
      const json = JSON.parse(data);
      console.log('响应:', JSON.stringify(json, null, 2));
      
      if (json.success) {
        console.log('\n✅ 登录成功！认证服务器已从数据库读取用户');
      } else {
        console.log('\n❌ 登录失败:', json.message);
      }
    } catch (e) {
      console.log('原始响应:', data);
    }
  });
});

req.on('error', (error) => {
  console.error('请求错误:', error.message);
});

req.write(postData);
req.end();
