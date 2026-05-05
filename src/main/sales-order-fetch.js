const { BrowserWindow, ipcMain, session, app } = require('electron')
const path = require('path')
const fs = require('fs')
const { getAuthToken } = require('./auth-store')

const DEBUG_LOG_PATH = path.join(
  app.isPackaged ? path.dirname(process.execPath) : process.cwd(),
  'sales-debug.json'
)

function saveDebugLog(data) {
  try {
    let existing = []
    try { existing = JSON.parse(fs.readFileSync(DEBUG_LOG_PATH, 'utf-8')) } catch (e) {}
    if (!Array.isArray(existing)) existing = []
    existing.push(data)
    // 最多保留20条
    if (existing.length > 20) existing = existing.slice(-20)
    fs.writeFileSync(DEBUG_LOG_PATH, JSON.stringify(existing, null, 2), 'utf-8')
    console.log('[SalesFetch] debug log saved:', DEBUG_LOG_PATH, 'entries:', existing.length)
  } catch (e) {
    console.log('[SalesFetch] save debug log failed:', e.message)
  }
}

const ENTRY_URL = 'https://shop.jd.com/'
const TARGET_URL = 'https://shop.jd.com/jdm/trade/orders/order-list?tabType=allOrders'
const OVERALL_TIMEOUT = 120000

const activeFetches = new Map()
global.__activeSyncStores = activeFetches  // 暴露给 cookie-heartbeat 使用

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
  var SORT_ORDER = 'desc';  // 按下单时间倒序，获取最新订单

  function patchUrlPageSize(url) {
    if (!url || typeof url !== 'string') return url;
    return url.replace(/([?&])(pageSize|page_size)=\\d+/g, '$1$2=' + ORDER_PAGE_SIZE);
  }

  // 修改请求体中的排序参数，确保获取最新订单
  function patchBodySortOrder(body) {
    if (!body || typeof body !== 'string') return body;
    try {
      if (body.charAt(0) === '{') {
        var obj = JSON.parse(body);
        // 设置排序字段为下单时间
        if (!obj.orderField) obj.orderField = 'orderCreateTime';
        // 设置排序方向为倒序（最新在前）
        obj.orderType = SORT_ORDER;
        return JSON.stringify(obj);
      }
    } catch(e) {}
    // URL编码或form格式的JSON
    var result = body;
    result = result.replace(/"orderType"\\s*:\\s*"[^"]*"/g, '"orderType":"' + SORT_ORDER + '"');
    result = result.replace(/%22orderType%22%3A%22[^%]*%22/gi, '%22orderType%22%3A%22' + SORT_ORDER + '%22');
    return result;
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
        init = Object.assign({}, init, { body: patchBodySortOrder(patchBodyPageSize(init.body)) });
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

    // 修改 body 中的 pageSize 和排序
    if (body && typeof body === 'string') {
      body = patchBodySortOrder(patchBodyPageSize(body));
    } else if (body instanceof URLSearchParams) {
      // 处理 URLSearchParams 格式
      if (body.has('pageSize')) body.set('pageSize', ORDER_PAGE_SIZE);
      if (body.has('page_size')) body.set('page_size', ORDER_PAGE_SIZE);
      // 设置排序参数
      if (body.has('orderField')) body.set('orderField', 'orderCreateTime');
      if (body.has('orderType')) body.set('orderType', SORT_ORDER);
      // 检查是否有嵌套 JSON 参数包含 pageSize
      body.forEach(function(value, key) {
        if (typeof value === 'string' && value.indexOf('pageSize') !== -1) {
          body.set(key, patchBodySortOrder(patchBodyPageSize(value)));
        }
      });
    } else if (body instanceof FormData) {
      // FormData 无法直接遍历修改，但检查 body 参数
      try {
        var bodyParam = body.get('body');
        if (bodyParam && typeof bodyParam === 'string') {
          var patched = bodyParam;
          if (patched.indexOf('pageSize') !== -1) {
            patched = patchBodyPageSize(patched);
          }
          patched = patchBodySortOrder(patched);
          body.set('body', patched);
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
    
    // 详细Cookie诊断
    if (cookies.length > 0) {
      console.log('[SalesFetch] Cookie详情:')
      cookies.forEach((c, i) => {
        console.log(`  ${i+1}. ${c.name}=${c.value?.substring(0, 15)}... domain:${c.domain} expires:${c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : 'session'}`)
      })
    }
    
    if (jdCookies.length === 0) {
      console.log('[SalesFetch] 没有找到京东Cookie！')
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
      let navigatingForLogistics = false // 物流获取期间导航标志，防止 did-finish-load 重触poll

      win.webContents.on('did-finish-load', () => {
        if (win.isDestroyed() || resolved) return
        const currentUrl = win.webContents.getURL()
        console.log('[SalesFetch] loaded:', currentUrl.substring(0, 150))

        // 物流获取期间的导航（详情页/返回列表页），不触发主流程
        if (navigatingForLogistics) return

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
            .then(async captured => {
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

                  // 诊断：打印订单状态分布
                  const statusDist = {}
                  orderData.orders.forEach(o => { const s = o.statusText || 'unknown'; statusDist[s] = (statusDist[s] || 0) + 1 })
                  const shippedCount = orderData.orders.filter(o => o.shipTime).length
                  const hasLogistics = orderData.orders.filter(o => o.logisticsNo).length
                  console.log(`[SalesFetch] 状态分布: ${JSON.stringify(statusDist)}, 有shipTime=${shippedCount}, 有logisticsNo=${hasLogistics}`)

                  finishWithOrderData(orderData)
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
       * 完成订单数据返回（保存调试日志 + finish）
       */
      function finishWithOrderData(orderData) {
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

        let result = null
        if (bestMatch) {
          try {
            const json = JSON.parse(bestMatch.body)
            const list = extractOrderList(json)
            if (list && list.length > 0) {
              const orders = list.map(normalizeSalesOrder)
              const total = json.totalCount || json.total || json.data?.total || orders.length
              result = { orders, total, apiUrl: bestMatch.url, rawOrders: list }
            }
          } catch (e) {
            console.log('[SalesFetch] Parse order API failed:', e.message)
          }
        }

        // 备用：扫描所有响应，找包含 orderId 的数组
        if (!result) {
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
                result = { orders, total: orders.length, apiUrl: r.url, rawOrders: list }
                break
              }
            } catch (e) {}
          }
        }

        // 从物流相关 API 补充物流信息（orderStatus / orderLogistics 等）
        if (result && result.orders.length > 0) {
          const logisticsMap = extractLogisticsFromResponses(responses)
          if (Object.keys(logisticsMap).length > 0) {
            let patched = 0
            for (const order of result.orders) {
              const key = order.orderId
              const info = logisticsMap[key]
              if (info && !order.logisticsNo) {
                if (info.logisticsNo) order.logisticsNo = info.logisticsNo
                if (info.logisticsCompany) order.logisticsCompany = info.logisticsCompany
                patched++
              }
            }
            if (patched > 0) {
              console.log(`[SalesFetch] 从物流API补充了 ${patched} 个订单的物流信息`)
            }
          }
        }

        return result
      }

      /**
       * 从拦截到的 API 响应中提取物流信息
       * JD 订单页面会额外请求 orderStatus / orderLogistics 等 API，
       * 这些 API 包含 mailNo（物流单号）和 cpCode/cpName（物流公司）
       */
      function extractLogisticsFromResponses(responses) {
        const logisticsMap = {}
        const logisticsKeywords = ['orderStatus', 'orderLogistics', 'logisticsInfo', 'waybill', 'expressInfo', 'queryOrderLogisticsTrack', 'LogisticsTrack']

        for (const r of responses) {
          if (r.status !== 200 || r.bodyLen < 50) continue
          const urlLower = r.url.toLowerCase()
          if (!logisticsKeywords.some(kw => urlLower.includes(kw.toLowerCase()))) continue

          try {
            const json = JSON.parse(r.body)
            // 递归查找包含 mailNo 或 logisticsNo 的对象
            findLogisticsInObject(json, logisticsMap)
          } catch (e) {}
        }

        return logisticsMap
      }

      /**
       * 递归在 JSON 中查找物流数据（带 orderId 关联）
       */
      function findLogisticsInObject(obj, resultMap, depth = 0) {
        if (!obj || typeof obj !== 'object' || depth > 6) return
        if (Array.isArray(obj)) {
          for (const item of obj) findLogisticsInObject(item, resultMap, depth + 1)
          return
        }
        // 检查当前对象是否包含物流字段
        const orderId = obj.orderId || obj.orderid || obj.order_id
        const mailNo = obj.mailNo || obj.logisticsNo || obj.waybillCode || obj.trackingNo || obj.carriageId
        const cpName = obj.cpName || obj.expressCompany || obj.logisticsCompany || obj.companyName || obj.carrier
        if (orderId && (mailNo || cpName)) {
          const id = String(orderId)
          if (!resultMap[id]) resultMap[id] = {}
          if (mailNo) resultMap[id].logisticsNo = mailNo
          if (cpName) resultMap[id].logisticsCompany = cpName
        }
        // 也检查嵌套的 fields 子对象（JD orderStatus API 的结构）
        if (obj.fields && typeof obj.fields === 'object') {
          const fOrderId = obj.orderId || obj.orderid || obj.order_id
          const fMailNo = obj.fields.mailNo
          const fCpCode = obj.fields.cpCode
          const fCpName = obj.fields.cpName
          if (fOrderId && (fMailNo || fCpCode || fCpName)) {
            const id = String(fOrderId)
            if (!resultMap[id]) resultMap[id] = {}
            if (fMailNo) resultMap[id].logisticsNo = fMailNo
            if (fCpName) resultMap[id].logisticsCompany = fCpName
            else if (fCpCode) resultMap[id].logisticsCompany = fCpCode // cpCode 兜底
          }
        }
        // 继续递归
        for (const key of Object.keys(obj)) {
          if (key === 'fields') continue // 已处理
          findLogisticsInObject(obj[key], resultMap, depth + 1)
        }
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
        const rawStatusText = statusInfo.orderStatusName || statusInfo.orderStatusDesc || ''
        // 标准化状态名称（JD API 返回 "等待出库" → 前端 "待出库"）
        const STATUS_ALIAS_MAP = {
          '等待付款': '待付款',
          '等待出库': '待出库',
          '锁定': '暂停订单',
          '暂停': '暂停订单',
          '已发货': '已出库',
        }
        order.statusText = STATUS_ALIAS_MAP[rawStatusText] || rawStatusText

        // 时间（京麦返回毫秒时间戳）
        order.orderTime = formatTimestamp(raw.orderCreateTime)
        order.paymentTime = formatTimestamp(raw.paymentConfirmTime)
        order.shipTime = formatTimestamp(raw.consignTime || raw.deliveryTime)
        order.finishTime = formatTimestamp(raw.finishTime || raw.completeTime || raw.orderCompleteTime)

        // 金额（从 orderPaymentInfo 嵌套对象取）
        // totalAmount: 应付总额（含运费）
        // goodsAmount: 商品总额（不含运费）
        order.totalAmount = parseFloat(payInfo.shouldPay || 0) || 0
        order.goodsAmount = parseFloat(payInfo.orderSum || payInfo.goodsAmount || payInfo.shouldPay || 0) || 0
        order.shippingFee = parseFloat(payInfo.freight || 0) || 0

        // 支付方式
        order.paymentMethod = payInfo.paymentTypeName || ''

        // 收货人信息（从 orderConsigneeInfo 取）
        order.buyerName = consInfo.consName || consInfo.fullname || ''
        order.buyerPhone = consInfo.consMobilePhone || consInfo.mobile || ''
        order.buyerAddress = consInfo.consAddress || consInfo.fullAddress || ''

        // 买家账号
        order.buyerAccount = raw.userPin || ''

        // 物流信息（JD queryOrderPage 响应中物流字段嵌套位置多样，需逐层尝试）
        const extInfo = raw.extendInfo || {}
        const logisticsInfo = raw.logistics || raw.orderLogisticsInfo || {}
        // logisticsInfoList: queryOrderPage 返回的物流列表，可能包含 carrier + carriageId
        const logisticsList = raw.logisticsInfoList || []
        const firstLogistics = logisticsList.length > 0 ? logisticsList[0] : {}
        order.logisticsCompany =
          raw.logisticsCompany ||
          firstLogistics.carrier || firstLogistics.expressCompany || firstLogistics.logisticsCompany ||
          logisticsInfo.expressCompany || logisticsInfo.logisticsCompany || logisticsInfo.companyName ||
          extInfo.expressCompany || extInfo.logisticsCompany ||
          ''
        order.logisticsNo =
          raw.logisticsNo || raw.waybillCode ||
          firstLogistics.carriageId || firstLogistics.mailNo || firstLogistics.waybillCode ||
          logisticsInfo.mailNo || logisticsInfo.logisticsNo || logisticsInfo.waybillCode ||
          extInfo.mailNo || extInfo.logisticsNo ||
          ''

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
    console.log('[SalesFetch IPC] 收到同步请求，storeId:', storeId)
    
    if (!storeId) {
      return { success: false, message: '请选择店铺' }
    }

    // 检查同步锁，避免重复同步
    console.log('[SalesFetch IPC] 请求同步锁...')
    const lock = await requestSyncLock(storeId, 'sales')
    console.log('[SalesFetch IPC] 锁结果:', lock)
    
    if (!lock.granted) {
      console.log('[SalesFetch IPC] 锁未获取，拒绝同步')
      return { success: false, message: `该店铺正在同步中，请稍后再试（上次同步: ${lock.lastSyncAt || '刚刚'}）` }
    }

    let result
    try {
      console.log('[SalesFetch] === Start storeId:', storeId, '===')
      result = await fetchSalesOrders(storeId)
      console.log('[SalesFetch] === End:', result.success ? 'OK' : 'FAIL', '===')
      return result
    } finally {
      // 释放同步锁，传递同步结果以决定是否更新历史
      await releaseSyncLock(storeId, 'sales', result?.success ?? false)
      console.log('[SalesFetch] Lock released for storeId:', storeId, 'success:', result?.success)
    }
  })

  // ============ 买家敏感信息获取（DOM自动化方案） ============
  ipcMain.handle('fetch-buyer-sensitive-info', async (event, { storeId, orderId }) => {
    console.log('[SalesFetch] 获取买家信息: storeId=' + storeId + ', orderId=' + orderId)
    if (!storeId || !orderId) return { success: false, message: '缺少参数' }

    try {
      // 轮询等待辅助函数
      async function pollUntil(checkFn, { timeout = 10000, interval = 500, label = '' } = {}) {
        const start = Date.now()
        while (Date.now() - start < timeout) {
          try {
            const result = await checkFn()
            if (result) return result
          } catch (e) { /* ignore */ }
          await new Promise(r => setTimeout(r, interval))
        }
        if (label) console.log('[SalesFetch] [BuyerInfo] pollUntil超时: ' + label)
        return null
      }

      const partitionName = 'persist:platform-' + storeId
      const ses = session.fromPartition(partitionName)
      const cookies = await ses.cookies.get({})
      if (!cookies || cookies.length === 0) {
        return { success: false, message: '店铺未登录，请先登录京东后台' }
      }

      let tempWin = null
      let bindVnResponseData = null  // Electron层面拦截到的bindVirtualNumber响应

      try {
        tempWin = new BrowserWindow({
          show: false,
          width: 1200,
          height: 800,
          webPreferences: {
            partition: partitionName,
            contextIsolation: true,
            nodeIntegration: false
          }
        })

        // 使用 Electron 的 webRequest API 在网络层监听 bindVirtualNumber 请求
        // webRequest 不能读响应体，但可以监听请求完成，配合页面内拦截器双保险
        const sesForWR = session.fromPartition(partitionName)
        let bindVnRequestDetected = false
        try {
          sesForWR.webRequest.onCompleted({ urls: ['*://sff.jd.com/*bindVirtualNumber*'] }, (details) => {
            console.log('[SalesFetch] [BuyerInfo] webRequest检测到bindVirtualNumber完成:', details.statusCode, details.url.substring(0, 150))
            bindVnRequestDetected = true
          })
        } catch(e) {
          console.log('[SalesFetch] [BuyerInfo] webRequest监听设置失败:', e.message)
        }

        // 注入 API 拦截器（全量捕获模式：捕获所有API响应，后续从中筛选买家信息）
        tempWin.webContents.on('dom-ready', () => {
          if (tempWin.isDestroyed()) return
          tempWin.webContents.executeJavaScript(`
            (function() {
              if (window.__sffInterceptorInstalled) return;
              window.__sffInterceptorInstalled = true;
              window.__sensitiveInfoResult = null;
              window.__bindVirtualNumberResult = null;
              window.__sensitiveInfoLogs = [];
              window.__allCapturedResponses = [];
              window.__captureEnabled = false;
              window.__orderListResult = null;
              window.__captureStartTime = 0;
              window.__postConfirmPhase = false;

              // 判断响应是否包含真实买家信息（非脱敏）
              // 支持：标准手机号、虚拟号（95xxx/400xxx转接号）、非脱敏地址
              function containsBuyerInfo(text) {
                if (!text || text.length < 20) return false;
                // 1. 匹配标准11位手机号字段
                var stdPhone = /"(?:mobile|phone|consMobilePhone|consigneePhone|receiverMobile|contactPhone)"\\s*:\\s*"(1[3-9]\\d{9})"/;
                if (stdPhone.test(text)) return true;
                // 2. 匹配虚拟号/转接号字段（任何>=7位数字）
                var virtualPhone = /"(?:virtualNumber|virtualPhone|forwardNumber|transferPhone|vnNumber)"\\s*:\\s*"(\\d{7,20}(?:-\\d{1,6})?)"/;
                if (virtualPhone.test(text)) return true;
                // 3. 匹配手机号字段有非脱敏值（>=7位数字，不含*）
                var anyRealPhone = /"(?:mobile|phone|consMobilePhone|consigneePhone|receiverMobile)"\\s*:\\s*"(\\d{7,20})"/;
                if (anyRealPhone.test(text) && text.indexOf('*') === -1) return true;
                // 4. 匹配非脱敏地址（不含*号，长度>10）
                var addrPattern = /"(?:consAddress|fullAddress|address|receiverAddress)"\\s*:\\s*"([^"*]{10,})"/;
                if (addrPattern.test(text)) return true;
                // 5. 标记字段（解密成功的标记）
                if (text.indexOf('"decryptFlag"') !== -1 || text.indexOf('"isDecrypt"') !== -1) return true;
                return false;
              }

              // 排除已知无关API（仅在确认前使用，确认后不排除任何API）
              function isExcludedApi(url) {
                if (window.__postConfirmPhase) return false;
                return url.indexOf('queryOrderTags') !== -1
                  || url.indexOf('queryOrderTabs') !== -1
                  || url.indexOf('saveTableHeader') !== -1
                  || url.indexOf('queryOrderSkuComments') !== -1
                  || url.indexOf('checkOrderOperateSign') !== -1
                  || url.indexOf('pageConfigBffService') !== -1;
              }

              // 判断是否为订单列表API（不直接设置 sensitiveInfoResult，而是单独存储）
              // 订单列表API包含多个订单的买家信息，直接覆盖会取到错误订单
              function isOrderListApi(url) {
                return url.indexOf('queryOrderPage') !== -1
                  || url.indexOf('queryOrderList') !== -1
                  || url.indexOf('getOrderList') !== -1
                  || url.indexOf('orderSearch') !== -1;
              }

              // 判断是否为绑定虚拟号API（点击确定后触发，包含完整买家信息+分机号+虚拟号）
              function isBindVirtualNumberApi(url) {
                return url.indexOf('bindVirtualNumber') !== -1;
              }

              var origFetch = window.fetch;
              window.fetch = function(input, init) {
                var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
                // 捕获 getSensitiveInfo 的完整请求信息（URL、headers、body），用于直接调用 bindVirtualNumber
                if (url.indexOf('getSensitiveInfo') !== -1 && init) {
                  try {
                    var reqBody = init.body ? (typeof init.body === 'string' ? init.body : (init.body.toString ? init.body.toString() : '')) : '';
                    if (reqBody) window.__sensitiveInfoRequestBody = reqBody;
                    // 捕获请求头（包括CSRF令牌等安全头）
                    var headers = {};
                    if (init.headers) {
                      if (init.headers instanceof Headers) {
                        init.headers.forEach(function(v, k) { headers[k] = v; });
                      } else if (typeof init.headers === 'object') {
                        for (var k in init.headers) {
                          if (init.headers.hasOwnProperty(k)) headers[k] = init.headers[k];
                        }
                      }
                    }
                    window.__sensitiveInfoRequestHeaders = JSON.stringify(headers);
                    window.__sensitiveInfoRequestUrl = url;
                    window.__sensitiveInfoRequestMethod = init.method || 'POST';
                    window.__sensitiveInfoLogs.push('CAPTURED-REQ: method=' + (init.method||'POST') + ' headers=' + Object.keys(headers).join(',') + ' body=' + reqBody.substring(0, 200));
                  } catch(e) {}
                }
                return origFetch.apply(this, arguments).then(function(response) {
                  if (window.__captureEnabled) {
                    try {
                      var cloned = response.clone();
                      cloned.text().then(function(text) {
                        window.__sensitiveInfoLogs.push('fetch[' + response.status + ']: ' + url.substring(0, 150) + ' len=' + text.length);
                        window.__allCapturedResponses.push({ url: url.substring(0, 300), body: text.substring(0, 50000), time: Date.now() });
                        if (!isExcludedApi(url)) {
                          if (isBindVirtualNumberApi(url)) {
                            // bindVirtualNumber 响应包含完整信息：name[XXXX], address[XXXX], virtualNumber
                            // 优先级最高，单独存储
                            window.__sensitiveInfoLogs.push('BIND-VN-CAPTURED fetch: ' + url.substring(0, 150));
                            try { window.__bindVirtualNumberResult = JSON.parse(text); }
                            catch(e) {}
                            // 同时也设置为 sensitiveInfoResult（向后兼容）
                            try { window.__sensitiveInfoResult = JSON.parse(text); }
                            catch(e) {}
                          } else if (isOrderListApi(url)) {
                            // 订单列表API始终捕获（即使脱敏，name/address可能仍有用）
                            window.__sensitiveInfoLogs.push('ORDERLIST-CAPTURED fetch: ' + url.substring(0, 150));
                            try { window.__orderListResult = JSON.parse(text); }
                            catch(e) {}
                          } else if (containsBuyerInfo(text)) {
                            window.__sensitiveInfoLogs.push('MATCH fetch: ' + url.substring(0, 150));
                            try { window.__sensitiveInfoResult = JSON.parse(text); }
                            catch(e) { window.__sensitiveInfoResult = { raw: text.substring(0, 50000) }; }
                          }
                        }
                      }).catch(function(){});
                    } catch(e) {}
                  }
                  return response;
                });
              };

              var origXhrOpen = XMLHttpRequest.prototype.open;
              var origXhrSend = XMLHttpRequest.prototype.send;
              var origXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

              XMLHttpRequest.prototype.open = function(method, url) {
                this.__sffUrl = (url || '').toString();
                this.__sffHeaders = {};
                return origXhrOpen.apply(this, arguments);
              };

              // 拦截 setRequestHeader 以捕获请求头（含CSRF令牌等安全头）
              XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
                if (this.__sffHeaders) {
                  this.__sffHeaders[name] = value;
                }
                return origXhrSetHeader.apply(this, arguments);
              };

              XMLHttpRequest.prototype.send = function(body) {
                var xhr = this;
                // 捕获 getSensitiveInfo 的完整请求信息（URL、headers、body）
                var xhrUrl = xhr.__sffUrl || '';
                if (xhrUrl.indexOf('getSensitiveInfo') !== -1) {
                  try {
                    var reqBody = body ? (typeof body === 'string' ? body : (body.toString ? body.toString() : '')) : '';
                    if (reqBody) window.__sensitiveInfoRequestBody = reqBody;
                    if (xhrUrl) window.__sensitiveInfoRequestUrl = xhrUrl;
                    window.__sensitiveInfoRequestMethod = 'POST';
                    // 捕获所有请求头
                    var hdrs = xhr.__sffHeaders || {};
                    window.__sensitiveInfoRequestHeaders = JSON.stringify(hdrs);
                    window.__sensitiveInfoLogs.push('CAPTURED-XHR-REQ: url=' + xhrUrl.substring(0, 150) + ' headers=' + JSON.stringify(hdrs).substring(0, 300) + ' body=' + reqBody.substring(0, 200));
                  } catch(e) {}
                }
                if (window.__captureEnabled) {
                  xhr.addEventListener('load', function() {
                    try {
                      var text = xhr.responseText || '';
                      var url = xhr.__sffUrl || '';
                      window.__sensitiveInfoLogs.push('xhr[' + xhr.status + ']: ' + url.substring(0, 150) + ' len=' + text.length);
                      window.__allCapturedResponses.push({ url: url.substring(0, 300), body: text.substring(0, 50000), time: Date.now() });
                      if (!isExcludedApi(url)) {
                        if (isBindVirtualNumberApi(url)) {
                          // bindVirtualNumber 响应包含完整信息：name[XXXX], address[XXXX], virtualNumber
                          window.__sensitiveInfoLogs.push('BIND-VN-CAPTURED xhr: ' + url.substring(0, 150));
                          try { window.__bindVirtualNumberResult = JSON.parse(text); }
                          catch(e) {}
                          try { window.__sensitiveInfoResult = JSON.parse(text); }
                          catch(e) {}
                        } else if (isOrderListApi(url)) {
                          window.__sensitiveInfoLogs.push('ORDERLIST-CAPTURED xhr: ' + url.substring(0, 150));
                          try { window.__orderListResult = JSON.parse(text); }
                          catch(e) {}
                        } else if (containsBuyerInfo(text)) {
                          window.__sensitiveInfoLogs.push('MATCH xhr: ' + url.substring(0, 150));
                          try { window.__sensitiveInfoResult = JSON.parse(text); }
                          catch(e) { window.__sensitiveInfoResult = { raw: text.substring(0, 50000) }; }
                        }
                      }
                    } catch(e) {}
                  });
                }
                return origXhrSend.apply(this, arguments);
              };
            })()
          `).catch(() => {})
          tempWin.webContents.executeJavaScript(VISIBILITY_OVERRIDE).catch(() => {})
        })

        // 第一步：直接加载订单页面（跳过入口页，省一次页面加载）
        console.log('[SalesFetch] [BuyerInfo] 直接加载订单页...')
        await tempWin.loadURL('https://shop.jd.com/jdm/trade/orders/order-list?tabType=allOrders')

        const entryUrl = tempWin.webContents.getURL()
        if (isLoginPage(entryUrl)) {
          tempWin.destroy()
          return { success: false, message: '店铺登录已过期，请重新登录京东后台' }
        }

        // 轮询等待搜索框出现
        const searchBoxReady = await pollUntil(
          () => tempWin.webContents.executeJavaScript(
            "!!(document.querySelector('input.jd-input__inner') || document.querySelector('input[placeholder*=\"查询\"]'))"
          ),
          { timeout: 12000, interval: 400, label: '搜索框加载' }
        )
        if (!searchBoxReady) await new Promise(r => setTimeout(r, 2000))

        // 第三步：搜索目标订单号
        console.log('[SalesFetch] [BuyerInfo] 在搜索框中输入订单号...')
        const searchResult = await tempWin.webContents.executeJavaScript(`
          (function() {
            var orderId = ${JSON.stringify(String(orderId))};
            var result = { searched: false, logs: [] };
            var inputs = document.querySelectorAll('input[type="text"], input:not([type]), input[type="search"]');
            var searchInput = null;
            for (var i = 0; i < inputs.length; i++) {
              var inp = inputs[i];
              var ph = (inp.placeholder || '').toLowerCase();
              result.logs.push('输入框[' + i + ']: placeholder=' + inp.placeholder + ' name=' + inp.name + ' class=' + inp.className.toString().substring(0, 60));
              if (ph.match(/订单|order|编号|搜索|查询|search/) || (inp.name || '').toLowerCase().match(/order|keyword|search/)) {
                searchInput = inp;
                result.logs.push('选中搜索框: ' + inp.placeholder);
                break;
              }
            }
            if (!searchInput && inputs.length > 0) {
              for (var i = 0; i < inputs.length; i++) {
                var rect = inputs[i].getBoundingClientRect();
                if (rect.width > 50 && rect.height > 10) {
                  searchInput = inputs[i];
                  result.logs.push('使用第一个可见输入框: ' + inputs[i].placeholder);
                  break;
                }
              }
            }
            if (!searchInput) { result.logs.push('未找到搜索输入框'); return result; }

            var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(searchInput, orderId);
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            searchInput.dispatchEvent(new Event('change', { bubbles: true }));
            result.logs.push('已输入订单号');

            var btns = document.querySelectorAll('button, [role="button"]');
            var searchBtn = null;
            for (var i = 0; i < btns.length; i++) {
              if (/^(搜索|查询|查找|Search)$/.test(btns[i].textContent.trim())) { searchBtn = btns[i]; break; }
            }
            if (!searchBtn) {
              var parent = searchInput.parentElement;
              for (var d = 0; d < 3; d++) {
                if (!parent) break;
                var iconBtns = parent.querySelectorAll('[class*="search" i], [class*="icon" i], button');
                for (var j = 0; j < iconBtns.length; j++) {
                  if (iconBtns[j] !== searchInput) { searchBtn = iconBtns[j]; break; }
                }
                if (searchBtn) break;
                parent = parent.parentElement;
              }
            }
            if (searchBtn) {
              searchBtn.click();
              result.searched = true;
              result.logs.push('已点击搜索按钮');
            } else {
              searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
              searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
              result.searched = true;
              result.logs.push('已模拟回车');
            }
            return result;
          })()
        `).catch(e => ({ searched: false, logs: ['error: ' + e.message] }))

        console.log('[SalesFetch] [BuyerInfo] 搜索结果:', JSON.stringify(searchResult))

        // 轮询等待搜索结果加载
        if (searchResult.searched) {
          const orderFound = await pollUntil(
            () => tempWin.webContents.executeJavaScript(
              "!!(function(){var els=document.querySelectorAll('*');for(var i=0;i<els.length;i++){if(els[i].children.length===0&&els[i].textContent.trim()==='" + orderId + "')return true;}return false;})()"
            ),
            { timeout: 8000, interval: 400, label: '搜索结果' }
          )
          if (!orderFound) await new Promise(r => setTimeout(r, 1500))
        }

        // 第四步：在DOM中查找目标订单并点击小眼睛
        // 先启用全量API捕获（在点击眼睛之前开启，确保不漏掉任何响应）
        await tempWin.webContents.executeJavaScript('window.__captureEnabled = true; window.__allCapturedResponses = [];').catch(() => {})
        console.log('[SalesFetch] [BuyerInfo] 在DOM中查找订单并点击小眼睛...')
        const clickResult = await tempWin.webContents.executeJavaScript(`
          (function() {
            var orderId = ${JSON.stringify(String(orderId))};
            var result = { found: false, clicked: false, logs: [] };
            try {
            function gc(el) { try { return el.getAttribute('class') || ''; } catch(e) { return ''; } }

            var allEls = document.querySelectorAll('*');
            var orderEl = null;
            for (var i = 0; i < allEls.length; i++) {
              if (allEls[i].children.length === 0 && allEls[i].textContent.trim() === orderId) {
                orderEl = allEls[i]; break;
              }
            }
            if (!orderEl) {
              for (var i = 0; i < allEls.length; i++) {
                if (allEls[i].children.length <= 2 && allEls[i].textContent.indexOf(orderId) !== -1 && allEls[i].textContent.length < orderId.length + 30) {
                  orderEl = allEls[i]; break;
                }
              }
            }
            if (!orderEl) { result.logs.push('未找到订单号元素'); return result; }

            result.found = true;
            result.logs.push('找到订单号: ' + orderEl.tagName + '.' + gc(orderEl));

            var container = orderEl;
            var bestContainer = null;
            for (var up = 0; up < 20; up++) {
              container = container.parentElement;
              if (!container || container === document.body) break;
              var r = container.getBoundingClientRect();
              // 优先选择有card/order类名的元素
              var cls = gc(container);
              if ((cls.indexOf('card') !== -1 || cls.indexOf('order') !== -1 || cls.indexOf('item') !== -1) && r.width > 300 && r.height > 50 && r.height < 400) {
                bestContainer = container;
                result.logs.push('卡片级容器[' + up + ']: ' + cls.substring(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
                break;
              }
              // 通用条件：宽度够且高度合理（不超过500，避免选到页面级容器）
              if (r.width > 500 && r.height > 100 && r.height < 500 && !bestContainer) {
                bestContainer = container;
              }
            }
            var scope = bestContainer || container || document.body;
            result.logs.push('容器[' + up + ']: ' + scope.tagName + '.' + gc(scope).substring(0, 30) + ' ' + Math.round(scope.getBoundingClientRect().width) + 'x' + Math.round(scope.getBoundingClientRect().height));

            var iconArea = scope;
            var iconEls = iconArea.querySelectorAll('svg, i, span, div');
            var eyeEl = null;
            var candidates = [];

            for (var j = 0; j < iconEls.length; j++) {
              var ic = iconEls[j];
              var icCls = gc(ic);
              if (icCls.match(/copy|复制|shop-info-config|menu|tab|header|footer|arrow|close|search|nav/i)) continue;
              var icR = ic.getBoundingClientRect();
              if (icR.width < 8 || icR.width > 40 || icR.height < 8 || icR.height > 40) continue;
              var isIcon = (ic.tagName === 'SVG' || ic.tagName === 'svg' || ic.tagName === 'I' || ic.tagName === 'i' || icCls.indexOf('icon') !== -1 || (icR.width <= 24 && icR.height <= 24 && ic.children.length <= 3));
              if (!isIcon) continue;
              var dup = false;
              for (var dd = 0; dd < candidates.length; dd++) { if (candidates[dd] === ic) { dup = true; break; } }
              if (dup) continue;
              var icT = ic.title || ic.getAttribute('aria-label') || '';
              result.logs.push('候选[' + candidates.length + ']: ' + ic.tagName + ' ' + icCls.substring(0, 60) + ' t=' + icT + ' ' + Math.round(icR.width) + 'x' + Math.round(icR.height));
              candidates.push(ic);
            }

            result.logs.push('候选总数: ' + candidates.length);

            // 智能选择眼睛图标
            var eyeIcons = [];
            var consigneeEyeIcon = null;
            for (var p = 0; p < candidates.length; p++) {
              var pCls = gc(candidates[p]);
              if (pCls.indexOf('shop-adv-icon') !== -1) {
                if (pCls.match(/dong-dong|sticky-note|custom-icon|operate-icon/i)) {
                  result.logs.push('排除非眼睛: 候选[' + p + '] ' + pCls.substring(0, 50));
                  continue;
                }
                eyeIcons.push({ el: candidates[p], idx: p, cls: pCls });
                result.logs.push('眼睛候选: 候选[' + p + '] ' + pCls.substring(0, 50));
                // consignee-info 眼睛能获取完整信息（姓名+手机号+地址）
                if (pCls.indexOf('consignee-info') !== -1) {
                  consigneeEyeIcon = { el: candidates[p], idx: p, cls: pCls };
                  result.logs.push('收货人信息眼睛: 候选[' + p + '] (含手机号)');
                }
              }
            }

            result.logs.push('眼睛候选: ' + eyeIcons.length + '个');

            // 优先选第一个眼睛（eyeIcons[0]，带ml-8的是"后台"眼睛，能触发完整信息API）
            // consignee-info-pin-filt 眼睛只能获取手机号tooltip，不触发完整API
            if (eyeIcons.length >= 1) {
              eyeEl = eyeIcons[0].el;
              result.logs.push('选第一个眼睛(候选[' + eyeIcons[0].idx + ']) - 触发完整信息API');
            } else if (consigneeEyeIcon) {
              eyeEl = consigneeEyeIcon.el;
              result.logs.push('无shop-adv-icon眼睛，退而选收货人信息眼睛(候选[' + consigneeEyeIcon.idx + '])');
            } else if (candidates.length >= 1) {
              eyeEl = candidates[candidates.length - 1];
              result.logs.push('无眼睛候选，兜底选最后');
            }

            if (eyeEl) {
              result.logs.push('点击: ' + eyeEl.tagName + '.' + gc(eyeEl).substring(0, 60));
              eyeEl.click();
              result.clicked = true;
            } else {
              result.logs.push('未找到小眼睛');
            }

            } catch(err) {
              result.logs.push('JS错误: ' + err.message);
            }
            return result;
          })()
        `).catch(e => ({ found: false, clicked: false, logs: ['executeJS error: ' + e.message] }))

        console.log('[SalesFetch] [BuyerInfo] DOM查找结果:', JSON.stringify(clickResult))

        let sensitiveData = null
        let confirmResult = { confirmed: false, logs: [] }
        let quickResult = { buyerName: '', buyerPhone: '', buyerAddress: '' }

        if (clickResult.clicked) {
          // 轮询等待确认弹窗（加入京东自定义组件选择器，增加超时到8秒）
          const dialogReady = await pollUntil(
            () => tempWin.webContents.executeJavaScript(
              "!!(document.querySelector('[class*=\"dialog\"] [class*=\"primary\"]') || document.querySelector('.ant-modal .ant-btn-primary') || document.querySelector('[class*=\"Dialog\"] button') || document.querySelector('[class*=\"Msgbox\"] button') || (function(){var bs=document.querySelectorAll('button, [role=\"button\"]');for(var i=0;i<bs.length;i++){var t=bs[i].textContent.trim();var r=bs[i].getBoundingClientRect();if(t.length<=6&&r.width>0&&/^(确认|确定|同意|OK|绑定|获取|查看)$/.test(t))return true;}return false;})())"
            ),
            { timeout: 8000, interval: 400, label: '确认弹窗' }
          )
          if (!dialogReady) await new Promise(r => setTimeout(r, 1000))

          // 关键：在点击确认按钮之前，清空已有捕获并标记进入确认后阶段
          // 确认后阶段不排除任何API（queryOrderPage可能携带解密数据）
          await tempWin.webContents.executeJavaScript(`
            window.__sensitiveInfoResult = null;
            window.__bindVirtualNumberResult = null;
            window.__orderListResult = null;
            window.__sensitiveInfoLogs = [];
            window.__allCapturedResponses = [];
            window.__postConfirmPhase = true;
          `).catch(() => {})

          console.log('[SalesFetch] [BuyerInfo] 查找并点击确认弹窗...')
          confirmResult = await tempWin.webContents.executeJavaScript(`
            (function() {
              var result = { confirmed: false, logs: [] };

              // 先记录页面上所有可见弹窗/对话框元素
              var modals = document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="Dialog"], [class*="popover"], [class*="Popper"], [role="dialog"]');
              result.logs.push('页面弹窗元素数: ' + modals.length);

              // 优先策略：在包含"虚拟号"或"绑定"文字的弹窗中找"确定"按钮
              // 这是最精准的——京东的虚拟号绑定弹窗包含"点击确定则绑定虚拟号"等文字
              var allModals = document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="Dialog"], [class*="Msgbox"], [class*="msgbox"], [role="dialog"]');
              for (var m = 0; m < allModals.length; m++) {
                var modal = allModals[m];
                var mRect = modal.getBoundingClientRect();
                if (mRect.width < 100 || mRect.height < 30) continue;
                var modalText = (modal.innerText || '');
                // 检查弹窗文本是否包含虚拟号绑定相关内容
                if (modalText.indexOf('虚拟号') !== -1 || modalText.indexOf('绑定') !== -1 || modalText.indexOf('脱敏') !== -1) {
                  result.logs.push('找到虚拟号绑定弹窗: ' + modal.className.substring(0, 80) + ' textLen=' + modalText.length);
                  // 在弹窗内找"确定"按钮
                  var modalBtns = modal.querySelectorAll('button, [role="button"], [class*="btn"], [class*="primary"]');
                  for (var b = 0; b < modalBtns.length; b++) {
                    var btn = modalBtns[b];
                    var btnText = btn.textContent.trim();
                    var btnRect = btn.getBoundingClientRect();
                    if (btnRect.width > 0 && btnRect.height > 0) {
                      result.logs.push('弹窗按钮[' + b + ']: "' + btnText + '" cls=' + btn.className.substring(0, 60) + ' rect=' + Math.round(btnRect.width) + 'x' + Math.round(btnRect.height));
                      // 优先点击"确定"按钮
                      if (/^(确定|确认|绑定|OK|Confirm)$/.test(btnText)) {
                        result.logs.push('点击虚拟号弹窗确定按钮: "' + btnText + '"');
                        btn.click();
                        result.confirmed = true;
                        break;
                      }
                    }
                  }
                  if (result.confirmed) break;
                  // 如果没找到"确定"文本按钮，点击弹窗内的primary按钮（第一个）
                  var primaryBtns = modal.querySelectorAll('[class*="primary"]');
                  for (var p = 0; p < primaryBtns.length; p++) {
                    var pBtn = primaryBtns[p];
                    var pRect = pBtn.getBoundingClientRect();
                    if (pRect.width > 0 && pRect.height > 0) {
                      var pText = pBtn.textContent.trim();
                      if (!/^(取消|Cancel|关闭|Close|拒绝)$/.test(pText)) {
                        result.logs.push('点击虚拟号弹窗primary按钮: "' + pText + '"');
                        pBtn.click();
                        result.confirmed = true;
                        break;
                      }
                    }
                  }
                  if (result.confirmed) break;
                }
              }

              // 方法1a：标准UI库选择器（如果上面没找到虚拟号弹窗）
              if (!result.confirmed) {
                '.ant-modal .ant-btn-primary',
                '.ant-modal-confirm-btns .ant-btn-primary',
                '.el-message-box__btns .el-button--primary',
                '.el-dialog .el-button--primary',
                '[class*="modal"] [class*="primary"]',
                '[class*="dialog"] [class*="primary"]',
                '[class*="Dialog"] [class*="primary"]',
                // 京东自定义组件选择器
                '.jd-modal .jd-btn--primary',
                '.jd-dialog .jd-btn--primary',
                '.jd-message-box .jd-btn--primary',
                '[class*="jd-modal"] [class*="primary"]',
                '[class*="jd-dialog"] [class*="primary"]',
                '[class*="Msgbox"] button',
                '[class*="msgbox"] button'
              ];
              for (var i = 0; i < selectors.length; i++) {
                var btns = document.querySelectorAll(selectors[i]);
                if (btns.length > 0) {
                  result.logs.push('找到确认按钮: selector=' + selectors[i] + ' count=' + btns.length);
                  var btn = btns[btns.length - 1];
                  result.logs.push('按钮文本: ' + btn.textContent.trim());
                  btn.click();
                  result.confirmed = true;
                  break;
                }
              }

              // 方法2：通过按钮文本查找（最可靠的方式）
              if (!result.confirmed) {
                var allBtns = document.querySelectorAll('button, [role="button"], [class*="btn"]');
                var confirmTexts = /^(确认|确定|同意|OK|Confirm|我已阅读|绑定|获取|查看|立即)$/;
                for (var i = 0; i < allBtns.length; i++) {
                  var text = allBtns[i].textContent.trim();
                  // 只匹配短文本（避免匹配到包含这些字的导航按钮）
                  if (text.length <= 6 && confirmTexts.test(text)) {
                    var rect = allBtns[i].getBoundingClientRect();
                    // 按钮必须可见
                    if (rect.width > 0 && rect.height > 0) {
                      result.logs.push('通过文本确认: "' + text + '" rect=' + Math.round(rect.width) + 'x' + Math.round(rect.height));
                      allBtns[i].click();
                      result.confirmed = true;
                      break;
                    }
                  }
                }
              }

              // 方法3：查找弹窗内的第一个可见按钮（兜底）
              if (!result.confirmed && modals.length > 0) {
                for (var m = 0; m < modals.length; m++) {
                  var modal = modals[m];
                  var rect = modal.getBoundingClientRect();
                  if (rect.width < 100 || rect.height < 50) continue;
                  var modalBtns = modal.querySelectorAll('button, [role="button"]');
                  result.logs.push('弹窗[' + m + ']: ' + modal.className.substring(0, 60) + ' 按钮数=' + modalBtns.length);
                  // 优先点击最后一个按钮（通常是"确认"）
                  for (var b = modalBtns.length - 1; b >= 0; b--) {
                    var btnRect = modalBtns[b].getBoundingClientRect();
                    var btnText = modalBtns[b].textContent.trim();
                    if (btnRect.width > 0 && btnRect.height > 0 && btnText.length <= 10) {
                      // 跳过"取消"按钮
                      if (/^(取消|Cancel|关闭|Close|拒绝)$/.test(btnText)) continue;
                      result.logs.push('弹窗内点击: "' + btnText + '"');
                      modalBtns[b].click();
                      result.confirmed = true;
                      break;
                    }
                  }
                  if (result.confirmed) break;
                }
              }

              if (!result.confirmed) result.logs.push('未找到确认弹窗按钮');
              return result;
            })()
          `).catch(e => ({ confirmed: false, logs: ['error: ' + e.message] }))

          console.log('[SalesFetch] [BuyerInfo] 确认弹窗结果:', JSON.stringify(confirmResult))

          // ====== 核心策略：直接从页面上下文调用 bindVirtualNumber API ======
          // 之前的点击确定按钮方式不可靠（webRequest检测确认请求未发出）
          // 改为直接调用API：从已拦截的 getSensitiveInfo 请求中获取格式，直接 fetch bindVirtualNumber
          console.log('[SalesFetch] [BuyerInfo] 直接调用bindVirtualNumber API...')

          // 读取 getSensitiveInfo 的完整请求信息
          const capturedReqInfo = await tempWin.webContents.executeJavaScript(`
            (function() {
              return {
                body: window.__sensitiveInfoRequestBody || '',
                headers: window.__sensitiveInfoRequestHeaders || '',
                url: window.__sensitiveInfoRequestUrl || '',
                method: window.__sensitiveInfoRequestMethod || 'POST'
              };
            })()
          `).catch(() => ({ body: '', headers: '', url: '', method: 'POST' }))

          if (capturedReqInfo.body) {
            console.log('[SalesFetch] [BuyerInfo] 捕获到getSensitiveInfo请求: method=' + capturedReqInfo.method + ' url=' + capturedReqInfo.url.substring(0, 100) + ' headers=' + capturedReqInfo.headers.substring(0, 200))

            // 从请求信息构造 bindVirtualNumber 的请求
            // 使用与 getSensitiveInfo 完全相同的 URL、headers、method，只替换 API 名
            const bindVnResult = await tempWin.webContents.executeJavaScript(`
              (function() {
                return new Promise(function(resolve) {
                  var reqBody = ${JSON.stringify(capturedReqInfo.body)};
                  var reqHeaders = ${JSON.stringify(capturedReqInfo.headers)};
                  var reqMethod = ${JSON.stringify(capturedReqInfo.method)};
                  var sffUrl = ${JSON.stringify(capturedReqInfo.url)};

                  // 替换URL中的API名: getSensitiveInfo -> bindVirtualNumber
                  var bindVnUrl = sffUrl ? sffUrl.replace('getSensitiveInfo', 'bindVirtualNumber') : '';

                  // 如果URL中没有getSensitiveInfo（不太可能），构造默认URL
                  if (!bindVnUrl || bindVnUrl === sffUrl) {
                    bindVnUrl = 'https://sff.jd.com/api?v=1.0&appId=COCX0HBWR4BA7RDVDBIQ&api=dsm.order.bff.orderSensitiveInfoBffService.bindVirtualNumber';
                  }

                  // 构造请求选项：使用相同的method、headers、credentials
                  var fetchOpts = {
                    method: reqMethod || 'POST',
                    credentials: 'include',
                    headers: {}
                  };

                  // 复制原始请求头（包括CSRF令牌等安全头）
                  try {
                    var origHeaders = JSON.parse(reqHeaders);
                    for (var k in origHeaders) {
                      if (origHeaders.hasOwnProperty(k)) {
                        fetchOpts.headers[k] = origHeaders[k];
                      }
                    }
                  } catch(e) {}

                  // 确保有Content-Type
                  if (!fetchOpts.headers['Content-Type'] && !fetchOpts.headers['content-type']) {
                    fetchOpts.headers['Content-Type'] = 'application/json';
                  }

                  // 使用相同的请求体格式
                  try {
                    var bodyObj = JSON.parse(reqBody);
                    fetchOpts.body = JSON.stringify(bodyObj);
                  } catch(e) {
                    fetchOpts.body = reqBody;
                  }

                  console.log('[BuyerInfo] 直接调用bindVirtualNumber:', bindVnUrl.substring(0, 150));
                  console.log('[BuyerInfo] 请求头:', JSON.stringify(fetchOpts.headers).substring(0, 300));
                  fetch(bindVnUrl, fetchOpts).then(function(resp) {
                    return resp.json();
                  }).then(function(data) {
                    console.log('[BuyerInfo] bindVirtualNumber响应:', JSON.stringify(data).substring(0, 500));
                    resolve(data);
                  }).catch(function(err) {
                    console.log('[BuyerInfo] bindVirtualNumber调用失败:', err.message);
                    resolve(null);
                  });
                });
              })()
            `).catch(() => null)

            if (bindVnResult && bindVnResult.code === 200 && bindVnResult.data) {
              const vnData = bindVnResult.data
              console.log('[SalesFetch] [BuyerInfo] bindVirtualNumber 直接调用成功:', JSON.stringify(vnData).substring(0, 500))
              const vnName = vnData.name || ''
              const vnAddress = vnData.address || ''
              const vnPhone = vnData.virtualNumber || ''

              // 从 name 中提取分机号
              let extension = ''
              let pureName = vnName
              const nameExtMatch = vnName.match(/^(.+)\[(\d{3,6})\]$/)
              if (nameExtMatch) {
                pureName = nameExtMatch[1]
                extension = nameExtMatch[2]
              }
              let pureAddress = vnAddress
              const addrExtMatch = vnAddress.match(/^(.+)\[(\d{3,6})\]$/)
              if (addrExtMatch) {
                pureAddress = addrExtMatch[1]
                if (!extension) extension = addrExtMatch[2]
              }

              let finalPhone = vnPhone
              if (extension && finalPhone && finalPhone.indexOf('-') === -1) {
                finalPhone = finalPhone + '-' + extension
              }

              quickResult = {
                buyerName: pureName,
                buyerPhone: finalPhone,
                buyerAddress: pureAddress
              }

              console.log('[SalesFetch] [BuyerInfo] bindVirtualNumber提取完成: name=' + pureName + ' phone=' + finalPhone + ' addr=' + pureAddress.substring(0, 30) + ' ext=' + extension)
              saveDebugLog({
                timestamp: new Date().toISOString(),
                storeId, orderId,
                phase: 'bindVirtualNumber-direct-success',
                vnData: { name: vnName, address: vnAddress, virtualNumber: vnPhone, extension },
                quickResult
              })

              // 如果首次绑定成功但没有分机号，等待1秒后再次调用获取分机号
              // 京东流程：首次bindVirtualNumber只绑定虚拟号不含分机号，二次调用才有分机号
              if (!extension && vnPhone) {
                console.log('[SalesFetch] [BuyerInfo] 首次绑定无分机号，等待1秒后再次调用获取分机号...')
                await new Promise(r => setTimeout(r, 1000))

                const bindVnResult2 = await tempWin.webContents.executeJavaScript(`
                  (function() {
                    return new Promise(function(resolve) {
                      var reqBody = ${JSON.stringify(capturedReqInfo.body)};
                      var reqHeaders = ${JSON.stringify(capturedReqInfo.headers)};
                      var reqMethod = ${JSON.stringify(capturedReqInfo.method)};
                      var sffUrl = ${JSON.stringify(capturedReqInfo.url)};
                      var bindVnUrl = sffUrl ? sffUrl.replace('getSensitiveInfo', 'bindVirtualNumber') : '';
                      if (!bindVnUrl || bindVnUrl === sffUrl) {
                        bindVnUrl = 'https://sff.jd.com/api?v=1.0&appId=COCX0HBWR4BA7RDVDBIQ&api=dsm.order.bff.orderSensitiveInfoBffService.bindVirtualNumber';
                      }
                      var fetchOpts = { method: reqMethod || 'POST', credentials: 'include', headers: {} };
                      try { var h = JSON.parse(reqHeaders); for (var k in h) { if (h.hasOwnProperty(k)) fetchOpts.headers[k] = h[k]; } } catch(e) {}
                      if (!fetchOpts.headers['Content-Type'] && !fetchOpts.headers['content-type']) fetchOpts.headers['Content-Type'] = 'application/json';
                      try { fetchOpts.body = JSON.stringify(JSON.parse(reqBody)); } catch(e) { fetchOpts.body = reqBody; }
                      fetch(bindVnUrl, fetchOpts).then(function(r) { return r.json(); }).then(resolve).catch(function() { resolve(null); });
                    });
                  })()
                `).catch(() => null)

                if (bindVnResult2 && bindVnResult2.code === 200 && bindVnResult2.data) {
                  const vnData2 = bindVnResult2.data
                  const vnName2 = vnData2.name || ''
                  const vnAddr2 = vnData2.address || ''
                  const vnPhone2 = vnData2.virtualNumber || vnPhone

                  // 提取分机号
                  let ext2 = ''
                  let pureName2 = vnName2
                  const m2 = vnName2.match(/^(.+)\[(\d{3,6})\]$/)
                  if (m2) { pureName2 = m2[1]; ext2 = m2[2]; }
                  let pureAddr2 = vnAddr2
                  const a2 = vnAddr2.match(/^(.+)\[(\d{3,6})\]$/)
                  if (a2) { pureAddr2 = a2[1]; if (!ext2) ext2 = a2[2]; }

                  if (ext2) {
                    extension = ext2
                    let phone2 = vnPhone2 || vnPhone
                    if (phone2 && phone2.indexOf('-') === -1) phone2 = phone2 + '-' + ext2
                    quickResult = {
                      buyerName: pureName2 || pureName,
                      buyerPhone: phone2,
                      buyerAddress: pureAddr2 || pureAddress
                    }
                    console.log('[SalesFetch] [BuyerInfo] 二次调用获取分机号成功: ext=' + ext2 + ' phone=' + phone2)
                    saveDebugLog({
                      timestamp: new Date().toISOString(),
                      storeId, orderId,
                      phase: 'bindVirtualNumber-2nd-success',
                      vnData2: { name: vnName2, address: vnAddr2, virtualNumber: vnPhone2, extension: ext2 },
                      quickResult
                    })
                  }
                }
              }

              if (quickResult.buyerName && quickResult.buyerPhone && quickResult.buyerAddress) {
                return { success: true, data: quickResult }
              }
            } else {
              console.log('[SalesFetch] [BuyerInfo] bindVirtualNumber直接调用失败:', JSON.stringify(bindVnResult || 'null').substring(0, 300))
              saveDebugLog({
                timestamp: new Date().toISOString(),
                storeId, orderId,
                phase: 'bindVirtualNumber-direct-failed',
                capturedReqInfo: {
                  method: capturedReqInfo.method,
                  url: capturedReqInfo.url.substring(0, 300),
                  headers: capturedReqInfo.headers.substring(0, 500),
                  body: capturedReqInfo.body.substring(0, 500)
                },
                bindVnResult: bindVnResult ? JSON.stringify(bindVnResult).substring(0, 500) : 'null'
              })
            }
          } else {
            console.log('[SalesFetch] [BuyerInfo] 未捕获到getSensitiveInfo请求体，无法直接调用bindVirtualNumber')
          }

          // 确认后等待页面更新（京东虚拟号绑定需要时间）
          await new Promise(r => setTimeout(r, 1500))

          // ====== 优先等待 bindVirtualNumber API 响应 ======
          // 点击确认后，京东会调用 bindVirtualNumber API，返回完整信息：
          //   name: "苏宝宝[4740]", address: "江苏宿迁市沭阳县...[4740]", virtualNumber: "17804435187"
          // 这是最可靠的数据来源，优先于DOM提取
          console.log('[SalesFetch] [BuyerInfo] 等待 bindVirtualNumber API响应...')
          let bindVnResult = await pollUntil(
            () => tempWin.webContents.executeJavaScript('window.__bindVirtualNumberResult').catch(() => null),
            { timeout: 10000, interval: 500, label: 'bindVirtualNumber' }
          )
          if (!bindVnResult) {
            bindVnResult = await tempWin.webContents.executeJavaScript('window.__bindVirtualNumberResult').catch(() => null)
          }

          if (bindVnResult && bindVnResult.data) {
            const vnData = bindVnResult.data
            console.log('[SalesFetch] [BuyerInfo] bindVirtualNumber 响应获取成功:', JSON.stringify(vnData).substring(0, 500))
            // 直接从 bindVirtualNumber 响应提取完整信息
            const vnName = vnData.name || ''        // "苏宝宝[4740]"
            const vnAddress = vnData.address || ''  // "江苏宿迁市沭阳县南湖街道-皇冠·世纪花园2-1-2701号.[4740]"
            const vnPhone = vnData.virtualNumber || ''  // "17804435187"

            // 从 name 中提取分机号
            let extension = ''
            let pureName = vnName
            const nameExtMatch = vnName.match(/^(.+)\[(\d{3,6})\]$/)
            if (nameExtMatch) {
              pureName = nameExtMatch[1]
              extension = nameExtMatch[2]
            }
            // 从 address 中提取分机号（如果 name 中没提取到）
            let pureAddress = vnAddress
            if (!extension) {
              const addrExtMatch = vnAddress.match(/^(.+)\[(\d{3,6})\]$/)
              if (addrExtMatch) {
                pureAddress = addrExtMatch[1]
                extension = addrExtMatch[2]
              }
            } else {
              // 地址中的分机号也要剥离
              const addrExtMatch = vnAddress.match(/^(.+)\[(\d{3,6})\]$/)
              if (addrExtMatch) {
                pureAddress = addrExtMatch[1]
              }
            }

            // 组装结果：手机号格式为 "虚拟号-分机号"
            let finalPhone = vnPhone
            if (extension && finalPhone && finalPhone.indexOf('-') === -1) {
              finalPhone = finalPhone + '-' + extension
            }

            quickResult = {
              buyerName: pureName,
              buyerPhone: finalPhone,
              buyerAddress: pureAddress
            }

            console.log('[SalesFetch] [BuyerInfo] bindVirtualNumber 直接提取完成: name=' + pureName + ' phone=' + finalPhone + ' addr=' + pureAddress.substring(0, 30) + ' ext=' + extension)
            saveDebugLog({
              timestamp: new Date().toISOString(),
              storeId, orderId,
              phase: 'bindVirtualNumber-success',
              vnData: { name: vnName, address: vnAddress, virtualNumber: vnPhone, extension },
              quickResult
            })

            // 如果三个字段齐全，直接返回
            if (quickResult.buyerName && quickResult.buyerPhone && quickResult.buyerAddress) {
              return { success: true, data: quickResult }
            }
            // 否则继续后续提取作为补充
          } else {
            console.log('[SalesFetch] [BuyerInfo] bindVirtualNumber 未拦截到，继续其他方式提取')
            // 诊断：捕获拦截器状态，了解为什么 bindVirtualNumber 没被拦截
            const interceptDiag = await tempWin.webContents.executeJavaScript(`
              (function() {
                return {
                  captureEnabled: window.__captureEnabled,
                  postConfirmPhase: window.__postConfirmPhase,
                  sensitiveInfoResult: window.__sensitiveInfoResult ? 'exists' : 'null',
                  bindVirtualNumberResult: window.__bindVirtualNumberResult ? 'exists' : 'null',
                  interceptorInstalled: window.__sffInterceptorInstalled,
                  logs: (window.__sensitiveInfoLogs || []).slice(-30),
                  capturedUrls: (window.__allCapturedResponses || []).map(function(r) {
                    return r.url.substring(0, 200) + ' len=' + (r.body || '').length;
                  })
                };
              })()
            `).catch(() => ({}))
            saveDebugLog({
              timestamp: new Date().toISOString(),
              storeId, orderId,
              phase: 'bindVirtualNumber-missing',
              webRequestDetected: bindVnRequestDetected,
              interceptDiag
            })
          }

          // ====== 快速提取阶段（在tooltip消失前立即读取） ======
          console.log('[SalesFetch] [BuyerInfo] 快速提取阶段...')

          // 快速DOM读取：立即查找tooltip/popover中的买家信息
          const quickDomResult = await tempWin.webContents.executeJavaScript(`
            (function() {
              var result = { name: '', phone: '', address: '', logs: [] };
              var orderId = ${JSON.stringify(String(orderId))};

              // 查找所有弹出层/tooltip
              var popovers = document.querySelectorAll('[class*="popover"], [class*="tooltip"], [class*="popper"], [class*="modal"], [class*="dialog"], [class*="consignee"], [class*="sensitive"], [class*="decrypt"], [class*="buyer"], [class*="contact"]');
              var extension = '';
              for (var i = 0; i < popovers.length; i++) {
                var el = popovers[i];
                var rect = el.getBoundingClientRect();
                if (rect.width < 10 || rect.height < 10) continue;
                var text = (el.innerText || '').trim();
                if (text.length < 5) continue;
                // 匹配手机号（含虚拟号格式 主号-分机号），排除订单号子串
                var phoneMatch = text.match(/(1[3-9]\\d{9}(?:-\\d{1,6})?)/);
                if (phoneMatch && orderId.indexOf(phoneMatch[1]) !== -1) {
                  result.logs.push('跳过订单号子串: ' + phoneMatch[1]);
                  phoneMatch = null;
                }
                if (phoneMatch) {
                  result.phone = phoneMatch[1];
                  result.logs.push('快速命中: ' + el.className.substring(0, 60) + ' text=' + text.substring(0, 200));
                  var lines = text.split(/[\\n\\r]+/);
                  for (var j = 0; j < lines.length; j++) {
                    var line = lines[j].trim();
                    // 提取[XXXX]分机号（虚拟号格式，姓名/地址后面会带）
                    if (!extension) {
                      var extMatch = line.match(/\\[(\\d{3,6})\\]$/);
                      if (extMatch) {
                        extension = extMatch[1];
                        result.logs.push('提取到分机号: [' + extension + ']');
                      }
                    }
                    // 姓名：支持带分机号格式如"苏宝宝[5008]"
                    if (!result.name && line.length >= 2 && line.length <= 14) {
                      var nameExtMatch = line.match(/^([\\u4e00-\\u9fa5·\\*]+)\\[(\\d{3,6})\\]$/);
                      if (nameExtMatch) {
                        result.name = nameExtMatch[1];
                        if (!extension) extension = nameExtMatch[2];
                        result.logs.push('姓名(含分机号): ' + result.name + ' ext=' + nameExtMatch[2]);
                      } else if (line.length <= 8 && /^[\\u4e00-\\u9fa5·]+$/.test(line)) {
                        if (!/^(确认|取消|查看|虚拟|收货|地址|手机|电话|说明|绑定|点击|使用|有效|收件|联系|复制|订单|快递|录入|短信|模板|分机|保护|安全)$/.test(line)) {
                          result.name = line;
                        }
                      }
                    }
                    // 地址：支持带分机号格式，包含省/市关键词，剥离[XXXX]
                    if (!result.address && line.length >= 8) {
                      var addrClean = line.replace(/\\[\\d{3,6}\\]$/, '').trim();
                      if (/(?:北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)/.test(addrClean) && addrClean.indexOf('*') === -1 && addrClean.indexOf('截流') === -1) {
                        result.address = addrClean;
                      }
                    }
                  }
                  // 如果有分机号且手机号还没带分机号，追加
                  if (extension && result.phone && result.phone.indexOf('-') === -1) {
                    result.phone = result.phone + '-' + extension;
                    result.logs.push('手机号追加分机号: ' + result.phone);
                  }
                  break;
                }
              }

              // 查找订单卡片容器中的信息
              if (!result.name || !result.address || !result.phone) {
                var allEls = document.querySelectorAll('*');
                var orderEl = null;
                for (var i = 0; i < allEls.length; i++) {
                  if (allEls[i].children.length === 0 && allEls[i].textContent.trim() === orderId) {
                    orderEl = allEls[i]; break;
                  }
                }
                if (orderEl) {
                  var container = orderEl;
                  for (var up = 0; up < 15; up++) {
                    container = container.parentElement;
                    if (!container || container === document.body) break;
                    var r = container.getBoundingClientRect();
                    if (r.width > 500 && r.height > 80) break;
                  }
                  if (container && container !== document.body) {
                    var containerText = container.innerText || '';
                    result.logs.push('容器文本长度: ' + containerText.length);
                    if (!result.phone) {
                      var p = containerText.match(/(1[3-9]\\d{9}(?:-\\d{1,6})?)/);
                      if (p && orderId.indexOf(p[1]) === -1) result.phone = p[1];
                    }
                    if (!result.address) {
                      var a = containerText.match(/((?:北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)[^\\n*]{5,80}?)(?:\\n|$)/);
                      if (a && a[1].indexOf('*') === -1 && a[1].indexOf('截流') === -1) result.address = a[1].trim();
                    }
                    if (!result.name) {
                      var n = containerText.match(/(?:收货人|姓名|买家|收件人)[:：\\s]*([\\u4e00-\\u9fa5a-zA-Z·]{2,10})/);
                      if (n) result.name = n[1];
                    }
                  }
                }
              }

              // 全页面搜索手机号文本节点
              if (!result.phone) {
                var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
                var node;
                while (node = walker.nextNode()) {
                  var t = node.textContent.trim();
                  if (t.length >= 7 && t.length <= 20) {
                    var pm = t.match(/^(1[3-9]\\d{9}(?:-\\d{1,6})?)$/);
                    if (pm) {
                      result.phone = pm[1];
                      result.logs.push('文本节点命中: ' + pm[1]);
                      break;
                    }
                  }
                }
              }

              // 去除手机号 _p 后缀
              if (result.phone && result.phone.indexOf('_') !== -1) {
                result.phone = result.phone.replace(/_[a-zA-Z]+$/, '');
              }
              result.logs.push('快速DOM: name=' + (result.name||'空') + ' phone=' + (result.phone||'空') + ' addr=' + (result.address ? result.address.substring(0,30) : '空'));
              return result;
            })()
          `).catch(e => ({ name: '', phone: '', address: '', logs: ['error: ' + e.message] }))
          console.log('[SalesFetch] [BuyerInfo] 快速DOM结果:', JSON.stringify(quickDomResult))

          // 读取 __orderListResult（拦截器始终捕获queryOrderPage）
          let quickApiResult = null
          const orderListResult = await tempWin.webContents.executeJavaScript('window.__orderListResult || null').catch(() => null)
          if (orderListResult) {
            console.log('[SalesFetch] [BuyerInfo] 从__orderListResult提取...')
            const parsed = parseSensitiveInfo(orderListResult, orderId)
            if (parsed) {
              quickApiResult = parsed
              console.log('[SalesFetch] [BuyerInfo] __orderListResult: name=' + (parsed.buyerName||'(空)') + ' phone=' + (parsed.buyerPhone||'(空)') + ' addr=' + (parsed.buyerAddress||'(空)').substring(0,30))
            }
          }

          // 读取 __capturedResponses（主页拦截器）中的queryOrderPage
          if (!quickApiResult || (!quickApiResult.buyerName && !quickApiResult.buyerAddress)) {
            const mainResponses = await tempWin.webContents.executeJavaScript('window.__capturedResponses || []').catch(() => [])
            for (const resp of mainResponses) {
              const url = (resp.url || '')
              if (url.indexOf('queryOrderPage') !== -1 || url.indexOf('queryOrderList') !== -1) {
                const body = resp.body || ''
                if (body.indexOf(String(orderId)) !== -1) {
                  try {
                    const json = JSON.parse(body)
                    const parsed = parseSensitiveInfo(json, orderId)
                    if (parsed && (parsed.buyerName || parsed.buyerAddress)) {
                      quickApiResult = parsed
                      console.log('[SalesFetch] [BuyerInfo] 从主页拦截器提取: name=' + (parsed.buyerName||'(空)') + ' phone=' + (parsed.buyerPhone||'(空)'))
                      break
                    }
                  } catch (e) {}
                }
              }
            }
          }

          // 合并快速结果（bindVirtualNumber优先，DOM提取补充，API最后补充）
          // 注意：如果 bindVirtualNumber 已经提供了完整数据，quickResult 已有值，不应被覆盖
          var mergedName = quickResult.buyerName || (quickDomResult.name) || (quickApiResult && quickApiResult.buyerName) || '';
          var mergedPhone = quickResult.buyerPhone || (quickDomResult.phone) || (quickApiResult && quickApiResult.buyerPhone && quickApiResult.buyerPhone.indexOf('*') === -1 ? quickApiResult.buyerPhone : '') || '';
          var mergedAddress = quickResult.buyerAddress || (quickDomResult.address) || (quickApiResult && quickApiResult.buyerAddress) || '';
          quickResult = {
            buyerName: mergedName,
            buyerPhone: mergedPhone,
            buyerAddress: mergedAddress
          }
          console.log('[SalesFetch] [BuyerInfo] 快速合并: name=' + quickResult.buyerName + ' phone=' + quickResult.buyerPhone + ' addr=' + (quickResult.buyerAddress||'').substring(0,30))

          // 如果快速提取三个字段齐全，直接返回
          if (quickResult.buyerName && quickResult.buyerPhone && quickResult.buyerAddress) {
            console.log('[SalesFetch] [BuyerInfo] 快速提取完成，三个字段齐全')
            saveDebugLog({ timestamp: new Date().toISOString(), storeId, orderId, phase: 'buyer-info-quick-success', quickDomResult, quickApiResult, quickResult })
            return { success: true, data: quickResult }
          }

          // 继续API拦截（等待更完整的API响应）
          await new Promise(r => setTimeout(r, 500))

          // 方案1a：API拦截（等待专用买家信息API响应）
          const apiReady = await pollUntil(
            () => tempWin.webContents.executeJavaScript('window.__sensitiveInfoResult').catch(() => null),
            { timeout: 8000, interval: 500, label: 'API响应' }
          )

          const interceptedResult = apiReady || await tempWin.webContents.executeJavaScript('window.__sensitiveInfoResult').catch(() => null)
          const interceptLogs = await tempWin.webContents.executeJavaScript('window.__sensitiveInfoLogs || []').catch(() => [])

          if (interceptLogs.length > 0) {
            console.log('[SalesFetch] [BuyerInfo] 拦截器日志:', interceptLogs.join(' | '))
          }

          if (interceptedResult) {
            console.log('[SalesFetch] [BuyerInfo] 拦截到API响应:', JSON.stringify(interceptedResult).substring(0, 800))
            sensitiveData = interceptedResult
          }

          // API拦截成功后，轮询DOM等待订单卡片更新（含虚拟号+分机号）
          // 截图显示：获取后卡片收货人信息变为 "苏宝宝[5785]"、"地址[5785]"、"17851740971"
          if (sensitiveData) {
            console.log('[SalesFetch] [BuyerInfo] API拦截成功，轮询DOM等待虚拟号+分机号更新...')

            // 来源1：重新读取 __orderListResult（绑定虚拟号后前端可能刷新了订单列表）
            const updatedOrderList = await tempWin.webContents.executeJavaScript('window.__orderListResult || null').catch(() => null)
            if (updatedOrderList) {
              const updatedParsed = parseSensitiveInfo(updatedOrderList, orderId)
              if (updatedParsed && updatedParsed.buyerPhone && updatedParsed.buyerPhone.indexOf('*') === -1) {
                console.log('[SalesFetch] [BuyerInfo] 更新后订单列表: phone=' + updatedParsed.buyerPhone)
                quickResult.buyerPhone = updatedParsed.buyerPhone
              }
            }

            // 来源2：轮询DOM提取（最多5次，每次间隔2秒，等待前端更新订单卡片）
            for (let pollIdx = 0; pollIdx < 5; pollIdx++) {
              await new Promise(r => setTimeout(r, 2000))
              const domResult = await tempWin.webContents.executeJavaScript(`
                (function() {
                  var result = { name: '', phone: '', extension: '', address: '', logs: [] };
                  var orderId = ${JSON.stringify(String(orderId))};

                  // 找到包含此订单号的订单卡片容器
                  var allEls = document.querySelectorAll('*');
                  var cardEl = null;
                  for (var i = 0; i < allEls.length; i++) {
                    if (allEls[i].children.length === 0 && allEls[i].textContent.trim() === orderId) {
                      var c = allEls[i];
                      for (var up = 0; up < 20; up++) {
                        c = c.parentElement;
                        if (!c || c === document.body) break;
                        var r = c.getBoundingClientRect();
                        if (r.width > 300 && r.height > 80) { cardEl = c; break; }
                      }
                      if (cardEl) break;
                    }
                  }

                  if (!cardEl) {
                    result.logs.push('未找到订单卡片');
                    return result;
                  }

                  var cardText = (cardEl.innerText || '').trim();
                  result.logs.push('卡片文本长度: ' + cardText.length);

                  // 提取虚拟号手机号（11位完整号码，非脱敏，排除订单号子串）
                  var phoneM = cardText.match(/(1[3-9]\\d{9})/);
                  if (phoneM && orderId.indexOf(phoneM[1]) !== -1) {
                    result.logs.push('跳过订单号子串: ' + phoneM[1]);
                    phoneM = null;
                  }
                  if (phoneM) {
                    result.phone = phoneM[1];
                    result.logs.push('虚拟号: ' + phoneM[1]);
                  }

                  // 提取分机号：匹配 姓名[XXXX] 或 地址[XXXX] 格式（4位数字）
                  // 搜索卡片内所有文本节点
                  var walker = document.createTreeWalker(cardEl, NodeFilter.SHOW_TEXT, null, false);
                  var node;
                  var allTextParts = [];
                  while (node = walker.nextNode()) {
                    var t = node.textContent.trim();
                    if (t) allTextParts.push(t);
                  }
                  var fullText = allTextParts.join(' ');
                  result.logs.push('文本节点数: ' + allTextParts.length);

                  // 从文本节点中匹配 姓名[XXXX] 格式
                  for (var i = 0; i < allTextParts.length; i++) {
                    var part = allTextParts[i];
                    // 匹配 "苏宝宝[5785]" 格式
                    var nameExtM = part.match(/([\\u4e00-\\u9fa5·\\*]+)\\[(\\d{4})\\]/);
                    if (nameExtM) {
                      result.name = nameExtM[1];
                      result.extension = nameExtM[2];
                      result.logs.push('姓名+分机号: ' + nameExtM[1] + ' [' + nameExtM[2] + ']');
                    }
                    // 匹配纯 [XXXX] 格式（4位数字，排除0618示例）
                    if (!result.extension) {
                      var extM = part.match(/^\\[(\\d{4})\\]$/);
                      if (extM && extM[1] !== '0618') {
                        result.extension = extM[1];
                        result.logs.push('纯分机号: [' + extM[1] + ']');
                      }
                    }
                    // 匹配地址[XXXX]格式
                    if (!result.address) {
                      var addrExtM = part.match(/(.{5,}?)\\[(\\d{4})\\]$/);
                      if (addrExtM && /(?:北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)/.test(addrExtM[1])) {
                        result.address = addrExtM[1];
                        if (!result.extension) result.extension = addrExtM[2];
                        result.logs.push('地址+分机号: ' + addrExtM[1].substring(0, 30) + ' [' + addrExtM[2] + ']');
                      }
                    }
                  }

                  // 也用fullText整段匹配
                  if (!result.extension) {
                    // 匹配 "姓名[XXXX]" 在完整文本中
                    var ftNameExt = fullText.match(/[\\u4e00-\\u9fa5·\\*]{2,10}\\[(\\d{4})\\]/);
                    if (ftNameExt && ftNameExt[1] !== '0618') {
                      result.extension = ftNameExt[1];
                      result.logs.push('整段匹配分机号: [' + ftNameExt[1] + ']');
                    }
                  }
                  if (!result.name && result.extension) {
                    var ftName = fullText.match(/([\\u4e00-\\u9fa5·]+)\\[\\d{4}\\]/);
                    if (ftName) result.name = ftName[1];
                  }
                  if (!result.address && result.extension) {
                    var ftAddr = fullText.match(/((?:北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)[^\\[]*?)\\[\\d{4}\\]/);
                    if (ftAddr) result.address = ftAddr[1].trim();
                  }

                  result.logs.push('结果: name=' + (result.name||'空') + ' phone=' + (result.phone||'空') + ' ext=[' + (result.extension||'空') + '] addr=' + (result.address ? result.address.substring(0,20) : '空'));
                  // 调试文本（前3000字符）
                  result._debugText = cardText.substring(0, 3000);
                  return result;
                })()
              `).catch(e => ({ name: '', phone: '', extension: '', address: '', logs: ['error: ' + e.message], _debugText: '' }))

              console.log('[SalesFetch] [BuyerInfo] DOM轮询第' + (pollIdx + 1) + '次:', JSON.stringify(domResult).substring(0, 800))

              if (domResult.extension || (domResult.phone && domResult.phone.indexOf('*') === -1)) {
                // 找到了虚拟号或分机号
                if (domResult.phone && domResult.phone.indexOf('*') === -1) {
                  quickResult.buyerPhone = domResult.phone
                }
                if (domResult.name) quickResult.buyerName = domResult.name
                if (domResult.address) quickResult.buyerAddress = domResult.address
                if (domResult.extension) quickResult._extension = domResult.extension
                // 保存调试日志
                saveDebugLog({
                  timestamp: new Date().toISOString(),
                  storeId, orderId,
                  phase: 'extension-found-poll' + (pollIdx + 1),
                  domResult: { name: domResult.name, phone: domResult.phone, extension: domResult.extension, logs: domResult.logs },
                  debugTextPreview: (domResult._debugText || '').substring(0, 3000)
                })
                break
              }

              // 最后一轮也保存调试日志
              if (pollIdx === 4) {
                saveDebugLog({
                  timestamp: new Date().toISOString(),
                  storeId, orderId,
                  phase: 'extension-not-found',
                  domResult: { name: domResult.name, phone: domResult.phone, extension: domResult.extension, logs: domResult.logs },
                  debugTextPreview: (domResult._debugText || '').substring(0, 3000)
                })
              }
            }
          }

          // 方案1b：如果专用API没拦截到，检查订单列表API（按orderId提取目标订单）
          if (!sensitiveData) {
            const latestOrderListResult = await tempWin.webContents.executeJavaScript('window.__orderListResult || null').catch(() => null)
            if (latestOrderListResult) {
              console.log('[SalesFetch] [BuyerInfo] 尝试从订单列表API按orderId提取...')
              const parsed = parseSensitiveInfo(latestOrderListResult, orderId)
              if (parsed && (parsed.buyerPhone || parsed.buyerAddress)) {
                console.log('[SalesFetch] [BuyerInfo] 从订单列表API提取成功: phone=' + (parsed.buyerPhone || '(空)') + ' addr=' + (parsed.buyerAddress || '(空)').substring(0, 30))
                // 补充到quickResult而不是直接返回
                if (!quickResult.buyerName && parsed.buyerName) quickResult.buyerName = parsed.buyerName
                if (!quickResult.buyerPhone && parsed.buyerPhone && parsed.buyerPhone.indexOf('*') === -1) quickResult.buyerPhone = parsed.buyerPhone
                if (!quickResult.buyerAddress && parsed.buyerAddress) quickResult.buyerAddress = parsed.buyerAddress
              }
            }
          }

          // 方案2：DOM提取（轮询模式 - 京东可能直接在页面展示解密信息）
          if (!sensitiveData) {
            console.log('[SalesFetch] [BuyerInfo] API未拦截到，轮询DOM提取解密信息...')
            const domExtractScript = `
              (function() {
                var result = { name: '', phone: '', address: '', logs: [] };
                var orderId = ${JSON.stringify(String(orderId))};

                // 策略1：查找弹出层/tooltip中的买家信息（点击眼睛图标后出现的提示）
                var popoverSelectors = [
                  '.jd-popover', '.jd-tooltip__popper', '.jd-drawer', '.jd-dialog',
                  '[class*="popover"]', '[class*="tooltip"]', '[class*="popper"]',
                  '[class*="drawer"]', '[class*="modal"]', '[class*="overlay"]',
                  '[class*="consignee"]', '[class*="receiver"]', '[class*="address-info"]',
                  '[class*="sensitive"]', '[class*="decrypt"]', '[class*="detail-info"]',
                  '[class*="buyer"]', '[class*="contact"]'
                ];

                function isValidAddress(text) {
                  if (!text || text.length < 8) return false;
                  // 必须以省/市/区/县开头或包含完整地址关键词
                  if (/^(?:省|市|区|县|镇|村|街|路)/.test(text)) return true;
                  if (/(?:省|市|自治区|特别行政区)/.test(text) && text.length > 10) return true;
                  if (/(?:省|市)[^\\n]{5,}/.test(text) && text.indexOf('截流') === -1 && text.indexOf('#') === -1) return true;
                  return false;
                }

                function isValidName(text) {
                  if (!text || text.length < 1 || text.length > 20) return false;
                  // 姓名应该是中文字符或英文字母，不含数字和特殊符号
                  if (/^[\\u4e00-\\u9fa5a-zA-Z\\s·]+$/.test(text)) return true;
                  return false;
                }

                for (var s = 0; s < popoverSelectors.length; s++) {
                  var els = document.querySelectorAll(popoverSelectors[s]);
                  for (var e = 0; e < els.length; e++) {
                    var el = els[e];
                    var rect = el.getBoundingClientRect();
                    // 必须是可见的
                    if (rect.width < 10 || rect.height < 10) continue;
                    var text = (el.innerText || '').trim();
                    if (text.length < 5 || text.length > 2000) continue;

                    // 查找手机号（标准11位 或 虚拟号格式 18600001111-0618）
                    var phoneMatch = text.match(/(1[3-9]\\d{9}(?:-\\d{1,6})?|95\\d{8,12}|400\\d{7})/);
                    if (phoneMatch) {
                      result.logs.push('弹出层命中: ' + popoverSelectors[s] + ' text=' + text.substring(0, 200));
                      result.phone = phoneMatch[0];
                      var extension = '';
                      // 按行解析姓名和地址
                      var lines = text.split(/[\\n\\r]+/).map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
                      for (var li = 0; li < lines.length; li++) {
                        var line = lines[li];
                        // 提取[XXXX]分机号（虚拟号格式）
                        if (!extension) {
                          var extM = line.match(/\\[(\\d{3,6})\\]$/);
                          if (extM) extension = extM[1];
                        }
                        // 匹配"收货人：XXX[XXXX]"格式（含分机号）
                        var nameKV = line.match(/(?:收货人|姓名|consignee|买家|收件人)[:：\\s]*([\\u4e00-\\u9fa5a-zA-Z·\\s]{1,20})/);
                        if (nameKV && !result.name) {
                          var kvName = nameKV[1].trim().replace(/\\s*\\[\\d{3,6}\\]\\s*$/, '');
                          if (isValidName(kvName)) {
                            result.name = kvName;
                            result.logs.push('弹出层姓名: ' + result.name);
                          }
                        }
                        // 匹配"地址：XXX[XXXX]"格式（含分机号，需剥离）
                        var addrKV = line.match(/(?:地址|收货地址|address)[:：\\s]*(.+)/i);
                        if (addrKV && !result.address) {
                          var kvAddr = addrKV[1].trim().replace(/\\s*\\[\\d{3,6}\\]\\s*$/, '');
                          if (isValidAddress(kvAddr)) {
                            result.address = kvAddr;
                            result.logs.push('弹出层地址: ' + result.address.substring(0, 30));
                          }
                        }
                        // 匹配"电话/手机"格式（可能含-分机号）
                        if (line.match(/电话|手机|mobile|phone|联系|虚拟号/i)) {
                          var phoneVal = line.replace(/.*[:：]\\s*/, '').trim();
                          var pMatch = phoneVal.match(/(1[3-9]\\d{9}(?:-\\d{1,6})?|95\\d{8,12}|400\\d{7})/);
                          if (pMatch) result.phone = pMatch[0];
                        }
                      }

                      // 如果还没找到姓名，尝试从tooltip中找短中文字符串（支持带[XXXX]分机号）
                      if (!result.name) {
                        for (var li2 = 0; li2 < lines.length; li2++) {
                          var l2 = lines[li2].trim();
                          // 支持带分机号的姓名格式：苏宝宝[5008]
                          var nameExtMatch = l2.match(/^([\\u4e00-\\u9fa5·\\*]+)\\[(\\d{3,6})\\]$/);
                          if (nameExtMatch) {
                            result.name = nameExtMatch[1];
                            if (!extension) extension = nameExtMatch[2];
                            result.logs.push('弹出层姓名(含分机号): ' + result.name + ' ext=' + nameExtMatch[2]);
                            break;
                          }
                          // 纯中文名
                          if (l2.length >= 2 && l2.length <= 8 && /^[\\u4e00-\\u9fa5·]+$/.test(l2)) {
                            if (!/^(确认|取消|查看|虚拟|收货|地址|手机|电话|说明|绑定|点击|使用|有效|收件|联系|复制|取消|订单|快递|录入|短信|模板|分机|保护|安全)$/.test(l2)) {
                              result.name = l2;
                              result.logs.push('弹出层短名: ' + l2);
                              break;
                            }
                          }
                        }
                      }

                      // 如果还没找到地址，尝试从含省关键词的行提取（剥离[XXXX]）
                      if (!result.address) {
                        for (var li3 = 0; li3 < lines.length; li3++) {
                          var l3 = lines[li3].trim();
                          var addrClean = l3.replace(/\\s*\\[\\d{3,6}\\]\\s*$/, '').trim();
                          if (addrClean.length >= 8 && isValidAddress(addrClean) && addrClean.indexOf('截流') === -1) {
                            result.address = addrClean;
                            result.logs.push('弹出层地址(剥离分机号): ' + addrClean.substring(0, 30));
                            break;
                          }
                        }
                      }

                      // 特殊格式：第一行可能是 "姓名，地址" 格式（如 "马**，浙江嘉兴市桐乡市**********"）
                      if ((!result.name || !result.address) && lines.length > 0) {
                        var firstLine = lines[0].trim();
                        var commaIdx = firstLine.indexOf('，');
                        if (commaIdx === -1) commaIdx = firstLine.indexOf(',');
                        if (commaIdx > 0) {
                          var namePart = firstLine.substring(0, commaIdx).trim();
                          var addrPart = firstLine.substring(commaIdx + 1).trim();
                          if (!result.name && namePart.length >= 2 && namePart.length <= 10 && /^[\\u4e00-\\u9fa5·\\*]+$/.test(namePart)) {
                            result.name = namePart;
                            result.logs.push('弹出层姓名(含脱敏): ' + namePart);
                          }
                          if (!result.address && addrPart.length >= 5 && /(?:北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)/.test(addrPart)) {
                            result.address = addrPart;
                            result.logs.push('弹出层地址(含脱敏): ' + addrPart.substring(0, 30));
                          }
                        }
                      }

                      // 如果有分机号且手机号还没带分机号，追加
                      if (extension && result.phone && result.phone.indexOf('-') === -1) {
                        result.phone = result.phone + '-' + extension;
                        result.logs.push('手机号追加分机号: ' + result.phone);
                      }
                      break;
                    }
                  }
                  if (result.phone) break;
                }

                // 策略2：在订单所在行/卡片中提取信息
                if (!result.name || !result.address) {
                  var allEls = document.querySelectorAll('*');
                  var orderEl = null;
                  for (var i = 0; i < allEls.length; i++) {
                    if (allEls[i].children.length === 0 && allEls[i].textContent.trim() === orderId) {
                      orderEl = allEls[i]; break;
                    }
                  }
                  if (orderEl) {
                    var container = orderEl;
                    for (var up = 0; up < 15; up++) {
                      container = container.parentElement;
                      if (!container || container === document.body) break;
                      var r = container.getBoundingClientRect();
                      if (r.width > 500 && r.height > 80) break;
                    }
                    if (container && container !== document.body) {
                      var containerText = container.innerText || '';
                      result.logs.push('订单容器文本长度: ' + containerText.length);
                      // 查找手机号（仅在未拿到时）
                      if (!result.phone) {
                        var containerPhones = containerText.match(/(1[3-9]\\d{9}(?:-\\d{1,6})?)/g);
                        if (containerPhones && containerPhones.length > 0) {
                          result.phone = containerPhones[0];
                          result.logs.push('容器中找到手机号: ' + result.phone);
                        }
                      }
                      // 查找地址（更严格：必须包含省/市级关键词）
                      if (!result.address) {
                        var addrMatch = containerText.match(/((?:北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)[^\\n*]{5,80}?)(?:\\n|$)/);
                        if (addrMatch && addrMatch[1].indexOf('*') === -1) {
                          result.address = addrMatch[1].trim();
                          result.logs.push('容器中找到地址: ' + result.address.substring(0, 30));
                        }
                      }
                      // 查找姓名
                      if (!result.name) {
                        var nameMatch = containerText.match(/(?:收货人|姓名|买家|收件人)[:：\\s]*([\\u4e00-\\u9fa5a-zA-Z·]{2,10})/);
                        if (nameMatch && isValidName(nameMatch[1])) {
                          result.name = nameMatch[1];
                          result.logs.push('容器中找到姓名: ' + result.name);
                        }
                      }
                    }
                  }
                }

                // 策略3：全页面搜索含有手机号的文本节点
                if (!result.phone) {
                  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
                  var node;
                  while (node = walker.nextNode()) {
                    var t = node.textContent.trim();
                    if (t.length >= 7 && t.length <= 50) {
                      var pm = t.match(/^(1[3-9]\\d{9}|95\\d{8,12}|400\\d{7})$/);
                      if (pm) {
                        var parent = node.parentElement;
                        var ctx = parent ? (parent.previousElementSibling ? parent.previousElementSibling.textContent : '') + parent.textContent : '';
                        if (ctx.match(/电话|手机|联系|mobile|phone|tel|虚拟/i) || (parent.className && parent.className.match(/phone|mobile|contact/i))) {
                          result.phone = pm[1];
                          result.logs.push('文本节点命中: ' + pm[1] + ' ctx=' + ctx.substring(0, 40));
                          break;
                        }
                      }
                    }
                  }
                }

                // 去除手机号 _p 后缀（京东虚拟号显示格式）
                if (result.phone && result.phone.indexOf('_') !== -1) {
                  result.phone = result.phone.replace(/_[a-zA-Z]+$/, '');
                }

                result.logs.push('DOM提取结果: name=' + (result.name || '空') + ' phone=' + (result.phone || '空') + ' addr=' + (result.address ? result.address.substring(0, 30) : '空'));
                return result;
              })()
            `

            // 轮询DOM提取（最多尝试5次，每次间隔800ms）
            let domResult = null
            for (let domAttempt = 0; domAttempt < 5; domAttempt++) {
              domResult = await tempWin.webContents.executeJavaScript(domExtractScript)
                .catch(e => ({ name: '', phone: '', address: '', logs: ['error: ' + e.message] }))
              if (domResult.phone || domResult.address) {
                console.log('[SalesFetch] [BuyerInfo] DOM提取成功(第' + (domAttempt + 1) + '次):', JSON.stringify(domResult))
                break
              }
              if (domAttempt < 4) await new Promise(r => setTimeout(r, 800))
            }

            if (domResult && (domResult.phone || domResult.address)) {
              sensitiveData = {
                code: 200,
                data: {
                  consName: domResult.name || '',
                  consMobilePhone: domResult.phone || '',
                  consAddress: domResult.address || ''
                }
              }
              console.log('[SalesFetch] [BuyerInfo] DOM提取成功: phone=' + domResult.phone)
              // 补充到quickResult
              if (domResult.name && !quickResult.buyerName) quickResult.buyerName = domResult.name
              if (domResult.phone && !quickResult.buyerPhone) quickResult.buyerPhone = domResult.phone
              if (domResult.address && !quickResult.buyerAddress) quickResult.buyerAddress = domResult.address
            } else {
              console.log('[SalesFetch] [BuyerInfo] DOM提取失败:', JSON.stringify(domResult))
            }
          }

          // 方案3：全量API响应搜索（最后兜底 - 优先搜索非订单列表API，再搜索订单列表API按orderId筛选）
          if (!sensitiveData) {
            console.log('[SalesFetch] [BuyerInfo] DOM也未提取到，尝试从全量API捕获中搜索...')
            const allResponses = await tempWin.webContents.executeJavaScript('window.__allCapturedResponses || []').catch(() => [])
            console.log('[SalesFetch] [BuyerInfo] 全量捕获响应数:', allResponses.length)
            for (const resp of allResponses) {
              console.log('[SalesFetch] [BuyerInfo]   响应URL:', (resp.url || '').substring(0, 200), 'len:', (resp.body || '').length)
            }

            // 3a: 优先搜索非订单列表API（买家信息专用API）
            for (const resp of allResponses) {
              const body = resp.body || ''
              const url = resp.url || ''
              if (body.length < 30) continue
              // 跳过订单列表API（已在上游处理或需要按orderId筛选）
              if (url.indexOf('queryOrderPage') !== -1 || url.indexOf('queryOrderList') !== -1
                || url.indexOf('getOrderList') !== -1 || url.indexOf('orderSearch') !== -1) continue
              // 匹配标准手机号或虚拟号字段
              const phoneMatch = body.match(/"(?:mobile|phone|consMobilePhone|consigneePhone|virtualNumber|receiverMobile|virtualPhone|forwardNumber)"\s*:\s*"(\d{7,20})"/)
              if (phoneMatch) {
                try {
                  const json = JSON.parse(body)
                  console.log('[SalesFetch] [BuyerInfo] 全量搜索命中(非订单列表):', url.substring(0, 150), 'phone:', phoneMatch[1])
                  sensitiveData = json
                  break
                } catch (e) { /* not JSON, skip */ }
              }
              // 也匹配含有非脱敏地址的响应
              if (!sensitiveData) {
                const addrMatch = body.match(/"(?:consAddress|fullAddress|address|receiverAddress)"\s*:\s*"([^"*]{10,})"/)
                if (addrMatch) {
                  try {
                    const json = JSON.parse(body)
                    // 确保不是订单列表响应（检查是否有orderList数组）
                    const data = json.data || json.result || json
                    const hasOrderList = (data.orderList && Array.isArray(data.orderList))
                      || (data.list && Array.isArray(data.list) && data.list[0] && data.list[0].orderId)
                    if (!hasOrderList) {
                      console.log('[SalesFetch] [BuyerInfo] 全量搜索命中(地址,非订单列表):', url.substring(0, 150))
                      sensitiveData = json
                      break
                    }
                  } catch (e) { /* not JSON, skip */ }
                }
              }
            }

            // 3b: 如果还没找到，搜索订单列表API，按orderId提取目标订单
            if (!sensitiveData) {
              for (const resp of allResponses) {
                const body = resp.body || ''
                const url = resp.url || ''
                if (body.length < 30) continue
                if (url.indexOf('queryOrderPage') === -1 && url.indexOf('queryOrderList') === -1
                  && url.indexOf('getOrderList') === -1 && url.indexOf('orderSearch') === -1) continue
                // 检查响应中是否包含目标orderId
                if (body.indexOf(orderId) !== -1) {
                  try {
                    const json = JSON.parse(body)
                    const parsed = parseSensitiveInfo(json, orderId)
                    if (parsed && (parsed.buyerPhone || parsed.buyerAddress)) {
                      console.log('[SalesFetch] [BuyerInfo] 从订单列表API中提取到目标订单买家信息:', url.substring(0, 150))
                      sensitiveData = json
                      // 直接返回按orderId提取的结果，不再走parseSensitiveInfo
                      return { success: true, data: parsed }
                    }
                  } catch (e) { /* not JSON, skip */ }
                }
              }
            }

            if (!sensitiveData) {
              // 最终兜底：打印所有响应体的前200字符用于调试
              for (const resp of allResponses) {
                console.log('[SalesFetch] [BuyerInfo]   body预览:', (resp.body || '').substring(0, 200))
              }
              console.log('[SalesFetch] [BuyerInfo] 全量搜索也未找到买家信息')
            }
          }
        }

        if (!sensitiveData) {
          // 即使没有sensitiveData，检查quickResult是否有部分数据
          if (quickResult.buyerName || quickResult.buyerPhone || quickResult.buyerAddress) {
            // 去除脱敏手机号
            if (quickResult.buyerPhone && quickResult.buyerPhone.indexOf('*') !== -1) {
              quickResult.buyerPhone = ''
            }
            if (quickResult.buyerName || quickResult.buyerPhone || quickResult.buyerAddress) {
              console.log('[SalesFetch] [BuyerInfo] 仅quickResult有数据: name=' + quickResult.buyerName + ' phone=' + quickResult.buyerPhone + ' addr=' + (quickResult.buyerAddress||'').substring(0,30))
              saveDebugLog({
                timestamp: new Date().toISOString(),
                storeId, orderId,
                phase: 'buyer-info-partial',
                quickResult, clickResult, confirmResult
              })
              return { success: true, data: quickResult }
            }
          }
          // 保存诊断日志
          saveDebugLog({
            timestamp: new Date().toISOString(),
            storeId, orderId,
            phase: 'buyer-info-failed',
            clickResult, confirmResult, quickResult
          })
          return { success: false, message: '获取买家信息失败，请确保店铺已在京麦后台登录' }
        }

        const rawJson = JSON.stringify(sensitiveData)
        console.log('[SalesFetch] getSensitiveInfo result:', rawJson.substring(0, 500))

        // 保存诊断日志（包含完整API响应数据，方便排查）
        saveDebugLog({
          timestamp: new Date().toISOString(),
          storeId, orderId,
          phase: 'buyer-info-success',
          clickResult,
          confirmResult,
          quickResult,
          apiResponsePreview: rawJson.substring(0, 2000)
        })

        if (sensitiveData.code && sensitiveData.code !== 0 && sensitiveData.code !== 200) {
          return { success: false, message: sensitiveData.msg || 'API错误(code=' + sensitiveData.code + ')' }
        }

        const buyerInfo = parseSensitiveInfo(sensitiveData, orderId)
        if (buyerInfo) {
          // 合并quickResult和buyerInfo（quickResult补充buyerInfo缺失的字段）
          if (!buyerInfo.buyerName && quickResult.buyerName) buyerInfo.buyerName = quickResult.buyerName
          if (!buyerInfo.buyerPhone && quickResult.buyerPhone) buyerInfo.buyerPhone = quickResult.buyerPhone
          // 如果buyerInfo的手机号是脱敏的，用quickResult替换
          if (buyerInfo.buyerPhone && buyerInfo.buyerPhone.indexOf('*') !== -1 && quickResult.buyerPhone && quickResult.buyerPhone.indexOf('*') === -1) {
            buyerInfo.buyerPhone = quickResult.buyerPhone
          }
          // 如果buyerInfo的手机号没有分机号，但quickResult有分机号（虚拟号-分机号格式），优先用quickResult
          if (buyerInfo.buyerPhone && buyerInfo.buyerPhone.indexOf('-') === -1 && quickResult.buyerPhone && quickResult.buyerPhone.indexOf('-') !== -1) {
            buyerInfo.buyerPhone = quickResult.buyerPhone
          }
          if (!buyerInfo.buyerAddress && quickResult.buyerAddress) buyerInfo.buyerAddress = quickResult.buyerAddress
          // 如果姓名中带[XXXX]分机号，剥离保留纯姓名，分机号追加到手机号
          if (buyerInfo.buyerName) {
            var nameExtM = buyerInfo.buyerName.match(/^(.+)\[(\d{3,6})\]$/);
            if (nameExtM) {
              buyerInfo.buyerName = nameExtM[1];
              if (buyerInfo.buyerPhone && buyerInfo.buyerPhone.indexOf('-') === -1) {
                buyerInfo.buyerPhone = buyerInfo.buyerPhone + '-' + nameExtM[2];
              }
            }
          }
          // 如果地址中带[XXXX]分机号，剥离保留纯地址
          if (buyerInfo.buyerAddress) {
            var addrExtM = buyerInfo.buyerAddress.match(/^(.+)\[(\d{3,6})\]$/);
            if (addrExtM) {
              buyerInfo.buyerAddress = addrExtM[1];
              if (buyerInfo.buyerPhone && buyerInfo.buyerPhone.indexOf('-') === -1) {
                buyerInfo.buyerPhone = buyerInfo.buyerPhone + '-' + addrExtM[2];
              }
            }
          }
          // DOM提取到了分机号但不在手机号中，追加到手机号
          if (quickResult._extension && buyerInfo.buyerPhone && buyerInfo.buyerPhone.indexOf('-') === -1) {
            buyerInfo.buyerPhone = buyerInfo.buyerPhone + '-' + quickResult._extension
            console.log('[SalesFetch] [BuyerInfo] 从DOM分机号追加: ' + quickResult._extension)
          }
          console.log('[SalesFetch] [BuyerInfo] 最终合并结果: name=' + buyerInfo.buyerName + ' phone=' + buyerInfo.buyerPhone + ' addr=' + (buyerInfo.buyerAddress||'').substring(0,30))
          return { success: true, data: buyerInfo }
        } else {
          // parseSensitiveInfo失败，尝试用quickResult
          if (quickResult.buyerName || quickResult.buyerPhone || quickResult.buyerAddress) {
            return { success: true, data: quickResult }
          }
          return { success: false, message: '解析买家信息失败', rawResponse: rawJson.substring(0, 2000) }
        }
      } catch (e) {
        console.log('[SalesFetch] [BuyerInfo] DOM自动化失败:', e.message)
        return { success: false, message: e.message }
      } finally {
        if (tempWin && !tempWin.isDestroyed()) {
          tempWin.destroy()
        }
      }
    } catch (err) {
      console.log('[SalesFetch] 获取买家信息失败:', err.message)
      return { success: false, message: err.message }
    }
  })
}

// ============ 解析敏感信息 ============
function parseSensitiveInfo(json, orderId) {
  try {
    console.log('[SalesFetch] [parseSensitiveInfo] 顶层keys:', Object.keys(json), 'orderId:', orderId || '无')
    const data = json.data || json.result || json
    if (!data) return null
    if (typeof data === 'object' && data !== null) {
      console.log('[SalesFetch] [parseSensitiveInfo] data层keys:', Object.keys(data))
    }

    // 检查是否为订单列表响应（包含多个订单，需要按orderId筛选）
    const orderListFields = ['orderList', 'list', 'result', 'results', 'orderInfoList']
    let orderListArray = null
    for (const field of orderListFields) {
      if (data[field] && Array.isArray(data[field]) && data[field].length > 0) {
        // 检查数组元素是否包含 orderId 字段（说明是订单列表而非单一买家信息）
        if (data[field][0] && (data[field][0].orderId || data[field][0].order_id)) {
          orderListArray = data[field]
          console.log('[SalesFetch] [parseSensitiveInfo] 检测到订单列表响应, 字段:', field, '数量:', orderListArray.length)
          break
        }
      }
    }

    if (orderListArray && orderId) {
      // 从订单列表中找到目标订单
      const targetOrder = orderListArray.find(o =>
        String(o.orderId || o.order_id || '') === String(orderId)
      )
      if (targetOrder) {
        console.log('[SalesFetch] [parseSensitiveInfo] 从订单列表中找到目标订单:', orderId)
        // 提取该订单的收货人信息
        const consInfo = targetOrder.orderConsigneeInfo || targetOrder.consigneeInfo || targetOrder.orderConsigneeDto || {}
        const result = {}
        result.buyerName = consInfo.consName || consInfo.fullname || consInfo.name || targetOrder.userPin || ''
        result.buyerPhone = consInfo.consMobilePhone || consInfo.mobile || consInfo.phone || ''
        result.buyerAddress = consInfo.consAddress || consInfo.fullAddress || consInfo.address || ''
        // virtualNumber
        if (consInfo.virtualNumber && typeof consInfo.virtualNumber === 'string' && consInfo.virtualNumber.length >= 7) {
          result.buyerPhone = consInfo.virtualNumber
        }
        console.log('[SalesFetch] [parseSensitiveInfo] 订单列表提取结果: name=' + (result.buyerName || '(空)') + ', phone=' + (result.buyerPhone || '(空)') + ', addr=' + (result.buyerAddress || '(空)').substring(0, 30))
        if (result.buyerName || result.buyerPhone || result.buyerAddress) return result
      } else {
        console.log('[SalesFetch] [parseSensitiveInfo] 订单列表中未找到目标订单:', orderId)
      }
      return null
    }

    const info = data.data || data.result || data
    if (!info) return null

    const result = {}

    if (typeof info === 'object' && info !== null) {
      // 基本字段提取
      result.buyerName = info.consName || info.consigneeName || info.name || info.fullname || ''
      result.buyerPhone = info.consMobilePhone || info.consigneePhone || info.mobile || info.phone || ''
      result.buyerAddress = info.consAddress || info.consigneeAddress || info.fullAddress || info.address || ''

      // virtualNumber 优先级高于脱敏的 mobile
      if (info.virtualNumber && typeof info.virtualNumber === 'string' && info.virtualNumber.length >= 7) {
        console.log('[SalesFetch] [parseSensitiveInfo] 使用virtualNumber替代脱敏手机号:', info.virtualNumber)
        result.buyerPhone = info.virtualNumber
      } else if (result.buyerPhone && result.buyerPhone.indexOf('*') !== -1) {
        // vnTips 兜底
        if (info.vnTips && typeof info.vnTips === 'object') {
          const vnPhone = info.vnTips.phone || info.vnTips.mobile || ''
          if (vnPhone && vnPhone.indexOf('*') === -1) {
            console.log('[SalesFetch] [parseSensitiveInfo] 使用vnTips手机号:', vnPhone)
            result.buyerPhone = vnPhone
          }
        }
        // virtualPhone 兜底
        if (info.virtualPhone && typeof info.virtualPhone === 'string' && info.virtualPhone.indexOf('*') === -1) {
          console.log('[SalesFetch] [parseSensitiveInfo] 使用virtualPhone:', info.virtualPhone)
          result.buyerPhone = info.virtualPhone
        }
      }

      // sensitiveInfoList 数组格式
      if (Array.isArray(info.sensitiveInfoList || info.list)) {
        const list = info.sensitiveInfoList || info.list
        for (let i = 0; i < list.length; i++) {
          const item = list[i]
          if (!item) continue
          if (!result.buyerName && (item.consName || item.name)) result.buyerName = item.consName || item.name
          if (!result.buyerPhone && (item.consMobilePhone || item.mobile || item.phone)) result.buyerPhone = item.consMobilePhone || item.mobile || item.phone
          if (!result.buyerAddress && (item.consAddress || item.address || item.fullAddress)) result.buyerAddress = item.consAddress || item.address || item.fullAddress
        }
      }

      // orderConsigneeDto 嵌套格式
      if (info.orderConsigneeDto && typeof info.orderConsigneeDto === 'object') {
        const dto = info.orderConsigneeDto
        if (!result.buyerName) result.buyerName = dto.fullname || dto.name || dto.consName || ''
        if (!result.buyerPhone) result.buyerPhone = dto.mobile || dto.telephone || dto.phone || ''
        if (!result.buyerAddress) result.buyerAddress = dto.fullAddress || dto.address || ''
        // dto 中也可能有 virtualNumber
        if (dto.virtualNumber && typeof dto.virtualNumber === 'string' && dto.virtualNumber.length >= 7) {
          if (!result.buyerPhone || result.buyerPhone.indexOf('*') !== -1) {
            result.buyerPhone = dto.virtualNumber
          }
        }
      }

      // 深度递归搜索缺失字段（限制：只在单一买家信息对象中搜索，不跨订单混搭）
      if (!result.buyerName || !result.buyerPhone || !result.buyerAddress) {
        const nameKeys = ['consName', 'consigneeName', 'fullname', 'name', 'receiverName', 'buyerName']
        const phoneKeys = ['consMobilePhone', 'consigneePhone', 'mobile', 'phone', 'receiverMobile', 'buyerPhone', 'virtualNumber', 'virtualPhone', 'forwardNumber', 'transferPhone', 'vnNumber', 'contactPhone']
        const addrKeys = ['consAddress', 'consigneeAddress', 'fullAddress', 'address', 'receiverAddress', 'buyerAddress']

        function deepSearch(obj, depth) {
          if (!obj || typeof obj !== 'object' || depth > 4) return
          // 如果遇到订单数组，跳过（避免从不同订单混搭数据）
          if (Array.isArray(obj) && obj.length > 0 && obj[0] && (obj[0].orderId || obj[0].order_id)) return
          const keys = Array.isArray(obj) ? obj.map((_, i) => i) : Object.keys(obj)
          for (let i = 0; i < keys.length; i++) {
            const val = obj[keys[i]]
            if (typeof val === 'string' && val.length > 0 && val.length < 500) {
              const k = String(keys[i])
              if (!result.buyerName && nameKeys.indexOf(k) !== -1) result.buyerName = val
              if (!result.buyerPhone && phoneKeys.indexOf(k) !== -1 && val.indexOf('*') === -1) result.buyerPhone = val
              if (!result.buyerAddress && addrKeys.indexOf(k) !== -1) result.buyerAddress = val
            } else if (typeof val === 'object' && val !== null) {
              deepSearch(val, depth + 1)
            }
            if (result.buyerName && result.buyerPhone && result.buyerAddress) return
          }
        }

        deepSearch(info, 0)
      }
    }

    console.log('[SalesFetch] [parseSensitiveInfo] 解析结果: name=' + (result.buyerName || '(空)') + ', phone=' + (result.buyerPhone || '(空)') + ', addr=' + (result.buyerAddress || '(空)').substring(0, 30))

    if (result.buyerName || result.buyerPhone || result.buyerAddress) return result
    return null
  } catch (e) {
    console.log('[SalesFetch] [parseSensitiveInfo] 异常:', e.message)
    return null
  }
}

// ============ 自动定时同步 ============
const AUTO_SYNC_INTERVAL = 10 * 60 * 1000 // 10 分钟
const AUTO_SYNC_FIRST_DELAY = 60 * 1000   // 启动后 60 秒开始第一次
const LOCAL_SERVER = 'http://localhost:3002'

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

// 主进程直接保存订单到服务器（避免通过 IPC 传递订单导致双重保存）
async function saveOrdersToServer(storeId, orders) {
  const http = require('http')
  return new Promise((resolve) => {
    const token = getAuthToken()
    const data = JSON.stringify({ store_id: storeId, orders })
    const req = http.request({
      hostname: 'localhost', port: 3002,
      path: '/api/sales-orders/batch', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    }, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        console.log(`[AutoSync] 保存订单响应: ${res.statusCode}`)
        resolve(res.statusCode === 200)
      })
    })
    req.on('error', (e) => { console.error('[AutoSync] 保存订单失败:', e.message); resolve(false) })
    req.write(data)
    req.end()
  })
}

// 主进程直接更新同步时间
async function updateSyncTimeOnServer(storeId) {
  const http = require('http')
  return new Promise((resolve) => {
    const token = getAuthToken()
    const req = http.request({
      hostname: 'localhost', port: 3002,
      path: `/api/stores/${storeId}/sync-time`, method: 'PUT',
      headers: {
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    }, (res) => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve(res.statusCode === 200))
    })
    req.on('error', (e) => { console.error('[AutoSync] 更新同步时间失败:', e.message); resolve(false) })
    req.end()
  })
}

// ============ 分布式同步锁机制 ============
// 设计目标：
// 1. 首次同步：登录后60秒自动同步（由 startAutoSync 控制）
// 2. 单一同步：同一时间只有1个账号在同步（多店铺逐个同步）
// 3. 频率限制：每个店铺10分钟内只能发起一次同步

const SYNC_LOCKS = new Map() // storeId -> { lockTime: number, deviceId: string }
const SYNC_HISTORY = new Map() // storeId -> { lastSyncTime: number, syncCount: number }
const MIN_SYNC_INTERVAL = 10 * 60 * 1000 // 10分钟最小同步间隔
const LOCK_TIMEOUT = 5 * 60 * 1000 // 5分钟锁超时（防止死锁）

async function requestSyncLock(storeId, type = 'sales') {
  const lockKey = `${storeId}-${type}`
  const now = Date.now()
  
  console.log(`[SyncLock] 请求锁: storeId=${storeId}, type=${type}`)
  
  // 1. 检查频率限制（10分钟内只能同步一次）
  const history = SYNC_HISTORY.get(storeId)
  if (history && (now - history.lastSyncTime) < MIN_SYNC_INTERVAL) {
    const waitMinutes = Math.ceil((MIN_SYNC_INTERVAL - (now - history.lastSyncTime)) / 60000)
    const waitSeconds = Math.ceil((MIN_SYNC_INTERVAL - (now - history.lastSyncTime)) / 1000)
    console.log(`[SyncLock] ❌ 频率限制: 距上次同步仅 ${waitSeconds} 秒，需等待 ${waitMinutes} 分钟`)
    return { 
      granted: false, 
      message: `该店铺10分钟内只能同步一次，请等待 ${waitMinutes} 分钟后再试`,
      lastSyncAt: new Date(history.lastSyncTime).toLocaleTimeString()
    }
  }
  
  // 2. 检查全局锁（防止多设备/多账号同时同步）
  const existingLock = SYNC_LOCKS.get(lockKey)
  if (existingLock && (now - existingLock.lockTime) < LOCK_TIMEOUT) {
    console.log(`[SyncLock] ❌ 全局锁冲突: 设备 ${existingLock.deviceId} 正在同步`)
    return { 
      granted: false, 
      message: `该店铺正在其他设备同步中，请稍后再试`,
      lockedBy: existingLock.deviceId
    }
  }
  
  // 3. 获取锁
  SYNC_LOCKS.set(lockKey, {
    lockTime: now,
    deviceId: DEVICE_ID
  })

  // 注意：SYNC_HISTORY 不在此处更新，改为在 releaseSyncLock 中根据同步结果决定是否更新

  console.log(`[SyncLock] ✅ 锁已获取 (设备: ${DEVICE_ID})`)
  console.log(`[SyncLock] 全局锁状态:`, Array.from(SYNC_LOCKS.entries()).map(([k, v]) => `${k}=${v.deviceId}`))
  console.log(`[SyncLock] 同步历史:`, Array.from(SYNC_HISTORY.entries()).map(([k, v]) => `${k}=${v.syncCount}次`))

  return { granted: true }
}

async function releaseSyncLock(storeId, type = 'sales', success = true) {
  const lockKey = `${storeId}-${type}`
  SYNC_LOCKS.delete(lockKey)

  // 仅在同步成功时更新历史，失败则不更新（允许立即重试）
  if (success) {
    const history = SYNC_HISTORY.get(storeId)
    SYNC_HISTORY.set(storeId, {
      lastSyncTime: Date.now(),
      syncCount: (history?.syncCount || 0) + 1
    })
    console.log(`[SyncLock] 同步成功，已更新历史: ${storeId}`)
  } else {
    console.log(`[SyncLock] 同步失败，不更新历史，允许重试: ${storeId}`)
  }

  console.log(`[SyncLock] 🔓 锁已释放: ${lockKey}`)
  console.log(`[SyncLock] 剩余全局锁:`, Array.from(SYNC_LOCKS.entries()).map(([k, v]) => `${k}=${v.deviceId}`))
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

      let result
      try {
        result = await fetchSalesOrders(store.store_id)
        if (result.success) {
          const orders = result.data?.list || []
          console.log(`[AutoSync] [${i + 1}/${jdStores.length}] 成功: ${orders.length} 条订单`)
          // 主进程直接保存订单到服务器，避免通过 IPC 传递导致双重保存
          if (orders.length > 0) {
            await saveOrdersToServer(store.store_id, orders)
          }
          // 更新同步时间
          await updateSyncTimeOnServer(store.store_id)
        } else {
          console.log(`[AutoSync] [${i + 1}/${jdStores.length}] 失败: ${result.message}`)
        }

        // 通知渲染进程同步结果（不再传递 orders，避免双重保存）
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
      } finally {
        // 同步完成后释放锁，传递同步结果以决定是否更新历史
        await releaseSyncLock(store.store_id, 'sales', result?.success ?? false)
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
  // 先清理已有定时器，防止重复创建
  stopAutoSync()

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
