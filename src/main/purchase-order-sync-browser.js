/**
 * 采购订单浏览器窗口同步模块
 * 使用隐藏 BrowserWindow + CDP (Chrome DevTools Protocol) 网络捕获方案
 * 参考 sales-order-fetch.js 模式，避免服务端 SESSION_EXPIRED 问题
 *
 * 核心思路：
 * 1. 打开隐藏窗口 → 导航到平台已买到的商品页面
 * 2. 通过 CDP Network 域捕获所有 API 响应（包括 JSONP/fetch/XHR）
 * 3. 筛选并解析目标 API 响应 → 提取订单信息
 * 4. 通过服务器 API 更新本地数据库 → 销毁窗口
 *
 * 优势：
 * - 浏览器自动管理 Cookie/Token，不存在 SESSION_EXPIRED 问题
 * - CDP 在 Chromium 网络层捕获，不依赖 JS 注入，覆盖 JSONP/fetch/XHR 全部请求
 */

const { BrowserWindow, ipcMain, session } = require('electron')
const http = require('http')
const { getAuthToken } = require('./auth-store')

const OVERALL_TIMEOUT = 90000 // 90 秒总超时
const POLL_INTERVAL = 3000   // 3 秒轮询 CDP 捕获结果
const MAX_POLLS = 25         // 最多轮询 25 次（75 秒）

const BUSINESS_SERVER = 'http://150.158.54.108:3002'

const activeSyncs = new Map() // accountId -> win

// ============ 平台配置 ============

const PLATFORM_CONFIG = {
  taobao: {
    entryUrl: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
    loginCheck: (url) => {
      const lower = url.toLowerCase()
      return lower.includes('login.taobao.com') || lower.includes('login.tmall.com')
    },
    apiKeywords: ['mtop.taobao.order', 'queryboughtlist'],
    orderPageKeyword: 'list_bought_items'
  },
  '1688': {
    entryUrl: 'https://trade.1688.com/order/buyer_order_list.htm',
    loginCheck: (url) => {
      const lower = url.toLowerCase()
      return lower.includes('login.1688.com') || (lower.includes('login') && lower.includes('1688.com'))
    },
    apiKeywords: ['orderList', 'buyer_order_list', 'trade'],
    orderPageKeyword: 'buyer_order_list'
  },
  pinduoduo: {
    entryUrl: 'https://mobile.yangkeduo.com/orders.html',
    loginCheck: (url) => {
      const lower = url.toLowerCase()
      return lower.includes('login.yangkeduo.com') || (lower.includes('login') && lower.includes('yangkeduo'))
    },
    apiKeywords: ['orderList', 'orders'],
    orderPageKeyword: 'orders'
  }
}

// ============ 物流公司代码映射 ============

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

function resolveLogisticsCompany(cpName, cpCode) {
  if (cpName && cpName.trim()) return cpName.trim()
  if (cpCode && CP_CODE_MAP[cpCode.toUpperCase()]) return CP_CODE_MAP[cpCode.toUpperCase()]
  return cpName || ''
}

// ============ CDP 网络捕获 ============

/**
 * 使用 CDP debugger 捕获窗口的网络请求
 * 监听 Network.requestWillBeSent 和 Network.loadingFinished 事件
 * 通过 Network.getResponseBody 获取响应体
 */
class CDPNetworkCapture {
  constructor(webContents, apiKeywords) {
    this.webContents = webContents
    this.apiKeywords = apiKeywords
    this.capturedResponses = [] // { url, status, body }
    this.pendingRequests = new Map() // requestId -> { url, status }
    this.attached = false
  }

  async attach() {
    try {
      if (this.webContents.isDestroyed()) return false
      this.webContents.debugger.attach('1.3')
      this.attached = true

      // 启用 Network 域
      await this.webContents.debugger.sendCommand('Network.enable')

      // 监听 CDP 事件
      this.webContents.debugger.on('message', (event, method, params) => {
        this._handleCDPEvent(method, params)
      })

      console.log('[CDP] Network capture attached')
      return true
    } catch (e) {
      console.error('[CDP] Attach failed:', e.message)
      this.attached = false
      return false
    }
  }

  _handleCDPEvent(method, params) {
    if (method === 'Network.responseReceived') {
      const { requestId, response } = params
      const url = response.url || ''

      // 检查 URL 是否匹配目标 API
      const isTargetAPI = this.apiKeywords.some(kw => url.toLowerCase().includes(kw.toLowerCase()))
      if (isTargetAPI) {
        this.pendingRequests.set(requestId, {
          url,
          status: response.status,
          mimeType: response.mimeType || ''
        })
        console.log(`[CDP] Target API detected: ${url.substring(0, 150)} (status: ${response.status})`)
      }
    }

    if (method === 'Network.loadingFinished') {
      const { requestId } = params
      const pending = this.pendingRequests.get(requestId)
      if (pending) {
        this.pendingRequests.delete(requestId)
        this._fetchResponseBody(requestId, pending)
      }
    }

    if (method === 'Network.loadingFailed') {
      const { requestId } = params
      this.pendingRequests.delete(requestId)
    }
  }

  async _fetchResponseBody(requestId, meta) {
    try {
      if (this.webContents.isDestroyed()) return
      const result = await this.webContents.debugger.sendCommand('Network.getResponseBody', { requestId })
      const body = result.body || ''

      if (body.length > 50) {
        this.capturedResponses.push({
          url: meta.url,
          status: meta.status,
          body: body.substring(0, 500000),
          bodyLen: body.length,
          time: Date.now()
        })
        console.log(`[CDP] Response captured: ${meta.url.substring(0, 100)} (${body.length}B)`)
      }
    } catch (e) {
      console.warn(`[CDP] GetResponseBody failed for ${requestId}:`, e.message)
    }
  }

  getCaptured() {
    const responses = [...this.capturedResponses]
    this.capturedResponses = []
    return responses
  }

  async detach() {
    try {
      if (this.attached && !this.webContents.isDestroyed()) {
        this.webContents.debugger.detach()
      }
    } catch (e) {
      // ignore detach errors
    }
    this.attached = false
  }
}

// ============ 响应解析函数 ============

/**
 * 解析淘宝H5 API响应（组件化布局格式）
 */
function parseTaobaoH5Response(responseText) {
  const orders = []
  try {
    const response = JSON.parse(responseText)

    if (response.ret && response.ret[0] !== 'SUCCESS::调用成功') {
      return orders
    }

    if (!response.data) return orders

    let data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
    const hasShopInfoKey = Object.keys(data).some(k => k.startsWith('shopInfo_'))
    const hasOrderStatusKey = Object.keys(data).some(k => k.startsWith('orderStatus_'))
    if (data && data.data && typeof data.data === 'object' && !hasShopInfoKey && !hasOrderStatusKey) {
      data = data.data
    }

    const orderMap = {}

    for (const [key, component] of Object.entries(data)) {
      if (!component || typeof component !== 'object') continue

      if (key.startsWith('shopInfo_')) {
        const orderId = component.id
        if (!orderId) continue
        if (!orderMap[orderId]) orderMap[orderId] = { order_no: orderId }
        if (component.fields && component.fields.tradeTitle) {
          orderMap[orderId].status = component.fields.tradeTitle
        }
      }

      if (key.startsWith('orderStatus_')) {
        const orderId = component.id
        if (!orderId) continue
        if (!orderMap[orderId]) orderMap[orderId] = { order_no: orderId }
        const fields = component.fields || {}
        if (fields.mailNo) orderMap[orderId].logistics_no = fields.mailNo
        if (fields.cpCode) orderMap[orderId].logistics_company_code = fields.cpCode
        if (fields.title) orderMap[orderId].logistics_status = fields.title
      }

      if (key.startsWith('orderLogistics_')) {
        const orderId = component.id
        if (!orderId) continue
        if (!orderMap[orderId]) orderMap[orderId] = { order_no: orderId }
        const fields = component.fields || {}
        if (fields.packagePreview && fields.packagePreview.packageViewList && fields.packagePreview.packageViewList.length > 0) {
          orderMap[orderId].logistics_company = fields.packagePreview.packageViewList[0].cpName
        }
      }
    }

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
  } catch (e) {
    console.error('[PurchaseSync] parseTaobaoH5Response error:', e.message)
  }

  return orders
}

/**
 * 解析1688订单API响应
 */
function parse1688OrderResponse(responseText) {
  const orders = []
  try {
    const response = JSON.parse(responseText)
    let list = null
    if (Array.isArray(response.data)) {
      list = response.data
    } else if (response.data && Array.isArray(response.data.orderList)) {
      list = response.data.orderList
    } else if (response.data && Array.isArray(response.data.list)) {
      list = response.data.list
    } else if (response.data && response.data.result && Array.isArray(response.data.result)) {
      list = response.data.result
    }

    if (list && list.length > 0) {
      for (const raw of list) {
        orders.push({
          order_no: String(raw.orderId || raw.orderNo || raw.id || ''),
          status: raw.statusText || raw.orderStatusText || raw.status || '',
          logistics_no: raw.logisticsOrderNo || raw.expressNo || raw.logisticsNo || '',
          logistics_company: raw.logisticsCompanyName || raw.expressCompany || '',
          logistics_company_code: raw.logisticsCompanyCode || '',
          logistics_status: raw.logisticsStatus || ''
        })
      }
    }
  } catch (e) {
    console.error('[PurchaseSync] parse1688OrderResponse error:', e.message)
  }
  return orders
}

/**
 * 解析拼多多订单API响应
 */
function parsePddOrderResponse(responseText) {
  const orders = []
  try {
    const response = JSON.parse(responseText)
    let list = null
    if (response.data && Array.isArray(response.data.list)) {
      list = response.data.list
    } else if (response.data && Array.isArray(response.data.orderList)) {
      list = response.data.orderList
    } else if (Array.isArray(response.data)) {
      list = response.data
    }

    if (list && list.length > 0) {
      for (const raw of list) {
        orders.push({
          order_no: String(raw.order_sn || raw.orderSn || raw.order_no || raw.id || ''),
          status: raw.order_status_text || raw.orderStatusName || raw.status_text || '',
          logistics_no: raw.shipping_no || raw.trackingNumber || raw.logisticsNo || '',
          logistics_company: raw.shipping_company || raw.logisticsCompany || '',
          logistics_company_code: raw.logistics_id || '',
          logistics_status: raw.shipping_status || ''
        })
      }
    }
  } catch (e) {
    console.error('[PurchaseSync] parsePddOrderResponse error:', e.message)
  }
  return orders
}

/**
 * 根据平台选择解析函数
 */
function parseOrdersByPlatform(platform, responseText) {
  if (platform === 'taobao') return parseTaobaoH5Response(responseText)
  if (platform === '1688') return parse1688OrderResponse(responseText)
  if (platform === 'pinduoduo') return parsePddOrderResponse(responseText)
  return []
}

/**
 * 从所有捕获的响应中查找指定订单
 */
function findOrderByPlatformOrderNo(platform, platformOrderNo, allResponses) {
  for (const r of allResponses) {
    if (r.status !== 200 || !r.body) continue
    try {
      const orders = parseOrdersByPlatform(platform, r.body)
      const found = orders.find(o => o.order_no === platformOrderNo)
      if (found) return found
    } catch (e) { /* skip */ }
  }
  return null
}

/**
 * 从所有捕获的响应中提取所有订单
 */
function findAllOrders(platform, allResponses) {
  const allOrders = []
  for (const r of allResponses) {
    if (r.status !== 200 || !r.body) continue
    try {
      const orders = parseOrdersByPlatform(platform, r.body)
      allOrders.push(...orders)
    } catch (e) { /* skip */ }
  }
  const seen = new Set()
  return allOrders.filter(o => {
    if (seen.has(o.order_no)) return false
    seen.add(o.order_no)
    return true
  })
}

// ============ HTTP 工具函数 ============

function httpPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const postData = JSON.stringify(body)
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
    // 附带主进程 auth token，避免服务端 401 拒绝
    const token = getAuthToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    } else {
      console.warn('[PurchaseSync] httpPostJson: 主进程没有 auth token，请求可能被 401 拒绝')
    }
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers,
      timeout: 15000
    }
    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(postData)
    req.end()
  })
}

// ============ 页面可见性覆盖 ============

const VISIBILITY_OVERRIDE = `
try {
  Object.defineProperty(document, 'hidden', { get: function() { return false; }, configurable: true });
  Object.defineProperty(document, 'visibilityState', { get: function() { return 'visible'; }, configurable: true });
  document.hasFocus = function() { return true; };
  document.dispatchEvent(new Event('visibilitychange'));
} catch(e) {}
`

// ============ 核心同步函数 ============

/**
 * 通过浏览器窗口同步单个采购订单
 * 使用 CDP 在 Chromium 网络层直接捕获响应，不依赖 JS 注入
 */
function syncSingleOrderByBrowser(accountId, platformOrderNo, platform) {
  return new Promise(async (resolve) => {
    const syncKey = `${accountId}-${platform}`
    if (activeSyncs.has(syncKey)) {
      return resolve({ success: false, message: '该账号正在同步中，请等待完成' })
    }

    const config = PLATFORM_CONFIG[platform]
    if (!config) {
      return resolve({ success: false, message: `不支持的平台: ${platform}` })
    }

    const partitionName = `persist:purchase-${accountId}`
    const ses = session.fromPartition(partitionName)
    const cookies = await ses.cookies.get({})

    console.log(`[PurchaseSync] accountId:${accountId} platform:${platform} partition:${partitionName}`)
    console.log(`[PurchaseSync] Cookies: ${cookies.length} 条`)

    if (cookies.length === 0) {
      return resolve({ success: false, message: '该采购账号未登录，请先点击"登录"按钮登录账号' })
    }

    let win = null
    let overallTimer = null
    let resolved = false
    let cdpCapture = null
    let allCapturedResponses = []

    function cleanup() {
      if (overallTimer) { clearTimeout(overallTimer); overallTimer = null }
      activeSyncs.delete(syncKey)
      if (cdpCapture) { cdpCapture.detach().catch(() => {}); cdpCapture = null }
      if (win && !win.isDestroyed()) {
        win.destroy()
      }
      win = null
    }

    function finish(result) {
      if (resolved) return
      resolved = true
      cleanup()
      resolve(result)
    }

    overallTimer = setTimeout(() => {
      console.log(`[PurchaseSync] 总超时，已捕获 ${allCapturedResponses.length} 个 API 响应`)
      // 超时时如果有数据也尝试返回
      if (allCapturedResponses.length > 0) {
        const orderInfo = findOrderByPlatformOrderNo(platform, platformOrderNo, allCapturedResponses)
        if (orderInfo) {
          finish({ success: true, orderInfo })
          return
        }
      }
      finish({ success: false, message: '同步超时，请稍后重试' })
    }, OVERALL_TIMEOUT)

    try {
      win = new BrowserWindow({
        show: false,
        width: 1200,
        height: 800,
        title: '[同步] 采购订单',
        webPreferences: {
          partition: partitionName,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false
        }
      })

      win.webContents.setBackgroundThrottling(false)
      activeSyncs.set(syncKey, win)

      // CDP 必须在页面导航之后 attach（target 需要 ready）
      let cdpAttached = false

      // 检测登录页面
      win.webContents.on('did-navigate', async (event, url) => {
        console.log('[PurchaseSync] navigate:', url.substring(0, 150))

        if (config.loginCheck(url)) {
          finish({ success: false, message: '采购账号登录已过期，请重新登录该账号', needsRelogin: true })
          return
        }

        // 在首次导航完成后 attach CDP（此时 target 已 ready）
        if (!cdpAttached && !resolved) {
          cdpCapture = new CDPNetworkCapture(win.webContents, config.apiKeywords)
          try {
            cdpAttached = await cdpCapture.attach()
            console.log(`[PurchaseSync] CDP attach after navigate: ${cdpAttached ? 'OK' : 'FAIL'}`)
          } catch (e) {
            console.warn('[PurchaseSync] CDP attach error:', e.message)
          }
        }
      })

      // DOM 就绪时注入可见性覆盖
      win.webContents.on('dom-ready', () => {
        if (win.isDestroyed() || resolved) return
        win.webContents.executeJavaScript(VISIBILITY_OVERRIDE).catch(() => {})
        console.log('[PurchaseSync] Visibility override injected')

        // 如果 CDP 尚未 attach，在 dom-ready 时再试
        if (!cdpAttached && !resolved) {
          cdpCapture = new CDPNetworkCapture(win.webContents, config.apiKeywords)
          cdpCapture.attach().then(ok => {
            cdpAttached = ok
            console.log(`[PurchaseSync] CDP attach on dom-ready: ${ok ? 'OK' : 'FAIL'}`)
          }).catch(e => {
            console.warn('[PurchaseSync] CDP attach on dom-ready failed:', e.message)
          })
        }
      })

      // 页面加载完成 → 开始轮询 CDP 捕获结果
      win.webContents.on('did-finish-load', () => {
        if (win.isDestroyed() || resolved) return
        const currentUrl = win.webContents.getURL()
        console.log('[PurchaseSync] loaded:', currentUrl.substring(0, 150))

        setTimeout(() => {
          if (win.isDestroyed() || resolved) return
          pollForData()
        }, 3000)
      })

      // 轮询检查 CDP 捕获的响应
      function pollForData() {
        let pollCount = 0
        let noNewDataCount = 0

        function poll() {
          if (win.isDestroyed() || resolved) return
          pollCount++

          // 获取 CDP 捕获的新响应
          const newResponses = cdpCapture ? cdpCapture.getCaptured() : []

          if (newResponses.length > 0) {
            allCapturedResponses.push(...newResponses)
            noNewDataCount = 0
            console.log(`[PurchaseSync] poll #${pollCount}: +${newResponses.length} APIs (total: ${allCapturedResponses.length})`)

            for (const r of newResponses) {
              console.log(`  [CDP] ${r.url.substring(0, 120)} (${r.bodyLen}B, status: ${r.status})`)
            }

            // 查找目标订单
            const orderInfo = findOrderByPlatformOrderNo(platform, platformOrderNo, allCapturedResponses)
            if (orderInfo) {
              console.log(`[PurchaseSync] 找到订单 ${platformOrderNo}:`, JSON.stringify(orderInfo))
              finish({ success: true, orderInfo })
              return
            }
          } else {
            noNewDataCount++
            console.log(`[PurchaseSync] poll #${pollCount}: 无新 API (total: ${allCapturedResponses.length}, noNew: ${noNewDataCount})`)
          }

          // 连续 5 次无新数据且已捕获到数据 → 不再等待
          if (noNewDataCount >= 5 && allCapturedResponses.length > 0) {
            finish({ success: false, message: `已获取 ${allCapturedResponses.length} 个API响应，但未找到订单 ${platformOrderNo}` })
            return
          }

          if (pollCount < MAX_POLLS) {
            setTimeout(poll, POLL_INTERVAL)
          } else {
            if (allCapturedResponses.length > 0) {
              finish({ success: false, message: `已获取 ${allCapturedResponses.length} 个API响应，但未找到订单 ${platformOrderNo}` })
            } else {
              finish({ success: false, message: '未捕获到任何平台API响应，请稍后重试' })
            }
          }
        }

        poll()
      }

      console.log('[PurchaseSync] Loading:', config.entryUrl)
      win.loadURL(config.entryUrl)

    } catch (err) {
      finish({ success: false, message: '同步失败: ' + err.message })
    }
  })
}

/**
 * 通过浏览器窗口同步所有采购订单（批量）
 */
function syncAllOrdersByBrowser(accountId, platform) {
  return new Promise(async (resolve) => {
    const syncKey = `${accountId}-${platform}`
    if (activeSyncs.has(syncKey)) {
      return resolve({ success: false, message: '该账号正在同步中，请等待完成' })
    }

    const config = PLATFORM_CONFIG[platform]
    if (!config) {
      return resolve({ success: false, message: `不支持的平台: ${platform}` })
    }

    const partitionName = `persist:purchase-${accountId}`
    const ses = session.fromPartition(partitionName)
    const cookies = await ses.cookies.get({})

    console.log(`[PurchaseSync-All] accountId:${accountId} platform:${platform}`)
    console.log(`[PurchaseSync-All] Cookies: ${cookies.length} 条`)

    if (cookies.length === 0) {
      return resolve({ success: false, message: '该采购账号未登录，请先点击"登录"按钮登录账号' })
    }

    let win = null
    let overallTimer = null
    let resolved = false
    let cdpCapture = null
    let allCapturedResponses = []

    function cleanup() {
      if (overallTimer) { clearTimeout(overallTimer); overallTimer = null }
      activeSyncs.delete(syncKey)
      if (cdpCapture) { cdpCapture.detach().catch(() => {}); cdpCapture = null }
      if (win && !win.isDestroyed()) {
        win.destroy()
      }
      win = null
    }

    function finish(result) {
      if (resolved) return
      resolved = true
      cleanup()
      resolve(result)
    }

    overallTimer = setTimeout(() => {
      console.log(`[PurchaseSync-All] 总超时，已捕获 ${allCapturedResponses.length} 个 API 响应`)
      if (allCapturedResponses.length > 0) {
        const orders = findAllOrders(platform, allCapturedResponses)
        finish({ success: true, orders, message: `同步超时，已获取 ${orders.length} 条订单` })
      } else {
        finish({ success: false, message: '同步超时，请稍后重试' })
      }
    }, OVERALL_TIMEOUT)

    try {
      win = new BrowserWindow({
        show: false,
        width: 1200,
        height: 800,
        title: '[批量同步] 采购订单',
        webPreferences: {
          partition: partitionName,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false
        }
      })

      win.webContents.setBackgroundThrottling(false)
      activeSyncs.set(syncKey, win)

      let cdpAttached = false

      win.webContents.on('did-navigate', async (event, url) => {
        console.log('[PurchaseSync-All] navigate:', url.substring(0, 150))
        if (config.loginCheck(url)) {
          finish({ success: false, message: '采购账号登录已过期，请重新登录该账号', needsRelogin: true })
          return
        }
        if (!cdpAttached && !resolved) {
          cdpCapture = new CDPNetworkCapture(win.webContents, config.apiKeywords)
          try {
            cdpAttached = await cdpCapture.attach()
            console.log(`[PurchaseSync-All] CDP attach after navigate: ${cdpAttached ? 'OK' : 'FAIL'}`)
          } catch (e) {
            console.warn('[PurchaseSync-All] CDP attach error:', e.message)
          }
        }
      })

      win.webContents.on('dom-ready', () => {
        if (win.isDestroyed() || resolved) return
        win.webContents.executeJavaScript(VISIBILITY_OVERRIDE).catch(() => {})
        if (!cdpAttached && !resolved) {
          cdpCapture = new CDPNetworkCapture(win.webContents, config.apiKeywords)
          cdpCapture.attach().then(ok => {
            cdpAttached = ok
            console.log(`[PurchaseSync-All] CDP attach on dom-ready: ${ok ? 'OK' : 'FAIL'}`)
          }).catch(e => {
            console.warn('[PurchaseSync-All] CDP attach on dom-ready failed:', e.message)
          })
        }
      })

      win.webContents.on('did-finish-load', () => {
        if (win.isDestroyed() || resolved) return
        const currentUrl = win.webContents.getURL()
        console.log('[PurchaseSync-All] loaded:', currentUrl.substring(0, 150))
        // 延迟3秒开始轮询，等待页面JS发起API请求
        setTimeout(() => {
          if (win.isDestroyed() || resolved) return
          pollForData()
        }, 3000)
      })

      function pollForData() {
        let pollCount = 0
        let stableCount = 0

        function poll() {
          if (win.isDestroyed() || resolved) return
          pollCount++

          const newResponses = cdpCapture ? cdpCapture.getCaptured() : []

          if (newResponses.length > 0) {
            allCapturedResponses.push(...newResponses)
            stableCount = 0
            console.log(`[PurchaseSync-All] poll #${pollCount}: +${newResponses.length} APIs (total: ${allCapturedResponses.length})`)
          } else {
            stableCount++
            console.log(`[PurchaseSync-All] poll #${pollCount}: 无新 API (stable: ${stableCount})`)
          }

          if (stableCount >= 3 && allCapturedResponses.length > 0) {
            const orders = findAllOrders(platform, allCapturedResponses)
            console.log(`[PurchaseSync-All] 页面数据稳定，共获取 ${orders.length} 条订单`)
            finish({ success: true, orders })
            return
          }

          if (pollCount < MAX_POLLS) {
            setTimeout(poll, POLL_INTERVAL)
          } else {
            const orders = findAllOrders(platform, allCapturedResponses)
            if (orders.length > 0) {
              finish({ success: true, orders, message: `轮询结束，获取 ${orders.length} 条订单` })
            } else {
              finish({ success: false, message: '未获取到任何订单数据' })
            }
          }
        }

        poll()
      }

      console.log('[PurchaseSync-All] Loading:', config.entryUrl)
      win.loadURL(config.entryUrl)

    } catch (err) {
      finish({ success: false, message: '同步失败: ' + err.message })
    }
  })
}

// ============ IPC 注册 ============

function registerPurchaseOrderSyncIpc(mainWindow) {
  // 单个订单同步
  ipcMain.handle('sync-purchase-order-browser', async (event, { accountId, platformOrderNo, platform }) => {
    console.log(`[PurchaseSync IPC] 收到单个同步请求: accountId=${accountId}, orderNo=${platformOrderNo}, platform=${platform}`)

    if (!accountId || !platformOrderNo || !platform) {
      return { success: false, message: 'accountId、platformOrderNo 和 platform 不能为空' }
    }

    const result = await syncSingleOrderByBrowser(accountId, platformOrderNo, platform)
    console.log(`[PurchaseSync IPC] 单个同步结果: ${result.success ? 'OK' : 'FAIL'}`)

    if (result.success && result.orderInfo) {
      try {
        const updateResult = await httpPostJson(`${BUSINESS_SERVER}/api/purchase-orders/browser-sync-update`, {
          account_id: accountId,
          platform,
          platform_order_no: platformOrderNo,
          order_info: result.orderInfo
        })
        if (updateResult && updateResult.code === 0) {
          console.log('[PurchaseSync IPC] 数据库更新成功:', JSON.stringify(updateResult.data))
          result.dbResult = updateResult.data
        } else {
          console.error('[PurchaseSync IPC] 数据库更新失败:', updateResult?.message)
          result.dbError = updateResult?.message || '数据库更新失败'
        }
      } catch (e) {
        console.error('[PurchaseSync IPC] 数据库更新异常:', e.message)
        result.dbError = e.message
      }
    }

    return result
  })

  // 批量同步
  ipcMain.handle('sync-purchase-orders-browser', async (event, { accountId, platform }) => {
    console.log(`[PurchaseSync IPC] 收到批量同步请求: accountId=${accountId}, platform=${platform}`)

    if (!accountId || !platform) {
      return { success: false, message: 'accountId 和 platform 不能为空' }
    }

    const result = await syncAllOrdersByBrowser(accountId, platform)
    console.log(`[PurchaseSync IPC] 批量同步结果: ${result.success ? 'OK' : 'FAIL'}, orders: ${result.orders?.length || 0}`)

    if (result.success && result.orders && result.orders.length > 0) {
      try {
        const updateResult = await httpPostJson(`${BUSINESS_SERVER}/api/purchase-orders/browser-sync-batch`, {
          account_id: accountId,
          platform,
          orders: result.orders
        })
        if (updateResult && updateResult.code === 0) {
          console.log('[PurchaseSync IPC] 批量更新成功:', JSON.stringify(updateResult.data))
          result.matchedCount = updateResult.data?.matched_count || 0
        } else {
          console.error('[PurchaseSync IPC] 批量更新失败:', updateResult?.message)
          result.dbError = updateResult?.message || '数据库更新失败'
        }
      } catch (e) {
        console.error('[PurchaseSync IPC] 批量更新异常:', e.message)
        result.dbError = e.message
      }
    }

    return result
  })
}

module.exports = { registerPurchaseOrderSyncIpc }
