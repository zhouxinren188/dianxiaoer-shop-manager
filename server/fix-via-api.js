/**
 * 通过 HTTP API 修复子账号店铺关联
 * 不需要 SSH，直接通过业务 API 操作
 */

const http = require('http');

const BASE_URL = 'http://150.158.54.108:3002';

async function httpRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + path);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fixAssociations() {
  console.log('=== 修复子账号店铺关联 ===\n');
  
  // 1. 先登录获取 token
  console.log('1. 登录获取 token...');
  const loginRes = await httpRequest('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: '巨马电商',
      password: '需要用户提供密码'
    })
  });
  
  console.log('登录响应:', JSON.stringify(loginRes.data));
  
  if (!loginRes.data.accessToken) {
    console.log('无法自动登录，需要用户提供密码');
    console.log('\n请提供巨马电商账号的密码，或者手动执行以下 SQL:');
    console.log(`
-- 查询子账号及其主账号
SELECT u.id, u.username, u.user_type, u.parent_id 
FROM users u 
WHERE u.username = '巨马电商';

-- 假设巨马电商是子账号，parent_id 指向主账号
-- 为子账号关联主账号名下的所有店铺
INSERT IGNORE INTO user_stores (user_id, store_id)
SELECT sub.id, s.id
FROM users sub
CROSS JOIN stores s
WHERE sub.username = '巨马电商'
  AND sub.user_type = 'sub'
  AND s.owner_id = sub.parent_id;
    `);
    return;
  }
  
  const token = loginRes.data.accessToken;
  const authHeader = { 'Authorization': `Bearer ${token}` };
  
  // 2. 查询当前用户信息
  console.log('\n2. 查询用户信息...');
  const meRes = await httpRequest('/api/me', { headers: authHeader });
  console.log('用户信息:', JSON.stringify(meRes.data));
  
  const user = meRes.data.user;
  if (user.user_type === 'master') {
    console.log('该账号是主账号，不需要修复关联');
    return;
  }
  
  // 3. 查询当前可访问的店铺
  console.log('\n3. 查询当前可访问的店铺...');
  const storesRes = await httpRequest('/api/stores?page=1&pageSize=100', { headers: authHeader });
  console.log('可访问店铺:', JSON.stringify(storesRes.data));
  
  console.log('\n=== 完成 ===');
}

fixAssociations().catch(err => console.error('Error:', err.message));
