const fs = require('fs');
const path = 'C:/Users/Administrator/dianxiaoer-server/index.js';

let content = fs.readFileSync(path, 'utf8');

if (content.includes('/api/sku-purchase-config')) {
  console.log('SKU purchase config routes already exist, skipping.');
  process.exit(0);
}

const routeCode = `
// ============ 商品SKU采购配置接口 ============

// 获取SKU采购配置（根据sku_id查询）
app.get('/api/sku-purchase-config', async (req, res) => {
  try {
    const ownerId = req.user.user_type === 'master' ? req.user.id : req.user.parent_id
    const { sku_id } = req.query
    if (!sku_id) {
      const [rows] = await pool.execute(
        'SELECT * FROM sku_purchase_config WHERE owner_id = ? ORDER BY updated_at DESC',
        [ownerId]
      )
      return res.json(ok({ list: rows, total: rows.length }))
    }
    const [rows] = await pool.execute(
      'SELECT * FROM sku_purchase_config WHERE sku_id = ? AND owner_id = ?',
      [sku_id, ownerId]
    )
    res.json(ok(rows[0] || null))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 保存/更新SKU采购配置（upsert）
app.post('/api/sku-purchase-config', async (req, res) => {
  try {
    const ownerId = req.user.user_type === 'master' ? req.user.id : req.user.parent_id
    const { sku_id, warehouse, platform, purchase_link, purchase_price, remark } = req.body
    if (!sku_id) return res.status(400).json(fail('sku_id 为必填项'))
    await pool.execute(
      \`INSERT INTO sku_purchase_config (sku_id, warehouse, platform, purchase_link, purchase_price, remark, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         warehouse = VALUES(warehouse),
         platform = VALUES(platform),
         purchase_link = VALUES(purchase_link),
         purchase_price = VALUES(purchase_price),
         remark = VALUES(remark),
         updated_at = NOW()\`,
      [sku_id, warehouse || '', platform || '', purchase_link || '', purchase_price || null, remark || '', ownerId]
    )
    const [rows] = await pool.execute(
      'SELECT * FROM sku_purchase_config WHERE sku_id = ? AND owner_id = ?',
      [sku_id, ownerId]
    )
    res.json(ok(rows[0] || null))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 删除SKU采购配置
app.delete('/api/sku-purchase-config/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM sku_purchase_config WHERE id = ?', [req.params.id])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

`;

// Insert before health check
const healthCheckMarker = '// 健康检查';
const healthCheckIndex = content.indexOf(healthCheckMarker);

if (healthCheckIndex === -1) {
  const listenIndex = content.indexOf('app.listen');
  if (listenIndex === -1) {
    content = content + '\\n' + routeCode;
  } else {
    content = content.slice(0, listenIndex) + routeCode + '\\n' + content.slice(listenIndex);
  }
} else {
  content = content.slice(0, healthCheckIndex) + routeCode + '\\n' + content.slice(healthCheckIndex);
}

fs.writeFileSync(path, content, 'utf8');
console.log('SKU purchase config routes injected successfully');
