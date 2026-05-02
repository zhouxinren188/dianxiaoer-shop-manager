const http = require('http');
const options = {
  hostname: '150.158.54.108',
  port: 3002,
  path: '/api/purchase-orders?pageSize=5',
  method: 'GET',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + (process.argv[2] || '')
  },
  timeout: 5000
};
const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const j = JSON.parse(data);
      console.log('Code:', j.code, 'Total:', j.data && j.data.total);
      if (j.data && j.data.list) {
        j.data.list.forEach(r => console.log(' -', r.id, r.purchase_no, r.status));
      }
    } catch(e) { console.log('Body:', data.substring(0, 200)); }
  });
});
req.on('error', (e) => console.log('Error:', e.message));
req.end();
