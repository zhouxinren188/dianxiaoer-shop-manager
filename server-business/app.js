const express = require('express')
const cors = require('cors')
const storesRouter = require('./routes/stores')
const cookiesRouter = require('./routes/cookies')

const app = express()
const PORT = 3002

// 确保 Windows 下 stdout 使用 UTF-8
process.stdout.setDefaultEncoding('utf8')

app.use(cors())
app.use(express.json({ limit: '10mb' }))

// 强制响应头使用 UTF-8 编码
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  next()
})

// 路由
app.use('/api/stores', storesRouter)
app.use('/api/cookies', cookiesRouter)

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'dianxiaoer-business' })
})

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('[Error]', err.message)
  res.status(500).json({ code: 1, message: err.message || '服务器内部错误' })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`店小二业务服务器运行在端口 ${PORT}`)
})
