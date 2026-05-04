/**
 * 从 purchase-order-sync-browser.js 提取的纯函数，用于单元测试
 * 这些函数不依赖 Electron/Node 运行时，可在 Vitest 中直接测试
 */

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

// ============ 淘宝 H5 响应解析 ============

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
    // parse error
  }

  return orders
}

// ============ 1688 响应解析 ============

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
    // parse error
  }
  return orders
}

// ============ 拼多多响应解析 ============

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
    // parse error
  }
  return orders
}

// ============ 平台路由解析 ============

function parseOrdersByPlatform(platform, responseText) {
  if (platform === 'taobao') return parseTaobaoH5Response(responseText)
  if (platform === '1688') return parse1688OrderResponse(responseText)
  if (platform === 'pinduoduo') return parsePddOrderResponse(responseText)
  return []
}

// ============ 查找 & 聚合 ============

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

// ============ 状态映射 (server-side sync-single) ============

const STATUS_MAP = {
  '等待买家付款': 'pending',
  '买家已付款': 'pending',
  '待发货': 'pending',
  '待收货': 'shipped',
  '卖家已发货': 'shipped',
  '已发货': 'shipped',
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
 * 模拟 browser-sync-update 端点的核心逻辑
 * 接收 orderInfo，返回更新后的状态字段
 */
function computeSyncUpdate(orderInfo, localOrder) {
  const updateFields = []
  const updateValues = []
  const result = {}

  const newStatus = STATUS_MAP[orderInfo.status] || null

  if (newStatus && newStatus !== localOrder.status) {
    updateFields.push('status')
    updateValues.push(newStatus)
    result.status = newStatus
  } else {
    result.status = localOrder.status
  }

  result.logistics_no = orderInfo.logistics_no || localOrder.logistics_no
  result.logistics_company = orderInfo.logistics_company || localOrder.logistics_company
  result.logistics_status = orderInfo.logistics_status || ''

  return {
    updateFields,
    updateValues,
    result,
    hasChanges: updateFields.length > 0 || !!orderInfo.logistics_no || !!orderInfo.logistics_company
  }
}

// ============ CDP 网络捕获器（可测试版） ============

/**
 * 使用 CDP debugger 捕获窗口的网络请求
 * 监听 Network.responseReceived 和 Network.loadingFinished 事件
 * 通过 Network.getResponseBody 获取响应体
 *
 * @param {object} webContents - Electron webContents（或其 mock）
 * @param {string[]} apiKeywords - 目标 API URL 关键词列表
 * @param {object} [options] - 可选配置
 * @param {function} [options.sendCommand] - 发送 CDP 命令的函数（用于测试注入）
 */
class CDPNetworkCapture {
  constructor(webContents, apiKeywords, options = {}) {
    this.webContents = webContents
    this.apiKeywords = apiKeywords
    this.capturedResponses = []
    this.pendingRequests = new Map()
    this.attached = false
    this._sendCommandFn = options.sendCommand || null
    this._onMessageCallback = null
  }

  async attach() {
    try {
      if (this.webContents.isDestroyed && this.webContents.isDestroyed()) return false
      this.webContents.debugger.attach('1.3')
      this.attached = true

      await this._sendCommand('Network.enable')

      this._onMessageCallback = (event, method, params) => {
        this._handleCDPEvent(method, params)
      }
      this.webContents.debugger.on('message', this._onMessageCallback)

      return true
    } catch (e) {
      this.attached = false
      return false
    }
  }

  async _sendCommand(method, params = {}) {
    if (this._sendCommandFn) {
      return this._sendCommandFn(method, params)
    }
    if (this.webContents.isDestroyed && this.webContents.isDestroyed()) {
      throw new Error('webContents destroyed')
    }
    return this.webContents.debugger.sendCommand(method, params)
  }

  _handleCDPEvent(method, params) {
    if (method === 'Network.responseReceived') {
      const { requestId, response } = params
      const url = response.url || ''

      const isTargetAPI = this.apiKeywords.some(kw => url.toLowerCase().includes(kw.toLowerCase()))
      if (isTargetAPI) {
        this.pendingRequests.set(requestId, {
          url,
          status: response.status,
          mimeType: response.mimeType || ''
        })
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
      if (this.webContents.isDestroyed && this.webContents.isDestroyed()) return
      const result = await this._sendCommand('Network.getResponseBody', { requestId })
      const body = result.body || ''

      if (body.length > 50) {
        this.capturedResponses.push({
          url: meta.url,
          status: meta.status,
          body: body.substring(0, 500000),
          bodyLen: body.length,
          time: Date.now()
        })
      }
    } catch (e) {
      // GetResponseBody can fail for some request types
    }
  }

  getCaptured() {
    const responses = [...this.capturedResponses]
    this.capturedResponses = []
    return responses
  }

  getAllCaptured() {
    return [...this.capturedResponses]
  }

  async detach() {
    try {
      if (this.attached) {
        if (this._onMessageCallback && this.webContents.debugger.off) {
          this.webContents.debugger.off('message', this._onMessageCallback)
        }
        if (!this.webContents.isDestroyed || !this.webContents.isDestroyed()) {
          this.webContents.debugger.detach()
        }
      }
    } catch (e) {
      // ignore detach errors
    }
    this.attached = false
  }
}

module.exports = {
  CP_CODE_MAP,
  resolveLogisticsCompany,
  PLATFORM_CONFIG,
  parseTaobaoH5Response,
  parse1688OrderResponse,
  parsePddOrderResponse,
  parseOrdersByPlatform,
  findOrderByPlatformOrderNo,
  findAllOrders,
  STATUS_MAP,
  computeSyncUpdate,
  CDPNetworkCapture
}
