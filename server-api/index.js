require('dotenv').config()
const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')
const fs = require('fs')
const path = require('path')
const https = require('https')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const multer = require('multer')
const rateLimit = require('express-rate-limit')

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
const ADMIN_PASSWORD = 'dianxiaoer2026'

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
app.post('/api/register', registerLimiter, (req, res) => {
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
    let finalSha256 = sha256
    if (!finalSha256) {
      const hash = crypto.createHash('sha256')
      hash.update(fs.readFileSync(filePath))
      finalSha256 = hash.digest('hex')
    }
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
  meta.full = { version, changelog: changelog || '', updatedAt: new Date().toISOString() }
  writeMeta(meta)
  console.log(`[Update] 全量更新已登记: v${version}`)
  res.json({ code: 0, message: '全量更新登记成功', version })
})

// 统一检查更新
app.get('/api/update/check', (req, res) => {
  try {
    const meta = readMeta()
    const currentVersion = req.query.version || '0.0.0'
    const appVersion = req.query.appVersion || ''
    const currentNum = parseVersion(currentVersion)

    if (appVersion && meta.full) {
      const appNum = parseVersion(appVersion)
      const fullNum = parseVersion(meta.full.version)
      if (fullNum > appNum) {
        return res.json({
          needUpdate: true,
          updateType: 'full',
          version: meta.full.version,
          changelog: meta.full.changelog || '',
          force: false
        })
      }
    }

    if (meta.hot) {
      const hotNum = parseVersion(meta.hot.version)
      if (hotNum > currentNum) {
        return res.json({
          needUpdate: true,
          updateType: 'hot',
          version: meta.hot.version,
          changelog: meta.hot.changelog || '',
          size: meta.hot.size || 0,
          sha256: meta.hot.sha256 || '',
          updatedAt: meta.hot.updatedAt
        })
      }
    }

    res.json({ needUpdate: false, updateType: 'none' })
  } catch (err) {
    console.error('[Update] 检查失败:', err.message)
    res.status(500).json({ needUpdate: false, error: err.message })
  }
})

// 热更新下载
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

// HTTP 服务器（仅 HTTP，新版本客户端正常更新）
const http = require('http')
http.createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log(`[API] 店小二后端服务已启动: http://0.0.0.0:${PORT}`)
})
