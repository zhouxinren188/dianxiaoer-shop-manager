require('dotenv').config()
const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')
const fs = require('fs')
const path = require('path')
const https = require('https')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const rateLimit = require('express-rate-limit')

const app = express()
const PORT = process.env.PORT || 3000

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
function initAdmin() {
  const users = readJson(USERS_FILE, {})
  if (!users['admin']) {
    users['admin'] = {
      password: bcrypt.hashSync('admin', 10),
      phone: '',
      createdAt: new Date().toISOString()
    }
    writeJson(USERS_FILE, users)
    console.log('[API] 初始化管理员账号: admin')
  }
}
initAdmin()

// ========== 中间件 ==========

// CORS 白名单
const corsOptions = {
  origin: function (origin, callback) {
    // Electron 客户端无 origin，允许 null/undefined
    if (!origin) return callback(null, true)
    if (ALLOWED_ORIGINS.length === 0) {
      // 未配置白名单时，仅允许服务器自身IP（开发调试）
      if (origin.includes('150.158.54.108')) return callback(null, true)
      return callback(new Error('CORS 未配置允许的来源'))
    }
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true)
    }
    console.warn(`[CORS] 拒绝来源: ${origin}`)
    callback(new Error('不允许的来源'))
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
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
app.post('/api/register', registerLimiter, (req, res) => {
  const { username, password, phone } = req.body

  if (!username || !password || !phone) {
    return res.status(400).json({ success: false, message: '参数不完整' })
  }

  if (typeof username !== 'string' || username.length < 3 || username.length > 20) {
    return res.status(400).json({ success: false, message: '账号长度为3-20个字符' })
  }

  if (typeof password !== 'string' || password.length < 6 || password.length > 20) {
    return res.status(400).json({ success: false, message: '密码长度为6-20个字符' })
  }

  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ success: false, message: '手机号格式不正确' })
  }

  const users = readJson(USERS_FILE, {})
  if (users[username]) {
    return res.status(409).json({ success: false, message: '该账号已存在' })
  }

  const hashedPassword = bcrypt.hashSync(password, 10)
  users[username] = {
    password: hashedPassword,
    phone: phone,
    createdAt: new Date().toISOString()
  }
  writeJson(USERS_FILE, users)

  console.log(`[API] 新用户注册: ${username}`)
  res.json({ success: true, message: '注册成功' })
})

// 登录
app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body

  if (!username || !password) {
    return res.status(400).json({ success: false, message: '参数不完整' })
  }

  if (isLockedOut(username)) {
    return res.status(429).json({ success: false, message: '登录失败次数过多，账号已锁定15分钟' })
  }

  const users = readJson(USERS_FILE, {})
  const user = users[username]

  if (!user) {
    recordFailAttempt(username)
    return res.status(401).json({ success: false, message: '账号或密码错误' })
  }

  const valid = bcrypt.compareSync(password, user.password)
  if (!valid) {
    recordFailAttempt(username)
    return res.status(401).json({ success: false, message: '账号或密码错误' })
  }

  // 登录成功，清除失败记录
  clearFailAttempts(username)

  // 签发 JWT（7天有效期）
  const accessToken = jwt.sign(
    { sub: username, phone: user.phone || '' },
    JWT_SECRET,
    { expiresIn: '7d', issuer: 'dianxiaoer-api' }
  )

  console.log(`[API] 用户登录: ${username}`)
  res.json({
    success: true,
    message: '登录成功',
    accessToken,
    tokenType: 'Bearer',
    expiresIn: 604800,
    user: {
      username,
      phone: user.phone || ''
    }
  })
})

// 刷新令牌
app.post('/api/refresh', authMiddleware, (req, res) => {
  const username = req.user.sub
  const users = readJson(USERS_FILE, {})
  const user = users[username]
  if (!user) {
    return res.status(401).json({ success: false, message: '用户不存在' })
  }
  const accessToken = jwt.sign(
    { sub: username, phone: user.phone || '' },
    JWT_SECRET,
    { expiresIn: '7d', issuer: 'dianxiaoer-api' }
  )
  res.json({
    success: true,
    accessToken,
    tokenType: 'Bearer',
    expiresIn: 604800
  })
})

// 获取当前用户信息
app.get('/api/me', authMiddleware, (req, res) => {
  const username = req.user.sub
  const users = readJson(USERS_FILE, {})
  const user = users[username]
  if (!user) {
    return res.status(404).json({ success: false, message: '用户不存在' })
  }
  res.json({
    success: true,
    user: {
      username,
      phone: user.phone || ''
    }
  })
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

https.createServer(sslOptions, app).listen(PORT, '0.0.0.0', () => {
  console.log(`[API] 店小二安全后端服务已启动: https://0.0.0.0:${PORT}`)
})
