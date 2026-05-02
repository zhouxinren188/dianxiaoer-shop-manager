const http = require('http');
const options = {
  hostname: '150.158.54.108',
  port: 3002,
  path: '/health',
  method: 'GET',
  timeout: 5000
};
const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => console.log('Status:', res.statusCode, 'Body:', data));
});
req.on('error', (e) => console.log('Error:', e.message));
req.on('timeout', () => { console.log('Timeout'); req.destroy(); });
req.end();
