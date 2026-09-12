import { describe, expect, it } from 'vitest'
import capturePolicy from '../src/main/sales-order-capture-policy.js'

const {
  DEFAULT_RESPONSE_CAPTURE_LIMIT,
  ORDER_PAGE_RESPONSE_CAPTURE_LIMIT,
  getSalesResponseCaptureLimit,
  limitSalesResponseBody
} = capturePolicy

describe('销售订单响应抓取上限', () => {
  it('订单主接口保留超过 200KB 的完整 JSON', () => {
    const body = JSON.stringify({
      code: 200,
      data: { results: [{ orderId: '1', description: 'x'.repeat(350000) }] }
    })

    const captured = limitSalesResponseBody(
      'https://sff.jd.com/api?api=dsm.order.bff.orderListBffService.queryOrderPage',
      body
    )

    expect(body.length).toBeGreaterThan(DEFAULT_RESPONSE_CAPTURE_LIMIT)
    expect(captured).toBe(body)
    expect(() => JSON.parse(captured)).not.toThrow()
  })

  it('普通静态资源仍限制为 200KB，避免无关响应占用过多内存', () => {
    const body = 'x'.repeat(DEFAULT_RESPONSE_CAPTURE_LIMIT + 100)
    expect(limitSalesResponseBody('https://example.com/app.js', body)).toHaveLength(DEFAULT_RESPONSE_CAPTURE_LIMIT)
  })

  it('订单主接口使用 2MB 上限', () => {
    expect(getSalesResponseCaptureLimit('https://sff.jd.com/api?api=queryOrderPage'))
      .toBe(ORDER_PAGE_RESPONSE_CAPTURE_LIMIT)
  })
})
