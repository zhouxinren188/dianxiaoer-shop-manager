import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import taobaoAmount from '../src/main/purchase-order-sync/taobao-amount.js'

const {
  parseTaobaoMoney,
  extractTaobaoOrderAmount,
  applyTaobaoOrderAmount,
  mergeTaobaoOrderInfo
} = taobaoAmount

describe('淘宝已买到的宝贝金额解析', () => {
  it('兼容人民币符号和千分位', () => {
    expect(parseTaobaoMoney('￥1,234.50')).toBe(1234.5)
    expect(parseTaobaoMoney('¥18.90')).toBe(18.9)
    expect(parseTaobaoMoney('')).toBe(0)
  })

  it('把 payInfo.actualFee 作为实付总额并计算采购单价', () => {
    expect(extractTaobaoOrderAmount({
      payInfo: { actualFee: '65.90', postFee: '5.90' },
      subOrders: [{ quantity: { count: '2' } }]
    })).toEqual({
      total_amount: 65.9,
      shipping_fee: 5.9,
      purchase_price: 30,
      quantity: 2
    })
  })

  it('单件订单可直接从已买列表补齐实付金额', () => {
    const result = { order_no: '5127481658490125118', status: '买家已付款' }
    applyTaobaoOrderAmount(result, {
      payInfo: { actualFee: '￥18.90', postFee: '0.00' },
      subOrders: [{ quantity: 1 }]
    })
    expect(result).toMatchObject({
      purchase_price: '18.9',
      total_amount: '18.9',
      quantity: 1
    })
  })

  it('同一订单多种响应去重时保留后续响应里的金额', () => {
    const merged = mergeTaobaoOrderInfo(
      { order_no: 'TB-1', status: '买家已付款', purchase_price: '' },
      { order_no: 'TB-1', total_amount: '56.80', purchase_price: '28.40', quantity: 2 }
    )
    expect(merged).toEqual({
      order_no: 'TB-1',
      status: '买家已付款',
      total_amount: '56.80',
      purchase_price: '28.40',
      quantity: 2
    })
  })

  it('跨商品订单只记录整单实付，不把总额平均成错误单价', () => {
    expect(extractTaobaoOrderAmount({
      payInfo: { actualFee: '65.90', postFee: '0.00' },
      subOrders: [
        { quantity: 1, priceInfo: { realTotal: '47.00' } },
        { quantity: 1, priceInfo: { realTotal: '18.90' } }
      ]
    })).toEqual({
      total_amount: 65.9,
      shipping_fee: 0,
      purchase_price: 0,
      quantity: 2
    })
  })
})

describe('淘宝同步金额兜底接线', () => {
  it('首页解析无金额时按订单号查询 asyncBought 并回传总额', () => {
    const source = readFileSync(new URL('../src/main/purchase-order-sync/taobao.js', import.meta.url), 'utf8')
    expect(source).toContain('async function fetchTaobaoOrderAmountFromSession')
    expect(source).toContain('asyncBought.htm?action=itemlist/BoughtQueryAction')
    expect(source).toContain("completeWithOrderInfo(found, 'first_page')")
    expect(source).toContain('completed.total_amount = String(amount.total_amount)')
  })
})
