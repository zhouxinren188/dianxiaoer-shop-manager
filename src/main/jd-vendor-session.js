const LOGIN_HOST_PATTERN = /(^|\.)(passport|login)\.jd\.com$/i
const LOGIN_TEXT_PATTERN = /(未登录|请先登录|重新登录|登录已失效|passport\.jd\.com|login\.jd\.com)/i

function normalizeId(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

function unwrapJsonp(text) {
  const trimmed = String(text || '').trim()
  const match = trimmed.match(/^[A-Za-z_$][\w$.[\]]*\s*\(([\s\S]*)\)\s*;?$/)
  return match ? match[1].trim() : trimmed
}

function isLoginLocation(location) {
  if (!location) return false
  try {
    const url = new URL(location, 'https://i.shop.jd.com')
    const pathAndQuery = `${url.pathname}${url.search}`.toLowerCase()
    return LOGIN_HOST_PATTERN.test(url.hostname) ||
      /(^|[/?&_.=-])(login|passport)([/?&_.=-]|$)/.test(pathAndQuery)
  } catch {
    return LOGIN_TEXT_PATTERN.test(String(location))
  }
}

function findCurrentVendor(payload) {
  if (!payload || typeof payload !== 'object') return null
  return payload.currentVendor || payload.data?.currentVendor || null
}

function parseJdVendorSessionResponse({
  statusCode,
  headers = {},
  body = '',
  expectedMerchantId = ''
}) {
  const httpStatus = Number(statusCode || 0)
  const location = String(headers.location || headers.Location || '')

  if (httpStatus === 301 || httpStatus === 302 || httpStatus === 303 || httpStatus === 307 || httpStatus === 308) {
    if (isLoginLocation(location)) {
      return { valid: false, reason: 'login_redirect', location }
    }
    return { valid: null, reason: 'unexpected_redirect', location }
  }

  if (httpStatus === 401) {
    return { valid: false, reason: 'http_401' }
  }

  // 403 可能是风控，404 可能是接口调整，429/5xx 属于临时故障；都不能据此宣告 Cookie 失效。
  if (httpStatus !== 200) {
    return { valid: null, reason: `http_${httpStatus || 'unknown'}` }
  }

  const rawBody = String(body || '')
  let payload
  try {
    payload = JSON.parse(unwrapJsonp(rawBody))
  } catch {
    if (LOGIN_TEXT_PATTERN.test(rawBody)) {
      return { valid: false, reason: 'login_response' }
    }
    return { valid: null, reason: 'invalid_json' }
  }

  const currentVendor = findCurrentVendor(payload)
  const vendorId = normalizeId(
    currentVendor?.vendorId ?? currentVendor?.venderId ?? currentVendor?.merchantId
  )
  const vendorName = String(
    currentVendor?.shopName ?? currentVendor?.vendorName ?? currentVendor?.venderName ?? currentVendor?.name ?? ''
  ).trim()

  if (!vendorId) {
    const message = String(payload?.message ?? payload?.msg ?? payload?.errorMessage ?? '')
    if (LOGIN_TEXT_PATTERN.test(message) || LOGIN_TEXT_PATTERN.test(rawBody)) {
      return { valid: false, reason: 'login_response' }
    }
    return { valid: null, reason: 'current_vendor_missing' }
  }

  const expected = normalizeId(expectedMerchantId)
  if (expected && vendorId !== expected) {
    return {
      valid: false,
      reason: 'vendor_identity_mismatch',
      vendorId,
      vendorName,
      expectedMerchantId: expected
    }
  }

  return {
    valid: true,
    reason: expected ? 'vendor_identity_verified' : 'vendor_identity_verified_without_expected_id',
    vendorId,
    vendorName,
    expectedMerchantId: expected
  }
}

module.exports = {
  parseJdVendorSessionResponse
}
