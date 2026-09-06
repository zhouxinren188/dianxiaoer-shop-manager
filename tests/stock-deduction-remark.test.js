import { describe, expect, it } from 'vitest'
import stockDeductionRemark from '../server/services/stock-deduction-remark.js'

const { buildStockDeductionRemark } = stockDeductionRemark

describe('stock deduction JD remark', () => {
  it('uses the actual deducted quantity including package size', () => {
    expect(buildStockDeductionRemark([
      { location: 'A-01-02', quantity: 2, package_num: 3 }
    ])).toBe('货位号：A-01-02 数量：6')
  })

  it('combines quantities from the same location and keeps multiple locations on separate lines', () => {
    expect(buildStockDeductionRemark([
      { location: 'A01', quantity: 1, package_num: 2 },
      { location: 'A01', quantity: 3, package_num: 1 },
      { location: 'B02', quantity: 2, package_num: 1 }
    ])).toBe('货位号：A01 数量：5\n货位号：B02 数量：2')
  })

  it('makes a missing location visible instead of producing an empty remark', () => {
    expect(buildStockDeductionRemark([
      { location: '', quantity: 1, package_num: 1 }
    ])).toBe('货位号：未设置 数量：1')
  })
})
