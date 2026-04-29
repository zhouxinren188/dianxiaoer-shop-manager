const express = require('express')
const router = express.Router()
const { getDb } = require('../db/init')

// GET /api/cookies - 获取所有 Cookie（心跳检测用，JOIN stores 获取 platform）
router.get('/', (req, res) => {
  const db = getDb()
  const list = db.prepare(`
    SELECT c.store_id, c.cookie_data, c.domain, c.saved_at, s.platform, s.name as store_name
    FROM cookies c
    JOIN stores s ON c.store_id = s.id
    WHERE s.status = 'enabled'
  `).all()

  res.json({ code: 0, data: list, message: 'ok' })
})

// GET /api/cookies/:storeId - 获取指定店铺 Cookie
router.get('/:storeId', (req, res) => {
  const db = getDb()
  const cookie = db.prepare('SELECT * FROM cookies WHERE store_id = ?').get(req.params.storeId)
  if (!cookie) return res.json({ code: 0, data: null, message: '无 Cookie 记录' })
  res.json({ code: 0, data: cookie, message: 'ok' })
})

// POST /api/cookies - 保存/更新 Cookie（UPSERT）
router.post('/', (req, res) => {
  const db = getDb()
  const { store_id, cookie_data, domain } = req.body

  if (!store_id || !cookie_data) {
    return res.json({ code: 1, message: 'store_id 和 cookie_data 为必填项' })
  }

  // 检查店铺是否存在
  const store = db.prepare('SELECT id FROM stores WHERE id = ?').get(store_id)
  if (!store) return res.json({ code: 1, message: '店铺不存在' })

  const now = new Date().toISOString()

  db.prepare(`
    INSERT INTO cookies (store_id, cookie_data, domain, saved_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(store_id) DO UPDATE SET
      cookie_data = excluded.cookie_data,
      domain = excluded.domain,
      saved_at = excluded.saved_at
  `).run(store_id, typeof cookie_data === 'string' ? cookie_data : JSON.stringify(cookie_data), domain || '', now)

  res.json({ code: 0, message: 'ok' })
})

// DELETE /api/cookies/:storeId - 清除指定店铺 Cookie
router.delete('/:storeId', (req, res) => {
  const db = getDb()
  db.prepare('DELETE FROM cookies WHERE store_id = ?').run(req.params.storeId)
  res.json({ code: 0, message: 'ok' })
})

module.exports = router
