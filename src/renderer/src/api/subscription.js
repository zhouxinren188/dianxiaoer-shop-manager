/**
 * 订阅系统 API 模块
 * 通过 proxy-fetch IPC 调用 3001 端口的订阅接口
 */

const API_BASE = 'http://150.158.54.108:3001'

/**
 * 通过主进程代理发起 HTTP 请求（绕过 Electron file:// 的 CORS 限制）
 */
async function proxyFetch(url, options = {}) {
  const { method = 'GET', body, headers } = options
  const token = localStorage.getItem('accessToken')

  const reqHeaders = { 'Content-Type': 'application/json' }
  if (token) reqHeaders['Authorization'] = `Bearer ${token}`
  if (headers) Object.assign(reqHeaders, headers)

  const proxyResult = await window.electronAPI.invoke('proxy-fetch', {
    url: `${API_BASE}${url}`,
    method,
    headers: reqHeaders,
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
  })

  if (!proxyResult) throw new Error('请求失败：无响应')

  let json
  try {
    json = JSON.parse(proxyResult.data)
  } catch {
    if (proxyResult.status >= 400) {
      throw new Error(`服务器返回异常 (HTTP ${proxyResult.status})`)
    }
    throw new Error('服务器返回格式错误')
  }

  return json
}

/**
 * 查询订阅状态
 * @returns {Promise<Object>} { success, status, tier, days_remaining, trial_end, subscription_end, pricing, ... }
 */
export async function checkStatus() {
  return proxyFetch('/api/subscription/status', { method: 'GET' })
}

/**
 * 创建支付订单
 * @param {string} tier - basic | standard | premium
 * @param {string} plan - monthly | quarterly | yearly
 * @returns {Promise<Object>} { success, order_no, code_url, amount, ... }
 */
export async function createOrder(tier, plan) {
  return proxyFetch('/api/subscription/create-order', {
    method: 'POST',
    body: { tier, plan }
  })
}

/**
 * 查询订单状态（轮询用）
 * @param {string} orderNo - 订单号
 * @returns {Promise<Object>} { success, status, paid_at }
 */
export async function queryOrder(orderNo) {
  return proxyFetch(`/api/subscription/query-order?order_no=${orderNo}`, { method: 'GET' })
}

/**
 * 按店铺创建订阅订单
 * @param {number[]} storeIds - 选中的店铺ID列表
 * @param {string} plan - monthly | quarterly | half_yearly
 * @returns {Promise<Object>} { success, order_no, code_url, amount, ... }
 */
export async function createStoreOrder(storeIds, plan) {
  return proxyFetch('/api/subscription/create-store-order', {
    method: 'POST',
    body: { store_ids: storeIds, plan }
  })
}

/**
 * 生成二维码图片 data URL
 * @param {string} text - 二维码内容（微信支付 code_url）
 * @returns {Promise<string>} data URL
 */
export async function generateQRCode(text) {
  return window.electronAPI.invoke('generate-qrcode', text)
}
