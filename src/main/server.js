const express = require('express')
const cors = require('cors')

const app = express()
app.use(cors())
app.use(express.json())

// ============ 内存数据库 ============
let userIdCounter = 3
const users = [
  { id: 1, username: 'admin', realName: '系统管理员', phone: '13800138000', userType: 'master', role: 'super_admin', status: 'enabled', createdAt: '2026-04-01 10:00:00' },
  { id: 2, username: 'staff01', realName: '张三', phone: '13900139000', userType: 'sub', role: 'staff', status: 'enabled', createdAt: '2026-04-15 14:30:00' }
]

const userStores = { 2: [1] }   // userId -> storeIds
const userWarehouses = { 2: [1] } // userId -> warehouseIds

const stores = [
  { id: 1, name: '京东旗舰店', platform: 'jd', account: 'jdshop001', merchant_id: 'M001', shop_id: 'S001', tags: ['自营'], online: 1, status: 'enabled' },
  { id: 2, name: '天猫专营店', platform: 'tmall', account: 'tmall001', merchant_id: 'M002', shop_id: 'S002', tags: ['品牌'], online: 0, status: 'enabled' },
  { id: 3, name: '淘宝小店', platform: 'taobao', account: 'tb001', merchant_id: 'M003', shop_id: 'S003', tags: [], online: 1, status: 'disabled' }
]

const warehouses = [
  { id: 1, name: '默认仓库', code: 'WH001', location: '浙江省杭州市', status: 'enabled' },
  { id: 2, name: '华东仓', code: 'WH002', location: '江苏省苏州市', status: 'enabled' },
  { id: 3, name: '华南仓', code: 'WH003', location: '广东省深圳市', status: 'enabled' },
  { id: 4, name: '华北仓', code: 'WH004', location: '北京市', status: 'disabled' }
]

function now() {
  const d = new Date()
  return d.toISOString().replace('T', ' ').substring(0, 19)
}

function ok(data) {
  return { code: 0, data }
}

function fail(message) {
  return { code: 1, message }
}

// ============ 用户管理接口 ============

// 查询用户列表
app.get('/api/users', (req, res) => {
  const { page = 1, pageSize = 10, username, realName, userType, role, status } = req.query
  let list = users.filter(u => {
    if (username && !u.username.includes(username)) return false
    if (realName && !u.realName.includes(realName)) return false
    if (userType && u.userType !== userType) return false
    if (role && u.role !== role) return false
    if (status && u.status !== status) return false
    return true
  })

  const total = list.length
  const start = (page - 1) * pageSize
  list = list.slice(start, start + +pageSize).map(u => ({
    ...u,
    assignedStores: (userStores[u.id] || []).map(sid => {
      const s = stores.find(x => x.id === sid)
      return s ? { id: s.id, name: s.name } : null
    }).filter(Boolean),
    assignedWarehouses: (userWarehouses[u.id] || []).map(wid => {
      const w = warehouses.find(x => x.id === wid)
      return w ? { id: w.id, name: w.name } : null
    }).filter(Boolean)
  }))

  res.json(ok({ list, total }))
})

// 获取单个用户
app.get('/api/users/:id', (req, res) => {
  const user = users.find(u => u.id === +req.params.id)
  if (!user) return res.status(404).json(fail('用户不存在'))
  res.json(ok(user))
})

// 创建用户
app.post('/api/users', (req, res) => {
  const { username, realName, phone, password, userType, role, status } = req.body
  if (!username) return res.json(fail('用户名不能为空'))
  if (users.find(u => u.username === username)) return res.json(fail('用户名已存在'))

  const newUser = {
    id: userIdCounter++,
    username,
    realName: realName || username,
    phone: phone || '',
    userType: userType || 'sub',
    role: role || 'staff',
    status: status || 'enabled',
    createdAt: now()
  }
  users.push(newUser)
  res.json(ok(newUser))
})

// 修改用户
app.put('/api/users/:id', (req, res) => {
  const user = users.find(u => u.id === +req.params.id)
  if (!user) return res.status(404).json(fail('用户不存在'))

  const { realName, phone, userType, role, status } = req.body
  if (realName !== undefined) user.realName = realName
  if (phone !== undefined) user.phone = phone
  if (userType !== undefined) user.userType = userType
  if (role !== undefined) user.role = role
  if (status !== undefined) user.status = status

  res.json(ok(user))
})

// 删除用户
app.delete('/api/users/:id', (req, res) => {
  const idx = users.findIndex(u => u.id === +req.params.id)
  if (idx === -1) return res.status(404).json(fail('用户不存在'))
  users.splice(idx, 1)
  delete userStores[+req.params.id]
  delete userWarehouses[+req.params.id]
  res.json(ok(true))
})

// 切换状态
app.put('/api/users/:id/toggle', (req, res) => {
  const user = users.find(u => u.id === +req.params.id)
  if (!user) return res.status(404).json(fail('用户不存在'))
  user.status = req.body.status || 'enabled'
  res.json(ok(user))
})

// 分配店铺
app.put('/api/users/:id/stores', (req, res) => {
  const user = users.find(u => u.id === +req.params.id)
  if (!user) return res.status(404).json(fail('用户不存在'))
  userStores[+req.params.id] = req.body.storeIds || []
  res.json(ok(true))
})

// 分配仓库
app.put('/api/users/:id/warehouses', (req, res) => {
  const user = users.find(u => u.id === +req.params.id)
  if (!user) return res.status(404).json(fail('用户不存在'))
  userWarehouses[+req.params.id] = req.body.warehouseIds || []
  res.json(ok(true))
})

// 获取用户已分配店铺
app.get('/api/users/:id/stores', (req, res) => {
  const ids = userStores[+req.params.id] || []
  const list = ids.map(sid => stores.find(s => s.id === sid)).filter(Boolean)
  res.json(ok(list))
})

// 获取用户已分配仓库
app.get('/api/users/:id/warehouses', (req, res) => {
  const ids = userWarehouses[+req.params.id] || []
  const list = ids.map(wid => warehouses.find(w => w.id === wid)).filter(Boolean)
  res.json(ok(list))
})

// ============ 店铺接口 ============

app.get('/api/stores', (req, res) => {
  const { page = 1, pageSize = 10, name, platform, status, online } = req.query
  let list = stores.filter(s => {
    if (name && !s.name.includes(name)) return false
    if (platform && s.platform !== platform) return false
    if (status && s.status !== status) return false
    if (online !== undefined && online !== '' && s.online !== +online) return false
    return true
  })
  const total = list.length
  const start = (page - 1) * pageSize
  list = list.slice(start, start + +pageSize)
  res.json(ok({ list, total }))
})

app.get('/api/stores/:id', (req, res) => {
  const store = stores.find(s => s.id === +req.params.id)
  if (!store) return res.status(404).json(fail('店铺不存在'))
  res.json(ok(store))
})

app.post('/api/stores', (req, res) => {
  const newStore = { id: stores.length + 1, ...req.body, online: 0, createdAt: now() }
  stores.push(newStore)
  res.json(ok(newStore))
})

app.put('/api/stores/:id', (req, res) => {
  const store = stores.find(s => s.id === +req.params.id)
  if (!store) return res.status(404).json(fail('店铺不存在'))
  Object.assign(store, req.body)
  res.json(ok(store))
})

app.delete('/api/stores/:id', (req, res) => {
  const idx = stores.findIndex(s => s.id === +req.params.id)
  if (idx === -1) return res.status(404).json(fail('店铺不存在'))
  stores.splice(idx, 1)
  res.json(ok(true))
})

app.put('/api/stores/:id/toggle', (req, res) => {
  const store = stores.find(s => s.id === +req.params.id)
  if (!store) return res.status(404).json(fail('店铺不存在'))
  store.status = req.body.status || 'enabled'
  res.json(ok(store))
})

// ============ 仓库接口 ============

app.get('/api/warehouses', (req, res) => {
  res.json(ok({ list: warehouses, total: warehouses.length }))
})

// ============ 启动 ============

function startServer(port = 3002) {
  app.listen(port, () => {
    console.log(`[Server] 后端服务已启动: http://localhost:${port}`)
  })
}

module.exports = { startServer }
