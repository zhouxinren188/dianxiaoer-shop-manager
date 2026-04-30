const fs = require('fs');
const path = 'C:/Users/Administrator/dianxiaoer-server/index.js';

// Read the current index.js
let content = fs.readFileSync(path, 'utf8');

// Check if already injected
if (content.includes('/api/purchase-accounts')) {
  console.log('Routes already exist in index.js, skipping injection.');
  process.exit(0);
}

// The route code to inject
const routeCode = `
// ============ 采购账号接口 ============

// 获取采购账号列表
app.get('/api/purchase-accounts', async (req, res) => {
  try {
    const ownerId = req.user.user_type === 'master' ? req.user.id : req.user.parent_id
    const [rows] = await pool.execute(
      'SELECT * FROM purchase_accounts WHERE owner_id = ? ORDER BY created_at DESC',
      [ownerId]
    )
    res.json(ok({ list: rows, total: rows.length }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 获取单个采购账号
app.get('/api/purchase-accounts/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM purchase_accounts WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json(fail('采购账号不存在'))
    res.json(ok(rows[0]))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 创建采购账号
app.post('/api/purchase-accounts', async (req, res) => {
  try {
    const ownerId = req.user.user_type === 'master' ? req.user.id : req.user.parent_id
    const { account, password, platform } = req.body
    const [result] = await pool.execute(
      'INSERT INTO purchase_accounts (account, password, platform, online, owner_id) VALUES (?, ?, ?, 0, ?)',
      [account || '', password || '', platform || '', ownerId]
    )
    const [rows] = await pool.execute('SELECT * FROM purchase_accounts WHERE id = ?', [result.insertId])
    res.json(ok(rows[0]))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 更新采购账号
app.put('/api/purchase-accounts/:id', async (req, res) => {
  try {
    const { account, password, platform, online } = req.body
    const updates = []
    const values = []
    if (account !== undefined) { updates.push('account = ?'); values.push(account) }
    if (password !== undefined) { updates.push('password = ?'); values.push(password) }
    if (platform !== undefined) { updates.push('platform = ?'); values.push(platform) }
    if (online !== undefined) { updates.push('online = ?'); values.push(online ? 1 : 0) }
    if (updates.length === 0) return res.json(ok(null))
    values.push(req.params.id)
    await pool.execute('UPDATE purchase_accounts SET ' + updates.join(', ') + ' WHERE id = ?', values)
    const [rows] = await pool.execute('SELECT * FROM purchase_accounts WHERE id = ?', [req.params.id])
    res.json(ok(rows[0] || null))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 删除采购账号
app.delete('/api/purchase-accounts/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM purchase_cookies WHERE account_id = ?', [req.params.id])
    await pool.execute('DELETE FROM purchase_accounts WHERE id = ?', [req.params.id])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 更新采购账号在线状态
app.put('/api/purchase-accounts/:id/status', async (req, res) => {
  try {
    const online = req.body.online ? 1 : 0
    await pool.execute('UPDATE purchase_accounts SET online = ? WHERE id = ?', [online, req.params.id])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 获取采购账号 Cookie
app.get('/api/purchase-accounts/:id/cookie', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM purchase_cookies WHERE account_id = ?', [req.params.id])
    res.json(ok(rows[0] || null))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 保存采购账号 Cookie
app.post('/api/purchase-accounts/:id/cookie', async (req, res) => {
  try {
    const { cookie_data, platform } = req.body
    if (!cookie_data) return res.json(fail('cookie_data 为必填项'))
    await pool.execute(
      'INSERT INTO purchase_cookies (account_id, cookie_data, platform) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE cookie_data = VALUES(cookie_data), platform = VALUES(platform), saved_at = NOW()',
      [req.params.id, typeof cookie_data === 'string' ? cookie_data : JSON.stringify(cookie_data), platform || '']
    )
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

`;

// Find the health check route as insertion point
const healthCheckMarker = '// 健康检查';
const healthCheckIndex = content.indexOf(healthCheckMarker);

if (healthCheckIndex === -1) {
  // Try alternative: find app.listen or the last route
  const listenIndex = content.indexOf('app.listen');
  if (listenIndex === -1) {
    // Append before the end
    content = content + '\n' + routeCode;
  } else {
    content = content.slice(0, listenIndex) + routeCode + '\n' + content.slice(listenIndex);
  }
} else {
  // Insert before health check
  content = content.slice(0, healthCheckIndex) + routeCode + '\n' + content.slice(healthCheckIndex);
}

// Write back
fs.writeFileSync(path, content, 'utf8');
console.log('Routes injected successfully into index.js');
