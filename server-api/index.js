const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })
const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')
const fs = require('fs')
const https = require('https')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const multer = require('multer')
const rateLimit = require('express-rate-limit')
const mysql = require('mysql2/promise')

// ========== 订阅系统服务 ==========
const subOrderService = require('./services/sub-order-service')
const subUserService = require('./services/sub-user-service')
const wechatPay = require('./services/wechat-pay')

const app = express()
const PORT = process.env.PORT || 3001

// ========== 环境变量校验 ==========
const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[FATAL] 环境变量 JWT_SECRET 未设置或长度不足32字符')
  process.exit(1)
}

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

// ========== MySQL 数据库连接 ==========
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3307,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'dianxiaoer',
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0
}

if (!dbConfig.password) {
  console.error('[FATAL] 环境变量 DB_PASSWORD 未设置')
  process.exit(1)
}

const dbPool = mysql.createPool(dbConfig)

async function getUserFromDB(username) {
  try {
    const [rows] = await dbPool.execute(
      'SELECT id, username, phone, role, password_hash FROM users WHERE username = ? AND status = "enabled"',
      [username]
    )
    return rows[0] || null
  } catch (err) {
    console.error('[DB] 查询用户失败:', err.message)
    return null
  }
}

// ========== SSL 证书 ==========
const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem'))
}

// ========== 数据存储 ==========
const DATA_DIR = path.join(__dirname, 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const LOCKOUT_FILE = path.join(DATA_DIR, 'lockout.json')

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

// ========== 更新文件存储 ==========
const UPDATE_DIR = path.join(__dirname, 'updates')
const HOT_DIR = path.join(UPDATE_DIR, 'hot')
const META_FILE = path.join(UPDATE_DIR, 'update-meta.json')
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
  console.error('[FATAL] 环境变量 ADMIN_PASSWORD 未设置或长度不足8字符')
  process.exit(1)
}

if (!fs.existsSync(UPDATE_DIR)) fs.mkdirSync(UPDATE_DIR, { recursive: true })
if (!fs.existsSync(HOT_DIR)) fs.mkdirSync(HOT_DIR, { recursive: true })

function readJson(filePath, defaultValue = {}) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
  } catch (e) {
    console.error(`[Error] 读取 ${filePath} 失败:`, e.message)
  }
  return defaultValue
}

function writeJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
  } catch (e) {
    console.error(`[Error] 写入 ${filePath} 失败:`, e.message)
  }
}

// ========== 登录锁定机制 ==========
const MAX_FAIL_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000 // 15分钟

function getLockoutRecord() {
  return readJson(LOCKOUT_FILE, {})
}

function setLockoutRecord(record) {
  writeJson(LOCKOUT_FILE, record)
}

function isLockedOut(username) {
  const record = getLockoutRecord()
  const entry = record[username]
  if (!entry) return false
  if (Date.now() - entry.lastFail < LOCKOUT_DURATION_MS && entry.count >= MAX_FAIL_ATTEMPTS) {
    return true
  }
  // 超过锁定时间则重置
  if (Date.now() - entry.lastFail >= LOCKOUT_DURATION_MS) {
    delete record[username]
    setLockoutRecord(record)
  }
  return false
}

function recordFailAttempt(username) {
  const record = getLockoutRecord()
  if (!record[username]) {
    record[username] = { count: 0, lastFail: 0 }
  }
  record[username].count += 1
  record[username].lastFail = Date.now()
  setLockoutRecord(record)
}

function clearFailAttempts(username) {
  const record = getLockoutRecord()
  if (record[username]) {
    delete record[username]
    setLockoutRecord(record)
  }
}

// ========== 初始化管理员账号 ==========
const INITIAL_ADMIN_PASSWORD = process.env.INITIAL_ADMIN_PASSWORD || 'Dxe@2026!Init'
function initAdmin() {
  const users = readJson(USERS_FILE, {})
  if (!users['admin']) {
    users['admin'] = {
      password: bcrypt.hashSync(INITIAL_ADMIN_PASSWORD, 10),
      phone: '',
      createdAt: new Date().toISOString()
    }
    writeJson(USERS_FILE, users)
    console.log('[API] 初始化管理员账号: admin（请尽快修改默认密码）')
  }
}
initAdmin()

// ========== 中间件 ==========

// CORS 白名单
const corsOptions = {
  origin: function (origin, callback) {
    // Electron 客户端从 file:// 协议加载时，origin 为字符串 "null" 或 undefined
    if (!origin || origin === 'null') return callback(null, true)
    if (ALLOWED_ORIGINS.length === 0) {
      // 未配置白名单时，仅允许服务器自身IP的精确来源
      const allowed = ['http://150.158.54.108:3001', 'http://150.158.54.108:3002', 'http://localhost:3001', 'http://localhost:3002']
      if (allowed.some(a => origin.startsWith(a))) return callback(null, true)
      return callback(new Error('CORS 未配置允许的来源'))
    }
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true)
    }
    console.warn(`[CORS] 拒绝来源: ${origin}`)
    callback(new Error('不允许的来源'))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-password']
}
app.use(cors(corsOptions))
app.use(bodyParser.json())

// 限流：注册每小时10次
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: '注册过于频繁，请稍后再试' },
  skipSuccessfulRequests: false
})

// 限流：登录每15分钟20次
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: '登录尝试过于频繁，请15分钟后再试' },
  skipSuccessfulRequests: false
})

// JWT 认证中间件
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization']
  if (!authHeader) {
    return res.status(401).json({ success: false, message: '未提供认证令牌' })
  }
  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ success: false, message: '认证格式错误' })
  }
  const token = parts[1]
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    req.user = decoded
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: '令牌已过期' })
    }
    return res.status(401).json({ success: false, message: '令牌无效' })
  }
}

// ========== API 路由 ==========

// 注册
app.post('/api/register', registerLimiter, async (req, res) => {
  const { username, password, phone } = req.body

  if (!username || !password || !phone) {
    return res.status(400).json({ success: false, message: '参数不完整' })
  }

  if (typeof username !== 'string' || username.length < 2 || username.length > 20) {
    return res.status(400).json({ success: false, message: '账号长度为2-20个字符' })
  }

  if (typeof password !== 'string' || password.length < 6 || password.length > 20) {
    return res.status(400).json({ success: false, message: '密码长度为6-20个字符' })
  }

  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ success: false, message: '手机号格式不正确' })
  }

  try {
    // 检查数据库中是否已存在
    const [existing] = await dbPool.execute('SELECT id FROM users WHERE username = ?', [username])
    if (existing.length) {
      return res.status(409).json({ success: false, message: '该账号已存在' })
    }

    const hashedPassword = bcrypt.hashSync(password, 10)

    // 写入MySQL数据库（注册用户默认为子账号 staff，防止注册即获得管理权限）
    const [result] = await dbPool.execute(
      `INSERT INTO users (username, phone, password_hash, user_type, role, parent_id, status, real_name)
       VALUES (?, ?, ?, 'sub', 'staff', NULL, 'enabled', ?)`,
      [username, phone, hashedPassword, username]
    )

    console.log(`[API] 新用户注册: ${username} (id=${result.insertId})`)
    res.json({ success: true, message: '注册成功' })
  } catch (err) {
    console.error('[API] 注册失败:', err.message)
    res.status(500).json({ success: false, message: '注册失败，请稍后重试' })
  }
})

// 登录
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body

  if (!username || !password) {
    return res.status(400).json({ success: false, message: '参数不完整' })
  }

  if (isLockedOut(username)) {
    return res.status(429).json({ success: false, message: '登录失败次数过多，账号已锁定15分钟' })
  }

  try {
    // 从数据库查询用户
    const user = await getUserFromDB(username)

    if (!user) {
      recordFailAttempt(username)
      return res.status(401).json({ success: false, message: '账号或密码错误' })
    }

    // 验证密码
    const valid = bcrypt.compareSync(password, user.password_hash)
    if (!valid) {
      recordFailAttempt(username)
      return res.status(401).json({ success: false, message: '账号或密码错误' })
    }

    // 登录成功，清除失败记录
    clearFailAttempts(username)

    // 签发 JWT（7天有效期）
    const accessToken = jwt.sign(
      { sub: username, phone: user.phone || '', role: user.role || 'staff' },
      JWT_SECRET,
      { expiresIn: '7d', issuer: 'dianxiaoer-api' }
    )

    // 单点登录：删除该用户旧 token，再写入新 token
    try {
      await dbPool.execute('DELETE FROM user_tokens WHERE user_id = ?', [user.id])
      await dbPool.execute(
        'INSERT INTO user_tokens (user_id, token) VALUES (?, ?)',
        [user.id, accessToken]
      )
    } catch (tokenErr) {
      console.warn('[API] 写入 user_tokens 失败（非致命）:', tokenErr.message)
    }

    console.log(`[API] 用户登录: ${username}`)
    res.json({
      success: true,
      message: '登录成功',
      accessToken,
      tokenType: 'Bearer',
      expiresIn: 604800,
      user: {
        username,
        phone: user.phone || '',
        role: user.role || 'staff'
      }
    })
  } catch (err) {
    console.error('[API] 登录错误:', err.message)
    res.status(500).json({ success: false, message: '服务器错误' })
  }
})

// 登出（删除 user_tokens 中的当前 token，实现单点登录踢出）
app.post('/api/logout', authMiddleware, async (req, res) => {
  const username = req.user.sub
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim()
  try {
    await dbPool.execute('DELETE FROM user_tokens WHERE token = ?', [token])
    console.log(`[API] 用户登出: ${username}`)
  } catch (err) {
    console.warn('[API] 登出删除 token 失败:', err.message)
  }
  res.json({ success: true, message: '已登出' })
})

// 刷新令牌
app.post('/api/refresh', authMiddleware, async (req, res) => {
  const username = req.user.sub
  
  try {
    const user = await getUserFromDB(username)
    if (!user) {
      return res.status(401).json({ success: false, message: '用户不存在' })
    }
    
    const accessToken = jwt.sign(
      { sub: username, phone: user.phone || '', role: user.role || 'staff' },
      JWT_SECRET,
      { expiresIn: '7d', issuer: 'dianxiaoer-api' }
    )
    
    res.json({
      success: true,
      accessToken,
      tokenType: 'Bearer',
      expiresIn: 604800
    })
  } catch (err) {
    console.error('[API] 刷新令牌错误:', err.message)
    res.status(500).json({ success: false, message: '服务器错误' })
  }
})

// 获取当前用户信息
app.get('/api/me', authMiddleware, async (req, res) => {
  const username = req.user.sub
  
  try {
    const user = await getUserFromDB(username)
    if (!user) {
      return res.status(404).json({ success: false, message: '用户不存在' })
    }
    
    res.json({
      success: true,
      user: {
        username,
        phone: user.phone || '',
        role: user.role || 'staff'
      }
    })
  } catch (err) {
    console.error('[API] 获取用户信息错误:', err.message)
    res.status(500).json({ success: false, message: '服务器错误' })
  }
})

// ========== 更新接口 ==========

// 静态文件服务：提供 latest.yml 和 .exe（供 electron-updater 全量更新使用）
app.use('/updates', express.static(UPDATE_DIR))

// 读取/写入 update-meta.json
function readMeta() {
  if (!fs.existsSync(META_FILE)) return { hot: null, full: null }
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf-8')) } catch (e) { return { hot: null, full: null } }
}
function writeMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2))
}

// 版本号比较
function parseVersion(v) {
  const parts = String(v || '0.0.0').split('.').map(Number)
  return parts[0] * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0)
}

// 热更新上传
const hotUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, HOT_DIR),
  filename: (req, file, cb) => {
    const ver = req.body.version || Date.now()
    cb(null, `update-${ver}.zip`)
  }
})
const hotUploadMiddleware = multer({
  storage: hotUploadStorage,
  limits: { fileSize: 100 * 1024 * 1024 }
}).single('file')

app.post('/api/update/upload', (req, res) => {
  const password = req.headers['x-admin-password']
  if (password !== ADMIN_PASSWORD) {
    return res.status(403).json({ code: 1, message: '未授权' })
  }
  hotUploadMiddleware(req, res, (err) => {
    if (err) {
      console.error('[Update] 上传失败:', err.message)
      return res.status(500).json({ code: 1, message: '上传失败: ' + err.message })
    }
    const version = req.body.version
    const changelog = req.body.changelog || ''
    const sha256 = req.body.sha256 || ''
    if (!version) {
      return res.status(400).json({ code: 1, message: 'version 不能为空' })
    }
    const filePath = path.join(HOT_DIR, `update-${version}.zip`)
    if (!fs.existsSync(filePath)) {
      return res.status(500).json({ code: 1, message: '文件保存失败' })
    }
    const stat = fs.statSync(filePath)
    // 始终基于实际保存的文件计算 SHA256，确保下载校验通过
    const hash = crypto.createHash('sha256')
    hash.update(fs.readFileSync(filePath))
    const finalSha256 = hash.digest('hex')
    const meta = readMeta()
    meta.hot = { version, changelog, filename: `update-${version}.zip`, size: stat.size, sha256: finalSha256, updatedAt: new Date().toISOString() }
    writeMeta(meta)
    console.log(`[Update] 热更新包已上传: v${version} (${(stat.size / 1024).toFixed(1)} KB)`)
    res.json({ code: 0, message: '上传成功', version, size: stat.size, sha256: finalSha256 })
  })
})

// 全量更新通知
app.post('/api/update/notify-full', (req, res) => {
  const password = req.headers['x-admin-password']
  if (password !== ADMIN_PASSWORD) {
    return res.status(403).json({ code: 1, message: '未授权' })
  }
  const { version, changelog } = req.body || {}
  if (!version) {
    return res.status(400).json({ code: 1, message: 'version 不能为空' })
  }
  const meta = readMeta()
  const fullInfo = { version, changelog: changelog || '', updatedAt: new Date().toISOString() }
  meta.full = fullInfo
  meta.fullUpdate = fullInfo
  meta.latestVersion = version
  meta.releaseDate = new Date().toISOString()
  writeMeta(meta)
  console.log(`[Update] 全量更新已登记: v${version}`)
  res.json({ code: 0, message: '全量更新登记成功', version })
})

// 统一检查更新
// 更新优先级规则（v3）：热更新仅 renderer，必须先全量再热更新
// 1. appVersion < fullVersion → 返回全量更新（必须先升级主进程）
// 2. appVersion >= fullVersion 且 hotVersion > currentVersion → 返回热更新
// 3. 热更新之间可跳版本，但不可跳过主进程全量更新
app.get('/api/update/check', (req, res) => {
  try {
    const meta = readMeta()
    const currentVersion = req.query.version || '0.0.0'
    const appVersion = req.query.appVersion || ''
    const currentNum = parseVersion(currentVersion)

    // 支持两种字段名格式：fullUpdate 和 full
    const full = meta.fullUpdate || meta.full
    // 支持两种字段名格式：hotfix 和 hot
    const hot = meta.hotfix || meta.hot

    const fullNum = full ? parseVersion(full.version) : 0
    const hotNum = hot ? parseVersion(hot.version) : 0
    const appNum = appVersion ? parseVersion(appVersion) : 0

    // 规则1：appVersion < fullVersion → 必须全量更新
    if (appVersion && full && fullNum > appNum) {
      console.log('[Update] base outdated: appVersion=' + appVersion + ', fullVersion=' + full.version + ', returning full update')
      return res.json({
        needUpdate: true,
        updateType: 'full',
        version: full.version,
        changelog: full.changelog || '',
        force: false
      })
    }

    // 规则2：基础版本已达标，检查热更新（hotVersion > currentVersion）
    if (hot && hotNum > currentNum) {
      return res.json({
        needUpdate: true,
        updateType: 'hot',
        version: hot.version,
        changelog: hot.changelog || '',
        size: hot.size || 0,
        sha256: hot.sha256 || '',
        updatedAt: hot.updatedAt
      })
    }

    res.json({ needUpdate: false, updateType: 'none' })
  } catch (err) {
    console.error('[Update] 检查失败:', err.message)
    res.status(500).json({ needUpdate: false, error: err.message })
  }
})

// 热更新下载（需要 JWT 认证，防止未授权下载源码包）
app.get('/api/update/download', (req, res) => {
  try {
    const meta = readMeta()
    if (!meta.hot) {
      return res.status(404).json({ code: 1, message: '暂无热更新包' })
    }
    const filePath = path.join(HOT_DIR, meta.hot.filename)
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ code: 1, message: '热更新包文件不存在' })
    }
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename=${meta.hot.filename}`)
    res.setHeader('Content-Length', fs.statSync(filePath).size)
    fs.createReadStream(filePath).pipe(res)
  } catch (err) {
    console.error('[Update] 下载失败:', err.message)
    res.status(500).json({ code: 1, message: err.message })
  }
})

// ========== 订阅系统路由 ==========

// 版本等级顺序（用于判断升级）
const TIER_ORDER = { basic: 1, standard: 2, premium: 3 }

// 通过 username 查询 owner_id（主账号为自己 id，子账号取 parent_id）
async function getOwnerIdFromUsername(username) {
  const [rows] = await dbPool.execute(
    'SELECT id, user_type, parent_id FROM users WHERE username = ? AND status = "enabled"',
    [username]
  )
  if (!rows.length) return null
  const user = rows[0]
  return user.user_type === 'master' ? user.id : user.parent_id
}

// 检查订阅状态（需登录）
app.get('/api/subscription/status', authMiddleware, async (req, res) => {
  try {
    const username = req.user.sub
    const ownerId = await getOwnerIdFromUsername(username)
    if (!ownerId) {
      return res.status(404).json({ success: false, message: '用户不存在' })
    }

    const sub = await subUserService.findOrCreateSubscription(ownerId, username)
    const status = subUserService.getUserStatus(sub)
    const daysRemaining = subUserService.getDaysRemaining(sub)
    const tier = subUserService.getUserTier(sub)
    const isFirst = await subOrderService.isFirstPayment(ownerId)

    res.json({
      success: true,
      status,
      tier,
      tier_label: subUserService.TIER_LABELS[tier] || tier,
      days_remaining: daysRemaining,
      trial_end: sub.trial_end,
      subscription_end: sub.subscription_end,
      is_first_payment: isFirst,
      pricing: subOrderService.TIER_PRICING,
      server_time: new Date().toISOString()
    })
  } catch (err) {
    console.error('[订阅] 查询状态失败:', err.message)
    res.status(500).json({ success: false, message: '服务器错误' })
  }
})

// 创建支付订单（需登录）
app.post('/api/subscription/create-order', authMiddleware, async (req, res) => {
  try {
    const username = req.user.sub
    const ownerId = await getOwnerIdFromUsername(username)
    if (!ownerId) {
      return res.status(404).json({ success: false, message: '用户不存在' })
    }

    const { tier, plan } = req.body
    const VALID_TIERS = ['basic', 'standard', 'premium']
    const VALID_PLANS = ['monthly', 'quarterly', 'yearly']
    if (!VALID_TIERS.includes(tier) || !VALID_PLANS.includes(plan)) {
      return res.status(400).json({ success: false, message: '无效的套餐类型' })
    }

    // 升级抵扣计算
    let discountAmount = 0
    const sub = await subUserService.findOrCreateSubscription(ownerId, username)
    const subStatus = subUserService.getUserStatus(sub)
    const currentTier = subUserService.getUserTier(sub)
    if (subStatus === 'active' && TIER_ORDER[currentTier] < TIER_ORDER[tier]) {
      const { remainingValue } = subUserService.calculateRemainingValue(sub)
      const originalPrice = subOrderService.TIER_PRICING[tier]?.[plan] || 0
      discountAmount = Math.min(remainingValue, originalPrice)
    }

    // 创建内部订单
    const order = await subOrderService.createOrder(username, ownerId, tier, plan, discountAmount)

    // 调用微信支付创建 Native Pay 订单
    const wxResult = await wechatPay.createNativeOrder(
      order.orderNo,
      order.amount,
      `店小二 - ${order.label}`
    )

    // 保存微信支付信息
    await subOrderService.updateOrderWxInfo(order.orderNo, wxResult.code_url)

    // 记录日志
    await subOrderService.logPaymentEvent(order.orderNo, 'created', {
      username, owner_id: ownerId, tier, plan,
      code_url: wxResult.code_url, discount_amount: discountAmount
    })

    res.json({
      success: true,
      order_no: order.orderNo,
      code_url: wxResult.code_url,
      amount: order.amount,
      original_amount: order.originalAmount,
      discount_amount: order.discountAmount,
      plan: order.plan,
      tier: order.tier,
      label: order.label
    })
  } catch (err) {
    console.error('[订阅] 创建订单失败:', err.message)
    res.status(500).json({ success: false, message: err.message || '创建订单失败' })
  }
})

// 按店铺创建订阅订单（需登录）
app.post('/api/subscription/create-store-order', authMiddleware, async (req, res) => {
  try {
    const username = req.user.sub
    const ownerId = await getOwnerIdFromUsername(username)
    if (!ownerId) {
      return res.status(404).json({ success: false, message: '用户不存在' })
    }

    const { store_ids, plan } = req.body
    const VALID_PLANS = ['monthly', 'quarterly', 'half_yearly']
    if (!Array.isArray(store_ids) || store_ids.length === 0) {
      return res.status(400).json({ success: false, message: '请至少选择一个店铺' })
    }
    if (!VALID_PLANS.includes(plan)) {
      return res.status(400).json({ success: false, message: '无效的套餐类型' })
    }

    // 创建内部订单
    const order = await subOrderService.createStoreOrder(username, ownerId, store_ids, plan)

    // 调用微信支付创建 Native Pay 订单
    const wxResult = await wechatPay.createNativeOrder(
      order.orderNo,
      order.amount,
      `店小二 - 店铺订阅${order.label}`
    )

    // 保存微信支付信息
    await subOrderService.updateOrderWxInfo(order.orderNo, wxResult.code_url)

    // 记录日志
    await subOrderService.logPaymentEvent(order.orderNo, 'store_order_created', {
      username, owner_id: ownerId, store_ids, plan,
      store_count: store_ids.length, amount: order.amount,
      code_url: wxResult.code_url
    })

    res.json({
      success: true,
      order_no: order.orderNo,
      code_url: wxResult.code_url,
      amount: order.amount,
      plan: order.plan,
      tier: order.tier,
      label: order.label
    })
  } catch (err) {
    console.error('[订阅] 创建店铺订单失败:', err.message)
    res.status(500).json({ success: false, message: err.message || '创建订单失败' })
  }
})

// 查询订单状态（需登录）
app.get('/api/subscription/query-order', authMiddleware, async (req, res) => {
  try {
    const { order_no } = req.query
    if (!order_no) {
      return res.status(400).json({ success: false, message: '缺少订单号' })
    }

    // 过期老订单
    await subOrderService.expireOldOrders()

    const order = await subOrderService.getOrder(order_no)
    if (!order) {
      return res.status(404).json({ success: false, message: '订单不存在' })
    }

    // 如果订单还是 pending，主动向微信查询真实支付状态
    if (order.status === 'pending') {
      try {
        const wxResult = await wechatPay.queryOrderStatus(order_no)
        if (wxResult.trade_state === 'SUCCESS') {
          // 校验金额
          const wxAmount = wxResult.amount && wxResult.amount.total
          if (wxAmount !== undefined && wxAmount !== order.amount) {
            await subOrderService.logPaymentEvent(order_no, 'amount_mismatch', { expected: order.amount, actual: wxAmount })
            return res.json({ success: true, status: order.status, paid_at: order.paid_at })
          }
          // 微信已支付，处理支付成功逻辑
          const wxTransactionId = wxResult.transaction_id || ''
          const isNewlyPaid = await subOrderService.markOrderPaid(order_no, wxTransactionId)
          if (isNewlyPaid) {
            const isUpgrade = (order.discount_amount || 0) > 0
            await subUserService.extendSubscription(order.owner_id, order.plan, order.tier, isUpgrade)
          }

          await subOrderService.logPaymentEvent(order_no, 'payment_completed_via_query', {
            username: order.username, owner_id: order.owner_id,
            plan: order.plan, tier: order.tier, wx_transaction_id: wxTransactionId
          })

          return res.json({ success: true, status: 'paid', paid_at: new Date().toISOString() })
        }
      } catch (wxErr) {
        console.error('[订阅] 微信订单查询失败:', wxErr.message)
      }
    }

    res.json({
      success: true,
      status: order.status,
      paid_at: order.paid_at
    })
  } catch (err) {
    console.error('[订阅] 查询订单失败:', err.message)
    res.status(500).json({ success: false, message: '查询失败' })
  }
})

// 微信支付回调通知（公开接口，不需要认证）
app.post('/api/subscription/notify', async (req, res) => {
  try {
    const body = req.body

    await subOrderService.logPaymentEvent(null, 'wx_notify', body)

    if (body.event_type !== 'TRANSACTION.SUCCESS') {
      return res.json({ code: 'SUCCESS', message: '成功' })
    }

    // 解密通知内容
    const transaction = wechatPay.decryptNotification(body.resource)
    const orderNo = transaction.out_trade_no
    const wxTransactionId = transaction.transaction_id

    await subOrderService.logPaymentEvent(orderNo, 'wx_notify_decrypted', transaction)

    // 查找订单
    const order = await subOrderService.getOrder(orderNo)
    if (!order || order.status !== 'pending') {
      return res.json({ code: 'SUCCESS', message: '成功' })
    }

    // 校验金额
    const wxAmount = transaction.amount && transaction.amount.total
    if (wxAmount !== undefined && wxAmount !== order.amount) {
      await subOrderService.logPaymentEvent(orderNo, 'amount_mismatch', { expected: order.amount, actual: wxAmount })
      return res.json({ code: 'SUCCESS', message: '成功' })
    }

    // 标记订单为已支付
    const isNewlyPaid = await subOrderService.markOrderPaid(orderNo, wxTransactionId)
    if (!isNewlyPaid) {
      return res.json({ code: 'SUCCESS', message: '成功' })
    }

    // 延长订阅
    const isUpgrade = (order.discount_amount || 0) > 0

    if (order.tier === 'store' && order.store_ids) {
      // 店铺订阅：更新每个店铺的到期时间
      const storeIds = typeof order.store_ids === 'string' ? JSON.parse(order.store_ids) : order.store_ids
      await subUserService.extendStoreSubscription(storeIds, order.plan)
      await subOrderService.logPaymentEvent(orderNo, 'store_subscription_extended', { store_ids: storeIds, plan: order.plan })
    } else {
      // 账号订阅：更新用户级订阅
      await subUserService.extendSubscription(order.owner_id, order.plan, order.tier, isUpgrade)
    }

    await subOrderService.logPaymentEvent(orderNo, 'payment_completed', {
      username: order.username, owner_id: order.owner_id,
      plan: order.plan, tier: order.tier, wx_transaction_id: wxTransactionId
    })

    res.json({ code: 'SUCCESS', message: '成功' })
  } catch (err) {
    console.error('[订阅] 微信回调处理失败:', err.message)
    res.status(500).json({ code: 'FAIL', message: '处理失败' })
  }
})

// ========== 管理后台静态页面 ==========
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')))

// ========== 管理后台 API ==========

// 管理员密码校验中间件
function adminAuth(req, res, next) {
  const password = req.headers['x-admin-password']
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, message: '管理员密码错误' })
  }
  next()
}

// 获取所有店铺（含到期时间、归属用户）
app.get('/api/admin/stores', adminAuth, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, username, storeName, merchantId, status, expired } = req.query
    const limit = Math.max(1, parseInt(pageSize, 10) || 20)
    const offset = Math.max(0, ((parseInt(page, 10) || 1) - 1) * limit)

    let where = 'WHERE 1=1'
    const params = []
    if (username) { where += ' AND u.username LIKE ?'; params.push(`%${username}%`) }
    if (storeName) { where += ' AND s.name LIKE ?'; params.push(`%${storeName}%`) }
    if (merchantId) { where += ' AND s.merchant_id LIKE ?'; params.push(`%${merchantId}%`) }
    if (status) { where += ' AND s.status = ?'; params.push(status) }
    if (expired === 'yes') {
      where += ' AND s.subscription_end IS NOT NULL AND s.subscription_end < CURDATE()'
    } else if (expired === 'no') {
      where += ' AND (s.subscription_end IS NULL OR s.subscription_end >= CURDATE())'
    }

    const [countRows] = await dbPool.execute(
      `SELECT COUNT(*) as total FROM stores s LEFT JOIN users u ON s.owner_id = u.id ${where}`, params
    )
    const total = countRows[0].total

    const [rows] = await dbPool.execute(
      `SELECT s.id, s.name, s.platform, s.store_type, s.merchant_id, s.shop_id,
              s.account AS store_username, s.status, s.subscription_end, s.created_at,
              s.owner_id, u.username AS owner_username, u.phone AS owner_phone
       FROM stores s
       LEFT JOIN users u ON s.owner_id = u.id
       ${where}
       ORDER BY u.username ASC, s.id ASC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    )

    res.json({
      success: true,
      data: {
        list: rows.map(r => ({
          id: r.id, name: r.name, platform: r.platform, storeType: r.store_type,
          merchantId: r.merchant_id, storeId: r.shop_id, storeUsername: r.store_username,
          status: r.status, subscriptionEnd: r.subscription_end, createdAt: r.created_at,
          ownerId: r.owner_id, ownerUsername: r.owner_username || '-', ownerPhone: r.owner_phone || ''
        })),
        total
      }
    })
  } catch (err) {
    console.error('[Admin] 获取店铺列表失败:', err.message)
    res.status(500).json({ success: false, message: err.message })
  }
})

// 批量修改到期时间（必须放在 :id 路由之前，否则 batch 会被当成 id）
app.put('/api/admin/stores/batch-subscription-end', adminAuth, async (req, res) => {
  try {
    const { storeIds, subscriptionEnd } = req.body
    if (!storeIds?.length) return res.json({ success: false, message: '请选择至少一个店铺' })
    if (!subscriptionEnd) return res.json({ success: false, message: '到期时间不能为空' })
    const date = new Date(subscriptionEnd)
    if (isNaN(date.getTime())) return res.json({ success: false, message: '日期格式无效' })
    const dateStr = date.toISOString().slice(0, 10)

    // 确保 storeIds 为数字
    const numericIds = storeIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id))
    if (!numericIds.length) return res.json({ success: false, message: '店铺ID无效' })
    const placeholders = numericIds.map(() => '?').join(',')

    console.log('[Admin] 批量修改到期:', { ids: numericIds, dateStr })
    await dbPool.query(`UPDATE stores SET subscription_end = ? WHERE id IN (${placeholders})`, [dateStr, ...numericIds])
    if (date < new Date()) {
      await dbPool.query(`UPDATE stores SET status = 'disabled' WHERE id IN (${placeholders}) AND status = 'enabled'`, numericIds)
    }
    res.json({ success: true, data: { updated: numericIds.length, subscriptionEnd: dateStr } })
  } catch (err) {
    console.error('[Admin] 批量修改失败:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// 修改单个店铺到期时间
app.put('/api/admin/stores/:id/subscription-end', adminAuth, async (req, res) => {
  try {
    const { subscriptionEnd } = req.body
    if (!subscriptionEnd) return res.json({ success: false, message: '到期时间不能为空' })
    const date = new Date(subscriptionEnd)
    if (isNaN(date.getTime())) return res.json({ success: false, message: '日期格式无效' })
    const dateStr = date.toISOString().slice(0, 10)

    await dbPool.execute('UPDATE stores SET subscription_end = ? WHERE id = ?', [dateStr, req.params.id])
    if (date < new Date()) {
      await dbPool.execute("UPDATE stores SET status = 'disabled' WHERE id = ? AND status = 'enabled'", [req.params.id])
    }
    res.json({ success: true, data: { id: req.params.id, subscriptionEnd: dateStr } })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// 获取所有主账号用户
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const [rows] = await dbPool.execute(
      `SELECT u.id, u.username, u.phone, u.user_type, u.role, u.status, u.created_at,
              (SELECT COUNT(*) FROM stores s WHERE s.owner_id = u.id) AS store_count
       FROM users u WHERE u.user_type = 'master' ORDER BY u.username ASC`
    )
    res.json({ success: true, data: { list: rows } })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// 修改用户状态（启用/停用）
app.put('/api/admin/users/:id/status', adminAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10)
    if (isNaN(userId)) return res.status(400).json({ success: false, message: '无效的用户ID' })
    const { status } = req.body
    if (!['enabled', 'disabled'].includes(status)) {
      return res.status(400).json({ success: false, message: '状态值无效，应为 enabled 或 disabled' })
    }
    const [result] = await dbPool.execute('UPDATE users SET status = ? WHERE id = ?', [status, userId])
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: '用户不存在' })
    }
    res.json({ success: true, data: { id: userId, status } })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// 删除用户
app.delete('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10)
    if (isNaN(userId)) return res.status(400).json({ success: false, message: '无效的用户ID' })

    // 检查用户是否存在及是否有关联店铺
    const [userRows] = await dbPool.execute('SELECT id, username, user_type FROM users WHERE id = ?', [userId])
    if (userRows.length === 0) {
      return res.status(404).json({ success: false, message: '用户不存在' })
    }
    const [storeRows] = await dbPool.execute('SELECT COUNT(*) as count FROM stores WHERE owner_id = ?', [userId])
    if (storeRows[0].count > 0) {
      return res.status(400).json({ success: false, message: `该用户下还有 ${storeRows[0].count} 个店铺，请先处理店铺后再删除` })
    }

    // 删除关联数据
    await dbPool.execute('DELETE FROM user_tokens WHERE user_id = ?', [userId])
    const [result] = await dbPool.execute('DELETE FROM users WHERE id = ?', [userId])
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: '用户不存在' })
    }
    res.json({ success: true, data: { id: userId } })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// 获取所有订阅订单
app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, startDate, endDate, status } = req.query
    const limit = Math.max(1, parseInt(pageSize, 10) || 20)
    const offset = Math.max(0, ((parseInt(page, 10) || 1) - 1) * limit)

    // 构建查询条件
    let where = ' WHERE 1=1'
    const params = []
    if (startDate) { where += ' AND o.created_at >= ?'; params.push(startDate + ' 00:00:00') }
    if (endDate) { where += ' AND o.created_at <= ?'; params.push(endDate + ' 23:59:59') }
    if (status) { where += ' AND o.status = ?'; params.push(status) }

    const [countRows] = await dbPool.query('SELECT COUNT(*) as total FROM subscription_orders o' + where, params)
    const total = countRows[0].total

    // 累计已支付金额
    let paidWhere = where + " AND o.status = 'paid'"
    const [sumRows] = await dbPool.query('SELECT COALESCE(SUM(o.amount), 0) as totalAmount, COUNT(*) as paidCount FROM subscription_orders o' + paidWhere, params)
    const totalAmount = sumRows[0].totalAmount
    const paidCount = sumRows[0].paidCount

    const [rows] = await dbPool.query(
      `SELECT o.id, o.order_no, o.owner_id, o.username, o.tier, o.plan, o.amount,
              o.status, o.store_ids, o.created_at, o.paid_at,
              u.phone AS owner_phone
       FROM subscription_orders o
       LEFT JOIN users u ON o.owner_id = u.id` + where +
      ` ORDER BY o.id DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    )

    // 解析 store_ids，查店铺名称
    const allStoreIds = new Set()
    rows.forEach(o => {
      if (o.store_ids) {
        try {
          const ids = typeof o.store_ids === 'string' ? JSON.parse(o.store_ids) : o.store_ids
          if (Array.isArray(ids)) ids.forEach(id => allStoreIds.add(id))
        } catch {}
      }
    })
    let storeMap = {}
    if (allStoreIds.size > 0) {
      const ids = Array.from(allStoreIds)
      const placeholders = ids.map(() => '?').join(',')
      const [storeRows] = await dbPool.execute(
        `SELECT id, name FROM stores WHERE id IN (${placeholders})`,
        ids
      )
      storeMap = Object.fromEntries(storeRows.map(s => [s.id, s.name]))
    }
    rows.forEach(o => {
      if (o.store_ids) {
        try {
          const ids = typeof o.store_ids === 'string' ? JSON.parse(o.store_ids) : o.store_ids
          o.storeInfo = Array.isArray(ids) ? ids.map(id => `${storeMap[id] || '未知店铺'} [${id}]`).join(', ') : null
        } catch { o.storeInfo = null }
      } else {
        o.storeInfo = null
      }
    })

    res.json({ success: true, data: { list: rows, total, totalAmount, paidCount } })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('[API Error]', err.message)
  if (res.headersSent) return next(err)
  res.status(500).json({ success: false, message: '服务器内部错误' })
})

// ========== 数据库迁移：subscription_orders 表添加 store_ids 列 ==========
async function runMigrations() {
  try {
    await dbPool.execute(`ALTER TABLE subscription_orders ADD COLUMN store_ids JSON DEFAULT NULL AFTER tier`)
    console.log('[迁移] subscription_orders.store_ids 列已添加')
  } catch (e) {
    if (e.code === 'ER_DUP_FIELDNAME') {
      console.log('[迁移] store_ids 列已存在，跳过')
    } else {
      console.error('[迁移] 添加 store_ids 列失败:', e.message)
    }
  }
}

// HTTP 服务器（仅 HTTP，新版本客户端正常更新）
const http = require('http')
http.createServer(app).listen(PORT, '0.0.0.0', async () => {
  console.log(`[API] 店小二后端服务已启动: http://0.0.0.0:${PORT}`)
  await runMigrations()
})
