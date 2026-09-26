const JD_STORE_PROFILE_URL = 'https://shop.jd.com/json/navigation/getPinBaseInfo.action'
const JD_STORE_LOGIN_URL = `https://passport.jd.com/common/loginPage?from=jzt&ReturnUrl=${encodeURIComponent(JD_STORE_PROFILE_URL)}`
// 京东的 JZT 聚合登录入口偶尔会在 Electron 主导航阶段返回 ERR_FAILED(-2)，
// 但通用账号登录页仍可正常访问。保留一个同属 passport.jd.com 的官方入口，
// 仅在主入口加载失败时使用，避免直接关闭登录窗口。
const JD_STORE_LOGIN_FALLBACK_URL = `https://passport.jd.com/new/login.aspx?ReturnUrl=${encodeURIComponent(JD_STORE_PROFILE_URL)}`

const JD_LOGIN_RISK_MARKERS = [
  '认证魔方',
  '存在安全风险',
  '请勿使用三方工具',
  '特殊场景请使用主账号登录',
  '使用手机短信验证码'
]

function normalizeText(value) {
  return value === undefined || value === null ? '' : String(value).trim()
}

function firstText(...values) {
  for (const value of values) {
    const text = normalizeText(value)
    if (text) return text
  }
  return ''
}

function findJdLoginRiskMarker(text) {
  const normalized = normalizeText(text).replace(/\s+/g, '')
  return JD_LOGIN_RISK_MARKERS.find(marker => normalized.includes(marker.replace(/\s+/g, ''))) || ''
}

function unwrapJsonp(text) {
  const trimmed = normalizeText(text)
  const match = trimmed.match(/^[A-Za-z_$][\w$.[\]]*\s*\(([\s\S]*)\)\s*;?$/)
  return match ? match[1].trim() : trimmed
}

function findProfileCandidate(payload) {
  if (!payload || typeof payload !== 'object') return null
  const candidates = [
    payload.venderBaseInfo,
    payload.vendorBaseInfo,
    payload.currentVendor,
    payload.data?.venderBaseInfo,
    payload.data?.vendorBaseInfo,
    payload.data?.currentVendor,
    payload.result?.venderBaseInfo,
    payload.result?.vendorBaseInfo,
    payload.result?.currentVendor,
    payload.data,
    payload.result,
    payload
  ]
  const identityKeys = [
    'venderId', 'vendorId', 'merchantId', 'shopId', 'shop_id',
    'shopName', 'venderName', 'vendorName', 'pin', 'ptPin', 'account'
  ]
  return candidates.find(candidate =>
    candidate &&
    typeof candidate === 'object' &&
    identityKeys.some(key => normalizeText(candidate[key]))
  ) || null
}

function parseJdStoreProfileText(text) {
  let payload
  try {
    payload = JSON.parse(unwrapJsonp(text))
  } catch {
    return null
  }

  const profile = findProfileCandidate(payload)
  if (!profile) return null
  const venderId = firstText(
    profile.venderId,
    profile.vendorId,
    profile.merchantId,
    payload.venderId,
    payload.vendorId,
    payload.merchantId
  )
  const shopId = firstText(profile.shopId, profile.shop_id, payload.shopId, payload.shop_id)
  const storeName = firstText(
    profile.shopName,
    profile.venderName,
    profile.vendorName,
    profile.name,
    payload.shopName,
    payload.venderName,
    payload.vendorName
  )
  const account = firstText(profile.pin, profile.ptPin, profile.account, payload.pin, payload.ptPin)

  if (!venderId && !shopId && !storeName && !account) return null
  return { venderId, shopId, storeName, account }
}

function isUnexpiredCookie(cookie, nowSeconds = Date.now() / 1000) {
  const expires = Number(cookie?.expirationDate || 0)
  return !expires || expires > nowSeconds
}

function getJdLoginCookieState(cookies, nowSeconds = Date.now() / 1000) {
  const valid = (Array.isArray(cookies) ? cookies : []).filter(cookie => {
    const domain = normalizeText(cookie?.domain).replace(/^\./, '').toLowerCase()
    return (domain === 'jd.com' || domain.endsWith('.jd.com') || domain === 'jd.hk' || domain.endsWith('.jd.hk')) &&
      isUnexpiredCookie(cookie, nowSeconds) && normalizeText(cookie?.value)
  })
  const find = names => valid.find(cookie => names.includes(normalizeText(cookie.name).toLowerCase())) || null
  const authCookie = find(['thor', 'pt_key'])
  const identityCookie = find(['pin', 'pt_pin', 'pinid', 'cookiejd'])
  return {
    valid: !!(authCookie && identityCookie),
    authCookie,
    identityCookie,
    cookies: valid
  }
}

function validateJdStoreIdentity(actual = {}, expected = {}) {
  const actualMerchantId = firstText(actual.venderId, actual.vendorId, actual.merchantId)
  const actualShopId = firstText(actual.shopId)
  const expectedMerchantId = firstText(expected.merchantId, expected.venderId, expected.vendorId)
  const expectedShopId = firstText(expected.shopId)

  if (expectedMerchantId && actualMerchantId && expectedMerchantId !== actualMerchantId) {
    return {
      valid: false,
      reason: 'merchant_id_mismatch',
      expected: expectedMerchantId,
      actual: actualMerchantId
    }
  }
  if (expectedShopId && actualShopId && expectedShopId !== actualShopId) {
    return {
      valid: false,
      reason: 'shop_id_mismatch',
      expected: expectedShopId,
      actual: actualShopId
    }
  }
  if (expectedMerchantId && !actualMerchantId) {
    return { valid: false, reason: 'merchant_id_missing', expected: expectedMerchantId, actual: '' }
  }
  if (expectedShopId && !actualShopId) {
    return { valid: false, reason: 'shop_id_missing', expected: expectedShopId, actual: '' }
  }
  return { valid: true, reason: 'identity_verified' }
}

module.exports = {
  JD_STORE_LOGIN_FALLBACK_URL,
  JD_STORE_LOGIN_URL,
  JD_STORE_PROFILE_URL,
  JD_LOGIN_RISK_MARKERS,
  findJdLoginRiskMarker,
  getJdLoginCookieState,
  parseJdStoreProfileText,
  validateJdStoreIdentity
}
