const crypto = require('crypto')

const INTERNAL_SKU_PREFIX = '__inventory__'

function createInternalInventorySku() {
  return `${INTERNAL_SKU_PREFIX}${crypto.randomUUID()}`
}

function resolveInventorySku(value) {
  const legacySku = typeof value === 'string' ? value.trim() : ''
  return legacySku || createInternalInventorySku()
}

function resolveSalesSkuId(body = {}) {
  const value = body.sku_id ?? body.sku
  return typeof value === 'string' ? value.trim() : String(value || '').trim()
}

module.exports = {
  INTERNAL_SKU_PREFIX,
  createInternalInventorySku,
  resolveInventorySku,
  resolveSalesSkuId
}
