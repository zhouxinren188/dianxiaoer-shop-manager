const express = require('express')
const cors = require('cors')
const path = require('path')
const { pool, initDB } = require('./db')

const app = express()
app.use(cors())
app.use(express.json())

// 完整更新文件静态服务（latest.yml + 安装包）
app.use('/updates', express.static(path.join(__dirname, 'updates')))

function ok(data) {
  return { code: 0, data }
}

function fail(message) {
  return { code: 1, message }
}

// ============ 用户管理接口 ============

// 查询用户列表
app.get('/api/users', async (req, res) => {
  try {
    const { page = 1, pageSize = 10, username, realName, userType, role, status } = req.query
    let sql = 'SELECT * FROM users WHERE 1=1'
    const params = []

    if (username) { sql += ' AND username LIKE ?'; params.push(`%${username}%`) }
    if (realName) { sql += ' AND real_name LIKE ?'; params.push(`%${realName}%`) }
    if (userType) { sql += ' AND user_type = ?'; params.push(userType) }
    if (role) { sql += ' AND role = ?'; params.push(role) }
    if (status) { sql += ' AND status = ?'; params.push(status) }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total')
    const [countRows] = await pool.execute(countSql, params)
    const total = countRows[0].total

    const limit = Math.max(1, parseInt(pageSize, 10) || 10)
    const offset = Math.max(0, ((parseInt(page, 10) || 1) - 1) * limit)
    sql += ` ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`

    const [rows] = await pool.execute(sql, params)

    // 查询每个用户的已分配店铺和仓库
    for (const user of rows) {
      const [stores] = await pool.execute(
        `SELECT s.id, s.name FROM stores s
         INNER JOIN user_stores us ON s.id = us.store_id
         WHERE us.user_id = ?`, [user.id]
      )
      const [warehouses] = await pool.execute(
        `SELECT w.id, w.name FROM warehouses w
         INNER JOIN user_warehouses uw ON w.id = uw.warehouse_id
         WHERE uw.user_id = ?`, [user.id]
      )
      user.assignedStores = stores
      user.assignedWarehouses = warehouses
    }

    const list = rows.map(r => ({
      id: r.id,
      username: r.username,
      realName: r.real_name,
      phone: r.phone,
      userType: r.user_type,
      role: r.role,
      status: r.status,
      createdAt: r.created_at,
      assignedStores: r.assignedStores,
      assignedWarehouses: r.assignedWarehouses
    }))

    res.json(ok({ list, total }))
  } catch (err) {
    console.error(err)
    res.status(500).json(fail(err.message))
  }
})

// 登录
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      return res.status(400).json({ code: 1, message: '用户名和密码不能为空' })
    }
    const [rows] = await pool.execute(
      'SELECT * FROM users WHERE username = ? AND status = ?',
      [username, 'enabled']
    )
    if (!rows.length) {
      return res.status(401).json({ code: 1, message: '账号或密码错误' })
    }
    const user = rows[0]
    if (user.password_hash !== password) {
      return res.status(401).json({ code: 1, message: '账号或密码错误' })
    }
    const token = 'token_' + Date.now() + '_' + Math.random().toString(36).slice(2)
    res.json(ok({
      accessToken: token,
      tokenType: 'Bearer',
      user: {
        id: user.id,
        username: user.username,
        realName: user.real_name,
        phone: user.phone,
        userType: user.user_type,
        role: user.role
      }
    }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 获取当前登录用户信息
app.get('/api/me', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'] || ''
    const username = authHeader.replace('Bearer ', '').trim()
    if (!username || !username.startsWith('token_')) {
      return res.status(401).json({ code: 1, message: '未登录' })
    }
    const [rows] = await pool.execute('SELECT * FROM users WHERE status = ? LIMIT 1', ['enabled'])
    if (!rows.length) return res.status(401).json({ code: 1, message: '用户不存在' })
    const r = rows[0]
    res.json(ok({
      id: r.id, username: r.username, realName: r.real_name, phone: r.phone,
      userType: r.user_type, role: r.role, status: r.status
    }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 获取单个用户
app.get('/api/users/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json(fail('用户不存在'))
    const r = rows[0]
    res.json(ok({
      id: r.id, username: r.username, realName: r.real_name, phone: r.phone,
      userType: r.user_type, role: r.role, status: r.status, createdAt: r.created_at
    }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 创建用户
app.post('/api/users', async (req, res) => {
  try {
    const { username, realName, phone, password, userType, role, status } = req.body
    if (!username) return res.json(fail('用户名不能为空'))

    const [exists] = await pool.execute('SELECT id FROM users WHERE username = ?', [username])
    if (exists.length) return res.json(fail('用户名已存在'))

    const [result] = await pool.execute(
      `INSERT INTO users (username, real_name, phone, password_hash, user_type, role, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [username, realName || username, phone || '', password || '', userType || 'sub', role || 'staff', status || 'enabled']
    )

    res.json(ok({ id: result.insertId, username, realName: realName || username, phone, userType, role, status }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 修改用户
app.put('/api/users/:id', async (req, res) => {
  try {
    const { realName, phone, userType, role, status } = req.body
    const fields = []
    const values = []

    if (realName !== undefined) { fields.push('real_name = ?'); values.push(realName) }
    if (phone !== undefined) { fields.push('phone = ?'); values.push(phone) }
    if (userType !== undefined) { fields.push('user_type = ?'); values.push(userType) }
    if (role !== undefined) { fields.push('role = ?'); values.push(role) }
    if (status !== undefined) { fields.push('status = ?'); values.push(status) }

    if (!fields.length) return res.json(fail('没有要修改的字段'))
    values.push(req.params.id)

    await pool.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values)
    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [req.params.id])
    const r = rows[0]
    res.json(ok({
      id: r.id, username: r.username, realName: r.real_name, phone: r.phone,
      userType: r.user_type, role: r.role, status: r.status
    }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 删除用户
app.delete('/api/users/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM users WHERE id = ?', [req.params.id])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 切换状态
app.put('/api/users/:id/toggle', async (req, res) => {
  try {
    const status = req.body.status || 'enabled'
    await pool.execute('UPDATE users SET status = ? WHERE id = ?', [status, req.params.id])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 分配店铺
app.put('/api/users/:id/stores', async (req, res) => {
  try {
    const userId = +req.params.id
    const storeIds = req.body.storeIds || []
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute('DELETE FROM user_stores WHERE user_id = ?', [userId])
      for (const storeId of storeIds) {
        await connection.execute('INSERT INTO user_stores (user_id, store_id) VALUES (?, ?)', [userId, storeId])
      }
      await connection.commit()
      res.json(ok(true))
    } catch (err) {
      await connection.rollback()
      throw err
    } finally {
      connection.release()
    }
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 分配仓库
app.put('/api/users/:id/warehouses', async (req, res) => {
  try {
    const userId = +req.params.id
    const warehouseIds = req.body.warehouseIds || []
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.execute('DELETE FROM user_warehouses WHERE user_id = ?', [userId])
      for (const whId of warehouseIds) {
        await connection.execute('INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (?, ?)', [userId, whId])
      }
      await connection.commit()
      res.json(ok(true))
    } catch (err) {
      await connection.rollback()
      throw err
    } finally {
      connection.release()
    }
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 获取用户已分配店铺
app.get('/api/users/:id/stores', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT s.* FROM stores s
       INNER JOIN user_stores us ON s.id = us.store_id
       WHERE us.user_id = ?`, [req.params.id]
    )
    res.json(ok(rows))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 获取用户已分配仓库
app.get('/api/users/:id/warehouses', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT w.* FROM warehouses w
       INNER JOIN user_warehouses uw ON w.id = uw.warehouse_id
       WHERE uw.user_id = ?`, [req.params.id]
    )
    res.json(ok(rows))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// ============ 店铺接口 ============

app.get('/api/stores', async (req, res) => {
  try {
    const { page = 1, pageSize = 10, name, platform, status, online } = req.query
    let sql = 'SELECT * FROM stores WHERE 1=1'
    const params = []

    if (name) { sql += ' AND name LIKE ?'; params.push(`%${name}%`) }
    if (platform) { sql += ' AND platform = ?'; params.push(platform) }
    if (status) { sql += ' AND status = ?'; params.push(status) }
    if (online !== undefined && online !== '') { sql += ' AND online = ?'; params.push(+online) }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total')
    const [countRows] = await pool.execute(countSql, params)
    const total = countRows[0].total

    const limit = Math.max(1, parseInt(pageSize, 10) || 10)
    const offset = Math.max(0, ((parseInt(page, 10) || 1) - 1) * limit)
    sql += ` ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`

    const [rows] = await pool.execute(sql, params)
    res.json(ok({ list: rows, total }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

app.get('/api/stores/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM stores WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json(fail('店铺不存在'))
    res.json(ok(rows[0]))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

app.post('/api/stores', async (req, res) => {
  try {
    const { name, platform, account, password, merchant_id, shop_id, tags, status } = req.body
    const [result] = await pool.execute(
      `INSERT INTO stores (name, platform, account, password, merchant_id, shop_id, tags, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name || '', platform || '', account || '', password || '', merchant_id || '', shop_id || '', JSON.stringify(tags || []), status || 'enabled']
    )
    res.json(ok({ id: result.insertId, ...req.body }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

app.put('/api/stores/:id', async (req, res) => {
  try {
    const allowed = ['name', 'platform', 'account', 'password', 'merchant_id', 'shop_id', 'tags', 'status']
    const fields = []
    const values = []
    for (const [key, val] of Object.entries(req.body)) {
      if (allowed.includes(key) && val !== undefined) {
        fields.push(`${key} = ?`)
        values.push(key === 'tags' ? JSON.stringify(val || []) : val)
      }
    }
    if (!fields.length) return res.json(fail('没有要修改的字段'))
    values.push(req.params.id)
    await pool.execute(`UPDATE stores SET ${fields.join(', ')} WHERE id = ?`, values)
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

app.delete('/api/stores/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM stores WHERE id = ?', [req.params.id])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

app.put('/api/stores/:id/toggle', async (req, res) => {
  try {
    const status = req.body.status || 'enabled'
    await pool.execute('UPDATE stores SET status = ? WHERE id = ?', [status, req.params.id])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

app.put('/api/stores/:id/status', async (req, res) => {
  try {
    const online = req.body.online !== undefined ? (req.body.online ? 1 : 0) : 1
    await pool.execute('UPDATE stores SET online = ? WHERE id = ?', [online, req.params.id])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// ============ 仓库接口 ============

app.get('/api/warehouses', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM warehouses ORDER BY id')
    res.json(ok({ list: rows, total: rows.length }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

app.get('/api/warehouses/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM warehouses WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json(fail('仓库不存在'))
    res.json(ok(rows[0]))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

app.post('/api/warehouses', async (req, res) => {
  try {
    const { name, code, location, contact, phone, status } = req.body
    if (!name) return res.json(fail('仓库名称不能为空'))
    const [result] = await pool.execute(
      `INSERT INTO warehouses (name, code, location, contact, phone, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, code || '', location || '', contact || '', phone || '', status || 'enabled']
    )
    res.json(ok({ id: result.insertId, ...req.body }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

app.put('/api/warehouses/:id', async (req, res) => {
  try {
    const allowed = ['name', 'code', 'location', 'contact', 'phone', 'status']
    const fields = []
    const values = []
    for (const [key, val] of Object.entries(req.body)) {
      if (allowed.includes(key)) {
        fields.push(`${key} = ?`)
        values.push(val)
      }
    }
    if (!fields.length) return res.json(fail('没有要修改的字段'))
    values.push(req.params.id)
    await pool.execute(`UPDATE warehouses SET ${fields.join(', ')} WHERE id = ?`, values)
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

app.delete('/api/warehouses/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM warehouses WHERE id = ?', [req.params.id])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// ============ Cookie 接口 ============

// 获取所有启用店铺的 Cookie（带店铺信息）
app.get('/api/cookies', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT c.id, c.store_id, c.cookie_data, c.domain, c.saved_at,
              s.name AS store_name, s.platform, s.account
       FROM cookies c
       LEFT JOIN stores s ON c.store_id = s.id
       ORDER BY c.saved_at DESC`
    )
    res.json(ok({ list: rows, total: rows.length }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 获取指定店铺的 Cookie
app.get('/api/cookies/:storeId', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM cookies WHERE store_id = ?', [req.params.storeId]
    )
    if (!rows.length) return res.status(404).json(fail('该店铺无 Cookie 数据'))
    res.json(ok(rows[0]))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 保存/更新店铺 Cookie（upsert）
app.post('/api/cookies', async (req, res) => {
  try {
    const { store_id, cookie_data, domain } = req.body
    if (!store_id) return res.json(fail('store_id 不能为空'))
    await pool.execute(
      `INSERT INTO cookies (store_id, cookie_data, domain, saved_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE cookie_data = VALUES(cookie_data), domain = VALUES(domain), saved_at = NOW()`,
      [store_id, typeof cookie_data === 'string' ? cookie_data : JSON.stringify(cookie_data || []), domain || '']
    )
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 删除指定店铺的 Cookie
app.delete('/api/cookies/:storeId', async (req, res) => {
  try {
    await pool.execute('DELETE FROM cookies WHERE store_id = ?', [req.params.storeId])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// ============ 供店订单 ============

// 批量保存/更新供店订单（upsert）
app.post('/api/supply-orders/batch', async (req, res) => {
  try {
    const { store_id, orders } = req.body
    if (!store_id) return res.json(fail('store_id 不能为空'))
    if (!Array.isArray(orders) || orders.length === 0) return res.json(fail('orders 不能为空'))

    let saved = 0
    for (const o of orders) {
      if (!o.orderId) continue
      await pool.execute(
        `INSERT INTO supply_orders
          (store_id, order_id, b_order_id, order_date, finish_time, stock_time,
           total_amount, goods_amount, freight_price, order_state, status_text,
           jd_order_state_desc, paid, wait_pay, lock_flag,
           dealer_code, dealer_name, supplier_name,
           receiver_name, receiver_phone, receiver_address, receiver_full_address,
           shipment_num, shipment_company_name,
           sku_id, product_name, product_image, unit_price, jd_price, quantity,
           outer_sku_id, sku_count, all_skus, order_source_desc, source_type, raw_data)
         VALUES (?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?, ?,?, ?,?,?,?,?,?, ?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           b_order_id=VALUES(b_order_id), order_date=VALUES(order_date),
           finish_time=VALUES(finish_time), stock_time=VALUES(stock_time),
           total_amount=VALUES(total_amount), goods_amount=VALUES(goods_amount),
           freight_price=VALUES(freight_price), order_state=VALUES(order_state),
           status_text=VALUES(status_text), jd_order_state_desc=VALUES(jd_order_state_desc),
           paid=VALUES(paid), wait_pay=VALUES(wait_pay), lock_flag=VALUES(lock_flag),
           dealer_code=VALUES(dealer_code), dealer_name=VALUES(dealer_name),
           supplier_name=VALUES(supplier_name),
           receiver_name=VALUES(receiver_name), receiver_phone=VALUES(receiver_phone),
           receiver_address=VALUES(receiver_address), receiver_full_address=VALUES(receiver_full_address),
           shipment_num=VALUES(shipment_num), shipment_company_name=VALUES(shipment_company_name),
           sku_id=VALUES(sku_id), product_name=VALUES(product_name), product_image=VALUES(product_image),
           unit_price=VALUES(unit_price), jd_price=VALUES(jd_price), quantity=VALUES(quantity),
           outer_sku_id=VALUES(outer_sku_id), sku_count=VALUES(sku_count), all_skus=VALUES(all_skus),
           order_source_desc=VALUES(order_source_desc), source_type=VALUES(source_type),
           raw_data=VALUES(raw_data), updated_at=NOW()`,
        [
          store_id, o.orderId, o.bOrderId || '', o.orderDate || '', o.finishTime || '', o.stockTime || '',
          o.totalAmount || 0, o.goodsAmount || 0, o.freightPrice || 0, o.orderState || 0, o.statusText || '',
          o.jdOrderStateDesc || '', o.paid ? 1 : 0, o.waitPay ? 1 : 0, o.lock || 0,
          o.dealerCode || '', o.dealerName || '', o.supplierName || '',
          o.receiverName || '', o.receiverPhone || '', o.receiverAddress || '', o.receiverFullAddress || '',
          o.shipmentNum || '', o.shipmentCompanyName || '',
          o.skuId || '', o.productName || '', o.productImage || '', o.unitPrice || 0, o.jdPrice || 0, o.quantity || 0,
          o.outerSkuId || '', o.skuCount || 1, JSON.stringify(o.allSkus || null),
          o.orderSourceDesc || '', o.sourceType || '', JSON.stringify(o)
        ]
      )
      saved++
    }
    res.json(ok({ saved }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 分页查询供店订单
app.get('/api/supply-orders', async (req, res) => {
  try {
    const { store_id, status, page = 1, pageSize = 20 } = req.query
    if (!store_id) return res.json(fail('store_id 不能为空'))

    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(pageSize)
    const limit = parseInt(pageSize)

    let where = 'WHERE store_id = ?'
    const params = [store_id]
    if (status) {
      where += ' AND status_text = ?'
      params.push(status)
    }

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM supply_orders ${where}`, params
    )
    const [rows] = await pool.execute(
      `SELECT * FROM supply_orders ${where} ORDER BY order_date DESC LIMIT ${limit} OFFSET ${offset}`, params
    )
    res.json(ok({ list: rows, total }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 获取单个供店订单
app.get('/api/supply-orders/:orderId', async (req, res) => {
  try {
    const { store_id } = req.query
    if (!store_id) return res.json(fail('store_id 不能为空'))
    const [rows] = await pool.execute(
      'SELECT * FROM supply_orders WHERE store_id = ? AND order_id = ?',
      [store_id, req.params.orderId]
    )
    if (!rows.length) return res.status(404).json(fail('订单不存在'))
    res.json(ok(rows[0]))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// ============ 销售订单 ============

// 批量保存/更新销售订单（upsert）
app.post('/api/sales-orders/batch', async (req, res) => {
  try {
    const { store_id, orders } = req.body
    if (!store_id) return res.json(fail('store_id 不能为空'))
    if (!Array.isArray(orders) || orders.length === 0) return res.json(fail('orders 不能为空'))

    let saved = 0
    for (const o of orders) {
      if (!o.orderId) continue
      await pool.execute(
        `INSERT INTO sales_orders
          (store_id, order_id, order_state, status_text,
           order_time, payment_time, ship_time, finish_time,
           total_amount, goods_amount, shipping_fee, payment_method,
           buyer_name, buyer_phone, buyer_address,
           logistics_company, logistics_no,
           sku_id, product_name, product_image, unit_price, quantity,
           item_count, all_items, raw_data)
         VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?, ?,?, ?,?,?,?,?, ?,?,?)
         ON DUPLICATE KEY UPDATE
           order_state=VALUES(order_state), status_text=VALUES(status_text),
           order_time=VALUES(order_time), payment_time=VALUES(payment_time),
           ship_time=VALUES(ship_time), finish_time=VALUES(finish_time),
           total_amount=VALUES(total_amount), goods_amount=VALUES(goods_amount),
           shipping_fee=VALUES(shipping_fee), payment_method=VALUES(payment_method),
           buyer_name=VALUES(buyer_name), buyer_phone=VALUES(buyer_phone),
           buyer_address=VALUES(buyer_address),
           logistics_company=VALUES(logistics_company), logistics_no=VALUES(logistics_no),
           sku_id=VALUES(sku_id), product_name=VALUES(product_name),
           product_image=VALUES(product_image), unit_price=VALUES(unit_price),
           quantity=VALUES(quantity), item_count=VALUES(item_count),
           all_items=VALUES(all_items), raw_data=VALUES(raw_data),
           updated_at=NOW()`,
        [
          store_id, o.orderId, o.orderState || 0, o.statusText || '',
          o.orderTime || '', o.paymentTime || '', o.shipTime || '', o.finishTime || '',
          o.totalAmount || 0, o.goodsAmount || 0, o.shippingFee || 0, o.paymentMethod || '',
          o.buyerName || '', o.buyerPhone || '', o.buyerAddress || '',
          o.logisticsCompany || '', o.logisticsNo || '',
          o.skuId || '', o.productName || '', o.productImage || '',
          o.unitPrice || 0, o.quantity || 0,
          o.itemCount || 1, JSON.stringify(o.allItems || null), JSON.stringify(o)
        ]
      )
      saved++
    }
    res.json(ok({ saved }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 分页查询销售订单
app.get('/api/sales-orders', async (req, res) => {
  try {
    const { store_id, status, page = 1, pageSize = 20 } = req.query
    if (!store_id) return res.json(fail('store_id 不能为空'))

    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(pageSize)
    const limit = parseInt(pageSize)

    let where = 'WHERE store_id = ?'
    const params = [store_id]
    if (status) {
      where += ' AND status_text = ?'
      params.push(status)
    }

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM sales_orders ${where}`, params
    )
    const [rows] = await pool.execute(
      `SELECT * FROM sales_orders ${where} ORDER BY order_time DESC LIMIT ${limit} OFFSET ${offset}`, params
    )
    res.json(ok({ list: rows, total }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 获取单个销售订单
app.get('/api/sales-orders/:orderId', async (req, res) => {
  try {
    const { store_id } = req.query
    if (!store_id) return res.json(fail('store_id 不能为空'))
    const [rows] = await pool.execute(
      'SELECT * FROM sales_orders WHERE store_id = ? AND order_id = ?',
      [store_id, req.params.orderId]
    )
    if (!rows.length) return res.status(404).json(fail('订单不存在'))
    res.json(ok(rows[0]))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// ============ 健康检查 ============

app.get('/health', async (req, res) => {
  try {
    await pool.execute('SELECT 1')
    res.json({ status: 'ok', time: new Date().toISOString() })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// ============ 启动 ============

const PORT = process.env.PORT || 3002

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] 后端服务已启动: http://0.0.0.0:${PORT}`)
  })
}).catch(err => {
  console.error('[Server] 数据库初始化失败:', err.message)
  process.exit(1)
})
