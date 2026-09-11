const { BrowserWindow, ipcMain, session } = require('electron')
const http = require('http')
const { getAuthToken } = require('./auth-store')
const runtimeLog = require('./runtime-logger')
const { hasValidPlatformCookies } = require('./purchase-order-sync/common')

const BUSINESS_SERVER = 'http://150.158.54.108:3002'
const FINANCE_PAGE_URL = 'https://shop.jd.com/jdm/fin/billManage/MonthlyBill'
const FINANCE_APP_ID = 'QDWB4GJVETRIFPT7RHSL'
const PENDING_API = 'dsm.pop.finance.vendor.spi.billsearch.OrderBillingDetailDsmProvider.querySumBalAndCount'
const WALLET_API = 'dsm.pop.finance.vendor.spi.homepage.HomePageDsmProvider.queryEnterpriseBalanceByVenderId'
const OVERALL_TIMEOUT = 45000
const CACHE_INTERVAL_MS = 3 * 60 * 60 * 1000

const activeWindows = new Set()
const activeStoreFetches = new Map()
let activeBatch = null

function localYmd(date) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function yesterdayYmd() {
  const date = new Date()
  date.setDate(date.getDate() - 1)
  return localYmd(date)
}

function isLoginPage(url) {
  const lower = String(url || '').toLowerCase()
  return lower.includes('passport.jd.com') || lower.includes('login.jd.com') ||
    (lower.includes('login') && lower.includes('jd.com'))
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const headers = { ...options.headers }
    const token = getAuthToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const request = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers,
      timeout: options.timeout || 15000,
      rejectUnauthorized: false
    }, response => {
      let data = ''
      response.on('data', chunk => { data += chunk })
      response.on('end', () => resolve({ statusCode: response.statusCode, data }))
    })
    request.on('error', reject)
    request.on('timeout', () => {
      request.destroy()
      reject(new Error('请求超时'))
    })
    if (options.body) request.write(options.body)
    request.end()
  })
}

function buildSettlementQueryScript(statisticsDate) {
  async function querySettlement(config) {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

    async function waitForSecuritySdk(timeoutMs = 12000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const securityConfig = window.__DSM_SECURITY_CONFIG || {}
        if (securityConfig.securitySdkReady) {
          try { await securityConfig.securitySdkReady } catch {}
        }
        if (typeof window.ParamsSign === 'function' && window.CryptoJS?.SHA256) return securityConfig
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

    function traceId() {
      if (window.crypto?.randomUUID) return window.crypto.randomUUID()
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`
    }

    const securityConfig = await waitForSecuritySdk()
    const eid = await getJsToken()

    async function post(api, body) {
      const businessId = securityConfig.securityWhiteList?.[api] || securityConfig.defaultBusinessId || '0248a'
      const signer = new window.ParamsSign({ appId: businessId, preRequest: false, debug: false, onSign() {} })
      const bodyText = JSON.stringify(body)
      const bodyHash = window.CryptoJS.SHA256(bodyText).toString().toUpperCase()
      const signed = await signer.sign({ body: bodyHash, appId: config.appId, api, v: '1.0' })
      if (!signed?.h5st) throw new Error('京麦未能生成结算接口签名')

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      try {
        const response = await fetch(`https://sff.jd.com/api?v=1.0&appId=${config.appId}&api=${encodeURIComponent(api)}`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json;charset=UTF-8',
            'dsm-lang': 'zh_CN',
            'dsm-language': 'zh_CN',
            'dsm-platform': 'pc',
            'dsm-trace-id': traceId(),
            h5st: encodeURI(signed.h5st),
            'x-requested-with': 'XMLHttpRequest',
            ...(eid ? { 'dsm-eid': eid } : {})
          },
          body: bodyText,
          signal: controller.signal
        })
        const result = await response.json()
        if (!response.ok) throw new Error(result?.msg || `HTTP ${response.status}`)
        if (String(result?.code) !== '200') throw new Error(result?.msg || `接口返回 ${result?.code}`)
        return result
      } finally {
        clearTimeout(timer)
      }
    }

    const pendingBody = { queryVo: { settleStatus: 1 }, accessContext: { source: 'web' } }
    const yesterdayBody = {
      queryVo: {
        settleStatus: 2,
        happenTimeE: `${config.statisticsDate} 23:59:59`,
        finishTimeS: `${config.statisticsDate} 00:00:00`
      },
      accessContext: { source: 'web' }
    }
    const walletBody = { accessContext: { source: 'web' } }
    const [pending, yesterday, wallet] = await Promise.all([
      post(config.pendingApi, pendingBody),
      post(config.pendingApi, yesterdayBody),
      post(config.walletApi, walletBody)
    ])
    return { pending, yesterday, wallet }
  }

  return `(async function() {
    try {
      var response = await (${querySettlement.toString()})(${JSON.stringify({
        appId: FINANCE_APP_ID,
        pendingApi: PENDING_API,
        walletApi: WALLET_API,
        statisticsDate
      })});
      return { ok: true, response: response };
    } catch (error) {
      return { ok: false, error: String(error && error.message || error || 'unknown error') };
    }
  })()`
}

function apiData(response) {
  const data = response && response.data
  return data && typeof data === 'object' ? data : {}
}

function requireNonNegativeNumber(value, field) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error(`${field} 返回值无效`)
  return number
}

async function uploadSettlementMetrics(storeId, metrics) {
  const response = await httpRequest(`${BUSINESS_SERVER}/api/store-settlement-metrics/${storeId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metrics)
  })
  if (response.statusCode !== 200) throw new Error(`服务器保存结算数据失败（HTTP ${response.statusCode}）`)
  const body = JSON.parse(response.data)
  if (!body || body.code !== 0) throw new Error(body?.message || '服务器拒绝保存结算数据')
}

async function fetchSettlementForStoreOnce(storeId) {
  const startedAt = Date.now()
  const partition = `persist:platform-${storeId}`
  const storeSession = session.fromPartition(partition)
  let cookies = await storeSession.cookies.get({})
  if (!hasValidPlatformCookies(cookies, 'jd')) {
    try {
      const { restoreCookiesFromDB } = require('./cookie-heartbeat')
      await restoreCookiesFromDB(storeId, { skipFlush: true, context: 'settlement' })
      cookies = await storeSession.cookies.get({})
    } catch {}
  }
  if (!hasValidPlatformCookies(cookies, 'jd')) {
    return { success: false, skipped: true, storeId, message: '店铺登录已失效' }
  }

  return new Promise(resolve => {
    let settled = false
    let window = null
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (window && !window.isDestroyed()) window.destroy()
      activeWindows.delete(window)
      runtimeLog.writeLog(
        'SETTLEMENT_SYNC',
        `store_id=${storeId} result=${result.success ? 'success' : 'failed'} elapsed_ms=${Date.now() - startedAt} message=${String(result.message || 'none').replace(/\s+/g, '_').slice(0, 160)}`
      )
      resolve(result)
    }
    const timer = setTimeout(() => finish({ success: false, storeId, message: '获取订单结算数据超时' }), OVERALL_TIMEOUT)

    try {
      window = new BrowserWindow({
        show: false,
        width: 1100,
        height: 760,
        webPreferences: {
          partition,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false
        }
      })
      activeWindows.add(window)
      window.webContents.setBackgroundThrottling(false)
      window.webContents.on('did-navigate', (_event, url) => {
        if (isLoginPage(url)) finish({ success: false, skipped: true, storeId, message: '店铺登录已过期' })
      })
      window.webContents.once('did-finish-load', async () => {
        if (settled || !window || window.isDestroyed()) return
        try {
          if (isLoginPage(window.webContents.getURL())) throw new Error('店铺登录已过期')
          const execution = await window.webContents.executeJavaScript(buildSettlementQueryScript(yesterdayYmd()))
          if (!execution?.ok) throw new Error(execution?.error || '结算接口未返回结果')
          const pending = apiData(execution.response.pending)
          const yesterday = apiData(execution.response.yesterday)
          const wallet = apiData(execution.response.wallet)
          const walletBalance = requireNonNegativeNumber(wallet.totalBalance, '钱包余额')
          const frozenAmount = requireNonNegativeNumber(wallet.unAvalibleBalance, '冻结金额')
          const metrics = {
            pendingAmount: requireNonNegativeNumber(pending.settleBal, '待结算金额'),
            pendingOrderCount: Math.trunc(requireNonNegativeNumber(pending.count, '待结算订单数')),
            yesterdaySettledAmount: requireNonNegativeNumber(yesterday.settleBal, '昨日到账'),
            walletBalance,
            frozenAmount,
            withdrawableAmount: Math.max(0, walletBalance - frozenAmount),
            statisticsDate: yesterdayYmd()
          }
          await uploadSettlementMetrics(storeId, metrics)
          finish({ success: true, storeId, metrics })
        } catch (error) {
          finish({ success: false, storeId, message: error.message })
        }
      })
      window.loadURL(FINANCE_PAGE_URL).catch(error => {
        if (!/ERR_ABORTED/.test(error?.message || '')) finish({ success: false, storeId, message: error.message })
      })
    } catch (error) {
      finish({ success: false, storeId, message: error.message })
    }
  })
}

function fetchSettlementForStore(storeId) {
  const key = String(storeId)
  if (activeStoreFetches.has(key)) return activeStoreFetches.get(key)
  const task = fetchSettlementForStoreOnce(storeId)
  activeStoreFetches.set(key, task)
  task.finally(() => activeStoreFetches.delete(key)).catch(() => {})
  return task
}

async function fetchEnabledJdStores() {
  const response = await httpRequest(`${BUSINESS_SERVER}/api/stores?page=1&pageSize=1000&platform=jd&status=enabled`)
  if (response.statusCode !== 200) throw new Error(`读取京东店铺失败（HTTP ${response.statusCode}）`)
  const body = JSON.parse(response.data)
  if (!body || body.code !== 0) throw new Error(body?.message || '京东店铺列表响应异常')
  const stores = Array.isArray(body.data?.list) ? body.data.list : []
  return stores.filter(store => String(store.platform || '').toLowerCase() === 'jd' && store.status === 'enabled')
}

async function hasFreshServerSnapshot() {
  try {
    const response = await httpRequest(`${BUSINESS_SERVER}/api/settlement-overview`)
    if (response.statusCode !== 200) return false
    const body = JSON.parse(response.data)
    const summary = body?.code === 0 ? body.data?.summary : null
    const updatedAt = new Date(summary?.updatedAt).getTime()
    return Number(summary?.storeCount) > 0 &&
      Number(summary?.matchedStoreCount) === Number(summary?.storeCount) &&
      Number(summary?.yesterdayMatchedStoreCount) === Number(summary?.storeCount) &&
      Number(summary?.staleStoreCount) === 0 &&
      Number.isFinite(updatedAt) && Date.now() - updatedAt < CACHE_INTERVAL_MS
  } catch {
    return false
  }
}

async function runSettlementBatch(force = false) {
  if (!getAuthToken()) return { success: false, message: '请先登录店小二账号' }
  if (!force && await hasFreshServerSnapshot()) return { success: true, skipped: true, reason: 'fresh' }
  const stores = await fetchEnabledJdStores()
  const results = []
  for (const store of stores) results.push(await fetchSettlementForStore(store.id))
  return {
    success: results.some(item => item.success) || stores.length === 0,
    total: stores.length,
    successCount: results.filter(item => item.success).length,
    skippedCount: results.filter(item => item.skipped).length,
    failCount: results.filter(item => !item.success && !item.skipped).length,
    results
  }
}

function syncSettlementOverview(force = false) {
  if (activeBatch) return activeBatch
  activeBatch = runSettlementBatch(force).finally(() => { activeBatch = null })
  return activeBatch
}

function registerSettlementFetchIpc(mainWindow) {
  ipcMain.handle('sync-settlement-overview', async (_event, options = {}) => {
    const result = await syncSettlementOverview(options.force === true)
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('settlement-overview-updated', result)
    }
    return result
  })
}

function closeAllSettlementWindows() {
  for (const window of activeWindows) {
    try { if (!window.isDestroyed()) window.destroy() } catch {}
  }
  activeWindows.clear()
}

module.exports = {
  buildSettlementQueryScript,
  closeAllSettlementWindows,
  registerSettlementFetchIpc,
  syncSettlementOverview
}
