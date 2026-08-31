import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createDesktopCommandBusinessHandlers
} = require('../src/main/desktop-command-business-handlers')

function makeContext() {
  return {
    assertActive: vi.fn(),
    reportProgress: vi.fn(async () => ({ accepted: true }))
  }
}

function finalCheckConfiguration(count) {
  return {
    workflow: { currentTask: null },
    exception: {
      resultShapeValid: true,
      status: 'succeeded',
      exceptionCount: count,
      message: count > 0 ? '发现异常' : '暂无异常'
    }
  }
}

describe('desktop purchase exception business handlers', () => {
  it('submits one query command and waits for a confirmed compact result', async () => {
    let configurationReads = 0
    let nowMs = Date.parse('2026-08-31T03:00:00.000Z')
    const requestApi = vi.fn(async request => {
      if (request.method === 'POST' && request.endpoint.endsWith('/exception/check')) {
        return { status: 'accepted' }
      }
      if (request.method === 'GET' && request.endpoint.endsWith('/cloud-configuration')) {
        configurationReads += 1
        if (configurationReads === 1) {
          return {
            workflow: {
              currentTask: {
                command: 'exception.order.check',
                transportStatus: 'executing'
              }
            }
          }
        }
        return finalCheckConfiguration(2)
      }
      throw new Error('unexpected request: ' + request.method + ' ' + request.endpoint)
    })
    const context = makeContext()
    const handlers = createDesktopCommandBusinessHandlers({
      requestApi,
      submitVendorRemark: vi.fn(),
      now: () => nowMs,
      sleep: vi.fn(async ms => { nowMs += ms })
    })

    await expect(handlers['purchase.exception.check'](
      { purchase_order_id: 18 },
      context
    )).resolves.toMatchObject({
      purchase_order_id: 18,
      state: 'exception_found',
      exception_count: 2
    })
    expect(requestApi.mock.calls.filter(([request]) => request.endpoint.endsWith('/exception/check'))).toHaveLength(1)
    expect(configurationReads).toBe(2)
    expect(context.reportProgress).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'checking_exception'
    }))
  })

  it('runs remark, resolve and verification in order without replaying writes', async () => {
    let configurationReads = 0
    const requests = []
    const requestApi = vi.fn(async request => {
      requests.push(request)
      if (request.method === 'GET' && request.endpoint === '/purchase-orders/21') {
        return { id: 21, purchase_no: 'A8873', sales_order_id: 91 }
      }
      if (request.method === 'GET' && request.endpoint.endsWith('/related-sales')) {
        return { storeId: 7, orderId: '3596445007470240', storePlatform: 'jd' }
      }
      if (request.method === 'GET' && request.endpoint.endsWith('/cloud-configuration')) {
        configurationReads += 1
        if (configurationReads === 1) {
          return {
            workflow: { currentTask: null },
            exceptionResolution: {
              transportStatus: 'completed',
              status: 'succeeded'
            }
          }
        }
        return finalCheckConfiguration(0)
      }
      return { accepted: true }
    })
    const submitVendorRemark = vi.fn(async () => ({
      success: true,
      message: '采购编号已自动备注到京东订单'
    }))
    const context = makeContext()
    const handlers = createDesktopCommandBusinessHandlers({
      requestApi,
      submitVendorRemark,
      sleep: vi.fn(async () => {})
    })

    await expect(handlers['purchase.exception.resolve'](
      { purchase_order_id: 21, confirmed: true },
      context
    )).resolves.toMatchObject({
      purchase_order_id: 21,
      remark_succeeded: true,
      resolve_state: 'succeeded',
      verification_state: 'exception_clear',
      remaining_exception_count: 0
    })
    expect(submitVendorRemark).toHaveBeenCalledWith({
      storeId: 7,
      orderId: '3596445007470240',
      remark: 'A8873'
    })
    const endpoints = requests.map(request => request.endpoint)
    expect(endpoints.filter(endpoint => endpoint.endsWith('/exception/resolve'))).toHaveLength(1)
    expect(endpoints.filter(endpoint => endpoint.endsWith('/exception/check'))).toHaveLength(1)
    expect(endpoints.filter(endpoint => endpoint.endsWith('/auto-remark-log'))).toHaveLength(1)
    expect(endpoints.filter(endpoint => endpoint === '/sales-orders/91/order-remark')).toHaveLength(1)
    expect(endpoints.indexOf('/purchase-orders/21/exception/resolve'))
      .toBeLessThan(endpoints.indexOf('/purchase-orders/21/exception/check'))
  })

  it('continues exception resolution when the JD remark fails', async () => {
    let configurationReads = 0
    const requestApi = vi.fn(async request => {
      if (request.endpoint === '/purchase-orders/22') {
        return { id: 22, purchase_no: 'A9001', sales_order_id: 92 }
      }
      if (request.endpoint.endsWith('/related-sales')) {
        return { storeId: 8, orderId: '3600000000000001', storePlatform: 'jd' }
      }
      if (request.endpoint.endsWith('/cloud-configuration')) {
        configurationReads += 1
        return configurationReads === 1
          ? {
              workflow: { currentTask: null },
              exceptionResolution: { transportStatus: 'completed', status: 'succeeded' }
            }
          : finalCheckConfiguration(0)
      }
      return { accepted: true }
    })
    const handlers = createDesktopCommandBusinessHandlers({
      requestApi,
      submitVendorRemark: vi.fn(async () => ({ success: false, message: '店铺未登录' })),
      sleep: vi.fn(async () => {})
    })

    await expect(handlers['purchase.exception.resolve'](
      { purchase_order_id: 22, confirmed: true },
      makeContext()
    )).resolves.toMatchObject({
      remark_succeeded: false,
      remark_message: '店铺未登录',
      verification_state: 'exception_clear'
    })
    expect(requestApi.mock.calls.some(([request]) => request.endpoint.endsWith('/exception/resolve'))).toBe(true)
    expect(requestApi.mock.calls.some(([request]) => request.endpoint === '/sales-orders/92/order-remark')).toBe(false)
  })
})
