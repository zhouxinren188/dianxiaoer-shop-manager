// 直接测试同步API
const https = require('https');

const BASE_URL = 'http://150.158.54.108:3002';

// 这里需要您的有效token
const TOKEN = process.argv[2] || '';

if (!TOKEN) {
  console.log('Usage: node test-sync-api.js <your-token>');
  console.log('Please get your token from browser localStorage or API response');
  process.exit(1);
}

function httpRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            data: JSON.parse(data)
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            data: data
          });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function test() {
  console.log('=== Testing Sync API ===\n');

  // 1. 先获取采购账号列表
  console.log('1. Fetching purchase accounts...');
  const accountsRes = await httpRequest('/api/purchase-accounts');
  console.log('Accounts:', JSON.stringify(accountsRes.data, null, 2));

  if (!accountsRes.data || !accountsRes.data.list || accountsRes.data.list.length === 0) {
    console.log('No accounts found');
    return;
  }

  const account = accountsRes.data.list[0];
  console.log(`\nUsing account: ${account.username} (id: ${account.id}, platform: ${account.platform})`);

  // 2. 获取采购订单列表
  console.log('\n2. Fetching purchase orders...');
  const ordersRes = await httpRequest('/api/purchase-orders?pageSize=10');
  const orders = ordersRes.data?.list || [];
  console.log(`Total orders: ${orders.length}`);
  
  const boundOrders = orders.filter(o => o.platform_order_no);
  console.log(`Bound orders (with platform_order_no): ${boundOrders.length}`);
  
  if (boundOrders.length > 0) {
    console.log('Sample bound order:', JSON.stringify(boundOrders[0], null, 2));
  }

  // 3. 执行同步
  console.log('\n3. Executing sync...');
  const syncRes = await httpRequest('/api/purchase-orders/sync', 'POST', {
    platform: account.platform,
    account_id: account.id
  });
  
  console.log('Sync result:', JSON.stringify(syncRes.data, null, 2));
}

test().catch(err => {
  console.error('Error:', err.message);
  console.error('Full error:', err);
});
