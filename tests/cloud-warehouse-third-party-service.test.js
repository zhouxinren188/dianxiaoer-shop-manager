import { describe, expect, it, vi } from 'vitest'
import service from '../server/services/cloud-warehouse-third-party-service.js'

const {
  attachExternalCommands,
  applyConfirmedOrderCommandStatus,
  applyConfirmedExceptionResolutionStatus,
  buildCommandPayload,
  buildWarehouseOrderCheckPayload,
  exceptionFromCommand,
  normalizeCommandResponse,
  normalizeMachineStatus,
  queryMachineStatus,
  recordAutomaticRemarkLog,
  refreshCommandResult,
  reprintFromCommand,
  scopeWarehouseOrderChecks,
  submitOrderReprint,
  submitWarehouseOrderCheck,
  warehouseOrdersFromCommand,
  writeResultFromCommand
} = service

describe('多仓机器订单隔离', () => {
  it('共用同一机器时只向当前账号返回本次请求涉及的订单', () => {
    const checks = [{
      requestId: 'machine-query-001',
      orders: [
        { orderNo: '3615402003343756', printable: true },
        { orderNo: 'OTHER-OWNER-ORDER', printable: true }
      ]
    }]

    expect(scopeWarehouseOrderChecks(checks, new Set(['3615402003343756']))[0].orders).toEqual([
      { orderNo: '3615402003343756', printable: true }
    ])
    expect(checks[0].orders).toHaveLength(2)
  })
})

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
        'warehouse.order.check': true,
        'warehouse.order.print': true,
        'warehouse.order.outbound': false,
        'warehouse.order.reprint': false
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

describe('云仓订单逐单查询协议', () => {
  it('查询命令携带销售订单号和年份', () => {
    expect(buildWarehouseOrderCheckPayload({
      requestId: 'warehouse-query-001',
      machineCode: 'YC-7F3K-92MX',
      orderNo: '3589471019934064',
      orderYear: 2026
    })).toEqual({
      request_id: 'warehouse-query-001',
      machine_code: 'YC-7F3K-92MX',
      command: 'warehouse.order.check',
      order_no: '3589471019934064',
      order_year: 2026
    })
  })

  it('解析现行逐单入单核验回执', () => {
    expect(warehouseOrdersFromCommand({
      requestId: 'warehouse-query-single',
      command: 'warehouse.order.check',
      orderNo: '3589471019934064',
      orderYear: 2026,
      status: 'completed',
      executionStatus: 'succeeded',
      final: true,
      result: {
        state: 'waiting_arrival',
        exists: false,
        waybill_no: '',
        queried_at: '2026-09-08T10:24:10.673Z'
      }
    })).toMatchObject({
      resultShapeValid: true,
      orders: [{
        orderNo: '3589471019934064',
        status: 'waiting_arrival',
        printable: false
      }]
    })
  })

  it('订单已入云仓时开放打印并带回运单号', () => {
    expect(warehouseOrdersFromCommand({
      requestId: 'warehouse-query-arrived',
      command: 'warehouse.order.check',
      orderNo: '3589471019934064',
      orderYear: 2026,
      status: 'completed',
      executionStatus: 'succeeded',
      final: true,
      result: {
        state: 'arrived',
        exists: true,
        waybill_no: 'JDV029243091652'
      }
    })).toMatchObject({
      resultShapeValid: true,
      orders: [{
        orderNo: '3589471019934064',
        status: 'arrived',
        logisticsNo: 'JDV029243091652',
        printable: true
      }]
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

  it('轮询结果继续使用 request_id 保存的订单范围过滤', () => {
    const result = warehouseOrdersFromCommand({
      requestId: 'warehouse-query-scoped',
      command: 'warehouse.order.check',
      status: 'completed',
      executionStatus: 'succeeded',
      final: true,
      scopeOrderNos: ['3589471019934064'],
      result: {
        orders: [
          { order_no: '3589471019934064', status: 'pending_print' },
          { order_no: 'OTHER-OWNER-ORDER', status: 'pending_print' }
        ]
      }
    })

    expect(result.orders.map(order => order.orderNo)).toEqual(['3589471019934064'])
  })

  it('实际提交时发送一次逐单查询命令并保存结果', async () => {
    let storedResponse = null
    let storedStatus = 'submitting'
    let storedHttpStatus = null
    const execute = vi.fn(async (sql, params) => {
      if (sql.includes('FROM cloud_machine_bindings')) {
        return [[{ machine_code: 'YC-7F3K-92MX' }]]
      }
      if (sql.includes('SELECT request_id FROM cloud_external_commands') && sql.includes('transport_status IN')) {
        return [[]]
      }
      if (sql.includes('INSERT INTO cloud_external_commands')) {
        expect(params).toHaveLength(7)
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
          purchase_order_id: 99,
          machine_code: 'YC-7F3K-92MX',
          command: 'warehouse.order.check',
          order_no: '3589471019934064',
          order_year: 2026,
          scope_order_nos: null,
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
            state: 'arrived',
            exists: true,
            waybill_no: 'JT1234567890'
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
      {
        user: { id: 18, user_type: 'master' },
        purchaseOrderId: 99,
        machineCode: 'YC-7F3K-92MX',
        orderNo: '3589471019934064',
        orderYear: 2026
      }
    )

    expect(submitCommand).toHaveBeenCalledWith({
      request_id: expect.any(String),
      machine_code: 'YC-7F3K-92MX',
      command: 'warehouse.order.check',
      order_no: '3589471019934064',
      order_year: 2026
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

describe('通道补打协议', () => {
  function responseFor({
    httpStatus = 200,
    outerStatus = 'completed',
    executionStatus = 'succeeded',
    businessConfirmed = true,
    code = 'reprinted',
    printedCount = 1
  } = {}) {
    const requestId = 'reprint-request-001'
    return {
      requestId,
      normalized: normalizeCommandResponse({
        httpStatus,
        body: {
          request_id: requestId,
          command: 'warehouse.order.reprint',
          status: outerStatus,
          response: {
            status: executionStatus,
            delivery: { business_confirmed: businessConfirmed },
            result: { code, printedCount }
          }
        }
      }, requestId, 'warehouse.order.reprint')
    }
  }

  it('复用统一指令地址所需的五个请求字段', () => {
    expect(buildCommandPayload({
      requestId: 'reprint-request-001',
      machineCode: 'YC-7F3K-92MX',
      command: 'warehouse.order.reprint',
      orderNo: '3589471019934064',
      orderYear: 2026
    })).toEqual({
      request_id: 'reprint-request-001',
      machine_code: 'YC-7F3K-92MX',
      command: 'warehouse.order.reprint',
      order_no: '3589471019934064',
      order_year: 2026
    })
  })

  it('仅在所有补打成功条件同时满足时确认出纸', () => {
    const { normalized } = responseFor({ printedCount: 2 })
    expect(reprintFromCommand(normalized)).toMatchObject({
      requestId: 'reprint-request-001',
      httpStatus: 200,
      transportStatus: 'completed',
      status: 'succeeded',
      terminal: true,
      succeeded: true,
      businessConfirmed: true,
      code: 'reprinted',
      printedCount: 2
    })
  })

  it.each([
    [{ executionStatus: 'review_required' }, 'review_required'],
    [{ businessConfirmed: false }, 'succeeded'],
    [{ code: 'printed' }, 'succeeded'],
    [{ printedCount: 0 }, 'succeeded']
  ])('任一业务成功条件缺失都转人工复核 %#', (overrides, expectedStatus) => {
    const { normalized } = responseFor(overrides)
    expect(reprintFromCommand(normalized)).toMatchObject({
      status: expectedStatus,
      terminal: true,
      succeeded: false,
      resultShapeValid: false
    })
  })

  it('HTTP 202 保留原 request_id 且只标记为执行中', () => {
    const requestId = 'reprint-request-202'
    const normalized = normalizeCommandResponse({
      httpStatus: 202,
      body: { request_id: requestId, command: 'warehouse.order.reprint', status: 'accepted' }
    }, requestId, 'warehouse.order.reprint')
    expect(reprintFromCommand(normalized)).toMatchObject({
      requestId,
      transportStatus: 'accepted',
      terminal: false,
      succeeded: false
    })
  })

  it('存在进行中补打时直接复用原 request_id，不检查设备也不再次提交', async () => {
    const requestId = 'reprint-request-existing'
    const execute = vi.fn(async (sql, params) => {
      if (sql.includes('FROM purchase_orders po')) {
        return [[{
          id: 99,
          owner_id: 18,
          purchase_no: 'A99',
          sales_order_id: 321,
          sales_order_no: '3589471019934064'
        }]]
      }
      if (sql.includes('SELECT request_id FROM cloud_external_commands') && sql.includes('AND command = ?')) {
        expect(params).toEqual([18, 99, 'warehouse.order.reprint'])
        return [[{ request_id: requestId }]]
      }
      if (sql.includes('SELECT request_id, purchase_order_id') && sql.includes('WHERE owner_id = ? AND request_id = ?')) {
        return [[{
          request_id: requestId,
          purchase_order_id: 99,
          machine_code: 'YC-7F3K-92MX',
          command: 'warehouse.order.reprint',
          order_no: '3589471019934064',
          order_year: 2026,
          transport_status: 'accepted',
          http_status: 202,
          reason: '',
          message_redacted: '',
          response_json: {
            request_id: requestId,
            command: 'warehouse.order.reprint',
            status: 'accepted'
          },
          created_at: '2026-09-07 09:00:00',
          updated_at: '2026-09-07 09:00:01',
          completed_at: null
        }]]
      }
      throw new Error(`unexpected_sql:${sql.replace(/\s+/g, ' ').trim()}`)
    })
    const apiClient = {
      getMachineStatus: vi.fn(),
      submitCommand: vi.fn()
    }

    const result = await submitOrderReprint(
      { execute },
      apiClient,
      { user: { id: 18, user_type: 'master' }, purchaseOrderId: 99 }
    )

    expect(result).toMatchObject({
      requestId,
      transportStatus: 'accepted',
      terminal: false,
      succeeded: false
    })
    expect(apiClient.getMachineStatus).not.toHaveBeenCalled()
    expect(apiClient.submitCommand).not.toHaveBeenCalled()
  })
})

describe('云仓打印与发货协议', () => {
  function responseFor(command, {
    httpStatus = 200,
    outerStatus = 'completed',
    executionStatus = 'succeeded',
    businessConfirmed = true,
    verificationConfirmed = true,
    observedStatus = command === 'warehouse.order.print' ? 'printed_unshipped' : 'shipped'
  } = {}) {
    const requestId = `${command}-request-001`
    return normalizeCommandResponse({
      httpStatus,
      body: {
        request_id: requestId,
        command,
        status: outerStatus,
        response: {
          status: executionStatus,
          delivery: { business_confirmed: businessConfirmed },
          verification: {
            confirmed: verificationConfirmed,
            observed_status: observedStatus
          },
          result: {}
        }
      }
    }, requestId, command)
  }

  it.each([
    ['warehouse.order.print', 'printed_unshipped'],
    ['warehouse.order.outbound', 'shipped']
  ])('%s 使用统一五字段请求并严格复验 %s', (command, expectedStatus) => {
    expect(buildCommandPayload({
      requestId: `${command}-request-001`,
      machineCode: 'YC-7F3K-92MX',
      command,
      orderNo: '3589471019934064',
      orderYear: 2026
    })).toEqual({
      request_id: `${command}-request-001`,
      machine_code: 'YC-7F3K-92MX',
      command,
      order_no: '3589471019934064',
      order_year: 2026
    })
    expect(writeResultFromCommand(responseFor(command))).toMatchObject({
      command,
      httpStatus: 200,
      transportStatus: 'completed',
      status: 'succeeded',
      terminal: true,
      succeeded: true,
      businessConfirmed: true,
      verificationConfirmed: true,
      observedStatus: expectedStatus
    })
  })

  it.each([
    [{ httpStatus: 202, outerStatus: 'accepted' }, false],
    [{ executionStatus: 'review_required' }, true],
    [{ businessConfirmed: false }, true],
    [{ verificationConfirmed: false }, true],
    [{ observedStatus: 'shipped' }, true]
  ])('打印任一成功条件缺失都不确认成功 %#', (overrides, terminal) => {
    expect(writeResultFromCommand(responseFor('warehouse.order.print', overrides))).toMatchObject({
      terminal,
      succeeded: false,
      resultShapeValid: false
    })
  })

  it('仅严格确认的发货回执会将采购单投影为已转发', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }])
    await expect(applyConfirmedOrderCommandStatus(
      { execute },
      18,
      99,
      responseFor('warehouse.order.outbound')
    )).resolves.toBe(true)
    await expect(applyConfirmedOrderCommandStatus(
      { execute },
      18,
      99,
      responseFor('warehouse.order.outbound', { verificationConfirmed: false })
    )).resolves.toBe(false)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'forwarded'"),
      [99, 18, 'pending_print', 'shipped', 'in_transit', 'received']
    )
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
