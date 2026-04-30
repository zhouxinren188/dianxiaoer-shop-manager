const fs = require('fs');
const filepath = 'C:/Users/Administrator/dianxiaoer-server/index.js';

try {
  console.log('Reading index.js...');
  let content = fs.readFileSync(filepath, 'utf8');
  console.log('File size:', content.length);

  if (content.includes('/api/purchase-orders')) {
    console.log('Purchase orders routes already exist, skipping.');
    process.exit(0);
  }

  const routeCode = [
    '',
    '// ============ 采购订单接口 ============',
    '',
    "app.post('/api/purchase-orders', async (req, res) => {",
    '  try {',
    "    const ownerId = req.user.user_type === 'master' ? req.user.id : req.user.parent_id",
    '    const { purchase_no, sales_order_id, sales_order_no, goods_name, sku, quantity, source_url, platform, purchase_price, remark } = req.body',
    "    if (!purchase_no) return res.status(400).json(fail('purchase_no required'))",
    '    await pool.execute(',
    "      `INSERT INTO purchase_orders (purchase_no, sales_order_id, sales_order_no, goods_name, sku, quantity, source_url, platform, purchase_price, remark, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE goods_name=VALUES(goods_name), source_url=VALUES(source_url), platform=VALUES(platform), purchase_price=VALUES(purchase_price), remark=VALUES(remark)`,",
    "      [purchase_no, sales_order_id || '', sales_order_no || '', goods_name || '', sku || '', quantity || 1, source_url || '', platform || '', purchase_price || null, remark || '', ownerId]",
    '    )',
    "    const [rows] = await pool.execute('SELECT * FROM purchase_orders WHERE purchase_no = ?', [purchase_no])",
    '    res.json(ok(rows[0] || null))',
    '  } catch (err) {',
    '    res.status(500).json(fail(err.message))',
    '  }',
    '})',
    '',
    "app.put('/api/purchase-orders/:purchaseNo/bind', async (req, res) => {",
    '  try {',
    '    const { platform_order_no } = req.body',
    "    if (!platform_order_no) return res.status(400).json(fail('platform_order_no required'))",
    "    await pool.execute('UPDATE purchase_orders SET platform_order_no = ?, status = ? WHERE purchase_no = ?', [platform_order_no, 'ordered', req.params.purchaseNo])",
    "    const [rows] = await pool.execute('SELECT * FROM purchase_orders WHERE purchase_no = ?', [req.params.purchaseNo])",
    '    res.json(ok(rows[0] || null))',
    '  } catch (err) {',
    '    res.status(500).json(fail(err.message))',
    '  }',
    '})',
    '',
    "app.get('/api/purchase-orders', async (req, res) => {",
    '  try {',
    "    const ownerId = req.user.user_type === 'master' ? req.user.id : req.user.parent_id",
    '    const { status, platform, page, pageSize } = req.query',
    "    let sql = 'SELECT * FROM purchase_orders WHERE owner_id = ?'",
    '    const params = [ownerId]',
    "    if (status) { sql += ' AND status = ?'; params.push(status) }",
    "    if (platform) { sql += ' AND platform = ?'; params.push(platform) }",
    "    sql += ' ORDER BY created_at DESC'",
    '    if (pageSize) {',
    '      const limit = parseInt(pageSize) || 20',
    '      const offset = ((parseInt(page) || 1) - 1) * limit',
    "      sql += ' LIMIT ? OFFSET ?'",
    '      params.push(limit, offset)',
    '    }',
    '    const [rows] = await pool.execute(sql, params)',
    '    res.json(ok({ list: rows, total: rows.length }))',
    '  } catch (err) {',
    '    res.status(500).json(fail(err.message))',
    '  }',
    '})',
    '',
    "app.put('/api/purchase-orders/:id/status', async (req, res) => {",
    '  try {',
    '    const { status } = req.body',
    "    await pool.execute('UPDATE purchase_orders SET status = ? WHERE id = ?', [status, req.params.id])",
    '    res.json(ok(true))',
    '  } catch (err) {',
    '    res.status(500).json(fail(err.message))',
    '  }',
    '})',
    '',
  ].join('\n');

  // Find app.listen as insertion point
  const listenIndex = content.indexOf('app.listen');
  if (listenIndex === -1) {
    content = content + '\n' + routeCode;
  } else {
    content = content.slice(0, listenIndex) + routeCode + '\n' + content.slice(listenIndex);
  }

  fs.writeFileSync(filepath, content, 'utf8');
  console.log('Purchase orders routes injected successfully!');
  console.log('New file size:', content.length);
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
