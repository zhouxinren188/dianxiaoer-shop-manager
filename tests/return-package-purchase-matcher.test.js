import { describe, expect, it } from 'vitest'
import matcher from '../server/services/return-package-purchase-matcher.js'

const { buildReturnPackageLookup, matchReturnRecordToPurchases } = matcher

const baseReturn = {
  store_id: 8,
  store_name: '示例店铺',
  sales_order_no: '3599471007575277',
  jd_sku: '10213086527675',
  afs_service_id: '44521493693',
  logistics_no: 'YT1234567890',
  logistics_company: '圆通速递'
}

function purchase(id, overrides = {}) {
  return {
    id,
    purchase_no: `A${id}`,
    sales_order_no: baseReturn.sales_order_no,
    sku: baseReturn.jd_sku,
    status: 'ordered',
    ...overrides
  }
}

describe('return package purchase matcher', () => {
  it('returns one exact valid purchase without manual review', () => {
    const result = matchReturnRecordToPurchases(baseReturn, [
      purchase(1),
      purchase(2, { status: 'pending' }),
      purchase(3, { status: 'cancelled' })
    ])

    expect(result.match_mode).toBe('exact')
    expect(result.needs_manual_review).toBe(false)
    expect(result.matches.map((item) => item.id)).toEqual([1])
    expect(result.excluded_purchase_count).toBe(2)
  })

  it('returns every valid exact purchase when a combination has multiple purchases', () => {
    const result = matchReturnRecordToPurchases(baseReturn, [purchase(1), purchase(2)])

    expect(result.match_mode).toBe('exact_multiple')
    expect(result.needs_manual_review).toBe(true)
    expect(result.matches.map((item) => item.id)).toEqual([1, 2])
  })

  it('falls back to all valid purchases under the sales order when SKU is absent', () => {
    const result = matchReturnRecordToPurchases(
      { ...baseReturn, jd_sku: '' },
      [purchase(1), purchase(2, { sku: '10213086527676' }), purchase(3, { status: 'pending' })]
    )

    expect(result.match_mode).toBe('sales_order_fallback')
    expect(result.needs_manual_review).toBe(true)
    expect(result.matches.map((item) => item.id)).toEqual([1, 2])
  })

  it('keeps multiple SKUs separated inside the same return waybill', () => {
    const secondSku = '10213086527676'
    const result = buildReturnPackageLookup(
      [baseReturn, { ...baseReturn, jd_sku: secondSku, afs_service_id: '44521493694' }],
      [purchase(1), purchase(2, { sku: secondSku })]
    )

    expect(result.package_count).toBe(2)
    expect(result.matched_purchase_count).toBe(2)
    expect(result.packages.map((item) => item.matches[0].id)).toEqual([1, 2])
    expect(result.needs_manual_review).toBe(false)
  })

  it('deduplicates repeated after-sale records and never copies customer PII', () => {
    const result = buildReturnPackageLookup(
      [
        { ...baseReturn, customer_name: '不应返回', customer_phone: '13800000000' },
        { ...baseReturn, afs_service_id: '44521493694', customer_address: '不应返回' }
      ],
      [purchase(1)]
    )

    expect(result.package_count).toBe(1)
    expect(result.packages[0].afs_service_ids).toEqual(['44521493693', '44521493694'])
    expect(JSON.stringify(result)).not.toContain('13800000000')
    expect(JSON.stringify(result)).not.toContain('不应返回')
  })

  it('reports not_found when no eligible purchase exists', () => {
    const result = matchReturnRecordToPurchases(baseReturn, [purchase(1, { status: 'pending' })])

    expect(result.match_mode).toBe('not_found')
    expect(result.matches).toEqual([])
    expect(result.needs_manual_review).toBe(true)
  })
})
