const { BrowserWindow, ipcMain, session, app } = require('electron')
const path = require('path')
const fs = require('fs')

const DEBUG_LOG_PATH = path.join(
  app.isPackaged ? path.dirname(process.execPath) : process.cwd(),
  'sales-debug.json'
)

function saveDebugLog(data) {
  try {
    fs.writeFileSync(DEBUG_LOG_PATH, JSON.stringify(data, null, 2), 'utf-8')
    console.log('[SalesFetch] debug log saved:', DEBUG_LOG_PATH)
  } catch (e) {
    console.log('[SalesFetch] save debug log failed:', e.message)
  }
}

const ENTRY_URL = 'https://shop.jd.com/'
const TARGET_URL = 'https://shop.jd.com/jdm/trade/orders/order-list?tabType=allOrders'
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
 * 同时将分页参数 pageSize 调整为 50，以获取更多订单数据
 */
const API_INTERCEPTOR = `
(function() {
  if (window.__apiInterceptorInstalled) return;
  window.__apiInterceptorInstalled = true;
  window.__capturedResponses = [];
  window.__debugRequestBodies = [];

  var ORDER_PAGE_SIZE = 50;

  function patchUrlPageSize(url) {
    if (!url || typeof url !== 'string') return url;
    return url.replace(/([?&])(pageSize|page_size)=\\d+/g, '$1$2=' + ORDER_PAGE_SIZE);
  }

  function patchBodyPageSize(body) {
    if (!body || typeof body !== 'string') return body;
    var result = body;
    try {
      if (result.charAt(0) === '{') {
        var obj = JSON.parse(result);
        var jsonStr = JSON.stringify(obj);
        if (jsonStr.indexOf('pageSize') !== -1 || jsonStr.indexOf('page_size') !== -1) {
          jsonStr = jsonStr.replace(/"pageSize":\\s*\\d+/g, '"pageSize":' + ORDER_PAGE_SIZE);
          jsonStr = jsonStr.replace(/"page_size":\\s*\\d+/g, '"page_size":' + ORDER_PAGE_SIZE);
          return jsonStr;
        }
        return result;
      }
    } catch(e) {}
    // JSON 在 form 参数内 (如 body={"pageSize":10,...})
    result = result.replace(/"pageSize"\\s*:\\s*\\d+/g, '"pageSize":' + ORDER_PAGE_SIZE);
    result = result.replace(/"page_size"\\s*:\\s*\\d+/g, '"page_size":' + ORDER_PAGE_SIZE);
    // URL编码的JSON (%22pageSize%22%3A10)
    result = result.replace(/%22pageSize%22%3A\\d+/gi, '%22pageSize%22%3A' + ORDER_PAGE_SIZE);
    result = result.replace(/%22page_size%22%3A\\d+/gi, '%22page_size%22%3A' + ORDER_PAGE_SIZE);
    // 简单 key=value 格式 (pageSize=10 或 pageSize%3D10)
    result = result.replace(/(pageSize|page_size)(=|%3D)\\d+/gi, '$1$2' + ORDER_PAGE_SIZE);
    return result;
  }

  // 拦截 fetch
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    var urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    // 修改 URL 中的 pageSize
    if (typeof input === 'string') {
      input = patchUrlPageSize(input);
    }
    // 修改 body 中的 pageSize
    if (init && init.body) {
      if (typeof init.body === 'string') {
        // 调试：记录 queryOrderPage 的 body
        if (urlStr.indexOf('queryOrderPage') !== -1) {
          window.__debugRequestBodies.push({ type: 'fetch', bodyType: 'string', body: init.body.substring(0, 2000), url: urlStr.substring(0, 200) });
        }
        init = Object.assign({}, init, { body: patchBodyPageSize(init.body) });
      } else {
        // body 不是字符串，记录其类型用于调试
        if (urlStr.indexOf('queryOrderPage') !== -1) {
          var bodyTypeName = init.body.constructor ? init.body.constructor.name : typeof init.body;
          window.__debugRequestBodies.push({ type: 'fetch', bodyType: bodyTypeName, body: '[non-string]', url: urlStr.substring(0, 200) });
        }
      }
    }
    return origFetch.call(this, input, init).then(function(response) {
      try {
        var cloned = response.clone();
        cloned.text().then(function(body) {
          if (body.length > 50) {
            window.__capturedResponses.push({
              type: 'fetch',
              url: urlStr.substring(0, 1000),
              status: response.status,
              bodyLen: body.length,
              body: body.substring(0, 200000),
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
    // 修改 URL 中的 pageSize
    if (typeof url === 'string') {
      arguments[1] = patchUrlPageSize(url);
    }
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    var xhr = this;
    var xhrUrl = xhr.__captureUrl || '';

    // 调试：记录 queryOrderPage 的请求 body 信息
    if (xhrUrl.indexOf('queryOrderPage') !== -1) {
      var debugInfo = { type: 'xhr', url: xhrUrl.substring(0, 200) };
      if (body === null || body === undefined) {
        debugInfo.bodyType = 'null';
        debugInfo.body = null;
      } else if (typeof body === 'string') {
        debugInfo.bodyType = 'string';
        debugInfo.body = body.substring(0, 2000);
      } else if (body instanceof FormData) {
        debugInfo.bodyType = 'FormData';
        debugInfo.body = '[FormData]';
        // 尝试读取 FormData 内容
        try {
          var fdEntries = [];
          body.forEach(function(value, key) { fdEntries.push(key + '=' + (typeof value === 'string' ? value.substring(0, 500) : '[blob]')); });
          debugInfo.body = fdEntries.join('&');
        } catch(e) { debugInfo.body = '[FormData: cannot read]'; }
      } else if (body instanceof URLSearchParams) {
        debugInfo.bodyType = 'URLSearchParams';
        debugInfo.body = body.toString().substring(0, 2000);
      } else if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
        debugInfo.bodyType = 'ArrayBuffer';
        try { debugInfo.body = new TextDecoder().decode(body).substring(0, 2000); } catch(e) { debugInfo.body = '[binary]'; }
      } else {
        debugInfo.bodyType = body.constructor ? body.constructor.name : typeof body;
        debugInfo.body = '[unknown type]';
      }
      window.__debugRequestBodies.push(debugInfo);
    }

    // 修改 body 中的 pageSize
    if (body && typeof body === 'string') {
      body = patchBodyPageSize(body);
    } else if (body instanceof URLSearchParams) {
      // 处理 URLSearchParams 格式
      if (body.has('pageSize')) body.set('pageSize', ORDER_PAGE_SIZE);
      if (body.has('page_size')) body.set('page_size', ORDER_PAGE_SIZE);
      // 检查是否有嵌套 JSON 参数包含 pageSize
      body.forEach(function(value, key) {
        if (typeof value === 'string' && value.indexOf('pageSize') !== -1) {
          body.set(key, patchBodyPageSize(value));
        }
      });
    } else if (body instanceof FormData) {
      // FormData 无法直接遍历修改，但检查 body 参数
      try {
        var bodyParam = body.get('body');
        if (bodyParam && typeof bodyParam === 'string' && bodyParam.indexOf('pageSize') !== -1) {
          body.set('body', patchBodyPageSize(bodyParam));
        }
      } catch(e) {}
    }

    xhr.addEventListener('load', function() {
      try {
        var respBody = xhr.responseText || '';
        if (respBody.length > 50) {
          window.__capturedResponses.push({
            type: 'xhr',
            method: xhr.__captureMethod,
            url: xhr.__captureUrl,
            status: xhr.status,
            bodyLen: respBody.length,
            body: respBody.substring(0, 200000),
            time: Date.now()
          });
        }
      } catch(e) {}
    });
    return origSend.call(this, body);
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
  var debugBodies = window.__debugRequestBodies || [];
  window.__debugRequestBodies = [];
  return {
    count: data.length,
    debugBodies: debugBodies,
    responses: data.map(function(r) {
      return {
        type: r.type,
        method: r.method || 'GET',
        url: r.url,
        status: r.status,
        bodyLen: r.bodyLen,
        body: r.body,
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

function fetchSalesOrders(storeId) {
  return new Promise(async (resolve) => {
    if (activeFetches.has(storeId)) {
      return resolve({ success: false, message: '该店铺正在获取数据，请等待完成' })
    }

    const partitionName = `persist:platform-${storeId}`
    const ses = session.fromPartition(partitionName)
    const cookies = await ses.cookies.get({})
    const jdCookies = cookies.filter(c => c.domain && c.domain.includes('jd.com'))

    console.log('[SalesFetch] storeId:', storeId, 'partition:', partitionName)
    console.log('[SalesFetch] Cookies:', cookies.length, 'JD:', jdCookies.length)

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
        show: false,
        width: 1200,
        height: 800,
        title: '[调试] 销售订单获取',
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
        console.log('[SalesFetch] API interceptor + visibility override injected')
      })

      win.webContents.on('did-navigate', (event, url) => {
        console.log('[SalesFetch] navigate:', url.substring(0, 150))
        if (isLoginPage(url)) {
          finish({ success: false, message: '店铺登录已过期，请重新登录京东后台' })
        }
      })

      let entryLoaded = false
      let targetLoaded = false

      win.webContents.on('did-finish-load', () => {
        if (win.isDestroyed() || resolved) return
        const currentUrl = win.webContents.getURL()
        console.log('[SalesFetch] loaded:', currentUrl.substring(0, 150))

        if (!entryLoaded && !isLoginPage(currentUrl)) {
          entryLoaded = true
          console.log('[SalesFetch] Entry OK, jump to target in 3s...')
          setTimeout(() => {
            if (win.isDestroyed() || resolved) return
            win.loadURL(TARGET_URL)
          }, 3000)
          return
        }

        if (entryLoaded && !targetLoaded && currentUrl.includes('trade/orders')) {
          targetLoaded = true
          console.log('[SalesFetch] Target page loaded, start polling for API data...')
          pollForAPIData()
          return
        }
      })

      // 轮询读取被拦截的 API 响应数据
      function pollForAPIData() {
        let pollCount = 0
        const maxPolls = 30 // 60 秒
        const pollInterval = 2000

        function poll() {
          if (win.isDestroyed() || resolved) return
          pollCount++

          win.webContents.executeJavaScript(READ_CAPTURED)
            .then(captured => {
              if (captured.count > 0) {
                allCapturedResponses.push(...captured.responses)
                console.log(`[SalesFetch] poll #${pollCount}: +${captured.count} APIs (total: ${allCapturedResponses.length})`)

                // 输出 queryOrderPage 的请求体调试信息
                if (captured.debugBodies && captured.debugBodies.length > 0) {
                  for (const db of captured.debugBodies) {
                    console.log(`[SalesFetch] DEBUG requestBody: type=${db.type} bodyType=${db.bodyType} url=${db.url}`)
                    console.log(`[SalesFetch] DEBUG body content: ${db.body ? db.body.substring(0, 500) : 'null'}`)
                  }
                }

                for (const r of captured.responses) {
                  console.log(`  [${r.type}] ${r.method} ${r.url.substring(0, 120)} (${r.bodyLen}B)`)
                }

                // 尝试从捕获的数据中找到订单
                const orderData = findOrderData(allCapturedResponses)
                if (orderData) {
                  console.log(`[SalesFetch] Order data found! ${orderData.orders.length} orders`)
                  saveDebugLog({
                    timestamp: new Date().toISOString(),
                    storeId,
                    phase: 'success',
                    ordersCount: orderData.orders.length,
                    totalCount: orderData.total,
                    apiUrl: orderData.apiUrl,
                    rawSampleOrders: orderData.rawOrders ? orderData.rawOrders.slice(0, 3) : [],
                    sampleOrders: orderData.orders.slice(0, 3),
                    allCapturedAPIs: allCapturedResponses.map(r => ({
                      type: r.type, method: r.method, url: r.url,
                      status: r.status, bodyLen: r.bodyLen
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
              } else {
                console.log(`[SalesFetch] poll #${pollCount}: no new APIs (total: ${allCapturedResponses.length})`)
              }

              if (pollCount < maxPolls) {
                setTimeout(poll, pollInterval)
              } else {
                console.log(`[SalesFetch] Poll timeout. Total APIs captured: ${allCapturedResponses.length}`)
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
              console.log(`[SalesFetch] poll error:`, err.message)
              if (pollCount < maxPolls) {
                setTimeout(poll, pollInterval)
              } else {
                finish({ success: false, message: '轮询失败: ' + err.message })
              }
            })
        }

        setTimeout(poll, 3000)
      }

      /**
       * 从捕获的 API 响应中查找销售订单数据
       * 京麦销售订单页面 API 关键词：orderList, queryOrder, order_list 等
       */
      function findOrderData(responses) {
        // 优先查找 URL 中包含订单相关关键词的 API
        const orderUrlKeywords = ['orderList', 'queryOrder', 'order_list', 'getOrderList', 'orderSearch', 'order/list']
        let bestMatch = null
        for (const r of responses) {
          if (r.status !== 200) continue
          const urlLower = r.url.toLowerCase()
          const matched = orderUrlKeywords.some(kw => urlLower.includes(kw.toLowerCase()))
          if (!matched) continue
          if (!bestMatch || r.bodyLen > bestMatch.bodyLen) {
            bestMatch = r
          }
        }

        if (bestMatch) {
          try {
            const json = JSON.parse(bestMatch.body)
            const list = extractOrderList(json)
            if (list && list.length > 0) {
              const orders = list.map(normalizeSalesOrder)
              const total = json.totalCount || json.total || json.data?.total || orders.length
              return { orders, total, apiUrl: bestMatch.url, rawOrders: list }
            }
          } catch (e) {
            console.log('[SalesFetch] Parse order API failed:', e.message)
          }
        }

        // 备用：扫描所有响应，找包含 orderId 的数组
        for (const r of responses) {
          if (r.status !== 200 || r.bodyLen < 500) continue
          if (r.url.includes('.css') || r.url.includes('.js') || r.url.includes('.png')) continue
          try {
            const body = r.body
            if (!body || (body.charAt(0) !== '{' && body.charAt(0) !== '[')) continue
            const json = JSON.parse(body)
            const list = findArrayWithField(json, 'orderId')
            if (list && list.length > 0) {
              const orders = list.map(normalizeSalesOrder)
              return { orders, total: orders.length, apiUrl: r.url, rawOrders: list }
            }
          } catch (e) {}
        }

        return null
      }

      /**
       * 从 JD 响应 JSON 中提取订单数组
       * 适配多种常见包装格式
       */
      function extractOrderList(json) {
        if (!json || typeof json !== 'object') return null

        // 直接数组
        if (Array.isArray(json) && json.length > 0 && json[0].orderId) return json

        // { data: [...] }
        if (Array.isArray(json.data) && json.data.length > 0) return json.data

        // { data: { orderList: [...] } }
        if (json.data && Array.isArray(json.data.orderList)) return json.data.orderList

        // { data: { list: [...] } }
        if (json.data && Array.isArray(json.data.list)) return json.data.list

        // { data: { result: [...] } }
        if (json.data && Array.isArray(json.data.result)) return json.data.result

        // { resultData: { list: [...] } }
        if (json.resultData && Array.isArray(json.resultData.list)) return json.resultData.list

        // { model: { orderInfoList: [...] } }
        if (json.model && Array.isArray(json.model.orderInfoList)) return json.model.orderInfoList

        // 递归查找
        return findArrayWithField(json, 'orderId')
      }

      /**
       * 递归查找 JSON 中包含指定字段的数组
       */
      function findArrayWithField(obj, fieldName, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 4) return null
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
       * 毫秒时间戳转为可读日期字符串
       */
      function formatTimestamp(ts) {
        if (!ts) return ''
        const n = typeof ts === 'number' ? ts : Number(ts)
        if (isNaN(n) || n <= 0) return String(ts || '')
        try {
          const d = new Date(n)
          const pad = v => String(v).padStart(2, '0')
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
        } catch (e) { return String(ts) }
      }

      /**
       * 拼接图片完整 URL
       */
      function normalizeImgUrl(url) {
        if (!url) return ''
        if (url.startsWith('http')) return url
        if (url.startsWith('//')) return 'https:' + url
        return 'https://img14.360buyimg.com/n1/' + url
      }

      /**
       * 标准化京麦销售订单数据
       * 基于 queryOrderPage 实际响应结构映射
       */
      function normalizeSalesOrder(raw) {
        const order = {}
        const statusInfo = raw.orderStatusInfo || {}
        const payInfo = raw.orderPaymentInfo || {}
        const consInfo = raw.orderConsigneeInfo || {}

        // 订单基本信息
        order.orderId = String(raw.orderId || '')
        order.orderState = statusInfo.orderStatus || 0
        order.statusText = statusInfo.orderStatusName || statusInfo.orderStatusDesc || ''

        // 时间（京麦返回毫秒时间戳）
        order.orderTime = formatTimestamp(raw.orderCreateTime)
        order.paymentTime = formatTimestamp(raw.paymentConfirmTime)
        order.shipTime = formatTimestamp(raw.consignTime || raw.deliveryTime)
        order.finishTime = formatTimestamp(raw.finishTime || raw.completeTime)

        // 金额（从 orderPaymentInfo 嵌套对象取）
        order.totalAmount = parseFloat(payInfo.shouldPay || payInfo.orderSum || 0) || 0
        order.goodsAmount = parseFloat(payInfo.orderSum || payInfo.shouldPay || 0) || 0
        order.shippingFee = parseFloat(payInfo.freight || 0) || 0

        // 支付方式
        order.paymentMethod = payInfo.paymentTypeName || ''

        // 收货人信息（从 orderConsigneeInfo 取）
        order.buyerName = consInfo.consName || consInfo.fullname || ''
        order.buyerPhone = consInfo.consMobilePhone || consInfo.mobile || ''
        order.buyerAddress = consInfo.consAddress || consInfo.fullAddress || ''

        // 买家账号
        order.buyerAccount = raw.userPin || ''

        // 物流信息（订单列表 API 可能不含，留空备用）
        order.logisticsCompany = raw.logisticsCompany || ''
        order.logisticsNo = raw.logisticsNo || raw.waybillCode || ''

        // 商品信息（从 orderItems 提取）
        const items = raw.orderItems || raw.skuList || raw.itemList || []
        if (items.length > 0) {
          const firstItem = items[0]
          order.skuId = String(firstItem.skuId || '')
          order.productName = firstItem.skuName || firstItem.itemName || ''
          order.unitPrice = parseFloat(firstItem.jdPrice || firstItem.price || 0) || 0
          order.quantity = firstItem.num || firstItem.quantity || 0
          order.productImage = normalizeImgUrl(firstItem.imgUrl || firstItem.image)

          order.itemCount = items.length
          order.allItems = items.map(item => ({
            skuId: String(item.skuId || ''),
            name: item.skuName || item.itemName || '',
            price: parseFloat(item.jdPrice || item.price || 0) || 0,
            quantity: item.num || item.quantity || 0,
            image: normalizeImgUrl(item.imgUrl || item.image)
          }))
        } else {
          order.skuId = ''
          order.productName = ''
          order.unitPrice = 0
          order.quantity = raw.skuTotalNum || 0
          order.productImage = ''
          order.itemCount = 0
          order.allItems = []
        }

        return order
      }

      console.log('[SalesFetch] Loading entry:', ENTRY_URL)
      win.loadURL(ENTRY_URL)

    } catch (err) {
      finish({ success: false, message: '获取订单失败: ' + err.message })
    }
  })
}

function registerSalesOrderIpc() {
  ipcMain.handle('fetch-sales-orders', async (event, { storeId }) => {
    if (!storeId) {
      return { success: false, message: '请选择店铺' }
    }

    // 检查同步锁，避免重复同步
    const lock = await requestSyncLock(storeId, 'sales')
    if (!lock.granted) {
      return { success: false, message: `该店铺正在同步中，请稍后再试（上次同步: ${lock.lastSyncAt || '刚刚'}）` }
    }

    console.log('[SalesFetch] === Start storeId:', storeId, '===')
    const result = await fetchSalesOrders(storeId)
    console.log('[SalesFetch] === End:', result.success ? 'OK' : 'FAIL', '===')
    return result
  })
}

// ============ 自动定时同步 ============
const AUTO_SYNC_INTERVAL = 10 * 60 * 1000 // 10 分钟
const AUTO_SYNC_FIRST_DELAY = 60 * 1000   // 启动后 60 秒开始第一次
const LOCAL_SERVER = 'http://localhost:3002'
const REMOTE_SERVER = 'http://150.158.54.108:3002'

let autoSyncTimer = null
let autoSyncRunning = false
const DEVICE_ID = `device_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

function httpGetJson(url) {
  const http = require('http')
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 10000 }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function httpPostJson(url, body) {
  const http = require('http')
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const postData = JSON.stringify(body)
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 10000
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

async function requestSyncLock(storeId, type = 'sales') {
  // 必须请求远程服务器获取锁（多设备共享）
  try {
    const res = await httpPostJson(`${REMOTE_SERVER}/api/sync-lock/${storeId}`, {
      deviceId: DEVICE_ID,
      type
    })
    if (res && res.code === 0 && res.data) {
      return res.data  // { granted: true/false, ... }
    }
    return { granted: false, message: '锁服务响应异常' }
  } catch (err) {
    console.log('[AutoSync] 请求同步锁失败:', err.message)
    return { granted: false, message: '无法连接锁服务: ' + err.message }
  }
}

async function autoSyncAllStores(mainWindow) {
  if (autoSyncRunning) {
    console.log('[AutoSync] 上一次同步尚未完成，跳过')
    return
  }
  autoSyncRunning = true
  console.log('[AutoSync] === 开始自动同步订单 ===')

  try {
    // 获取所有启用且有 Cookie 的店铺
    const json = await httpGetJson(`${LOCAL_SERVER}/api/cookies`)
    if (!json || json.code !== 0 || !json.data) {
      console.log('[AutoSync] 获取店铺列表失败')
      return
    }

    // 筛选京东平台店铺（目前 fetchSalesOrders 只支持 JD）
    const jdStores = json.data.filter(s => s.platform === 'jd' && s.cookie_data)
    if (jdStores.length === 0) {
      console.log('[AutoSync] 无可同步的京东店铺')
      return
    }

    console.log(`[AutoSync] 待同步店铺: ${jdStores.length} 个`)

    // 逐个同步，避免并发风控
    for (let i = 0; i < jdStores.length; i++) {
      const store = jdStores[i]
      console.log(`[AutoSync] [${i + 1}/${jdStores.length}] 同步店铺: ${store.store_name} (ID:${store.store_id})`)

      // 请求同步锁，避免多设备重复同步
      const lock = await requestSyncLock(store.store_id, 'sales')
      if (!lock.granted) {
        console.log(`[AutoSync] [${i + 1}/${jdStores.length}] 跳过: 已被其他设备同步 (by:${lock.lockedBy}, at:${lock.lastSyncAt})`)
        continue
      }

      // 通知渲染进程开始同步
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auto-sync-start', {
          storeId: store.store_id,
          storeName: store.store_name
        })
      }

      try {
        const result = await fetchSalesOrders(store.store_id)
        if (result.success) {
          console.log(`[AutoSync] [${i + 1}/${jdStores.length}] 成功: ${result.data?.pageTotal || 0} 条订单`)
        } else {
          console.log(`[AutoSync] [${i + 1}/${jdStores.length}] 失败: ${result.message}`)
        }

        // 通知渲染进程同步结果
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auto-sync-result', {
            storeId: store.store_id,
            storeName: store.store_name,
            success: result.success,
            orderCount: result.data?.pageTotal || 0,
            message: result.message || ''
          })
        }
      } catch (err) {
        console.log(`[AutoSync] [${i + 1}/${jdStores.length}] 异常: ${err.message}`)
      }

      // 多店铺之间间隔 30 秒，避免频繁操作
      if (i < jdStores.length - 1) {
        console.log('[AutoSync] 等待 30 秒后同步下一个店铺...')
        await new Promise(resolve => setTimeout(resolve, 30000))
      }
    }
  } catch (err) {
    console.log('[AutoSync] 自动同步异常:', err.message)
  } finally {
    autoSyncRunning = false
    console.log('[AutoSync] === 自动同步结束 ===')
  }
}

function startAutoSync(mainWindow) {
  // 首次延迟执行
  setTimeout(() => {
    autoSyncAllStores(mainWindow)
  }, AUTO_SYNC_FIRST_DELAY)

  // 定时执行
  autoSyncTimer = setInterval(() => {
    autoSyncAllStores(mainWindow)
  }, AUTO_SYNC_INTERVAL)

  console.log('[AutoSync] 定时同步已启动，间隔: 10 分钟')
}

function stopAutoSync() {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer)
    autoSyncTimer = null
  }
}

module.exports = { registerSalesOrderIpc, startAutoSync, stopAutoSync }
