import { describe, expect, it, vi } from 'vitest'
import createCloudWarehouseRouter from '../server/routes/cloud-warehouse.js'

function commandRow() {
  return {
    request_id: 'request-active-001',
    owner_id: 18,
    purchase_order_id: 99,
    requested_by_user_id: 18,
    machine_code: 'YC-7F3K-92MX',
    command: 'exception.order.check',
    order_no: '3590463007646092',
    order_year: 2026,
    transport_status: 'executing',
    http_status: 202,
    reason: '',
    message_redacted: '',
    response_json: {},
    created_at: '2026-08-15 19:00:00',
    updated_at: '2026-08-15 19:00:01',
    completed_at: null
  }
}

function createPool() {
  return {
    execute: vi.fn(async sql => {
      if (sql.includes('FROM purchase_orders po')) {
        return [[{
          id: 99,
          owner_id: 18,
          purchase_no: 'A8277',
          platform: 'jd',
          account_id: 5,
          created_by: 18,
          sales_order_id: 321,
          sales_order_no: '3590463007646092',
          cloud_locator_version: 1
        }]]
      }
      if (sql.includes('SELECT 1 FROM cloud_machine_bindings')) return [[{ bound: 1 }]]
      if (sql.includes('FROM sales_orders so')) {
        return [[{
          sales_order_id: 321,
          platform_order_no: '3590463007646092',
          sales_order_time: '2026-08-15 13:00:00',
          order_year: 2026,
          store_owner_id: 18
        }]]
      }
      if (sql.includes("command IN ('exception.order.check', 'exception.order.resolve')")) {
        return [[commandRow()]]
      }
      if (sql.includes('FROM cloud_order_process_logs')) return [[]]
      if (sql.includes('WHERE owner_id = ? AND request_id = ?')) return [[commandRow()]]
      throw new Error(`unexpected_sql:${sql.replace(/\s+/g, ' ').trim()}`)
    })
  }
}

describe('云仓订单配置降级', () => {
  it('活跃任务刷新第三方状态失败时仍返回已有配置和刷新失败信息', async () => {
    const error = Object.assign(new Error('云仓助手接口请求失败：设备状态暂不可用'), {
      code: 'cloud_api_request_failed',
      httpStatus: 503
    })
    const apiClient = { getCommandResult: vi.fn(async () => { throw error }) }
    const router = createCloudWarehouseRouter(createPool(), { getApiClient: () => apiClient })
    const layer = router.stack.find(item => item.route?.path === '/orders/:purchaseOrderId/configuration')
    const req = {
      user: { id: 18, user_type: 'master' },
      params: { purchaseOrderId: '99' }
    }
    const res = {
      status: vi.fn(function status() { return this }),
      json: vi.fn()
    }

    await layer.route.stack[0].handle(req, res)

    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 0,
      data: expect.objectContaining({
        workflow: expect.objectContaining({
          state: 'executing',
          currentTask: expect.objectContaining({ taskId: 'request-active-001' }),
          refreshFailure: expect.objectContaining({
            reason: 'cloud_api_request_failed',
            httpStatus: 503
          })
        })
      })
    }))
  })
})
