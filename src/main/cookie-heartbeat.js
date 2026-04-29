const http = require('http')
const https = require('https')

const BUSINESS_SERVER = 'http://150.158.54.108:3002'
const HEARTBEAT_INTERVAL = 5 * 60 * 1000 // 5 分钟
const FIRST_CHECK_DELAY = 10 * 1000 // 启动后 10 秒
const REQUEST_TIMEOUT = 10 * 1000

// 各平台心跳验证 URL
const HEARTBEAT_URLS = {
  taobao: 'https://myseller.taobao.com/home.htm',
  tmall: 'https://myseller.taobao.com/home.htm',
  jd: 'https://shop.jd.com/main',
  pdd: 'https://mms.pinduoduo.com/home',
  douyin: 'https://fxg.jinritemai.com/ffa/mshop/homepage/overview'
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const urlObj = new URL(url)
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers,
      timeout: REQUEST_TIMEOUT
    }

    const req = mod.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, data }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.end()
  })
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const urlObj = new URL(url)
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: REQUEST_TIMEOUT
    }

    const req = mod.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, data }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    if (options.body) req.write(options.body)
    req.end()
  })
}

// 将 Cookie 数组转为请求头字符串
function cookiesToHeader(cookies) {
  try {
    const parsed = typeof cookies === 'string' ? JSON.parse(cookies) : cookies
    if (!Array.isArray(parsed)) return ''
    return parsed.map(c => `${c.name}=${c.value}`).join('; ')
  } catch {
    return ''
  }
}

// 检测单个店铺的在线状态
async function checkSingleStore(storeId, platform, cookieData) {
  const heartbeatUrl = HEARTBEAT_URLS[platform]
  if (!heartbeatUrl) return null // 未知平台，跳过

  const cookieHeader = cookiesToHeader(cookieData)
  if (!cookieHeader) return false // 无有效 Cookie

  try {
    const res = await httpGet(heartbeatUrl, {
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    })

    // 302 重定向到登录页 = 离线
    if (res.statusCode === 302 || res.statusCode === 301) {
      const location = res.headers.location || ''
      if (location.includes('login') || location.includes('sign') || location.includes('passport')) {
        return false
      }
    }

    // 401/403 = 离线
    if (res.statusCode === 401 || res.statusCode === 403) {
      return false
    }

    // 200 且响应中不包含登录页面特征 = 在线
    if (res.statusCode === 200) {
      const body = res.data.toLowerCase()
      if (body.includes('login') && body.includes('password') && body.includes('form')) {
        return false // 返回的是登录页面
      }
      return true
    }

    return null // 其他状态码，不做判断
  } catch {
    return null // 网络错误，不更新状态
  }
}

async function checkAllStores(mainWindow) {
  try {
    // 获取所有启用店铺的 Cookie
    const res = await httpRequest(`${BUSINESS_SERVER}/api/cookies`)
    const json = JSON.parse(res.data)
    if (json.code !== 0 || !json.data) return

    const stores = json.data

    // 串行检测，避免并发风控
    for (const store of stores) {
      const online = await checkSingleStore(store.store_id, store.platform, store.cookie_data)
      if (online === null) continue // 网络错误，不更新

      // 更新服务器状态
      try {
        await httpRequest(`${BUSINESS_SERVER}/api/stores/${store.store_id}/status`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ online })
        })
      } catch (e) {
        console.error(`[Heartbeat] 更新状态失败 store_id=${store.store_id}:`, e.message)
      }

      // 通知渲染进程
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('store-status-changed', {
          storeId: store.store_id,
          online
        })
      }
    }
  } catch (err) {
    console.error('[Heartbeat] checkAllStores error:', err.message)
  }
}

let heartbeatTimer = null

function startHeartbeat(mainWindow) {
  // 首次延迟检测
  setTimeout(() => {
    checkAllStores(mainWindow)
  }, FIRST_CHECK_DELAY)

  // 定时检测
  heartbeatTimer = setInterval(() => {
    checkAllStores(mainWindow)
  }, HEARTBEAT_INTERVAL)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

module.exports = { startHeartbeat, stopHeartbeat }
