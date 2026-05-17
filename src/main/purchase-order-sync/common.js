/**
 * 采购订单同步 - 共享工具模块
 * 包含 CDP 网络捕获、HTTP 工具、常量、物流映射等共享代码
 */

const { BrowserWindow, ipcMain, session } = require('electron')
const path = require('path')
const http = require('http')
const { getAuthToken } = require('../auth-store')
const { resolveAppPath } = require('../hot-updater')

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
  '退款中': 'refunded',
  '已拒收': 'rejected',
  '拒收': 'rejected'
}

/**
 * 将中文订单状态映射为系统标准英文状态码
 * 如果已经是英文状态码（pending/shipped等），直接返回
 * 如果映射不到，返回原值
 */
function mapOrderStatus(status) {
  if (!status) return status
  // 已经是标准英文状态码，直接返回
  const validStatuses = ['ordered', 'pending', 'shipped', 'in_transit', 'received', 'forwarded', 'stocked', 'pending_after_sale', 'rejected', 'cancelled', 'refunded']
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

/**
 * 根据物流轨迹内容修正订单状态
 *
 * 检测逻辑（优先级从高到低）：
 * 1. logisticsStatus（平台原始物流状态字段，最可靠）
 *    - 拒收关键词 → rejected
 *    - 签收关键词 → received
 * 2. tracking 轨迹文本（逐条检查，匹配即返回）
 *    - 拒收关键词 → rejected
 *    - 签收关键词 → received
 *    - 揽收关键词（仅 shipped → in_transit）
 *
 * @param {string} status - 当前英文状态码 (shipped/in_transit)
 * @param {Array} tracking - 归一化轨迹数组 [{time, context}]
 * @param {string} logisticsStatus - 平台原始物流状态（中文，如"已签收"）
 * @returns {string} 修正后的状态码
 */
function refineStatusByTracking(status, tracking, logisticsStatus) {
  if (status !== 'shipped' && status !== 'in_transit') return status

  // 优先检查 logisticsStatus（平台原始字段，最可靠）
  if (logisticsStatus) {
    if (/已拒收|拒收|拒签/.test(logisticsStatus)) {
      console.log(`[StatusRefine] ${status} → rejected (物流状态: ${logisticsStatus})`)
      return 'rejected'
    }
    if (/已签收|已投递|已妥投|家人签收|代收/.test(logisticsStatus)) {
      console.log(`[StatusRefine] ${status} → received (物流状态: ${logisticsStatus})`)
      return 'received'
    }
  }

  // 其次检查轨迹文本
  if (!Array.isArray(tracking) || tracking.length === 0) return status

  for (const item of tracking) {
    const ctx = (item.context || '') + (item.desc || '')
    // 排除"通知取件"类伪揽收（如"正在通知中通快递取件"）
    if (/通知.*取件|取件.*通知/.test(ctx)) continue

    // 拒收检测
    if (/拒收|拒签|拒绝签收|退回/.test(ctx)) {
      console.log(`[StatusRefine] ${status} → rejected (轨迹: ${ctx.substring(0, 50)})`)
      return 'rejected'
    }
    // 签收检测
    if (/已签收|已投递|已妥投|家人签收|代收|本人签收/.test(ctx)) {
      console.log(`[StatusRefine] ${status} → received (轨迹: ${ctx.substring(0, 50)})`)
      return 'received'
    }
    // 揽收检测（仅 shipped → in_transit）
    if (status === 'shipped' && /揽收|已取件/.test(ctx)) {
      console.log(`[StatusRefine] shipped → in_transit (真实揽收: ${ctx.substring(0, 50)})`)
      return 'in_transit'
    }
  }
  return status
}

// ============ Cookie 有效性检查 ============

const PLATFORM_DOMAINS = {
  pinduoduo: ['pinduoduo.com', 'yangkeduo.com'],
  taobao: ['taobao.com', 'tmall.com'],
  '1688': ['1688.com', 'alibaba.com'],
  douyin: ['douyin.com', 'jinritemai.com']
}

/**
 * 检查 partition 中是否有该平台的有效（未过期）cookie
 * 用于判断是否需要从服务器恢复 cookie
 *
 * @param {Array} cookies - ses.cookies.get({}) 返回的 cookie 数组
 * @param {string} platform - 平台 (pinduoduo/taobao/1688/douyin)
 * @returns {boolean} true 表示有有效平台 cookie，false 表示需要恢复
 */
function hasValidPlatformCookies(cookies, platform) {
  if (!cookies || cookies.length === 0) return false

  const domains = PLATFORM_DOMAINS[platform]
  if (!domains || domains.length === 0) {
    // 未知平台：有任何未过期 cookie 就认为有效
    const now = Date.now() / 1000
    return cookies.some(ck => !ck.expirationDate || ck.expirationDate <= 0 || ck.expirationDate > now)
  }

  const now = Date.now() / 1000
  const validPlatformCookies = cookies.filter(ck => {
    // 必须属于该平台域名
    if (!ck.domain || !domains.some(d => ck.domain.includes(d))) return false
    // 必须未过期（session cookie 无 expirationDate 或为 0，视为有效）
    if (ck.expirationDate && ck.expirationDate > 0 && ck.expirationDate <= now) return false
    return true
  })

  if (validPlatformCookies.length === 0) return false

  // PDD 平台额外检查：PDDAccessToken 是必要条件
  // 只有 api_uid 等非认证 cookie 而无 PDDAccessToken，PDD 服务器会拒绝请求
  if (platform === 'pinduoduo') {
    const cookieNames = new Set(validPlatformCookies.map(c => c.name))
    if (!cookieNames.has('PDDAccessToken')) {
      console.warn('[CookieCheck] PDD 缺少 PDDAccessToken，视为无效')
      return false
    }
  }

  return true
}

// ============ Cookie 从服务器恢复到 Partition ============

// cookie 恢复短期缓存：同一 accountId+platform 在 CACHE_TTL 内不重复请求服务器
const _cookieRestoreCache = new Map() // key: `${accountId}|${platform}` → { result, timestamp }
const COOKIE_RESTORE_CACHE_TTL = 600000 // 10 分钟缓存有效期（批量同步时每个订单约30秒，10分钟内无需重复请求）

/**
 * 从服务器恢复 cookie 到 Electron partition（合并模式）
 * 同步前始终调用此函数，无论 partition 是否已有 cookie
 *
 * 合并策略：只补充 partition 中缺失的 cookie，不覆盖已有的
 * - 如果 partition 已有同名/同域/同路径的 cookie，跳过（保留 partition 的新鲜版本）
 * - 如果 partition 缺少该 cookie，从服务器补充（确保多用户共享同一份 cookie）
 *
 * 缓存策略：同一 accountId+platform 在 60 秒内不重复请求服务器（批量同步场景优化）
 *
 * 解决场景：
 * - 子账号新增采购账号后，其他用户在本机 partition 无 cookie 导致"未登录"
 * - partition 有结构性有效但实际已过期的旧 cookie（如 PDDAccessToken 过期但未超 expirationDate）
 *   导致 hasValidPlatformCookies 返回 true 跳过恢复，平台拒绝请求
 * - 删除账号后重新添加，partition 为空需要从服务器恢复
 * - 覆盖策略的问题：partition 有新鲜 cookie（如刚登录后平台轮换的 _m_h5_tk），
 *   服务器保存的是登录 5 秒后的快照，覆盖会替换新 token 为旧 token，导致同步失败
 *
 * @param {string} accountId - 采购账号 ID
 * @param {string} platform - 平台 (pinduoduo/taobao/1688/douyin)
 * @returns {Promise<{restored: boolean, count: number, skipped: number}>} 恢复结果
 */
async function restoreCookiesFromServer(accountId, platform) {
  const RESTORE_TIMEOUT = 5000 // 5 秒总超时，防止 HTTP 请求挂起阻塞同步

  // 检查缓存：同一 accountId+platform 在 CACHE_TTL 内不重复请求
  const cacheKey = `${accountId}|${platform}`
  const cached = _cookieRestoreCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < COOKIE_RESTORE_CACHE_TTL) {
    console.log(`[CookieRestore] 命中缓存，跳过服务器请求 (accountId=${accountId}, 缓存剩余${Math.round((COOKIE_RESTORE_CACHE_TTL - (Date.now() - cached.timestamp)) / 1000)}秒)`)
    return cached.result
  }

  const doRestore = async () => {
    const partitionName = `persist:purchase-${accountId}`
    const ses = session.fromPartition(partitionName)

  try {
    // 1. 从服务器获取 cookie
    const token = getAuthToken()
    if (!token) {
      console.warn('[CookieRestore] 主进程没有 auth token，无法从服务器恢复 cookie')
      return { restored: false, count: 0, skipped: 0 }
    }

    const urlObj = new URL(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`)
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 8000
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
      req.end()
    })

    if (!result || result.code !== 0 || !result.data || !result.data.cookie_data) {
      console.log(`[CookieRestore] 服务器无 cookie 数据 (accountId=${accountId})`)
      return { restored: false, count: 0, skipped: 0 }
    }

    // 2. 解析 cookie 数据
    const raw = typeof result.data.cookie_data === 'string'
      ? JSON.parse(result.data.cookie_data)
      : result.data.cookie_data

    if (!Array.isArray(raw) || raw.length === 0) {
      console.log(`[CookieRestore] cookie 数据为空 (accountId=${accountId})`)
      return { restored: false, count: 0, skipped: 0 }
    }

    // 3. 过滤过期 cookie
    const now = Date.now() / 1000
    const validCookies = raw.filter(ck => {
      if (ck.expirationDate && ck.expirationDate > 0 && ck.expirationDate < now) return false
      return true
    })

    if (validCookies.length === 0) {
      console.log(`[CookieRestore] 所有 cookie 已过期 (accountId=${accountId}, total=${raw.length})`)
      return { restored: false, count: 0, skipped: 0 }
    }

    // 4. PDD 平台：恢复前先清除 partition 中该平台域名的旧 cookie
    // 原因：旧 cookie 可能是 hostOnly（domain 无前导点），与服务器的新格式（有前导点）不同
    // 合并模式用 name|domain|path 做 key，新旧 domain 不同导致旧 cookie 不被覆盖，新旧并存 PDD 优先使用旧的失效 cookie
    if (platform === 'pinduoduo') {
      try {
        const pddDomains = ['yangkeduo.com', 'pinduoduo.com', 'pdd.net']
        const existingPddCookies = await ses.cookies.get({})
        const oldPddCookies = existingPddCookies.filter(c =>
          pddDomains.some(d => c.domain && c.domain.includes(d))
        )
        for (const old of oldPddCookies) {
          try {
            const secure = old.secure || false
            const url = (secure ? 'https://' : 'http://') + (old.domain || '').replace(/^\./, '') + (old.path || '/')
            await ses.cookies.remove(url, old.name)
          } catch (e) { /* ignore */ }
        }
        if (oldPddCookies.length > 0) console.log(`[CookieRestore] PDD 旧 cookie 已清除: ${oldPddCookies.length} 条, accountId=${accountId}`)
      } catch (clearErr) {
        console.warn(`[CookieRestore] PDD 旧 cookie 清除失败:`, clearErr.message)
      }
    }

    // 淘宝平台：恢复前先清除 partition 中该平台域名的旧 cookie
    // 原因：旧 cookie 可能是 hostOnly（domain 无前导点如 taobao.com），与服务器新格式（有前导点如 .taobao.com）不同
    // Chromium 视为不同 cookie，新旧并存时淘宝优先使用旧的失效 cookie，导致滑块验证或登录重定向
    if (platform === 'taobao') {
      try {
        const tbDomains = ['taobao.com', 'tmall.com', 'tmall.hk', 'alipay.com']
        const existingTbCookies = await ses.cookies.get({})
        const oldTbCookies = existingTbCookies.filter(c =>
          tbDomains.some(d => c.domain && c.domain.includes(d))
        )
        for (const old of oldTbCookies) {
          try {
            const secure = old.secure || false
            const url = (secure ? 'https://' : 'http://') + (old.domain || '').replace(/^\./, '') + (old.path || '/')
            await ses.cookies.remove(url, old.name)
          } catch (e) { /* ignore */ }
        }
        if (oldTbCookies.length > 0) console.log(`[CookieRestore] 淘宝旧 cookie 已清除: ${oldTbCookies.length} 条, accountId=${accountId}`)
      } catch (clearErr) {
        console.warn(`[CookieRestore] 淘宝旧 cookie 清除失败:`, clearErr.message)
      }
    }

    // 5. 写入服务器 cookie
    // PDD/淘宝已清除旧 cookie，全量写入；其他平台仍为合并模式（只补充缺失的，不覆盖已有的）
    const existingKeysAfter = new Set()
    if (platform !== 'pinduoduo' && platform !== 'taobao') {
      const currentCookies = await ses.cookies.get({})
      for (const ck of currentCookies) {
        existingKeysAfter.add(`${ck.name}|${ck.domain}|${ck.path}`)
      }
    }
    let setOk = 0
    let skipped = 0
    for (const ck of validCookies) {
      const key = `${ck.name}|${ck.domain || ''}|${ck.path || '/'}`
      if (existingKeysAfter.has(key)) {
        skipped++
        continue
      }
      try {
        const sameSite = ck.sameSite || undefined
        const secure = sameSite === 'no_restriction' ? true : (ck.secure || false)
        await ses.cookies.set({
          url: (secure ? 'https://' : 'http://') + (ck.domain || '').replace(/^\./, '') + (ck.path || '/'),
          name: ck.name,
          value: ck.value || '',
          domain: ck.domain,
          path: ck.path || '/',
          secure,
          httpOnly: ck.httpOnly || false,
          expirationDate: ck.expirationDate || undefined,
          sameSite
        })
        setOk++
      } catch (e) {
        // 忽略单条 cookie 写入失败
      }
    }

    // 6. 刷盘持久化（5秒超时防止卡死）
    await Promise.race([
      new Promise(resolve => ses.flushStorageData(resolve)),
      new Promise(resolve => setTimeout(resolve, 5000))
    ])

    console.log(`[CookieRestore] 合并完成: accountId=${accountId}, ${setOk} 条补充/${skipped} 条保留/${validCookies.length} 条服务器总有效 (平台: ${platform})`)
    return { restored: setOk > 0, count: setOk, skipped }

  } catch (err) {
    console.warn(`[CookieRestore] 恢复失败: accountId=${accountId}, ${err.message}`)
    return { restored: false, count: 0, skipped: 0 }
  }
  }

  // 用 Promise.race 防止整个恢复流程挂起（如 DNS 解析卡住、服务器无响应等）
  const timeoutPromise = new Promise(resolve => {
    setTimeout(() => {
      console.warn(`[CookieRestore] 恢复超时(${RESTORE_TIMEOUT}ms)，跳过，使用 partition 已有 cookie (accountId=${accountId})`)
      resolve({ restored: false, count: 0, skipped: 0, timedOut: true })
    }, RESTORE_TIMEOUT)
  })
  const finalResult = await Promise.race([doRestore(), timeoutPromise])
  // 缓存结果（超时的结果不缓存，下次重试时重新请求）
  if (!finalResult.timedOut) {
    _cookieRestoreCache.set(cacheKey, { result: finalResult, timestamp: Date.now() })
  }
  return finalResult
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
  ORDER_STATUS_MAP, mapOrderStatus, refineStatusByTracking,
  // CDP
  CDPNetworkCapture,
  // HTTP
  httpPostJson,
  // Cookie Restore
  restoreCookiesFromServer,
  hasValidPlatformCookies,
  // Path Resolution
  resolveAppPath,
  // Visibility
  VISIBILITY_OVERRIDE
}
