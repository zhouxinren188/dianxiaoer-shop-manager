'use strict'

// These functions run inside a JD BrowserWindow, not in the Electron main process.
// The production main process is compiled with bytenode, where Function#toString()
// returns "[native code]". Keep the injected source as literals so development and
// packaged builds send exactly the same JavaScript to the page.
const SETTLEMENT_QUERY_RENDERER_SOURCE = String.raw`(async function querySettlement(config) {
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
    return String(Date.now()) + '-' + Math.random().toString(36).slice(2)
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
      const endpoint = 'https://sff.jd.com/api?v=1.0&appId=' + config.appId + '&api=' + encodeURIComponent(api)
      const headers = {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json;charset=UTF-8',
        'dsm-lang': 'zh_CN',
        'dsm-language': 'zh_CN',
        'dsm-platform': 'pc',
        'dsm-trace-id': traceId(),
        h5st: encodeURI(signed.h5st),
        'x-requested-with': 'XMLHttpRequest'
      }
      if (eid) headers['dsm-eid'] = eid

      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: bodyText,
        signal: controller.signal
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result?.msg || 'HTTP ' + response.status)
      if (String(result?.code) !== '200') throw new Error(result?.msg || '接口返回 ' + result?.code)
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  const pendingBody = { queryVo: { settleStatus: 1 }, accessContext: { source: 'web' } }
  const yesterdayBody = {
    queryVo: {
      settleStatus: 2,
      happenTimeE: config.statisticsDate + ' 23:59:59',
      finishTimeS: config.statisticsDate + ' 00:00:00'
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
})`

const PENDING_INVOICE_QUERY_RENDERER_SOURCE = String.raw`(async function queryPendingInvoices(api, appId) {
  const invoicePageUrl = 'https://shop.jd.com/jdm/finance/consumerInvoice/cinvoiceOrder'
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

  function traceId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID()
    return String(Date.now()) + '-' + Math.random().toString(36).slice(2)
  }

  function localDateTime(date) {
    const pad = value => String(value).padStart(2, '0')
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
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
    accessContext: { source: 'web' }
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
    signer.sign({ body: bodyHash, appId, api, v: '1.0' }),
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
    const endpoint = 'https://sff.jd.com/api?v=1.0&appId=' + appId + '&api=' + encodeURIComponent(api)
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: bodyText,
      signal: controller.signal
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result?.msg || 'HTTP ' + response.status)
    if (String(result?.code) !== '200') throw new Error(result?.msg || '接口返回 ' + result?.code)
    return result
  } finally {
    clearTimeout(timeout)
  }
})`

module.exports = {
  PENDING_INVOICE_QUERY_RENDERER_SOURCE,
  SETTLEMENT_QUERY_RENDERER_SOURCE
}
