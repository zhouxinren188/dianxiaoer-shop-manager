export const TAOBAO_SAME_HISTORY_STORAGE_KEY = 'dianxiaoer:taobao-same-history:v1'
export const TAOBAO_SAME_HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const TAOBAO_SAME_HISTORY_MAX_ENTRIES = 100

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

export function readTaobaoSameHistory(storage, key, now = Date.now()) {
  const cacheKey = cleanText(key)
  if (!cacheKey) return null
  const record = readHistoryEntries(storage).find(entry => entry?.key === cacheKey)
  if (!record || !Number.isFinite(Number(record.cachedAt))) return null
  if (now - Number(record.cachedAt) > TAOBAO_SAME_HISTORY_TTL_MS) return null
  const products = validProducts(record.products)
  return products.length > 0
    ? { products, cachedAt: Number(record.cachedAt) }
    : null
}

export function saveTaobaoSameHistory(storage, key, products, now = Date.now()) {
  const cacheKey = cleanText(key)
  const safeProducts = validProducts(products)
  if (!cacheKey || safeProducts.length === 0 || !storage || typeof storage.setItem !== 'function') return false

  const freshEntries = readHistoryEntries(storage)
    .filter(entry => entry?.key !== cacheKey)
    .filter(entry => Number.isFinite(Number(entry?.cachedAt)) && now - Number(entry.cachedAt) <= TAOBAO_SAME_HISTORY_TTL_MS)
  freshEntries.unshift({ key: cacheKey, cachedAt: now, products: safeProducts })
  const entries = freshEntries.slice(0, TAOBAO_SAME_HISTORY_MAX_ENTRIES)

  try {
    storage.setItem(TAOBAO_SAME_HISTORY_STORAGE_KEY, JSON.stringify({ version: 1, entries }))
    return true
  } catch {
    return false
  }
}
