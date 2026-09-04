import { describe, expect, it, vi } from 'vitest'
import service from '../server/services/cloud-warehouse-third-party-service.js'

const {
  attachExternalCommands,
  applyConfirmedExceptionResolutionStatus,
  buildCommandPayload,
  buildWarehouseOrderCheckPayload,
  exceptionFromCommand,
  normalizeCommandResponse,
  normalizeMachineStatus,
  queryMachineStatus,
  recordAutomaticRemarkLog,
  refreshCommandResult,
  submitWarehouseOrderCheck,
  warehouseOrdersFromCommand
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
          'warehouse.order.check': true,
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
        'exception.order.resolve': true,
        'warehouse.order.check': true
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

describe('云仓订单全量查询协议', () => {
  it('查询命令不携带订单号、年份或订单数组', () => {
    expect(buildWarehouseOrderCheckPayload({
      requestId: 'warehouse-query-001',
      machineCode: 'YC-7F3K-92MX'
    })).toEqual({
      request_id: 'warehouse-query-001',
      machine_code: 'YC-7F3K-92MX',
      command: 'warehouse.order.check'
    })
  })

  it('按销售订单号解析状态和运单号，并只开放待打印订单', () => {
    expect(warehouseOrdersFromCommand({
      requestId: 'warehouse-query-001',
      command: 'warehouse.order.check',
      status: 'completed',
      executionStatus: 'succeeded',
      final: true,
      completedAt: '2026-09-02T08:00:00.000Z',
      result: {
        queried_at: '2026-09-02T08:00:00.000Z',
        orders: [{
          order_no: '3589471019934064',
          status: 'pending_print',
          logistics_no: 'JT1234567890'
        }, {
          sales_order_no: '3589471019934065',
          order_status: 'waiting_arrival',
          waybill_no: 'JT1234567891'
        }, {
          order_no: '3589471019934066',
          status: 'custom_status',
          printable: true
        }]
      }
    })).toMatchObject({
      resultShapeValid: true,
      orders: [{
        orderNo: '3589471019934064',
        status: 'pending_print',
        logisticsNo: 'JT1234567890',
        printable: true
      }, {
        orderNo: '3589471019934065',
        status: 'waiting_arrival',
        logisticsNo: 'JT1234567891',
        printable: false
      }, {
        orderNo: '3589471019934066',
        printable: true
      }]
    })
  })

  it('实际提交时只发送一次全量查询命令并保存结果', async () => {
    let storedResponse = null
    let storedStatus = 'submitting'
    let storedHttpStatus = null
    const execute = vi.fn(async (sql, params) => {
      if (sql.includes('FROM cloud_machine_bindings')) {
        return [[{ machine_code: 'YC-7F3K-92MX' }]]
      }
      if (sql.includes('purchase_order_id IS NULL') && sql.includes('SELECT request_id')) {
        return [[]]
      }
      if (sql.includes('INSERT INTO cloud_external_commands')) {
        expect(params).toHaveLength(4)
        return [{ affectedRows: 1 }]
      }
      if (sql.includes('SET transport_status = ?')) {
        storedStatus = params[0]
        storedHttpStatus = params[1]
        storedResponse = params[4]
        return [{ affectedRows: 1 }]
      }
      if (sql.includes('WHERE owner_id = ? AND request_id = ?') && sql.includes('SELECT request_id')) {
        return [[{
          request_id: params[1],
          purchase_order_id: null,
          machine_code: 'YC-7F3K-92MX',
          command: 'warehouse.order.check',
          order_no: '',
          order_year: null,
          transport_status: storedStatus,
          http_status: storedHttpStatus,
          reason: 'query_completed',
          message_redacted: '查询完成',
          response_json: storedResponse,
          created_at: '2026-09-02 08:00:00',
          updated_at: '2026-09-02 08:00:01',
          completed_at: '2026-09-02 08:00:01'
        }]]
      }
      throw new Error(`unexpected_sql:${sql.replace(/\s+/g, ' ').trim()}`)
    })
    const submitCommand = vi.fn(async payload => ({
      httpStatus: 200,
      body: {
        request_id: payload.request_id,
        command: 'warehouse.order.check',
        status: 'completed',
        response: {
          status: 'succeeded',
          reason: 'query_completed',
          message: '查询完成',
          result: {
            orders: [{
              order_no: '3589471019934064',
              status: 'pending_print',
              logistics_no: 'JT1234567890'
            }]
          }
        }
      }
    }))

    const result = await submitWarehouseOrderCheck(
      { execute },
      {
        getMachineStatus: vi.fn(async () => ({
          httpStatus: 200,
          body: {
            machine_code: 'YC-7F3K-92MX',
            online: true,
            state: 'idle',
            capabilities: { 'warehouse.order.check': true }
          }
        })),
        submitCommand
      },
      { user: { id: 18, user_type: 'master' } }
    )

    expect(submitCommand).toHaveBeenCalledWith({
      request_id: expect.any(String),
      machine_code: 'YC-7F3K-92MX',
      command: 'warehouse.order.check'
    })
    expect(result).toMatchObject({
      final: true,
      resultShapeValid: true,
      orders: [{
        orderNo: '3589471019934064',
        logisticsNo: 'JT1234567890',
        printable: true
      }]
    })
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

describe('异常处理后的复查结果', () => {
  it('远端明确返回指令不存在时结束本地处理中状态并允许再次操作', async () => {
    let row = {
      request_id: 'request-missing-001',
      purchase_order_id: 99,
      machine_code: 'YC-7F3K-92MX',
      command: 'exception.order.resolve',
      order_no: '3590463007646092',
      order_year: 2026,
      transport_status: 'executing',
      http_status: 202,
      reason: '',
      message_redacted: '',
      response_json: {},
      created_at: '2026-08-16 17:09:19',
      updated_at: '2026-08-16 17:09:20',
      completed_at: null
    }
    const execute = vi.fn(async (sql, params) => {
      if (sql.includes('WHERE owner_id = ? AND request_id = ?') && sql.includes('SELECT request_id')) {
        return [[row]]
      }
      if (sql.includes("SET transport_status = 'failed'")) {
        row = {
          ...row,
          transport_status: 'failed',
          http_status: params[0],
          reason: 'remote_command_not_found',
          message_redacted: params[1],
          response_json: JSON.parse(params[2]),
          completed_at: '2026-08-16 17:09:30'
        }
        return [{ affectedRows: 1 }]
      }
      throw new Error(`unexpected_sql:${sql.replace(/\s+/g, ' ').trim()}`)
    })
    const missing = Object.assign(new Error('云仓助手接口请求失败：指令不存在'), {
      code: 'cloud_api_request_failed',
      httpStatus: 404,
      responseBody: { message: '指令不存在' }
    })

    const result = await refreshCommandResult(
      { execute },
      { getCommandResult: vi.fn(async () => { throw missing }) },
      { id: 18, user_type: 'master' },
      row.request_id
    )

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'remote_command_not_found',
      message: '云仓助手接口请求失败：指令不存在'
    })
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("SET transport_status = 'failed'"),
      expect.arrayContaining([404, '云仓助手接口请求失败：指令不存在'])
    )
  })

  it('最新复查结果优先于较早的处理回执决定页面状态', async () => {
    const rows = [{
      request_id: 'check-after-resolve',
      command: 'exception.order.check',
      transport_status: 'completed',
      http_status: 200,
      reason: 'query_completed',
      message_redacted: '仍有异常',
      response_json: {
        status: 'completed',
        response: {
          status: 'succeeded',
          reason: 'query_completed',
          result: {
            state: 'exception_found',
            exception_count: 1,
            exceptions: [{ source: 'billexception', exception_type_masked: '异常' }]
          }
        }
      },
      created_at: '2026-08-15 16:20:00',
      updated_at: '2026-08-15 16:20:01',
      completed_at: '2026-08-15 16:20:01'
    }, {
      request_id: 'resolve-before-check',
      command: 'exception.order.resolve',
      transport_status: 'completed',
      http_status: 200,
      reason: 'business_state_confirmed',
      message_redacted: '处理完成',
      response_json: {
        status: 'completed',
        response: {
          status: 'succeeded',
          reason: 'business_state_confirmed',
          result: { state: 'waiting_arrival' }
        }
      },
      created_at: '2026-08-15 16:19:00',
      updated_at: '2026-08-15 16:19:01',
      completed_at: '2026-08-15 16:19:01'
    }]
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([rows])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([{ affectedRows: 1 }])
    }

    const config = await attachExternalCommands(
      pool,
      { id: 18, user_type: 'master' },
      99,
      { purchaseOrderId: 99 }
    )

    expect(config.workflow.state).toBe('exception_found')
    expect(config.exception.resultRecordedAt).toBe('2026-08-15 16:20:01')
    expect(config.exceptionResolution.resultRecordedAt).toBe('2026-08-15 16:19:01')
    expect(pool.execute).toHaveBeenLastCalledWith(
      expect.stringContaining("SET status = 'pending_print'"),
      [99, 18, 'shipped', 'in_transit', 'received']
    )
  })

  it('only a confirmed successful exception resolution advances the order to pending print', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }])
    await expect(applyConfirmedExceptionResolutionStatus({ execute }, 18, 99, {
      command: 'exception.order.resolve',
      status: 'completed',
      executionStatus: 'succeeded'
    })).resolves.toBe(true)
    await expect(applyConfirmedExceptionResolutionStatus({ execute }, 18, 99, {
      command: 'exception.order.resolve',
      status: 'accepted',
      executionStatus: ''
    })).resolves.toBe(false)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('keeps a confirmed cloud result authoritative when the local status projection needs retry', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('temporary database failure'))
    await expect(applyConfirmedExceptionResolutionStatus({ execute }, 18, 99, {
      command: 'exception.order.resolve',
      status: 'completed',
      executionStatus: 'succeeded'
    })).resolves.toBe(false)
  })

  it('自动备注结果按主账号体系和实际操作人持久化为脱敏日志', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[{
        id: 99,
        owner_id: 18,
        purchase_no: 'A8277',
        sales_order_id: 321,
        sales_order_no: '3590461014281824'
      }]])
      .mockResolvedValueOnce([{ insertId: 456 }])

    const log = await recordAutomaticRemarkLog(
      { execute },
      { id: 27, user_type: 'sub', parent_id: 18 },
      99,
      { success: false, message: 'Cookie=secret-value 京东返回失败' }
    )

    expect(execute.mock.calls[1][1]).toEqual([
      18,
      99,
      27,
      'failed',
      'Cookie=[已脱敏] 京东返回失败'
    ])
    expect(log).toMatchObject({
      id: 'local:456',
      action: 'auto_remark',
      status: 'failed',
      message: 'Cookie=[已脱敏] 京东返回失败'
    })
  })
})
