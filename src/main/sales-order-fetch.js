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

        // 注入 API 拦截器（全量捕获模式：捕获所有API响应，后续从中筛选买家信息）
        tempWin.webContents.on('dom-ready', () => {
          if (tempWin.isDestroyed()) return
          tempWin.webContents.executeJavaScript(`
            (function() {
              if (window.__sffInterceptorInstalled) return;
              window.__sffInterceptorInstalled = true;
              window.__sensitiveInfoResult = null;
              window.__sensitiveInfoLogs = [];
              window.__allCapturedResponses = [];
              window.__captureEnabled = false;
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
                var virtualPhone = /"(?:virtualNumber|virtualPhone|forwardNumber|transferPhone|vnNumber)"\\s*:\\s*"(\\d{7,20})"/;
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

              var origFetch = window.fetch;
              window.fetch = function(input, init) {
                var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
                return origFetch.apply(this, arguments).then(function(response) {
                  if (window.__captureEnabled) {
                    try {
                      var cloned = response.clone();
                      cloned.text().then(function(text) {
                        window.__sensitiveInfoLogs.push('fetch[' + response.status + ']: ' + url.substring(0, 150) + ' len=' + text.length);
                        window.__allCapturedResponses.push({ url: url.substring(0, 300), body: text.substring(0, 50000), time: Date.now() });
                        if (!isExcludedApi(url) && containsBuyerInfo(text)) {
                          window.__sensitiveInfoLogs.push('MATCH fetch: ' + url.substring(0, 150));
                          try { window.__sensitiveInfoResult = JSON.parse(text); }
                          catch(e) { window.__sensitiveInfoResult = { raw: text.substring(0, 50000) }; }
                        }
                      }).catch(function(){});
                    } catch(e) {}
                  }
                  return response;
                });
              };

              var origXhrOpen = XMLHttpRequest.prototype.open;
              var origXhrSend = XMLHttpRequest.prototype.send;
              XMLHttpRequest.prototype.open = function(method, url) {
                this.__sffUrl = (url || '').toString();
                return origXhrOpen.apply(this, arguments);
              };
              XMLHttpRequest.prototype.send = function(body) {
                var xhr = this;
                if (window.__captureEnabled) {
                  xhr.addEventListener('load', function() {
                    try {
                      var text = xhr.responseText || '';
                      var url = xhr.__sffUrl || '';
                      window.__sensitiveInfoLogs.push('xhr[' + xhr.status + ']: ' + url.substring(0, 150) + ' len=' + text.length);
                      window.__allCapturedResponses.push({ url: url.substring(0, 300), body: text.substring(0, 50000), time: Date.now() });
                      if (!isExcludedApi(url) && containsBuyerInfo(text)) {
                        window.__sensitiveInfoLogs.push('MATCH xhr: ' + url.substring(0, 150));
                        try { window.__sensitiveInfoResult = JSON.parse(text); }
                        catch(e) { window.__sensitiveInfoResult = { raw: text.substring(0, 50000) }; }
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
            for (var up = 0; up < 20; up++) {
              container = container.parentElement;
              if (!container || container === document.body) break;
              var r = container.getBoundingClientRect();
              if (r.width > 500 && r.height > 100) break;
            }
            var scope = container || document.body;
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

            // 优先选 consignee-info 眼睛（能获取手机号），否则选最后一个（通常包含更完整的信息）
            if (consigneeEyeIcon) {
              eyeEl = consigneeEyeIcon.el;
              result.logs.push('选收货人信息眼睛(候选[' + consigneeEyeIcon.idx + ']) - 含手机号');
            } else if (eyeIcons.length >= 2) {
              eyeEl = eyeIcons[eyeIcons.length - 1].el;
              result.logs.push('选最后一个眼睛(候选[' + eyeIcons[eyeIcons.length - 1].idx + ']) - 多个眼睛取后者');
            } else if (eyeIcons.length === 1) {
              eyeEl = eyeIcons[0].el;
              result.logs.push('选唯一眼睛(候选[' + eyeIcons[0].idx + '])');
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

        if (clickResult.clicked) {
          // 轮询等待确认弹窗
          const dialogReady = await pollUntil(
            () => tempWin.webContents.executeJavaScript(
              "!!(document.querySelector('[class*=\"dialog\"] [class*=\"primary\"]') || document.querySelector('.ant-modal .ant-btn-primary') || (function(){var bs=document.querySelectorAll('button');for(var i=0;i<bs.length;i++){if(/^(确认|确定|同意|OK)$/.test(bs[i].textContent.trim()))return true;}return false;})())"
            ),
            { timeout: 5000, interval: 300, label: '确认弹窗' }
          )
          if (!dialogReady) await new Promise(r => setTimeout(r, 500))

          // 关键：在点击确认按钮之前，清空已有捕获并标记进入确认后阶段
          // 确认后阶段不排除任何API（queryOrderPage可能携带解密数据）
          await tempWin.webContents.executeJavaScript(`
            window.__sensitiveInfoResult = null;
            window.__sensitiveInfoLogs = [];
            window.__allCapturedResponses = [];
            window.__postConfirmPhase = true;
          `).catch(() => {})

          console.log('[SalesFetch] [BuyerInfo] 查找并点击确认弹窗...')
          const confirmResult = await tempWin.webContents.executeJavaScript(`
            (function() {
              var result = { confirmed: false, logs: [] };
              var selectors = [
                '.ant-modal .ant-btn-primary',
                '.ant-modal-confirm-btns .ant-btn-primary',
                '.el-message-box__btns .el-button--primary',
                '.el-dialog .el-button--primary',
                '[class*="modal"] [class*="primary"]',
                '[class*="dialog"] [class*="primary"]',
                '[class*="Dialog"] [class*="primary"]'
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
              if (!result.confirmed) {
                var allBtns = document.querySelectorAll('button, [role="button"]');
                for (var i = 0; i < allBtns.length; i++) {
                  var text = allBtns[i].textContent.trim();
                  if (/^(确认|确定|同意|OK|Confirm|我已阅读)$/.test(text)) {
                    allBtns[i].click();
                    result.confirmed = true;
                    result.logs.push('通过文本确认: ' + text);
                    break;
                  }
                }
              }
              if (!result.confirmed) result.logs.push('未找到确认弹窗按钮');
              return result;
            })()
          `).catch(e => ({ confirmed: false, logs: ['error: ' + e.message] }))

          console.log('[SalesFetch] [BuyerInfo] 确认弹窗结果:', JSON.stringify(confirmResult))

          // 确认后等待页面更新（京东会触发API或直接在DOM更新解密信息）
          await new Promise(r => setTimeout(r, 1500))

          // 方案1：API拦截（等待解密API响应）
          const apiReady = await pollUntil(
            () => tempWin.webContents.executeJavaScript('window.__sensitiveInfoResult').catch(() => null),
            { timeout: 6000, interval: 300, label: 'API响应' }
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

          // 方案2：DOM提取（轮询模式 - 京东可能直接在页面展示解密信息）
          if (!sensitiveData) {
            console.log('[SalesFetch] [BuyerInfo] API未拦截到，轮询DOM提取解密信息...')
            const domExtractScript = `
              (function() {
                var result = { name: '', phone: '', address: '', logs: [] };
                var orderId = ${JSON.stringify(String(orderId))};

                // 策略1：查找弹出层/tooltip/popover中的解密信息
                var popoverSelectors = [
                  '.jd-popover', '.jd-tooltip__popper', '.jd-drawer', '.jd-dialog',
                  '[class*="popover"]', '[class*="tooltip"]', '[class*="popper"]',
                  '[class*="drawer"]', '[class*="modal"]', '[class*="overlay"]',
                  '[class*="consignee"]', '[class*="receiver"]', '[class*="address-info"]',
                  '[class*="sensitive"]', '[class*="decrypt"]', '[class*="detail-info"]',
                  '[class*="buyer"]', '[class*="contact"]'
                ];
                
                for (var s = 0; s < popoverSelectors.length; s++) {
                  var els = document.querySelectorAll(popoverSelectors[s]);
                  for (var e = 0; e < els.length; e++) {
                    var el = els[e];
                    var text = (el.innerText || '').trim();
                    if (text.length < 5 || text.length > 2000) continue;
                    
                    // 查找手机号（标准11位 或 虚拟号如95xxx/400xxx）
                    var phoneMatch = text.match(/(?:1[3-9]\\d{9}|95\\d{8,12}|400\\d{7}|\\d{3,4}-\\d{7,8})/);
                    if (phoneMatch) {
                      result.logs.push('弹出层命中: ' + popoverSelectors[s] + ' text=' + text.substring(0, 100));
                      result.phone = phoneMatch[0];
                      // 提取姓名和地址
                      var lines = text.split(/[\\n\\r]+/).map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
                      for (var li = 0; li < lines.length; li++) {
                        var line = lines[li];
                        if (line.match(/收货人|姓名|consignee|买家/i) && !result.name) {
                          var nameVal = line.replace(/.*[:：]\\s*/, '').trim();
                          if (nameVal.length >= 1 && nameVal.length <= 30) result.name = nameVal;
                        }
                        if (line.match(/地址|address|收货地址/i) && !result.address) {
                          var addrVal = line.replace(/.*[:：]\\s*/, '').trim();
                          if (addrVal.length >= 5) result.address = addrVal;
                        }
                        if (line.match(/电话|手机|mobile|phone|联系|虚拟号/i)) {
                          var phoneVal = line.replace(/.*[:：]\\s*/, '').trim();
                          var pMatch = phoneVal.match(/(?:1[3-9]\\d{9}|95\\d{8,12}|400\\d{7}|\\d{3,4}-\\d{7,8})/);
                          if (pMatch) result.phone = pMatch[0];
                        }
                      }
                      // 如果只找到电话没找到姓名/地址，尝试从相邻文本行提取
                      if (!result.name && lines.length >= 1) {
                        for (var li2 = 0; li2 < lines.length; li2++) {
                          var l2 = lines[li2];
                          if (l2.length >= 2 && l2.length <= 10 && !l2.match(/[0-9]/) && !l2.match(/确定|取消|查看|虚拟/)) {
                            result.name = l2;
                            break;
                          }
                        }
                      }
                      break;
                    }
                  }
                  if (result.phone) break;
                }

                // 策略2：在订单所在行/卡片中补充提取信息（姓名、地址、手机号）
                if (!result.phone || !result.name || !result.address) {
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
                        var containerPhones = containerText.match(/(?:1[3-9]\\d{9}|95\\d{8,12}|400\\d{7})/g);
                        if (containerPhones && containerPhones.length > 0) {
                          result.phone = containerPhones[0];
                          result.logs.push('容器中找到手机号: ' + result.phone);
                        }
                      }
                      // 查找不含星号的地址
                      if (!result.address) {
                        var addrMatch = containerText.match(/(?:省|市|区|县|镇|街|路|号|栋|楼|室|村|组)[^\\n*]{5,80}/);
                        if (addrMatch && addrMatch[0].indexOf('*') === -1) {
                          result.address = addrMatch[0];
                          result.logs.push('容器中找到地址: ' + result.address.substring(0, 30));
                        }
                      }
                      // 查找姓名（"买家：XXX" 或 "收货人：XXX" 格式）
                      if (!result.name) {
                        var nameMatch = containerText.match(/(?:收货人|姓名|买家)[:：\\s]*([\\u4e00-\\u9fa5a-zA-Z]{2,10})/);
                        if (nameMatch) {
                          result.name = nameMatch[1];
                          result.logs.push('容器中找到姓名: ' + result.name);
                        }
                      }
                    }
                  }
                }

                // 策略3：全页面搜索含有手机号的文本节点（放宽匹配条件）
                if (!result.phone) {
                  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
                  var node;
                  while (node = walker.nextNode()) {
                    var t = node.textContent.trim();
                    if (t.length >= 7 && t.length <= 50) {
                      // 匹配标准手机号或虚拟号
                      var pm = t.match(/^(1[3-9]\\d{9}|95\\d{8,12}|400\\d{7})$/);
                      if (pm) {
                        var parent = node.parentElement;
                        var ctx = parent ? (parent.previousElementSibling ? parent.previousElementSibling.textContent : '') + parent.textContent : '';
                        if (ctx.match(/电话|手机|联系|mobile|phone|tel|虚拟/i) || parent.className.match(/phone|mobile|contact/i)) {
                          result.phone = pm[1];
                          result.logs.push('文本节点命中: ' + pm[1] + ' ctx=' + ctx.substring(0, 40));
                          break;
                        }
                      }
                    }
                  }
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
            } else {
              console.log('[SalesFetch] [BuyerInfo] DOM提取失败:', JSON.stringify(domResult))
            }
          }

          // 方案3：全量API响应搜索（最后兜底 - 放宽匹配规则）
          if (!sensitiveData) {
            console.log('[SalesFetch] [BuyerInfo] DOM也未提取到，尝试从全量API捕获中搜索...')
            const allResponses = await tempWin.webContents.executeJavaScript('window.__allCapturedResponses || []').catch(() => [])
            console.log('[SalesFetch] [BuyerInfo] 全量捕获响应数:', allResponses.length)
            for (const resp of allResponses) {
              console.log('[SalesFetch] [BuyerInfo]   响应URL:', (resp.url || '').substring(0, 200), 'len:', (resp.body || '').length)
            }

            for (const resp of allResponses) {
              const body = resp.body || ''
              if (body.length < 30) continue
              // 匹配标准手机号或虚拟号字段（regex已确保值为纯数字，无需额外*检查）
              const phoneMatch = body.match(/"(?:mobile|phone|consMobilePhone|consigneePhone|virtualNumber|receiverMobile|virtualPhone|forwardNumber)"\s*:\s*"(\d{7,20})"/)
              if (phoneMatch) {
                try {
                  const json = JSON.parse(body)
                  console.log('[SalesFetch] [BuyerInfo] 全量搜索命中:', (resp.url || '').substring(0, 150), 'phone:', phoneMatch[1])
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
                    console.log('[SalesFetch] [BuyerInfo] 全量搜索命中(地址):', (resp.url || '').substring(0, 150))
                    sensitiveData = json
                    break
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
          return { success: false, message: '获取买家信息失败，请确保店铺已在京麦后台登录' }
        }

        const rawJson = JSON.stringify(sensitiveData)
        console.log('[SalesFetch] getSensitiveInfo result:', rawJson.substring(0, 500))

        if (sensitiveData.code && sensitiveData.code !== 0 && sensitiveData.code !== 200) {
          return { success: false, message: sensitiveData.msg || 'API错误(code=' + sensitiveData.code + ')' }
        }

        const buyerInfo = parseSensitiveInfo(sensitiveData)
        if (buyerInfo) {
          return { success: true, data: buyerInfo }
        } else {
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
function parseSensitiveInfo(json) {
  try {
    console.log('[SalesFetch] [parseSensitiveInfo] 顶层keys:', Object.keys(json))
    const data = json.data || json.result || json
    if (!data) return null
    if (typeof data === 'object' && data !== null) {
      console.log('[SalesFetch] [parseSensitiveInfo] data层keys:', Object.keys(data))
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

      // 深度递归搜索缺失字段
      if (!result.buyerName || !result.buyerPhone || !result.buyerAddress) {
        const nameKeys = ['consName', 'consigneeName', 'fullname', 'name', 'receiverName', 'buyerName']
        const phoneKeys = ['consMobilePhone', 'consigneePhone', 'mobile', 'phone', 'receiverMobile', 'buyerPhone', 'virtualNumber', 'virtualPhone', 'forwardNumber', 'transferPhone', 'vnNumber', 'contactPhone']
        const addrKeys = ['consAddress', 'consigneeAddress', 'fullAddress', 'address', 'receiverAddress', 'buyerAddress']

        function deepSearch(obj, depth) {
          if (!obj || typeof obj !== 'object' || depth > 4) return
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
