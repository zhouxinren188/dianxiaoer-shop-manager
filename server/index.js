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

// 更新采购订单信息（物流单号、商品信息等）
app.put('/api/purchase-orders/:id', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)
    const { sales_order_no, goods_name, sku, quantity, purchase_price, platform,
            source_url, remark, logistics_no, logistics_company } = req.body

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

    if (!fields.length) return res.json(fail('没有要修改的字段'))

    values.push(req.params.id, ownerId)
    fields.push('updated_at=NOW()')

    await pool.execute(
      `UPDATE purchase_orders SET ${fields.join(', ')} WHERE id=? AND owner_id=?`,
      values
    )
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

      // 更新订单状态
      if (newStatus !== localOrder.status) {
        await pool.execute(
          'UPDATE purchase_orders SET status=? WHERE id=?',
          [newStatus, localOrder.id]
        )
        console.log(`[Sync] Updated order ${localOrder.purchase_no}: ${localOrder.status} -> ${newStatus}`)
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
      'SELECT pc.cookie_data FROM purchase_cookies pc WHERE pc.account_id = ?',
      [account_id]
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
        return res.json({ success: false, message: 'Cookie已失效，请重新登录采购账号' })
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
        orderInfo = await queryTaobaoOrderByNo(cookies, platform_order_no)
      } else if (platform === '1688') {
        orderInfo = await query1688OrderByNo(cookies, platform_order_no)
      } else if (platform === 'pinduoduo') {
        orderInfo = await queryPddOrderByNo(cookies, platform_order_no)
      } else {
        return res.json(fail(`暂不支持 ${platform} 平台`))
      }
    } catch (e) {
      console.error(`[Sync-Single] Platform API error: ${e.message}`)
      return res.json({ success: false, message: `查询失败: ${e.message}` })
    }

    if (!orderInfo) {
      return res.json({ success: false, message: '未找到该订单' })
    }

    console.log(`[Sync-Single] Found order:`, JSON.stringify(orderInfo))

    // 更新本地数据库
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

    const newStatus = statusMap[orderInfo.status] || null

    // 查找本地采购订单
    const [localOrders] = await pool.execute(
      'SELECT id, purchase_no, status, logistics_no FROM purchase_orders WHERE owner_id=? AND platform_order_no=?',
      [ownerId, platform_order_no]
    )

    if (localOrders.length === 0) {
      return res.json({ success: false, message: '本地未找到对应的采购订单' })
    }

    const localOrder = localOrders[0]

    // 更新状态
    if (newStatus && newStatus !== localOrder.status) {
      await pool.execute(
        'UPDATE purchase_orders SET status=? WHERE id=?',
        [newStatus, localOrder.id]
      )
      console.log(`[Sync-Single] Updated status: ${localOrder.status} -> ${newStatus}`)
    }

    // 更新物流信息
    if (orderInfo.logistics_no) {
      await pool.execute(
        'UPDATE purchase_orders SET logistics_no=?, logistics_company=?, logistics_status=? WHERE id=?',
        [
          orderInfo.logistics_no || null,
          orderInfo.logistics_company || null,
          orderInfo.logistics_status || null,
          localOrder.id
        ]
      )
      console.log(`[Sync-Single] Updated logistics: ${orderInfo.logistics_no} (${orderInfo.logistics_company})`)
    }

    res.json({
      success: true,
      status: newStatus || localOrder.status,
      logistics_no: orderInfo.logistics_no || localOrder.logistics_no,
      logistics_company: orderInfo.logistics_company,
      logistics_status: orderInfo.logistics_status,
      message: '同步成功'
    })
  } catch (err) {
    console.error(`[Sync-Single] Error: ${err.message}`)
    res.status(500).json(fail(err.message))
  }
})

// ============ 平台订单同步函数 ============

/**
 * 同步淘宝/天猫订单
 * 使用 H5 API: mtop.taobao.order.queryboughtlistV2
 */
async function syncTaobaoOrders(cookies) {
  const https = require('https')
  const cookieStr = buildCookieString(cookies)

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

  // 构建URL参数（与浏览器抓包一致）
  const params = new URLSearchParams({
    jsv: '2.7.2',
    appKey: '12574478',
    t: timestamp.toString(),
    sign: 'test',
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

  const options = {
    hostname: 'h5api.m.taobao.com',
    path: `/h5/mtop.taobao.order.queryboughtlistv2/1.0/?${params.toString()}`,
    method: 'POST',
    headers: {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': '*/*',
      'Referer': 'https://buyertrade.taobao.com/'
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
    
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
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
    
    // 转换为数组
    for (const orderId of Object.keys(orderMap)) {
      const order = orderMap[orderId]
      if (order.order_no) {
        orders.push({
          order_no: order.order_no,
          status: order.status || '',
          logistics_no: order.logistics_no || '',
          logistics_company: order.logistics_company || '',
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
async function queryTaobaoOrderByNo(cookies, orderNo) {
  const https = require('https')
  const crypto = require('crypto')
  const cookieStr = buildCookieString(cookies)

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

  // 从Cookie中提取token
  const tokenMatch = cookieStr.match(/_m_h5_tk=([^;]+)/)
  const token = tokenMatch ? tokenMatch[1].split('_')[0] : ''

  // 生成签名
  const signStr = `${token}&${timestamp}&12574478&${dataStr}`
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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) dianxiaoer-shop-manager/1.2.11 Chrome/146.0.7680.188 Electron/41.3.0 Safari/537.36',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Referer': 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
      'Content-Length': Buffer.byteLength(postData)
    }
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          console.log(`[Query-Taobao] Response status: ${res.statusCode}`)
          console.log(`[Query-Taobao] Response headers:`, JSON.stringify(res.headers).substring(0, 300))
          console.log(`[Query-Taobao] Response sample:`, data.substring(0, 500))
          
          // 检查是否是HTML错误页面
          if (data.trim().startsWith('<') || data.includes('Cannot pro')) {
            console.error(`[Query-Taobao] Received HTML response instead of JSON`)
            reject(new Error('淘宝API返回错误页面，Cookie可能已失效'))
            return
          }
          
          const response = JSON.parse(data)
          console.log(`[Query-Taobao] API response ret:`, response.ret)

          if (response.ret && response.ret[0] === 'SUCCESS::调用成功') {
            // 解析订单数据
            const orders = parseTaobaoH5Response(data)
            if (orders.length > 0) {
              // 查找匹配的订单
              const order = orders.find(o => o.order_no === orderNo)
              if (order) {
                console.log(`[Query-Taobao] Found order:`, order)
                resolve(order)
              } else {
                resolve(null)
              }
            } else {
              resolve(null)
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

          // 检查HTML内容是否包含登录关键词
          if (data.includes('请登录') || data.includes('login') || data.includes('passport')) {
            console.log(`[Sync] Login keywords found in response, cookie expired`)
            resolve(false)
            return
          }

          // HTTP 401/403 = 认证失败
          if (statusCode === 401 || statusCode === 403) {
            console.log(`[Sync] HTTP ${statusCode}, cookie expired`)
            resolve(false)
            return
          }

          // 其他状态码认为Cookie有效
          console.log(`[Sync] Cookie appears valid`)
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

// ============ 物流轨迹查询 ============

// 查询物流轨迹
app.get('/api/purchase-orders/:id/logistics', async (req, res) => {
  try {
    const ownerId = getOwnerId(req.user)

    // 1. 获取采购订单信息
    const [rows] = await pool.execute(
      'SELECT logistics_no, logistics_company, platform FROM purchase_orders WHERE id=? AND owner_id=?',
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

    // 尝试从平台API获取物流轨迹
    try {
      if (order.platform === 'taobao') {
        trackingData = await queryTaobaoLogistics(order.logistics_no, order.logistics_company, ownerId)
      } else if (order.platform === '1688') {
        trackingData = await query1688Logistics(order.logistics_no, order.logistics_company, ownerId)
      } else if (order.platform === 'pinduoduo') {
        trackingData = await queryPddLogistics(order.logistics_no, order.logistics_company, ownerId)
      }
    } catch (e) {
      console.log(`[Logistics] 平台物流查询失败: ${e.message}，尝试第三方API`)
    }

    // 如果平台查询失败，使用快递100 API
    if (!trackingData) {
      try {
        trackingData = await queryExpress100(order.logistics_no, order.logistics_company)
      } catch (e) {
        return res.json(fail(`物流查询失败: ${e.message}`))
      }
    }

    res.json(ok(trackingData))
  } catch (err) { res.status(500).json(fail(err.message)) }
})

// ============ 物流轨迹查询函数 ============

/**
 * 查询淘宝物流轨迹
 */
async function queryTaobaoLogistics(logisticsNo, company, ownerId) {
  const https = require('https')

  // 淘宝物流查询API（需要有效的Cookie）
  const cookieRows = await pool.execute(
    'SELECT pc.cookie_data FROM purchase_cookies pc JOIN purchase_accounts pa ON pc.account_id = pa.id WHERE pa.platform = "taobao" AND pa.owner_id = ? ORDER BY pc.saved_at DESC LIMIT 1',
    [ownerId]
  )

  if (!cookieRows.length || !cookieRows[0].cookie_data) {
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
async function query1688Logistics(logisticsNo, company, ownerId) {
  const https = require('https')

  const cookieRows = await pool.execute(
    'SELECT pc.cookie_data FROM purchase_cookies pc JOIN purchase_accounts pa ON pc.account_id = pa.id WHERE pa.platform = "1688" AND pa.owner_id = ? ORDER BY pc.saved_at DESC LIMIT 1',
    [ownerId]
  )

  if (!cookieRows.length || !cookieRows[0].cookie_data) {
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
async function queryPddLogistics(logisticsNo, company, ownerId) {
  const https = require('https')

  const cookieRows = await pool.execute(
    'SELECT pc.cookie_data FROM purchase_cookies pc JOIN purchase_accounts pa ON pc.account_id = pa.id WHERE pa.platform = "pinduoduo" AND pa.owner_id = ? ORDER BY pc.saved_at DESC LIMIT 1',
    [ownerId]
  )

  if (!cookieRows.length || !cookieRows[0].cookie_data) {
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
