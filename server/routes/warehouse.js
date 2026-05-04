/**
 * 仓库管理 API 路由
 * 提供入库、出库、库存查询、盘点等接口
 */

function ok(data) {
  return { code: 0, data }
}

function fail(message) {
  return { code: 1, message }
}

// 获取主账号ID
function getOwnerId(user) {
  return user.user_type === 'master' ? user.id : user.parent_id
}

module.exports = function(pool) {
  const router = require('express').Router()

  // ============ 统计接口 ============

  router.get('/stats', async (req, res) => {
    try {
      const ownerId = getOwnerId(req.user)
      const { warehouse_id } = req.query

      let where = 'WHERE owner_id = ?'
      const params = [ownerId]

      if (warehouse_id) {
        where += ' AND warehouse_id = ?'
        params.push(warehouse_id)
      }

      // 今日入库数
      const [inRows] = await pool.execute(
        `SELECT COALESCE(SUM(quantity), 0) as total FROM stock_in_records ${where} AND DATE(created_at) = CURDATE()`,
        params
      )

      // 今日出库数
      const [outRows] = await pool.execute(
        `SELECT COALESCE(SUM(quantity), 0) as total FROM stock_out_records ${where} AND DATE(created_at) = CURDATE()`,
        params
      )

      // SKU数
      const [skuRows] = await pool.execute(
        `SELECT COUNT(*) as total FROM inventory ${where}`,
        params
      )

      // 低库存数
      const [lowRows] = await pool.execute(
        `SELECT COUNT(*) as total FROM inventory ${where} AND quantity <= warn_quantity`,
        params
      )

      res.json(ok({
        todayStockIn: inRows[0].total,
        todayStockOut: outRows[0].total,
        totalSku: skuRows[0].total,
        lowStock: lowRows[0].total
      }))
    } catch (err) {
      res.status(500).json(fail(err.message))
    }
  })

  // ============ 最近操作记录 ============

  router.get('/recent-records', async (req, res) => {
    try {
      const ownerId = getOwnerId(req.user)
      const { warehouse_id, limit = 10 } = req.query

      let where = 'WHERE owner_id = ?'
      const params = [ownerId]

      if (warehouse_id) {
        where += ' AND warehouse_id = ?'
        params.push(warehouse_id)
      }

      // 入库记录
      const [inRows] = await pool.execute(
        `SELECT id, sku, product_name, quantity, 'in' as type, created_at
         FROM stock_in_records ${where}
         ORDER BY id DESC LIMIT ${parseInt(limit)}`,
        params
      )

      // 出库记录
      const [outRows] = await pool.execute(
        `SELECT id, sku, product_name, quantity, 'out' as type, created_at
         FROM stock_out_records ${where}
         ORDER BY id DESC LIMIT ${parseInt(limit)}`,
        params
      )

      // 合并并按时间排序
      const all = [...inRows, ...outRows]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, parseInt(limit))
        .map(r => ({
          id: r.id,
          type: r.type,
          sku: r.sku,
          productName: r.product_name,
          quantity: r.quantity,
          time: formatTime(r.created_at)
        }))

      res.json(ok({ list: all }))
    } catch (err) {
      res.status(500).json(fail(err.message))
    }
  })

  // ============ 入库 ============

  router.post('/stock-in', async (req, res) => {
    try {
      const ownerId = getOwnerId(req.user)
      const { warehouse_id, sku, product_name, quantity, batch_no, supplier, location, remark } = req.body

      if (!warehouse_id || !sku || !product_name || !quantity || quantity <= 0) {
        return res.json(fail('仓库、SKU、商品名称和数量为必填项'))
      }

      // 1. 写入入库记录
      await pool.execute(
        `INSERT INTO stock_in_records (warehouse_id, sku, product_name, quantity, batch_no, supplier, location, remark, operator_id, operator_name, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [warehouse_id, sku, product_name, quantity, batch_no || '', supplier || '', location || '', remark || '',
         req.user.id, req.user.real_name || req.user.username, ownerId]
      )

      // 2. 更新库存（upsert）
      await pool.execute(
        `INSERT INTO inventory (warehouse_id, sku, product_name, quantity, batch_no, supplier, location, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           quantity = quantity + VALUES(quantity),
           product_name = VALUES(product_name),
           batch_no = IF(VALUES(batch_no) != '', VALUES(batch_no), batch_no),
           supplier = IF(VALUES(supplier) != '', VALUES(supplier), supplier),
           location = IF(VALUES(location) != '', VALUES(location), location),
           updated_at = NOW()`,
        [warehouse_id, sku, product_name, quantity, batch_no || '', supplier || '', location || '', ownerId]
      )

      res.json(ok({ success: true }))
    } catch (err) {
      res.status(500).json(fail(err.message))
    }
  })

  // 入库记录查询
  router.get('/stock-in-records', async (req, res) => {
    try {
      const ownerId = getOwnerId(req.user)
      const { warehouse_id, today, page = 1, pageSize = 20 } = req.query

      let where = 'WHERE owner_id = ?'
      const params = [ownerId]

      if (warehouse_id) {
        where += ' AND warehouse_id = ?'
        params.push(warehouse_id)
      }
      if (today === '1' || today === 1) {
        where += ' AND DATE(created_at) = CURDATE()'
      }

      const countSql = `SELECT COUNT(*) as total FROM stock_in_records ${where}`
      const [[{ total }]] = await pool.execute(countSql, params)

      const limit = Math.max(1, parseInt(pageSize))
      const offset = Math.max(0, (parseInt(page) - 1) * limit)
      const [rows] = await pool.execute(
        `SELECT * FROM stock_in_records ${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
        params
      )

      // 格式化时间
      const list = rows.map(r => ({
        ...r,
        created_at: formatTime(r.created_at)
      }))

      res.json(ok({ list, total }))
    } catch (err) {
      res.status(500).json(fail(err.message))
    }
  })

  // ============ 出库 ============

  router.post('/stock-out', async (req, res) => {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()

      const ownerId = getOwnerId(req.user)
      const { warehouse_id, sku, product_name, quantity, type, related_order, remark } = req.body

      if (!warehouse_id || !sku || !quantity || quantity <= 0) {
        await connection.rollback()
        return res.json(fail('仓库、SKU和数量为必填项'))
      }

      // 1. 检查库存
      const [invRows] = await connection.execute(
        'SELECT id, quantity, product_name FROM inventory WHERE warehouse_id = ? AND sku = ? AND owner_id = ?',
        [warehouse_id, sku, ownerId]
      )

      if (invRows.length === 0) {
        await connection.rollback()
        return res.json(fail('该SKU在当前仓库无库存'))
      }

      if (invRows[0].quantity < quantity) {
        await connection.rollback()
        return res.json(fail('库存不足，当前库存 ' + invRows[0].quantity))
      }

      const productName = product_name || invRows[0].product_name

      // 2. 写入出库记录
      await connection.execute(
        `INSERT INTO stock_out_records (warehouse_id, sku, product_name, quantity, type, related_order, remark, operator_id, operator_name, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [warehouse_id, sku, productName, quantity, type || 'sale', related_order || '', remark || '',
         req.user.id, req.user.real_name || req.user.username, ownerId]
      )

      // 3. 扣减库存
      await connection.execute(
        'UPDATE inventory SET quantity = quantity - ?, updated_at = NOW() WHERE warehouse_id = ? AND sku = ? AND owner_id = ?',
        [quantity, warehouse_id, sku, ownerId]
      )

      await connection.commit()
      res.json(ok({ success: true }))
    } catch (err) {
      await connection.rollback()
      res.status(500).json(fail(err.message))
    } finally {
      connection.release()
    }
  })

  // 出库记录查询
  router.get('/stock-out-records', async (req, res) => {
    try {
      const ownerId = getOwnerId(req.user)
      const { warehouse_id, today, page = 1, pageSize = 20 } = req.query

      let where = 'WHERE owner_id = ?'
      const params = [ownerId]

      if (warehouse_id) {
        where += ' AND warehouse_id = ?'
        params.push(warehouse_id)
      }
      if (today === '1' || today === 1) {
        where += ' AND DATE(created_at) = CURDATE()'
      }

      const countSql = `SELECT COUNT(*) as total FROM stock_out_records ${where}`
      const [[{ total }]] = await pool.execute(countSql, params)

      const limit = Math.max(1, parseInt(pageSize))
      const offset = Math.max(0, (parseInt(page) - 1) * limit)
      const [rows] = await pool.execute(
        `SELECT * FROM stock_out_records ${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`,
        params
      )

      const list = rows.map(r => ({
        ...r,
        created_at: formatTime(r.created_at)
      }))

      res.json(ok({ list, total }))
    } catch (err) {
      res.status(500).json(fail(err.message))
    }
  })

  // ============ 库存查询 ============

  router.get('/inventory', async (req, res) => {
    try {
      const ownerId = getOwnerId(req.user)
      const { warehouse_id, keyword, sku, low_stock, out_of_stock, page = 1, pageSize = 20 } = req.query

      let where = 'WHERE i.owner_id = ?'
      const params = [ownerId]

      if (warehouse_id) {
        where += ' AND i.warehouse_id = ?'
        params.push(warehouse_id)
      }
      if (sku) {
        where += ' AND i.sku = ?'
        params.push(sku)
      }
      if (keyword) {
        where += ' AND (i.sku LIKE ? OR i.product_name LIKE ?)'
        params.push(`%${keyword}%`, `%${keyword}%`)
      }
      if (low_stock === '1' || low_stock === 1) {
        where += ' AND i.quantity <= i.warn_quantity AND i.quantity > 0'
      }
      if (out_of_stock === '1' || out_of_stock === 1) {
        where += ' AND i.quantity <= 0'
      }

      const countSql = `SELECT COUNT(*) as total FROM inventory i ${where}`
      const [[{ total }]] = await pool.execute(countSql, params)

      // 低库存统计
      const lowParams = [ownerId]
      let lowWhere = 'WHERE i.owner_id = ?'
      if (warehouse_id) {
        lowWhere += ' AND i.warehouse_id = ?'
        lowParams.push(warehouse_id)
      }
      lowWhere += ' AND i.quantity <= i.warn_quantity'
      const [[{ lowStockCount }]] = await pool.execute(
        `SELECT COUNT(*) as lowStockCount FROM inventory i ${lowWhere}`,
        lowParams
      )

      const limit = Math.max(1, parseInt(pageSize))
      const offset = Math.max(0, (parseInt(page) - 1) * limit)
      const [rows] = await pool.execute(
        `SELECT i.*, w.name as warehouse_name
         FROM inventory i
         LEFT JOIN warehouses w ON i.warehouse_id = w.id
         ${where}
         ORDER BY i.updated_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params
      )

      res.json(ok({ list: rows, total, lowStockCount }))
    } catch (err) {
      res.status(500).json(fail(err.message))
    }
  })

  // ============ 盘点 ============

  // 创建盘点
  router.post('/checks', async (req, res) => {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()

      const ownerId = getOwnerId(req.user)
      const { warehouse_id } = req.body

      if (!warehouse_id) {
        await connection.rollback()
        return res.json(fail('仓库ID不能为空'))
      }

      // 生成盘点编号
      const [noRows] = await connection.execute(
        'SELECT MAX(id) as max_id FROM inventory_checks'
      )
      const nextNo = (noRows[0].max_id || 0) + 1
      const checkNo = 'CK' + String(nextNo).padStart(6, '0')

      // 获取仓库中所有库存项
      const [invRows] = await connection.execute(
        'SELECT id, sku, product_name, quantity FROM inventory WHERE warehouse_id = ? AND owner_id = ?',
        [warehouse_id, ownerId]
      )

      // 创建盘点主记录
      const [result] = await connection.execute(
        `INSERT INTO inventory_checks (check_no, warehouse_id, total_items, status, operator_id, operator_name, owner_id)
         VALUES (?, ?, ?, 'checking', ?, ?, ?)`,
        [checkNo, warehouse_id, invRows.length, req.user.id, req.user.real_name || req.user.username, ownerId]
      )

      const checkId = result.insertId

      // 创建盘点明细
      for (const inv of invRows) {
        await connection.execute(
          `INSERT INTO inventory_check_items (check_id, inventory_id, sku, product_name, system_quantity)
           VALUES (?, ?, ?, ?, ?)`,
          [checkId, inv.id, inv.sku, inv.product_name, inv.quantity]
        )
      }

      await connection.commit()
      res.json(ok({ id: checkId, check_no: checkNo, total_items: invRows.length }))
    } catch (err) {
      await connection.rollback()
      res.status(500).json(fail(err.message))
    } finally {
      connection.release()
    }
  })

  // 盘点列表
  router.get('/checks', async (req, res) => {
    try {
      const ownerId = getOwnerId(req.user)
      const { warehouse_id, status, page = 1, pageSize = 20 } = req.query

      let where = 'WHERE ic.owner_id = ?'
      const params = [ownerId]

      if (warehouse_id) {
        where += ' AND ic.warehouse_id = ?'
        params.push(warehouse_id)
      }
      if (status) {
        where += ' AND ic.status = ?'
        params.push(status)
      }

      const countSql = `SELECT COUNT(*) as total FROM inventory_checks ic ${where}`
      const [[{ total }]] = await pool.execute(countSql, params)

      const limit = Math.max(1, parseInt(pageSize))
      const offset = Math.max(0, (parseInt(page) - 1) * limit)
      const [rows] = await pool.execute(
        `SELECT ic.*, w.name as warehouse_name
         FROM inventory_checks ic
         LEFT JOIN warehouses w ON ic.warehouse_id = w.id
         ${where}
         ORDER BY ic.id DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params
      )

      const list = rows.map(r => ({
        ...r,
        created_at: formatTime(r.created_at)
      }))

      res.json(ok({ list, total }))
    } catch (err) {
      res.status(500).json(fail(err.message))
    }
  })

  // 盘点详情
  router.get('/checks/:id', async (req, res) => {
    try {
      const ownerId = getOwnerId(req.user)

      const [checkRows] = await pool.execute(
        `SELECT ic.*, w.name as warehouse_name
         FROM inventory_checks ic
         LEFT JOIN warehouses w ON ic.warehouse_id = w.id
         WHERE ic.id = ? AND ic.owner_id = ?`,
        [req.params.id, ownerId]
      )

      if (!checkRows.length) {
        return res.status(404).json(fail('盘点记录不存在'))
      }

      const checkInfo = {
        ...checkRows[0],
        created_at: formatTime(checkRows[0].created_at)
      }

      const [items] = await pool.execute(
        'SELECT * FROM inventory_check_items WHERE check_id = ? ORDER BY id',
        [req.params.id]
      )

      checkInfo.items = items
      res.json(ok(checkInfo))
    } catch (err) {
      res.status(500).json(fail(err.message))
    }
  })

  // 更新盘点明细（录入实盘数量）
  router.put('/checks/:checkId/items/:itemId', async (req, res) => {
    try {
      const ownerId = getOwnerId(req.user)
      const { checkId, itemId } = req.params
      const { actual_quantity } = req.body

      if (actual_quantity === undefined || actual_quantity === null) {
        return res.json(fail('实盘数量不能为空'))
      }

      // 校验盘点单归属
      const [checkRows] = await pool.execute(
        'SELECT id, status FROM inventory_checks WHERE id = ? AND owner_id = ?',
        [checkId, ownerId]
      )
      if (!checkRows.length) {
        return res.status(404).json(fail('盘点记录不存在'))
      }
      if (checkRows[0].status === 'completed') {
        return res.json(fail('盘点已完成，无法修改'))
      }

      // 获取系统数量计算差异
      const [itemRows] = await pool.execute(
        'SELECT system_quantity FROM inventory_check_items WHERE id = ? AND check_id = ?',
        [itemId, checkId]
      )
      if (!itemRows.length) {
        return res.status(404).json(fail('盘点明细不存在'))
      }

      const diffQuantity = actual_quantity - itemRows[0].system_quantity

      await pool.execute(
        'UPDATE inventory_check_items SET actual_quantity = ?, diff_quantity = ? WHERE id = ? AND check_id = ?',
        [actual_quantity, diffQuantity, itemId, checkId]
      )

      // 更新盘点单的差异计数
      const [diffRows] = await pool.execute(
        'SELECT COUNT(*) as diff_count FROM inventory_check_items WHERE check_id = ? AND diff_quantity IS NOT NULL AND diff_quantity != 0',
        [checkId]
      )
      await pool.execute(
        'UPDATE inventory_checks SET diff_count = ? WHERE id = ?',
        [diffRows[0].diff_count, checkId]
      )

      res.json(ok({ success: true }))
    } catch (err) {
      res.status(500).json(fail(err.message))
    }
  })

  // 完成盘点（调整库存）
  router.put('/checks/:id/complete', async (req, res) => {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()

      const ownerId = getOwnerId(req.user)
      const checkId = req.params.id

      // 校验
      const [checkRows] = await connection.execute(
        'SELECT id, warehouse_id, status FROM inventory_checks WHERE id = ? AND owner_id = ?',
        [checkId, ownerId]
      )
      if (!checkRows.length) {
        await connection.rollback()
        return res.status(404).json(fail('盘点记录不存在'))
      }
      if (checkRows[0].status === 'completed') {
        await connection.rollback()
        return res.json(fail('盘点已完成'))
      }

      const warehouseId = checkRows[0].warehouse_id

      // 获取有差异的盘点明细
      const [items] = await connection.execute(
        'SELECT * FROM inventory_check_items WHERE check_id = ? AND actual_quantity IS NOT NULL AND diff_quantity != 0',
        [checkId]
      )

      // 按实盘数量调整库存
      for (const item of items) {
        await connection.execute(
          'UPDATE inventory SET quantity = ?, updated_at = NOW() WHERE id = ? AND warehouse_id = ? AND owner_id = ?',
          [item.actual_quantity, item.inventory_id, warehouseId, ownerId]
        )
      }

      // 更新盘点状态
      await connection.execute(
        "UPDATE inventory_checks SET status = 'completed', updated_at = NOW() WHERE id = ?",
        [checkId]
      )

      await connection.commit()
      res.json(ok({ success: true, adjusted_items: items.length }))
    } catch (err) {
      await connection.rollback()
      res.status(500).json(fail(err.message))
    } finally {
      connection.release()
    }
  })

  // 取消盘点
  router.put('/checks/:id/cancel', async (req, res) => {
    try {
      const ownerId = getOwnerId(req.user)

      const [checkRows] = await pool.execute(
        'SELECT id, status FROM inventory_checks WHERE id = ? AND owner_id = ?',
        [req.params.id, ownerId]
      )
      if (!checkRows.length) {
        return res.status(404).json(fail('盘点记录不存在'))
      }
      if (checkRows[0].status === 'completed') {
        return res.json(fail('已完成的盘点无法取消'))
      }

      await pool.execute(
        "UPDATE inventory_checks SET status = 'cancelled', updated_at = NOW() WHERE id = ?",
        [req.params.id]
      )

      res.json(ok({ success: true }))
    } catch (err) {
      res.status(500).json(fail(err.message))
    }
  })

  return router
}

// 格式化时间
function formatTime(date) {
  if (!date) return ''
  const d = new Date(date)
  if (isNaN(d.getTime())) return String(date)

  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
