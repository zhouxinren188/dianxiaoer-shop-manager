'use strict'

const DEFAULT_READY_TTL_MS = 5 * 60 * 1000
const DEFAULT_FALLBACK_TTL_MS = 15 * 1000
const DEFAULT_MAX_ENTRIES = 100

function createTaobaoRebatePrefetchCache({
  resolveUrl,
  now = () => Date.now(),
  readyTtlMs = DEFAULT_READY_TTL_MS,
  fallbackTtlMs = DEFAULT_FALLBACK_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES
} = {}) {
  if (typeof resolveUrl !== 'function') throw new TypeError('resolveUrl must be a function')

  const entries = new Map()

  function pruneExpired() {
    const currentTime = now()
    for (const [key, entry] of entries) {
      if (entry.state === 'ready' && entry.expiresAt <= currentTime) entries.delete(key)
    }
  }

  function trimEntries() {
    if (entries.size < maxEntries) return
    for (const [key, entry] of entries) {
      if (entry.state === 'ready') {
        entries.delete(key)
        if (entries.size < maxEntries) return
      }
    }
  }

  function prepare(key) {
    const normalizedKey = String(key || '').trim()
    if (!normalizedKey) throw new Error('淘宝返利预取链接不能为空')

    pruneExpired()
    const existing = entries.get(normalizedKey)
    if (existing) {
      return {
        state: existing.state === 'ready' ? 'ready' : 'inflight',
        promise: existing.promise,
        startedAt: existing.startedAt
      }
    }

    trimEntries()
    const entry = {
      state: 'pending',
      startedAt: now(),
      expiresAt: Number.POSITIVE_INFINITY,
      promise: null
    }
    entry.promise = Promise.resolve()
      .then(() => resolveUrl(normalizedKey))
      .then(result => {
        entry.state = 'ready'
        const ttl = result?.converted === true ? readyTtlMs : fallbackTtlMs
        entry.expiresAt = now() + ttl
        return result
      })
      .catch(error => {
        if (entries.get(normalizedKey) === entry) entries.delete(normalizedKey)
        throw error
      })
    entries.set(normalizedKey, entry)

    return { state: 'miss', promise: entry.promise, startedAt: entry.startedAt }
  }

  function clear() {
    entries.clear()
  }

  return {
    prepare,
    clear,
    size: () => entries.size
  }
}

module.exports = {
  DEFAULT_READY_TTL_MS,
  DEFAULT_FALLBACK_TTL_MS,
  createTaobaoRebatePrefetchCache
}
