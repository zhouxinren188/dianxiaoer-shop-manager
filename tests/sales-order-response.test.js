import { describe, expect, it } from 'vitest'
import salesOrderResponse from '../src/main/sales-order-response.js'

const { isSuccessfulEmptySalesOrderResponse } = salesOrderResponse

describe('京东销售订单空结果识别', () => {
  it('把 queryOrderPage 成功返回的 totalItem=0 识别为有效空结果', () => {
    expect(isSuccessfulEmptySalesOrderResponse({
      msg: '成功',
      code: 200,
      data: { totalItem: 0, pageSize: 50, page: 1 }
    })).toBe(true)
  })

  it('兼容字符串状态码和其他总数字段', () => {
    expect(isSuccessfulEmptySalesOrderResponse({ code: '0', data: { totalCount: '0' } })).toBe(true)
  })

  it('不把失败响应或没有明确总数的响应当作空订单', () => {
    expect(isSuccessfulEmptySalesOrderResponse({ code: 500, data: { totalItem: 0 } })).toBe(false)
    expect(isSuccessfulEmptySalesOrderResponse({ code: 200, data: { page: 1 } })).toBe(false)
  })
})
