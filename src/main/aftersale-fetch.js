const { BrowserWindow, ipcMain, session } = require('electron')
const http = require('http')
const { getAuthToken } = require('./auth-store')

const BUSINESS_SERVER = 'http://150.158.54.108:3002'
const JD_HOME_URL = 'https://shop.jd.com/'
const OVERALL_TIMEOUT = 60000

// 京东 findHomeDisplay API 中各指标的 ID 映射
const JD_METRIC_MAP = {
  // 订单类 (category id: 101)
  1006: 'overdue_orders',       // 发货超时
  1003: 'pending_follow_ups',   // 待回复催单
  // 售后类 (category id: 102)
  3001: 'cancelled_orders',               // 取消订单
  3002: 'pending_review_aftersales',      // 待审核售后
  3003: 'pending_receive_aftersales',     // 待收货售后
  3004: 'pending_process_aftersales',     // 待处理售后
  3007: 'pending_task_orders',            // 任务工单
  // 纠纷类 (category id: 103)
  4001: 'pending_reply_disputes',    // 待回复纠纷
  4002: 'pending_evidence_disputes', // 待举证纠纷
  4003: 'pending_execute_disputes',  // 待执行纠纷
  4005: 'pending_compensation',      // 待处理赔付
  // 合规类 (category id: 106)
  7010: 'pending_warnings',               // 待处理预警单
  7004: 'pending_violations',             // 待处理违约单
  7011: 'pending_industry_complaints',    // 待处理工商投诉
}

/**
 * API 拦截器 —— 仅捕获 findHomeDisplay API 响应
 */
const AFTERSALE_INTERCEPTOR = `
(function() {
  if (window.__aftersaleInterceptorInstalled) return;
  window.__aftersaleInterceptorInstalled = true;
  window.__capturedHomeDisplay = null;

  // 覆盖 document visibility，确保后台页面正常加载
  try {
    Object.defineProperty(document, 'hidden', { get: function() { return false; }, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: function() { return 'visible'; }, configurable: true });
    document.hasFocus = function() { return true; };
  } catch(e) {}

  // 拦截 fetch
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    var urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    return origFetch.call(this, input, init).then(function(response) {
      if (urlStr.indexOf('findHomeDisplay') !== -1) {
        var cloned = response.clone();
        cloned.text().then(function(body) {
          try {
            var json = JSON.parse(body);
            if (json && json.data && json.data.realSchedules) {
              window.__capturedHomeDisplay = json;
              console.log('[AftersaleFetch] findHomeDisplay captured, categories:', json.data.realSchedules.length);
            }
          } catch(e) {
            console.log('[AftersaleFetch] parse findHomeDisplay failed:', e.message);
          }
        }).catch(function(){});
      }
      return response;
    });
  };

  // 拦截 XMLHttpRequest
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__aftersaleUrl = (url || '').toString();
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    var xhr = this;
    if (xhr.__aftersaleUrl && xhr.__aftersaleUrl.indexOf('findHomeDisplay') !== -1) {
      xhr.addEventListener('load', function() {
        try {
          var respBody = xhr.responseText || '';
          var json = JSON.parse(respBody);
          if (json && json.data && json.data.realSchedules) {
            window.__capturedHomeDisplay = json;
            console.log('[AftersaleFetch] findHomeDisplay captured (XHR), categories:', json.data.realSchedules.length);
          }
        } catch(e) {
          console.log('[AftersaleFetch] parse findHomeDisplay XHR failed:', e.message);
        }
      });
    }
    return origSend.call(this, body);
  };
})()
`

/**
 * 从 findHomeDisplay 响应中提取指标数据
 */
function extractMetrics(apiResponse) {
  const schedules = apiResponse.data.realSchedules || []
  const metrics = {}

  for (const category of schedules) {
    for (const item of category.data || []) {
      const field = JD_METRIC_MAP[item.id]
      if (field) {
        metrics[field] = parseInt(item.value || '0', 10)
      }
    }
  }

  return metrics
}

function isLoginPage(url) {
  const lower = url.toLowerCase()
  return lower.includes('passport.jd.com') || lower.includes('login.jd.com') ||
    (lower.includes('login') && lower.includes('jd.com'))
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const token = getAuthToken()
    const headers = { ...options.headers }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers,
      timeout: 10000,
      rejectUnauthorized: false
    }

    const req = http.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, data }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
    if (options.body) req.write(options.body)
    req.end()
  })
}

/**
 * 抓取指定京东店铺的售后纠纷指标
 */
function fetchAftersaleMetrics(storeId) {
  return new Promise(async (resolve) => {
    const partitionName = `persist:platform-${storeId}`
    const ses = session.fromPartition(partitionName)
    let cookies = await ses.cookies.get({})
    let jdCookies = cookies.filter(c => c.domain && (c.domain.includes('jd.com') || c.domain.includes('jd.hk')))

    console.log('[AftersaleFetch] storeId:', storeId, 'partition:', partitionName)

    if (jdCookies.length === 0) {
      // 尝试从数据库恢复
      try {
        const { restoreCookiesFromDB } = require('./cookie-heartbeat')
        const restored = await restoreCookiesFromDB(storeId, { skipFlush: true })
        if (restored) {
          cookies = await ses.cookies.get({})
          jdCookies = cookies.filter(c => c.domain && (c.domain.includes('jd.com') || c.domain.includes('jd.hk')))
          console.log('[AftersaleFetch] 从数据库恢复后Cookie:', cookies.length, 'JD:', jdCookies.length)
        }
      } catch (e) {
        console.error('[AftersaleFetch] 从数据库恢复Cookie失败:', e.message)
      }
    }

    if (jdCookies.length === 0) {
      return resolve({ success: false, message: '店铺没有京东Cookie，请先在「店铺管理」中登录京东后台' })
    }

    let win = null
    let overallTimer = null
    let resolved = false

    function cleanup() {
      if (overallTimer) { clearTimeout(overallTimer); overallTimer = null }
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    }

    function finish(result) {
      if (resolved) return
      resolved = true
      cleanup()
      resolve(result)
    }

    overallTimer = setTimeout(() => {
      finish({ success: false, message: '获取售后指标超时' })
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

      // 注入拦截器
      win.webContents.on('dom-ready', () => {
        if (win.isDestroyed() || resolved) return
        win.webContents.executeJavaScript(AFTERSALE_INTERCEPTOR).catch(() => {})
        console.log('[AftersaleFetch] interceptor injected')
      })

      // 检测登录页
      win.webContents.on('did-navigate', (event, url) => {
        if (isLoginPage(url)) {
          finish({ success: false, message: '店铺登录已过期，请重新登录京东后台' })
        }
      })

      // 页面加载后开始轮询捕获的数据
      win.webContents.on('did-finish-load', () => {
        if (win.isDestroyed() || resolved) return
        console.log('[AftersaleFetch] page loaded:', win.webContents.getURL().substring(0, 100))
        startPolling()
      })

      // 轮询检查 findHomeDisplay 是否被捕获
      function startPolling() {
        let pollCount = 0
        const maxPolls = 30 // 最多轮询30次，每次2秒

        function poll() {
          if (win.isDestroyed() || resolved) return
          pollCount++

          win.webContents.executeJavaScript(
            `(function() {
              if (window.__capturedHomeDisplay) {
                var data = window.__capturedHomeDisplay;
                window.__capturedHomeDisplay = null;
                return data;
              }
              return null;
            })()`
          ).then(capturedData => {
            if (capturedData && capturedData.data && capturedData.data.realSchedules) {
              console.log('[AftersaleFetch] findHomeDisplay 数据已捕获')
              processAndSave(capturedData)
            } else if (pollCount < maxPolls) {
              setTimeout(poll, 2000)
            } else {
              finish({ success: false, message: '未能捕获京东后台指标数据，请确保店铺已登录' })
            }
          }).catch(() => {
            if (pollCount < maxPolls) {
              setTimeout(poll, 2000)
            } else {
              finish({ success: false, message: '轮询超时' })
            }
          })
        }

        // 首次轮询延迟5秒，等待页面完全加载和API调用
        setTimeout(poll, 5000)
      }

      // 解析数据并保存到服务器
      async function processAndSave(apiResponse) {
        try {
          const metrics = extractMetrics(apiResponse)
          console.log('[AftersaleFetch] extracted metrics:', JSON.stringify(metrics))

          // 发送到服务器
          const resp = await httpRequest(
            `${BUSINESS_SERVER}/api/store-aftersale-metrics/${storeId}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                platform: 'jd',
                metrics,
                raw_data: JSON.stringify(apiResponse)
              })
            }
          )

          if (resp.statusCode === 200) {
            const result = JSON.parse(resp.data)
            console.log('[AftersaleFetch] server response:', result.code, result.message || '')
            finish({ success: true, metrics })
          } else {
            finish({ success: false, message: `服务器返回 ${resp.statusCode}` })
          }
        } catch (err) {
          console.error('[AftersaleFetch] 保存失败:', err.message)
          finish({ success: false, message: '保存到服务器失败: ' + err.message })
        }
      }

      // 加载京东商家后台首页
      win.loadURL(JD_HOME_URL)
    } catch (err) {
      console.error('[AftersaleFetch] 创建窗口失败:', err.message)
      finish({ success: false, message: '创建窗口失败: ' + err.message })
    }
  })
}

/**
 * 检查店铺是否有京东Cookie（不创建窗口，仅检查登录状态）
 */
async function checkStoreHasJdCookies(storeId) {
  const partitionName = `persist:platform-${storeId}`
  const ses = session.fromPartition(partitionName)
  let cookies = await ses.cookies.get({})
  let jdCookies = cookies.filter(c => c.domain && (c.domain.includes('jd.com') || c.domain.includes('jd.hk')))

  if (jdCookies.length === 0) {
    try {
      const { restoreCookiesFromDB } = require('./cookie-heartbeat')
      const restored = await restoreCookiesFromDB(storeId, { skipFlush: true })
      if (restored) {
        cookies = await ses.cookies.get({})
        jdCookies = cookies.filter(c => c.domain && (c.domain.includes('jd.com') || c.domain.includes('jd.hk')))
      }
    } catch (e) {}
  }

  return jdCookies.length > 0
}

/**
 * 注册 IPC 处理器
 */
function registerAftersaleFetchIpc(mainWindow) {
  // 单店铺同步
  ipcMain.handle('fetch-aftersale-metrics', async (event, { storeId }) => {
    console.log('[AftersaleFetch IPC] 收到请求，storeId:', storeId)
    if (!storeId) {
      return { success: false, message: '请选择店铺' }
    }
    return await fetchAftersaleMetrics(storeId)
  })

  // 批量同步：返回有Cookie的店铺ID列表，前端按此列表逐个调用单店铺同步
  ipcMain.handle('check-aftersale-sync-stores', async (event, { storeIds }) => {
    console.log('[AftersaleFetch IPC] 检查店铺Cookie状态，共', storeIds.length, '个店铺')
    const availableStores = []
    for (const storeId of storeIds) {
      const hasCookies = await checkStoreHasJdCookies(storeId)
      if (hasCookies) {
        availableStores.push(storeId)
      }
    }
    console.log('[AftersaleFetch IPC] 有Cookie的店铺:', availableStores.length, '个')
    return { total: storeIds.length, available: availableStores }
  })
}

module.exports = { registerAftersaleFetchIpc }