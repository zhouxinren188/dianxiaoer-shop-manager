'use strict'

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''))
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeTabUrl(value) {
  try {
    const parsed = new URL(String(value || ''))
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return String(value || '')
  }
}

function isLikelyLoginUrl(value) {
  try {
    const parsed = new URL(String(value || ''))
    const host = parsed.hostname.toLowerCase()
    const pathAndQuery = `${parsed.pathname}${parsed.search}`.toLowerCase()
    return host.includes('passport.jd.com') || host === 'login.jd.com' ||
      (host.endsWith('.jd.com') && pathAndQuery.includes('login'))
  } catch {
    return false
  }
}

function selectOldestInactiveTab(tabs, activeTabId) {
  return (Array.isArray(tabs) ? tabs : [])
    .filter(tab => tab && tab.id !== activeTabId)
    .sort((left, right) => Number(left.lastActiveAt || 0) - Number(right.lastActiveAt || 0))[0] || null
}

module.exports = {
  isHttpUrl,
  normalizeTabUrl,
  isLikelyLoginUrl,
  selectOldestInactiveTab
}
