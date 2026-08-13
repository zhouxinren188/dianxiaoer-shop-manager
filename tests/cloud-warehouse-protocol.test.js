import { describe, expect, it } from 'vitest'
import protocol from '../server/services/cloud-warehouse-protocol.js'
import taskService from '../server/services/cloud-warehouse-task-service.js'
import orderService from '../server/services/cloud-warehouse-order-service.js'

const {
  MACHINE_CODE_PATTERN,
  buildTaskEnvelope,
  canManageMachineBinding,
  getTenantOwnerId,
  isValidMachineCode,
  normalizeMachineCode,
  validateSuccessfulWriteResponse
} = protocol

const {
  EXECUTOR_TRANSPORT_ENABLED,
  assertRouteReady,
  findExceptionSnapshotWorkflow
} = taskService
const {
  normalizeExceptionSummary,
  normalizeOrderYear,
  normalizeResolutionSummary,
  normalizeWorkflowSummary,
  readRelatedSalesLocator,
  resolveTrustedOrderMapping
} = orderService

const baseTask = {
  orderRefId: 'ord_018f56b6-a6ee-7df1-9b83-cf7bf4d0d001',
  workflowId: 'wf_018f56b6-a6ee-7df1-9b83-cf7bf4d0d002',
  requestedBy: {
    actor_id: 'user-001',
    actor_type: 'user',
    display_name: '操作人'
  },
  machineCode: 'YC-7F3K-92MX',
  now: new Date('2026-08-12T12:00:00.000Z')
}

describe('云仓助手机器码', () => {
  it('接受正式机器码格式并规范化小写输入', () => {
    expect(MACHINE_CODE_PATTERN.test('YC-7F3K-92MX')).toBe(true)
    expect(normalizeMachineCode('  yc-7f3k-92mx ')).toBe('YC-7F3K-92MX')
    expect(isValidMachineCode('yc-7f3k-92mx')).toBe(true)
  })

  it.each([
    'YC-0F3K-92MX',
    'YC-1F3K-92MX',
    'YC-IF3K-92MX',
    'YC-OF3K-92MX',
    'YC-7F3K-92M',
    'XX-7F3K-92MX'
  ])('拒绝无效机器码 %s', machineCode => {
    expect(isValidMachineCode(machineCode)).toBe(false)
  })
})

describe('主账号体系机器码绑定权限', () => {
  it('主账号和子账号都解析到同一个 owner_id', () => {
    expect(getTenantOwnerId({ id: 18, user_type: 'master', parent_id: null })).toBe(18)
    expect(getTenantOwnerId({ id: 27, user_type: 'sub', parent_id: 18 })).toBe(18)
  })

  it('只有主账号或管理员可以变更绑定', () => {
    expect(canManageMachineBinding({ user_type: 'master', role: 'staff' })).toBe(true)
    expect(canManageMachineBinding({ user_type: 'sub', role: 'admin' })).toBe(true)
    expect(canManageMachineBinding({ user_type: 'sub', role: 'staff' })).toBe(false)
  })
})

describe('中央路由安全门槛', () => {
  const route = {
    online: true,
    capabilities: {
      'exception.order.resolve': true,
      'warehouse.order.print': true,
      'warehouse.order.outbound': true
    },
    printerAvailable: false,
    loginEnvironmentAvailable: true
  }

  it('控制面已启用', () => {
    expect(EXECUTOR_TRANSPORT_ENABLED).toBe(true)
  })

  it.each(['warehouse.order.check', 'warehouse.order.print', 'warehouse.order.outbound'])('%s 第一轮保持禁用', command => {
    expect(() => assertRouteReady(route, command)).toThrow('该命令尚未在中央服务启用')
  })

  it('异常处理不要求打印机可用', () => {
    expect(() => assertRouteReady(route, 'exception.order.resolve')).not.toThrow()
  })
})

describe('云仓助手任务信封', () => {
  it('异常查询 params 必须为空对象', () => {
    expect(buildTaskEnvelope({ ...baseTask, command: 'exception.order.check', params: {} }).params).toEqual({})
    expect(() => buildTaskEnvelope({
      ...baseTask,
      command: 'exception.order.check',
      params: { platform_order_no: '123', order_year: 2026 }
    })).toThrow('params 当前必须为空对象')
  })

  it('异常处理 params 只能包含不透明 exception_snapshot_ref', () => {
    const task = buildTaskEnvelope({
      ...baseTask,
      command: 'exception.order.resolve',
      params: { exception_snapshot_ref: 'exsnap-random-opaque-reference' },
      confirmation: {
        confirmed: true,
        actor_id: 'user-001',
        action: 'exception.order.resolve'
      }
    })
    expect(task.params).toEqual({ exception_snapshot_ref: 'exsnap-random-opaque-reference' })
    expect(() => buildTaskEnvelope({
      ...baseTask,
      command: 'exception.order.resolve',
      params: { exception_snapshot_ref: 'exsnap-ok-value', internal_id: 'forbidden' },
      confirmation: {
        confirmed: true,
        actor_id: 'user-001',
        action: 'exception.order.resolve'
      }
    })).toThrow('params 只能包含 exception_snapshot_ref')
  })

  it('只读查询使用10分钟有效期且 target 只有 machine_code', () => {
    const task = buildTaskEnvelope({
      ...baseTask,
      command: 'warehouse.order.check',
      taskId: 'task-001',
      idempotencyKey: 'idem-001'
    })

    expect(task).toMatchObject({
      protocol_version: '1.0',
      task_id: 'task-001',
      trace_id: baseTask.workflowId,
      order_id: baseTask.orderRefId,
      command: 'warehouse.order.check',
      created_at: '2026-08-12T12:00:00.000Z',
      expires_at: '2026-08-12T12:10:00.000Z',
      target: { machine_code: 'YC-7F3K-92MX' },
      params: {}
    })
    expect(Object.keys(task).sort()).toEqual([
      'command',
      'created_at',
      'expires_at',
      'idempotency_key',
      'order_id',
      'params',
      'protocol_version',
      'requested_by',
      'target',
      'task_id',
      'trace_id'
    ].sort())
    expect(Object.keys(task.target)).toEqual(['machine_code'])
    expect(task).not.toHaveProperty('confirmation')
    expect(JSON.stringify(task)).not.toContain('requester_device_id')
    expect(JSON.stringify(task)).not.toContain('same_device_session_id')
  })

  it('写任务使用2分钟有效期并强制确认 action 与 command 相同', () => {
    const task = buildTaskEnvelope({
      ...baseTask,
      command: 'warehouse.order.print',
      taskId: 'task-002',
      idempotencyKey: 'idem-002',
      confirmation: {
        confirmed: true,
        confirmed_at: '2026-08-12T12:00:00.000Z',
        actor_id: 'user-001',
        action: 'warehouse.order.print'
      }
    })

    expect(task.expires_at).toBe('2026-08-12T12:02:00.000Z')
    expect(task.confirmation).toEqual({
      confirmed: true,
      confirmed_at: '2026-08-12T12:00:00.000Z',
      actor_id: 'user-001',
      action: 'warehouse.order.print'
    })

    expect(() => buildTaskEnvelope({
      ...baseTask,
      command: 'warehouse.order.print',
      confirmation: {
        confirmed: true,
        actor_id: 'user-001',
        action: 'warehouse.order.outbound'
      }
    })).toThrow('写命令需要与 command 完全一致的人工确认')
  })

  it('同一工作流的每轮查询生成新的 task_id 和 idempotency_key', () => {
    const first = buildTaskEnvelope({ ...baseTask, command: 'warehouse.order.check' })
    const second = buildTaskEnvelope({ ...baseTask, command: 'warehouse.order.check' })

    expect(first.trace_id).toBe(second.trace_id)
    expect(first.task_id).not.toBe(second.task_id)
    expect(first.idempotency_key).not.toBe(second.idempotency_key)
  })

  it('拒绝固定白名单以外的命令', () => {
    expect(() => buildTaskEnvelope({ ...baseTask, command: 'shell.execute' }))
      .toThrow('命令不在云仓助手固定命令白名单中')
  })
})

describe('订单定位与脱敏异常结果', () => {
  it('只从关联销售订单号和销售下单时间生成可信定位', async () => {
    expect(normalizeOrderYear(2026)).toBe(2026)
    expect(() => normalizeOrderYear(0)).toThrow('关联销售订单的下单时间无效')

    let locatorSql = ''
    const db = {
      execute: async sql => {
        locatorSql = sql
        return [[{
        sales_order_id: 321,
        platform_order_no: '3588401003348721',
        sales_order_time: '2026-08-12 13:07:12',
        order_year: 2026,
        store_owner_id: 18
        }]]
      }
    }
    await expect(readRelatedSalesLocator(db, {
      owner_id: 18,
      sales_order_id: 321,
      sales_order_no: '3588401003348721',
      cloud_locator_version: 1
    })).resolves.toEqual({
      salesOrderId: 321,
      platformOrderNo: '3588401003348721',
      salesOrderTime: '2026-08-12 13:07:12',
      orderYear: 2026,
      locatorVersion: 1
    })
    expect(locatorSql).toContain('YEAR(so.order_time)')
    expect(locatorSql).not.toContain('created_at')
  })

  it('页面结果只保留固定来源和脱敏字段', () => {
    const summary = normalizeExceptionSummary({
      task_id: 'task-check',
      execution_status: 'succeeded',
      result_redacted_json: {
        exception_snapshot_ref: 'exsnap-safe',
        exception_count: 1,
        queried_at: '2026-08-13T01:00:00.000Z',
        exceptions: [{
          source: 'billexception',
          exception_type_masked: '地址异常',
          reason_masked: '收货信息***',
          internal_exception_id: 'must-not-leak',
          url: 'https://must-not-leak.example'
        }]
      }
    })
    expect(summary.exceptions).toEqual([{
      source: 'billexception',
      exceptionTypeMasked: '地址异常',
      reasonMasked: '收货信息***'
    }])
    expect(summary.resultShapeValid).toBe(true)
    expect(JSON.stringify(summary)).not.toContain('must-not-leak')
  })

  it('异常处理只能使用当前订单十分钟内的成功异常快照', async () => {
    const now = new Date('2026-08-13T02:00:00.000Z')
    const pool = {
      execute: async () => [[{
        workflow_id: 'wf-safe',
        state: 'exception_found',
        current_task_id: null,
        task_id: 'task-check',
        execution_status: 'succeeded',
        completed_at: '2026-08-13T01:55:00.000Z',
        result_redacted_json: {
          exception_snapshot_ref: 'exsnap-safe-current-order',
          exception_count: 2
        }
      }]]
    }
    await expect(findExceptionSnapshotWorkflow(
      pool,
      18,
      baseTask.orderRefId,
      'exsnap-safe-current-order',
      now
    )).resolves.toMatchObject({ workflow_id: 'wf-safe', task_id: 'task-check' })
    await expect(findExceptionSnapshotWorkflow(
      pool,
      18,
      baseTask.orderRefId,
      'exsnap-other-order',
      now
    )).rejects.toMatchObject({ code: 'precondition_not_met' })
  })

  it('页面工作流摘要不暴露机器码、定位参数或执行器凭据', () => {
    const workflow = normalizeWorkflowSummary({
      workflow_id: 'wf-safe',
      state: 'checking_exception',
      current_task_id: 'task-safe',
      current_task_command: 'exception.order.check',
      current_transport_status: 'leased',
      current_execution_status: 'executing',
      target_machine_code: 'YC-7F3K-92MX',
      lease_id: 'must-not-leak'
    })
    const resolution = normalizeResolutionSummary({
      task_id: 'task-resolve',
      transport_status: 'completed',
      execution_status: 'succeeded',
      observed_status: 'waiting_arrival'
    })
    expect(workflow.currentTask).toMatchObject({
      taskId: 'task-safe',
      command: 'exception.order.check',
      executionStatus: 'executing'
    })
    expect(resolution.observedStatus).toBe('waiting_arrival')
    expect(JSON.stringify({ workflow, resolution })).not.toContain('YC-7F3K-92MX')
    expect(JSON.stringify({ workflow, resolution })).not.toContain('must-not-leak')
  })

  it('受信任映射仅向已领取任务的绑定执行器返回订单号和年份', async () => {
    const pool = {
      execute: async () => [[{
        task_id: 'task-001',
        order_ref_id: baseTask.orderRefId,
        target_machine_code: baseTask.machineCode,
        transport_status: 'leased',
        claimed_executor_instance_id: 'executor-001',
        lease_id: 'lease-001',
        lease_fencing_token: 1,
        expires_at: '2099-01-01T00:00:00.000Z',
        lease_expires_at: '2099-01-01T00:00:00.000Z',
        workflow_owner_id: 18,
        ref_owner_id: 18,
        order_owner_id: 18,
        store_owner_id: 18,
        linked_sales_order_id: 321,
        linked_sales_order_no: '987654321',
        resolved_sales_order_id: 321,
        platform_order_no: '987654321',
        sales_order_time: '2026-08-12 13:07:12',
        order_year: 2026,
        cloud_locator_version: 2,
        workflow_locator_version: 2,
        bound_machine_code: baseTask.machineCode,
        current_binding_version: 1,
        workflow_binding_version: 1,
        instance_machine_code: baseTask.machineCode,
        instance_status: 'online',
        instance_last_heartbeat_at: new Date().toISOString(),
        machine_status: 'online',
        active_executor_instance_id: 'executor-001'
      }]]
    }
    const mapping = await resolveTrustedOrderMapping(pool, {
      taskId: 'task-001',
      orderRefId: baseTask.orderRefId,
      machineCode: baseTask.machineCode,
      executorInstanceId: 'executor-001',
      leaseId: 'lease-001',
      fencingToken: 1
    })
    expect(mapping).toEqual({ platform_order_no: '987654321', order_year: 2026 })
    expect(Object.keys(mapping).sort()).toEqual(['order_year', 'platform_order_no'])
  })
})

describe('写后状态复验', () => {
  it('打印只有复验为 printed_unshipped 才是可信成功', () => {
    expect(validateSuccessfulWriteResponse({
      command: 'warehouse.order.print',
      status: 'succeeded',
      delivery: { business_confirmed: true },
      verification: { confirmed: true, observed_status: 'printed_unshipped' }
    })).toMatchObject({ valid: true, expectedStatus: 'printed_unshipped' })

    expect(validateSuccessfulWriteResponse({
      command: 'warehouse.order.print',
      status: 'succeeded',
      delivery: { business_confirmed: true },
      verification: { confirmed: true, observed_status: 'shipped' }
    })).toMatchObject({ valid: false, reason: 'business_state_unconfirmed' })
  })

  it('快速出库只有复验为 shipped 才允许中央服务标记 forwarded', () => {
    expect(validateSuccessfulWriteResponse({
      command: 'warehouse.order.outbound',
      status: 'succeeded',
      delivery: { business_confirmed: true },
      verification: { confirmed: true, observed_status: 'shipped' }
    })).toMatchObject({ valid: true, expectedStatus: 'shipped' })

    expect(validateSuccessfulWriteResponse({
      command: 'warehouse.order.outbound',
      status: 'succeeded',
      delivery: { business_confirmed: true },
      verification: { confirmed: true, observed_status: 'printed_unshipped' }
    })).toMatchObject({ valid: false, reason: 'business_state_unconfirmed' })
  })
})
