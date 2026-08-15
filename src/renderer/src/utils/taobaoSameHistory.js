export const TAOBAO_SAME_HISTORY_STORAGE_KEY = 'dianxiaoer:taobao-same-history:v1'
export const TAOBAO_SAME_HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const TAOBAO_SAME_HISTORY_MAX_ENTRIES = 10000
export const TAOBAO_SAME_SEARCH_UI_TIMEOUT_MS = 60 * 1000
const TAOBAO_SAME_HISTORY_DB_NAME = 'dianxiaoer-taobao-same-history'
const TAOBAO_SAME_HISTORY_DB_VERSION = 1
const TAOBAO_SAME_HISTORY_STORE_NAME = 'entries'
const TAOBAO_SAME_HISTORY_CACHED_AT_INDEX = 'cachedAt'

let historyDatabasePromise = null
let legacyMigrationPromise = null

export function withTaobaoSameSearchTimeout(promise, timeoutMs = TAOBAO_SAME_SEARCH_UI_TIMEOUT_MS) {
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('淘宝同款搜索等待超时，界面已解除加载状态，请重新搜索'))
    }, timeoutMs)
  })
  return Promise.race([Promise.resolve(promise), timeout])
    .finally(() => clearTimeout(timeoutId))
}

function cleanText(value) {
  return String(value == null ? '' : value).trim()
}

function normalizeImageUrl(value) {
  const text = cleanText(value)
  if (!text) return ''
  try {
    const url = new URL(text.startsWith('//') ? `https:${text}` : text)
    url.hash = ''
    url.search = ''
    return url.toString()
  } catch {
    return text.split('#')[0].split('?')[0]
  }
}

export function extractTaobaoItemId(value) {
  if (value && typeof value === 'object') {
    const directId = cleanText(value.itemId || value.item_id || value.itemID)
    if (/^\d+$/.test(directId)) return directId
    return extractTaobaoItemId(value.link || value.purchase_link || value.url || '')
  }

  const text = cleanText(value)
  if (!text) return ''
  try {
    const url = new URL(text.startsWith('//') ? `https:${text}` : text)
    const queryId = cleanText(
      url.searchParams.get('id') ||
      url.searchParams.get('itemId') ||
      url.searchParams.get('item_id')
    )
    if (/^\d+$/.test(queryId)) return queryId
    const pathMatch = url.pathname.match(/(?:\/i|\/item\/)(\d+)(?:\.htm)?(?:\/|$)/i)
    if (pathMatch) return pathMatch[1]
  } catch {
    // 继续兼容不完整链接和旧数据。
  }

  const decoded = (() => {
    try { return decodeURIComponent(text) } catch { return text }
  })()
  const queryMatch = decoded.match(/[?&#](?:id|itemId|item_id)=(\d+)/i)
  if (queryMatch) return queryMatch[1]
  const pathMatch = decoded.match(/(?:\/i|\/item\/)(\d+)(?:\.htm)?(?:[/?#]|$)/i)
  return pathMatch ? pathMatch[1] : ''
}

export function collectTaobaoSourceItemIds(sources) {
  const ids = new Set()
  for (const source of Array.isArray(sources) ? sources : []) {
    const platform = cleanText(source?.platform).toLowerCase()
    if (platform && platform !== 'taobao' && platform !== 'tmall') continue
    const itemId = extractTaobaoItemId(source)
    if (itemId) ids.add(itemId)
  }
  return ids
}

export function buildTaobaoSameHistoryKey({ userId, accountId, skuId, imageUrl } = {}) {
  const parts = [
    cleanText(userId) || 'anonymous',
    cleanText(accountId) || 'no-account',
    cleanText(skuId) || 'no-sku',
    normalizeImageUrl(imageUrl) || 'no-image'
  ]
  return parts.map(part => encodeURIComponent(part)).join('|')
}

function readHistoryEntries(storage) {
  if (!storage || typeof storage.getItem !== 'function') return []
  try {
    const parsed = JSON.parse(storage.getItem(TAOBAO_SAME_HISTORY_STORAGE_KEY) || '{}')
    return Array.isArray(parsed.entries) ? parsed.entries : []
  } catch {
    return []
  }
}

function writeHistoryEntries(storage, entries) {
  if (!storage || typeof storage.setItem !== 'function') return false
  try {
    storage.setItem(
      TAOBAO_SAME_HISTORY_STORAGE_KEY,
      JSON.stringify({ version: 1, entries: Array.isArray(entries) ? entries : [] })
    )
    return true
  } catch {
    return false
  }
}

function freshHistoryEntries(storage, now = Date.now()) {
  const entries = readHistoryEntries(storage)
  const freshEntries = entries
    .filter(entry => Number.isFinite(Number(entry?.cachedAt)) && now - Number(entry.cachedAt) <= TAOBAO_SAME_HISTORY_TTL_MS)
  if (freshEntries.length !== entries.length) writeHistoryEntries(storage, freshEntries)
  return freshEntries
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => reject(request.error || new Error('淘宝同款历史数据库操作失败'))
  })
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('淘宝同款历史数据库事务失败'))
    transaction.onabort = () => reject(transaction.error || new Error('淘宝同款历史数据库事务已取消'))
  })
}

function getHistoryDatabaseFactory() {
  try {
    return globalThis.indexedDB || null
  } catch {
    return null
  }
}

function openTaobaoSameHistoryDatabase() {
  const factory = getHistoryDatabaseFactory()
  if (!factory) return Promise.resolve(null)
  if (historyDatabasePromise) return historyDatabasePromise

  historyDatabasePromise = new Promise((resolve, reject) => {
    const request = factory.open(TAOBAO_SAME_HISTORY_DB_NAME, TAOBAO_SAME_HISTORY_DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      const store = database.objectStoreNames.contains(TAOBAO_SAME_HISTORY_STORE_NAME)
        ? request.transaction.objectStore(TAOBAO_SAME_HISTORY_STORE_NAME)
        : database.createObjectStore(TAOBAO_SAME_HISTORY_STORE_NAME, { keyPath: 'key' })
      if (!store.indexNames.contains(TAOBAO_SAME_HISTORY_CACHED_AT_INDEX)) {
        store.createIndex(TAOBAO_SAME_HISTORY_CACHED_AT_INDEX, 'cachedAt')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('无法打开淘宝同款历史数据库'))
    request.onblocked = () => reject(new Error('淘宝同款历史数据库升级被阻塞'))
  }).catch(() => {
    historyDatabasePromise = null
    return null
  })
  return historyDatabasePromise
}

async function migrateLegacyTaobaoSameHistory(storage, database, now = Date.now()) {
  if (!database || !storage) return
  if (legacyMigrationPromise) return legacyMigrationPromise
  legacyMigrationPromise = (async () => {
    const entries = freshHistoryEntries(storage, now)
      .slice(0, TAOBAO_SAME_HISTORY_MAX_ENTRIES)
    if (entries.length > 0) {
      const readTransaction = database.transaction(TAOBAO_SAME_HISTORY_STORE_NAME, 'readonly')
      const readStore = readTransaction.objectStore(TAOBAO_SAME_HISTORY_STORE_NAME)
      const existingEntries = await Promise.all(
        entries.map(entry => requestResult(readStore.get(entry.key)))
      )
      const entriesToMigrate = entries.filter((entry, index) => {
        const existing = existingEntries[index]
        return !existing || Number(entry.cachedAt) > Number(existing.cachedAt || 0)
      })
      if (entriesToMigrate.length > 0) {
        const writeTransaction = database.transaction(TAOBAO_SAME_HISTORY_STORE_NAME, 'readwrite')
        const writeStore = writeTransaction.objectStore(TAOBAO_SAME_HISTORY_STORE_NAME)
        for (const entry of entriesToMigrate) writeStore.put(entry)
        await transactionComplete(writeTransaction)
      }
    }
    try {
      if (typeof storage.removeItem === 'function') storage.removeItem(TAOBAO_SAME_HISTORY_STORAGE_KEY)
    } catch {}
  })().catch(() => {})
  return legacyMigrationPromise
}

async function deleteIndexedDbEntriesByCursor(index, range, limit = Number.POSITIVE_INFINITY) {
  let deleted = 0
  await new Promise((resolve, reject) => {
    const request = index.openCursor(range)
    request.onerror = () => reject(request.error || new Error('清理淘宝同款历史失败'))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor || deleted >= limit) {
        resolve()
        return
      }
      cursor.delete()
      deleted += 1
      cursor.continue()
    }
  })
  return deleted
}

async function pruneIndexedDbHistory(database, now = Date.now()) {
  const transaction = database.transaction(TAOBAO_SAME_HISTORY_STORE_NAME, 'readwrite')
  const completion = transactionComplete(transaction)
  const store = transaction.objectStore(TAOBAO_SAME_HISTORY_STORE_NAME)
  const index = store.index(TAOBAO_SAME_HISTORY_CACHED_AT_INDEX)
  const keyRangeFactory = globalThis.IDBKeyRange
  if (keyRangeFactory) {
    const expiredBefore = now - TAOBAO_SAME_HISTORY_TTL_MS
    await deleteIndexedDbEntriesByCursor(index, keyRangeFactory.upperBound(expiredBefore, true))
  }
  const count = Number(await requestResult(store.count()))
  const overflow = Math.max(0, count - TAOBAO_SAME_HISTORY_MAX_ENTRIES)
  if (overflow > 0) await deleteIndexedDbEntriesByCursor(index, null, overflow)
  await completion
}

function validProducts(products) {
  if (!Array.isArray(products)) return []
  return products
    .filter(product => product && typeof product === 'object' && cleanText(product.link))
    .slice(0, 20)
    .map(product => ({
      itemId: cleanText(product.itemId || product.item_id),
      link: cleanText(product.link),
      title: cleanText(product.title),
      img: cleanText(product.img),
      price: product.price == null || !Number.isFinite(Number(product.price)) ? null : Number(product.price),
      originalPrice: product.originalPrice == null || !Number.isFinite(Number(product.originalPrice))
        ? null
        : Number(product.originalPrice),
      sales: cleanText(product.sales),
      shop: cleanText(product.shop)
    }))
}

export async function readTaobaoSameHistory(storage, key, now = Date.now()) {
  const cacheKey = cleanText(key)
  if (!cacheKey) return null
  const database = await openTaobaoSameHistoryDatabase()
  if (database) {
    try {
      await migrateLegacyTaobaoSameHistory(storage, database, now)
      await pruneIndexedDbHistory(database, now)
      const transaction = database.transaction(TAOBAO_SAME_HISTORY_STORE_NAME, 'readonly')
      const record = await requestResult(transaction.objectStore(TAOBAO_SAME_HISTORY_STORE_NAME).get(cacheKey))
      if (!record || !Number.isFinite(Number(record.cachedAt))) return null
      const products = validProducts(record.products)
      return products.length > 0
        ? { products, cachedAt: Number(record.cachedAt) }
        : null
    } catch {
      return null
    }
  }

  const record = freshHistoryEntries(storage, now).find(entry => entry?.key === cacheKey)
  if (!record || !Number.isFinite(Number(record.cachedAt))) return null
  const products = validProducts(record.products)
  return products.length > 0
    ? { products, cachedAt: Number(record.cachedAt) }
    : null
}

export async function saveTaobaoSameHistory(storage, key, products, now = Date.now()) {
  const cacheKey = cleanText(key)
  const safeProducts = validProducts(products)
  if (!cacheKey || safeProducts.length === 0 || !storage || typeof storage.setItem !== 'function') return false

  const database = await openTaobaoSameHistoryDatabase()
  if (database) {
    try {
      await migrateLegacyTaobaoSameHistory(storage, database, now)
      const transaction = database.transaction(TAOBAO_SAME_HISTORY_STORE_NAME, 'readwrite')
      transaction.objectStore(TAOBAO_SAME_HISTORY_STORE_NAME).put({
        key: cacheKey,
        cachedAt: now,
        products: safeProducts
      })
      await transactionComplete(transaction)
      await pruneIndexedDbHistory(database, now)
      return true
    } catch {
      return false
    }
  }

  const freshEntries = freshHistoryEntries(storage, now)
    .filter(entry => entry?.key !== cacheKey)
  freshEntries.unshift({ key: cacheKey, cachedAt: now, products: safeProducts })
  const entries = freshEntries.slice(0, TAOBAO_SAME_HISTORY_MAX_ENTRIES)
  return writeHistoryEntries(storage, entries)
}
