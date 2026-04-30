const fs = require('fs');
const filepath = 'C:/Users/Administrator/dianxiaoer-server/index.js';

try {
  console.log('Reading index.js...');
  let content = fs.readFileSync(filepath, 'utf8');
  console.log('File size:', content.length);

  if (content.includes('/api/sku-purchase-config')) {
    console.log('SKU routes already exist, skipping.');
    process.exit(0);
  }

  const routeCode = [
    '',
    '// ============ 商品SKU采购配置接口 ============',
    '',
    "app.get('/api/sku-purchase-config', async (req, res) => {",
    '  try {',
    "    const ownerId = req.user.user_type === 'master' ? req.user.id : req.user.parent_id",
    '    const { sku_id } = req.query',
    '    if (!sku_id) {',
    '      const [rows] = await pool.execute(',
    "        'SELECT * FROM sku_purchase_config WHERE owner_id = ? ORDER BY updated_at DESC',",
    '        [ownerId]',
    '      )',
    '      return res.json(ok({ list: rows, total: rows.length }))',
    '    }',
    '    const [rows] = await pool.execute(',
    "      'SELECT * FROM sku_purchase_config WHERE sku_id = ? AND owner_id = ?',",
    '      [sku_id, ownerId]',
    '    )',
    '    res.json(ok(rows[0] || null))',
    '  } catch (err) {',
    '    res.status(500).json(fail(err.message))',
    '  }',
    '})',
    '',
    "app.post('/api/sku-purchase-config', async (req, res) => {",
    '  try {',
    "    const ownerId = req.user.user_type === 'master' ? req.user.id : req.user.parent_id",
    '    const { sku_id, warehouse, platform, purchase_link, purchase_price, remark } = req.body',
    "    if (!sku_id) return res.status(400).json(fail('sku_id required'))",
    '    await pool.execute(',
    "      `INSERT INTO sku_purchase_config (sku_id, warehouse, platform, purchase_link, purchase_price, remark, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE warehouse = VALUES(warehouse), platform = VALUES(platform), purchase_link = VALUES(purchase_link), purchase_price = VALUES(purchase_price), remark = VALUES(remark), updated_at = NOW()`,",
    "      [sku_id, warehouse || '', platform || '', purchase_link || '', purchase_price || null, remark || '', ownerId]",
    '    )',
    '    const [rows] = await pool.execute(',
    "      'SELECT * FROM sku_purchase_config WHERE sku_id = ? AND owner_id = ?',",
    '      [sku_id, ownerId]',
    '    )',
    '    res.json(ok(rows[0] || null))',
    '  } catch (err) {',
    '    res.status(500).json(fail(err.message))',
    '  }',
    '})',
    '',
    "app.delete('/api/sku-purchase-config/:id', async (req, res) => {",
    '  try {',
    "    await pool.execute('DELETE FROM sku_purchase_config WHERE id = ?', [req.params.id])",
    '    res.json(ok(true))',
    '  } catch (err) {',
    '    res.status(500).json(fail(err.message))',
    '  }',
    '})',
    '',
  ].join('\n');

  // Find insertion point
  var insertIndex = -1;
  var marker = '// \u5065\u5eb7\u68c0\u67e5';
  insertIndex = content.indexOf(marker);
  console.log('Health check marker index:', insertIndex);

  if (insertIndex === -1) {
    // Try to find app.listen
    insertIndex = content.indexOf('app.listen');
    console.log('app.listen index:', insertIndex);
  }

  if (insertIndex === -1) {
    // Append to end
    content = content + '\n' + routeCode;
  } else {
    content = content.slice(0, insertIndex) + routeCode + '\n' + content.slice(insertIndex);
  }

  fs.writeFileSync(filepath, content, 'utf8');
  console.log('SKU purchase config routes injected successfully!');
  console.log('New file size:', content.length);
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
