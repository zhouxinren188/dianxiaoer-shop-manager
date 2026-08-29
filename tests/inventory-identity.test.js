import { describe, expect, it } from 'vitest'
import inventoryIdentity from '../server/services/inventory-identity.js'

const {
  INTERNAL_SKU_PREFIX,
  createInternalInventorySku,
  resolveInventorySku,
  resolveSalesSkuId
} = inventoryIdentity

describe('warehouse inventory identity', () => {
  it('creates opaque unique compatibility keys for new warehouse products', () => {
    const first = createInternalInventorySku()
    const second = createInternalInventorySku()

    expect(first).toMatch(new RegExp(`^${INTERNAL_SKU_PREFIX}[0-9a-f-]{36}$`))
    expect(second).not.toBe(first)
  })

  it('keeps legacy inventory keys but generates one when the field is omitted', () => {
    expect(resolveInventorySku(' LEGACY-001 ')).toBe('LEGACY-001')
    expect(resolveInventorySku('')).toMatch(new RegExp(`^${INTERNAL_SKU_PREFIX}`))
    expect(resolveInventorySku()).toMatch(new RegExp(`^${INTERNAL_SKU_PREFIX}`))
  })

  it('uses sku_id for the sales binding and accepts old client payloads', () => {
    expect(resolveSalesSkuId({ sku_id: ' 10214934933733 ', sku: 'old' })).toBe('10214934933733')
    expect(resolveSalesSkuId({ sku: ' legacy-client-sku ' })).toBe('legacy-client-sku')
    expect(resolveSalesSkuId({})).toBe('')
  })
})
