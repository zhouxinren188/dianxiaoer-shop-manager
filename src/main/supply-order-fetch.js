const { BrowserWindow, ipcMain, session } = require('electron')

const TARGET_URL = 'https://shop.jd.com/jdm/gongxiao/shopEmbed/vender/purchaseManage'
const OVERALL_TIMEOUT = 60000 // 整体超时 60 秒
const PAGE_LOAD_TIMEOUT = 30000 // 页面加载超时 30 秒

// 活跃请求追踪 Map<storeId, BrowserWindow>
const activeFetches = new Map()

/**
 * 判断 URL 是否为目标订单 API
 */
function isOrderApiUrl(url) {
  const lower = url.toLowerCase()
  // 排除静态资源
  if (/\.(js|css|png|jpg|gif|svg|woff|ttf|ico)(\?|$)/.test(lower)) return false
  // 匹配供销相关 API
  if (lower.includes('/gongxiao/') && (lower.includes('purchase') || lower.includes('order'))) return true
  if (lower.includes('purchaselist') || lower.includes('purchaseorder')) return true
  if (lower.includes('queryorder') || lower.includes('orderlist')) return true
  return false
}

/**
 * 检测是否跳转到登录页
 */
function isLoginPage(url) {
  const lower = url.toLowerCase()
  return lower.includes('passport.jd.com') || lower.includes('login.jd.com') ||
    (lower.includes('login') && lower.includes('jd.com'))
}

/**
 * 在响应 JSON 中查找订单列表数组
 */
function extractOrderList(data) {
  if (!data || typeof data !== 'object') return null

  // 直接是数组
  if (Array.isArray(data) && data.length > 0) return data

  // 遍历常见的数据包装结构
  const listKeys = ['list', 'result', 'data', 'orderList', 'purchaseList', 'records', 'items', 'rows']
  for (const key of listKeys) {
    if (Array.isArray(data[key]) && data[key].length > 0) return data[key]
  }

  // 递归一层查找
  for (const val of Object.values(data)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const key of listKeys) {
        if (Array.isArray(val[key]) && val[key].length > 0) return val[key]
      }
    }
  }

  return null
}

/**
 * 提取总数
 */
function extractTotal(data) {
  if (!data || typeof data !== 'object') return 0
  const totalKeys = ['total', 'totalCount', 'totalNum', 'count', 'totalElements']
  for (const key of totalKeys) {
    if (typeof data[key] === 'number') return data[key]
  }
  for (const val of Object.values(data)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const key of totalKeys) {
        if (typeof val[key] === 'number') return val[key]
      }
    }
  }
  return 0
}

/**
 * 规范化单条订单数据
 */
function normalizeOrderItem(item) {
  return {
    orderId: item.orderId || item.purchaseOrderId || item.orderNo || item.poId || item.id || '',
    orderStatus: item.status || item.orderStatus || item.statusCode || item.state || '',
    statusText: item.statusName || item.statusText || item.statusDesc || item.stateName || '',
    supplierName: item.supplierName || item.vendorName || item.providerName || item.supplier || '',
    productName: item.goodsName || item.skuName || item.productName || item.itemName || item.title || '',
    skuId: item.skuId || item.skuNo || item.sku || '',
    quantity: Number(item.quantity || item.num || item.count || item.buyNum || 0),
    unitPrice: Number(item.unitPrice || item.price || item.salePrice || 0),
    totalAmount: Number(item.totalAmount || item.amount || item.totalPrice || item.orderAmount || 0),
    orderDate: item.orderDate || item.createTime || item.createdAt || item.orderTime || '',
    expectedDelivery: item.expectedDelivery || item.deliveryDate || item.expectDate || '',
    trackingNo: item.trackingNo || item.expressNo || item.logisticsNo || item.waybillNo || '',
    remark: item.remark || item.memo || item.note || ''
  }
}

/**
 * 核心：通过隐藏窗口 + CDP 获取供销订单
 */
function fetchSupplyOrders(storeId) {
  return new Promise(async (resolve, reject) => {
    // 并发保护
    if (activeFetches.has(storeId)) {
      return resolve({ success: false, message: '该店铺正在获取数据，请等待完成' })
    }

    // 检查 session 是否有 cookies
    const partitionName = `persist:platform-${storeId}`
    const ses = session.fromPartition(partitionName)
    const cookies = await ses.cookies.get({})

    if (!cookies || cookies.length === 0) {
      return resolve({ success: false, message: '店铺未登录，请先在店铺管理中登录京东后台' })
    }

    let win = null
    let overallTimer = null
    let resolved = false
    // 记录匹配到的 requestId -> URL
    const matchedRequests = new Map()
    // 收集到的 API 响应数据
    const collectedResponses = []

    function cleanup() {
      if (overallTimer) { clearTimeout(overallTimer); overallTimer = null }
      activeFetches.delete(storeId)
      if (win && !win.isDestroyed()) {
        try { win.webContents.debugger.detach() } catch {}
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

    // 整体超时
    overallTimer = setTimeout(() => {
      if (collectedResponses.length > 0) {
        // 已有数据，返回已收集的
        finishWithCollectedData()
      } else {
        finish({ success: false, message: '获取订单超时，请检查网络连接或重新登录店铺' })
      }
    }, OVERALL_TIMEOUT)

    function finishWithCollectedData() {
      // 从所有收集到的响应中选择最有效的一个（包含最多数据的）
      let bestList = null
      let bestTotal = 0
      let bestRaw = null

      for (const resp of collectedResponses) {
        const list = extractOrderList(resp)
        if (list && (!bestList || list.length > bestList.length)) {
          bestList = list
          bestTotal = extractTotal(resp) || list.length
          bestRaw = resp
        }
      }

      if (bestList) {
        const normalizedList = bestList.map(normalizeOrderItem)
        finish({
          success: true,
          data: { list: normalizedList, total: bestTotal, raw: bestRaw }
        })
      } else {
        finish({ success: false, message: '未能从页面中解析到订单数据，请确认店铺已开通供销功能' })
      }
    }

    try {
      // 创建隐藏窗口
      win = new BrowserWindow({
        show: false,
        width: 1200,
        height: 800,
        webPreferences: {
          partition: partitionName,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })

      activeFetches.set(storeId, win)

      // 登录检测
      win.webContents.on('did-navigate', (event, url) => {
        if (isLoginPage(url)) {
          finish({ success: false, message: '店铺登录已过期，请在店铺管理中重新登录京东后台' })
        }
      })
      win.webContents.on('did-redirect-navigation', (event, url) => {
        if (isLoginPage(url)) {
          finish({ success: false, message: '店铺登录已过期，请在店铺管理中重新登录京东后台' })
        }
      })

      // 附加 CDP debugger
      win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Network.enable')

      // 监听网络事件
      win.webContents.debugger.on('message', (event, method, params) => {
        if (resolved) return

        if (method === 'Network.responseReceived') {
          const { requestId, response } = params
          const url = response.url || ''
          const mimeType = response.mimeType || ''

          // 开发模式记录所有 API 请求
          if (mimeType.includes('json') || url.includes('/api/') || url.includes('/gongxiao/')) {
            console.log('[SupplyFetch] API:', response.status, url.substring(0, 200))
          }

          // 匹配目标 API
          if ((mimeType.includes('json') || mimeType.includes('text')) && isOrderApiUrl(url)) {
            matchedRequests.set(requestId, url)
            console.log('[SupplyFetch] Matched order API:', url)
          }
        }

        if (method === 'Network.loadingFinished') {
          const { requestId } = params
          if (matchedRequests.has(requestId)) {
            // 获取响应体
            win.webContents.debugger.sendCommand('Network.getResponseBody', { requestId })
              .then(({ body, base64Encoded }) => {
                try {
                  const text = base64Encoded ? Buffer.from(body, 'base64').toString() : body
                  const json = JSON.parse(text)
                  collectedResponses.push(json)
                  console.log('[SupplyFetch] Got response body for:', matchedRequests.get(requestId))

                  // 检查是否已获取到有效数据
                  const list = extractOrderList(json)
                  if (list && list.length > 0) {
                    // 等待短暂时间看是否有更多数据到来
                    setTimeout(() => {
                      if (!resolved) finishWithCollectedData()
                    }, 2000)
                  }
                } catch (e) {
                  console.log('[SupplyFetch] Parse response failed:', e.message)
                }
              })
              .catch(err => {
                console.log('[SupplyFetch] getResponseBody failed:', err.message)
              })
            matchedRequests.delete(requestId)
          }
        }
      })

      // 导航到目标页面
      win.loadURL(TARGET_URL)

      // 页面加载超时后如果没有匹配到任何 API，等待额外时间（SPA 可能异步加载）
      setTimeout(() => {
        if (!resolved && collectedResponses.length === 0 && matchedRequests.size === 0) {
          console.log('[SupplyFetch] No order API detected after page load, waiting...')
        }
      }, PAGE_LOAD_TIMEOUT)

    } catch (err) {
      finish({ success: false, message: '获取订单失败: ' + err.message })
    }
  })
}

function registerSupplyOrderIpc() {
  ipcMain.handle('fetch-supply-orders', async (event, { storeId }) => {
    if (!storeId) {
      return { success: false, message: '请选择店铺' }
    }
    console.log('[SupplyFetch] 开始获取供销订单, storeId:', storeId)
    const result = await fetchSupplyOrders(storeId)
    console.log('[SupplyFetch] 获取结果:', result.success, result.success ? `${result.data.list.length}条` : result.message)
    return result
  })
}

module.exports = { registerSupplyOrderIpc }
