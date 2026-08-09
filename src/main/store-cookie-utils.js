const crypto = require('crypto')

function normalizeCookieForFingerprint(cookie) {
  return {
    domain: String(cookie?.domain || '').toLowerCase(),
    path: String(cookie?.path || '/'),
    name: String(cookie?.name || ''),
    value: String(cookie?.value || ''),
    expirationDate: Number(cookie?.expirationDate || 0),
    secure: !!cookie?.secure,
    httpOnly: !!cookie?.httpOnly,
    sameSite: String(cookie?.sameSite || '')
  }
}

function normalizeCookiesForFingerprint(cookies) {
  const list = Array.isArray(cookies) ? cookies : []
  return list
    .filter(cookie => cookie && cookie.name && cookie.domain)
    .map(normalizeCookieForFingerprint)
    .sort((left, right) => {
      const leftKey = `${left.domain}\u0000${left.path}\u0000${left.name}`
      const rightKey = `${right.domain}\u0000${right.path}\u0000${right.name}`
      return leftKey.localeCompare(rightKey)
    })
}

function fingerprintCookies(cookies) {
  const normalized = normalizeCookiesForFingerprint(cookies)
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function parseCookieData(cookieData) {
  if (Array.isArray(cookieData)) return cookieData
  if (typeof cookieData !== 'string' || !cookieData.trim()) return []
  try {
    const parsed = JSON.parse(cookieData)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function isJdCookie(cookie) {
  const domain = String(cookie?.domain || '').toLowerCase()
  return domain.includes('jd.com') || domain.includes('jd.hk')
}

function shortFingerprint(fingerprint) {
  return fingerprint ? String(fingerprint).slice(0, 12) : 'none'
}

module.exports = {
  fingerprintCookies,
  isJdCookie,
  normalizeCookiesForFingerprint,
  parseCookieData,
  shortFingerprint
}
