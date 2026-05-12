/**
 * 采购订单同步 - 共享工具模块
 * 包含 CDP 网络捕获、HTTP 工具、常量、物流映射等共享代码
 */

const { BrowserWindow, ipcMain, session } = require('electron')
const path = require('path')
const http = require('http')
const { getAuthToken } = require('../auth-store')

const OVERALL_TIMEOUT = 90000 // 90 秒总超时
const POLL_INTERVAL = 3000   // 3 秒轮询 CDP 捕获结果
const MAX_POLLS = 25         // 最多轮询 25 次（75 秒）

const BUSINESS_SERVER = 'http://150.158.54.108:3002'

const activeSyncs = new Map() // accountId -> win

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

// ============ 订单状态映射（中文 → 英文代码） ============
// 在客户端完成状态映射，不依赖远程服务器的 statusMap
// 确保 "等待买家付款" → "ordered" 而非 "pending"

const ORDER_STATUS_MAP = {
  '等待买家付款': 'ordered',
  '买家已付款': 'pending',
  '待发货': 'pending',
  '待收货': 'shipped',
  '卖家已发货': 'shipped',
  '已发货': 'shipped',
  '卖家发货': 'shipped',
  '买家付款': 'pending',
  '拍下宝贝': 'ordered',
  '确认收货': 'received',
  '已签收': 'received',
  '交易成功': 'received',
  '运输中': 'in_transit',
  '派送中': 'in_transit',
  '已成交': 'completed',
  '交易关闭': 'cancelled',
  '已取消': 'cancelled',
  '退款成功': 'refunded',
  '退款中': 'refunded'
}

/**
 * 将中文订单状态映射为系统标准英文状态码
 * 如果已经是英文状态码（pending/shipped等），直接返回
 * 如果映射不到，返回原值
 */
function mapOrderStatus(status) {
  if (!status) return status
  // 已经是标准英文状态码，直接返回
  const validStatuses = ['ordered', 'pending', 'shipped', 'in_transit', 'received', 'stocked', 'cancelled', 'refunded']
  if (validStatuses.includes(status)) return status
  // 中文 → 英文映射
  return ORDER_STATUS_MAP[status] || status
}

function resolveLogisticsCompany(cpName, cpCode) {
  if (cpName && cpName.trim()) return cpName.trim()
  if (cpCode && CP_CODE_MAP[cpCode.toUpperCase()]) return CP_CODE_MAP[cpCode.toUpperCase()]
  return cpName || ''
}

// ============ 物流轨迹提取工具 ============

// 时间类字段名（优先级从高到低）
const TRACKING_TIME_FIELDS = ['time', 'timeStr', 'odate', 'date', 'timestamp', 'acceptTime', 'scanTime']
// 描述类字段名（优先级从高到低）
const TRACKING_DESC_FIELDS = ['desc', 'description', 'standerdDesc', 'standardDesc', 'context', 'message', 'content', 'action', 'acceptAddress', 'scanDesc']

/**
 * 富文本转纯文本
 * 淘宝物流页的 desc 字段可能是富文本数组:
 *   [{text: "您的快件在 ", css: {fontColor: "#000000", isBold: false}}, {text: "[深圳]", ...}, ...]
 *   subTitle: {text: "05-11 09:30", css: {fontColor: "#999999"}}
 * 也可能是纯字符串
 */
function richTextToPlain(val) {
  if (!val) return ''
  if (typeof val === 'string') return val
  if (typeof val === 'number') return String(val)
  if (Array.isArray(val)) {
    return val.map(item => {
      if (!item || typeof item !== 'object') return String(item || '')
      return item.text || item.content || item.value || ''
    }).filter(t => t).join('')
  }
  if (typeof val === 'object') {
    // 单个富文本对象: {text: "...", css: {...}}
    return val.text || val.content || val.value || ''
  }
  return String(val)
}

/**
 * 标准化单条轨迹记录为 {time, context} 格式
 */
function normalizeTrackingItem(item) {
  if (!item || typeof item !== 'object') return null
  let time = ''
  for (const key of TRACKING_TIME_FIELDS) {
    if (item[key] != null && item[key] !== '') {
      time = typeof item[key] === 'number' ? new Date(item[key]).toLocaleString('zh-CN') : String(item[key])
      break
    }
  }
  let context = ''
  for (const key of TRACKING_DESC_FIELDS) {
    if (item[key] != null && item[key] !== '') {
      context = richTextToPlain(item[key])
      break
    }
  }
  if (!time && !context) return null
  return { time, context }
}

/**
 * 标准化轨迹数组
 */
function normalizeTrackingItems(items) {
  if (!Array.isArray(items)) return null
  const normalized = []
  for (const item of items) {
    const n = normalizeTrackingItem(item)
    if (n) normalized.push(n)
  }
  return normalized.length > 0 ? normalized : null
}

/**
 * 检查一个数组是否看起来像物流轨迹数组
 * 条件：至少2个元素，每个元素有time-like字段和desc-like字段
 */
function looksLikeTrackingArray(arr) {
  if (!Array.isArray(arr) || arr.length < 1) return false
  // 至少1个元素需要同时有时间和描述
  let matchCount = 0
  for (const item of arr) {
    if (!item || typeof item !== 'object') return false
    const hasTime = TRACKING_TIME_FIELDS.some(k => item[k] != null && item[k] !== '')
    const hasDesc = TRACKING_DESC_FIELDS.some(k => item[k] != null && item[k] !== '')
    if (hasTime || hasDesc) matchCount++
  }
  return matchCount > 0 && (arr.length <= 1 || matchCount >= arr.length * 0.5)
}

/**
 * 从任意对象中尝试提取物流轨迹数组
 * 搜索已知字段名 + 扫描所有数组属性（启发式检测）
 * @param {object} obj - 要搜索的数据对象
 * @param {number} maxDepth - 最大递归深度，默认 3
 * @returns {Array<{time:string, context:string}>|null}
 */
function extractTrackingFromData(obj, maxDepth) {
  if (!obj || typeof obj !== 'object') return null
  if (maxDepth === undefined) maxDepth = 3

  // 已知的轨迹数组字段名
  const trackingArrayKeys = [
    'details', 'logisticsDetailList', 'logisticsDetails',
    'trackingDetails', 'traceList', 'trackInfoList',
    'traceDetailList', 'steps', 'trackList', 'tracks',
    'logisticsTrackList', 'deliveryTrackList'
  ]

  // 1. 直接搜索已知字段
  for (const key of trackingArrayKeys) {
    if (Array.isArray(obj[key]) && obj[key].length > 0) {
      const result = normalizeTrackingItems(obj[key])
      if (result) {
        console.log(`[Tracking] 命中字段 "${key}", ${result.length} 条轨迹`)
        return result
      }
    }
  }

  // 2. 启发式扫描：检查所有数组属性，看是否像轨迹数据
  for (const [key, val] of Object.entries(obj)) {
    if (trackingArrayKeys.includes(key)) continue // 已检查过
    if (!Array.isArray(val) || val.length === 0) continue
    if (!looksLikeTrackingArray(val)) continue
    const result = normalizeTrackingItems(val)
    if (result) {
      console.log(`[Tracking] 启发式命中字段 "${key}", ${result.length} 条轨迹`)
      return result
    }
  }

  // 3. 递归搜索子对象
  if (maxDepth > 0) {
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const result = extractTrackingFromData(val, maxDepth - 1)
        if (result) return result
      }
    }
  }

  return null
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
    this.capturedRequests = []  // { url, method, postData }
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
    // 捕获请求（含 postData）
    if (method === 'Network.requestWillBeSent') {
      const { requestId, request } = params
      const url = request.url || ''
      const isTargetAPI = this.apiKeywords.some(kw => url.toLowerCase().includes(kw.toLowerCase()))
      if (isTargetAPI) {
        this.capturedRequests.push({
          requestId,
          url,
          method: request.method || 'GET',
          postData: request.postData || ''
        })
        console.log(`[CDP] Target request captured: ${request.method} ${url.substring(0, 120)}`)
      }
    }

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

  getCapturedRequests() {
    const requests = [...this.capturedRequests]
    this.capturedRequests = []
    return requests
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

// ============ HTTP 工具 ============

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
  Object.defineProperty(document, 'hidden', { get: () => false });
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
  document.hasFocus = function() { return true; };
  document.dispatchEvent(new Event('visibilitychange'));
} catch(e) {}
`

module.exports = {
  // Electron / Node
  BrowserWindow, ipcMain, session, path, http,
  // Constants
  OVERALL_TIMEOUT, POLL_INTERVAL, MAX_POLLS,
  BUSINESS_SERVER,
  activeSyncs,
  // Logistics
  CP_CODE_MAP, resolveLogisticsCompany,
  // Tracking
  extractTrackingFromData, normalizeTrackingItems, looksLikeTrackingArray, richTextToPlain,
  // Status
  ORDER_STATUS_MAP, mapOrderStatus,
  // CDP
  CDPNetworkCapture,
  // HTTP
  httpPostJson,
  // Visibility
  VISIBILITY_OVERRIDE
}
