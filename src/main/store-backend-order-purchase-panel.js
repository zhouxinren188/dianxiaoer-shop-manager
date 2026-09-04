'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const { getAuthToken } = require('./auth-store')

const BUSINESS_SERVER = 'http://150.158.54.108:3002'
const JD_ORDER_DETAILS_HOST = 'shop.jd.com'
const JD_ORDER_DETAILS_PATH = '/jdm/trade/orders/order-details'
const JD_AFTERSALE_DETAILS_PATH = '/jdm/trade/after-sale/independent-after-sale/detail'
const JD_AFTERSALE_LIST_PATH = '/jdm/trade/after-sale/independent-after-sale/list'
const LOGISTICS_ACTION_PREFIX = '[DXE_ORDER_PURCHASE_LOGISTICS]'
const ORDER_PURCHASE_ACTION_CHANNEL = 'store-backend-order-purchase-action'
const ORDER_PURCHASE_RUNTIME_SOURCE_FILE = 'store-backend-order-purchase-panel-runtime.json'

const panelActionHandlers = new Map()
let panelIpcRegistered = false
let runtimeSourceCache = null
let runtimeSourceCachePath = ''

function registerOrderPurchasePanelIpc(ipcMain) {
  if (panelIpcRegistered) return
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('ipcMain.handle is required to register the order purchase panel bridge')
  }
  panelIpcRegistered = true
  ipcMain.handle(ORDER_PURCHASE_ACTION_CHANNEL, async (event, payload = {}) => {
    const handler = panelActionHandlers.get(event?.sender?.id)
    if (!handler) return { ok: false, error: '当前店铺后台页面尚未就绪，请刷新页面后重试' }
    try {
      const result = await handler(payload)
      return { ok: true, result: result || null }
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 300)
      }
    }
  })
}

const PURCHASE_TYPE_LABELS = {
  dropship: '三方代发',
  warehouse: '仓库转发',
  warehouse_in: '仓库进货'
}

const PURCHASE_STATUS_LABELS = {
  ordered: '已下单',
  pending: '待发货',
  shipped: '已发货',
  in_transit: '运输中',
  received: '已签收',
  pending_print: '待打印',
  forwarded: '已转发',
  stocked: '已入库',
  completed: '已完成',
  rejected: '已拒收',
  cancelled: '已取消'
}

const PURCHASE_AFTERSALE_STATUS_LABELS = {
  pending_refund: '待申请退款',
  pending_return_refund: '待申请退货退款',
  pending_return_tracking: '待退货上传单号',
  pending_merchant_handle: '待商家处理',
  closed: '售后关闭'
}

function getJdOrderId(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== JD_ORDER_DETAILS_HOST) return ''
    if (!parsed.pathname.startsWith(JD_ORDER_DETAILS_PATH)) return ''
    const orderId = String(parsed.searchParams.get('orderId') || '').trim()
    return /^\d{10,30}$/.test(orderId) ? orderId : ''
  } catch {
    return ''
  }
}

function getJdAftersaleServiceId(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== JD_ORDER_DETAILS_HOST) return ''
    if (!parsed.pathname.startsWith(JD_AFTERSALE_DETAILS_PATH)) return ''
    const serviceId = String(parsed.searchParams.get('afsServiceId') || '').trim()
    return /^\d{6,30}$/.test(serviceId) ? serviceId : ''
  } catch {
    return ''
  }
}

function getPurchasePanelPageKey(url) {
  const orderId = getJdOrderId(url)
  if (orderId) return `order:${orderId}`
  const serviceId = getJdAftersaleServiceId(url)
  return serviceId ? `aftersale:${serviceId}` : ''
}

function normalizeImageUrl(value) {
  const image = String(value || '').trim()
  if (!image) return ''
  if (/^https?:\/\//i.test(image)) return image
  if (image.startsWith('//')) return `https:${image}`
  return image
}

function normalizeMoney(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function normalizePurchaseOrder(row = {}) {
  const purchaseType = String(row.purchase_type || 'dropship').trim()
  const status = String(row.status || '').trim()
  const rawPlatform = String(row.platform || '').trim()
  const platform = rawPlatform === 'tmall' ? 'taobao' : rawPlatform
  const logisticsCompany = String(row.logistics_company || '').trim()
  const logisticsNo = String(row.logistics_no || '').trim()
  return {
    id: Number(row.id) || 0,
    purchaseNo: String(row.purchase_no || '').trim() || '未生成编号',
    salesOrderNo: String(row.sales_order_no || '').trim(),
    platform,
    platformLabel: platform === 'taobao' ? '淘宝/天猫' : platform === 'pinduoduo' ? '拼多多' : platform === '1688' ? '阿里巴巴' : (rawPlatform || '未知平台'),
    accountId: Number(row.account_id) || 0,
    accountName: String(row.account_name || '').trim(),
    platformOrderNo: String(row.platform_order_no || '').trim(),
    createdAt: String(row.created_at || '').trim(),
    updatedAt: String(row.updated_at || '').trim(),
    goodsName: String(row.goods_name || '').trim(),
    goodsImage: normalizeImageUrl(row.goods_image),
    sku: String(row.sku || '').trim(),
    quantity: Math.max(1, Number(row.quantity) || 1),
    actualQuantity: Math.max(0, Number(row.actual_quantity) || 0),
    purchasePrice: normalizeMoney(row.purchase_price),
    totalAmount: normalizeMoney(row.total_amount),
    shippingFee: normalizeMoney(row.shipping_fee),
    sourceUrl: String(row.source_url || '').trim(),
    warehouseName: String(row.warehouse_name || '').trim(),
    shippingName: String(row.shipping_name || '').trim(),
    shippingPhone: String(row.shipping_phone || '').trim(),
    shippingAddress: String(row.shipping_address || '').trim(),
    remark: String(row.remark || '').trim(),
    purchaseType,
    purchaseTypeLabel: PURCHASE_TYPE_LABELS[purchaseType] || purchaseType || '未知类型',
    status,
    statusLabel: PURCHASE_STATUS_LABELS[status] || status || '状态未知',
    aftersaleStatus: String(row.aftersale_status || '').trim(),
    aftersaleStatusLabel: PURCHASE_AFTERSALE_STATUS_LABELS[String(row.aftersale_status || '').trim()]
      || String(row.aftersale_status || '').trim()
      || '无售后',
    aftersaleRemark: String(row.aftersale_remark || '').trim(),
    logisticsCompany,
    logisticsNo,
    logisticsLabel: logisticsCompany || logisticsNo
      ? [logisticsCompany, logisticsNo].filter(Boolean).join(' · ')
      : '暂无物流信息'
  }
}

function requestJson(url, token = getAuthToken(), timeoutMs = 10000) {
  return requestBusinessJson(url, { token, timeoutMs })
}

function requestBusinessJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const token = options.token === undefined ? getAuthToken() : options.token
    const timeoutMs = Number(options.timeoutMs) || 10000
    const method = String(options.method || 'GET').toUpperCase()
    const requestBody = options.body === undefined ? '' : JSON.stringify(options.body)
    if (!token) {
      reject(new Error('请先登录店小二账号'))
      return
    }
    const parsed = new URL(url)
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(requestBody ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody)
        } : {})
      },
      timeout: timeoutMs
    }, response => {
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        let parsedBody
        try {
          parsedBody = JSON.parse(body || '{}')
        } catch {
          const error = new Error('采购信息响应无法解析')
          error.statusCode = Number(response.statusCode || 0)
          reject(error)
          return
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(parsedBody?.message || `采购信息请求失败（HTTP ${response.statusCode}）`)
          error.statusCode = Number(response.statusCode || 0)
          reject(error)
          return
        }
        resolve(parsedBody)
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('采购信息请求超时')))
    req.end(requestBody)
  })
}

function normalizeReturnLogisticsRecords(records, maxRecords = 200) {
  if (!Array.isArray(records)) return []
  const limit = Math.max(1, Math.min(200, Number(maxRecords) || 200))
  const controlChars = /[\u0000-\u001f\u007f]/
  const seen = new Set()
  const normalized = []
  for (const record of records.slice(0, limit)) {
    const salesOrderNo = String(record?.sales_order_no || record?.salesOrderNo || '').trim()
    const jdSku = String(record?.jd_sku || record?.jdSku || '').trim()
    const afsServiceId = String(record?.afs_service_id || record?.afsServiceId || '').trim()
    const logisticsNo = String(record?.logistics_no || record?.logisticsNo || record?.waybillCode || '').trim()
    const logisticsCompany = String(record?.logistics_company || record?.logisticsCompany || record?.providerName || '').trim()
    if (!/^\d{10,30}$/.test(salesOrderNo)) continue
    if (jdSku && !/^\d{5,30}$/.test(jdSku)) continue
    if (!/^\d{6,30}$/.test(afsServiceId)) continue
    if (!logisticsNo || logisticsNo.length > 100 || controlChars.test(logisticsNo)) continue
    if (logisticsCompany.length > 100 || controlChars.test(logisticsCompany)) continue
    const key = [salesOrderNo, jdSku, afsServiceId, logisticsNo].join(':')
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push({
      sales_order_no: salesOrderNo,
      jd_sku: jdSku,
      afs_service_id: afsServiceId,
      logistics_no: logisticsNo,
      logistics_company: logisticsCompany
    })
  }
  return normalized
}

function normalizeLogisticsTracking(data = {}) {
  const tracks = Array.isArray(data.tracks) ? data.tracks : []
  return {
    company: String(data.company || '').trim(),
    trackingNo: String(data.tracking_no || data.trackingNo || '').trim(),
    source: String(data.source || '').trim(),
    tracks: tracks.map(track => ({
      time: String(track?.time || track?.timestamp || '').trim(),
      context: String(track?.context || track?.desc || track?.message || '').trim()
    })).filter(track => track.time || track.context)
  }
}

async function fetchPurchaseOrderLogistics(purchaseId, options = {}) {
  const normalizedPurchaseId = Number(purchaseId)
  if (!Number.isSafeInteger(normalizedPurchaseId) || normalizedPurchaseId <= 0) {
    throw new Error('采购单ID无效')
  }
  const request = typeof options.request === 'function'
    ? options.request
    : url => requestJson(url, undefined, 20000)
  const response = await request(`${BUSINESS_SERVER}/api/purchase-orders/${normalizedPurchaseId}/logistics`)
  if (!response || Number(response.code) !== 0) {
    throw new Error(response?.message || '查询物流轨迹失败')
  }
  return normalizeLogisticsTracking(response.data)
}

async function updatePurchaseOrderAftersale(purchaseId, data = {}, options = {}) {
  const normalizedPurchaseId = Number(purchaseId)
  if (!Number.isSafeInteger(normalizedPurchaseId) || normalizedPurchaseId <= 0) {
    throw new Error('采购单ID无效')
  }
  const aftersaleStatus = String(data.aftersaleStatus || '').trim()
  if (!Object.prototype.hasOwnProperty.call(PURCHASE_AFTERSALE_STATUS_LABELS, aftersaleStatus)) {
    throw new Error('请选择有效的售后状态')
  }
  const aftersaleRemark = String(data.aftersaleRemark || '').trim()
  if (aftersaleRemark.length > 2000) throw new Error('售后处理日志不能超过2000字')
  const request = typeof options.request === 'function'
    ? options.request
    : (url, requestOptions) => requestBusinessJson(url, requestOptions)
  const response = await request(`${BUSINESS_SERVER}/api/purchase-orders/${normalizedPurchaseId}/status`, {
    method: 'PUT',
    body: {
      aftersale_status: aftersaleStatus,
      aftersale_remark: aftersaleRemark
    },
    timeoutMs: 15000
  })
  if (!response || Number(response.code) !== 0) {
    throw new Error(response?.message || '标记售后失败')
  }
  return {
    purchaseId: normalizedPurchaseId,
    aftersaleStatus,
    aftersaleRemark
  }
}

async function fetchPurchaseOrdersBySalesOrder(orderId, options = {}) {
  const normalizedOrderId = String(orderId || '').trim()
  if (!/^\d{10,30}$/.test(normalizedOrderId)) throw new Error('销售订单号无效')
  const request = typeof options.request === 'function' ? options.request : requestJson
  const exactUrl = `${BUSINESS_SERVER}/api/purchase-orders/by-sales-order/${encodeURIComponent(normalizedOrderId)}`
  let response = null
  let exactEndpointAvailable = false
  try {
    response = await request(exactUrl)
    exactEndpointAvailable = true
  } catch (error) {
    if (Number(error?.statusCode) !== 404) throw error
  }
  if (response && Number(response.code) !== 0) {
    throw new Error(response?.message || '读取采购信息失败')
  }

  const exactRows = Array.isArray(response?.data?.list) ? response.data.list : []
  const exactMatches = exactRows.filter(row => {
    const salesOrderNo = String(row?.sales_order_no || '').trim()
    const linkedSalesOrderNo = String(row?.linked_sales_order_no || '').trim()
    return salesOrderNo === normalizedOrderId || linkedSalesOrderNo === normalizedOrderId
  })
  if (exactEndpointAvailable) return exactMatches.map(normalizePurchaseOrder)

  // 兼容尚未部署精确接口、以及历史采购单只保存 sales_order_id 的情况。
  // 先走现有销售单号筛选；仍为空时再读取销售订单内部 ID，并有限分页匹配采购单。
  const fallbackUrl = `${BUSINESS_SERVER}/api/purchase-orders?page=1&pageSize=100` +
    `&salesOrderNo=${encodeURIComponent(normalizedOrderId)}`
  const fallbackResponse = await request(fallbackUrl)
  if (!fallbackResponse || Number(fallbackResponse.code) !== 0) {
    throw new Error(fallbackResponse?.message || '读取采购信息失败')
  }
  const directRows = Array.isArray(fallbackResponse.data?.list) ? fallbackResponse.data.list : []
  const directMatches = directRows.filter(row => String(row?.sales_order_no || '').trim() === normalizedOrderId)
  if (directMatches.length) return directMatches.map(normalizePurchaseOrder)

  const salesResponse = await request(
    `${BUSINESS_SERVER}/api/sales-orders?page=1&pageSize=5&order_id=${encodeURIComponent(normalizedOrderId)}`
  )
  if (!salesResponse || Number(salesResponse.code) !== 0) return []
  const internalIds = new Set(
    (Array.isArray(salesResponse.data?.list) ? salesResponse.data.list : [])
      .filter(row => String(row?.order_id || '').trim() === normalizedOrderId)
      .map(row => String(row?.id || '').trim())
      .filter(Boolean)
  )
  if (!internalIds.size) return []

  const pageSize = 100
  const maxPages = 20
  for (let page = 1; page <= maxPages; page += 1) {
    const pageResponse = await request(
      `${BUSINESS_SERVER}/api/purchase-orders?page=${page}&pageSize=${pageSize}`
    )
    if (!pageResponse || Number(pageResponse.code) !== 0) break
    const rows = Array.isArray(pageResponse.data?.list) ? pageResponse.data.list : []
    const matches = rows.filter(row => {
      const salesOrderNo = String(row?.sales_order_no || '').trim()
      const salesOrderId = String(row?.sales_order_id || '').trim()
      return salesOrderNo === normalizedOrderId || internalIds.has(salesOrderId)
    })
    if (matches.length) return matches.map(normalizePurchaseOrder)
    const total = Math.max(0, Number(pageResponse.data?.total) || 0)
    if (!rows.length || page * pageSize >= total) break
  }
  return []
}

async function fetchPurchaseAccounts(options = {}) {
  const request = typeof options.request === 'function' ? options.request : requestJson
  const response = await request(`${BUSINESS_SERVER}/api/purchase-accounts`)
  if (!response || Number(response.code) !== 0) {
    throw new Error(response?.message || '读取采购账号失败')
  }
  const rows = Array.isArray(response.data?.list) ? response.data.list : []
  return rows.map(row => ({
    id: Number(row.id) || 0,
    platform: String(row.platform || '').trim(),
    cookieValid: Boolean(row.cookie_valid),
    online: Boolean(row.online)
  })).filter(account => account.id && account.platform)
}

function serializeForJavaScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function getOrderPurchaseRuntimeSourcePath() {
  const explicitPath = String(process.env.DXE_ORDER_PURCHASE_RUNTIME_SOURCE || '').trim()
  if (explicitPath) return explicitPath
  if (!process.resourcesPath) {
    return path.join(__dirname, '..', '..', 'resources', ORDER_PURCHASE_RUNTIME_SOURCE_FILE)
  }
  return path.join(
    process.resourcesPath,
    'app.asar',
    'resources',
    ORDER_PURCHASE_RUNTIME_SOURCE_FILE
  )
}

function loadOrderPurchaseRuntimeSources() {
  const runtimeSourcePath = getOrderPurchaseRuntimeSourcePath()
  if (runtimeSourceCache && runtimeSourceCachePath === runtimeSourcePath) return runtimeSourceCache
  const parsed = JSON.parse(fs.readFileSync(runtimeSourcePath, 'utf8'))
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid order purchase panel runtime source resource')
  }
  runtimeSourceCache = parsed
  runtimeSourceCachePath = runtimeSourcePath
  return runtimeSourceCache
}

function resetOrderPurchaseRuntimeSourceCache() {
  runtimeSourceCache = null
  runtimeSourceCachePath = ''
}

function getOrderPurchaseRuntimeFunctionSource(name, fallbackFunction) {
  const inlineSource = Function.prototype.toString.call(fallbackFunction)
  const requiresExternalSource =
    process.env.DXE_MAIN_BYTECODE === '1' ||
    inlineSource.includes('[native code]')
  if (!requiresExternalSource) return inlineSource

  const runtimeSources = loadOrderPurchaseRuntimeSources()
  const externalSource = String(runtimeSources[name] || '').trim()
  if (!externalSource || externalSource.includes('[native code]')) {
    throw new Error(`Missing order purchase panel runtime function source: ${name}`)
  }
  return externalSource
}

function renderOrderPurchasePanel(model) {
  const STATE_KEY = '__DXE_ORDER_PURCHASE_PANEL_STATE__'
  const HOST_ID = 'dxe-order-purchase-panel-host'

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function sendAction(payload) {
    const bridge = window.dxeStoreBackendBridge
    if (bridge && typeof bridge.requestOrderPurchaseAction === 'function') {
      return bridge.requestOrderPurchaseAction(payload)
    }
    return Promise.resolve({
      ok: false,
      error: '当前标签页功能桥接未加载，请关闭店铺后台窗口后重新打开'
    })
  }

  function currentPageKey() {
    try {
      const parsed = new URL(location.href)
      const path = parsed.pathname
      const orderId = String(parsed.searchParams.get('orderId') || '').trim()
      if (path.startsWith('/jdm/trade/orders/order-details') && /^\d{10,30}$/.test(orderId)) {
        return `order:${orderId}`
      }
      const serviceId = String(parsed.searchParams.get('afsServiceId') || '').trim()
      if (path.startsWith('/jdm/trade/after-sale/independent-after-sale/detail') && /^\d{6,30}$/.test(serviceId)) {
        return `aftersale:${serviceId}`
      }
      return ''
    } catch {
      return ''
    }
  }

  const modelPageKey = String(model?.pageKey || `order:${model?.orderId || ''}`)
  if (!model || currentPageKey() !== modelPageKey) return false

  let state = window[STATE_KEY]
  if (!state || state.pageKey !== modelPageKey) {
    if (state?.observer) state.observer.disconnect()
    const previous = document.getElementById(HOST_ID)
    if (previous) previous.remove()
    state = {
      orderId: model.orderId,
      pageKey: modelPageKey,
      model,
      host: null,
      observer: null,
      mountTimer: null,
      attempts: 0
    }
    window[STATE_KEY] = state
  } else {
    state.model = model
  }

  function findMarkerCard(markerTexts) {
    const elements = document.querySelectorAll('h1,h2,h3,h4,div,span')
    let marker = null
    for (const element of elements) {
      if (element.childElementCount > 1) continue
      const text = String(element.textContent || '').trim()
      if (markerTexts.includes(text)) {
        marker = element
        break
      }
    }
    if (!marker) return null

    // JD's after-sale detail page is a two-column layout. The marker card lives
    // in the narrower left column, while the purchase panel must be inserted
    // before the complete left/right layout so it can use the full content width.
    const preferredWidth = Math.max(720, window.innerWidth * 0.6)
    const fallbackWidth = Math.max(560, window.innerWidth * 0.38)
    let fallback = null
    let node = marker
    while (node && node.parentElement && node.parentElement !== document.body) {
      const rect = node.getBoundingClientRect()
      if (rect.width >= preferredWidth && rect.height >= 80) return node
      if (!fallback && rect.width >= fallbackWidth && rect.height >= 100 && rect.height <= 900) {
        fallback = node
      }
      node = node.parentElement
    }
    return fallback
  }

  function findNearestMarkerCard(markerTexts) {
    const elements = document.querySelectorAll('h1,h2,h3,h4,div,span')
    let marker = null
    for (const element of elements) {
      if (element.childElementCount > 1) continue
      const text = String(element.textContent || '').trim()
      if (markerTexts.includes(text)) {
        marker = element
        break
      }
    }
    if (!marker) return null

    // 售后详情是左侧主内容 + 右侧商品信息的双栏结构。采购信息应放在
    // 左侧内容栏内，避免跨越右侧商品栏形成过宽的大框。
    const minWidth = Math.max(480, window.innerWidth * 0.32)
    let node = marker
    while (node && node.parentElement && node.parentElement !== document.body) {
      const rect = node.getBoundingClientRect()
      if (rect.width >= minWidth && rect.height >= 80 && rect.height <= 1200) return node
      node = node.parentElement
    }
    return null
  }

  function findTargetCard() {
    if (state.pageKey.startsWith('aftersale:')) {
      return findNearestMarkerCard([
        '售后单信息', '售后服务单信息', '服务单信息', '服务信息',
        '售后信息', '退款信息', '申请信息', '售后商品信息', '服务单日志',
        '商品信息', '协商记录', '处理记录'
      ])
    }
    return findMarkerCard(['订单信息'])
  }

  function ensureHost() {
    if (state.host && document.contains(state.host)) return state.host
    const anchor = findTargetCard()
    if (!anchor?.parentNode) return null
    const host = document.createElement('section')
    host.id = HOST_ID
    host.dataset.orderId = state.orderId
    host.dataset.pageKey = state.pageKey
    host.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin:10px 0;'
    anchor.parentNode.insertBefore(host, anchor)
    const anchorRect = anchor.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    const leftInset = Math.max(0, Math.round(anchorRect.left - hostRect.left))
    const rightInset = Math.max(0, Math.round(hostRect.right - anchorRect.right))
    if (leftInset || rightInset) {
      host.style.width = `calc(100% - ${leftInset + rightInset}px)`
      host.style.marginLeft = `${leftInset}px`
      host.style.marginRight = `${rightInset}px`
    }
    state.host = host
    return host
  }

  function statusClass(status) {
    if (['completed', 'received', 'forwarded', 'stocked'].includes(status)) return 'success'
    if (['cancelled', 'rejected'].includes(status)) return 'danger'
    if (['shipped', 'in_transit'].includes(status)) return 'primary'
    return 'warning'
  }

  function formatMoney(value) {
    const amount = Number(value)
    return Number.isFinite(amount) ? `¥${amount.toFixed(2)}` : '--'
  }

  function formatTime(value) {
    if (!value) return '--'
    const text = String(value).replace('T', ' ').replace(/\.\d{3}Z?$/, '')
    return text.length > 19 ? text.slice(0, 19) : text
  }

  function render() {
    const host = ensureHost()
    if (!host) return false
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' })
    const current = state.model || {}
    const orders = Array.isArray(current.orders) ? current.orders : []
    const syncableCount = orders.filter(order => order.platform && order.platformOrderNo).length
    const markableOrders = orders.filter(order => Number(order.id) > 0 && order.status !== 'cancelled')

    let content = ''
    if (current.state === 'loading') {
      content = '<div class="message loading"><i></i><span>正在读取对应采购单信息…</span></div>'
    } else if (current.state === 'error') {
      content = `<div class="message error">${escapeHtml(current.message || '采购信息读取失败')}</div>`
    } else if (!orders.length) {
      content = '<div class="message empty">该销售订单暂未生成采购单</div>'
    } else {
      content = `<div class="orders">${orders.map((order, index) => `
        <article class="order">
          <div class="order-titlebar">
            <div class="order-meta">
              <span class="order-index">${orders.length > 1 ? `采购单 ${index + 1}` : '采购单'}</span>
              <strong>${escapeHtml(order.purchaseNo)}</strong>
              <span class="meta-sep">|</span><span>采购订单号</span><b>${escapeHtml(order.platformOrderNo || '--')}</b>
              <span class="meta-sep">|</span><b>${escapeHtml(order.platformLabel || '--')}</b>
              <span class="meta-sep">|</span><span>采购账户</span><b>${escapeHtml(order.accountName || '--')}</b>
              <span class="meta-sep">|</span><span>${escapeHtml(formatTime(order.createdAt))}</span>
            </div>
            <b class="tag ${statusClass(order.status)}">${escapeHtml(order.statusLabel)}</b>
          </div>
          <div class="order-main">
            <div class="product">
              ${order.goodsImage ? `<img src="${escapeHtml(order.goodsImage)}" alt="" referrerpolicy="no-referrer">` : '<div class="image-placeholder">无图</div>'}
              <div class="product-text"><strong title="${escapeHtml(order.goodsName)}">${escapeHtml(order.goodsName || '--')}</strong><span class="type-pill">${escapeHtml(order.purchaseTypeLabel)}</span></div>
            </div>
            <div class="amount"><span>采购单价 / 数量</span><strong>${escapeHtml(formatMoney(order.purchasePrice))}</strong><span>×${escapeHtml(order.quantity || 1)}${order.actualQuantity ? `（实采 ${escapeHtml(order.actualQuantity)}）` : ''}</span></div>
            <div class="amount total"><span>实付总额</span><strong>${escapeHtml(formatMoney(order.totalAmount))}</strong><span>含运费 ${escapeHtml(formatMoney(order.shippingFee))}</span></div>
            <div class="warehouse"><span>售后状态</span><em class="aftersale-state">${escapeHtml(order.aftersaleStatusLabel || '无售后')}</em></div>
            <div class="logistics"><span>物流信息</span>${order.logisticsNo
              ? `<div class="logistics-content"><b class="logistics-value" title="双击或右键可复制物流单号">${escapeHtml(order.logisticsLabel)}</b><button class="logistics-link" type="button" data-purchase-id="${escapeHtml(order.id)}" data-company="${escapeHtml(order.logisticsCompany)}" data-tracking-no="${escapeHtml(order.logisticsNo)}" title="点击查看物流轨迹">查看轨迹</button></div>`
              : `<b title="${escapeHtml(order.logisticsLabel)}">${escapeHtml(order.logisticsLabel)}</b>`}</div>
          </div>
          ${(order.shippingName || order.shippingPhone || order.shippingAddress || order.sourceUrl || order.remark || order.aftersaleRemark || order.updatedAt) ? `<div class="order-footer">
            ${(order.shippingName || order.shippingPhone || order.shippingAddress) ? `<span>收件地址：${escapeHtml([order.shippingName, order.shippingPhone, order.shippingAddress].filter(Boolean).join(' '))}</span>` : ''}
            ${order.sourceUrl ? `<a href="${escapeHtml(order.sourceUrl)}" target="_blank" rel="noopener noreferrer">货源链接</a>` : ''}
            ${order.remark ? `<span>采购备注：${escapeHtml(order.remark)}</span>` : ''}
            ${order.aftersaleRemark ? `<span>售后备注：${escapeHtml(order.aftersaleRemark)}</span>` : ''}
            ${order.updatedAt ? `<span class="updated-at">更新时间：${escapeHtml(formatTime(order.updatedAt))}</span>` : ''}
          </div>` : ''}
        </article>
      `).join('')}</div>`
    }

    root.innerHTML = `
      <style>
        :host{all:initial;display:block;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#262626}
        *{box-sizing:border-box}
        .panel{width:100%;background:#fff;border:1px solid #e5e8ef;border-radius:8px;box-shadow:0 1px 4px rgba(31,35,41,.06);overflow:hidden}
        .header{height:46px;padding:0 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #edf0f5;background:linear-gradient(90deg,#f7f9ff 0,#fff 42%)}
        .heading{display:flex;align-items:center;gap:9px;font-size:16px;font-weight:600;color:#1f2329}
        .heading:before{content:"";width:4px;height:18px;border-radius:3px;background:#315efb}
        .sales-no{font-size:12px;font-weight:400;color:#8f959e}
        .header-actions{display:flex;align-items:center;gap:5px}.header-action{border:0;background:transparent;color:#315efb;font-size:13px;cursor:pointer;padding:5px 8px;border-radius:4px;white-space:nowrap}
        .header-action:hover{background:#eef3ff}.header-action:disabled{cursor:not-allowed;color:#b8bdc7;background:transparent}.sync.success{color:#0a8f55}.sync.error{color:#d93b3b}.mark-aftersale{color:#e5484d}.mark-aftersale:hover{background:#fff0f0}.mark-aftersale:disabled{color:#b8bdc7}
        .body{padding:10px 14px 12px}
        .orders{display:grid;gap:8px}
        .order{border:1px solid #e7eaf0;border-radius:7px;background:#fafbfc;overflow:hidden}
        .order-titlebar{min-height:38px;padding:6px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid #edf0f5;background:#fff}
        .order-meta{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0;color:#7d838d;font-size:12px}
        .order-meta>strong,.order-meta>b{font-size:13px;font-weight:600;color:#262b33;overflow:hidden;text-overflow:ellipsis}.meta-sep{color:#d2d6dd}
        .order-index{font-size:12px;color:#315efb;background:#eef3ff;border-radius:4px;padding:2px 6px;white-space:nowrap}
        .order-main{min-height:76px;padding:8px 12px;display:grid;grid-template-columns:minmax(250px,2fr) minmax(86px,.55fr) minmax(104px,.65fr) minmax(112px,.75fr) minmax(210px,1.45fr);gap:12px;align-items:center}
        .product{display:flex;align-items:center;gap:9px;min-width:0}.product img,.image-placeholder{width:52px;height:52px;flex:0 0 52px;border:1px solid #e5e8ef;border-radius:5px;object-fit:cover;background:#f2f3f5}.image-placeholder{display:flex;align-items:center;justify-content:center;color:#a5abb4;font-size:12px}
        .product-text{display:flex;flex-direction:column;align-items:flex-start;gap:3px;min-width:0}.product-text>strong{max-width:100%;font-size:13px;line-height:18px;color:#262b33;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.product-text>span{font-size:12px;color:#8f959e}.product-text .type-pill{padding:1px 6px;border-radius:9px;color:#b56a00;background:#fff3dc}
        .amount{display:flex;flex-direction:column;align-items:flex-start;gap:3px;font-size:12px;color:#8f959e}.amount strong{font-size:14px;color:#30343b}.amount.total strong{color:#ef4f23}
        .warehouse,.logistics{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0;font-size:12px}.warehouse>span,.logistics>span{color:#8f959e}.warehouse>b,.logistics>b{max-width:100%;font-weight:500;color:#30343b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.aftersale-state{max-width:100%;font-style:normal;color:#b56a00;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .logistics-content{display:flex;align-items:center;gap:10px;min-width:0;max-width:100%}.logistics-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:#315efb;cursor:text;user-select:text;-webkit-user-select:text}
        .logistics-link{flex:0 0 auto;padding:3px 5px;border:0;border-radius:4px;background:transparent;color:#315efb;cursor:pointer;font-size:12px;white-space:nowrap}
        .logistics-link:hover{background:#eef3ff}
        .order-footer{min-height:30px;padding:5px 12px;display:flex;align-items:center;flex-wrap:wrap;gap:6px 16px;border-top:1px solid #edf0f5;background:#fff;color:#7d838d;font-size:12px}.order-footer span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.order-footer a{flex:0 0 auto;color:#315efb;text-decoration:none}.order-footer a:hover{text-decoration:underline}.order-footer .updated-at{margin-left:auto;flex:0 0 auto}
        .tag{display:inline-flex!important;align-items:center;overflow:visible!important;padding:2px 7px;border-radius:10px;font-size:12px;line-height:18px}
        .tag.success{color:#0a8f55;background:#e8f8f0}.tag.danger{color:#d93b3b;background:#fff0f0}
        .tag.primary{color:#315efb;background:#eef3ff}.tag.warning{color:#b56a00;background:#fff5e5}
        .message{min-height:52px;display:flex;align-items:center;justify-content:center;font-size:14px;color:#8f959e}
        .message.loading{gap:9px}.message.loading i{width:16px;height:16px;border:2px solid #d9e2ff;border-top-color:#315efb;border-radius:50%;animation:spin .8s linear infinite}
        .message.error{color:#d93b3b}.message.empty{color:#8f959e}
        .dialog-backdrop[hidden],.aftersale-backdrop[hidden]{display:none}.dialog-backdrop,.aftersale-backdrop{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(17,24,39,.46)}
        .dialog{width:min(650px,calc(100vw - 48px));max-height:min(720px,calc(100vh - 48px));display:flex;flex-direction:column;background:#fff;border-radius:10px;box-shadow:0 18px 55px rgba(0,0,0,.22);overflow:hidden}
        .dialog-header{height:54px;padding:0 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #edf0f5}
        .dialog-title{font-size:16px;font-weight:600;color:#1f2329}.dialog-close{width:30px;height:30px;border:0;border-radius:5px;background:transparent;color:#8f959e;font-size:24px;line-height:28px;cursor:pointer}.dialog-close:hover{background:#f2f3f5;color:#30343b}
        .dialog-summary{padding:15px 20px 12px;display:flex;align-items:center;gap:10px;color:#30343b;font-size:13px;border-bottom:1px solid #f2f3f5}.dialog-summary .sep{color:#c5c9d0}.dialog-summary .source{padding:2px 7px;border-radius:10px;color:#315efb;background:#eef3ff;font-size:12px}
        .dialog-body{min-height:190px;max-height:520px;padding:18px 24px 22px;overflow:auto}.dialog-message{min-height:154px;display:flex;align-items:center;justify-content:center;gap:9px;color:#8f959e;font-size:14px}.dialog-message.error{color:#d93b3b}
        .dialog-message i{width:18px;height:18px;border:2px solid #d9e2ff;border-top-color:#315efb;border-radius:50%;animation:spin .8s linear infinite}
        .track{display:grid;grid-template-columns:142px 18px minmax(0,1fr);column-gap:12px;min-height:62px}.track-time{padding-top:1px;color:#8f959e;font-size:12px;line-height:19px}.track-axis{position:relative;display:flex;justify-content:center}.track-dot{position:relative;z-index:1;width:9px;height:9px;margin-top:5px;border:2px solid #aeb8d0;border-radius:50%;background:#fff}.track:first-child .track-dot{width:11px;height:11px;margin-top:4px;border-color:#315efb;background:#315efb}.track-line{position:absolute;top:14px;bottom:-5px;width:1px;background:#dfe3eb}.track-text{padding-bottom:20px;color:#30343b;font-size:13px;line-height:20px;word-break:break-word}.track:first-child .track-text{color:#315efb;font-weight:500}
        .aftersale-dialog{width:min(520px,calc(100vw - 48px))}.aftersale-form{padding:20px 24px 8px;display:grid;gap:17px}.form-row{display:grid;grid-template-columns:92px minmax(0,1fr);align-items:center;gap:12px}.form-row.textarea-row{align-items:start}.form-label{padding-top:1px;color:#4e5661;font-size:13px;text-align:right}.form-control{width:100%;height:36px;padding:0 11px;border:1px solid #d9dde5;border-radius:6px;background:#fff;color:#262b33;font:13px/34px inherit;outline:none}.form-control:focus{border-color:#315efb;box-shadow:0 0 0 2px rgba(49,94,251,.1)}textarea.form-control{height:92px;padding:9px 11px;line-height:20px;resize:vertical}.quick-select{height:32px;color:#5d6570}.dialog-footer{min-height:62px;padding:12px 20px;display:flex;align-items:center;gap:10px;border-top:1px solid #edf0f5;background:#fafbfc}.save-message{flex:1;color:#d93b3b;font-size:12px;line-height:18px}.dialog-button{height:34px;min-width:74px;padding:0 16px;border:1px solid #d9dde5;border-radius:6px;background:#fff;color:#30343b;font-size:13px;cursor:pointer}.dialog-button:hover{border-color:#9db2ff;color:#315efb}.dialog-button.primary{border-color:#315efb;background:#315efb;color:#fff}.dialog-button.primary:hover{border-color:#244be0;background:#244be0}.dialog-button:disabled{cursor:not-allowed;opacity:.58}
        @keyframes spin{to{transform:rotate(360deg)}}
        @media(max-width:1150px){.order-main{grid-template-columns:minmax(250px,1.7fr) minmax(86px,.55fr) minmax(104px,.65fr) minmax(210px,1.35fr)}}
        @media(max-width:950px){.order-main{grid-template-columns:1fr 1fr}.product,.logistics{grid-column:1/-1}.header{padding:0 14px}.body{padding:12px 14px}.sales-no{display:none}.track{grid-template-columns:105px 18px minmax(0,1fr)}}
      </style>
      <div class="panel">
        <div class="header">
          <div class="heading">店小二采购信息 <span class="sales-no">销售订单：${escapeHtml(current.orderId || '')}</span></div>
          <div class="header-actions">
            <button class="header-action sync" type="button" title="${syncableCount ? `同步当前 ${syncableCount} 个平台采购订单的状态和物流` : '当前没有可同步的平台采购订单'}" ${syncableCount ? '' : 'disabled'}>同步采购单</button>
            <button class="header-action mark-aftersale" type="button" title="${markableOrders.length ? '为采购单记录售后状态和处理日志' : '当前没有可标记售后的采购单'}" ${markableOrders.length ? '' : 'disabled'}>标记售后</button>
          </div>
        </div>
        <div class="body">${content}</div>
      </div>
      <div class="dialog-backdrop" hidden>
        <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dxe-logistics-dialog-title">
          <div class="dialog-header"><div class="dialog-title" id="dxe-logistics-dialog-title">物流轨迹</div><button class="dialog-close" type="button" title="关闭">×</button></div>
          <div class="dialog-summary"><span class="dialog-company">--</span><span class="sep">|</span><span class="dialog-tracking-no">--</span><span class="source" hidden></span></div>
          <div class="dialog-body"><div class="dialog-message"><i></i><span>正在查询物流轨迹...</span></div></div>
        </section>
      </div>
      <div class="aftersale-backdrop" hidden>
        <section class="dialog aftersale-dialog" role="dialog" aria-modal="true" aria-labelledby="dxe-aftersale-dialog-title">
          <div class="dialog-header"><div class="dialog-title" id="dxe-aftersale-dialog-title">标记售后</div><button class="dialog-close aftersale-close" type="button" title="关闭">×</button></div>
          <div class="aftersale-form">
            <label class="form-row"><span class="form-label">采购单</span><select class="form-control aftersale-purchase">${markableOrders.map(order => `<option value="${escapeHtml(order.id)}">${escapeHtml(order.purchaseNo)}${order.platformOrderNo ? ` · ${escapeHtml(order.platformOrderNo)}` : ''}</option>`).join('')}</select></label>
            <label class="form-row"><span class="form-label">售后状态</span><select class="form-control aftersale-status">
              <option value="pending_refund">待申请退款</option>
              <option value="pending_return_refund">待申请退货退款</option>
              <option value="pending_return_tracking">待退货上传单号</option>
              <option value="pending_merchant_handle">待商家处理</option>
              <option value="closed">售后关闭</option>
            </select></label>
            <label class="form-row textarea-row"><span class="form-label">售后处理日志</span><textarea class="form-control aftersale-remark" maxlength="2000" placeholder="记录售后现状，方便后续处理"></textarea></label>
            <label class="form-row"><span class="form-label">快捷短语</span><select class="form-control quick-select"><option value="">请选择快捷短语</option><option value="0">用户已退款，商品已拒收，请申请退款。</option><option value="1">用户已退款，商品拒收失败，请申请退货退款。</option><option value="2">用户已退款，请申请退货退款。</option></select></label>
          </div>
          <div class="dialog-footer"><span class="save-message"></span><button class="dialog-button aftersale-cancel" type="button">取消</button><button class="dialog-button primary aftersale-save" type="button">确认</button></div>
        </section>
      </div>`
    root.querySelector('.sync')?.addEventListener('click', event => {
      const button = event.currentTarget
      if (!syncableCount || !current.actionNonce || !current.actionPrefix || button.disabled) return
      button.disabled = true
      button.classList.remove('success', 'error')
      button.textContent = `同步中 0/${syncableCount}`
      button.title = '正在同步采购订单状态和物流，请勿重复点击'
      sendAction({
        nonce: current.actionNonce,
        action: 'sync-orders',
        orderId: current.orderId,
        pageKey: current.pageKey
      }).then(response => {
        if (!response || response.ok !== false) return
        button.disabled = false
        button.classList.add('error')
        button.textContent = '同步失败，重试'
        button.title = response.error || '同步采购单失败'
      }).catch(error => {
        button.disabled = false
        button.classList.add('error')
        button.textContent = '同步失败，重试'
        button.title = error?.message || String(error)
      })
    })
    const backdrop = root.querySelector('.dialog-backdrop')
    const closeDialog = () => { backdrop.hidden = true }
    root.querySelector('.dialog-close')?.addEventListener('click', closeDialog)
    backdrop?.addEventListener('click', event => {
      if (event.target === backdrop) closeDialog()
    })
    const aftersaleBackdrop = root.querySelector('.aftersale-backdrop')
    const aftersalePurchase = root.querySelector('.aftersale-purchase')
    const aftersaleStatus = root.querySelector('.aftersale-status')
    const aftersaleRemark = root.querySelector('.aftersale-remark')
    const quickSelect = root.querySelector('.quick-select')
    const saveMessage = root.querySelector('.save-message')
    const saveButton = root.querySelector('.aftersale-save')
    const fillAftersaleForm = purchaseId => {
      const purchase = markableOrders.find(order => String(order.id) === String(purchaseId)) || markableOrders[0]
      if (!purchase) return
      aftersalePurchase.value = String(purchase.id)
      aftersaleStatus.value = purchase.aftersaleStatus && purchase.aftersaleStatus !== 'none' ? purchase.aftersaleStatus : 'pending_refund'
      aftersaleRemark.value = purchase.aftersaleRemark || ''
      quickSelect.value = ''
      saveMessage.textContent = ''
    }
    const closeAftersaleDialog = () => {
      if (saveButton?.disabled) return
      aftersaleBackdrop.hidden = true
    }
    root.querySelector('.mark-aftersale')?.addEventListener('click', () => {
      if (!markableOrders.length || !current.actionNonce || !current.actionPrefix) return
      fillAftersaleForm(markableOrders[0].id)
      aftersaleBackdrop.hidden = false
      aftersalePurchase?.focus()
    })
    aftersalePurchase?.addEventListener('change', () => fillAftersaleForm(aftersalePurchase.value))
    quickSelect?.addEventListener('change', () => {
      const phrases = [
        { text: '用户已退款，商品已拒收，请申请退款。', status: 'pending_refund' },
        { text: '用户已退款，商品拒收失败，请申请退货退款。', status: 'pending_return_refund' },
        { text: '用户已退款，请申请退货退款。', status: 'pending_return_refund' }
      ]
      const phrase = phrases[Number(quickSelect.value)]
      if (!phrase) return
      aftersaleRemark.value = phrase.text
      aftersaleStatus.value = phrase.status
    })
    root.querySelector('.aftersale-close')?.addEventListener('click', closeAftersaleDialog)
    root.querySelector('.aftersale-cancel')?.addEventListener('click', closeAftersaleDialog)
    aftersaleBackdrop?.addEventListener('click', event => {
      if (event.target === aftersaleBackdrop) closeAftersaleDialog()
    })
    saveButton?.addEventListener('click', () => {
      const purchaseId = Number(aftersalePurchase?.value || 0)
      if (!purchaseId || !aftersaleStatus?.value || !current.actionNonce || !current.actionPrefix || saveButton.disabled) return
      saveButton.disabled = true
      saveButton.textContent = '保存中...'
      saveMessage.textContent = ''
      sendAction({
        nonce: current.actionNonce,
        action: 'mark-aftersale',
        orderId: current.orderId,
        pageKey: current.pageKey,
        purchaseId,
        aftersaleStatus: aftersaleStatus.value,
        aftersaleRemark: aftersaleRemark.value
      }).then(response => {
        if (response?.ok === false) throw new Error(response.error || '标记售后失败')
        aftersaleBackdrop.hidden = true
      }).catch(error => {
        saveButton.disabled = false
        saveButton.textContent = '确认'
        saveMessage.textContent = error?.message || String(error)
      })
    })
    root.querySelectorAll('.logistics-link').forEach(button => {
      button.addEventListener('click', () => {
        const purchaseId = Number(button.dataset.purchaseId || 0)
        if (!purchaseId || !current.actionNonce || !current.actionPrefix) return
        backdrop.dataset.purchaseId = String(purchaseId)
        root.querySelector('.dialog-company').textContent = button.dataset.company || '--'
        root.querySelector('.dialog-tracking-no').textContent = button.dataset.trackingNo || '--'
        const source = root.querySelector('.source')
        source.hidden = true
        source.textContent = ''
        root.querySelector('.dialog-body').innerHTML = '<div class="dialog-message"><i></i><span>正在查询物流轨迹...</span></div>'
        backdrop.hidden = false
        root.querySelector('.dialog-close')?.focus()
        const requestPurchaseId = String(purchaseId)
        setTimeout(() => {
          if (backdrop.hidden || backdrop.dataset.purchaseId !== requestPurchaseId) return
          if (!root.querySelector('.dialog-body .dialog-message i')) return
          root.querySelector('.dialog-body').innerHTML = '<div class="dialog-message error">查询物流轨迹超时，请重试</div>'
        }, 22000)
        sendAction({
          nonce: current.actionNonce,
          action: 'view-logistics',
          orderId: current.orderId,
          pageKey: current.pageKey,
          purchaseId
        }).then(response => {
          if (!response || response.ok !== false) return
          if (backdrop.hidden || backdrop.dataset.purchaseId !== requestPurchaseId) return
          root.querySelector('.dialog-body').innerHTML = `<div class="dialog-message error">${escapeHtml(response.error || '查询物流轨迹失败')}</div>`
        }).catch(error => {
          if (backdrop.hidden || backdrop.dataset.purchaseId !== requestPurchaseId) return
          root.querySelector('.dialog-body').innerHTML = `<div class="dialog-message error">${escapeHtml(error?.message || String(error))}</div>`
        })
      })
    })
    return true
  }

  function scheduleMount() {
    if (state.mountTimer) clearTimeout(state.mountTimer)
    state.mountTimer = setTimeout(() => {
      state.mountTimer = null
      if (currentPageKey() !== state.pageKey) return
      if (!render() && state.attempts++ < 40) scheduleMount()
    }, state.attempts ? 300 : 0)
  }

  const mounted = render()
  if (!mounted) scheduleMount()
  if (!state.observer && document.body) {
    state.observer = new MutationObserver(() => {
      if (!state.host || !document.contains(state.host)) scheduleMount()
    })
    state.observer.observe(document.body, { childList: true, subtree: true })
  }
  return {
    accepted: true,
    mounted,
    pageKey: state.pageKey,
    hostConnected: Boolean(state.host && document.contains(state.host))
  }
}

function renderOrderPurchaseLogisticsResult(model) {
  function currentPageKey() {
    try {
      const parsed = new URL(location.href)
      const orderId = String(parsed.searchParams.get('orderId') || '').trim()
      if (parsed.pathname.startsWith('/jdm/trade/orders/order-details') && /^\d{10,30}$/.test(orderId)) return `order:${orderId}`
      const serviceId = String(parsed.searchParams.get('afsServiceId') || '').trim()
      if (parsed.pathname.startsWith('/jdm/trade/after-sale/independent-after-sale/detail') && /^\d{6,30}$/.test(serviceId)) return `aftersale:${serviceId}`
      return ''
    } catch {
      return ''
    }
  }

  const state = window.__DXE_ORDER_PURCHASE_PANEL_STATE__
  const host = document.getElementById('dxe-order-purchase-panel-host')
  const root = host?.shadowRoot
  const backdrop = root?.querySelector('.dialog-backdrop')
  const modelPageKey = String(model?.pageKey || `order:${model?.orderId || ''}`)
  if (!state || !root || !backdrop || currentPageKey() !== modelPageKey || state.pageKey !== modelPageKey) return false
  if (String(backdrop.dataset.purchaseId || '') !== String(model?.purchaseId || '')) return false

  const body = root.querySelector('.dialog-body')
  if (!body) return false
  const sourceLabels = { taobao: '淘宝', '1688': '阿里巴巴', pinduoduo: '拼多多', local: '本地', express100: '快递100' }
  const source = root.querySelector('.source')
  const escapeHtml = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

  if (model.state === 'error') {
    body.innerHTML = `<div class="dialog-message error">${escapeHtml(model.message || '物流轨迹查询失败')}</div>`
    return true
  }

  const data = model.data || {}
  const tracks = Array.isArray(data.tracks) ? data.tracks : []
  root.querySelector('.dialog-company').textContent = data.company || root.querySelector('.dialog-company').textContent || '--'
  root.querySelector('.dialog-tracking-no').textContent = data.trackingNo || root.querySelector('.dialog-tracking-no').textContent || '--'
  const sourceLabel = sourceLabels[data.source] || data.source || ''
  source.textContent = sourceLabel
  source.hidden = !sourceLabel

  if (!tracks.length) {
    body.innerHTML = '<div class="dialog-message">暂无详细物流轨迹，可到采购平台查看</div>'
    return true
  }
  body.innerHTML = `<div class="tracks">${tracks.map((track, index) => `
    <div class="track">
      <div class="track-time">${escapeHtml(track.time || '')}</div>
      <div class="track-axis"><span class="track-dot"></span>${index < tracks.length - 1 ? '<span class="track-line"></span>' : ''}</div>
      <div class="track-text">${escapeHtml(track.context || '')}</div>
    </div>
  `).join('')}</div>`
  return true
}

function renderOrderPurchaseSyncState(model) {
  function currentPageKey() {
    try {
      const parsed = new URL(location.href)
      const orderId = String(parsed.searchParams.get('orderId') || '').trim()
      if (parsed.pathname.startsWith('/jdm/trade/orders/order-details') && /^\d{10,30}$/.test(orderId)) return `order:${orderId}`
      const serviceId = String(parsed.searchParams.get('afsServiceId') || '').trim()
      if (parsed.pathname.startsWith('/jdm/trade/after-sale/independent-after-sale/detail') && /^\d{6,30}$/.test(serviceId)) return `aftersale:${serviceId}`
      return ''
    } catch {
      return ''
    }
  }

  const state = window.__DXE_ORDER_PURCHASE_PANEL_STATE__
  const root = document.getElementById('dxe-order-purchase-panel-host')?.shadowRoot
  const button = root?.querySelector('.sync')
  const modelPageKey = String(model?.pageKey || `order:${model?.orderId || ''}`)
  if (!state || !button || currentPageKey() !== modelPageKey || state.pageKey !== modelPageKey) return false
  if (state.syncResetTimer) {
    clearTimeout(state.syncResetTimer)
    state.syncResetTimer = null
  }

  button.classList.remove('success', 'error')
  if (model.state === 'loading' || model.state === 'progress') {
    const current = Math.max(0, Number(model.current) || 0)
    const total = Math.max(0, Number(model.total) || 0)
    button.disabled = true
    button.textContent = `同步中 ${current}/${total}`
    button.title = model.purchaseNo ? `正在同步采购单 ${model.purchaseNo}` : '正在同步采购订单状态和物流'
    return true
  }

  const successCount = Math.max(0, Number(model.successCount) || 0)
  const failCount = Math.max(0, Number(model.failCount) || 0)
  button.disabled = false
  if (model.state === 'ready' && failCount === 0) {
    button.classList.add('success')
    button.textContent = '同步完成'
    button.title = `已同步 ${successCount} 个采购单，并重新读取最新信息`
  } else {
    button.classList.add('error')
    button.textContent = successCount ? '部分失败，重试' : '同步失败，重试'
    button.title = model.message || `同步成功 ${successCount} 个，失败 ${failCount} 个`
  }
  state.syncResetTimer = setTimeout(() => {
    if (!button.isConnected) return
    button.classList.remove('success', 'error')
    button.textContent = '同步采购单'
    const count = Array.isArray(state.model?.orders)
      ? state.model.orders.filter(order => order.platform && order.platformOrderNo).length
      : 0
    button.title = count ? `同步当前 ${count} 个平台采购订单的状态和物流` : '当前没有可同步的平台采购订单'
  }, 5000)
  return true
}

function discoverAfterSaleSalesOrder(serviceId) {
  const normalizedServiceId = String(serviceId || '').trim()
  try {
    const parsed = new URL(location.href)
    if (!parsed.pathname.startsWith('/jdm/trade/after-sale/independent-after-sale/detail')) return null
    if (String(parsed.searchParams.get('afsServiceId') || '').trim() !== normalizedServiceId) return null
  } catch {
    return null
  }

  const validOrderId = value => {
    const text = String(value == null ? '' : value).trim()
    return /^\d{10,30}$/.test(text) && text !== normalizedServiceId ? text : ''
  }

  for (const link of document.querySelectorAll('a[href*="orderId="]')) {
    try {
      const orderId = validOrderId(new URL(link.href, location.href).searchParams.get('orderId'))
      if (orderId) return { orderId, evidence: 'order_link' }
    } catch (_) {}
  }

  const orderKeys = new Set(['orderid', 'orderno', 'jdorderid', 'mainorderid', 'parentorderid', 'ordercode'])
  const visited = new WeakSet()
  const scan = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 7 || visited.has(value)) return ''
    visited.add(value)
    for (const [key, child] of Object.entries(value)) {
      if (orderKeys.has(String(key).replace(/[_-]/g, '').toLowerCase())) {
        const orderId = validOrderId(child)
        if (orderId) return orderId
      }
    }
    for (const child of Object.values(value)) {
      const orderId = scan(child, depth + 1)
      if (orderId) return orderId
    }
    return ''
  }

  for (const stateName of ['__INITIAL_STATE__', '__INITIAL_DATA__', '__NEXT_DATA__', '__APOLLO_STATE__']) {
    const orderId = scan(window[stateName])
    if (orderId) return { orderId, evidence: `page_state:${stateName}` }
  }

  for (const script of document.querySelectorAll('script[type="application/json"]')) {
    try {
      const orderId = scan(JSON.parse(script.textContent || 'null'))
      if (orderId) return { orderId, evidence: 'structured_json' }
    } catch (_) {}
  }

  const labels = document.querySelectorAll('div,span,dt,th,label')
  for (const label of labels) {
    if (label.childElementCount > 1) continue
    const text = String(label.textContent || '').replace(/\s+/g, '')
    if (!/^(京东)?订单(编号|号)[:：]?$/.test(text)) continue
    const containerText = String(label.parentElement?.textContent || '').replace(/\s+/g, ' ')
    const match = containerText.match(/(?:京东)?订单(?:编号|号)\s*[:：]?\s*(\d{10,30})/)
    const orderId = validOrderId(match?.[1])
    if (orderId) return { orderId, evidence: 'labeled_order_id' }
  }
  return null
}

function buildOrderPurchasePanelScript(model) {
  return `(${getOrderPurchaseRuntimeFunctionSource('renderOrderPurchasePanel', renderOrderPurchasePanel)})(${serializeForJavaScript(model)})`
}

function buildOrderPurchaseLogisticsScript(model) {
  return `(${getOrderPurchaseRuntimeFunctionSource('renderOrderPurchaseLogisticsResult', renderOrderPurchaseLogisticsResult)})(${serializeForJavaScript(model)})`
}

function buildOrderPurchaseSyncStateScript(model) {
  return `(${getOrderPurchaseRuntimeFunctionSource('renderOrderPurchaseSyncState', renderOrderPurchaseSyncState)})(${serializeForJavaScript(model)})`
}

function buildAfterSaleOrderDiscoveryScript(serviceId) {
  return `(${getOrderPurchaseRuntimeFunctionSource('discoverAfterSaleSalesOrder', discoverAfterSaleSalesOrder)})(${serializeForJavaScript(serviceId)})`
}

const REMOVE_PANEL_SCRIPT = `(() => {
  const state = window.__DXE_ORDER_PURCHASE_PANEL_STATE__;
  if (state?.observer) state.observer.disconnect();
  if (state?.mountTimer) clearTimeout(state.mountTimer);
  if (state?.syncResetTimer) clearTimeout(state.syncResetTimer);
  document.getElementById('dxe-order-purchase-panel-host')?.remove();
  delete window.__DXE_ORDER_PURCHASE_PANEL_STATE__;
  return true;
})()`

function attachOrderPurchasePanel(webContents, options = {}) {
  if (!webContents || webContents.isDestroyed() || webContents.__dxeOrderPurchasePanelAttached) return
  webContents.__dxeOrderPurchasePanelAttached = true

  const runtimeLog = options.runtimeLog || null
  const storeId = String(options.storeId || '')
  const loadPurchaseOrders = typeof options.fetchPurchaseOrders === 'function'
    ? options.fetchPurchaseOrders
    : fetchPurchaseOrdersBySalesOrder
  const loadPurchaseAccounts = typeof options.fetchPurchaseAccounts === 'function'
    ? options.fetchPurchaseAccounts
    : fetchPurchaseAccounts
  const loadLogistics = typeof options.fetchPurchaseOrderLogistics === 'function'
    ? options.fetchPurchaseOrderLogistics
    : fetchPurchaseOrderLogistics
  const updateAftersale = typeof options.updatePurchaseAftersale === 'function'
    ? options.updatePurchaseAftersale
    : updatePurchaseOrderAftersale
  const persistReturnLogistics = typeof options.persistReturnLogistics === 'function'
    ? options.persistReturnLogistics
    : records => requestBusinessJson(
        `${BUSINESS_SERVER}/api/sales-return-logistics/${encodeURIComponent(storeId)}/batch`,
        { method: 'POST', body: { records }, timeoutMs: 15000 }
      )
  const actionNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  let refreshTimer = null
  let requestSequence = 0
  let panelMayExist = false
  let allowedPurchases = new Map()
  let syncRunning = false
  let resolvedAfterSale = { serviceId: '', orderId: '' }
  const discoveryTimers = new Set()

  const getActivePageContext = (url = webContents.getURL()) => {
    const directOrderId = getJdOrderId(url)
    if (directOrderId) {
      return { pageType: 'order', pageKey: `order:${directOrderId}`, orderId: directOrderId, serviceId: '' }
    }
    const serviceId = getJdAftersaleServiceId(url)
    if (!serviceId) return null
    const orderId = resolvedAfterSale.serviceId === serviceId ? resolvedAfterSale.orderId : ''
    return { pageType: 'aftersale', pageKey: `aftersale:${serviceId}`, orderId, serviceId }
  }

  const isSamePageContext = (orderId, pageKey) => {
    const context = getActivePageContext()
    return Boolean(context && context.pageKey === pageKey && context.orderId === orderId)
  }

  const log = message => {
    if (runtimeLog && typeof runtimeLog.writeLog === 'function') {
      runtimeLog.writeLog('ORDER_PURCHASE_PANEL', `store_id=${storeId} ${message}`)
    }
  }

  const inject = async model => {
    if (webContents.isDestroyed()) return false
    panelMayExist = true
    return webContents.executeJavaScript(buildOrderPurchasePanelScript({
      actionPrefix: LOGISTICS_ACTION_PREFIX,
      actionNonce,
      ...model
    }), true)
  }

  const injectLogistics = async model => {
    if (webContents.isDestroyed()) return false
    return webContents.executeJavaScript(buildOrderPurchaseLogisticsScript(model), true)
  }

  const injectSyncState = async model => {
    if (webContents.isDestroyed()) return false
    return webContents.executeJavaScript(buildOrderPurchaseSyncStateScript(model), true)
  }

  const remove = () => {
    if (webContents.isDestroyed() || !panelMayExist) return
    panelMayExist = false
    webContents.executeJavaScript(REMOVE_PANEL_SCRIPT, true).catch(() => {})
  }

  const refresh = async reason => {
    if (webContents.isDestroyed()) return
    const context = getActivePageContext()
    const sequence = ++requestSequence
    if (!context?.pageKey) {
      allowedPurchases = new Map()
      remove()
      return
    }
    if (!context.orderId) {
      allowedPurchases = new Map()
      remove()
      return
    }
    const { orderId, pageKey, pageType } = context

    try {
      await inject({ state: 'loading', orderId, pageKey, pageType, orders: [] })
      const orders = await loadPurchaseOrders(orderId)
      if (sequence !== requestSequence || webContents.isDestroyed()) return
      if (!isSamePageContext(orderId, pageKey)) return
      allowedPurchases = new Map(orders.map(order => [order.id, order]))
      const injection = await inject({ state: 'ready', orderId, pageKey, pageType, orders })
      const mountState = injection?.mounted === true || injection?.hostConnected === true ? 'mounted' : 'pending'
      log(`phase=render reason=${reason} page_type=${pageType} page_key=${pageKey} order_id=${orderId} result=success purchase_count=${orders.length} mount_state=${mountState}`)
    } catch (error) {
      if (sequence !== requestSequence || webContents.isDestroyed()) return
      const message = String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 180)
      if (isSamePageContext(orderId, pageKey)) {
        await inject({ state: 'error', orderId, pageKey, pageType, orders: [], message: `采购信息读取失败：${message}` }).catch(() => {})
      }
      log(`phase=render reason=${reason} page_type=${pageType} page_key=${pageKey} order_id=${orderId} result=failed error=${message}`)
    }
  }

  const syncCurrentOrders = async (orderId, pageKey) => {
    if (syncRunning || webContents.isDestroyed()) return
    const targets = [...allowedPurchases.values()]
      .filter(order => order.platform && order.platformOrderNo)
    if (!targets.length) {
      await injectSyncState({
        state: 'error', orderId, pageKey, successCount: 0, failCount: 0,
        message: '当前没有已绑定采购平台订单号的采购单'
      }).catch(() => {})
      return
    }

    syncRunning = true
    let successCount = 0
    let failCount = 0
    const failureMessages = []
    let accounts = null
    try {
      await injectSyncState({ state: 'loading', orderId, pageKey, current: 0, total: targets.length })
      const syncSingle = typeof options.syncSinglePurchaseOrder === 'function'
        ? options.syncSinglePurchaseOrder
        : payload => require('./purchase-order-sync').syncSinglePurchaseOrderBrowser(payload)

      for (let index = 0; index < targets.length; index += 1) {
        if (webContents.isDestroyed() || !isSamePageContext(orderId, pageKey)) break
        const order = targets[index]
        await injectSyncState({
          state: 'progress', orderId, pageKey, current: index, total: targets.length,
          purchaseNo: order.purchaseNo
        })

        let accountId = order.accountId
        if (!accountId) {
          if (!accounts) accounts = await loadPurchaseAccounts()
          const candidates = accounts.filter(account => {
            const platform = account.platform === 'tmall' ? 'taobao' : account.platform
            return platform === order.platform
          })
          const account = candidates.find(item => item.cookieValid && item.online) ||
            candidates.find(item => item.cookieValid) || candidates.find(item => item.online) || candidates[0]
          accountId = account?.id || 0
        }

        if (!accountId) {
          failCount += 1
          failureMessages.push(`${order.purchaseNo}：未找到对应采购账号`)
        } else {
          const result = await syncSingle({
            accountId: String(accountId),
            platformOrderNo: order.platformOrderNo,
            platform: order.platform
          })
          if (result?.success && !result?.dbError) {
            successCount += 1
          } else {
            failCount += 1
            failureMessages.push(`${order.purchaseNo}：${result?.dbError || result?.message || '同步失败'}`)
          }
        }

        await injectSyncState({
          state: 'progress', orderId, pageKey, current: index + 1, total: targets.length,
          purchaseNo: order.purchaseNo
        })
      }

      if (!webContents.isDestroyed() && isSamePageContext(orderId, pageKey)) {
        await refresh('sync-complete')
        await injectSyncState({
          state: failCount ? 'error' : 'ready',
          orderId,
          pageKey,
          successCount,
          failCount,
          message: failureMessages.join('；').slice(0, 500)
        }).catch(() => {})
      }
      log(`phase=sync order_id=${orderId} result=${failCount ? 'partial' : 'success'} success_count=${successCount} fail_count=${failCount}`)
    } catch (error) {
      failCount += 1
      const message = String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 180)
      if (!webContents.isDestroyed() && isSamePageContext(orderId, pageKey)) {
        await refresh('sync-error')
        await injectSyncState({ state: 'error', orderId, pageKey, successCount, failCount, message }).catch(() => {})
      }
      log(`phase=sync order_id=${orderId} result=failed success_count=${successCount} fail_count=${failCount} error=${message}`)
    } finally {
      syncRunning = false
    }
  }

  const handlePageAction = async payload => {
    if (payload?.action === 'capture-return-logistics') {
      let currentUrl
      try {
        currentUrl = new URL(webContents.getURL())
      } catch {
        throw new Error('退货物流页面校验失败')
      }
      if (currentUrl.protocol !== 'https:' ||
          currentUrl.hostname.toLowerCase() !== JD_ORDER_DETAILS_HOST ||
          !currentUrl.pathname.startsWith(JD_AFTERSALE_LIST_PATH)) {
        throw new Error('当前页面不允许保存退货物流')
      }
      const records = normalizeReturnLogisticsRecords(payload?.records)
      if (records.length === 0) {
        return { action: 'capture-return-logistics', saved: 0 }
      }
      const response = await persistReturnLogistics(records)
      if (!response || Number(response.code) !== 0) {
        throw new Error(response?.message || '保存退货物流失败')
      }
      const saved = Math.max(0, Number(response?.data?.saved) || 0)
      log(`phase=capture-return-logistics result=success received_count=${records.length} saved_count=${saved}`)
      return { action: 'capture-return-logistics', saved }
    }

    if (payload?.action === 'resolve-aftersale-order') {
      const serviceId = getJdAftersaleServiceId(webContents.getURL())
      const payloadServiceId = String(payload?.afsServiceId || '').trim()
      const resolvedOrderId = String(payload?.orderId || '').trim()
      if (!serviceId || serviceId !== payloadServiceId || !/^\d{10,30}$/.test(resolvedOrderId) || resolvedOrderId === serviceId) {
        log(`phase=resolve-aftersale result=rejected service_id=${serviceId || '-'} order_id=${resolvedOrderId || '-'}`)
        throw new Error('售后关联订单校验失败')
      }
      const changed = resolvedAfterSale.serviceId !== serviceId || resolvedAfterSale.orderId !== resolvedOrderId
      resolvedAfterSale = { serviceId, orderId: resolvedOrderId }
      log(`phase=resolve-aftersale result=success service_id=${serviceId} order_id=${resolvedOrderId} evidence=${String(payload?.evidence || 'network').slice(0, 80)}`)
      if (changed) scheduleRefresh('aftersale-order-resolved', 0)
      return { action: 'resolve-aftersale-order', orderId: resolvedOrderId }
    }

    const context = getActivePageContext()
    const orderId = context?.orderId || ''
    const pageKey = context?.pageKey || ''
    if (!orderId || !pageKey) throw new Error('当前页面采购信息尚未就绪')
    if (payload?.nonce !== actionNonce || String(payload?.orderId || '') !== orderId || String(payload?.pageKey || `order:${payload?.orderId || ''}`) !== pageKey) {
      log(`phase=action result=rejected reason=invalid_context page_key=${pageKey} order_id=${orderId}`)
      throw new Error('页面操作校验失败，请刷新页面后重试')
    }
    if (payload?.action === 'sync-orders') {
      await syncCurrentOrders(orderId, pageKey)
      return { action: 'sync-orders' }
    }
    if (payload?.action === 'mark-aftersale') {
      const purchaseId = Number(payload?.purchaseId)
      const purchase = allowedPurchases.get(purchaseId)
      if (!purchase || purchase.status === 'cancelled') {
        log(`phase=aftersale result=rejected reason=invalid_purchase order_id=${orderId} purchase_id=${purchaseId || 0}`)
        throw new Error('该采购单不可标记售后')
      }
      const aftersaleStatus = String(payload?.aftersaleStatus || '').trim()
      if (!Object.prototype.hasOwnProperty.call(PURCHASE_AFTERSALE_STATUS_LABELS, aftersaleStatus)) {
        throw new Error('请选择有效的售后状态')
      }
      const aftersaleRemark = String(payload?.aftersaleRemark || '').trim()
      if (aftersaleRemark.length > 2000) throw new Error('售后处理日志不能超过2000字')
      await updateAftersale(purchaseId, { aftersaleStatus, aftersaleRemark })
      log(`phase=aftersale order_id=${orderId} purchase_id=${purchaseId} status=${aftersaleStatus} result=success`)
      if (!webContents.isDestroyed() && isSamePageContext(orderId, pageKey)) {
        await refresh('aftersale-marked')
      }
      return { action: 'mark-aftersale', purchaseId, aftersaleStatus }
    }
    if (payload?.action !== 'view-logistics') throw new Error('不支持的采购信息操作')

    const purchaseId = Number(payload?.purchaseId)
    const purchase = allowedPurchases.get(purchaseId)
    if (!purchase?.logisticsNo) {
      log(`phase=action result=rejected reason=invalid_purchase order_id=${orderId} purchase_id=${purchaseId || 0}`)
      throw new Error('该采购单暂无可查询的物流单号')
    }

    log(`phase=logistics order_id=${orderId} purchase_id=${purchaseId} result=requested`)
    try {
      const data = await loadLogistics(purchaseId)
      if (webContents.isDestroyed() || !isSamePageContext(orderId, pageKey)) {
        throw new Error('订单详情页已关闭或切换')
      }
      const injected = await injectLogistics({ state: 'ready', orderId, pageKey, purchaseId, data })
      if (injected !== true) throw new Error('物流结果回填失败，请重试')
      log(`phase=logistics order_id=${orderId} purchase_id=${purchaseId} result=success track_count=${data.tracks.length}`)
      return { action: 'view-logistics', purchaseId, trackCount: data.tracks.length }
    } catch (error) {
      const message = String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 180)
      if (!webContents.isDestroyed() && isSamePageContext(orderId, pageKey)) {
        await injectLogistics({ state: 'error', orderId, pageKey, purchaseId, message }).catch(() => {})
      }
      log(`phase=logistics order_id=${orderId} purchase_id=${purchaseId} result=failed error=${message}`)
      throw error
    }
  }

  if (Number.isSafeInteger(Number(webContents.id)) && Number(webContents.id) > 0) {
    panelActionHandlers.set(Number(webContents.id), handlePageAction)
  }

  const onConsoleMessage = (_event, levelOrDetails, ...legacyArgs) => {
    const message = String(
      levelOrDetails && typeof levelOrDetails === 'object'
        ? levelOrDetails.message || ''
        : legacyArgs[0] || ''
    )
    if (!message.startsWith(LOGISTICS_ACTION_PREFIX)) return
    let payload
    try {
      payload = JSON.parse(message.slice(LOGISTICS_ACTION_PREFIX.length))
    } catch {
      return
    }
    handlePageAction(payload).catch(() => {})
  }

  webContents.on('console-message', onConsoleMessage)

  const scheduleRefresh = (reason, delay = 250) => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      refresh(reason).catch(() => {})
    }, delay)
  }

  const discoverAfterSaleOrder = async reason => {
    if (webContents.isDestroyed()) return
    const serviceId = getJdAftersaleServiceId(webContents.getURL())
    if (!serviceId || (resolvedAfterSale.serviceId === serviceId && resolvedAfterSale.orderId)) return
    try {
      const result = await webContents.executeJavaScript(buildAfterSaleOrderDiscoveryScript(serviceId), true)
      const orderId = String(result?.orderId || '').trim()
      if (!/^\d{10,30}$/.test(orderId)) return
      await handlePageAction({
        action: 'resolve-aftersale-order',
        afsServiceId: serviceId,
        orderId,
        evidence: result?.evidence || `fallback:${reason}`
      })
    } catch (error) {
      log(`phase=resolve-aftersale result=retry reason=${reason} error=${String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 120)}`)
    }
  }

  const scheduleAfterSaleDiscovery = reason => {
    for (const delay of [500, 1500, 4000, 8000]) {
      const timer = setTimeout(() => {
        discoveryTimers.delete(timer)
        discoverAfterSaleOrder(reason).catch(() => {})
      }, delay)
      discoveryTimers.add(timer)
    }
  }

  webContents.on('dom-ready', () => {
    scheduleRefresh('dom-ready', 0)
    scheduleAfterSaleDiscovery('dom-ready')
  })
  webContents.on('did-finish-load', () => {
    scheduleRefresh('did-finish-load')
    scheduleAfterSaleDiscovery('did-finish-load')
  })
  webContents.on('did-navigate', (_event, url) => {
    requestSequence += 1
    const serviceId = getJdAftersaleServiceId(url)
    if (serviceId && serviceId !== resolvedAfterSale.serviceId) resolvedAfterSale = { serviceId: '', orderId: '' }
    if (getPurchasePanelPageKey(url)) {
      scheduleRefresh('did-navigate')
      if (serviceId) scheduleAfterSaleDiscovery('did-navigate')
    } else remove()
  })
  webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame === false) return
    requestSequence += 1
    const serviceId = getJdAftersaleServiceId(url)
    if (serviceId && serviceId !== resolvedAfterSale.serviceId) resolvedAfterSale = { serviceId: '', orderId: '' }
    if (getPurchasePanelPageKey(url)) {
      scheduleRefresh('did-navigate-in-page')
      if (serviceId) scheduleAfterSaleDiscovery('did-navigate-in-page')
    } else remove()
  })
  webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return
    requestSequence += 1
    const serviceId = getJdAftersaleServiceId(url)
    if (serviceId && serviceId !== resolvedAfterSale.serviceId) resolvedAfterSale = { serviceId: '', orderId: '' }
    if (!getPurchasePanelPageKey(url)) remove()
  })
  scheduleRefresh('attached', 0)
  scheduleAfterSaleDiscovery('attached')

  webContents.once('destroyed', () => {
    requestSequence += 1
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = null
    allowedPurchases = new Map()
    syncRunning = false
    resolvedAfterSale = { serviceId: '', orderId: '' }
    for (const timer of discoveryTimers) clearTimeout(timer)
    discoveryTimers.clear()
    if (Number.isSafeInteger(Number(webContents.id))) panelActionHandlers.delete(Number(webContents.id))
    try { webContents.removeListener('console-message', onConsoleMessage) } catch (_) {}
  })
}

module.exports = {
  BUSINESS_SERVER,
  ORDER_PURCHASE_ACTION_CHANNEL,
  ORDER_PURCHASE_RUNTIME_SOURCE_FILE,
  JD_ORDER_DETAILS_HOST,
  JD_ORDER_DETAILS_PATH,
  JD_AFTERSALE_DETAILS_PATH,
  JD_AFTERSALE_LIST_PATH,
  PURCHASE_TYPE_LABELS,
  PURCHASE_STATUS_LABELS,
  PURCHASE_AFTERSALE_STATUS_LABELS,
  getJdOrderId,
  getJdAftersaleServiceId,
  getPurchasePanelPageKey,
  normalizePurchaseOrder,
  normalizeReturnLogisticsRecords,
  normalizeLogisticsTracking,
  fetchPurchaseOrdersBySalesOrder,
  fetchPurchaseAccounts,
  fetchPurchaseOrderLogistics,
  updatePurchaseOrderAftersale,
  renderOrderPurchasePanel,
  renderOrderPurchaseLogisticsResult,
  renderOrderPurchaseSyncState,
  discoverAfterSaleSalesOrder,
  getOrderPurchaseRuntimeFunctionSource,
  resetOrderPurchaseRuntimeSourceCache,
  buildOrderPurchasePanelScript,
  buildOrderPurchaseLogisticsScript,
  buildOrderPurchaseSyncStateScript,
  buildAfterSaleOrderDiscoveryScript,
  registerOrderPurchasePanelIpc,
  attachOrderPurchasePanel
}
