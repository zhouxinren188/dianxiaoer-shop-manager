const express = require('express')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
const { app: electronApp } = require('electron')

const app = express()
app.use(cors())
app.use(express.json())

// ============ 本地文件持久化 ============
function getDataDir() {
  // Electron 用户数据目录：C:\Users\xxx\AppData\Roaming\dianxiaoer-shop-manager
  return electronApp.getPath('userData')
}

function loadJson(filename, defaults) {
  const filePath = path.join(getDataDir(), filename)
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    }
  } catch (e) {
    console.error(`[DB] 加载 ${filename} 失败:`, e.message)
  }
  return defaults
}

function saveJson(filename, data) {
  const dir = getDataDir()
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf8')
  } catch (e) {
    console.error(`[DB] 保存 ${filename} 失败:`, e.message)
  }
}

// ============ 内存数据库 ============
let userIdCounter = 3
const users = [
  { id: 1, username: 'admin', realName: '系统管理员', phone: '13800138000', userType: 'master', role: 'super_admin', status: 'enabled', createdAt: '2026-04-01 10:00:00' },
  { id: 2, username: 'staff01', realName: '张三', phone: '13900139000', userType: 'sub', role: 'staff', status: 'enabled', createdAt: '2026-04-15 14:30:00' }
]

const userStores = { 2: [1] }   // userId -> storeIds
const userWarehouses = { 2: [1] } // userId -> warehouseIds

// 店铺数据：从本地文件加载，变更时保存
const STORE_FILE = 'stores.json'
const defaultStores = [
  { id: 1, name: '京东旗舰店', platform: 'jd', account: 'jdshop001', merchant_id: 'M001', shop_id: 'S001', tags: ['自营'], online: 0, status: 'enabled' },
  { id: 2, name: '天猫专营店', platform: 'tmall', account: 'tmall001', merchant_id: 'M002', shop_id: 'S002', tags: ['品牌'], online: 0, status: 'enabled' },
  { id: 3, name: '淘宝小店', platform: 'taobao', account: 'tb001', merchant_id: 'M003', shop_id: 'S003', tags: [], online: 0, status: 'disabled' }
]

const stores = loadJson(STORE_FILE, defaultStores)
let storeIdCounter = stores.length > 0 ? Math.max(...stores.map(s => s.id)) + 1 : 1

function saveStores() {
  saveJson(STORE_FILE, stores)
}

// 仓库数据：从本地文件加载，变更时保存
const WAREHOUSE_FILE = 'warehouses.json'
const defaultWarehouses = [
  { id: 1, name: '默认仓库', code: 'WH001', location: '浙江省杭州市', contact: '', phone: '', status: 'enabled', createdAt: '2026-01-15 09:30:00' },
  { id: 2, name: '华东仓', code: 'WH002', location: '江苏省苏州市', contact: '', phone: '', status: 'enabled', createdAt: '2026-03-20 14:20:00' },
  { id: 3, name: '华南仓', code: 'WH003', location: '广东省深圳市', contact: '', phone: '', status: 'enabled', createdAt: '2026-03-21 10:00:00' },
  { id: 4, name: '华北仓', code: 'WH004', location: '北京市', contact: '', phone: '', status: 'disabled', createdAt: '2026-03-22 11:00:00' }
]

const warehouses = loadJson(WAREHOUSE_FILE, defaultWarehouses)
let warehouseIdCounter = warehouses.length > 0 ? Math.max(...warehouses.map(w => w.id)) + 1 : 1

function saveWarehouses() {
  saveJson(WAREHOUSE_FILE, warehouses)
}

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
  const newStore = {
    id: storeIdCounter++,
    name: req.body.name || '',
    platform: req.body.platform || '',
    account: req.body.account || '',
    password: req.body.password || '',
    merchant_id: req.body.merchant_id || '',
    shop_id: req.body.shop_id || '',
    tags: req.body.tags || [],
    status: req.body.status || 'enabled',
    online: 0,
    createdAt: now()
  }
  stores.push(newStore)
  saveStores()
  res.json(ok(newStore))
})

app.put('/api/stores/:id', (req, res) => {
  const store = stores.find(s => s.id === +req.params.id)
  if (!store) return res.status(404).json(fail('店铺不存在'))
  Object.assign(store, req.body)
  saveStores()
  res.json(ok(store))
})

app.delete('/api/stores/:id', (req, res) => {
  const idx = stores.findIndex(s => s.id === +req.params.id)
  if (idx === -1) return res.status(404).json(fail('店铺不存在'))
  stores.splice(idx, 1)
  saveStores()
  res.json(ok(true))
})

app.put('/api/stores/:id/toggle', (req, res) => {
  const store = stores.find(s => s.id === +req.params.id)
  if (!store) return res.status(404).json(fail('店铺不存在'))
  store.status = req.body.status || 'enabled'
  saveStores()
  res.json(ok(store))
})

// 更新店铺在线状态
app.put('/api/stores/:id/status', (req, res) => {
  const store = stores.find(s => s.id === +req.params.id)
  if (!store) return res.status(404).json(fail('店铺不存在'))
  store.online = req.body.online ? 1 : 0
  saveStores()
  res.json(ok(store))
})

// ============ Cookie 接口 ============

// Cookie 数据：从本地文件加载，变更时保存
const COOKIE_FILE = 'cookies.json'
const cookieStore = loadJson(COOKIE_FILE, {})  // storeId -> { store_id, cookie_data, domain, saved_at }

function saveCookies() {
  saveJson(COOKIE_FILE, cookieStore)
}

// 获取所有 Cookie（心跳检测用）
app.get('/api/cookies', (req, res) => {
  const list = Object.values(cookieStore).map(c => {
    const s = stores.find(x => x.id === c.store_id)
    return {
      store_id: c.store_id,
      cookie_data: c.cookie_data,
      domain: c.domain,
      saved_at: c.saved_at,
      platform: s ? s.platform : '',
      store_name: s ? s.name : ''
    }
  }).filter(c => {
    const s = stores.find(x => x.id === c.store_id)
    return s && s.status === 'enabled'
  })
  res.json(ok(list))
})

// 获取指定店铺 Cookie
app.get('/api/cookies/:storeId', (req, res) => {
  const cookie = cookieStore[+req.params.storeId]
  if (!cookie) return res.json(ok(null))
  res.json(ok(cookie))
})

// 保存/更新 Cookie
app.post('/api/cookies', (req, res) => {
  const { store_id, cookie_data, domain } = req.body
  if (!store_id || !cookie_data) {
    return res.json(fail('store_id 和 cookie_data 为必填项'))
  }
  cookieStore[+store_id] = {
    store_id: +store_id,
    cookie_data: typeof cookie_data === 'string' ? cookie_data : JSON.stringify(cookie_data),
    domain: domain || '',
    saved_at: now()
  }
  saveCookies()
  res.json(ok(true))
})

// 删除指定店铺 Cookie
app.delete('/api/cookies/:storeId', (req, res) => {
  delete cookieStore[+req.params.storeId]
  saveCookies()
  res.json(ok(true))
})

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'dianxiaoer-business' })
})

// ============ 仓库接口 ============

app.get('/api/warehouses', (req, res) => {
  res.json(ok({ list: warehouses, total: warehouses.length }))
})

app.get('/api/warehouses/:id', (req, res) => {
  const wh = warehouses.find(w => w.id === +req.params.id)
  if (!wh) return res.status(404).json(fail('仓库不存在'))
  res.json(ok(wh))
})

app.post('/api/warehouses', (req, res) => {
  const { name, location, contact, phone, status } = req.body
  if (!name) return res.json(fail('仓库名称不能为空'))
  const newWh = {
    id: warehouseIdCounter++,
    name,
    code: '',
    location: location || '',
    contact: contact || '',
    phone: phone || '',
    status: status || 'enabled',
    createdAt: now()
  }
  warehouses.push(newWh)
  saveWarehouses()
  res.json(ok(newWh))
})

app.put('/api/warehouses/:id', (req, res) => {
  const wh = warehouses.find(w => w.id === +req.params.id)
  if (!wh) return res.status(404).json(fail('仓库不存在'))
  const allowed = ['name', 'code', 'location', 'contact', 'phone', 'status']
  for (const key of allowed) {
    if (req.body[key] !== undefined) wh[key] = req.body[key]
  }
  saveWarehouses()
  res.json(ok(wh))
})

app.delete('/api/warehouses/:id', (req, res) => {
  const idx = warehouses.findIndex(w => w.id === +req.params.id)
  if (idx === -1) return res.status(404).json(fail('仓库不存在'))
  warehouses.splice(idx, 1)
  saveWarehouses()
  res.json(ok(true))
})

// ============ 采购账号接口 ============

const PURCHASE_ACCOUNT_FILE = 'purchase-accounts.json'
const purchaseAccounts = loadJson(PURCHASE_ACCOUNT_FILE, [])
let purchaseAccountIdCounter = purchaseAccounts.length > 0 ? Math.max(...purchaseAccounts.map(a => a.id)) + 1 : 1

function savePurchaseAccounts() {
  saveJson(PURCHASE_ACCOUNT_FILE, purchaseAccounts)
}

// 采购账号 Cookie 存储
const PURCHASE_COOKIE_FILE = 'purchase-cookies.json'
const purchaseCookieStore = loadJson(PURCHASE_COOKIE_FILE, {})

function savePurchaseCookies() {
  saveJson(PURCHASE_COOKIE_FILE, purchaseCookieStore)
}

// 获取采购账号列表
app.get('/api/purchase-accounts', (req, res) => {
  const list = purchaseAccounts.map(a => ({
    ...a,
    password: a.password || ''
  }))
  res.json(ok({ list, total: list.length }))
})

// 获取单个采购账号
app.get('/api/purchase-accounts/:id', (req, res) => {
  const acc = purchaseAccounts.find(a => a.id === +req.params.id)
  if (!acc) return res.status(404).json(fail('采购账号不存在'))
  res.json(ok(acc))
})

// 创建采购账号
app.post('/api/purchase-accounts', (req, res) => {
  const newAcc = {
    id: purchaseAccountIdCounter++,
    account: req.body.account || '',
    password: req.body.password || '',
    platform: req.body.platform || '',
    online: false,
    createdAt: now()
  }
  purchaseAccounts.push(newAcc)
  savePurchaseAccounts()
  res.json(ok(newAcc))
})

// 更新采购账号
app.put('/api/purchase-accounts/:id', (req, res) => {
  const acc = purchaseAccounts.find(a => a.id === +req.params.id)
  if (!acc) return res.status(404).json(fail('采购账号不存在'))
  if (req.body.account !== undefined) acc.account = req.body.account
  if (req.body.password !== undefined) acc.password = req.body.password
  if (req.body.platform !== undefined) acc.platform = req.body.platform
  if (req.body.online !== undefined) acc.online = !!req.body.online
  savePurchaseAccounts()
  res.json(ok(acc))
})

// 删除采购账号
app.delete('/api/purchase-accounts/:id', (req, res) => {
  const idx = purchaseAccounts.findIndex(a => a.id === +req.params.id)
  if (idx === -1) return res.status(404).json(fail('采购账号不存在'))
  purchaseAccounts.splice(idx, 1)
  delete purchaseCookieStore[+req.params.id]
  savePurchaseAccounts()
  savePurchaseCookies()
  res.json(ok(true))
})

// 更新采购账号在线状态
app.put('/api/purchase-accounts/:id/status', (req, res) => {
  const acc = purchaseAccounts.find(a => a.id === +req.params.id)
  if (!acc) return res.status(404).json(fail('采购账号不存在'))
  acc.online = !!req.body.online
  savePurchaseAccounts()
  res.json(ok(acc))
})

// 获取采购账号 Cookie
app.get('/api/purchase-accounts/:id/cookie', (req, res) => {
  const cookie = purchaseCookieStore[+req.params.id]
  res.json(ok(cookie || null))
})

// 保存采购账号 Cookie
app.post('/api/purchase-accounts/:id/cookie', (req, res) => {
  const { cookie_data, platform } = req.body
  if (!cookie_data) return res.json(fail('cookie_data 为必填项'))
  purchaseCookieStore[+req.params.id] = {
    account_id: +req.params.id,
    cookie_data: typeof cookie_data === 'string' ? cookie_data : JSON.stringify(cookie_data),
    platform: platform || '',
    saved_at: now()
  }
  savePurchaseCookies()
  res.json(ok(true))
})

// ============ 启动 ============

function startServer(port = 3002) {
  app.listen(port, () => {
    console.log(`[Server] 后端服务已启动: http://localhost:${port}`)
  })
}

module.exports = { startServer }
