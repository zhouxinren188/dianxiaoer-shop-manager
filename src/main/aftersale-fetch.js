const { BrowserWindow, ipcMain, session, app } = require('electron')
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { getAuthToken } = require('./auth-store')
const runtimeLog = require('./runtime-logger')
const { hasValidPlatformCookies } = require('./purchase-order-sync/common')
const {
  createAftersaleAutoSync,
  DEFAULT_AFTERSALE_AUTO_SYNC_INTERVAL_MS
} = require('./aftersale-auto-sync')
const { extractMetrics } = require('./aftersale-metrics')
const { extractPendingInvoices } = require('./pending-invoices')
const {
  PENDING_METRIC_CHANNEL,
  isPendingMetricPageUrl,
  normalizePendingMetricObservation
} = require('./store-backend-pending-metrics')

const BUSINESS_SERVER = 'http://150.158.54.108:3002'
const JD_HOME_URL = 'https://shop.jd.com/jdm/home'
const JD_PENDING_INVOICE_API = 'dsm.pop.finance.vendor.spi.cinvoice.ApplyOrderDsmProvider.queryPendingReviewApplyOrderList'
const JD_PENDING_INVOICE_APP_ID = 'QDWB4GJVETRIFPT7RHSL'
const OVERALL_TIMEOUT = 60000
const activeAftersaleFetches = new Map()
let aftersaleFetchQueue = Promise.resolve()
let autoSyncController = null
let autoSyncMainWindow = null
let autoSyncToken = null
let pendingMetricListenerRegistered = false
const pendingMetricStoreByWebContentsId = new Map()
const recentPendingMetricReports = new Map()

function notifyAftersaleMetricUpdated(storeId, metric, value) {
  if (!autoSyncMainWindow || autoSyncMainWindow.isDestroyed() || autoSyncMainWindow.webContents.isDestroyed()) return
  autoSyncMainWindow.webContents.send('aftersale-metric-updated', {
    storeId: Number(storeId),
    metric,
    value: Number(value) || 0
  })
}

function getAutoSyncSettingsPath() {
  return path.join(app.getPath('userData'), 'aftersale-auto-sync-settings.json')
}

function getTokenUserKey(token) {
  try {
    const encoded = String(token || '').split('.')[1]
    if (!encoded) return ''
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'))
    const subject = String(payload.sub || '').trim()
    return subject ? crypto.createHash('sha256').update(subject).digest('hex') : ''
  } catch {
    return ''
  }
}

function readAutoSyncSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getAutoSyncSettingsPath(), 'utf8'))
    return parsed && Array.isArray(parsed.enabledUsers) ? parsed : { enabledUsers: [] }
  } catch {
    return { enabledUsers: [] }
  }
}

function isAutoSyncEnabledForToken(token) {
  const userKey = getTokenUserKey(token)
  if (!userKey) return false
  return readAutoSyncSettings().enabledUsers.includes(userKey)
}

function saveAutoSyncEnabledForToken(token, enabled) {
  const userKey = getTokenUserKey(token)
  if (!userKey) throw new Error('当前登录身份无效')
  const settings = readAutoSyncSettings()
  const enabledUsers = new Set(settings.enabledUsers)
  if (enabled) enabledUsers.add(userKey)
  else enabledUsers.delete(userKey)
  fs.writeFileSync(
    getAutoSyncSettingsPath(),
    JSON.stringify({ enabledUsers: [...enabledUsers] }, null, 2),
    'utf8'
  )
}

/**
 * API 拦截器 —— 捕获首页待办响应
 */
const AFTERSALE_INTERCEPTOR = `
(function() {
  if (window.__aftersaleInterceptorInstalled) return;
  window.__aftersaleInterceptorInstalled = true;
  window.__capturedHomeDisplay = null;

  function captureResponse(urlStr, body, transport) {
    try {
      var json = JSON.parse(body);
      if (urlStr.indexOf('findHomeDisplay') !== -1 && json && json.data && json.data.realSchedules) {
        window.__capturedHomeDisplay = json;
        console.log('[AftersaleFetch] findHomeDisplay captured (' + transport + '), categories:', json.data.realSchedules.length);
      }
    } catch(e) {
      console.log('[AftersaleFetch] parse captured response failed:', e.message);
    }
  }

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
          captureResponse(urlStr, body, 'fetch');
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
        captureResponse(xhr.__aftersaleUrl, xhr.responseText || '', 'XHR');
      });
    }
    return origSend.call(this, body);
  };
})()
`

function buildPendingInvoiceDirectQueryScript() {
  async function queryPendingInvoices(api, appId) {
    const invoicePageUrl = 'https://shop.jd.com/jdm/finance/consumerInvoice/cinvoiceOrder'
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

    function traceId() {
      if (window.crypto?.randomUUID) return window.crypto.randomUUID()
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`
    }

    function localDateTime(date) {
      const pad = value => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    async function waitForSecuritySdk(timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const config = window.__DSM_SECURITY_CONFIG || {}
        if (config.securitySdkReady) {
          try { await config.securitySdkReady } catch {}
        }
        if (typeof window.ParamsSign === 'function' && window.CryptoJS?.SHA256) return config
        await sleep(150)
      }
      throw new Error('京麦页面签名组件未就绪')
    }

    function getJsToken() {
      if (typeof window.getJsToken !== 'function') return Promise.resolve('')
      return new Promise(resolve => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          resolve('')
        }, 1500)
        try {
          window.getJsToken(result => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(result?.jsToken || '')
          }, 1200)
        } catch {
          clearTimeout(timer)
          resolve('')
        }
      })
    }

    const endTime = new Date()
    endTime.setHours(23, 59, 59, 999)
    const startTime = new Date(endTime)
    startTime.setMonth(startTime.getMonth() - 3)
    startTime.setDate(startTime.getDate() + 1)
    startTime.setHours(0, 0, 0, 0)

    const body = {
      request: {
        pageIndex: 1,
        pageSize: 10,
        orderId: null,
        invoiceTitle: null,
        invoiceTitleType: null,
        countdownDays: null,
        auditInvoiceStatus: null,
        allInvoiceStatus: null,
        invoiceType: null,
        applyTime: null,
        waitApplyTime: [startTime.toISOString(), endTime.toISOString()],
        orderCompleteTime: null,
        sourceId: null,
        userType: null,
        companyId: null,
        applyTimeOrder: 'DESC',
        countdownEndTimeSort: null,
        applyTimeStart: localDateTime(startTime),
        applyTimeEnd: localDateTime(endTime),
        orderCompleteTimeStart: null,
        orderCompleteTimeEnd: null,
        invoiceStatus: null
      },
      accessContext: {source: 'web'}
    }

    const config = await waitForSecuritySdk()
    const businessId = config.securityWhiteList?.[api] || config.defaultBusinessId || '0248a'
    const signer = new window.ParamsSign({
      appId: businessId,
      preRequest: false,
      debug: false,
      onSign() {}
    })
    const bodyText = JSON.stringify(body)
    const bodyHash = window.CryptoJS.SHA256(bodyText).toString().toUpperCase()
    const [signed, eid] = await Promise.all([
      signer.sign({body: bodyHash, appId, api, v: '1.0'}),
      getJsToken()
    ])
    if (!signed?.h5st) throw new Error('京麦未能生成待开票接口签名')

    const headers = {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json;charset=UTF-8',
      'dsm-file-path': 'lineation-price',
      'dsm-lang': 'zh-CN',
      'dsm-platform': 'pc',
      'dsm-site': '',
      'dsm-trace-id': traceId(),
      h5st: encodeURI(signed.h5st),
      'x-referer-page': invoicePageUrl,
      'x-requested-with': 'XMLHttpRequest',
      'x-rp-client': 'h5_2.4.0'
    }
    if (eid) headers['dsm-eid'] = eid

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const endpoint = `https://sff.jd.com/api?v=1.0&appId=${appId}&api=${encodeURIComponent(api)}`
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: bodyText,
        signal: controller.signal
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result?.msg || `HTTP ${response.status}`)
      if (String(result?.code) !== '200') throw new Error(result?.msg || `接口返回 ${result?.code}`)
      return result
    } finally {
      clearTimeout(timeout)
    }
  }

  return `(${queryPendingInvoices.toString()})(${JSON.stringify(JD_PENDING_INVOICE_API)}, ${JSON.stringify(JD_PENDING_INVOICE_APP_ID)})`
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

function registerStoreBackendMetricWebContents(webContents, storeId) {
  const normalizedStoreId = Number(storeId)
  if (!webContents || !Number.isSafeInteger(normalizedStoreId) || normalizedStoreId <= 0) return
  pendingMetricStoreByWebContentsId.set(webContents.id, normalizedStoreId)
  webContents.once('destroyed', () => {
    pendingMetricStoreByWebContentsId.delete(webContents.id)
  })
}

async function saveObservedPendingMetric(storeId, observation) {
  const response = await httpRequest(
    `${BUSINESS_SERVER}/api/store-aftersale-metrics/${storeId}/metric`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'jd',
        metric: observation.metric,
        value: observation.value,
        source: 'jd_list_response',
        observedAt: observation.observedAt
      })
    }
  )
  if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`)
  const result = JSON.parse(response.data)
  if (!result || result.code !== 0) throw new Error(result?.message || 'server rejected metric update')
  return result.data
}

function registerPendingMetricCaptureIpc(mainWindow) {
  if (pendingMetricListenerRegistered) return
  pendingMetricListenerRegistered = true

  ipcMain.on(PENDING_METRIC_CHANNEL, async (event, payload) => {
    const storeId = pendingMetricStoreByWebContentsId.get(event.sender.id)
    const observation = normalizePendingMetricObservation(payload)
    if (!storeId || !observation || !isPendingMetricPageUrl(observation.metric, event.sender.getURL())) return

    const reportKey = `${storeId}:${observation.metric}`
    const recent = recentPendingMetricReports.get(reportKey)
    if (recent && recent.value === observation.value && Date.now() - recent.savedAt < 5000) return

    try {
      await saveObservedPendingMetric(storeId, observation)
      recentPendingMetricReports.set(reportKey, {value: observation.value, savedAt: Date.now()})
      runtimeLog.writeLog(
        'AFTERSALE_LIVE_METRIC',
        `store_id=${storeId} metric=${observation.metric} value=${observation.value} evidence=${observation.evidence} result=success`
      )
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('aftersale-metric-updated', {
          storeId,
          metric: observation.metric,
          value: observation.value
        })
      }
    } catch (error) {
      runtimeLog.writeLog(
        'AFTERSALE_LIVE_METRIC',
        `store_id=${storeId} metric=${observation.metric} value=${observation.value} evidence=${observation.evidence} result=failed reason=${error.message}`
      )
    }
  })
}

/**
 * 抓取指定京东店铺的售后纠纷指标
 */
async function fetchAftersaleMetricsOnce(storeId) {
  const syncStartedAt = Date.now()
  runtimeLog.writeLog('AFTERSALE_SYNC', `store_id=${storeId} phase=start`)
  const partitionName = `persist:platform-${storeId}`
  const ses = session.fromPartition(partitionName)
  let cookies
  try {
    cookies = await ses.cookies.get({})
  } catch (error) {
    runtimeLog.writeLog('AFTERSALE_SYNC', `store_id=${storeId} phase=cookies result=failed reason=${error.message}`)
    return { success: false, message: '读取店铺Cookie失败: ' + error.message }
  }
  let hasValidJdCookies = hasValidPlatformCookies(cookies, 'jd')

  console.log('[AftersaleFetch] storeId:', storeId, 'partition:', partitionName)

  if (!hasValidJdCookies) {
    // 尝试从数据库恢复
    try {
      const { restoreCookiesFromDB } = require('./cookie-heartbeat')
      const restored = await restoreCookiesFromDB(storeId, { skipFlush: true })
      if (restored) {
        cookies = await ses.cookies.get({})
        hasValidJdCookies = hasValidPlatformCookies(cookies, 'jd')
        console.log('[AftersaleFetch] 从数据库恢复后Cookie:', cookies.length, 'JD有效:', hasValidJdCookies)
      }
    } catch (e) {
      console.error('[AftersaleFetch] 从数据库恢复Cookie失败:', e.message)
    }
  }

  if (!hasValidJdCookies) {
    runtimeLog.writeLog('AFTERSALE_SYNC', `store_id=${storeId} phase=cookies result=invalid`)
    return { success: false, message: '店铺没有有效京东Cookie，请先在「店铺管理」中登录京东后台' }
  }

  return new Promise(resolve => {
    let win = null
    let overallTimer = null
    let pollTimer = null
    let pollingStarted = false
    let processing = false
    let resolved = false

    function cleanup() {
      if (overallTimer) { clearTimeout(overallTimer); overallTimer = null }
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    }

    function finish(result) {
      if (resolved) return
      resolved = true
      const message = String(result?.message || '').replace(/\s+/g, '_').slice(0, 200)
      runtimeLog.writeLog(
        'AFTERSALE_SYNC',
        `store_id=${storeId} phase=finish result=${result?.success ? 'success' : 'failed'} elapsed_ms=${Date.now() - syncStartedAt}${message ? ` message=${message}` : ''}`
      )
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
        if (!win || win.isDestroyed() || resolved) return
        win.webContents.executeJavaScript(AFTERSALE_INTERCEPTOR).catch(() => {})
        console.log('[AftersaleFetch] interceptor injected')
      })

      // 检测登录页
      win.webContents.on('did-navigate', (event, url) => {
        runtimeLog.writeLog('AFTERSALE_SYNC', `store_id=${storeId} phase=navigate url=${String(url || '').slice(0, 160)}`)
        if (isLoginPage(url)) {
          finish({ success: false, message: '店铺登录已过期，请重新登录京东后台' })
        }
      })

      win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || resolved || errorCode === -3) return
        runtimeLog.writeLog(
          'AFTERSALE_SYNC',
          `store_id=${storeId} phase=page_load result=failed code=${errorCode} reason=${String(errorDescription || '').replace(/\s+/g, '_')} url=${String(validatedURL || '').slice(0, 160)}`
        )
      })

      win.webContents.on('did-finish-load', () => {
        if (!win || win.isDestroyed() || resolved) return
        const loadedUrl = win.webContents.getURL().substring(0, 160)
        console.log('[AftersaleFetch] page loaded:', loadedUrl)
        runtimeLog.writeLog('AFTERSALE_SYNC', `store_id=${storeId} phase=page_loaded url=${loadedUrl}`)
      })

      // 轮询检查 findHomeDisplay 是否被捕获
      function startPolling() {
        if (pollingStarted) return
        pollingStarted = true
        let pollCount = 0
        const maxPolls = 20

        function schedulePoll(delay) {
          if (resolved) return
          pollTimer = setTimeout(poll, delay)
        }

        async function poll() {
          pollTimer = null
          if (!win || win.isDestroyed() || resolved) return
          pollCount++

          let capturedData = null
          try {
            capturedData = await win.webContents.executeJavaScript(
              `(function() {
                if (window.__capturedHomeDisplay) {
                  var data = window.__capturedHomeDisplay;
                  window.__capturedHomeDisplay = null;
                  return data;
                }
                return null;
              })()`
            )
          } catch {
            // 页面尚未建立脚本上下文时仍继续检查 CDP 捕获结果。
          }

          if (resolved || !win || win.isDestroyed()) return
          const effectiveData = capturedData
          if (effectiveData && effectiveData.data && effectiveData.data.realSchedules) {
            runtimeLog.writeLog(
              'AFTERSALE_SYNC',
              `store_id=${storeId} phase=home_captured elapsed_ms=${Date.now() - syncStartedAt}`
            )
            processAndSave(effectiveData)
          } else if (pollCount < maxPolls) {
            schedulePoll(1000)
          } else {
            runtimeLog.writeLog(
              'AFTERSALE_SYNC',
              `store_id=${storeId} phase=home_capture result=timeout elapsed_ms=${Date.now() - syncStartedAt} url=${String(win.webContents.getURL() || '').slice(0, 160)}`
            )
            finish({ success: false, message: '未能捕获京东后台指标数据，请确保店铺已登录' })
          }
        }

        // 不等待 did-finish-load：接口通常在页面完成加载前已经返回。
        schedulePoll(1000)
      }

      async function capturePendingInvoiceDetails(metrics) {
        console.log(
          '[AftersaleFetch] calling pending invoice API for store:',
          storeId,
          'home count:',
          Number(metrics.pending_consumer_invoices || 0)
        )
        try {
          const response = await win.webContents.executeJavaScript(buildPendingInvoiceDirectQueryScript())
          const snapshot = extractPendingInvoices(response)
          console.log('[AftersaleFetch] pending invoice API returned:', snapshot.items.length, '/', snapshot.total)
          runtimeLog.writeLog(
            'AFTERSALE_SYNC',
            `store_id=${storeId} phase=invoice_api result=success total=${snapshot.total} details=${snapshot.items.length}`
          )
          return snapshot
        } catch (error) {
          console.warn('[AftersaleFetch] pending invoice API failed:', error?.message || error)
          runtimeLog.writeLog(
            'AFTERSALE_SYNC',
            `store_id=${storeId} phase=invoice_api result=failed reason=${String(error?.message || error).replace(/\s+/g, '_').slice(0, 200)}`
          )
          return null
        }
      }

      async function uploadMetrics(requestBody) {
        const resp = await httpRequest(
          `${BUSINESS_SERVER}/api/store-aftersale-metrics/${storeId}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          }
        )
        if (resp.statusCode !== 200) throw new Error(`服务器返回 ${resp.statusCode}`)
        const result = JSON.parse(resp.data)
        if (!result || result.code !== 0) {
          throw new Error(result?.message || '服务器保存售后指标失败')
        }
        notifyAftersaleMetricUpdated(
          storeId,
          'pending_consumer_invoices',
          requestBody?.metrics?.pending_consumer_invoices
        )
        return result
      }

      // 解析数据并保存到服务器
      async function processAndSave(apiResponse) {
        if (processing || resolved) return
        processing = true
        try {
          const metrics = extractMetrics(apiResponse)
          console.log('[AftersaleFetch] extracted metrics:', JSON.stringify(metrics))

          const pendingInvoiceCount = Number(metrics.pending_consumer_invoices || 0)
          const requestBody = {
            platform: 'jd',
            metrics,
            raw_data: JSON.stringify(apiResponse)
          }
          if (pendingInvoiceCount <= 0) {
            requestBody.pending_invoices = []
          }

          // 首页指标一旦捕获就先写服务器，发票详情失败不得阻塞整家店的数据更新。
          await uploadMetrics(requestBody)
          runtimeLog.writeLog(
            'AFTERSALE_SYNC',
            `store_id=${storeId} phase=metrics_uploaded invoice_count=${pendingInvoiceCount}`
          )

          if (pendingInvoiceCount <= 0) {
            console.log('[AftersaleFetch] pending invoice count is 0; skipping invoice page')
            finish({ success: true, metrics, pendingInvoiceDetails: 0 })
            return
          }

          const pendingInvoiceSnapshot = await capturePendingInvoiceDetails(metrics)
          if (!pendingInvoiceSnapshot) {
            runtimeLog.writeLog(
              'AFTERSALE_SYNC',
              `store_id=${storeId} phase=invoice_details result=not_captured invoice_count=${pendingInvoiceCount}`
            )
            finish({ success: true, metrics, pendingInvoiceDetails: null })
            return
          }

          metrics.pending_consumer_invoices = pendingInvoiceSnapshot.total
          try {
            await uploadMetrics({
              platform: 'jd',
              metrics,
              raw_data: JSON.stringify(apiResponse),
              pending_invoices: pendingInvoiceSnapshot.items
            })
            runtimeLog.writeLog(
              'AFTERSALE_SYNC',
              `store_id=${storeId} phase=invoice_details result=uploaded total=${pendingInvoiceSnapshot.total} details=${pendingInvoiceSnapshot.items.length}`
            )
            finish({
              success: true,
              metrics,
              pendingInvoiceDetails: pendingInvoiceSnapshot.items.length
            })
          } catch (invoiceSaveError) {
            runtimeLog.writeLog(
              'AFTERSALE_SYNC',
              `store_id=${storeId} phase=invoice_details result=save_failed reason=${invoiceSaveError.message}`
            )
            finish({ success: true, metrics, pendingInvoiceDetails: null })
          }
        } catch (err) {
          console.error('[AftersaleFetch] 保存失败:', err.message)
          finish({ success: false, message: '保存到服务器失败: ' + err.message })
        }
      }

      // 首页维持原有的页面接口捕获方式。只有首页响应中的 1012 大于 0，
      // 才会在 capturePendingInvoiceDetails() 内启用详情接口捕获。
      startPolling()
      win.loadURL(JD_HOME_URL).catch(error => {
        if (error && (error.code === 'ERR_ABORTED' || /ERR_ABORTED/.test(error.message || ''))) return
        finish({ success: false, message: '加载京东后台失败: ' + error.message })
      })
    } catch (err) {
      console.error('[AftersaleFetch] 创建窗口失败:', err.message)
      finish({ success: false, message: '创建窗口失败: ' + err.message })
    }
  })
}

function fetchAftersaleMetrics(storeId) {
  const key = String(storeId || '')
  const existing = activeAftersaleFetches.get(key)
  if (existing) {
    runtimeLog.writeLog('AFTERSALE_SYNC', `store_id=${key} action=reuse_inflight`)
    return existing
  }

  const task = aftersaleFetchQueue
    .catch(() => {})
    .then(() => fetchAftersaleMetricsOnce(storeId))
  aftersaleFetchQueue = task.then(() => undefined, () => undefined)
  activeAftersaleFetches.set(key, task)
  task.finally(() => {
    if (activeAftersaleFetches.get(key) === task) activeAftersaleFetches.delete(key)
  }).catch(() => {})
  return task
}

/**
 * 检查店铺是否有京东Cookie（不创建窗口，仅检查登录状态）
 */
async function checkStoreHasJdCookies(storeId) {
  const partitionName = `persist:platform-${storeId}`
  const ses = session.fromPartition(partitionName)
  let cookies = await ses.cookies.get({})
  let hasValidJdCookies = hasValidPlatformCookies(cookies, 'jd')

  if (!hasValidJdCookies) {
    try {
      const { restoreCookiesFromDB } = require('./cookie-heartbeat')
      const restored = await restoreCookiesFromDB(storeId, { skipFlush: true })
      if (restored) {
        cookies = await ses.cookies.get({})
        hasValidJdCookies = hasValidPlatformCookies(cookies, 'jd')
      }
    } catch (e) {}
  }

  return hasValidJdCookies
}

async function fetchAutoSyncJdStores() {
  const response = await httpRequest(
    `${BUSINESS_SERVER}/api/stores?page=1&pageSize=1000&platform=jd`
  )
  if (response.statusCode !== 200) {
    throw new Error(`HTTP ${response.statusCode}`)
  }

  const body = JSON.parse(response.data)
  if (!body || body.code !== 0) {
    throw new Error(body && body.message || '店铺列表响应异常')
  }

  const stores = body.data && Array.isArray(body.data.list) ? body.data.list : []
  return stores.filter(store => String(store.platform || '').toLowerCase() === 'jd')
}

function ensureAftersaleAutoSync(mainWindow) {
  autoSyncMainWindow = mainWindow || autoSyncMainWindow
  if (autoSyncController) return autoSyncController

  autoSyncController = createAftersaleAutoSync({
    intervalMs: DEFAULT_AFTERSALE_AUTO_SYNC_INTERVAL_MS,
    getToken: () => getAuthToken(),
    listStores: fetchAutoSyncJdStores,
    syncStore: storeId => fetchAftersaleMetrics(storeId),
    log: message => runtimeLog.writeLog('AFTERSALE_AUTO_SYNC', message),
    onStart: info => {
      runtimeLog.writeLog('AFTERSALE_AUTO_SYNC', `started source=${info.source}`)
      if (autoSyncMainWindow && !autoSyncMainWindow.isDestroyed() && !autoSyncMainWindow.webContents.isDestroyed()) {
        autoSyncMainWindow.webContents.send('aftersale-auto-sync-start', info)
      }
    },
    onComplete: result => {
      runtimeLog.writeLog(
        'AFTERSALE_AUTO_SYNC',
        `completed source=${result.source} total=${result.total} success=${result.successCount} failed=${result.failCount} skipped=${result.skipCount} interrupted=${result.interrupted}`
      )
      if (autoSyncMainWindow && !autoSyncMainWindow.isDestroyed() && !autoSyncMainWindow.webContents.isDestroyed()) {
        autoSyncMainWindow.webContents.send('aftersale-auto-sync-result', result)
      }
    }
  })

  return autoSyncController
}

function updateAftersaleAutoSyncAuth(token) {
  autoSyncToken = token || null
  if (!autoSyncController) return
  const enabled = !!autoSyncToken && isAutoSyncEnabledForToken(autoSyncToken)
  if (enabled) {
    runtimeLog.writeLog('AFTERSALE_AUTO_SYNC', 'auth_ready enabled=true action=schedule')
    autoSyncController.start()
  } else {
    runtimeLog.writeLog('AFTERSALE_AUTO_SYNC', `auth_ready enabled=${enabled} action=stop`)
    autoSyncController.stop()
  }
}

function stopAftersaleAutoSync() {
  autoSyncToken = null
  if (autoSyncController) autoSyncController.stop()
}

/**
 * 注册 IPC 处理器
 */
function registerAftersaleFetchIpc(mainWindow) {
  ensureAftersaleAutoSync(mainWindow)
  updateAftersaleAutoSyncAuth(getAuthToken())
  registerPendingMetricCaptureIpc(mainWindow)

  // 单店铺同步
  ipcMain.handle('fetch-aftersale-metrics', async (event, { storeId }) => {
    console.log('[AftersaleFetch IPC] 收到请求，storeId:', storeId)
    if (!storeId) {
      return { success: false, message: '请选择店铺' }
    }
    return await fetchAftersaleMetrics(storeId)
  })

  ipcMain.handle('toggle-aftersale-auto-sync', (event, { enabled }) => {
    const token = getAuthToken()
    if (!token) return { success: false, enabled: false, message: '请先登录店小二账号' }
    try {
      const wasEnabled = isAutoSyncEnabledForToken(token)
      saveAutoSyncEnabledForToken(token, !!enabled)
      updateAftersaleAutoSyncAuth(token)
      if (enabled && !wasEnabled && autoSyncController) {
        autoSyncController.run('enabled').catch(error => {
          runtimeLog.writeLog('AFTERSALE_AUTO_SYNC', `initial_run_failed reason=${error.message}`)
        })
      }
      return {
        success: true,
        enabled: !!enabled,
        running: !!(autoSyncController && autoSyncController.isRunning()),
        scheduled: !!(autoSyncController && autoSyncController.hasScheduledRun()),
        nextRunAt: autoSyncController && autoSyncController.getNextRunAt()
      }
    } catch (error) {
      runtimeLog.writeLog('AFTERSALE_AUTO_SYNC', `save_setting_failed reason=${error.message}`)
      return { success: false, enabled: isAutoSyncEnabledForToken(token), message: error.message }
    }
  })

  ipcMain.handle('aftersale-auto-sync-status', () => {
    const token = getAuthToken()
    return {
      enabled: isAutoSyncEnabledForToken(token),
      running: !!(autoSyncController && autoSyncController.isRunning()),
      scheduled: !!(autoSyncController && autoSyncController.hasScheduledRun()),
      nextRunAt: autoSyncController && autoSyncController.getNextRunAt(),
      intervalMs: DEFAULT_AFTERSALE_AUTO_SYNC_INTERVAL_MS
    }
  })

  // 批量同步：返回有Cookie的店铺ID列表，前端按此列表逐个调用单店铺同步
  ipcMain.handle('check-aftersale-sync-stores', async (event, { storeIds }) => {
    const ids = Array.isArray(storeIds) ? storeIds : []
    console.log('[AftersaleFetch IPC] 检查店铺Cookie状态，共', ids.length, '个店铺')
    const availableStores = []
    for (const storeId of ids) {
      const hasCookies = await checkStoreHasJdCookies(storeId)
      if (hasCookies) {
        availableStores.push(storeId)
      }
    }
    console.log('[AftersaleFetch IPC] 有Cookie的店铺:', availableStores.length, '个')
    return { total: ids.length, available: availableStores }
  })
}

module.exports = {
  registerAftersaleFetchIpc,
  registerStoreBackendMetricWebContents,
  updateAftersaleAutoSyncAuth,
  stopAftersaleAutoSync
}
