const express = require('express')
const cors = require('cors')
const path = require('path')
const fs = require('fs')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const { pool, initDB } = require('./db')

// JWT 密钥（与 dianxiaoer-api 保持一致）
const JWT_SECRET = 'bfb3079104c65c88d55b4ed46624c07b171d8254c87ec40a2f485370d10ee159a7115459fc9d249051bcd60bc0849633c47c4a8d1a4f167cce27aabfd152effd'

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
const publicPaths = ['/health', '/api/sync-lock']

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
    sql += ` ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`

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
// 注意：不再自动去重，允许创建重复店铺，由前端在登录成功后处理去重
app.post('/api/stores', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { name, platform, store_type, account, password, merchant_id, shop_id, tags, status } = req.body
    
    // 创建新店铺（即使 merchant_id 已存在也创建）
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

// 分页查询销售订单（权限过滤）
app.get('/api/sales-orders', async (req, res) => {
  try {
    const { store_id, status, page = 1, pageSize = 20 } = req.query
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
      'SELECT id, account, platform, online, created_at, updated_at FROM purchase_accounts WHERE owner_id=? ORDER BY id DESC',
      [ownerId]
    )
    res.json(ok({ list: rows, total: rows.length }))
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

// 获取下一个采购编号（按用户隔离，自动递增）
app.get('/api/purchase-orders/next-no', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const [[row]] = await pool.execute(
      'SELECT purchase_no FROM purchase_orders WHERE owner_id=? ORDER BY id DESC LIMIT 1',
      [ownerId]
    )
    let nextNum = 1
    if (row && row.purchase_no) {
      const num = parseInt(row.purchase_no, 10)
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
            purchase_type, shipping_name, shipping_phone, shipping_address } = req.body
    if (!purchase_no) return res.json(fail('purchase_no 不能为空'))
    await pool.execute(
      `INSERT INTO purchase_orders
        (purchase_no, sales_order_id, sales_order_no, goods_name, goods_image, sku, quantity,
         source_url, platform, purchase_price, remark,
         purchase_type, shipping_name, shipping_phone, shipping_address,
         status, owner_id)
       VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?, 'pending', ?)
       ON DUPLICATE KEY UPDATE
         sales_order_id=VALUES(sales_order_id), sales_order_no=VALUES(sales_order_no),
         goods_name=VALUES(goods_name), goods_image=VALUES(goods_image), sku=VALUES(sku), quantity=VALUES(quantity),
         source_url=VALUES(source_url), platform=VALUES(platform),
         purchase_price=VALUES(purchase_price), remark=VALUES(remark),
         purchase_type=VALUES(purchase_type), shipping_name=VALUES(shipping_name),
         shipping_phone=VALUES(shipping_phone), shipping_address=VALUES(shipping_address),
         updated_at=NOW()`,
      [purchase_no, sales_order_id||'', sales_order_no||'', goods_name||'', goods_image||'', sku||'', quantity||0,
       source_url||'', platform||'', purchase_price||0, remark||'',
       purchase_type||'dropship', shipping_name||'', shipping_phone||'', shipping_address||'',
       ownerId]
    )
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
    let sql = 'SELECT * FROM purchase_orders WHERE owner_id=?'
    const params = [ownerId]
    if (status) { sql += ' AND status=?'; params.push(status) }
    if (platform) { sql += ' AND platform=?'; params.push(platform) }
    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total')
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
