const PLATFORM_COOKIE_DOMAINS = Object.freeze({
  pinduoduo: ['pinduoduo.com', 'yangkeduo.com', 'pdd.net'],
  taobao: ['taobao.com', 'tmall.com'],
  tmall: ['taobao.com', 'tmall.com'],
  '1688': ['1688.com', 'alibaba.com'],
  jd: ['jd.com', 'jd.hk'],
  douyin: ['douyin.com', 'jinritemai.com']
})

function parsePurchaseCookies(cookieData) {
  if (Array.isArray(cookieData)) return cookieData
  if (!cookieData) return []
  try {
    const parsed = typeof cookieData === 'string' ? JSON.parse(cookieData) : cookieData
    return Array.isArray(parsed) ? parsed : []
  } catch (_) {
    return []
  }
}

function isCookieUnexpired(cookie, nowSeconds = Date.now() / 1000) {
  if (!cookie || !String(cookie.name || '') || !String(cookie.value || '')) return false
  if (cookie.session === true) return true
  const expirationDate = Number(cookie.expirationDate)
  return !Number.isFinite(expirationDate) || expirationDate <= 0 || expirationDate > nowSeconds
}

function isCookieForPlatform(cookie, platform) {
  const domains = PLATFORM_COOKIE_DOMAINS[String(platform || '').toLowerCase()] || []
  if (!domains.length) return false
  const cookieDomain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase()
  return domains.some(domain => cookieDomain === domain || cookieDomain.endsWith(`.${domain}`))
}

function hasValidPlatformCookies(cookieData, platform, nowSeconds = Date.now() / 1000) {
  return parsePurchaseCookies(cookieData).some(cookie =>
    isCookieForPlatform(cookie, platform) && isCookieUnexpired(cookie, nowSeconds)
  )
}

function evaluatePurchaseCookieState(row, nowSeconds = Date.now() / 1000) {
  const platform = String(row?.platform || '').toLowerCase()
  const storedCookiesValid = hasValidPlatformCookies(row?.cookie_data, platform, nowSeconds)
  const checkedStatus = String(row?.cookie_status || '').toLowerCase()

  if (platform === 'taobao' || platform === 'tmall') {
    if (checkedStatus === 'valid') {
      return { cookieValid: storedCookiesValid, status: storedCookiesValid ? 'valid' : 'invalid' }
    }
    if (['invalid', 'mismatch', 'risk'].includes(checkedStatus)) {
      return { cookieValid: false, status: checkedStatus }
    }
    return { cookieValid: false, status: storedCookiesValid ? 'stored' : 'missing' }
  }

  return {
    cookieValid: storedCookiesValid,
    status: storedCookiesValid ? 'valid' : 'missing'
  }
}

function sanitizePurchaseAccountRow(row, nowSeconds = Date.now() / 1000) {
  const cookieState = evaluatePurchaseCookieState(row, nowSeconds)
  const { password, cookie_data, ...safeRow } = row || {}
  return {
    ...safeRow,
    has_password: !!String(password || ''),
    online: cookieState.cookieValid ? 1 : 0,
    cookie_valid: cookieState.cookieValid,
    effective_cookie_status: cookieState.status
  }
}

function purchaseAccountMetadataChanged(current, updates) {
  if (!current || !updates) return false
  if (updates.account !== undefined && String(updates.account).trim() !== String(current.account || '').trim()) return true
  if (updates.platform !== undefined && String(updates.platform).trim() !== String(current.platform || '').trim()) return true
  return false
}

module.exports = {
  PLATFORM_COOKIE_DOMAINS,
  parsePurchaseCookies,
  isCookieUnexpired,
  isCookieForPlatform,
  hasValidPlatformCookies,
  evaluatePurchaseCookieState,
  sanitizePurchaseAccountRow,
  purchaseAccountMetadataChanged
}
