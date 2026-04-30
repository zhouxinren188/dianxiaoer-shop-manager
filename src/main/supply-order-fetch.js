const { BrowserWindow, ipcMain, session, app } = require('electron')
const path = require('path')
const fs = require('fs')

const DEBUG_LOG_PATH = path.join(
  app.isPackaged ? path.dirname(process.execPath) : process.cwd(),
  'supply-debug.json'
)

function saveDebugLog(data) {
  try {
    fs.writeFileSync(DEBUG_LOG_PATH, JSON.stringify(data, null, 2), 'utf-8')
    console.log('[SupplyFetch] debug log saved:', DEBUG_LOG_PATH)
  } catch (e) {
    console.log('[SupplyFetch] save debug log failed:', e.message)
  }
}

const ENTRY_URL = 'https://shop.jd.com/'
const TARGET_URL = 'https://shop.jd.com/jdm/gongxiao/shopEmbed/vender/purchaseManage'
const OVERALL_TIMEOUT = 120000

const activeFetches = new Map()

function isLoginPage(url) {
  const lower = url.toLowerCase()
  return lower.includes('passport.jd.com') || lower.includes('login.jd.com') ||
    (lower.includes('login') && lower.includes('jd.com'))
}

/**
 * API 拦截器 —— 在 dom-ready 时注入
 * 覆盖 fetch / XMLHttpRequest，捕获 SPA 发出的所有 API 请求和响应
 * 只做数据捕获（读取），不修改任何请求/响应，不触发风控
 */
const API_INTERCEPTOR = `
(function() {
  if (window.__apiInterceptorInstalled) return;
  window.__apiInterceptorInstalled = true;
  window.__capturedResponses = [];

  // 拦截 fetch
  var origFetch = window.fetch;
  window.fetch = function() {
    var url = arguments[0];
    var urlStr = typeof url === 'string' ? url : (url && url.url ? url.url : '');
    return origFetch.apply(this, arguments).then(function(response) {
      try {
        var cloned = response.clone();
        cloned.text().then(function(body) {
          if (body.length > 50) {
            window.__capturedResponses.push({
              type: 'fetch',
              url: urlStr.substring(0, 1000),
              status: response.status,
              bodyLen: body.length,
              body: body.substring(0, 500000),
              time: Date.now()
            });
          }
        }).catch(function(){});
      } catch(e) {}
      return response;
    });
  };

  // 拦截 XMLHttpRequest
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__captureUrl = (url || '').toString().substring(0, 1000);
    this.__captureMethod = method;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    var xhr = this;
    xhr.__captureReqBody = body ? String(body).substring(0, 5000) : '';
    xhr.addEventListener('load', function() {
      try {
        var body = xhr.responseText || '';
        if (body.length > 50) {
          window.__capturedResponses.push({
            type: 'xhr',
            method: xhr.__captureMethod,
            url: xhr.__captureUrl,
            status: xhr.status,
            bodyLen: body.length,
            body: body.substring(0, 500000),
            reqBody: xhr.__captureReqBody,
            time: Date.now()
          });
        }
      } catch(e) {}
    });
    return origSend.apply(this, arguments);
  };
})()
`

/**
 * 读取已捕获的 API 响应（读取后清空，避免重复）
 */
const READ_CAPTURED = `
(function() {
  var data = window.__capturedResponses || [];
  window.__capturedResponses = [];
  return {
    count: data.length,
    responses: data.map(function(r) {
      return {
        type: r.type,
        method: r.method || 'GET',
        url: r.url,
        status: r.status,
        bodyLen: r.bodyLen,
        body: r.body,
        reqBody: r.reqBody || '',
        time: r.time
      };
    })
  };
})()
`

/**
 * 页面可见性覆盖
 */
const VISIBILITY_OVERRIDE = `
try {
  Object.defineProperty(document, 'hidden', { get: function() { return false; }, configurable: true });
  Object.defineProperty(document, 'visibilityState', { get: function() { return 'visible'; }, configurable: true });
  document.hasFocus = function() { return true; };
  document.dispatchEvent(new Event('visibilitychange'));
} catch(e) {}
`

function fetchSupplyOrders(storeId) {
  return new Promise(async (resolve) => {
    if (activeFetches.has(storeId)) {
      return resolve({ success: false, message: '该店铺正在获取数据，请等待完成' })
    }

    const partitionName = `persist:platform-${storeId}`
    const ses = session.fromPartition(partitionName)
    const cookies = await ses.cookies.get({})
    const jdCookies = cookies.filter(c => c.domain && c.domain.includes('jd.com'))

    console.log('[SupplyFetch] storeId:', storeId, 'partition:', partitionName)
    console.log('[SupplyFetch] Cookies:', cookies.length, 'JD:', jdCookies.length)

    if (jdCookies.length === 0) {
      return resolve({ success: false, message: '店铺没有京东Cookie，请先在「店铺管理」中登录京东后台' })
    }

    let win = null
    let overallTimer = null
    let resolved = false
    let allCapturedResponses = []

    function cleanup() {
      if (overallTimer) { clearTimeout(overallTimer); overallTimer = null }
      activeFetches.delete(storeId)
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
      // 超时时保存所有捕获的 API 数据，方便分析
      saveDebugLog({
        timestamp: new Date().toISOString(),
        storeId,
        phase: 'timeout',
        capturedCount: allCapturedResponses.length,
        capturedAPIs: allCapturedResponses.map(r => ({
          type: r.type,
          method: r.method,
          url: r.url,
          status: r.status,
          bodyLen: r.bodyLen,
          bodyPreview: (r.body || '').substring(0, 500)
        }))
      })
      finish({ success: false, message: '获取订单超时' })
    }, OVERALL_TIMEOUT)

    try {
      win = new BrowserWindow({
        show: true,
        width: 1200,
        height: 800,
        title: '[调试] 供销订单获取',
        webPreferences: {
          partition: partitionName,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false
        }
      })

      win.webContents.setBackgroundThrottling(false)
      activeFetches.set(storeId, win)

      // 在每次 DOM 就绪时注入 API 拦截器 + 可见性覆盖
      win.webContents.on('dom-ready', () => {
        if (win.isDestroyed() || resolved) return
        win.webContents.executeJavaScript(API_INTERCEPTOR).catch(() => {})
        win.webContents.executeJavaScript(VISIBILITY_OVERRIDE).catch(() => {})
        console.log('[SupplyFetch] API interceptor + visibility override injected')
      })

      win.webContents.on('did-navigate', (event, url) => {
        console.log('[SupplyFetch] navigate:', url.substring(0, 150))
        if (isLoginPage(url)) {
          finish({ success: false, message: '店铺登录已过期，请重新登录京东后台' })
        }
      })

      let entryLoaded = false
      let targetLoaded = false

      win.webContents.on('did-finish-load', () => {
        if (win.isDestroyed() || resolved) return
        const currentUrl = win.webContents.getURL()
        console.log('[SupplyFetch] loaded:', currentUrl.substring(0, 150))

        if (!entryLoaded && !isLoginPage(currentUrl)) {
          entryLoaded = true
          console.log('[SupplyFetch] Entry OK, jump to target in 3s...')
          setTimeout(() => {
            if (win.isDestroyed() || resolved) return
            win.loadURL(TARGET_URL)
          }, 3000)
          return
        }

        if (entryLoaded && !targetLoaded && currentUrl.includes('gongxiao')) {
          targetLoaded = true
          console.log('[SupplyFetch] Target page loaded, start polling for API data...')
          win.show()
          win.moveTop()
          win.focus()
          win.webContents.focus()
          pollForAPIData()
          return
        }
      })

      // 轮询读取被拦截的 API 响应数据
      // 策略：先等 SPA 发出 api_order_list 请求（捕获请求格式），
      // 然后主动发起自己的 API 调用获取全部状态的订单
      function pollForAPIData() {
        let pollCount = 0
        const maxPolls = 30 // 60 秒
        const pollInterval = 2000
        let activeCallMade = false // 是否已主动发起过 API 调用

        function poll() {
          if (win.isDestroyed() || resolved) return
          pollCount++

          win.webContents.executeJavaScript(READ_CAPTURED)
            .then(captured => {
              if (captured.count > 0) {
                allCapturedResponses.push(...captured.responses)
                console.log(`[SupplyFetch] poll #${pollCount}: +${captured.count} APIs (total: ${allCapturedResponses.length})`)

                for (const r of captured.responses) {
                  console.log(`  [${r.type}] ${r.method} ${r.url.substring(0, 120)} (${r.bodyLen}B)`)
                }
              } else {
                console.log(`[SupplyFetch] poll #${pollCount}: no new APIs (total: ${allCapturedResponses.length})`)
              }

              // 检查是否已捕获到 SPA 的 api_order_list 请求（获取请求格式）
              const spaOrderCall = allCapturedResponses.find(r => r.url.includes('api_order_list'))

              // 如果 SPA 已发出过请求但我们还没主动调用，现在主动调用获取全部订单
              if (spaOrderCall && !activeCallMade) {
                activeCallMade = true
                console.log('[SupplyFetch] SPA order API detected, making active call for ALL orders...')
                console.log('[SupplyFetch] SPA reqBody:', spaOrderCall.reqBody)
                makeActiveOrderCall()
                // 继续轮询等待主动调用的结果
                if (pollCount < maxPolls) {
                  setTimeout(poll, pollInterval)
                }
                return
              }

              // 尝试从捕获的数据中找到有效订单数据（优先找主动调用的结果）
              const orderData = findOrderData(allCapturedResponses)
              if (orderData) {
                console.log(`[SupplyFetch] Order data found! ${orderData.orders.length} orders`)
                saveDebugLog({
                  timestamp: new Date().toISOString(),
                  storeId,
                  phase: 'success',
                  ordersCount: orderData.orders.length,
                  totalCount: orderData.total,
                  apiUrl: orderData.apiUrl,
                  sampleOrders: orderData.orders.slice(0, 3),
                  allCapturedAPIs: allCapturedResponses.map(r => ({
                    type: r.type, method: r.method, url: r.url,
                    status: r.status, bodyLen: r.bodyLen, reqBody: r.reqBody
                  }))
                })
                finish({
                  success: true,
                  data: {
                    list: orderData.orders,
                    total: orderData.total,
                    pageTotal: orderData.orders.length,
                    sourceUrl: orderData.apiUrl,
                    matchedApis: ['API interception']
                  }
                })
                return
              }

              if (pollCount < maxPolls) {
                setTimeout(poll, pollInterval)
              } else {
                // 轮询超时，保存所有捕获的 API 数据用于分析
                console.log(`[SupplyFetch] Poll timeout. Total APIs captured: ${allCapturedResponses.length}`)
                saveDebugLog({
                  timestamp: new Date().toISOString(),
                  storeId,
                  phase: 'poll-timeout',
                  pollCount,
                  capturedCount: allCapturedResponses.length,
                  capturedAPIs: allCapturedResponses.map(r => ({
                    type: r.type,
                    method: r.method,
                    url: r.url,
                    status: r.status,
                    bodyLen: r.bodyLen,
                    reqBody: r.reqBody,
                    bodyPreview: (r.body || '').substring(0, 1000)
                  }))
                })
                finish({
                  success: false,
                  message: '未能自动获取订单数据，请查看调试日志'
                })
              }
            })
            .catch(err => {
              console.log(`[SupplyFetch] poll error:`, err.message)
              if (pollCount < maxPolls) {
                setTimeout(poll, pollInterval)
              } else {
                finish({ success: false, message: '轮询失败: ' + err.message })
              }
            })
        }

        // 主动发起 API 调用，获取全部状态的订单
        // 从 SPA 的原始请求中提取安全 token，用正确的格式发起请求
        function makeActiveOrderCall() {
          // 从已捕获的请求中提取 x-api-eid-token 和 ext
          const spaCall = allCapturedResponses.find(r => r.url.includes('api_order_list') && r.reqBody)
          let eidToken = ''
          let ext = ''
          if (spaCall && spaCall.reqBody) {
            const eidMatch = spaCall.reqBody.match(/x-api-eid-token=([^&]+)/)
            const extMatch = spaCall.reqBody.match(/ext=([^&]+)/)
            if (eidMatch) eidToken = eidMatch[1]
            if (extMatch) ext = extMatch[1]
          }
          console.log('[SupplyFetch] Extracted eidToken:', eidToken ? 'yes' : 'no', 'ext:', ext ? 'yes' : 'no')

          // 用 SPA 页面内的 JS 上下文来发请求（能自动带 cookie）
          // 使用 SPA 完全相同的参数结构，修改 states 为空数组获取全部订单
          // 排序改为 DESC（最新下单在前），与 JD 原始页面"全部"标签一致
          const script = `
            (function() {
              try {
                var bodyObj = {
                  states: [],
                  warnExceptionCodes: [],
                  sortDtoList: [{"sortFieldType": "2", "sortType": "DESC"}],
                  page: { current: 1, pageSize: 100 },
                  clientType: 1
                };
                var params = 'body=' + encodeURIComponent(JSON.stringify(bodyObj));
                ${eidToken ? `params += '&x-api-eid-token=${eidToken}';` : ''}
                ${ext ? `params += '&ext=${ext}';` : ''}

                var xhr = new XMLHttpRequest();
                var url = 'https://api.m.jd.com/api?functionId=api_order_list&scval=all&loginType=3&appid=gx-pc&client=pc&t=' + Date.now();
                xhr.open('POST', url, true);
                xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
                xhr.withCredentials = true;
                xhr.send(params);
                return 'active-call-sent';
              } catch(e) {
                return 'active-call-error: ' + e.message;
              }
            })()
          `
          win.webContents.executeJavaScript(script)
            .then(r => console.log('[SupplyFetch] Active API call result:', r))
            .catch(e => console.log('[SupplyFetch] Active API call failed:', e.message))
        }

        setTimeout(poll, 3000)
      }

      /**
       * 从捕获的 API 响应中查找 api_order_list 接口的响应
       * JD 供销订单 API：https://api.m.jd.com/api?functionId=api_order_list
       */
      function findOrderData(responses) {
        // 优先查找 api_order_list 接口（最大的那个响应）
        let bestMatch = null
        for (const r of responses) {
          if (r.status !== 200) continue
          if (!r.url.includes('api_order_list')) continue
          if (!bestMatch || r.bodyLen > bestMatch.bodyLen) {
            bestMatch = r
          }
        }

        if (bestMatch) {
          try {
            const json = JSON.parse(bestMatch.body)
            // 兼容两种响应格式：
            // 旧格式: { data: [订单数组], totalCount: N }
            // 新格式: { data: { rows: [订单数组], page: { total: N } } }
            let list = null
            let total = 0
            if (json && json.data) {
              if (Array.isArray(json.data) && json.data.length > 0) {
                list = json.data
                total = json.totalCount || json.total || list.length
              } else if (json.data.rows && Array.isArray(json.data.rows) && json.data.rows.length > 0) {
                list = json.data.rows
                total = (json.data.page && json.data.page.total) || json.totalCount || list.length
              }
            }
            if (list) {
              const orders = list.map(normalizeOrder)
              return { orders, total, apiUrl: bestMatch.url }
            }
          } catch (e) {
            console.log('[SupplyFetch] Parse api_order_list failed:', e.message)
          }
        }

        // 备用：扫描所有响应，找包含 jdOrderId 的数组
        for (const r of responses) {
          if (r.status !== 200 || r.bodyLen < 1000) continue
          if (r.url.includes('.css') || r.url.includes('.js') || r.url.includes('.png')) continue
          try {
            const body = r.body
            if (!body || (body.charAt(0) !== '{' && body.charAt(0) !== '[')) continue
            const json = JSON.parse(body)
            const list = findArrayWithField(json, 'jdOrderId')
            if (list && list.length > 0) {
              const orders = list.map(normalizeOrder)
              return { orders, total: orders.length, apiUrl: r.url }
            }
          } catch (e) {}
        }

        return null
      }

      /**
       * 递归查找 JSON 中包含指定字段的数组
       */
      function findArrayWithField(obj, fieldName, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 3) return null
        if (Array.isArray(obj)) {
          if (obj.length > 0 && obj[0] && obj[0][fieldName] !== undefined) return obj
          return null
        }
        for (const key of Object.keys(obj)) {
          const result = findArrayWithField(obj[key], fieldName, depth + 1)
          if (result) return result
        }
        return null
      }

      /**
       * 标准化 JD 供销订单数据
       * 基于实际 API 响应结构（api_order_list）精准映射
       *
       * 关键字段：
       *   jdOrderId     - JD 订单号
       *   orderTime     - 下单时间
       *   orderStateDesc - 状态文本（待出库/已出库/已完成等）
       *   totalCgPrice  - 采购总额
       *   freightPrice  - 运费
       *   loanPrice     - 货款总额
       *   sellerId / sellerShopName - 代销商信息
       *   consumerName / consumerTel / consumerAddress - 收货人
       *   skuList[]     - 商品列表（嵌套数组）
       *   extMap.originalAddress - 真实地址（非脱敏）
       */
      function normalizeOrder(raw) {
        const order = {}

        // 订单基本信息
        order.orderId = String(raw.jdOrderId || '')
        order.bOrderId = String(raw.bOrderId || '')
        order.orderDate = raw.orderTime || ''
        order.finishTime = raw.finishTime || ''
        order.stockTime = raw.stockTime || ''

        // 金额
        order.totalAmount = raw.totalCgPrice || raw.loanPrice || 0
        order.goodsAmount = raw.loanPrice || 0
        order.freightPrice = raw.freightPrice || 0

        // 状态
        order.orderState = raw.orderState
        order.statusText = raw.orderStateDesc || raw.jdOrderStateDesc || ''
        order.jdOrderStateDesc = raw.jdOrderStateDesc || ''
        order.paid = raw.paid || false
        order.waitPay = raw.waitPay || false
        order.lock = raw.lock || 0

        // 代销商（买家/seller）
        order.dealerCode = String(raw.sellerId || '')
        order.dealerName = raw.sellerShopName || raw.sellerPin || ''

        // 供应商（卖家/supplier）
        order.supplierName = raw.supplierShopName || raw.supplierPin || ''

        // 收货人
        order.receiverName = raw.consumerName || ''
        order.receiverPhone = raw.consumerTel || ''
        order.receiverAddress = raw.consumerAddress || ''
        // extMap 中可能有真实地址
        if (raw.extMap && raw.extMap.originalAddress) {
          order.receiverFullAddress = raw.extMap.originalAddress
        }

        // 物流
        order.shipmentNum = raw.shipmentNum || ''
        order.shipmentCompanyName = raw.shipmentCompanyName || ''

        // 商品信息（从 skuList 提取第一个 SKU）
        if (raw.skuList && raw.skuList.length > 0) {
          const sku = raw.skuList[0]
          order.skuId = String(sku.jdSkuId || '')
          order.productName = sku.skuName || ''
          order.unitPrice = sku.cgPrice || 0
          order.jdPrice = sku.jdPrice || 0
          order.quantity = sku.skuNum || 0
          order.productImage = sku.image ? `https://img14.360buyimg.com/n1/${sku.image}` : ''
          order.outerSkuId = sku.outerSkuId || ''
          // 如果有多个 SKU
          if (raw.skuList.length > 1) {
            order.skuCount = raw.skuList.length
            order.allSkus = raw.skuList.map(s => ({
              skuId: String(s.jdSkuId || ''),
              name: s.skuName || '',
              price: s.cgPrice || 0,
              quantity: s.skuNum || 0
            }))
          }
        }

        // 订单来源
        order.orderSourceDesc = raw.orderSourceDesc || ''
        order.sourceType = raw.sourceType || ''

        return order
      }

      console.log('[SupplyFetch] Loading entry:', ENTRY_URL)
      win.loadURL(ENTRY_URL)

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
    console.log('[SupplyFetch] === Start storeId:', storeId, '===')
    const result = await fetchSupplyOrders(storeId)
    console.log('[SupplyFetch] === End:', result.success ? 'OK' : 'FAIL', '===')
    return result
  })
}

module.exports = { registerSupplyOrderIpc }
