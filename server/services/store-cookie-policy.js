const crypto = require('crypto')

const PROMOTED_SOURCE_TYPES = new Set(['login_capture', 'manual_import'])
const VERSIONED_SOURCE_TYPES = new Set(['heartbeat', 'recovery_verified'])

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

function fingerprintCookieData(cookieData) {
  const normalized = parseCookieData(cookieData)
    .filter(cookie => cookie && cookie.name && cookie.domain)
    .map(normalizeCookieForFingerprint)
    .sort((left, right) => {
      const leftKey = `${left.domain}\u0000${left.path}\u0000${left.name}`
      const rightKey = `${right.domain}\u0000${right.path}\u0000${right.name}`
      return leftKey.localeCompare(rightKey)
    })
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function normalizeSourceType(sourceType) {
  const normalized = String(sourceType || 'legacy').trim().toLowerCase()
  if (PROMOTED_SOURCE_TYPES.has(normalized) || VERSIONED_SOURCE_TYPES.has(normalized)) return normalized
  return 'legacy'
}

function decideCookieUpdate({ currentRevision, currentFingerprint, incomingFingerprint, sourceType, baseRevision }) {
  const current = Number(currentRevision || 0)
  const base = Number(baseRevision || 0)
  const source = normalizeSourceType(sourceType)

  if (current <= 0) {
    return { accepted: true, contentChanged: true, nextRevision: 1, reason: 'initial_cookie' }
  }
  if (currentFingerprint && currentFingerprint === incomingFingerprint) {
    return { accepted: true, contentChanged: false, nextRevision: current, reason: 'same_fingerprint' }
  }
  if (PROMOTED_SOURCE_TYPES.has(source)) {
    return { accepted: true, contentChanged: true, nextRevision: current + 1, reason: source }
  }
  if (VERSIONED_SOURCE_TYPES.has(source) && base === current) {
    return { accepted: true, contentChanged: true, nextRevision: current + 1, reason: 'matching_base_revision' }
  }
  if (VERSIONED_SOURCE_TYPES.has(source)) {
    return { accepted: false, contentChanged: false, nextRevision: current, reason: 'stale_base_revision' }
  }
  return { accepted: false, contentChanged: false, nextRevision: current, reason: 'legacy_overwrite_blocked' }
}

module.exports = {
  decideCookieUpdate,
  fingerprintCookieData,
  normalizeSourceType,
  parseCookieData
}
