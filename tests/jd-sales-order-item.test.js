import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { extractJdSalesOrderSkuSpec, parseSaleAttributes } = require('../src/main/jd-sales-order-item')

describe('JD sales order item specification', () => {
  it('extracts the exact specification from a JSON saleAttributes string', () => {
    expect(extractJdSalesOrderSkuSpec({
      skuName: '????????????????',
      saleAttributes: JSON.stringify([{
        dim: 1,
        saleName: '??',
        saleValue: '16cm???+5????300?? ??????',
        sequenceNo: 4
      }])
    })).toBe('16cm???+5????300?? ??????')
  })

  it('keeps multiple sales dimensions readable', () => {
    expect(extractJdSalesOrderSkuSpec({
      saleAttributes: [
        { saleName: '规格', saleValue: '套餐13号' },
        { saleName: '尺码', saleValue: '不含盆' }
      ]
    })).toBe('规格：套餐13号 / 尺码：不含盆')
  })

  it('accepts an object-shaped attributes payload', () => {
    expect(parseSaleAttributes({
      attributes: [{ attrName: '??', attrValue: 'XL' }]
    })).toEqual([{ name: '??', value: 'XL' }])
  })

  it('falls back to legacy explicit specification fields', () => {
    expect(extractJdSalesOrderSkuSpec({
      saleAttributes: 'not-json',
      specName: '1300ml??'
    })).toBe('1300ml??')
  })

  it('does not guess a specification from the product title', () => {
    expect(extractJdSalesOrderSkuSpec({
      skuName: '????????? 4?? ???'
    })).toBe('')
  })
})
