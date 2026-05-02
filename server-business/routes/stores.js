const express = require('express')
const router = express.Router()
const { getDb } = require('../db/init')

// GET /api/stores - 店铺列表（分页+筛选）
router.get('/', (req, res) => {
  const db = getDb()
  const { name, platform, status, online, merchant_id, page = 1, pageSize = 10 } = req.query
  const conditions = []
  const params = []

  if (name) {
    conditions.push('name LIKE ?')
    params.push(`%${name}%`)
  }
  if (platform) {
    conditions.push('platform = ?')
    params.push(platform)
  }
  if (status) {
    conditions.push('status = ?')
    params.push(status)
  }
  if (online !== undefined && online !== '') {
    conditions.push('online = ?')
    params.push(Number(online))
  }
  if (merchant_id) {
    conditions.push('merchant_id = ?')
    params.push(merchant_id)
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const offset = (Number(page) - 1) * Number(pageSize)

  const total = db.prepare(`SELECT COUNT(*) as count FROM stores ${where}`).get(...params).count
  const list = db.prepare(`SELECT * FROM stores ${where} ORDER BY id ASC LIMIT ? OFFSET ?`).all(...params, Number(pageSize), offset)

  // 解析 tags JSON
  list.forEach(item => {
    try { item.tags = JSON.parse(item.tags) } catch { item.tags = [] }
  })

  res.json({ code: 0, data: { list, total }, message: 'ok' })
})

// GET /api/stores/:id - 单个店铺
router.get('/:id', (req, res) => {
  const db = getDb()
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.id)
  if (!store) return res.json({ code: 1, message: '店铺不存在' })

  try { store.tags = JSON.parse(store.tags) } catch { store.tags = [] }
  res.json({ code: 0, data: store, message: 'ok' })
})

// POST /api/stores - 新增店铺
router.post('/', (req, res) => {
  const db = getDb()
  const { name, platform, account, password, merchant_id, shop_id, tags, status } = req.body

  if (!name || !platform) {
    return res.json({ code: 1, message: '店铺名称和平台类型为必填项' })
  }

  const tagsStr = Array.isArray(tags) ? JSON.stringify(tags) : '[]'
  const now = new Date().toISOString()

  const result = db.prepare(`
    INSERT INTO stores (name, platform, account, password, merchant_id, shop_id, tags, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, platform, account || '', password || '', merchant_id || '', shop_id || '', tagsStr, status || 'enabled', now, now)

  res.json({ code: 0, data: { id: result.lastInsertRowid }, message: 'ok' })
})

// PUT /api/stores/:id - 编辑店铺
router.put('/:id', (req, res) => {
  const db = getDb()
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(req.params.id)
  if (!store) return res.json({ code: 1, message: '店铺不存在' })

  const { name, platform, account, password, merchant_id, shop_id, tags, status } = req.body
  const tagsStr = Array.isArray(tags) ? JSON.stringify(tags) : store.tags
  const now = new Date().toISOString()

  db.prepare(`
    UPDATE stores SET
      name = COALESCE(?, name),
      platform = COALESCE(?, platform),
      account = COALESCE(?, account),
      password = COALESCE(?, password),
      merchant_id = COALESCE(?, merchant_id),
      shop_id = COALESCE(?, shop_id),
      tags = ?,
      status = COALESCE(?, status),
      updated_at = ?
    WHERE id = ?
  `).run(
    name || null, platform || null, account !== undefined ? account : null,
    password !== undefined ? password : null, merchant_id !== undefined ? merchant_id : null,
    shop_id !== undefined ? shop_id : null, tagsStr, status || null, now, req.params.id
  )

  res.json({ code: 0, message: 'ok' })
})

// DELETE /api/stores/:id - 删除店铺
router.delete('/:id', (req, res) => {
  const db = getDb()
  const result = db.prepare('DELETE FROM stores WHERE id = ?').run(req.params.id)
  if (result.changes === 0) return res.json({ code: 1, message: '店铺不存在' })
  res.json({ code: 0, message: 'ok' })
})

// PUT /api/stores/:id/status - 更新在线状态
router.put('/:id/status', (req, res) => {
  const db = getDb()
  const { online } = req.body
  const onlineVal = online ? 1 : 0
  const now = new Date().toISOString()

  const result = db.prepare('UPDATE stores SET online = ?, updated_at = ? WHERE id = ?').run(onlineVal, now, req.params.id)
  if (result.changes === 0) return res.json({ code: 1, message: '店铺不存在' })
  res.json({ code: 0, message: 'ok' })
})

// PUT /api/stores/:id/toggle - 切换经营状态
router.put('/:id/toggle', (req, res) => {
  const db = getDb()
  const { status } = req.body
  if (!status || !['enabled', 'disabled'].includes(status)) {
    return res.json({ code: 1, message: '状态值无效，需为 enabled 或 disabled' })
  }
  const now = new Date().toISOString()

  const result = db.prepare('UPDATE stores SET status = ?, updated_at = ? WHERE id = ?').run(status, now, req.params.id)
  if (result.changes === 0) return res.json({ code: 1, message: '店铺不存在' })
  res.json({ code: 0, message: 'ok' })
})

module.exports = router
