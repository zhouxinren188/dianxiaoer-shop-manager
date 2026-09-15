import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { normalizeJdSalesOrderAmounts } = require('../src/main/jd-sales-order-money')

describe('京东销售订单金额口径', () => {
  it('优先使用商家应收而不是 shouldPay', () => {
    expect(normalizeJdSalesOrderAmounts({
      receivables: 0.26,
      shouldPay: 75312.54,
      orderSum: 75312.54,
      freight: 0
    })).toEqual({
      totalAmount: 0.26,
      goodsAmount: 75312.54,
      shippingFee: 0,
      merchantReceivable: 0.26,
      shouldPayAmount: 75312.54
    })
  })

  it('商家应收为零时保留零，不错误回退到 shouldPay', () => {
    expect(normalizeJdSalesOrderAmounts({
      receivables: 0,
      shouldPay: 100
    }).totalAmount).toBe(0)
  })

  it('旧接口没有商家应收字段时回退到 shouldPay', () => {
    expect(normalizeJdSalesOrderAmounts({
      shouldPay: '55.31',
      goodsAmount: '60.00',
      freight: '4.69'
    })).toMatchObject({
      totalAmount: 55.31,
      goodsAmount: 60,
      shippingFee: 4.69,
      merchantReceivable: null,
      shouldPayAmount: 55.31
    })
  })

  it('兼容带千位分隔符的金额字符串并拒绝无效值', () => {
    expect(normalizeJdSalesOrderAmounts({
      receivables: '1,234.56',
      shouldPay: '无效',
      orderSum: ''
    })).toMatchObject({
      totalAmount: 1234.56,
      goodsAmount: 0,
      shouldPayAmount: null
    })
  })
})
