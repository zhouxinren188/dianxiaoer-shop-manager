const mysql = require('C:/Users/Administrator/dianxiaoer-server/node_modules/mysql2/promise');
const fs = require('fs');

(async () => {
  // 1. 数据库迁移：移除唯一索引，改为普通索引
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'jd123456',
    database: 'dianxiaoer'
  });

  try {
    await conn.execute('ALTER TABLE sku_purchase_config DROP INDEX uk_sku_owner');
    console.log('Dropped unique index uk_sku_owner');
  } catch (e) {
    if (e.message.includes("check that column/key exists") || e.message.includes("Can't DROP")) {
      console.log('uk_sku_owner already removed or does not exist');
    } else {
      console.log('Drop index note:', e.message);
    }
  }

  try {
    await conn.execute('CREATE INDEX idx_sku_owner ON sku_purchase_config(sku_id, owner_id)');
    console.log('Created index idx_sku_owner');
  } catch (e) {
    if (e.message.includes('Duplicate key name')) {
      console.log('idx_sku_owner already exists');
    } else {
      console.log('Create index note:', e.message);
    }
  }
  await conn.end();

  // 2. 更新 index.js 路由
  const filepath = 'C:/Users/Administrator/dianxiaoer-server/index.js';
  let content = fs.readFileSync(filepath, 'utf8');

  // 替换 GET /api/sku-purchase-config 路由
  const oldGetPattern = /app\.get\('\/api\/sku-purchase-config',\s*async\s*\(req,\s*res\)\s*=>\s*\{[\s\S]*?res\.json\(ok\(rows\[0\]\s*\|\|\s*null\)\)[\s\S]*?\}\s*catch\s*\(err\)\s*\{[\s\S]*?res\.status\(500\)\.json\(fail\(err\.message\)\)[\s\S]*?\}\s*\}\)/;
  const newGetRoute = `app.get('/api/sku-purchase-config', async (req, res) => {
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
      'SELECT * FROM sku_purchase_config WHERE sku_id = ? AND owner_id = ? ORDER BY updated_at DESC',
      [sku_id, ownerId]
    )
    res.json(ok({ list: rows, total: rows.length }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})`;

  if (oldGetPattern.test(content)) {
    content = content.replace(oldGetPattern, newGetRoute);
    console.log('Updated GET /api/sku-purchase-config route');
  } else {
    console.log('GET route pattern not matched, may need manual update');
  }

  // 替换 POST /api/sku-purchase-config 路由
  const oldPostPattern = /app\.post\('\/api\/sku-purchase-config',\s*async\s*\(req,\s*res\)\s*=>\s*\{[\s\S]*?ON DUPLICATE KEY UPDATE[\s\S]*?res\.json\(ok\(rows\[0\]\s*\|\|\s*null\)\)[\s\S]*?\}\s*catch\s*\(err\)\s*\{[\s\S]*?res\.status\(500\)\.json\(fail\(err\.message\)\)[\s\S]*?\}\s*\}\)/;
  const newPostRoute = `app.post('/api/sku-purchase-config', async (req, res) => {
  try {
    const ownerId = req.user.user_type === 'master' ? req.user.id : req.user.parent_id
    const { id, sku_id, platform, purchase_link, purchase_price, remark } = req.body
    if (!sku_id) return res.status(400).json(fail('sku_id required'))
    if (id) {
      await pool.execute(
        \`UPDATE sku_purchase_config SET sku_id = ?, platform = ?, purchase_link = ?, purchase_price = ?, remark = ? WHERE id = ? AND owner_id = ?\`,
        [sku_id, platform || '', purchase_link || '', purchase_price || null, remark || '', id, ownerId]
      )
    } else {
      await pool.execute(
        \`INSERT INTO sku_purchase_config (sku_id, platform, purchase_link, purchase_price, remark, owner_id) VALUES (?, ?, ?, ?, ?, ?)\`,
        [sku_id, platform || '', purchase_link || '', purchase_price || null, remark || '', ownerId]
      )
    }
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})`;

  if (oldPostPattern.test(content)) {
    content = content.replace(oldPostPattern, newPostRoute);
    console.log('Updated POST /api/sku-purchase-config route');
  } else {
    console.log('POST route pattern not matched, may need manual update');
  }

  fs.writeFileSync(filepath, content, 'utf8');
  console.log('Server routes updated successfully');
  console.log('Done! Please restart the dianxiaoer-server.');
})().catch(e => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
