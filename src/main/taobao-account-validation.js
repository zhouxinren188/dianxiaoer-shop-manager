const crypto = require('crypto')
const http = require('http')
const { getAuthToken } = require('./auth-store')
const runtimeLog = require('./runtime-logger')

const BUSINESS_SERVER = 'http://150.158.54.108:3002'
const TAOBAO_USER_SIMPLE_API = 'mtop.user.getUserSimple'
const TAOBAO_USER_SIMPLE_APP_KEY = '12574478'
const TAOBAO_USER_SIMPLE_DATA = '{}'
const TAOBAO_USER_SIMPLE_URL = 'https://h5api.m.taobao.com/h5/mtop.user.getusersimple/1.0/'
const TAOBAO_VALIDATION_SUCCESS_TTL = 5 * 60 * 1000
const TAOBAO_VALIDATION_FAILURE_TTL = 15 * 1000
const TAOBAO_VALIDATION_TIMEOUT = 8000
const TAOBAO_IDENTITY_COOKIE_NAMES = new Set([
  'unb', 'cookie17', 'cookie2', 'tracknick', 'lgc', '_m_h5_tk', '_m_h5_tk_enc'
])
const TAOBAO_LOGIN_COOKIE_NAMES = new Set(['unb', 'cookie17', 'cookie2'])

const validationCache = new Map()
const validationTasks = new Map()

function isTaobaoCookieDomain(domain) {
  const normalized = String(domain || '').replace(/^\./, '').toLowerCase()
  return normalized === 'taobao.com' ||
    normalized.endsWith('.taobao.com') ||
    normalized === 'tmall.com' ||
    normalized.endsWith('.tmall.com') ||
    normalized === 'tmall.hk' ||
    normalized.endsWith('.tmall.hk')
}

function isCookieExpired(cookie, nowSeconds = Date.now() / 1000) {
  return !!(cookie?.expirationDate && cookie.expirationDate > 0 && cookie.expirationDate <= nowSeconds)
}

function createTaobaoCookieFingerprint(cookies) {
  const serialized = (cookies || [])
    .filter(cookie =>
      cookie &&
      TAOBAO_IDENTITY_COOKIE_NAMES.has(String(cookie.name || '')) &&
      isTaobaoCookieDomain(cookie.domain) &&
      !isCookieExpired(cookie)
    )
    .map(cookie => [
      String(cookie.name || ''),
      String(cookie.domain || '').replace(/^\./, '').toLowerCase(),
      String(cookie.path || '/'),
      String(cookie.value || '')
    ].join('@'))
    .sort()
    .join('|')
  return serialized ? crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16) : ''
}

function hasTaobaoLoginCookie(cookies) {
  return (cookies || []).some(cookie =>
    cookie &&
    TAOBAO_LOGIN_COOKIE_NAMES.has(String(cookie.name || '')) &&
    isTaobaoCookieDomain(cookie.domain) &&
    !!String(cookie.value || '') &&
    !isCookieExpired(cookie)
  )
}

function selectTaobaoMtopToken(cookies) {
  const candidates = (cookies || [])
    .filter(cookie =>
      cookie &&
      cookie.name === '_m_h5_tk' &&
      isTaobaoCookieDomain(cookie.domain) &&
      !isCookieExpired(cookie)
    )
    .sort((left, right) => {
      const leftExact = String(left.domain || '').replace(/^\./, '') === 'h5api.m.taobao.com' ? 1 : 0
      const rightExact = String(right.domain || '').replace(/^\./, '') === 'h5api.m.taobao.com' ? 1 : 0
      return rightExact - leftExact || String(right.path || '').length - String(left.path || '').length
    })
  const value = String(candidates[0]?.value || '')
  return value ? value.split('_')[0] : ''
}

function buildTaobaoUserSimpleRequest(token, timestamp = Date.now()) {
  const t = String(timestamp)
  const signInput = `${String(token || '')}&${t}&${TAOBAO_USER_SIMPLE_APP_KEY}&${TAOBAO_USER_SIMPLE_DATA}`
  const sign = crypto.createHash('md5').update(signInput).digest('hex')
  const query = new URLSearchParams({
    jsv: '2.7.2',
    appKey: TAOBAO_USER_SIMPLE_APP_KEY,
    t,
    sign,
    jsonpIncPrefix: 'tbnavnew',
    api: TAOBAO_USER_SIMPLE_API,
    v: '1.0',
    dataType: 'json',
    type: 'originaljson',
    data: TAOBAO_USER_SIMPLE_DATA
  })
  return {
    timestamp: Number(timestamp),
    sign,
    url: `${TAOBAO_USER_SIMPLE_URL}?${query.toString()}`
  }
}

function parseMtopJson(text) {
  const value = String(text || '').trim()
  if (!value) throw new Error('淘宝接口返回空响应')
  try {
    return JSON.parse(value)
  } catch (_) {
    const start = value.indexOf('(')
    const end = value.lastIndexOf(')')
    if (start >= 0 && end > start) return JSON.parse(value.slice(start + 1, end))
    throw new Error('淘宝接口返回无法识别的数据')
  }
}

function findFirstValue(source, keys, depth = 0) {
  if (!source || typeof source !== 'object' || depth > 4) return ''
  const entries = Object.entries(source)
  const normalizedKeys = new Set(keys.map(key => key.toLowerCase()))
  for (const [key, value] of entries) {
    if (!normalizedKeys.has(String(key).toLowerCase())) continue
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim()
  }
  for (const [, value] of entries) {
    if (value && typeof value === 'object') {
      const nested = findFirstValue(value, keys, depth + 1)
      if (nested) return nested
    }
  }
  return ''
}

function findLoginFlag(source, depth = 0) {
  if (!source || typeof source !== 'object' || depth > 4) return null
  for (const [key, value] of Object.entries(source)) {
    if (!['islogin', 'login', 'logined', 'loggedin'].includes(String(key).toLowerCase())) continue
    if (value === true || value === 1 || /^(true|1|yes)$/i.test(String(value))) return true
    if (value === false || value === 0 || /^(false|0|no)$/i.test(String(value))) return false
  }
  for (const value of Object.values(source)) {
    if (value && typeof value === 'object') {
      const nested = findLoginFlag(value, depth + 1)
      if (nested !== null) return nested
    }
  }
  return null
}

function extractTaobaoSimpleUser(payload) {
  const data = payload && typeof payload.data === 'object' ? payload.data : {}
  return {
    userId: findFirstValue(data, ['userId', 'user_id', 'userid', 'uid', 'unb']),
    nick: findFirstValue(data, ['nick', 'nickname', 'nickName', 'displayNick', 'loginNick']),
    isLogin: findLoginFlag(data)
  }
}

function taobaoRetText(payload) {
  const ret = payload?.ret
  if (Array.isArray(ret)) return ret.join(' | ')
  return String(ret || payload?.message || payload?.msg || '')
}

function classifyTaobaoUserSimpleResponse(payload) {
  const retText = taobaoRetText(payload)
  const user = extractTaobaoSimpleUser(payload)
  const success = /(?:^|\|\s*)SUCCESS(?:::|\s|$)/i.test(retText)

  if (success && user.isLogin !== false && (user.userId || user.nick)) {
    return { status: 'valid', reason: 'api_success', userId: user.userId, nick: user.nick, retText }
  }
  if (user.isLogin === false || /SESSION_EXPIRED|FAIL_SYS_SESSION_EXPIRED|NEED_LOGIN|NOT_LOGIN|LOGIN_REQUIRED/i.test(retText)) {
    return { status: 'invalid', reason: 'session_expired', userId: '', nick: '', retText }
  }
  if (/RGV587|FAIL_SYS_USER_VALIDATE|USER_VALIDATE/i.test(retText)) {
    return { status: 'risk', reason: 'security_verification', userId: '', nick: '', retText }
  }
  if (/TOKEN_(?:EMPTY|EXPIRED|ILLEGAL)|FAIL_SYS_TOKEN/i.test(retText)) {
    return { status: 'token', reason: 'token_unavailable', userId: '', nick: '', retText }
  }
  if (/被挤爆|SYSTEM_BUSY|SERVICE_UNAVAILABLE|FAIL_SYS_TRAFFIC_LIMIT|TIMEOUT/i.test(retText)) {
    return { status: 'unknown', reason: 'taobao_busy', userId: '', nick: '', retText }
  }
  if (success) {
    return { status: 'unknown', reason: 'success_without_identity', userId: '', nick: '', retText }
  }
  return { status: 'unknown', reason: 'unrecognized_response', userId: '', nick: '', retText }
}

function sanitizeReason(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, 120)
}

function statusCacheTtl(status) {
  return status === 'valid' ? TAOBAO_VALIDATION_SUCCESS_TTL : TAOBAO_VALIDATION_FAILURE_TTL
}

function invalidateTaobaoAccountValidation(accountId) {
  validationCache.delete(String(accountId || ''))
}

async function reportTaobaoAccountValidation(accountId, result) {
  const token = getAuthToken()
  if (!token || !accountId) return { success: false, reason: 'missing_auth' }
  const body = JSON.stringify({
    status: result.status,
    reason: sanitizeReason(result.reason),
    taobao_user_id: result.userId || '',
    taobao_nick: result.nick || ''
  })
  return new Promise(resolve => {
    const req = http.request({
      hostname: '150.158.54.108',
      port: 3002,
      path: `/api/purchase-accounts/${encodeURIComponent(accountId)}/cookie-validation`,
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 5000
    }, res => {
      let responseText = ''
      res.on('data', chunk => { responseText += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseText || '{}')
          const data = parsed?.data || {}
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed?.code === 0) {
            resolve({ success: true, result: data })
          } else {
            resolve({ success: false, reason: `http_${res.statusCode}`, message: parsed?.message || '' })
          }
        } catch (_) {
          resolve({ success: false, reason: `http_${res.statusCode}` })
        }
      })
    })
    req.on('error', error => resolve({ success: false, reason: 'network_error', message: error.message }))
    req.on('timeout', () => { req.destroy(); resolve({ success: false, reason: 'timeout' }) })
    req.end(body)
  })
}

async function persistTaobaoSessionCookies(accountId, ses) {
  const token = getAuthToken()
  if (!token || !accountId || !ses) return { success: false, reason: 'missing_context' }
  try {
    const cookies = await ses.cookies.get({})
    if (!cookies.length) return { success: false, reason: 'empty_cookies' }
    const body = JSON.stringify({
      cookie_data: JSON.stringify(cookies),
      platform: 'taobao'
    })
    return await new Promise(resolve => {
      const req = http.request({
        hostname: '150.158.54.108',
        port: 3002,
        path: `/api/purchase-accounts/${encodeURIComponent(accountId)}/cookies`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 5000
      }, res => {
        let responseText = ''
        res.on('data', chunk => { responseText += chunk })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseText || '{}')
            resolve({
              success: res.statusCode >= 200 && res.statusCode < 300 && parsed?.code === 0,
              reason: `http_${res.statusCode}`,
              count: cookies.length
            })
          } catch (_) {
            resolve({ success: false, reason: `http_${res.statusCode}` })
          }
        })
      })
      req.on('error', error => resolve({ success: false, reason: 'network_error', message: error.message }))
      req.on('timeout', () => { req.destroy(); resolve({ success: false, reason: 'timeout' }) })
      req.end(body)
    })
  } catch (error) {
    return { success: false, reason: 'cookie_read_error', message: error.message }
  }
}

async function fetchTaobaoUserSimple(ses, token) {
  const request = buildTaobaoUserSimpleRequest(token)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TAOBAO_VALIDATION_TIMEOUT)
  try {
    const chromeVersion = process.versions.chrome || '134.0.0.0'
    const response = await ses.fetch(request.url, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://i.taobao.com',
        Referer: 'https://i.taobao.com/my_itaobao',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
      }
    })
    const text = await response.text()
    if (!response.ok && !text) {
      return { status: 'unknown', reason: `http_${response.status}`, userId: '', nick: '', retText: '' }
    }
    return classifyTaobaoUserSimpleResponse(parseMtopJson(text))
  } catch (error) {
    return {
      status: 'unknown',
      reason: error?.name === 'AbortError' ? 'timeout' : 'network_error',
      userId: '',
      nick: '',
      retText: ''
    }
  } finally {
    clearTimeout(timer)
  }
}

async function runTaobaoAccountValidation({ accountId, ses }) {
  let cookies = await ses.cookies.get({})
  const initialCookieFingerprint = createTaobaoCookieFingerprint(cookies)
  if (!hasTaobaoLoginCookie(cookies)) {
    return {
      status: 'invalid',
      reason: 'missing_login_cookie',
      userId: '',
      nick: '',
      cookieFingerprint: initialCookieFingerprint,
      cookieChanged: false
    }
  }

  let token = selectTaobaoMtopToken(cookies)
  let result = await fetchTaobaoUserSimple(ses, token)
  if (result.status === 'token') {
    // 第一次轻量请求可能通过 Set-Cookie 初始化/轮换 _m_h5_tk；只允许重试一次。
    cookies = await ses.cookies.get({ url: TAOBAO_USER_SIMPLE_URL })
    const refreshedToken = selectTaobaoMtopToken(cookies)
    if (refreshedToken) {
      token = refreshedToken
      result = await fetchTaobaoUserSimple(ses, token)
    } else {
      result = { status: 'unknown', reason: 'token_refresh_failed', userId: '', nick: '', retText: result.retText }
    }
  }
  const finalCookies = await ses.cookies.get({})
  const cookieFingerprint = createTaobaoCookieFingerprint(finalCookies)
  return {
    ...result,
    cookieFingerprint,
    cookieChanged: cookieFingerprint !== initialCookieFingerprint
  }
}

async function validateTaobaoPurchaseAccount({ accountId, ses, force = false, report = true }) {
  const key = String(accountId || '')
  if (!key) return { status: 'unknown', reason: 'missing_account_id', userId: '', nick: '' }
  if (!ses) return { status: 'unknown', reason: 'missing_session', userId: '', nick: '' }

  const cookies = await ses.cookies.get({})
  const cookieFingerprint = createTaobaoCookieFingerprint(cookies)
  const cached = validationCache.get(key)
  if (!force && cached && cached.cookieFingerprint === cookieFingerprint && cached.expiresAt > Date.now()) {
    return { ...cached.result, cached: true }
  }
  if (validationTasks.has(key)) return validationTasks.get(key)

  const task = (async () => {
    const startedAt = Date.now()
    let result = await runTaobaoAccountValidation({ accountId: key, ses })
    let cookiePersistResult = null
    if (result.cookieChanged) {
      cookiePersistResult = await persistTaobaoSessionCookies(key, ses)
    }
    if (report) {
      const reportResult = await reportTaobaoAccountValidation(key, result)
      if (reportResult.success && reportResult.result?.status === 'mismatch') {
        result = { ...result, status: 'mismatch', reason: 'account_identity_mismatch' }
      }
    }
    result = {
      ...result,
      cookiePersisted: cookiePersistResult ? cookiePersistResult.success : !result.cookieChanged,
      elapsedMs: Date.now() - startedAt,
      cached: false
    }
    validationCache.set(key, {
      cookieFingerprint: result.cookieFingerprint || cookieFingerprint,
      expiresAt: Date.now() + statusCacheTtl(result.status),
      result
    })
    runtimeLog.writeLog(
      'TaobaoAccountCheck',
      `accountId=${key}, status=${result.status}, reason=${sanitizeReason(result.reason)}, ` +
      `identity=${result.userId ? 'YES' : 'NO'}, nick=${result.nick ? 'YES' : 'NO'}, ` +
      `cookieFp=${result.cookieFingerprint || cookieFingerprint || 'none'}, ` +
      `cookieChanged=${result.cookieChanged === true}, cookiePersisted=${result.cookiePersisted === true}, ` +
      `elapsedMs=${result.elapsedMs}`
    )
    return result
  })().finally(() => {
    if (validationTasks.get(key) === task) validationTasks.delete(key)
  })
  validationTasks.set(key, task)
  return task
}

module.exports = {
  TAOBAO_USER_SIMPLE_API,
  TAOBAO_USER_SIMPLE_APP_KEY,
  TAOBAO_VALIDATION_SUCCESS_TTL,
  isTaobaoCookieDomain,
  createTaobaoCookieFingerprint,
  hasTaobaoLoginCookie,
  selectTaobaoMtopToken,
  buildTaobaoUserSimpleRequest,
  parseMtopJson,
  extractTaobaoSimpleUser,
  classifyTaobaoUserSimpleResponse,
  invalidateTaobaoAccountValidation,
  validateTaobaoPurchaseAccount
}
