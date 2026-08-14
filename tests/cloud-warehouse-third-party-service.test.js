import { describe, expect, it, vi } from 'vitest'
import service from '../server/services/cloud-warehouse-third-party-service.js'

const {
  buildCommandPayload,
  exceptionFromCommand,
  normalizeCommandResponse,
  normalizeMachineStatus,
  queryMachineStatus
} = service

describe('云仓助手在线状态', () => {
  it('解析在线、空闲和第一阶段能力', () => {
    expect(normalizeMachineStatus({
      httpStatus: 200,
      body: {
        machine_code: 'YC-7F3K-92MX',
        online: true,
        state: 'idle',
        capabilities: {
          'exception.order.check': true,
          'exception.order.resolve': true,
          'warehouse.order.print': true
        },
        active_request_id: null,
        checked_at: '2026-08-14T08:00:00.000Z'
      }
    }, 'YC-7F3K-92MX')).toEqual({
      machineCode: 'YC-7F3K-92MX',
      online: true,
      busy: false,
      status: 'idle',
      capabilities: {
        'exception.order.check': true,
        'exception.order.resolve': true
      },
      activeRequestId: null,
      checkedAt: '2026-08-14T08:00:00.000Z'
    })
  })

  it('子账号只能查询所属主账号体系绑定的机器码', async () => {
    const execute = vi.fn(async (sql, params) => {
      expect(sql).toContain('FROM cloud_machine_bindings')
      expect(params).toEqual([18])
      return [[{ machine_code: 'YC-7F3K-92MX' }]]
    })
    const getMachineStatus = vi.fn(async machineCode => ({
      httpStatus: 200,
      body: { machine_code: machineCode, online: true, state: 'idle', capabilities: {} }
    }))
    const result = await queryMachineStatus(
      { execute },
      { getMachineStatus },
      { id: 27, user_type: 'sub', parent_id: 18 }
    )
    expect(getMachineStatus).toHaveBeenCalledWith('YC-7F3K-92MX')
    expect(result.machineCode).toBe('YC-7F3K-92MX')
  })

  it('查询前会清理数据库机器码的首尾空格并统一为大写', async () => {
    const execute = vi.fn(async () => [[{ machine_code: '  yc-ex8w-9ted  ' }]])
    const getMachineStatus = vi.fn(async machineCode => ({
      httpStatus: 200,
      body: { machine_code: machineCode, online: true, state: 'idle', capabilities: {} }
    }))

    await queryMachineStatus(
      { execute },
      { getMachineStatus },
      { id: 18, user_type: 'master' }
    )

    expect(getMachineStatus).toHaveBeenCalledWith('YC-EX8W-9TED')
  })
})

describe('异常查询简化协议', () => {
  it('提交字段严格为 request_id、绑定机器码、固定命令、订单号和年份', () => {
    expect(buildCommandPayload({
      requestId: 'request-001',
      machineCode: 'YC-7F3K-92MX',
      command: 'exception.order.check',
      orderNo: '3589471019934064',
      orderYear: 2026
    })).toEqual({
      request_id: 'request-001',
      machine_code: 'YC-7F3K-92MX',
      command: 'exception.order.check',
      order_no: '3589471019934064',
      order_year: 2026
    })
  })

  it('解析查询到异常的最终结果和脱敏明细', () => {
    const response = {
      request_id: 'request-001',
      machine_code: 'YC-7F3K-92MX',
      command: 'exception.order.check',
      order_no: '3589471019934064',
      order_year: 2026,
      status: 'completed',
      completed_at: '2026-08-14T08:00:01.000Z',
      response: {
        status: 'succeeded',
        reason: 'query_completed',
        message: '查询到异常订单',
        result: {
          state: 'exception_found',
          exception_snapshot_ref: 'snapshot-ref',
          exception_count: 1,
          queried_at: '2026-08-14T08:00:01.000Z',
          exceptions: [{
            source: 'billexception',
            exception_type_masked: '异常类型',
            reason_masked: '异常原因',
            solution_masked: '处理方案'
          }]
        }
      }
    }
    const command = normalizeCommandResponse({ httpStatus: 200, body: response }, 'request-001', 'exception.order.check')
    expect(exceptionFromCommand(command)).toMatchObject({
      status: 'succeeded',
      resultShapeValid: true,
      exceptionCount: 1,
      state: 'exception_found',
      exceptionSnapshotRef: 'snapshot-ref',
      exceptions: [{
        source: 'billexception',
        exceptionTypeMasked: '异常类型',
        reasonMasked: '异常原因',
        solutionMasked: '处理方案'
      }]
    })
  })

  it('解析真实协议中的暂无异常结果', () => {
    const requestId = 'dxe-check-20260814-test'
    const normalized = normalizeCommandResponse({
      httpStatus: 200,
      body: {
        request_id: requestId,
        machine_code: 'YC-EX8W-9TED',
        command: 'exception.order.check',
        order_no: '3589471019934064',
        order_year: 2026,
        status: 'completed',
        completed_at: '2026-08-14T00:36:34.815Z',
        response: {
          protocol_version: '1.0',
          task_id: requestId,
          trace_id: requestId,
          command: 'exception.order.check',
          order_id: '3589471019934064',
          idempotency_key: requestId,
          status: 'succeeded',
          reason: 'query_completed',
          message: '暂无异常订单',
          result: {
            state: 'no_exception',
            exception_snapshot_ref: '',
            exception_count: 0,
            queried_at: '2026-08-14T00:36:34.815Z',
            exceptions: []
          }
        }
      }
    }, requestId, 'exception.order.check')

    expect(exceptionFromCommand(normalized)).toMatchObject({
      status: 'succeeded',
      reason: 'query_completed',
      message: '暂无异常订单',
      resultShapeValid: true,
      exceptionCount: 0,
      state: 'no_exception',
      exceptions: []
    })
  })

  it.each([
    ['merchant_session_expired', '云仓助手商家登录已失效'],
    ['exception_query_timeout', '云仓异常订单查询超时']
  ])('保留失败原因 %s 并使订单状态保持未知', (reason, message) => {
    const normalized = normalizeCommandResponse({
      httpStatus: 200,
      body: {
        status: 'completed',
        response: { status: 'failed', reason, message, result: null }
      }
    }, 'request-002', 'exception.order.check')
    expect(exceptionFromCommand(normalized)).toMatchObject({
      status: 'failed',
      reason,
      message,
      resultShapeValid: false
    })
  })

  it('HTTP 202保持原request_id进入轮询，不视为最终结果', () => {
    expect(normalizeCommandResponse({
      httpStatus: 202,
      body: { request_id: 'request-003', status: 'accepted' }
    }, 'request-003', 'exception.order.check')).toMatchObject({
      requestId: 'request-003',
      status: 'accepted',
      final: false
    })
  })
})
