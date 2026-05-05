const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const { pool, initDB } = require('./db')

// 版本标记 - 用于验证代码是否更新
const APP_VERSION = 'v1.0.32-taobao-cookie-filter'
console.log(`[Server] Application version: ${APP_VERSION}`)
console.log('[Server] Taobao cookie filter: ENABLED (fix HTTP 431 error)')

// JWT 密钥（与 dianxiaoer-api 保持一致）
// 优先从环境变量读取，否则使用默认值
const JWT_SECRET = process.env.JWT_SECRET || 'bfb3079104c65c88d55b4ed46624c07b171d8254c87ec40a2f485370d10ee159a7115459fc9d249051bcd60bc0849633c47c4a8d1a4f167cce27aabfd152effd'
console.log(`[Server] JWT_SECRET source: ${process.env.JWT_SECRET ? 'ENV' : 'DEFAULT'}`)

const app = express()
app.use(cors())
app.use(express.json())

function ok(data) {
  return { code: 0, data }
}

function fail(message) {
  return { code: 1, message }
}

// ============ 全局认证中间件 ============

// 不需要认证的路径
const publicPaths = ['/health', '/api/sync-lock', '/api/auth/login']

app.use(async (req, res, next) => {
  // 公开接口跳过认证
  if (publicPaths.includes(req.path)) {
    return next()
  }

  const authHeader = req.headers['authorization'] || ''
  const token = authHeader.replace('Bearer ', '').trim()

  if (!token) {
    return res.status(401).json({ code: 1, message: '未登录或 token 无效' })
  }

  try {
    let user = null

    if (token.startsWith('token_')) {
      // 自定义 token 校验（兼容旧方式）
      const [rows] = await pool.execute(
        `SELECT ut.user_id, u.id, u.username, u.real_name, u.phone,
                u.user_type, u.role, u.parent_id, u.status
         FROM user_tokens ut
         INNER JOIN users u ON ut.user_id = u.id
         WHERE ut.token = ? AND u.status = 'enabled'`,
        [token]
      )
      user = rows[0] || null
    } else {
      // JWT 校验（来自 3001 dianxiaoer-api）
      try {
        const decoded = jwt.verify(token, JWT_SECRET)
        const username = decoded.sub || decoded.username
        if (username) {
          const [rows] = await pool.execute(
            `SELECT id, username, real_name, phone,
                    user_type, role, parent_id, status
             FROM users
             WHERE username = ? AND status = 'enabled'`,
            [username]
          )
          if (rows.length) {
            user = rows[0]
            user.user_id = user.id
          }
        }
      } catch (jwtErr) {
        console.error('[Auth] JWT 校验失败:', jwtErr.message)
      }
    }

    if (!user) {
      return res.status(401).json({ code: 1, message: 'token 已失效，请重新登录' })
    }

    req.user = user
    next()
  } catch (err) {
    console.error('[Auth] 认证失败:', err.message)
    return res.status(500).json({ code: 1, message: '认证服务异常' })
  }
})

// ============ 辅助函数 ============

// 状态名称标准化映射（JD API 返回值 → 前端标准名称）
const STATUS_ALIAS_MAP = {
  '等待付款': '待付款',
  '等待出库': '待出库',
  '锁定': '暂停订单',
  '暂停': '暂停订单',
  '已发货': '已出库',
}

function normalizeStatusText(statusText) {
  return STATUS_ALIAS_MAP[statusText] || statusText
}

// 获取当前用户对应的主账号 ID（master 就是自己，sub 取 parent_id）
function getOwnerId(user) {
  return user.user_type === 'master' ? user.id : user.parent_id
}

// 获取当前用户可访问的店铺 ID 列表
async function getAccessibleStoreIds(user) {
  const ownerId = getOwnerId(user)
  if (user.user_type === 'master') {
    // 主账号：看到自己名下所有店铺
    const [rows] = await pool.execute('SELECT id FROM stores WHERE owner_id = ?', [ownerId])
    return rows.map(r => r.id)
  } else {
    // 子账号：只看被分配的店铺（且店铺必须属于其主账号）
    const [rows] = await pool.execute(
      `SELECT s.id FROM stores s
       INNER JOIN user_stores us ON s.id = us.store_id
       WHERE us.user_id = ? AND s.owner_id = ?`,
      [user.id, ownerId]
    )
    return rows.map(r => r.id)
  }
}

// 获取当前用户可访问的仓库 ID 列表
async function getAccessibleWarehouseIds(user) {
  const ownerId = getOwnerId(user)
  if (user.user_type === 'master') {
    const [rows] = await pool.execute('SELECT id FROM warehouses WHERE owner_id = ?', [ownerId])
    return rows.map(r => r.id)
  } else {
    const [rows] = await pool.execute(
      `SELECT w.id FROM warehouses w
       INNER JOIN user_warehouses uw ON w.id = uw.warehouse_id
       WHERE uw.user_id = ? AND w.owner_id = ?`,
      [user.id, ownerId]
    )
    return rows.map(r => r.id)
  }
}

// ============ 用户管理接口 ============

// 查询用户列表（主账号看自己和子账号，子账号只看自己）
app.get('/api/users', async (req, res) => {
  try {
    const { page = 1, pageSize = 10, username, realName, userType, role, status } = req.query
    const ownerId = getOwnerId(req.user)

    let sql = 'SELECT * FROM users WHERE 1=1'
    const params = []

    if (req.user.user_type === 'master') {
      // 主账号看自己 + 挂在自己下面的子账号
      sql += ' AND (id = ? OR parent_id = ?)'
      params.push(ownerId, ownerId)
    } else {
      // 子账号只能看自己
      sql += ' AND id = ?'
      params.push(req.user.id)
    }

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

// 获取单个用户（只能查看同组用户）
app.get('/api/users/:id', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const [rows] = await pool.execute(
      'SELECT * FROM users WHERE id = ? AND (id = ? OR parent_id = ?)',
      [req.params.id, ownerId, ownerId]
    )
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

// 创建用户（只有 master 可以创建，创建的用户自动挂在当前主账号下）
app.post('/api/users', async (req, res) => {
  try {
    if (req.user.user_type !== 'master') {
      return res.status(403).json(fail('只有主账号才能创建用户'))
    }

    const { username, realName, phone, password, userType, role, status } = req.body
    if (!username) return res.json(fail('用户名不能为空'))

    const [exists] = await pool.execute('SELECT id FROM users WHERE username = ?', [username])
    if (exists.length) return res.json(fail('用户名已存在'))

    // 主账号创建的子账号，parent_id 指向自己
    const parentId = (userType === 'master') ? null : req.user.id

    // 使用 bcrypt 加密密码
    const passwordHash = password ? bcrypt.hashSync(password, 10) : ''

    const [result] = await pool.execute(
      `INSERT INTO users (username, real_name, phone, password_hash, user_type, role, parent_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [username, realName || username, phone || '', passwordHash, userType || 'sub', role || 'staff', parentId, status || 'enabled']
    )

    res.json(ok({ id: result.insertId, username, realName: realName || username, phone, userType, role, status }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 修改用户（只能修改同组用户）
app.put('/api/users/:id', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    // 验证目标用户属于同组
    const [check] = await pool.execute(
      'SELECT id FROM users WHERE id = ? AND (id = ? OR parent_id = ?)',
      [req.params.id, ownerId, ownerId]
    )
    if (!check.length) return res.status(403).json(fail('无权操作此用户'))

    const { realName, phone, userType, role, status, password } = req.body
    const fields = []
    const values = []

    if (realName !== undefined) { fields.push('real_name = ?'); values.push(realName) }
    if (phone !== undefined) { fields.push('phone = ?'); values.push(phone) }
    if (userType !== undefined) { fields.push('user_type = ?'); values.push(userType) }
    if (role !== undefined) { fields.push('role = ?'); values.push(role) }
    if (status !== undefined) { fields.push('status = ?'); values.push(status) }
    if (password !== undefined && password) {
      fields.push('password_hash = ?');
      values.push(bcrypt.hashSync(password, 10))
    }

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

// 删除用户（只能删除同组的子账号）
app.delete('/api/users/:id', async (req, res) => {
  try {
    if (req.user.user_type !== 'master') {
      return res.status(403).json(fail('只有主账号才能删除用户'))
    }
    const ownerId = getOwnerId(req.user)
    // 不能删除自己，只能删除挂在自己下面的子账号
    const [check] = await pool.execute(
      'SELECT id FROM users WHERE id = ? AND parent_id = ?',
      [req.params.id, ownerId]
    )
    if (!check.length) return res.status(403).json(fail('无权删除此用户'))

    // 同时清理该用户的 token
    await pool.execute('DELETE FROM user_tokens WHERE user_id = ?', [req.params.id])
    await pool.execute('DELETE FROM users WHERE id = ?', [req.params.id])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 切换状态（只能操作同组用户）
app.put('/api/users/:id/toggle', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const [check] = await pool.execute(
      'SELECT id FROM users WHERE id = ? AND (id = ? OR parent_id = ?)',
      [req.params.id, ownerId, ownerId]
    )
    if (!check.length) return res.status(403).json(fail('无权操作此用户'))

    const status = req.body.status || 'enabled'
    await pool.execute('UPDATE users SET status = ? WHERE id = ?', [status, req.params.id])

    // 禁用时清理 token
    if (status === 'disabled') {
      await pool.execute('DELETE FROM user_tokens WHERE user_id = ?', [req.params.id])
    }

    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 分配店铺（只有 master 可操作，且只能分配自己名下的店铺给子账号）
app.put('/api/users/:id/stores', async (req, res) => {
  try {
    if (req.user.user_type !== 'master') {
      return res.status(403).json(fail('只有主账号才能分配店铺'))
    }
    const userId = +req.params.id
    const storeIds = req.body.storeIds || []
    const ownerId = getOwnerId(req.user)

    // 验证目标用户是自己的子账号
    const [check] = await pool.execute(
      'SELECT id FROM users WHERE id = ? AND parent_id = ?',
      [userId, ownerId]
    )
    if (!check.length) return res.status(403).json(fail('只能给自己的子账号分配店铺'))

    // 验证所有店铺都是自己名下的
    if (storeIds.length > 0) {
      const placeholders = storeIds.map(() => '?').join(',')
      const [valid] = await pool.execute(
        `SELECT id FROM stores WHERE id IN (${placeholders}) AND owner_id = ?`,
        [...storeIds, ownerId]
      )
      if (valid.length !== storeIds.length) {
        return res.status(403).json(fail('包含不属于您的店铺'))
      }
    }

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

// 分配仓库（只有 master 可操作）
app.put('/api/users/:id/warehouses', async (req, res) => {
  try {
    if (req.user.user_type !== 'master') {
      return res.status(403).json(fail('只有主账号才能分配仓库'))
    }
    const userId = +req.params.id
    const warehouseIds = req.body.warehouseIds || []
    const ownerId = getOwnerId(req.user)

    const [check] = await pool.execute(
      'SELECT id FROM users WHERE id = ? AND parent_id = ?',
      [userId, ownerId]
    )
    if (!check.length) return res.status(403).json(fail('只能给自己的子账号分配仓库'))

    if (warehouseIds.length > 0) {
      const placeholders = warehouseIds.map(() => '?').join(',')
      const [valid] = await pool.execute(
        `SELECT id FROM warehouses WHERE id IN (${placeholders}) AND owner_id = ?`,
        [...warehouseIds, ownerId]
      )
      if (valid.length !== warehouseIds.length) {
        return res.status(403).json(fail('包含不属于您的仓库'))
      }
    }

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
    const ownerId = getOwnerId(req.user)
    const [check] = await pool.execute(
      'SELECT id FROM users WHERE id = ? AND (id = ? OR parent_id = ?)',
      [req.params.id, ownerId, ownerId]
    )
    if (!check.length) return res.status(403).json(fail('无权查看'))

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
    const ownerId = getOwnerId(req.user)
    const [check] = await pool.execute(
      'SELECT id FROM users WHERE id = ? AND (id = ? OR parent_id = ?)',
      [req.params.id, ownerId, ownerId]
    )
    if (!check.length) return res.status(403).json(fail('无权查看'))

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

// 查询店铺列表（按权限过滤）
app.get('/api/stores', async (req, res) => {
  try {
    const { page = 1, pageSize = 10, name, platform, store_type, status, online, merchant_id } = req.query
    const storeIds = await getAccessibleStoreIds(req.user)

    if (!storeIds.length) {
      return res.json(ok({ list: [], total: 0 }))
    }

    const placeholders = storeIds.map(() => '?').join(',')
    let sql = `SELECT * FROM stores WHERE id IN (${placeholders})`
    const params = [...storeIds]

    if (name) { sql += ' AND name LIKE ?'; params.push(`%${name}%`) }
    if (platform) { sql += ' AND platform = ?'; params.push(platform) }
    if (store_type) { sql += ' AND store_type = ?'; params.push(store_type) }
    if (status) { sql += ' AND status = ?'; params.push(status) }
    if (online !== undefined && online !== '') { sql += ' AND online = ?'; params.push(+online) }
    if (merchant_id) { sql += ' AND merchant_id = ?'; params.push(merchant_id) }

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total')
    const [countRows] = await pool.execute(countSql, params)
    const total = countRows[0].total

    const limit = Math.max(1, parseInt(pageSize, 10) || 10)
    const offset = Math.max(0, ((parseInt(page, 10) || 1) - 1) * limit)
    sql += ` ORDER BY id ASC LIMIT ${limit} OFFSET ${offset}`

    const [rows] = await pool.execute(sql, params)
    res.json(ok({ list: rows, total }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 获取单个店铺（权限校验）
app.get('/api/stores/:id', async (req, res) => {
  try {
    const storeIds = await getAccessibleStoreIds(req.user)
    const id = +req.params.id
    if (!storeIds.includes(id)) {
      return res.status(403).json(fail('无权访问此店铺'))
    }
    const [rows] = await pool.execute('SELECT * FROM stores WHERE id = ?', [id])
    if (!rows.length) return res.status(404).json(fail('店铺不存在'))
    res.json(ok(rows[0]))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 获取店铺最后同步时间
app.get('/api/stores/:id/last-sync', async (req, res) => {
  try {
    const storeIds = await getAccessibleStoreIds(req.user)
    const id = +req.params.id
    if (!storeIds.includes(id)) {
      return res.status(403).json(fail('无权访问此店铺'))
    }
    const [rows] = await pool.execute('SELECT last_sync_at FROM stores WHERE id = ?', [id])
    if (!rows.length) return res.status(404).json(fail('店铺不存在'))
    res.json(ok({ lastSyncAt: rows[0].last_sync_at }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 更新店铺最后同步时间
app.put('/api/stores/:id/sync-time', async (req, res) => {
  try {
    const storeIds = await getAccessibleStoreIds(req.user)
    const id = +req.params.id
    if (!storeIds.includes(id)) {
      return res.status(403).json(fail('无权修改此店铺'))
    }
    await pool.execute('UPDATE stores SET last_sync_at = NOW() WHERE id = ?', [id])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 创建店铺（自动设置 owner_id）
// 如果 merchant_id 已存在，则更新原有店铺而不是创建新店铺
app.post('/api/stores', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { name, platform, store_type, account, password, merchant_id, shop_id, tags, status } = req.body
    
    // 如果提供了 merchant_id，检查是否已存在
    if (merchant_id) {
      const [existingStores] = await pool.execute(
        'SELECT id FROM stores WHERE merchant_id = ? AND owner_id = ?',
        [merchant_id, ownerId]
      )
      
      if (existingStores.length > 0) {
        // 已存在相同 merchant_id 的店铺，更新它
        const existingId = existingStores[0].id
        console.log(`[Store] 发现重复店铺 merchant_id=${merchant_id}，更新店铺 ${existingId} 而不是创建新店铺`)
        
        await pool.execute(
          `UPDATE stores SET 
           name = ?, platform = ?, store_type = ?, account = ?, password = ?, 
           merchant_id = ?, shop_id = ?, tags = ?, status = ?
           WHERE id = ? AND owner_id = ?`,
          [name || '', platform || '', store_type || '', account || '', password || '', 
           merchant_id, shop_id || '', JSON.stringify(tags || []), status || 'enabled', existingId, ownerId]
        )
        
        res.json(ok({ id: existingId, updated: true, ...req.body }))
        return
      }
    }
    
    // 创建新店铺
    const [result] = await pool.execute(
      `INSERT INTO stores (name, platform, store_type, account, password, merchant_id, shop_id, tags, status, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name || '', platform || '', store_type || '', account || '', password || '', merchant_id || '', shop_id || '', JSON.stringify(tags || []), status || 'enabled', ownerId]
    )

    // 如果是子账号创建的店铺，自动关联到子账号（写入 user_stores 表）
    if (req.user.user_type !== 'master') {
      await pool.execute(
        'INSERT IGNORE INTO user_stores (user_id, store_id) VALUES (?, ?)',
        [req.user.id, result.insertId]
      )
      console.log(`[Store] 子账号 ${req.user.username} 创建店铺 ${result.insertId}，已自动关联`)
    }

    res.json(ok({ id: result.insertId, ...req.body }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 修改店铺（权限校验）
app.put('/api/stores/:id', async (req, res) => {
  try {
    const storeIds = await getAccessibleStoreIds(req.user)
    const id = +req.params.id
    if (!storeIds.includes(id)) {
      return res.status(403).json(fail('无权修改此店铺'))
    }

    const allowed = ['name', 'platform', 'store_type', 'account', 'password', 'merchant_id', 'shop_id', 'tags', 'status']
    const fields = []
    const values = []
    for (const [key, val] of Object.entries(req.body)) {
      if (allowed.includes(key) && val !== undefined) {
        fields.push(`${key} = ?`)
        values.push(key === 'tags' ? JSON.stringify(val || []) : val)
      }
    }
    if (!fields.length) return res.json(fail('没有要修改的字段'))
    values.push(id)
    await pool.execute(`UPDATE stores SET ${fields.join(', ')} WHERE id = ?`, values)
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 删除店铺（只有 master 可删除自己名下的）
app.delete('/api/stores/:id', async (req, res) => {
  try {
    if (req.user.user_type !== 'master') {
      return res.status(403).json(fail('只有主账号才能删除店铺'))
    }
    const ownerId = getOwnerId(req.user)
    const [check] = await pool.execute('SELECT id FROM stores WHERE id = ? AND owner_id = ?', [req.params.id, ownerId])
    if (!check.length) return res.status(403).json(fail('无权删除此店铺'))

    await pool.execute('DELETE FROM stores WHERE id = ?', [req.params.id])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 切换店铺启用/禁用（权限校验）
app.put('/api/stores/:id/toggle', async (req, res) => {
  try {
    const storeIds = await getAccessibleStoreIds(req.user)
    const id = +req.params.id
    if (!storeIds.includes(id)) {
      return res.status(403).json(fail('无权操作此店铺'))
    }
    const status = req.body.status || 'enabled'
    await pool.execute('UPDATE stores SET status = ? WHERE id = ?', [status, id])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 切换店铺在线状态（权限校验）
app.put('/api/stores/:id/status', async (req, res) => {
  try {
    const storeIds = await getAccessibleStoreIds(req.user)
    const id = +req.params.id
    if (!storeIds.includes(id)) {
      return res.status(403).json(fail('无权操作此店铺'))
    }
    const online = req.body.online !== undefined ? (req.body.online ? 1 : 0) : 1
    await pool.execute('UPDATE stores SET online = ? WHERE id = ?', [online, id])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// ============ 仓库接口 ============

// 查询仓库列表（按权限过滤）
app.get('/api/warehouses', async (req, res) => {
  try {
    const whIds = await getAccessibleWarehouseIds(req.user)

    if (!whIds.length) {
      return res.json(ok({ list: [], total: 0 }))
    }

    const placeholders = whIds.map(() => '?').join(',')
    const [rows] = await pool.execute(
      `SELECT * FROM warehouses WHERE id IN (${placeholders}) ORDER BY id`,
      whIds
    )
    res.json(ok({ list: rows, total: rows.length }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 获取单个仓库（权限校验）
app.get('/api/warehouses/:id', async (req, res) => {
  try {
    const whIds = await getAccessibleWarehouseIds(req.user)
    const id = +req.params.id
    if (!whIds.includes(id)) {
      return res.status(403).json(fail('无权访问此仓库'))
    }
    const [rows] = await pool.execute('SELECT * FROM warehouses WHERE id = ?', [id])
    if (!rows.length) return res.status(404).json(fail('仓库不存在'))
    res.json(ok(rows[0]))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 创建仓库（自动设置 owner_id）
app.post('/api/warehouses', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { name, code, location, contact, phone, status } = req.body
    if (!name) return res.json(fail('仓库名称不能为空'))
    const [result] = await pool.execute(
      `INSERT INTO warehouses (name, code, location, contact, phone, status, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, code || '', location || '', contact || '', phone || '', status || 'enabled', ownerId]
    )
    res.json(ok({ id: result.insertId, ...req.body }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 修改仓库（权限校验）
app.put('/api/warehouses/:id', async (req, res) => {
  try {
    const whIds = await getAccessibleWarehouseIds(req.user)
    const id = +req.params.id
    if (!whIds.includes(id)) {
      return res.status(403).json(fail('无权修改此仓库'))
    }

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
    values.push(id)
    await pool.execute(`UPDATE warehouses SET ${fields.join(', ')} WHERE id = ?`, values)
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 删除仓库（只有 master）
app.delete('/api/warehouses/:id', async (req, res) => {
  try {
    if (req.user.user_type !== 'master') {
      return res.status(403).json(fail('只有主账号才能删除仓库'))
    }
    const ownerId = getOwnerId(req.user)
    const [check] = await pool.execute('SELECT id FROM warehouses WHERE id = ? AND owner_id = ?', [req.params.id, ownerId])
    if (!check.length) return res.status(403).json(fail('无权删除此仓库'))

    await pool.execute('DELETE FROM warehouses WHERE id = ?', [req.params.id])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// ============ Cookie 接口 ============

// 获取所有可访问店铺的 Cookie
app.get('/api/cookies', async (req, res) => {
  try {
    const storeIds = await getAccessibleStoreIds(req.user)
    if (!storeIds.length) {
      return res.json(ok({ list: [], total: 0 }))
    }

    const placeholders = storeIds.map(() => '?').join(',')
    const [rows] = await pool.execute(
      `SELECT c.id, c.store_id, c.cookie_data, c.domain, c.saved_at,
              s.name AS store_name, s.platform, s.account
       FROM cookies c
       LEFT JOIN stores s ON c.store_id = s.id
       WHERE c.store_id IN (${placeholders})
       ORDER BY c.saved_at DESC`,
      storeIds
    )
    res.json(ok({ list: rows, total: rows.length }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 获取指定店铺的 Cookie（权限校验）
app.get('/api/cookies/:storeId', async (req, res) => {
  try {
    const storeIds = await getAccessibleStoreIds(req.user)
    const storeId = +req.params.storeId
    if (!storeIds.includes(storeId)) {
      return res.status(403).json(fail('无权访问此店铺 Cookie'))
    }

    const [rows] = await pool.execute(
      'SELECT * FROM cookies WHERE store_id = ?', [storeId]
    )
    if (!rows.length) return res.status(404).json(fail('该店铺无 Cookie 数据'))
    res.json(ok(rows[0]))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 保存/更新店铺 Cookie（权限校验）
app.post('/api/cookies', async (req, res) => {
  try {
    const { store_id, cookie_data, domain } = req.body
    if (!store_id) return res.json(fail('store_id 不能为空'))

    const storeIds = await getAccessibleStoreIds(req.user)
    if (!storeIds.includes(+store_id)) {
      return res.status(403).json(fail('无权操作此店铺 Cookie'))
    }

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

// 删除指定店铺的 Cookie（权限校验）
app.delete('/api/cookies/:storeId', async (req, res) => {
  try {
    const storeIds = await getAccessibleStoreIds(req.user)
    const storeId = +req.params.storeId
    if (!storeIds.includes(storeId)) {
      return res.status(403).json(fail('无权删除此店铺 Cookie'))
    }

    await pool.execute('DELETE FROM cookies WHERE store_id = ?', [storeId])
    res.json(ok(true))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// ============ 供店订单 ============

// 批量保存/更新供店订单（权限校验）
app.post('/api/supply-orders/batch', async (req, res) => {
  try {
    const { store_id, orders } = req.body
    if (!store_id) return res.json(fail('store_id 不能为空'))
    if (!Array.isArray(orders) || orders.length === 0) return res.json(fail('orders 不能为空'))

    const storeIds = await getAccessibleStoreIds(req.user)
    if (!storeIds.includes(+store_id)) {
      return res.status(403).json(fail('无权操作此店铺订单'))
    }

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

// 分页查询供店订单（权限过滤）
app.get('/api/supply-orders', async (req, res) => {
  try {
    const { store_id, status, page = 1, pageSize = 20 } = req.query
    if (!store_id) return res.json(fail('store_id 不能为空'))

    const storeIds = await getAccessibleStoreIds(req.user)
    if (!storeIds.includes(+store_id)) {
      return res.status(403).json(fail('无权查看此店铺订单'))
    }

    const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(pageSize, 10)
    const limit = parseInt(pageSize, 10)

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

// 获取单个供店订单（权限校验）
app.get('/api/supply-orders/:orderId', async (req, res) => {
  try {
    const { store_id } = req.query
    if (!store_id) return res.json(fail('store_id 不能为空'))

    const storeIds = await getAccessibleStoreIds(req.user)
    if (!storeIds.includes(+store_id)) {
      return res.status(403).json(fail('无权查看此店铺订单'))
    }

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

// 批量保存/更新销售订单（权限校验）
app.post('/api/sales-orders/batch', async (req, res) => {
  try {
    const { store_id, orders } = req.body
    if (!store_id) return res.json(fail('store_id 不能为空'))
    if (!Array.isArray(orders) || orders.length === 0) return res.json(fail('orders 不能为空'))

    const storeIds = await getAccessibleStoreIds(req.user)
    if (!storeIds.includes(+store_id)) {
      return res.status(403).json(fail('无权操作此店铺订单'))
    }

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
           store_id=VALUES(store_id),
           order_state=VALUES(order_state), status_text=VALUES(status_text),
           order_time=VALUES(order_time), payment_time=VALUES(payment_time),
           ship_time=VALUES(ship_time), finish_time=VALUES(finish_time),
           total_amount=VALUES(total_amount), goods_amount=VALUES(goods_amount),
           shipping_fee=VALUES(shipping_fee), payment_method=VALUES(payment_method),
           buyer_name=IF(VALUES(buyer_name)!='', VALUES(buyer_name), buyer_name),
           buyer_phone=IF(VALUES(buyer_phone) REGEXP '[*]', buyer_phone, IF(VALUES(buyer_phone)!='', VALUES(buyer_phone), buyer_phone)),
           buyer_address=IF(VALUES(buyer_address)!='', VALUES(buyer_address), buyer_address),
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

// 更新销售订单买家信息（仅更新 buyer_name, buyer_phone, buyer_address）
app.put('/api/sales-orders/:orderId/buyer-info', async (req, res) => {
  try {
    const { orderId } = req.params
    const { store_id, buyerName, buyerPhone, buyerAddress } = req.body
    if (!store_id || !orderId) return res.json(fail('store_id 和 orderId 不能为空'))

    const storeIds = await getAccessibleStoreIds(req.user)
    if (!storeIds.includes(+store_id)) {
      return res.status(403).json(fail('无权操作此店铺订单'))
    }

    const [result] = await pool.execute(
      `UPDATE sales_orders SET buyer_name=?, buyer_phone=?, buyer_address=?, updated_at=NOW()
       WHERE store_id=? AND order_id=?`,
      [buyerName || '', buyerPhone || '', buyerAddress || '', store_id, orderId]
    )
    res.json(ok({ updated: result.affectedRows }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 更新销售订单系统备注（采购绑定成功后自动写入）
app.put('/api/sales-orders/:orderId/sys-remark', async (req, res) => {
  try {
    const { orderId } = req.params
    const { sys_remark } = req.body
    if (!orderId) return res.json(fail('orderId 不能为空'))

    // 尝试通过 store_id 校验权限；如果用户没有关联店铺则仅用 id 匹配
    // （sales_orders 可能没有 owner_id 列，所以不用 owner_id 过滤）
    const storeIds = await getAccessibleStoreIds(req.user)
    let result
    if (storeIds.length > 0) {
      const placeholders = storeIds.map(() => '?').join(',')
      ;[result] = await pool.execute(
        `UPDATE sales_orders SET sys_remark=?, updated_at=NOW() WHERE id=? AND store_id IN (${placeholders})`,
        [sys_remark || '', orderId, ...storeIds]
      )
    } else {
      // 用户没有关联店铺时，仅用 id 匹配（已通过 JWT 认证，安全性可接受）
      ;[result] = await pool.execute(
        'UPDATE sales_orders SET sys_remark=?, updated_at=NOW() WHERE id=?',
        [sys_remark || '', orderId]
      )
    }
    res.json(ok({ updated: result.affectedRows }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 更新销售订单采购状态（仅允许手动设置为'已忽略'）
app.put('/api/sales-orders/:orderId/purchase-status', async (req, res) => {
  try {
    const { orderId } = req.params
    const { purchase_status } = req.body
    if (!orderId) return res.json(fail('orderId 不能为空'))
    if (!purchase_status) return res.json(fail('purchase_status 不能为空'))
    if (purchase_status !== '已忽略') return res.json(fail('仅允许设置为已忽略'))

    const storeIds = await getAccessibleStoreIds(req.user)
    let result
    if (storeIds.length > 0) {
      const placeholders = storeIds.map(() => '?').join(',')
      ;[result] = await pool.execute(
        `UPDATE sales_orders SET purchase_status=?, updated_at=NOW() WHERE id=? AND store_id IN (${placeholders})`,
        [purchase_status, orderId, ...storeIds]
      )
    } else {
      ;[result] = await pool.execute(
        'UPDATE sales_orders SET purchase_status=?, updated_at=NOW() WHERE id=?',
        [purchase_status, orderId]
      )
    }
    res.json(ok({ updated: result.affectedRows }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 分页查询销售订单（权限过滤）
app.get('/api/sales-orders', async (req, res) => {
  try {
    const { store_id, status, page = 1, pageSize = 20,
            order_id, goods_name, customer_name, customer_phone, outbound_no, store_tag, purchase_status } = req.query
    const storeIds = await getAccessibleStoreIds(req.user)

    const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(pageSize, 10)
    const limit = parseInt(pageSize, 10)

    let where = 'WHERE 1=1'
    const params = []

    if (store_id) {
      if (!storeIds.includes(+store_id)) {
        return res.status(403).json(fail('无权查看此店铺订单'))
      }
      where += ' AND store_id = ?'
      params.push(store_id)
    } else {
      // 没指定 store_id 时，只看可访问店铺的订单
      if (!storeIds.length) {
        return res.json(ok({ list: [], total: 0 }))
      }
      const placeholders = storeIds.map(() => '?').join(',')
      where += ` AND store_id IN (${placeholders})`
      params.push(...storeIds)
    }

    if (status) {
      // 支持标准化状态名过滤：前端传 "待出库" 也能匹配数据库中的 "等待出库"
      const reverseAliases = Object.entries(STATUS_ALIAS_MAP)
        .filter(([, v]) => v === status)
        .map(([k]) => k)
      if (reverseAliases.length > 0) {
        where += ` AND status_text IN (${[status, ...reverseAliases].map(() => '?').join(',')})`
        params.push(status, ...reverseAliases)
      } else {
        where += ' AND status_text = ?'
        params.push(status)
      }
    }
    if (order_id) {
      where += ' AND order_id LIKE ?'
      params.push(`%${order_id}%`)
    }
    if (goods_name) {
      where += ' AND (product_name LIKE ? OR all_items LIKE ?)'
      params.push(`%${goods_name}%`, `%${goods_name}%`)
    }
    if (customer_name) {
      where += ' AND buyer_name LIKE ?'
      params.push(`%${customer_name}%`)
    }
    if (customer_phone) {
      where += ' AND buyer_phone LIKE ?'
      params.push(`%${customer_phone}%`)
    }
    if (outbound_no) {
      where += ' AND logistics_no LIKE ?'
      params.push(`%${outbound_no}%`)
    }
    if (store_tag) {
      where += ' AND store_id IN (SELECT id FROM stores WHERE JSON_CONTAINS(tags, ?))'
      params.push(JSON.stringify(store_tag))
    }
    if (purchase_status) {
      if (purchase_status === '仓库有货') {
        where += ' AND purchase_status = ?'
        params.push('未采购')
      } else {
        where += ' AND purchase_status = ?'
        params.push(purchase_status)
      }
    }

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM sales_orders ${where}`, params
    )
    const [rows] = await pool.execute(
      `SELECT * FROM sales_orders ${where} ORDER BY order_time DESC LIMIT ${limit} OFFSET ${offset}`, params
    )

    // 动态检测仓库有货：对"未采购"订单批量查询 inventory 表
    if (rows.length > 0) {
      const ownerId = getOwnerId(req.user)
      const skuSet = new Set()
      rows.forEach(row => {
        if (row.purchase_status === '未采购') {
          if (row.sku_id) skuSet.add(row.sku_id)
          // 解析 all_items 提取多 SKU
          try {
            const items = typeof row.all_items === 'string' ? JSON.parse(row.all_items || 'null') : row.all_items
            if (Array.isArray(items)) {
              items.forEach(it => { if (it.skuId) skuSet.add(it.skuId) })
            }
          } catch {}
        }
      })
      if (skuSet.size > 0) {
        try {
          const skuList = [...skuSet]
          const invPlaceholders = skuList.map(() => '?').join(',')
          const [invRows] = await pool.execute(
            `SELECT DISTINCT sku FROM inventory WHERE sku IN (${invPlaceholders}) AND quantity > 0 AND owner_id = ?`,
            [...skuList, ownerId]
          )
          const invSkuSet = new Set(invRows.map(r => r.sku))
          rows.forEach(row => {
            row.has_inventory = false
            if (row.purchase_status === '未采购') {
              if (row.sku_id && invSkuSet.has(row.sku_id)) {
                row.has_inventory = true
              } else {
                try {
                  const items = typeof row.all_items === 'string' ? JSON.parse(row.all_items || 'null') : row.all_items
                  if (Array.isArray(items) && items.some(it => it.skuId && invSkuSet.has(it.skuId))) {
                    row.has_inventory = true
                  }
                } catch {}
              }
            }
          })
        } catch (e) {
          rows.forEach(row => { row.has_inventory = false })
        }
      } else {
        rows.forEach(row => { row.has_inventory = false })
      }
    }

    res.json(ok({ list: rows, total }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 获取销售订单状态计数（用于状态标签栏）
app.get('/api/sales-orders/status-counts', async (req, res) => {
  try {
    const { store_id, order_id, goods_name, customer_name, customer_phone, outbound_no, store_tag, purchase_status } = req.query
    const storeIds = await getAccessibleStoreIds(req.user)

    let where = 'WHERE 1=1'
    const params = []

    if (store_id) {
      if (!storeIds.includes(+store_id)) {
        return res.status(403).json(fail('无权查看此店铺订单'))
      }
      where += ' AND store_id = ?'
      params.push(store_id)
    } else {
      if (!storeIds.length) {
        return res.json(ok({ total: 0, counts: {} }))
      }
      const placeholders = storeIds.map(() => '?').join(',')
      where += ` AND store_id IN (${placeholders})`
      params.push(...storeIds)
    }
    if (order_id) {
      where += ' AND order_id LIKE ?'
      params.push(`%${order_id}%`)
    }
    if (goods_name) {
      where += ' AND (product_name LIKE ? OR all_items LIKE ?)'
      params.push(`%${goods_name}%`, `%${goods_name}%`)
    }
    if (customer_name) {
      where += ' AND buyer_name LIKE ?'
      params.push(`%${customer_name}%`)
    }
    if (customer_phone) {
      where += ' AND buyer_phone LIKE ?'
      params.push(`%${customer_phone}%`)
    }
    if (outbound_no) {
      where += ' AND logistics_no LIKE ?'
      params.push(`%${outbound_no}%`)
    }
    if (store_tag) {
      where += ' AND store_id IN (SELECT id FROM stores WHERE JSON_CONTAINS(tags, ?))'
      params.push(JSON.stringify(store_tag))
    }
    if (purchase_status) {
      if (purchase_status === '仓库有货') {
        where += ' AND purchase_status = ?'
        params.push('未采购')
      } else {
        where += ' AND purchase_status = ?'
        params.push(purchase_status)
      }
    }

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM sales_orders ${where}`, params
    )
    const [statusRows] = await pool.execute(
      `SELECT status_text, COUNT(*) as count FROM sales_orders ${where} GROUP BY status_text`, params
    )
    const counts = {}
    statusRows.forEach(r => {
      if (r.status_text) {
        const normalizedStatus = normalizeStatusText(r.status_text)
        counts[normalizedStatus] = (counts[normalizedStatus] || 0) + r.count
      }
    })
    res.json(ok({ total, counts }))
  } catch (err) {
    res.status(500).json(fail(err.message))
  }
})

// 获取单个销售订单（权限校验）
app.get('/api/sales-orders/:orderId', async (req, res) => {
  try {
    const { store_id } = req.query
    if (!store_id) return res.json(fail('store_id 不能为空'))

    const storeIds = await getAccessibleStoreIds(req.user)
    if (!storeIds.includes(+store_id)) {
      return res.status(403).json(fail('无权查看此店铺订单'))
    }

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

// ============ SKU 采购配置 ============

app.get('/api/sku-purchase-config', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { sku_id } = req.query
    let sql = 'SELECT * FROM sku_purchase_config WHERE owner_id = ?'
    const params = [ownerId]
    if (sku_id) { sql += ' AND sku_id = ?'; params.push(sku_id) }
    sql += ' ORDER BY id DESC'
    const [rows] = await pool.execute(sql, params)
    res.json(ok({ list: rows, total: rows.length }))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

app.post('/api/sku-purchase-config', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { id, sku_id, platform, purchase_link, purchase_price, remark } = req.body
    if (!sku_id) return res.json(fail('sku_id 不能为空'))
    if (id) {
      await pool.execute(
        'UPDATE sku_purchase_config SET platform=?, purchase_link=?, purchase_price=?, remark=? WHERE id=? AND owner_id=?',
        [platform||'', purchase_link||'', purchase_price||0, remark||'', id, ownerId]
      )
      res.json(ok({ id }))
    } else {
      const [result] = await pool.execute(
        'INSERT INTO sku_purchase_config (sku_id, platform, purchase_link, purchase_price, remark, owner_id) VALUES (?,?,?,?,?,?)',
        [sku_id, platform||'', purchase_link||'', purchase_price||0, remark||'', ownerId]
      )
      res.json(ok({ id: result.insertId }))
    }
  } catch (err) { res.status(500).json(fail(err.message)) }
})

app.delete('/api/sku-purchase-config/:id', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    await pool.execute('DELETE FROM sku_purchase_config WHERE id=? AND owner_id=?', [req.params.id, ownerId])
    res.json(ok(true))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

app.put('/api/sku-purchase-config/update-price', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { sku_id, purchase_link, purchase_price, platform } = req.body
    if (!sku_id || !purchase_link || !purchase_price) {
      return res.json(fail('sku_id, purchase_link, purchase_price 不能为空'))
    }
    const [rows] = await pool.execute(
      'SELECT id FROM sku_purchase_config WHERE sku_id=? AND purchase_link=? AND owner_id=?',
      [sku_id, purchase_link, ownerId]
    )
    if (rows.length > 0) {
      await pool.execute(
        'UPDATE sku_purchase_config SET purchase_price=?, updated_at=NOW() WHERE id=?',
        [purchase_price, rows[0].id]
      )
      res.json(ok({ id: rows[0].id, action: 'updated' }))
    } else {
      const [result] = await pool.execute(
        'INSERT INTO sku_purchase_config (sku_id, platform, purchase_link, purchase_price, owner_id) VALUES (?,?,?,?,?)',
        [sku_id, platform || '', purchase_link, purchase_price, ownerId]
      )
      res.json(ok({ id: result.insertId, action: 'created' }))
    }
  } catch (err) { res.status(500).json(fail(err.message)) }
})

// ============ 采购账号管理 ============

app.get('/api/purchase-accounts', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const [rows] = await pool.execute(
      'SELECT id, account, password, platform, online, created_at, updated_at FROM purchase_accounts WHERE owner_id=? ORDER BY id DESC',
      [ownerId]
    )
    
    // 为每个账号检查Cookie是否有效（是否存在Cookie数据）
    const accountList = await Promise.all(rows.map(async (row) => {
      const [cookieRows] = await pool.execute(
        'SELECT id FROM purchase_cookies WHERE account_id = ? LIMIT 1',
        [row.id]
      )
      return {
        ...row,
        cookie_valid: cookieRows.length > 0  // 有Cookie数据就认为有效
      }
    }))
    
    res.json(ok({ list: accountList, total: accountList.length }))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

app.post('/api/purchase-accounts', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { account, password, platform } = req.body
    if (!platform) return res.json(fail('platform 不能为空'))
    const [result] = await pool.execute(
      'INSERT INTO purchase_accounts (account, password, platform, online, owner_id) VALUES (?,?,?,0,?)',
      [account||'', password||'', platform, ownerId]
    )
    res.json(ok({ id: result.insertId }))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

app.put('/api/purchase-accounts/:id', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { account, password, platform } = req.body
    const fields = []; const values = []
    if (account !== undefined) { fields.push('account=?'); values.push(account) }
    if (password !== undefined) { fields.push('password=?'); values.push(password) }
    if (platform !== undefined) { fields.push('platform=?'); values.push(platform) }
    if (!fields.length) return res.json(fail('没有要修改的字段'))
    values.push(req.params.id, ownerId)
    await pool.execute('UPDATE purchase_accounts SET ' + fields.join(',') + ' WHERE id=? AND owner_id=?', values)
    res.json(ok(true))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

app.delete('/api/purchase-accounts/:id', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    await pool.execute('DELETE FROM purchase_cookies WHERE account_id=?', [req.params.id])
    await pool.execute('DELETE FROM purchase_accounts WHERE id=? AND owner_id=?', [req.params.id, ownerId])
    res.json(ok(true))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

app.post('/api/purchase-accounts/:id/cookies', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const accountId = req.params.id
    const { cookie_data, platform } = req.body
    const [check] = await pool.execute('SELECT id FROM purchase_accounts WHERE id=? AND owner_id=?', [accountId, ownerId])
    if (!check.length) return res.status(403).json(fail('无权操作此账号'))
    await pool.execute(
      'INSERT INTO purchase_cookies (account_id, cookie_data, platform, saved_at) VALUES (?,?,?,NOW()) ON DUPLICATE KEY UPDATE cookie_data=VALUES(cookie_data), platform=VALUES(platform), saved_at=NOW()',
      [accountId, typeof cookie_data === 'string' ? cookie_data : JSON.stringify(cookie_data||[]), platform||'']
    )
    await pool.execute('UPDATE purchase_accounts SET online=1 WHERE id=?', [accountId])
    res.json(ok(true))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

app.get('/api/purchase-accounts/:id/cookies', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const [check] = await pool.execute('SELECT id FROM purchase_accounts WHERE id=? AND owner_id=?', [req.params.id, ownerId])
    if (!check.length) return res.status(403).json(fail('无权操作此账号'))
    const [rows] = await pool.execute('SELECT * FROM purchase_cookies WHERE account_id=?', [req.params.id])
    res.json(ok(rows.length ? rows[0] : null))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

app.put('/api/purchase-accounts/:id/status', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { online } = req.body
    await pool.execute('UPDATE purchase_accounts SET online=? WHERE id=? AND owner_id=?', [online?1:0, req.params.id, ownerId])
    res.json(ok(true))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

// ============ 采购订单 ============

// 获取下一个采购编号（全局递增，避免编号冲突）
app.get('/api/purchase-orders/next-no', async (req, res) => {
  try {
    // 只取纯数字格式的 purchase_no，忽略 TEST_ 等非编号数据
    const [rows] = await pool.execute(
      "SELECT purchase_no FROM purchase_orders WHERE purchase_no REGEXP '^[0-9]+$' ORDER BY id DESC LIMIT 1"
    )
    let nextNum = 1
    if (rows.length > 0 && rows[0].purchase_no) {
      const num = parseInt(rows[0].purchase_no, 10)
      if (!isNaN(num)) nextNum = num + 1
    }
    const purchaseNo = String(nextNum).padStart(4, '0')
    res.json(ok({ purchase_no: purchaseNo }))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

app.post('/api/purchase-orders', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { purchase_no, sales_order_id, sales_order_no, goods_name, goods_image, sku, quantity,
            source_url, platform, purchase_price, remark,
            purchase_type, shipping_name, shipping_phone, shipping_address, account_id } = req.body
    if (!purchase_no) return res.json(fail('purchase_no 不能为空'))
    await pool.execute(
      `INSERT INTO purchase_orders
        (purchase_no, sales_order_id, sales_order_no, goods_name, goods_image, sku, quantity,
         source_url, platform, purchase_price, remark,
         purchase_type, shipping_name, shipping_phone, shipping_address, account_id,
         status, owner_id)
       VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?, 'pending', ?)
       ON DUPLICATE KEY UPDATE
         owner_id=VALUES(owner_id),
         sales_order_id=VALUES(sales_order_id), sales_order_no=VALUES(sales_order_no),
         goods_name=VALUES(goods_name), goods_image=VALUES(goods_image), sku=VALUES(sku), quantity=VALUES(quantity),
         source_url=VALUES(source_url), platform=VALUES(platform),
         purchase_price=VALUES(purchase_price), remark=VALUES(remark),
         purchase_type=VALUES(purchase_type), shipping_name=VALUES(shipping_name),
         shipping_phone=VALUES(shipping_phone), shipping_address=VALUES(shipping_address),
         account_id=VALUES(account_id),
         status='pending',
         updated_at=NOW()`,
      [purchase_no, sales_order_id||'', sales_order_no||'', goods_name||'', goods_image||'', sku||'', quantity||0,
       source_url||'', platform||'', purchase_price||0, remark||'',
       purchase_type||'dropship', shipping_name||'', shipping_phone||'', shipping_address||'', account_id||null,
       ownerId]
    )
    // 创建采购单成功后，自动更新关联销售订单的采购状态
    if (sales_order_id) {
      try {
        const purchaseStatus = purchase_type === 'warehouse' ? '已采购（仓库转发）' : '已采购（三方代发）'
        await pool.execute(
          'UPDATE sales_orders SET purchase_status=?, updated_at=NOW() WHERE id=?',
          [purchaseStatus, sales_order_id]
        )
      } catch (e) {
        console.warn('[PurchaseOrders] 更新销售订单采购状态失败(非关键):', e.message)
      }
    }

    res.json(ok({ purchase_no }))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

app.put('/api/purchase-orders/:purchaseNo/bind', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { platform_order_no } = req.body
    if (!platform_order_no) return res.json(fail('platform_order_no 不能为空'))
    await pool.execute(
      'UPDATE purchase_orders SET platform_order_no=?, status=? WHERE purchase_no=? AND owner_id=?',
      [platform_order_no, 'ordered', req.params.purchaseNo, ownerId]
    )
    res.json(ok(true))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

app.get('/api/purchase-orders', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { page=1, pageSize=20, status, platform } = req.query
    let sql = `
      SELECT po.*, pa.account as account_name
      FROM purchase_orders po
      LEFT JOIN purchase_accounts pa ON po.account_id = pa.id
      WHERE po.owner_id=?
    `
    const params = [ownerId]
    if (status) { sql += ' AND status=?'; params.push(status) }
    if (platform) { sql += ' AND platform=?'; params.push(platform) }
    
    // 正确的COUNT查询
    const countSql = `
      SELECT COUNT(*) as total
      FROM purchase_orders po
      LEFT JOIN purchase_accounts pa ON po.account_id = pa.id
      WHERE po.owner_id=?
    `
    const [[{ total }]] = await pool.execute(countSql, params)
    const limit = Math.max(1, parseInt(pageSize,10)||20)
    const offset = Math.max(0, ((parseInt(page,10)||1)-1)*limit)
    sql += ' ORDER BY id DESC LIMIT ' + limit + ' OFFSET ' + offset
    const [rows] = await pool.execute(sql, params)
    res.json(ok({ list: rows, total }))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

app.put('/api/purchase-orders/:id/status', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { status } = req.body
    await pool.execute('UPDATE purchase_orders SET status=? WHERE id=? AND owner_id=?', [status, req.params.id, ownerId])
    res.json(ok(true))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

// 更新采购订单信息（物流单号、商品信息等）
app.put('/api/purchase-orders/:id', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { sales_order_no, goods_name, sku, quantity, purchase_price, platform,
            source_url, remark, logistics_no, logistics_company, account_id } = req.body

    console.log(`[Update Purchase Order] id=${req.params.id}, account_id=${account_id}, body=${JSON.stringify(req.body)}`)

    const fields = []
    const values = []

    if (sales_order_no !== undefined) { fields.push('sales_order_no=?'); values.push(sales_order_no) }
    if (goods_name !== undefined) { fields.push('goods_name=?'); values.push(goods_name) }
    if (sku !== undefined) { fields.push('sku=?'); values.push(sku) }
    if (quantity !== undefined) { fields.push('quantity=?'); values.push(quantity) }
    if (purchase_price !== undefined) { fields.push('purchase_price=?'); values.push(purchase_price) }
    if (platform !== undefined) { fields.push('platform=?'); values.push(platform) }
    if (source_url !== undefined) { fields.push('source_url=?'); values.push(source_url) }
    if (remark !== undefined) { fields.push('remark=?'); values.push(remark) }
    if (logistics_no !== undefined) { fields.push('logistics_no=?'); values.push(logistics_no) }
    if (logistics_company !== undefined) { fields.push('logistics_company=?'); values.push(logistics_company) }
    if (account_id !== undefined) { fields.push('account_id=?'); values.push(account_id || null) }

    console.log(`[Update Purchase Order] fields=${fields.join(', ')}, values=${JSON.stringify(values)}`)

    if (!fields.length) return res.json(fail('没有要修改的字段'))

    values.push(req.params.id, ownerId)
    fields.push('updated_at=NOW()')

    const sql = `UPDATE purchase_orders SET ${fields.join(', ')} WHERE id=? AND owner_id=?`
    console.log(`[Update Purchase Order] SQL=${sql}`)
    
    const [result] = await pool.execute(sql, values)
    console.log(`[Update Purchase Order] affectedRows=${result.affectedRows}`)
    
    res.json(ok(true))
  } catch (err) { 
    console.error(`[Update Purchase Order] Error:`, err)
    res.status(500).json(fail(err.message)) 
  }
})

// 获取采购订单详情（权限校验）
app.get('/api/purchase-orders/:id', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const [rows] = await pool.execute(
      'SELECT * FROM purchase_orders WHERE id=? AND owner_id=?',
      [req.params.id, ownerId]
    )
    if (!rows.length) return res.status(404).json(fail('采购订单不存在'))
    res.json(ok(rows[0]))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

// 同步采购订单（通过平台API获取订单状态和物流信息）
app.post('/api/purchase-orders/sync', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { platform, account_id } = req.body

    console.log(`[Sync] Start sync: platform=${platform}, account_id=${account_id}, owner=${ownerId}`)

    if (!platform || !account_id) {
      return res.json(fail('platform 和 account_id 不能为空'))
    }

    // 1. 获取采购账号的Cookie
    const [cookieRows] = await pool.execute(
      'SELECT pc.cookie_data, pa.account FROM purchase_cookies pc JOIN purchase_accounts pa ON pc.account_id = pa.id WHERE pc.account_id = ? AND pa.owner_id = ?',
      [account_id, ownerId]
    )
    if (!cookieRows.length) {
      console.log(`[Sync] No cookie found for account ${account_id}`)
      return res.json(fail('采购账号未登录，请先登录该账号'))
    }

    let cookies = []
    try {
      cookies = typeof cookieRows[0].cookie_data === 'string'
        ? JSON.parse(cookieRows[0].cookie_data)
        : cookieRows[0].cookie_data
      console.log(`[Sync] Cookie loaded: ${Array.isArray(cookies) ? cookies.length : 'invalid'} items`)
    } catch (e) {
      return res.json(fail('Cookie数据格式错误'))
    }

    // 构建Cookie字符串（用于后续请求）
    const cookieStr = buildCookieString(cookies)

    // 2. 验证Cookie有效性（先调用平台API验证）
    console.log(`[Sync] Validating cookie for ${platform}...`)
    try {
      const isValid = await validatePlatformCookie(platform, cookies)
      if (!isValid) {
        console.log(`[Sync] Cookie validation failed for ${platform}`)
        // 更新账号状态为离线
        await pool.execute('UPDATE purchase_accounts SET online=0 WHERE id=?', [account_id])
        return res.json(fail('Cookie已失效，请重新登录采购账号'))
      }
      console.log(`[Sync] Cookie validation passed`)
    } catch (e) {
      console.log(`[Sync] Cookie validation error: ${e.message}`)
      // 验证失败也尝试继续（可能是验证API本身的问题）
    }

    // 3. 根据平台调用对应的API
    let purchasedOrders = []
    try {
      if (platform === 'taobao') {
        purchasedOrders = await syncTaobaoOrders(cookies)
      } else if (platform === '1688') {
        purchasedOrders = await sync1688Orders(cookies)
      } else if (platform === 'pinduoduo') {
        purchasedOrders = await syncPddOrders(cookies)
      } else {
        return res.json(fail(`暂不支持 ${platform} 平台的采购订单同步`))
      }
      console.log(`[Sync] Platform API returned ${purchasedOrders.length} orders`)
      if (purchasedOrders.length > 0) {
        console.log(`[Sync] Sample order: ${JSON.stringify(purchasedOrders[0]).substring(0, 300)}`)
      }
    } catch (e) {
      console.error(`[Sync] Platform API error: ${e.message}`)
      // 如果是Cookie失效导致的错误，更新账号状态
      if (e.message.includes('401') || e.message.includes('403') || e.message.includes('登录')) {
        await pool.execute('UPDATE purchase_accounts SET online=0 WHERE id=?', [account_id])
      }
      return res.json(fail(`同步失败: ${e.message}`))
    }

    // 4. 获取本地已绑定的采购订单列表
    const [localOrders] = await pool.execute(
      'SELECT id, purchase_no, platform_order_no, platform, status FROM purchase_orders WHERE owner_id=? AND platform_order_no IS NOT NULL AND platform_order_no != ?',
      [ownerId, '']
    )
    console.log(`[Sync] Local bound orders: ${localOrders.length}`)
    if (localOrders.length === 0) {
      return res.json(ok({ matched_count: 0, total_platform: purchasedOrders.length, message: '本地暂无已绑定平台订单号的采购订单，请先通过采购下单功能绑定订单' }))
    }

    // 打印本地订单的平台订单号用于调试
    console.log(`[Sync] Local platform_order_nos:`, localOrders.map(lo => lo.platform_order_no))
    console.log(`[Sync] Platform order_nos:`, purchasedOrders.map(po => po.order_no))

    // 5. 匹配平台订单并同步状态
    let matchedCount = 0
    // 订单状态映射表
    const statusMap = {
      '卖家已发货': 'shipped',
      '已发货': 'shipped',
      '已签收': 'received',
      '交易成功': 'received',
      '运输中': 'in_transit',
      '派送中': 'in_transit',
      '已成交': 'completed',
      '已取消': 'cancelled',
      '退款成功': 'refunded'
    }

    for (const platformOrder of purchasedOrders) {
      // 匹配本地订单
      const localOrder = localOrders.find(lo => lo.platform_order_no === platformOrder.order_no)
      if (!localOrder) continue

      matchedCount++
      const newStatus = statusMap[platformOrder.status] || localOrder.status

      // 更新订单状态和account_id
      if (newStatus !== localOrder.status || !localOrder.account_id) {
        await pool.execute(
          'UPDATE purchase_orders SET status=?, account_id=? WHERE id=?',
          [newStatus, account_id, localOrder.id]
        )
        console.log(`[Sync] Updated order ${localOrder.purchase_no}: ${localOrder.status} -> ${newStatus}, account_id=${account_id}`)
      }

      // 如果物流信息存在，也同步更新
      if (platformOrder.logistics_no) {
        await pool.execute(
          'UPDATE purchase_orders SET logistics_no=?, logistics_company=? WHERE id=?',
          [platformOrder.logistics_no || null, platformOrder.logistics_company || null, localOrder.id]
        )
        console.log(`[Sync] Updated logistics for order ${localOrder.purchase_no}: ${platformOrder.logistics_no}`)
      }

      // 如果订单已发货但物流信息为空，抓取物流页面获取单号
      if ((newStatus === 'shipped' || newStatus === 'in_transit') && !localOrder.logistics_no) {
        try {
          const logistics = await fetchTaobaoLogistics(platformOrder.order_no, cookieStr)
          if (logistics && logistics.logistics_no) {
            await pool.execute(
              'UPDATE purchase_orders SET logistics_no=?, logistics_company=? WHERE id=?',
              [logistics.logistics_no || null, logistics.logistics_company || null, localOrder.id]
            )
            console.log(`[Sync] Fetched logistics for order ${localOrder.purchase_no}: ${logistics.logistics_no} (${logistics.logistics_company})`)
          }
        } catch (e) {
          console.log(`[Sync] Logistics fetch failed for order ${platformOrder.order_no}: ${e.message}`)
        }
      }
    }

    console.log(`[Sync] Sync completed: matched ${matchedCount} orders`)
    res.json(ok({ matched_count: matchedCount, total_platform: purchasedOrders.length }))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

// 同步单个采购订单（通过平台订单号精确查询）
app.post('/api/purchase-orders/sync-single', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { platform, account_id, platform_order_no } = req.body

    console.log(`[Sync-Single] Start: platform=${platform}, order_no=${platform_order_no}, account_id=${account_id}`)

    if (!platform || !platform_order_no || !account_id) {
      return res.json(fail('platform、platform_order_no 和 account_id 不能为空'))
    }

    // 获取Cookie
    const [cookieRows] = await pool.execute(
      'SELECT pc.cookie_data, pa.account FROM purchase_cookies pc JOIN purchase_accounts pa ON pc.account_id = pa.id WHERE pc.account_id = ? AND pa.owner_id = ?',
      [account_id, ownerId]
    )
    if (!cookieRows.length) {
      return res.json(fail('采购账号未登录，请先登录该账号'))
    }

    let cookies = []
    try {
      cookies = typeof cookieRows[0].cookie_data === 'string'
        ? JSON.parse(cookieRows[0].cookie_data)
        : cookieRows[0].cookie_data
    } catch (e) {
      return res.json(fail('Cookie数据格式错误'))
    }

    console.log(`[Sync-Single] Loaded ${cookies.length} cookies`)

    const cookieStr = buildCookieString(cookies)

    // 验证Cookie有效性
    try {
      const isValid = await validatePlatformCookie(platform, cookies)
      if (!isValid) {
        console.log(`[Sync-Single] Cookie validation failed`)
        await pool.execute('UPDATE purchase_accounts SET online=0 WHERE id=?', [account_id])
        return res.json(fail('Cookie已失效，请重新登录采购账号'))
      }
      console.log(`[Sync-Single] Cookie validation passed`)
    } catch (e) {
      console.log(`[Sync-Single] Cookie validation error: ${e.message}`)
      // 验证失败也尝试继续
    }

    // 调用平台API查询指定订单
    let orderInfo = null
    try {
      if (platform === 'taobao') {
        orderInfo = await queryTaobaoOrderByNo(cookies, platform_order_no, {
          onCookiesRefreshed: async (updatedCookies) => {
            // 刷新成功后回写 cookie 到数据库，供后续请求使用
            try {
              await pool.execute(
                'UPDATE purchase_cookies SET cookie_data=?, saved_at=NOW() WHERE account_id=?',
                [JSON.stringify(updatedCookies), account_id]
              )
              console.log(`[Sync-Single] Refreshed cookies saved to DB for account ${account_id}`)
            } catch (dbErr) {
              console.error(`[Sync-Single] Failed to save refreshed cookies: ${dbErr.message}`)
            }
          }
        })
      } else if (platform === '1688') {
        orderInfo = await query1688OrderByNo(cookies, platform_order_no)
      } else if (platform === 'pinduoduo') {
        orderInfo = await queryPddOrderByNo(cookies, platform_order_no)
      } else {
        return res.json(fail(`暂不支持 ${platform} 平台`))
      }
    } catch (e) {
      console.error(`[Sync-Single] Platform API error: ${e.message}`)
      // 检测 SESSION_EXPIRED：标记账号下线，返回特定错误码通知前端
      if (e.code === 'SESSION_EXPIRED' || e.message.includes('会话已过期')) {
        await pool.execute('UPDATE purchase_accounts SET online=0 WHERE id=?', [account_id])
        console.log(`[Sync-Single] Account ${account_id} marked offline due to session expiry`)
        return res.json({ code: 2, message: '淘宝会话已过期，请重新登录采购账号', needsRelogin: true })
      }
      return res.json(fail(`查询失败: ${e.message}`))
    }

    if (!orderInfo) {
      return res.json(fail('未找到该订单'))
    }

    console.log(`[Sync-Single] Found order:`, JSON.stringify(orderInfo))

    // 更新本地数据库
    const statusMap = {
      '等待买家付款': 'pending',
      '买家已付款': 'pending',
      '待发货': 'pending',
      '待收货': 'shipped',
      '卖家已发货': 'shipped',
      '已发货': 'shipped',
      '已签收': 'received',
      '交易成功': 'received',
      '运输中': 'in_transit',
      '派送中': 'in_transit',
      '已成交': 'completed',
      '交易关闭': 'cancelled',
      '已取消': 'cancelled',
      '退款成功': 'refunded',
      '退款中': 'refunded'
    }

    const newStatus = statusMap[orderInfo.status] || null

    // 查找本地采购订单
    const [localOrders] = await pool.execute(
      'SELECT id, purchase_no, status, logistics_no, logistics_company FROM purchase_orders WHERE owner_id=? AND platform_order_no=?',
      [ownerId, platform_order_no]
    )

    if (localOrders.length === 0) {
      return res.json(fail('本地未找到对应的采购订单'))
    }

    const localOrder = localOrders[0]

    // 更新状态和account_id
    const updateFields = []
    const updateValues = []

    if (newStatus && newStatus !== localOrder.status) {
      updateFields.push('status=?')
      updateValues.push(newStatus)
      console.log(`[Sync-Single] Updated status: ${localOrder.status} -> ${newStatus}`)
    }

    // 始终设置account_id（即使已存在）
    updateFields.push('account_id=?')
    updateValues.push(account_id)

    // 更新物流信息（仅更新有值的字段，避免 null 覆盖已有数据）
    if (orderInfo.logistics_no) {
      updateFields.push('logistics_no=?')
      updateValues.push(orderInfo.logistics_no)
      console.log(`[Sync-Single] Updated logistics_no: ${orderInfo.logistics_no}`)
    }
    if (orderInfo.logistics_company) {
      updateFields.push('logistics_company=?')
      updateValues.push(orderInfo.logistics_company)
      console.log(`[Sync-Single] Updated logistics_company: ${orderInfo.logistics_company}`)
    }

    if (updateFields.length > 0) {
      updateValues.push(localOrder.id)
      await pool.execute(
        `UPDATE purchase_orders SET ${updateFields.join(', ')} WHERE id=?`,
        updateValues
      )
    }

    res.json(ok({
      status: newStatus || localOrder.status,
      logistics_no: orderInfo.logistics_no || localOrder.logistics_no,
      logistics_company: orderInfo.logistics_company || localOrder.logistics_company,
      logistics_status: orderInfo.logistics_status || ''
    }))
  } catch (err) {
    console.error(`[Sync-Single] Error: ${err.message}`)
    res.status(500).json(fail(err.message))
  }
})

// 浏览器方案同步 - 单个订单更新端点
// 接收 Electron 主进程从浏览器窗口捕获的订单数据，更新数据库
app.post('/api/purchase-orders/browser-sync-update', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { account_id, platform, platform_order_no, order_info } = req.body

    console.log(`[Browser-Sync-Update] account_id=${account_id}, order_no=${platform_order_no}, platform=${platform}`)

    if (!account_id || !platform || !platform_order_no || !order_info) {
      return res.json(fail('参数不完整'))
    }

    // 订单状态映射表
    const statusMap = {
      '等待买家付款': 'pending',
      '买家已付款': 'pending',
      '待发货': 'pending',
      '待收货': 'shipped',
      '卖家已发货': 'shipped',
      '已发货': 'shipped',
      '已签收': 'received',
      '交易成功': 'received',
      '运输中': 'in_transit',
      '派送中': 'in_transit',
      '已成交': 'completed',
      '交易关闭': 'cancelled',
      '已取消': 'cancelled',
      '退款成功': 'refunded',
      '退款中': 'refunded'
    }

    const newStatus = statusMap[order_info.status] || null

    // 查找本地采购订单
    const [localOrders] = await pool.execute(
      'SELECT id, purchase_no, status, logistics_no, logistics_company FROM purchase_orders WHERE owner_id=? AND platform_order_no=?',
      [ownerId, platform_order_no]
    )

    if (localOrders.length === 0) {
      return res.json(fail('本地未找到对应的采购订单'))
    }

    const localOrder = localOrders[0]

    // 更新状态和物流信息
    const updateFields = []
    const updateValues = []

    if (newStatus && newStatus !== localOrder.status) {
      updateFields.push('status=?')
      updateValues.push(newStatus)
      console.log(`[Browser-Sync-Update] 状态更新: ${localOrder.status} -> ${newStatus}`)
    }

    // 始终设置 account_id
    updateFields.push('account_id=?')
    updateValues.push(account_id)

    // 更新物流信息（仅更新有值的字段，避免 null 覆盖已有数据）
    if (order_info.logistics_no) {
      updateFields.push('logistics_no=?')
      updateValues.push(order_info.logistics_no)
      console.log(`[Browser-Sync-Update] 物流单号: ${order_info.logistics_no}`)
    }
    if (order_info.logistics_company) {
      updateFields.push('logistics_company=?')
      updateValues.push(order_info.logistics_company)
      console.log(`[Browser-Sync-Update] 物流公司: ${order_info.logistics_company}`)
    }

    if (updateFields.length > 0) {
      updateValues.push(localOrder.id)
      await pool.execute(
        `UPDATE purchase_orders SET ${updateFields.join(', ')} WHERE id=?`,
        updateValues
      )
    }

    res.json(ok({
      status: newStatus || localOrder.status,
      logistics_no: order_info.logistics_no || localOrder.logistics_no,
      logistics_company: order_info.logistics_company || localOrder.logistics_company,
      logistics_status: order_info.logistics_status || ''
    }))
  } catch (err) {
    console.error(`[Browser-Sync-Update] Error: ${err.message}`)
    res.status(500).json(fail(err.message))
  }
})

// 浏览器方案同步 - 批量订单更新端点
// 接收 Electron 主进程从浏览器窗口捕获的全部订单，匹配并更新数据库
app.post('/api/purchase-orders/browser-sync-batch', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { account_id, platform, orders } = req.body

    console.log(`[Browser-Sync-Batch] account_id=${account_id}, platform=${platform}, orders=${orders?.length || 0}`)

    if (!account_id || !platform || !orders || !Array.isArray(orders)) {
      return res.json(fail('参数不完整'))
    }

    // 获取本地已绑定的采购订单
    const [localOrders] = await pool.execute(
      'SELECT id, purchase_no, platform_order_no, platform, status, logistics_no, logistics_company FROM purchase_orders WHERE owner_id=? AND platform_order_no IS NOT NULL AND platform_order_no != ?',
      [ownerId, '']
    )

    if (localOrders.length === 0) {
      return res.json(ok({ matched_count: 0, total_platform: orders.length, message: '本地暂无已绑定平台订单号的采购订单' }))
    }

    // 订单状态映射
    const statusMap = {
      '等待买家付款': 'pending',
      '买家已付款': 'pending',
      '待发货': 'pending',
      '待收货': 'shipped',
      '卖家已发货': 'shipped',
      '已发货': 'shipped',
      '已签收': 'received',
      '交易成功': 'received',
      '运输中': 'in_transit',
      '派送中': 'in_transit',
      '已成交': 'completed',
      '交易关闭': 'cancelled',
      '已取消': 'cancelled',
      '退款成功': 'refunded',
      '退款中': 'refunded'
    }

    let matchedCount = 0

    for (const platformOrder of orders) {
      const localOrder = localOrders.find(lo => lo.platform_order_no === platformOrder.order_no)
      if (!localOrder) continue

      matchedCount++
      const newStatus = statusMap[platformOrder.status] || localOrder.status

      const updateFields = []
      const updateValues = []

      if (newStatus !== localOrder.status || !localOrder.account_id) {
        updateFields.push('status=?')
        updateValues.push(newStatus)
      }

      updateFields.push('account_id=?')
      updateValues.push(account_id)

      if (platformOrder.logistics_no) {
        updateFields.push('logistics_no=?')
        updateValues.push(platformOrder.logistics_no)
      }
      if (platformOrder.logistics_company) {
        updateFields.push('logistics_company=?')
        updateValues.push(platformOrder.logistics_company)
      }

      if (updateFields.length > 0) {
        updateValues.push(localOrder.id)
        await pool.execute(
          `UPDATE purchase_orders SET ${updateFields.join(', ')} WHERE id=?`,
          updateValues
        )
        console.log(`[Browser-Sync-Batch] 更新订单 ${localOrder.purchase_no}: status=${newStatus}, logistics=${platformOrder.logistics_no || '无'}`)
      }
    }

    console.log(`[Browser-Sync-Batch] 完成: 匹配 ${matchedCount} 条`)
    res.json(ok({ matched_count: matchedCount, total_platform: orders.length }))
  } catch (err) {
    console.error(`[Browser-Sync-Batch] Error: ${err.message}`)
    res.status(500).json(fail(err.message))
  }
})

// ============ 物流公司代码映射表 ============
const CP_CODE_MAP = {
  'YUNDA': '韵达快递', 'ZTO': '中通快递', 'STO': '申通快递', 'SF': '顺丰速运',
  'YTO': '圆通速递', 'HTKY': '百世快递', 'JD': '京东物流', 'EMS': 'EMS',
  'DBL': '德邦快递', 'YZPY': '邮政快递包裹', 'JD_VD': '京东快运',
  'ANE': '安能物流', 'XBWL': '新邦物流', 'FAST': '快捷快递',
  'QFKD': '全峰快递', 'DB': '德邦物流', 'RDB': '德邦快运',
  'ZJS': '宅急送', 'TTKDY': '天天快递', 'UC': '优速快递',
  'SNWL': '苏宁物流', 'PFCNE': '品骏快递', 'JDWL': '京东快递',
  'HHT': '天天快递', 'GZL': '广州物流', 'CNPL': '菜鸟直送',
  'CAINIAO': '菜鸟裹裹', 'BNQD': '百世快运', 'YZSAM': '邮政标准快递'
}

/**
 * 根据 cpCode 获取物流公司名称
 * 优先使用 API 返回的 cpName，为空时用 cpCode 映射兜底
 */
function resolveLogisticsCompany(cpName, cpCode) {
  if (cpName && cpName.trim()) return cpName.trim()
  if (cpCode && CP_CODE_MAP[cpCode.toUpperCase()]) return CP_CODE_MAP[cpCode.toUpperCase()]
  return cpName || ''
}

// ============ 平台订单同步函数 ============

/**
 * 同步淘宝/天猫订单
 * 使用 H5 API: mtop.taobao.order.queryboughtlistV2
 */
async function syncTaobaoOrders(cookies) {
  const https = require('https')
  const crypto = require('crypto')
  
  // 淘宝H5 API只需要关键Cookie,避免请求头过大(HTTP 431错误)
  // 只保留必需的Cookie字段
  const requiredCookies = ['_m_h5_tk', '_m_h5_tk_enc', 'cookie2', 't', 'sgcookie', 'enc', 'existShop', 'lgc', 'dnk', 'cna', 'tracknick', '_tb_token_', 'thw', 'hng']
  let essentialCookies = []
  
  if (Array.isArray(cookies)) {
    essentialCookies = cookies.filter(c => requiredCookies.includes(c.name))
    console.log(`[Sync] Filtered cookies: ${cookies.length} -> ${essentialCookies.length}`)
  }
  
  const cookieStr = buildCookieString(essentialCookies)
  console.log(`[Sync] Cookie string length: ${cookieStr.length} bytes`)

  // 构建请求数据（正确的格式，与浏览器一致）
  const dataObj = {
    tabCode: "all",
    page: 1,
    OrderType: "OrderSearch",
    appName: "tborder",
    appVersion: "3.0",
    condition: JSON.stringify({
      directRouteToTm2Scene: "1",
      wordType: "0",
      wordTerm: "",
      showText: "",
      itemTitle: "",
      orderFilterExtParam: "{}"
    })
  }

  const dataStr = JSON.stringify(dataObj)
  const timestamp = Date.now()
  // 淘宝H5 API签名使用的时间戳需要除以60000取整（防重放攻击）
  const signTimestamp = Math.floor(timestamp / 60000)

  // 从Cookie中提取token用于签名
  const tokenMatch = cookieStr.match(/_m_h5_tk=([^;]+)/)
  const token = tokenMatch ? tokenMatch[1].split('_')[0] : ''

  // 生成签名: MD5(token&signTimestamp&appKey&data)
  const signStr = `${token}&${signTimestamp}&12574478&${dataStr}`
  const sign = crypto.createHash('md5').update(signStr).digest('hex')

  console.log(`[Sync] Token: ${token}, SignTimestamp: ${signTimestamp}, Sign: ${sign}`)

  // 构建URL参数（与浏览器抓包一致）
  const params = new URLSearchParams({
    jsv: '2.7.2',
    appKey: '12574478',
    t: timestamp.toString(),
    sign: sign,
    v: '1.0',
    ecode: '1',
    timeout: '8000',
    dataType: 'json',
    valueType: 'original',
    ttid: '1@tbwang_windows_1.0.0#pc',
    needLogin: 'true',
    type: 'originaljson',
    isHttps: '1',
    needRetry: 'true',
    api: 'mtop.taobao.order.queryboughtlistV2',
    preventFallback: 'true',
    data: dataStr
  })

  const postData = `data=${encodeURIComponent(dataStr)}`

  const options = {
    hostname: 'h5api.m.taobao.com',
    path: `/h5/mtop.taobao.order.queryboughtlistv2/1.0/?${params.toString()}`,
    method: 'POST',
    headers: {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Referer': 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
      'Content-Length': Buffer.byteLength(postData),
      'Origin': 'https://buyertrade.taobao.com'
    }
  }

  console.log('[Sync] Calling Taobao H5 API: mtop.taobao.order.queryboughtlistV2')

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          console.log('[Sync] Taobao H5 API response status:', res.statusCode)
          console.log('[Sync] Response sample:', data.substring(0, 500))
          
          // 检查是否是HTML错误页面
          if (data.trim().startsWith('<') || data.includes('Cannot pro')) {
            console.error('[Sync] Received HTML response instead of JSON')
            console.error('[Sync] HTML response preview:', data.substring(0, 1000))
            console.error('[Sync] Request URL:', options.hostname + options.path)
            console.error('[Sync] Response headers:', JSON.stringify(res.headers))
            reject(new Error('淘宝API返回错误页面，Cookie可能已失效'))
            return
          }
          
          const orders = parseTaobaoH5Response(data)
          console.log('[Sync] Parsed orders count:', orders.length)
          resolve(orders)
        } catch (e) {
          reject(new Error(`淘宝订单解析失败: ${e.message}`))
        }
      })
    })
    req.on('error', (e) => {
      console.error('[Sync] Request error:', e.message)
      reject(e)
    })
    req.setTimeout(15000, () => { 
      req.destroy()
      reject(new Error('请求超时')) 
    })
    req.write(postData)
    req.end()
  })
}

/**
 * 解析淘宝H5 API响应（mtop.taobao.order.queryboughtlistv2）
 * 根据抓包数据：淘宝返回组件化布局结构
 * - shopInfo_* - 店铺信息（包含订单ID、tradeTitle订单状态）
 * - orderStatus_* - 订单状态（包含mailNo物流单号、cpCode物流代码、title/subTitle物流状态）
 * - orderLogistics_* - 物流详情（包含packagePreview.packageViewList[].cpName物流公司名称）
 */
function parseTaobaoH5Response(responseText) {
  const orders = []
  try {
    const response = JSON.parse(responseText)
    console.log('[Sync] H5 API response structure:', Object.keys(response))
    
    if (response.ret && response.ret[0] !== 'SUCCESS::调用成功') {
      console.error('[Sync] H5 API error:', response.ret)
      return orders
    }
    
    if (!response.data) {
      console.log('[Sync] No data in H5 API response')
      return orders
    }
    
    let data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    // 处理嵌套 data.data 结构（部分API响应格式: { data: { data: { shopInfo_...: ... }, ret: [...] } }）
    // 检查 data 中是否有任何以 shopInfo_ 或 orderStatus_ 开头的键（前缀匹配，避免误判 shopInfo_12345 等动态键）
    const hasShopInfoKey = Object.keys(data).some(k => k.startsWith('shopInfo_'))
    const hasOrderStatusKey = Object.keys(data).some(k => k.startsWith('orderStatus_'))
    if (data && data.data && typeof data.data === 'object' && !hasShopInfoKey && !hasOrderStatusKey) {
      console.log('[Sync] Detected nested data.data structure, unwrapping...')
      data = data.data
    }
    console.log('[Sync] Data keys:', Object.keys(data))
    
    // 组件化布局：遍历所有组件，按订单ID聚合信息
    const orderMap = {}
    
    for (const [key, component] of Object.entries(data)) {
      if (!component || typeof component !== 'object') continue
      
      // shopInfo_* 组件：提取订单ID和订单状态
      if (key.startsWith('shopInfo_')) {
        const orderId = component.id
        if (!orderId) continue
        
        if (!orderMap[orderId]) {
          orderMap[orderId] = { order_no: orderId }
        }
        
        // 提取订单状态（tradeTitle字段，如"卖家已发货"）
        if (component.fields && component.fields.tradeTitle) {
          orderMap[orderId].status = component.fields.tradeTitle
        }
      }
      
      // orderStatus_* 组件：提取物流单号和物流状态
      if (key.startsWith('orderStatus_')) {
        const orderId = component.id
        if (!orderId) continue
        
        if (!orderMap[orderId]) {
          orderMap[orderId] = { order_no: orderId }
        }
        
        const fields = component.fields || {}
        
        // 物流单号（在 fields 里面）
        if (fields.mailNo) {
          orderMap[orderId].logistics_no = fields.mailNo
        }
        
        // 物流公司代码
        if (fields.cpCode) {
          orderMap[orderId].logistics_company_code = fields.cpCode
        }
        
        // 物流状态标题（如"运输中"）
        if (fields.title) {
          orderMap[orderId].logistics_status = fields.title
        }
      }
      
      // orderLogistics_* 组件：提取物流公司名称
      if (key.startsWith('orderLogistics_')) {
        const orderId = component.id
        if (!orderId) continue
        
        if (!orderMap[orderId]) {
          orderMap[orderId] = { order_no: orderId }
        }
        
        // 物流公司名称：从fields.packagePreview.packageViewList[0].cpName提取
        const fields = component.fields || {}
        if (fields.packagePreview && fields.packagePreview.packageViewList && fields.packagePreview.packageViewList.length > 0) {
          orderMap[orderId].logistics_company = fields.packagePreview.packageViewList[0].cpName
        }
      }
    }
    
    // 转换为数组，用 cpCode 兜底 logistics_company
    for (const orderId of Object.keys(orderMap)) {
      const order = orderMap[orderId]
      if (order.order_no) {
        orders.push({
          order_no: order.order_no,
          status: order.status || '',
          logistics_no: order.logistics_no || '',
          logistics_company: resolveLogisticsCompany(order.logistics_company || '', order.logistics_company_code || ''),
          logistics_company_code: order.logistics_company_code || '',
          logistics_status: order.logistics_status || ''
        })
      }
    }
    
    console.log('[Sync] Parsed orders count:', orders.length)
    if (orders.length > 0) {
      console.log('[Sync] Sample order:', JSON.stringify(orders[0]))
    }
    
  } catch (e) {
    console.error('[Sync] H5 API parse error:', e.message)
    console.error('[Sync] Stack:', e.stack)
  }
  
  return orders
}

/**
 * 按订单号查询淘宝订单
 */
/**
 * 按订单号查询淘宝订单
 * @param {Array} cookies - cookie数组
 * @param {string} orderNo - 订单号
 * @param {Object} [options] - 可选参数
 * @param {Function} [options.onCookiesRefreshed] - cookie刷新回调，参数为更新后的cookie数组
 */
async function queryTaobaoOrderByNo(cookies, orderNo, { onCookiesRefreshed } = {}) {
  const https = require('https')
  const crypto = require('crypto')
  
  // 淘宝H5 API只需要关键Cookie,避免请求头过大(HTTP 431错误)
  const requiredCookies = ['_m_h5_tk', '_m_h5_tk_enc', 'cookie2', 't', 'sgcookie', 'enc', 'existShop', 'lgc', 'dnk', 'cna', 'tracknick', '_tb_token_', 'thw', 'hng']
  let essentialCookies = []
  
  if (Array.isArray(cookies)) {
    essentialCookies = cookies.filter(c => requiredCookies.includes(c.name))
    console.log(`[Query-Taobao] Filtered cookies: ${cookies.length} -> ${essentialCookies.length}`)
  }
  
  const cookieStr = buildCookieString(essentialCookies)
  console.log(`[Query-Taobao] Cookie string length: ${cookieStr.length} bytes`)

  console.log(`[Query-Taobao] Querying order: ${orderNo}`)

  // 构建请求数据 - 使用订单号搜索
  const dataObj = {
    tabCode: "all",
    page: 1,
    OrderType: "OrderSearch",
    appName: "tborder",
    appVersion: "3.0",
    condition: JSON.stringify({
      directRouteToTm2Scene: "1",
      wordType: "3",  // 3表示搜索
      wordTerm: orderNo,
      showText: orderNo,
      itemTitle: orderNo,
      orderFilterExtParam: "{}"
    }),
    __needlessClearProtocol__: true
  }

  const dataStr = JSON.stringify(dataObj)
  const timestamp = Date.now()
  // 淘宝H5 API签名使用的时间戳需要除以60000取整（防重放攻击）
  const signTimestamp = Math.floor(timestamp / 60000)

  // 从Cookie中提取token
  const tokenMatch = cookieStr.match(/_m_h5_tk=([^;]+)/)
  const token = tokenMatch ? tokenMatch[1].split('_')[0] : ''

  // 生成签名
  const signStr = `${token}&${signTimestamp}&12574478&${dataStr}`
  const sign = crypto.createHash('md5').update(signStr).digest('hex')
  
  console.log(`[Query-Taobao] Token: ${token}, SignTimestamp: ${signTimestamp}`)

  const params = new URLSearchParams({
    jsv: '2.7.2',
    appKey: '12574478',
    t: timestamp.toString(),
    sign: sign,
    v: '1.0',
    ecode: '1',
    timeout: '8000',
    dataType: 'json',
    valueType: 'original',
    ttid: '1@tbwang_windows_1.0.0#pc',
    needLogin: 'true',
    type: 'originaljson',
    isHttps: '1',
    needRetry: 'true',
    api: 'mtop.taobao.order.queryboughtlistV2',
    __customTag__: 'boughtList_all_OrderSearch',
    preventFallback: 'true'
  })

  const postData = `data=${encodeURIComponent(dataStr)}`

  const options = {
    hostname: 'h5api.m.taobao.com',
    path: `/h5/mtop.taobao.order.queryboughtlistv2/1.0/?${params.toString()}`,
    method: 'POST',
    headers: {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Referer': 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
      'Content-Length': Buffer.byteLength(postData),
      'Origin': 'https://buyertrade.taobao.com'
    }
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', async () => {
        try {
          console.log(`[Query-Taobao] Response status: ${res.statusCode}`)
          console.log(`[Query-Taobao] Response headers:`, JSON.stringify(res.headers).substring(0, 300))
          console.log(`[Query-Taobao] Response sample:`, data.substring(0, 500))

          // 检查是否是HTML错误页面
          if (data.trim().startsWith('<') || data.includes('Cannot pro')) {
            console.error(`[Query-Taobao] Received HTML response instead of JSON`)
            console.error(`[Query-Taobao] Response status: ${res.statusCode}`)
            console.error(`[Query-Taobao] HTML content (first 2000 chars):`, data.substring(0, 2000))
            
            // 保存错误响应到文件供调试
            const fs = require('fs')
            const errorFile = `taobao-error-${Date.now()}.html`
            try {
              fs.writeFileSync(errorFile, data.substring(0, 5000))
              console.error(`[Query-Taobao] Error saved to: C:\\dianxiaoer-server\\${errorFile}`)
            } catch(e) {}
            
            reject(new Error(`淘宝API返回错误页面(HTTP ${res.statusCode})，错误详情已保存到服务器文件`))
            return
          }
          
          const response = JSON.parse(data)
          console.log(`[Query-Taobao] API response ret:`, response.ret)
          console.log(`[Query-Taobao] response.data type: ${typeof response.data}, keys: ${response.data ? Object.keys(response.data).join(',') : 'N/A'}`)

          if (response.ret && response.ret[0] === 'SUCCESS::调用成功') {
            // 解析订单数据
            const orders = parseTaobaoH5Response(data)
            console.log(`[Query-Taobao] Parsed ${orders.length} orders, searching for orderNo=${orderNo}`)
            if (orders.length > 0) {
              console.log(`[Query-Taobao] Order numbers found:`, orders.map(o => o.order_no))
              // 查找匹配的订单
              const order = orders.find(o => o.order_no === orderNo || o.order_no === String(orderNo))
              if (order) {
                console.log(`[Query-Taobao] Found matching order:`, JSON.stringify(order))
                resolve(order)
              } else {
                console.log(`[Query-Taobao] No order matched orderNo=${orderNo}`)
                resolve(null)
              }
            } else {
              console.log(`[Query-Taobao] No orders parsed from API response`)
              resolve(null)
            }
          } else if (response.ret && response.ret[0] && response.ret[0].includes('SESSION_EXPIRED')) {
            // Token过期处理：多层刷新策略
            console.log(`[Query-Taobao] Session expired, starting token refresh flow...`)

            // 第一步：尝试从当前响应的 Set-Cookie 提取新 token
            const setCookies = res.headers['set-cookie'] || []
            let newTk = ''
            let newTkEnc = ''
            for (const sc of setCookies) {
              const tkMatch = sc.match(/_m_h5_tk=([^;]+)/)
              if (tkMatch) newTk = tkMatch[1]
              const tkEncMatch = sc.match(/_m_h5_tk_enc=([^;]+)/)
              if (tkEncMatch) newTkEnc = tkEncMatch[1]
            }

            // 第二步：如果 Set-Cookie 没有新 token，通过 warmup 请求刷新
            if (!newTk) {
              console.log(`[Query-Taobao] No token in Set-Cookie, trying warmup refresh...`)
              const refreshResult = await refreshTaobaoH5Token(cookies)
              if (refreshResult.success) {
                newTk = refreshResult.newTk
                newTkEnc = refreshResult.newTkEnc
              }
            }

            // 第三步：有新 token → 重建签名 + 更新 cookie + 重试
            if (newTk) {
              console.log(`[Query-Taobao] Got refreshed token, rebuilding request and retrying...`)

              // 通知调用方更新数据库中的 cookie
              if (onCookiesRefreshed) {
                try {
                  const updatedCookies = updateCookiesWithNewToken(cookies, newTk, newTkEnc)
                  await onCookiesRefreshed(updatedCookies)
                  console.log(`[Query-Taobao] Cookies updated in database via callback`)
                } catch (cbErr) {
                  console.error(`[Query-Taobao] Cookie update callback error: ${cbErr.message}`)
                }
              }

              // 用新 token 重建签名并重试
              const retryTimestamp = Date.now()
              const retrySignTs = Math.floor(retryTimestamp / 60000)
              const retryToken = newTk.split('_')[0]
              const retrySignStr = `${retryToken}&${retrySignTs}&12574478&${dataStr}`
              const retrySign = crypto.createHash('md5').update(retrySignStr).digest('hex')

              // 更新 cookie 字符串中的 _m_h5_tk
              let retryCookieStr = cookieStr
              retryCookieStr = retryCookieStr.replace(/_m_h5_tk=[^;]+/, `_m_h5_tk=${newTk}`)
              if (newTkEnc) {
                retryCookieStr = retryCookieStr.replace(/_m_h5_tk_enc=[^;]+/, `_m_h5_tk_enc=${newTkEnc}`)
              }

              const retryParams = new URLSearchParams({
                jsv: '2.7.2', appKey: '12574478', t: retryTimestamp.toString(),
                sign: retrySign, v: '1.0', ecode: '1', timeout: '8000',
                dataType: 'json', valueType: 'original',
                ttid: '1@tbwang_windows_1.0.0#pc', needLogin: 'true',
                type: 'originaljson', isHttps: '1', needRetry: 'true',
                api: 'mtop.taobao.order.queryboughtlistV2',
                __customTag__: 'boughtList_all_OrderSearch', preventFallback: 'true'
              })

              const retryOptions = {
                hostname: 'h5api.m.taobao.com',
                path: `/h5/mtop.taobao.order.queryboughtlistv2/1.0/?${retryParams.toString()}`,
                method: 'POST',
                headers: {
                  'Cookie': retryCookieStr,
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Accept': 'application/json',
                  'Referer': 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
                  'Content-Length': Buffer.byteLength(postData),
                  'Origin': 'https://buyertrade.taobao.com'
                }
              }

              const retryReq = https.request(retryOptions, (retryRes) => {
                let retryData = ''
                retryRes.on('data', chunk => { retryData += chunk })
                retryRes.on('end', () => {
                  try {
                    console.log(`[Query-Taobao] Retry response:`, retryData.substring(0, 500))
                    const retryResponse = JSON.parse(retryData)
                    if (retryResponse.ret && retryResponse.ret[0] === 'SUCCESS::调用成功') {
                      const orders = parseTaobaoH5Response(retryData)
                      console.log(`[Query-Taobao] Retry parsed ${orders.length} orders, searching for orderNo=${orderNo}`)
                      if (orders.length > 0) {
                        console.log(`[Query-Taobao] Retry order numbers:`, orders.map(o => o.order_no))
                      }
                      const order = orders.find(o => o.order_no === orderNo || o.order_no === String(orderNo))
                      if (order) {
                        console.log(`[Query-Taobao] Retry found matching order:`, JSON.stringify(order))
                      }
                      resolve(order || null)
                    } else if (retryResponse.ret && retryResponse.ret[0] && retryResponse.ret[0].includes('SESSION_EXPIRED')) {
                      // 重试后仍然 SESSION_EXPIRED — 主会话 cookie 已过期
                      console.log(`[Query-Taobao] Retry also returned SESSION_EXPIRED - main session expired`)
                      const err = new Error('淘宝会话已过期，请重新登录采购账号')
                      err.code = 'SESSION_EXPIRED'
                      reject(err)
                    } else {
                      reject(new Error(retryResponse.ret ? retryResponse.ret.join(', ') : '重试后仍然失败'))
                    }
                  } catch (e) {
                    reject(new Error(`重试响应解析失败: ${e.message}`))
                  }
                })
              })
              retryReq.on('error', reject)
              retryReq.setTimeout(15000, () => { retryReq.destroy(); reject(new Error('重试请求超时')) })
              retryReq.write(postData)
              retryReq.end()
            } else {
              // 第四步：无法刷新 token — 主会话 cookie 已过期，需要用户重新登录
              console.log(`[Query-Taobao] Token refresh failed - main session cookies expired`)
              const err = new Error('淘宝会话已过期，请重新登录采购账号')
              err.code = 'SESSION_EXPIRED'
              reject(err)
            }
          } else {
            const errorMsg = response.ret ? response.ret.join(', ') : 'API调用失败'
            console.error(`[Query-Taobao] API error:`, errorMsg)
            reject(new Error(errorMsg))
          }
        } catch (e) {
          console.error(`[Query-Taobao] Parse error:`, e.message)
          console.error(`[Query-Taobao] Raw response:`, data.substring(0, 500))
          reject(new Error(`响应解析失败: ${e.message}`))
        }
      })
    })

    req.on('error', reject)
    req.setTimeout(15000, () => {
      req.destroy()
      reject(new Error('请求超时'))
    })

    req.write(postData)
    req.end()
  })
}

/**
 * 解析单个淘宝H5订单数据
 */
function parseTaobaoH5Order(orderData) {
  try {
    console.log('[Sync] Order data keys:', Object.keys(orderData))
    
    // 提取订单号
    let order_no = ''
    if (orderData.idStr) order_no = orderData.idStr
    else if (orderData.orderId) order_no = orderData.orderId
    else if (orderData.bizOrderId) order_no = orderData.bizOrderId
    else if (orderData.id) order_no = orderData.id
    
    // 提取订单状态（tradeTitle字段）
    let status = ''
    if (orderData.fields && orderData.fields.tradeTitle) {
      status = orderData.fields.tradeTitle
    } else if (orderData.statusInfo && orderData.statusInfo.statusTitle) {
      status = orderData.statusInfo.statusTitle
    } else if (orderData.status) {
      status = orderData.status
    }
    
    // 提取物流信息
    let logistics_no = ''
    let logistics_company = ''
    
    if (orderData.extendInfo) {
      logistics_no = orderData.extendInfo.mailNo || orderData.extendInfo.logisticsNo || ''
      logistics_company = orderData.extendInfo.expressCompany || orderData.extendInfo.logisticsCompany || ''
    }
    
    if (!logistics_no && orderData.logistics) {
      logistics_no = orderData.logistics.mailNo || orderData.logistics.logisticsNo || ''
      logistics_company = orderData.logistics.expressCompany || orderData.logistics.logisticsCompany || ''
    }
    
    const result = {
      order_no,
      status,
      logistics_no,
      logistics_company
    }
    
    console.log('[Sync] Parsed H5 order:', result)
    return result
    
  } catch (e) {
    console.error('[Sync] Parse single order error:', e.message)
    return null
  }
}

/**
 * 解析淘宝订单响应（旧版，保留兼容）
 */
function parseTaobaoOrders(html) {
  const orders = []
  try {
    // 从HTML中提取订单JSON数据
    const jsonMatch = html.match(/"data":\s*(\{.*?\})\s*,\s*"success"/s)
    if (jsonMatch) {
      const jsonData = JSON.parse(jsonMatch[1])
      console.log('[Sync] Taobao API response keys:', Object.keys(jsonData))
      if (jsonData.mainOrders) {
        console.log('[Sync] Taobao mainOrders count:', jsonData.mainOrders.length)
        for (const mainOrder of jsonData.mainOrders) {
          console.log('[Sync] Order keys:', Object.keys(mainOrder))
          
          // 提取订单状态（tradeTitle字段表示订单状态）
          let status = ''
          // 优先从 fields.tradeTitle 提取（如"卖家已发货"、"已签收"等）
          if (mainOrder.fields && mainOrder.fields.tradeTitle) {
            status = mainOrder.fields.tradeTitle
          }
          // 备选从 statusInfo 提取
          if (!status && mainOrder.statusInfo && mainOrder.statusInfo.statusTitle) {
            status = mainOrder.statusInfo.statusTitle
          }
          // 最后从 status 字段提取
          if (!status) {
            status = mainOrder.status || ''
          }
          
          const order = {
            order_no: mainOrder.idStr || mainOrder.orderId || mainOrder.id || '',
            status: status,
            logistics_no: '',
            logistics_company: ''
          }

          // 尝试从子订单或物流信息中提取
          if (mainOrder.extendInfo) {
            console.log('[Sync] extendInfo keys:', Object.keys(mainOrder.extendInfo))
            order.logistics_no = mainOrder.extendInfo.mailNo || mainOrder.extendInfo.logisticsNo || ''
            order.logistics_company = mainOrder.extendInfo.expressCompany || mainOrder.extendInfo.logisticsCompany || ''
          }

          // 尝试从logistics字段提取
          if (mainOrder.logistics) {
            console.log('[Sync] logistics keys:', Object.keys(mainOrder.logistics))
            order.logistics_no = mainOrder.logistics.mailNo || mainOrder.logistics.logisticsNo || ''
            order.logistics_company = mainOrder.logistics.expressCompany || mainOrder.logistics.logisticsCompany || ''
          }

          // 尝试从其他可能字段提取
          if (!order.logistics_no && mainOrder.bizOrder) {
            order.logistics_no = mainOrder.bizOrder.logisticsId || ''
          }

          console.log('[Sync] Parsed order:', order)
          if (order.order_no) {
            orders.push(order)
          }
        }
      } else {
        console.log('[Sync] No mainOrders found in Taobao response')
        // 保存部分HTML用于调试
        console.log('[Sync] Response sample:', html.substring(0, 2000))
      }
    } else {
      console.log('[Sync] No JSON data found in Taobao response')
      console.log('[Sync] Response sample:', html.substring(0, 2000))
    }
  } catch (e) {
    console.error('[Sync] 淘宝订单解析异常:', e.message)
    console.error('[Sync] Stack:', e.stack)
  }
  return orders
}

/**
 * 同步1688订单
 */
async function sync1688Orders(cookies) {
  const https = require('https')
  const cookieStr = buildCookieString(cookies)

  const options = {
    hostname: 'trade.1688.com',
    path: '/order/offer_order_list.htm?pageSize=100&pageNum=1',
    method: 'GET',
    headers: {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://trade.1688.com/order/offer_order_list.htm'
    }
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const orders = parse1688Orders(data)
          resolve(orders)
        } catch (e) {
          reject(new Error(`1688订单解析失败: ${e.message}`))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')) })
    req.end()
  })
}

/**
 * 解析1688订单响应
 */
function parse1688Orders(html) {
  const orders = []
  try {
    // 1688订单页面通常包含JSON数据
    const jsonMatch = html.match(/"offerOrderList":\s*(\[.*?\])/s)
    if (jsonMatch) {
      const orderList = JSON.parse(jsonMatch[1])
      for (const order of orderList) {
        orders.push({
          order_no: order.id || order.orderId || '',
          status: order.status || order.statusText || '',
          logistics_no: order.logistics?.mailNo || order.mailNo || '',
          logistics_company: order.logistics?.companyName || order.logisticsCompany || ''
        })
      }
    }
  } catch (e) {
    console.warn('[Sync] 1688订单解析异常:', e.message)
  }
  return orders
}

/**
 * 爬取淘宝物流页面获取物流单号和物流公司
 * @param {string} orderId - 淘宝订单号
 * @param {string} cookieStr - Cookie字符串
 * @returns {Promise<{logistics_no: string, logistics_company: string}|null>}
 */
async function fetchTaobaoLogistics(orderId, cookieStr) {
  const https = require('https')
  
  // 物流页面URL
  const logisticsUrl = `https://market.m.taobao.com/app/dinamic/pc-trade-logistics/home.html?orderId=${orderId}&entrance=pc`
  
  // 访问物流页面
  const options = {
    hostname: 'market.m.taobao.com',
    path: `/app/dinamic/pc-trade-logistics/home.html?orderId=${orderId}&entrance=pc`,
    method: 'GET',
    headers: {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://detail.tmall.com/order/order_detail.htm'
    }
  }
  
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const result = parseLogisticsPage(data)
          resolve(result)
        } catch (e) {
          reject(new Error(`物流页面解析失败: ${e.message}`))
        }
      })
    })
    req.on('error', (e) => reject(e))
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('物流页面请求超时')) })
    req.end()
  })
}

/**
 * 解析淘宝物流页面，提取物流单号和物流公司
 */
function parseLogisticsPage(html) {
  try {
    // 从HTML中提取物流信息
    // 方式1：从页面JSON数据中提取
    const jsonMatch = html.match(/"logisticsDetail":\s*(\{.*?\})/s)
    if (jsonMatch) {
      const detail = JSON.parse(jsonMatch[1])
      return {
        logistics_no: detail.mailNo || detail.logisticsNo || detail.wuliuNo || '',
        logistics_company: detail.companyName || detail.logisticsCompany || detail.wuliuCompanyName || ''
      }
    }
    
    // 方式2：从页面文本中提取（正则匹配）
    // 匹配 "快递: xxx" 或 "物流公司: xxx"
    const companyPatterns = [
      /物流公司[：:\s]*([^<"\s]+)/,
      /快递公司[：:\s]*([^<"\s]+)/,
      /承运方[：:\s]*([^<"\s]+)/
    ]
    
    // 匹配 "单号: xxx" 或 "运单号: xxx"
    const noPatterns = [
      /运单号[：:\s]*([A-Za-z0-9]{10,})/,
      /物流单号[：:\s]*([A-Za-z0-9]{10,})/,
      /快递单号[：:\s]*([A-Za-z0-9]{10,})/
    ]
    
    let logistics_no = ''
    let logistics_company = ''
    
    for (const pattern of noPatterns) {
      const match = html.match(pattern)
      if (match && match[1]) {
        logistics_no = match[1].trim()
        break
      }
    }
    
    for (const pattern of companyPatterns) {
      const match = html.match(pattern)
      if (match && match[1]) {
        logistics_company = match[1].trim()
        break
      }
    }
    
    return { logistics_no, logistics_company }
  } catch (e) {
    console.error('[Logistics] 物流页面解析异常:', e.message)
    return null
  }
}

/**
 * 同步拼多多订单
 */
async function syncPddOrders(cookies) {
  const https = require('https')
  const cookieStr = buildCookieString(cookies)

  const options = {
    hostname: 'mms.pinduoduo.com',
    path: '/order/list',
    method: 'GET',
    headers: {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const orders = parsePddOrders(data)
          resolve(orders)
        } catch (e) {
          reject(new Error(`拼多多订单解析失败: ${e.message}`))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时')) })
    req.end()
  })
}

/**
 * 解析拼多多订单响应
 */
function parsePddOrders(html) {
  const orders = []
  try {
    // 拼多多订单解析逻辑
    const jsonMatch = html.match(/"orderList":\s*(\[.*?\])/s)
    if (jsonMatch) {
      const orderList = JSON.parse(jsonMatch[1])
      for (const order of orderList) {
        orders.push({
          order_no: order.order_sn || order.orderSn || '',
          status: order.order_status || order.statusText || '',
          logistics_no: order.tracking_number || order.logisticsNo || '',
          logistics_company: order.logistics_company || order.logisticsCompany || ''
        })
      }
    }
  } catch (e) {
    console.warn('[Sync] 拼多多订单解析异常:', e.message)
  }
  return orders
}

/**
 * 构建Cookie字符串
 */
function buildCookieString(cookies) {
  if (Array.isArray(cookies)) {
    return cookies.map(c => `${c.name}=${c.value}`).join('; ')
  }
  if (typeof cookies === 'string') {
    return cookies
  }
  return ''
}

/**
 * 验证平台Cookie是否有效
 */
async function validatePlatformCookie(platform, cookies) {
  const https = require('https')
  const cookieStr = buildCookieString(cookies)

  return new Promise((resolve) => {
    try {
      let options
      if (platform === 'taobao') {
        options = {
          hostname: 'buyertrade.taobao.com',
          path: '/trade/itemlist/list_bought_items.htm',
          method: 'GET',
          headers: {
            'Cookie': cookieStr,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          timeout: 10000
        }
      } else if (platform === '1688') {
        options = {
          hostname: 'trade.1688.com',
          path: '/order/offer_order_list.htm',
          method: 'GET',
          headers: {
            'Cookie': cookieStr,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          timeout: 10000
        }
      } else if (platform === 'pinduoduo') {
        options = {
          hostname: 'mms.pinduoduo.com',
          path: '/order/list',
          method: 'GET',
          headers: {
            'Cookie': cookieStr,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          timeout: 10000
        }
      } else {
        resolve(false)
        return
      }

      const req = https.request(options, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          // 检查响应状态和重定向
          const statusCode = res.statusCode
          console.log(`[Sync] Cookie validation: ${platform} returned status ${statusCode}`)

          // 302重定向到登录页 = Cookie失效
          if (statusCode === 302) {
            const location = res.headers['location'] || ''
            if (location.includes('login') || location.includes('passport')) {
              console.log(`[Sync] Redirect to login detected, cookie expired`)
              resolve(false)
              return
            }
          }

          // HTTP 401/403 = 认证失败
          if (statusCode === 401 || statusCode === 403) {
            console.log(`[Sync] HTTP ${statusCode}, cookie expired`)
            resolve(false)
            return
          }

          // 其他状态码认为Cookie有效(不再检查HTML内容中的login关键词,因为淘宝页面经常包含这些词)
          console.log(`[Sync] Cookie appears valid (status ${statusCode})`)
          resolve(true)
        })
      })

      req.on('error', (e) => {
        console.log(`[Sync] Cookie validation request error: ${e.message}`)
        resolve(false)
      })

      req.on('timeout', () => {
        req.destroy()
        console.log(`[Sync] Cookie validation timeout`)
        resolve(false)
      })

      req.end()
    } catch (e) {
      console.log(`[Sync] Cookie validation error: ${e.message}`)
      resolve(false)
    }
  })
}

// ============ 淘宝 H5 Token 刷新 ============

/**
 * 通过轻量级 API 请求刷新 _m_h5_tk token
 * 访问淘宝 H5 API 网关，触发 Set-Cookie 返回新的 _m_h5_tk
 * @param {Array|Object} cookies - 原始 cookie 数组
 * @returns {{ newTk: string, newTkEnc: string, success: boolean }}
 */
async function refreshTaobaoH5Token(cookies) {
  const https = require('https')
  const crypto = require('crypto')

  const requiredCookies = ['_m_h5_tk', '_m_h5_tk_enc', 'cookie2', 't', 'sgcookie', 'enc', 'existShop', 'lgc', 'dnk', 'cna', 'tracknick', '_tb_token_', 'thw', 'hng']
  let essentialCookies = []
  if (Array.isArray(cookies)) {
    essentialCookies = cookies.filter(c => requiredCookies.includes(c.name))
  }
  const cookieStr = buildCookieString(essentialCookies)

  console.log(`[Token-Refresh] Attempting H5 token refresh, cookie length: ${cookieStr.length}`)

  // 使用 mtop.common.getTimestamp 轻量API触发token刷新
  const timestamp = Date.now()
  const signTimestamp = Math.floor(timestamp / 60000)
  const tokenMatch = cookieStr.match(/_m_h5_tk=([^;]+)/)
  const oldToken = tokenMatch ? tokenMatch[1].split('_')[0] : ''

  const dataStr = '{}'
  const signStr = `${oldToken}&${signTimestamp}&12574478&${dataStr}`
  const sign = crypto.createHash('md5').update(signStr).digest('hex')

  const params = new URLSearchParams({
    jsv: '2.7.2',
    appKey: '12574478',
    t: timestamp.toString(),
    sign: sign,
    v: '1.0',
    ecode: '1',
    timeout: '8000',
    dataType: 'json',
    api: 'mtop.common.getTimestamp',
    isHttps: '1',
    needRetry: 'true'
  })

  const options = {
    hostname: 'h5api.m.taobao.com',
    path: `/h5/mtop.common.getTimestamp/1.0/?${params.toString()}`,
    method: 'GET',
    headers: {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm'
    }
  }

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      const setCookies = res.headers['set-cookie'] || []
      let newTk = ''
      let newTkEnc = ''

      for (const sc of setCookies) {
        const tkMatch = sc.match(/_m_h5_tk=([^;]+)/)
        if (tkMatch) newTk = tkMatch[1]
        const tkEncMatch = sc.match(/_m_h5_tk_enc=([^;]+)/)
        if (tkEncMatch) newTkEnc = tkEncMatch[1]
      }

      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (newTk) {
          console.log(`[Token-Refresh] Success! Got new _m_h5_tk: ${newTk.substring(0, 16)}...`)
          resolve({ newTk, newTkEnc, success: true })
        } else {
          console.log(`[Token-Refresh] Failed - no new token in Set-Cookie`)
          console.log(`[Token-Refresh] Response status: ${res.statusCode}, Set-Cookie count: ${setCookies.length}`)
          // 尝试第二种方式：访问淘宝订单列表页面获取token
          refreshTaobaoH5TokenViaPage(cookieStr).then(result => {
            resolve(result)
          })
        }
      })
    })

    req.on('error', (e) => {
      console.log(`[Token-Refresh] Request error: ${e.message}`)
      resolve({ newTk: '', newTkEnc: '', success: false })
    })

    req.setTimeout(10000, () => {
      req.destroy()
      console.log(`[Token-Refresh] Request timeout`)
      resolve({ newTk: '', newTkEnc: '', success: false })
    })

    req.end()
  })
}

/**
 * 通过访问淘宝页面刷新 _m_h5_tk（备选方案）
 * @param {string} cookieStr - cookie字符串
 * @returns {{ newTk: string, newTkEnc: string, success: boolean }}
 */
async function refreshTaobaoH5TokenViaPage(cookieStr) {
  const https = require('https')

  console.log(`[Token-Refresh] Trying page-based refresh via buyertrade.taobao.com...`)

  const options = {
    hostname: 'buyertrade.taobao.com',
    path: '/trade/itemlist/list_bought_items.htm',
    method: 'GET',
    headers: {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  }

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      const setCookies = res.headers['set-cookie'] || []
      let newTk = ''
      let newTkEnc = ''

      for (const sc of setCookies) {
        const tkMatch = sc.match(/_m_h5_tk=([^;]+)/)
        if (tkMatch) newTk = tkMatch[1]
        const tkEncMatch = sc.match(/_m_h5_tk_enc=([^;]+)/)
        if (tkEncMatch) newTkEnc = tkEncMatch[1]
      }

      if (newTk) {
        console.log(`[Token-Refresh-Page] Success! Got new _m_h5_tk from page visit`)
        resolve({ newTk, newTkEnc, success: true })
      } else {
        console.log(`[Token-Refresh-Page] Failed - main session cookies may be expired`)
        resolve({ newTk: '', newTkEnc: '', success: false })
      }
    })

    req.on('error', () => resolve({ newTk: '', newTkEnc: '', success: false }))
    req.setTimeout(10000, () => { req.destroy(); resolve({ newTk: '', newTkEnc: '', success: false }) })
    req.end()
  })
}

/**
 * 更新 cookie 数组中的 _m_h5_tk 和 _m_h5_tk_enc
 * @param {Array} cookies - 原始 cookie 数组
 * @param {string} newTk - 新的 _m_h5_tk 值
 * @param {string} newTkEnc - 新的 _m_h5_tk_enc 值
 * @returns {Array} 更新后的 cookie 数组
 */
function updateCookiesWithNewToken(cookies, newTk, newTkEnc) {
  const updated = cookies.map(c => ({ ...c }))
  const tkIdx = updated.findIndex(c => c.name === '_m_h5_tk')
  if (tkIdx >= 0) {
    updated[tkIdx] = { ...updated[tkIdx], value: newTk }
  } else {
    updated.push({ name: '_m_h5_tk', value: newTk })
  }
  if (newTkEnc) {
    const tkEncIdx = updated.findIndex(c => c.name === '_m_h5_tk_enc')
    if (tkEncIdx >= 0) {
      updated[tkEncIdx] = { ...updated[tkEncIdx], value: newTkEnc }
    } else {
      updated.push({ name: '_m_h5_tk_enc', value: newTkEnc })
    }
  }
  return updated
}

// ============ 物流轨迹查询 ============

// 查询物流轨迹
app.get('/api/purchase-orders/:id/logistics', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)

    // 1. 获取采购订单信息（包含account_id）
    const [rows] = await pool.execute(
      'SELECT logistics_no, logistics_company, platform, account_id FROM purchase_orders WHERE id=? AND owner_id=?',
      [req.params.id, ownerId]
    )

    if (!rows.length) {
      return res.status(404).json(fail('采购订单不存在'))
    }

    const order = rows[0]
    if (!order.logistics_no) {
      return res.json(fail('该订单暂无物流单号'))
    }

    // 2. 查询物流轨迹（优先从平台获取，其次使用第三方API）
    let trackingData = null

    // 尝试从平台API获取物流轨迹（使用订单关联的account_id）
    try {
      if (order.platform === 'taobao') {
        trackingData = await queryTaobaoLogistics(order.logistics_no, order.logistics_company, order.account_id, ownerId)
      } else if (order.platform === '1688') {
        trackingData = await query1688Logistics(order.logistics_no, order.logistics_company, order.account_id, ownerId)
      } else if (order.platform === 'pinduoduo') {
        trackingData = await queryPddLogistics(order.logistics_no, order.logistics_company, order.account_id, ownerId)
      }
    } catch (e) {
      console.log(`[Logistics] 平台物流查询失败: ${e.message}，尝试第三方API`)
    }

    // 如果平台查询失败，使用快递100 API
    if (!trackingData) {
      try {
        trackingData = await queryExpress100(order.logistics_no, order.logistics_company)
      } catch (e) {
        // 快递100也不可用，返回已有的基本信息（物流单号、公司）
        console.log(`[Logistics] 快递100查询失败: ${e.message}，返回基本信息`)
        return res.json(ok({
          company: order.logistics_company || '',
          tracking_no: order.logistics_no || '',
          tracks: [],
          source: 'local'
        }))
      }
    }

    res.json(ok(trackingData))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

// ============ 物流轨迹查询函数 ============

/**
 * 查询淘宝物流轨迹
 */
async function queryTaobaoLogistics(logisticsNo, company, accountId, ownerId) {
  const https = require('https')

  let cookieRows = []
  
  // 优先使用订单关联的account_id获取Cookie
  if (accountId) {
    cookieRows = await pool.execute(
      'SELECT pc.cookie_data, pa.account FROM purchase_cookies pc JOIN purchase_accounts pa ON pc.account_id = pa.id WHERE pc.account_id = ? AND pa.owner_id = ?',
      [accountId, ownerId]
    )
    if (cookieRows.length && cookieRows[0].cookie_data) {
      console.log(`[Logistics] 使用订单关联的淘宝账号 "${cookieRows[0].account}" (id=${accountId}) 查询物流`)
    }
  }
  
  // 如果account_id无效或Cookie不存在，fallback到该用户名下最近的淘宝账号
  if (!cookieRows.length || !cookieRows[0].cookie_data) {
    cookieRows = await pool.execute(
      'SELECT pc.cookie_data, pa.account FROM purchase_cookies pc JOIN purchase_accounts pa ON pc.account_id = pa.id WHERE pa.platform = "taobao" AND pa.owner_id = ? ORDER BY pc.saved_at DESC LIMIT 1',
      [ownerId]
    )
    if (cookieRows.length && cookieRows[0].cookie_data) {
      console.log(`[Logistics] 订单无account_id，使用最近的淘宝账号 "${cookieRows[0].account}" 查询物流`)
    }
  }

  if (!cookieRows.length || !cookieRows[0].cookie_data) {
    console.log(`[Logistics] 未找到淘宝账号Cookie，owner_id=${ownerId}`)
    return null
  }

  const cookieStr = buildCookieString(
    typeof cookieRows[0].cookie_data === 'string' ? JSON.parse(cookieRows[0].cookie_data) : cookieRows[0].cookie_data
  )

  const options = {
    hostname: 'buyertrade.taobao.com',
    path: `/trade/detail/query_logistics.htm?orderId=${logisticsNo}`,
    method: 'GET',
    headers: {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': `https://buyertrade.taobao.com/trade/detail?orderId=${logisticsNo}`
    }
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const result = JSON.parse(data)
          if (result.success && result.data) {
            resolve({
              company: result.data.logisticsCompany || company,
              tracking_no: result.data.logisticsNo || logisticsNo,
              tracks: result.data.details || [],
              source: 'taobao'
            })
          } else {
            resolve(null)
          }
        } catch (e) {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(10000, () => { req.destroy(); resolve(null) })
    req.end()
  })
}

/**
 * 查询1688物流轨迹
 */
async function query1688Logistics(logisticsNo, company, accountId, ownerId) {
  const https = require('https')

  let cookieRows = []
  
  // 优先使用订单关联的account_id获取Cookie
  if (accountId) {
    cookieRows = await pool.execute(
      'SELECT pc.cookie_data, pa.account FROM purchase_cookies pc JOIN purchase_accounts pa ON pc.account_id = pa.id WHERE pc.account_id = ? AND pa.owner_id = ?',
      [accountId, ownerId]
    )
    if (cookieRows.length && cookieRows[0].cookie_data) {
      console.log(`[Logistics] 使用订单关联的1688账号 "${cookieRows[0].account}" (id=${accountId}) 查询物流`)
    }
  }
  
  // 如果account_id无效或Cookie不存在，fallback
  if (!cookieRows.length || !cookieRows[0].cookie_data) {
    cookieRows = await pool.execute(
      'SELECT pc.cookie_data, pa.account FROM purchase_cookies pc JOIN purchase_accounts pa ON pc.account_id = pa.id WHERE pa.platform = "1688" AND pa.owner_id = ? ORDER BY pc.saved_at DESC LIMIT 1',
      [ownerId]
    )
    if (cookieRows.length && cookieRows[0].cookie_data) {
      console.log(`[Logistics] 订单无account_id，使用最近的1688账号 "${cookieRows[0].account}" 查询物流`)
    }
  }

  if (!cookieRows.length || !cookieRows[0].cookie_data) {
    console.log(`[Logistics] 未找到1688账号Cookie，owner_id=${ownerId}`)
    return null
  }

  const cookieStr = buildCookieString(
    typeof cookieRows[0].cookie_data === 'string' ? JSON.parse(cookieRows[0].cookie_data) : cookieRows[0].cookie_data
  )

  const options = {
    hostname: 'trade.1688.com',
    path: `/order/detail.htm?orderId=${logisticsNo}`,
    method: 'GET',
    headers: {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    }
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          // 解析1688物流信息
          const html = data
          const logisticsMatch = html.match(/"logisticsDetails":\s*(\[.*?\])/s)
          if (logisticsMatch) {
            const details = JSON.parse(logisticsMatch[1])
            resolve({
              company: company,
              tracking_no: logisticsNo,
              tracks: details,
              source: '1688'
            })
          } else {
            resolve(null)
          }
        } catch (e) {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(10000, () => { req.destroy(); resolve(null) })
    req.end()
  })
}

/**
 * 查询拼多多物流轨迹
 */
async function queryPddLogistics(logisticsNo, company, accountId, ownerId) {
  const https = require('https')

  let cookieRows = []
  
  // 优先使用订单关联的account_id获取Cookie
  if (accountId) {
    cookieRows = await pool.execute(
      'SELECT pc.cookie_data, pa.account FROM purchase_cookies pc JOIN purchase_accounts pa ON pc.account_id = pa.id WHERE pc.account_id = ? AND pa.owner_id = ?',
      [accountId, ownerId]
    )
    if (cookieRows.length && cookieRows[0].cookie_data) {
      console.log(`[Logistics] 使用订单关联的拼多多账号 "${cookieRows[0].account}" (id=${accountId}) 查询物流`)
    }
  }
  
  // 如果account_id无效或Cookie不存在，fallback
  if (!cookieRows.length || !cookieRows[0].cookie_data) {
    cookieRows = await pool.execute(
      'SELECT pc.cookie_data, pa.account FROM purchase_cookies pc JOIN purchase_accounts pa ON pc.account_id = pa.id WHERE pa.platform = "pinduoduo" AND pa.owner_id = ? ORDER BY pc.saved_at DESC LIMIT 1',
      [ownerId]
    )
    if (cookieRows.length && cookieRows[0].cookie_data) {
      console.log(`[Logistics] 订单无account_id，使用最近的拼多多账号 "${cookieRows[0].account}" 查询物流`)
    }
  }

  if (!cookieRows.length || !cookieRows[0].cookie_data) {
    console.log(`[Logistics] 未找到拼多多账号Cookie，owner_id=${ownerId}`)
    return null
  }

  const cookieStr = buildCookieString(
    typeof cookieRows[0].cookie_data === 'string' ? JSON.parse(cookieRows[0].cookie_data) : cookieRows[0].cookie_data
  )

  const options = {
    hostname: 'mms.pinduoduo.com',
    path: `/order/detail?orderSn=${logisticsNo}`,
    method: 'GET',
    headers: {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    }
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const html = data
          const logisticsMatch = html.match(/"trackingDetails":\s*(\[.*?\])/s)
          if (logisticsMatch) {
            const details = JSON.parse(logisticsMatch[1])
            resolve({
              company: company,
              tracking_no: logisticsNo,
              tracks: details,
              source: 'pinduoduo'
            })
          } else {
            resolve(null)
          }
        } catch (e) {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(10000, () => { req.destroy(); resolve(null) })
    req.end()
  })
}

/**
 * 使用快递100查询物流轨迹
 * 注意：需要在环境变量中配置 EXPRESS100_KEY 和 EXPRESS100_CUSTOMER
 */
async function queryExpress100(logisticsNo, company) {
  const https = require('https')

  const apiKey = process.env.EXPRESS100_KEY || ''
  const customer = process.env.EXPRESS100_CUSTOMER || ''

  if (!apiKey || !customer) {
    throw new Error('快递100 API 未配置')
  }

  // 快递公司代码转换
  const companyMap = {
    '顺丰速运': 'shunfeng',
    '圆通速递': 'yuantong',
    '中通快递': 'zhongtong',
    '韵达快递': 'yunda',
    '申通快递': 'shentong',
    '百世快递': 'huitongkuaidi',
    '极兔速递': 'jtexpress',
    '邮政快递': 'youzhengguonei',
    '德邦快递': 'debangwuliu',
    '京东物流': 'jd',
    '顺丰快运': 'shunfengkuaiyun'
  }

  const companyCode = companyMap[company] || company?.toLowerCase() || ''
  if (!companyCode) {
    throw new Error('无法识别物流公司')
  }

  // 快递100 API参数
  const param = JSON.stringify({
    com: companyCode,
    num: logisticsNo,
    phone: '',
    from: '',
    to: '',
    resultv2: '1'
  })

  const sign = require('crypto')
    .createHash('md5')
    .update(param + apiKey + customer)
    .digest('hex')
    .toUpperCase()

  const postData = JSON.stringify({
    param: param,
    sign: sign,
    customer: customer
  })

  const options = {
    hostname: 'poll.kuaidi100.com',
    path: '/poll/query.do',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const result = JSON.parse(data)
          if (result.state === '200' && result.data) {
            resolve({
              company: company,
              tracking_no: logisticsNo,
              tracks: result.data.map(track => ({
                time: track.time,
                context: track.context,
                status: track.status
              })),
              source: 'express100'
            })
          } else {
            throw new Error(result.message || '快递100查询失败')
          }
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('快递100请求超时')) })
    req.write(postData)
    req.end()
  })
}

// ============ 小程序登录接口 ============
// 供仓库小程序使用，返回 token 供后续 API 调用

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      return res.json(fail('用户名和密码不能为空'))
    }

    const [rows] = await pool.execute(
      'SELECT id, username, real_name, phone, user_type, role, parent_id, status, password_hash FROM users WHERE username = ?',
      [username]
    )

    if (!rows.length) {
      return res.json(fail('用户名或密码错误'))
    }

    const user = rows[0]
    if (user.status === 'disabled') {
      return res.json(fail('账号已被禁用'))
    }

    // 验证密码
    const valid = bcrypt.compareSync(password, user.password_hash)
    if (!valid) {
      return res.json(fail('用户名或密码错误'))
    }

    // 签发 JWT
    const token = jwt.sign(
      { sub: user.username, user_id: user.id },
      JWT_SECRET,
      { expiresIn: '7d', issuer: 'dianxiaoer-server' }
    )

    // 保存 token 到 user_tokens 表
    await pool.execute(
      'INSERT INTO user_tokens (user_id, token) VALUES (?, ?) ON DUPLICATE KEY UPDATE token = ?',
      [user.id, token, token]
    )

    res.json(ok({
      token,
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
    console.error('[Auth] 登录失败:', err.message)
    res.status(500).json(fail('登录失败'))
  }
})

// ============ 仓库管理路由 ============

const warehouseRouter = require('./routes/warehouse')(pool)
app.use('/api/warehouse', warehouseRouter)

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
