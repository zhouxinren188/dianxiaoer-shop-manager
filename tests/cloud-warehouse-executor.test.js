import { describe, expect, it, vi } from 'vitest'
import authService from '../server/services/cloud-warehouse-executor-auth-service.js'
import executorService from '../server/services/cloud-warehouse-executor-service.js'
import executorRoute from '../server/routes/cloud-warehouse-executor.js'

const MACHINE_CODE = 'YC-7F3K-92MX'
const INSTANCE_ID = 'executor-instance-001'
const NOW = new Date('2026-08-13T01:00:00.000Z')

const {
  assertExactKeys,
  authenticateAccessToken,
  enrollExecutor,
  hashOpaqueSecret,
  issueExecutorToken,
  safeHashEqual,
  toMysqlDate
} = authService

const {
  ENABLED_EXECUTOR_COMMANDS,
  claimTask,
  normalizeEnabledCapabilities,
  normalizeExecutorResponse,
  normalizeHeartbeatPayload,
  normalizeMappingPayload,
  markExpiredReadTasksForReview,
  markExpiredWriteTasksForReview,
  recordHeartbeat,
  recordTaskResult,
  redactMessage,
  renewLease,
  reportExecuting,
  runExecutorMaintenance
} = executorService

describe('执行器独立认证', () => {
  it('一次性登记码换取独立执行器凭据且数据库不保存明文密钥', async () => {
    const calls = []
    const enrollmentCode = 'enroll_one-time-secret'
    const connection = {
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
      execute: vi.fn(async (sql, params) => {
        calls.push({ sql, params })
        if (sql.includes('FROM cloud_executor_enrollments')) {
          return [[{
            enrollment_id: 'enrollment-001',
            owner_id: 18,
            machine_code: MACHINE_CODE,
            bound_machine_code: MACHINE_CODE,
            expires_at: '2026-08-13T01:10:00.000Z',
            used_at: null
          }]]
        }
        return [{ affectedRows: 1 }]
      })
    }
    const credential = await enrollExecutor({ getConnection: async () => connection }, {
      protocol_version: '1.0',
      machine_code: MACHINE_CODE,
      enrollment_code: enrollmentCode,
      executor_instance_id: INSTANCE_ID,
      executor_version: '1.0.0',
      started_at: NOW.toISOString()
    }, NOW)

    expect(credential).toMatchObject({ machine_code: MACHINE_CODE })
    expect(credential.client_id).toMatch(/^exec_/)
    expect(credential.client_secret).toMatch(/^execsec_/)
    const persistedText = JSON.stringify(calls)
    expect(persistedText).not.toContain(enrollmentCode)
    expect(persistedText).not.toContain(credential.client_secret)
    expect(connection.commit).toHaveBeenCalledOnce()
  })

  it('只保存客户端密钥和访问令牌的哈希', async () => {
    const calls = []
    const secret = 'execsec_top-secret-value'
    const pool = {
      execute: vi.fn(async (sql, params) => {
        calls.push({ sql, params })
        if (sql.includes('FROM cloud_executor_credentials')) {
          return [[{
            credential_id: 'execred-001',
            machine_code: MACHINE_CODE,
            secret_hash: hashOpaqueSecret(secret),
            status: 'active',
            bound_machine_code: MACHINE_CODE
          }]]
        }
        return [{ affectedRows: 1 }]
      })
    }
    const token = await issueExecutorToken(pool, {
      grant_type: 'client_credentials',
      client_id: 'exec-client-001',
      client_secret: secret
    }, NOW)

    expect(token).toMatchObject({ token_type: 'Bearer', expires_in: 900, machine_code: MACHINE_CODE })
    expect(token.access_token).toMatch(/^exectok_/)
    const storedText = JSON.stringify(calls.slice(1))
    expect(storedText).not.toContain(secret)
    expect(storedText).not.toContain(token.access_token)
    expect(storedText).toContain(hashOpaqueSecret(token.access_token))
  })

  it('访问令牌必须有效、未吊销且机器码仍有绑定', async () => {
    const accessToken = 'exectok_safe-random-value'
    const pool = {
      execute: vi.fn(async sql => {
        if (sql.includes('FROM cloud_executor_access_tokens')) {
          return [[{
            credential_id: 'execred-001',
            machine_code: MACHINE_CODE,
            expires_at: '2026-08-13T01:10:00.000Z',
            revoked_at: null,
            credential_status: 'active',
            bound_machine_code: MACHINE_CODE
          }]]
        }
        return [{ affectedRows: 1 }]
      })
    }
    await expect(authenticateAccessToken(pool, accessToken, NOW)).resolves.toMatchObject({
      credentialId: 'execred-001',
      machineCode: MACHINE_CODE
    })
  })

  it('使用定时安全比较并拒绝未知字段', () => {
    expect(safeHashEqual('abc', 'abc')).toBe(true)
    expect(safeHashEqual('abc', 'abd')).toBe(false)
    expect(() => assertExactKeys({ allowed: true, cookie: 'forbidden' }, ['allowed'], 'request'))
      .toThrow('包含未知字段')
  })

  it('serializes MySQL DATETIME in server local time so enrollment codes stay valid', () => {
    const date = new Date(2026, 7, 13, 9, 10, 11, 123)
    expect(toMysqlDate(date)).toBe('2026-08-13 09:10:11.123')
  })
})

describe('心跳、能力与定向领取', () => {
  it('第一轮只保留异常查询和异常处理能力', () => {
    expect(ENABLED_EXECUTOR_COMMANDS).toEqual(['exception.order.check', 'exception.order.resolve'])
    expect(normalizeEnabledCapabilities({
      'exception.order.check': true,
      'exception.order.resolve': true,
      'warehouse.order.check': true,
      'warehouse.order.print': true,
      'warehouse.order.outbound': true
    })).toEqual({
      'exception.order.check': true,
      'exception.order.resolve': true,
      'warehouse.order.check': false,
      'warehouse.order.print': false,
      'warehouse.order.outbound': false
    })
  })

  it('心跳绑定 Bearer Token 的机器码并清洗失败原因', () => {
    const normalized = normalizeHeartbeatPayload({
      protocol_version: '1.0',
      machine_code: MACHINE_CODE,
      executor_instance_id: INSTANCE_ID,
      reported_at: NOW.toISOString(),
      status: 'online',
      executor_version: '1.0.0',
      capabilities: {
        'exception.order.check': true,
        'exception.order.resolve': true,
        'warehouse.order.check': true
      },
      readiness: {
        printer_available: false,
        login_environment_available: true
      },
      active_task_count: 0,
      last_failure_reason: 'Authorization=secret-value'
    }, { machineCode: MACHINE_CODE })

    expect(normalized.capabilities['warehouse.order.check']).toBe(false)
    expect(normalized.lastFailureReason).not.toContain('secret-value')
  })

  it('心跳持久化实例和机器状态并返回30秒间隔', async () => {
    const connection = {
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
      execute: vi.fn(async sql => {
        if (sql.includes('SELECT m.machine_code')) {
          return [[{ machine_code: MACHINE_CODE, bound_machine_code: MACHINE_CODE }]]
        }
        if (sql.includes('SELECT executor_instance_id')) {
          return [[{ executor_instance_id: INSTANCE_ID }]]
        }
        if (sql.includes('SELECT task_id, workflow_id')) return [[]]
        return [{ affectedRows: 1 }]
      })
    }
    const result = await recordHeartbeat(
      { getConnection: async () => connection },
      { machineCode: MACHINE_CODE },
      {
        protocol_version: '1.0',
        machine_code: MACHINE_CODE,
        executor_instance_id: INSTANCE_ID,
        reported_at: NOW.toISOString(),
        status: 'online',
        executor_version: '1.0.0',
        capabilities: {
          'exception.order.check': true,
          'exception.order.resolve': true
        },
        readiness: {
          printer_available: false,
          login_environment_available: true
        },
        active_task_count: 0,
        last_failure_reason: ''
      },
      NOW
    )
    expect(result).toEqual({
      accepted: true,
      server_time: NOW.toISOString(),
      heartbeat_interval_seconds: 30,
      offline_after_seconds: 90
    })
    expect(connection.commit).toHaveBeenCalledOnce()
  })

  it('领取只返回绑定机器码的一条异常查询任务和外层租约', async () => {
    const calls = []
    const taskRow = {
      task_id: 'task-001',
      workflow_id: 'wf-001',
      trace_id: 'wf-001',
      order_ref_id: 'ord-001',
      protocol_version: '1.0',
      command: 'exception.order.check',
      idempotency_key: 'idem-001',
      requested_by_json: JSON.stringify({ actor_id: '1', actor_type: 'user', display_name: '操作人' }),
      target_machine_code: MACHINE_CODE,
      confirmation_json: null,
      params_json: '{}',
      created_at: '2026-08-13T00:59:00.000Z',
      expires_at: '2026-08-13T01:05:00.000Z',
      lease_fencing_token: null
    }
    const connection = {
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
      execute: vi.fn(async (sql, params) => {
        calls.push({ sql, params })
        if (sql.includes('FROM cloud_executor_machines m')) {
          return [[{
            machine_status: 'online',
            active_executor_instance_id: INSTANCE_ID,
            capabilities_json: JSON.stringify({
              'exception.order.check': true,
              'exception.order.resolve': true,
              'warehouse.order.check': true
            }),
            printer_available: 0,
            login_environment_available: 1,
            machine_heartbeat_at: NOW.toISOString(),
            instance_machine_code: MACHINE_CODE,
            instance_status: 'online',
            instance_heartbeat_at: NOW.toISOString(),
            bound_machine_code: MACHINE_CODE
          }]]
        }
        if (sql.includes('SELECT t.*')) return [[taskRow]]
        if (sql.includes('SELECT task_id, workflow_id')) return [[]]
        return [{ affectedRows: 1 }]
      })
    }
    const result = await claimTask({ getConnection: async () => connection }, { machineCode: MACHINE_CODE }, {
      protocol_version: '1.0',
      machine_code: MACHINE_CODE,
      executor_instance_id: INSTANCE_ID,
      available_slots: 1,
      wait_seconds: 0
    }, NOW)

    expect(result.task).toMatchObject({
      task_id: 'task-001',
      command: 'exception.order.check',
      target: { machine_code: MACHINE_CODE },
      params: {}
    })
    expect(result.lease).toMatchObject({ fencing_token: 1, renew_after_seconds: 20 })
    expect(result.lease.lease_id).toMatch(/^lease_/)
    const claimSql = calls.find(call => call.sql.includes('SELECT t.*')).sql
    expect(claimSql).toContain('target_machine_code = ?')
    expect(claimSql).toContain('t.command IN')
  })
})

describe('租约身份、订单解析与完整结果', () => {
  it('异常处理租约过期后直接进入人工复核且不重新领取', async () => {
    const calls = []
    const connection = {
      execute: vi.fn(async (sql, params) => {
        calls.push({ sql, params })
        if (sql.includes('SELECT task_id, workflow_id')) {
          return [[{ task_id: 'task-write-001', workflow_id: 'wf-001' }]]
        }
        return [{ affectedRows: 1 }]
      })
    }
    await expect(markExpiredWriteTasksForReview(connection, MACHINE_CODE, NOW)).resolves.toBe(1)
    expect(calls.some(call => call.sql.includes("execution_result_unknown"))).toBe(true)
    expect(calls.some(call => call.sql.includes('DELETE FROM cloud_order_write_locks'))).toBe(true)
  })

  it('异常查询超过任务有效期后结束轮询并进入人工复核', async () => {
    const calls = []
    const connection = {
      execute: vi.fn(async (sql, params) => {
        calls.push({ sql, params })
        if (sql.includes("command = 'exception.order.check'") && sql.includes('SELECT task_id')) {
          return [[{ task_id: 'task-read-001', workflow_id: 'wf-read-001' }]]
        }
        return [{ affectedRows: 1 }]
      })
    }
    await expect(markExpiredReadTasksForReview(connection, NOW)).resolves.toBe(1)
    expect(calls.some(call => call.sql.includes("reason = 'task_expired'"))).toBe(true)
    expect(calls.some(call => call.sql.includes("event_type") && call.sql.includes("'read_task_expired'"))).toBe(true)
  })

  it('中央维护任务定期标记心跳超时并扫描过期写任务', async () => {
    const connection = {
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
      execute: vi.fn(async sql => {
        if (sql.includes('SELECT task_id, target_machine_code')) return [[]]
        if (sql.includes("command = 'exception.order.check'") && sql.includes('SELECT task_id')) return [[]]
        if (sql.includes('UPDATE cloud_executor_instances')) return [{ affectedRows: 2 }]
        if (sql.includes('UPDATE cloud_executor_machines')) return [{ affectedRows: 1 }]
        return [{ affectedRows: 0 }]
      })
    }
    await expect(runExecutorMaintenance({ getConnection: async () => connection }, NOW)).resolves.toEqual({
      reviewedTaskCount: 0,
      offlineInstanceCount: 2,
      offlineMachineCount: 1
    })
    expect(connection.commit).toHaveBeenCalledOnce()
  })

  it('订单解析请求必须携带 task 租约和不透明 order_id', () => {
    expect(normalizeMappingPayload({
      protocol_version: '1.0',
      machine_code: MACHINE_CODE,
      executor_instance_id: INSTANCE_ID,
      lease_id: 'lease-001',
      fencing_token: 3,
      order_id: 'ord-001'
    }, { machineCode: MACHINE_CODE })).toEqual({
      machineCode: MACHINE_CODE,
      executorInstanceId: INSTANCE_ID,
      leaseId: 'lease-001',
      fencingToken: 3,
      orderRefId: 'ord-001'
    })
  })

  it('异常查询回执只保留快照和脱敏异常字段', () => {
    const task = { task_id: 'task-001', command: 'exception.order.check', order_ref_id: 'ord-001' }
    const normalized = normalizeExecutorResponse({
      protocol_version: '1.0',
      task_id: 'task-001',
      command: 'exception.order.check',
      order_id: 'ord-001',
      status: 'succeeded',
      reason: 'business_state_confirmed',
      message: '',
      delivery: { received: true, executed: true, business_confirmed: true },
      result: {
        exception_snapshot_ref: 'exsnap-safe-reference',
        exception_count: 1,
        queried_at: NOW.toISOString(),
        exceptions: [{
          source: 'billexception',
          exception_type_masked: '地址异常',
          reason_masked: '收货信息***'
        }]
      },
      verification: { confirmed: true, observed_status: '' },
      executor: { device_id: '', executor_instance_id: INSTANCE_ID },
      completed_at: NOW.toISOString()
    }, task, INSTANCE_ID)

    expect(normalized.result.exception_count).toBe(1)
    expect(Object.keys(normalized.result.exceptions[0]).sort()).toEqual([
      'exception_type_masked', 'reason_masked', 'source'
    ].sort())
  })

  it('拒绝异常结果夹带内部 ID 或其他未知字段', () => {
    const task = { task_id: 'task-001', command: 'exception.order.check', order_ref_id: 'ord-001' }
    expect(() => normalizeExecutorResponse({
      protocol_version: '1.0',
      task_id: 'task-001',
      command: 'exception.order.check',
      order_id: 'ord-001',
      status: 'succeeded',
      reason: 'business_state_confirmed',
      message: '',
      delivery: { received: true, executed: true, business_confirmed: true },
      result: {
        exception_snapshot_ref: 'exsnap-safe-reference',
        exception_count: 1,
        queried_at: NOW.toISOString(),
        exceptions: [{
          source: 'billexception',
          exception_type_masked: '异常',
          reason_masked: '脱敏原因',
          internal_exception_id: 'forbidden'
        }]
      },
      verification: { confirmed: true, observed_status: '' },
      executor: { device_id: '', executor_instance_id: INSTANCE_ID },
      completed_at: NOW.toISOString()
    }, task, INSTANCE_ID)).toThrow('包含未知字段')
  })

  it('异常处理只有写后复验 waiting_arrival 才接受 succeeded', () => {
    const task = { task_id: 'task-002', command: 'exception.order.resolve', order_ref_id: 'ord-001' }
    const response = {
      protocol_version: '1.0',
      task_id: 'task-002',
      command: 'exception.order.resolve',
      order_id: 'ord-001',
      status: 'succeeded',
      reason: 'business_state_confirmed',
      message: '',
      delivery: { received: true, executed: true, business_confirmed: true },
      result: {},
      verification: { confirmed: true, observed_status: 'waiting_arrival' },
      executor: { device_id: '', executor_instance_id: INSTANCE_ID },
      completed_at: NOW.toISOString()
    }
    expect(normalizeExecutorResponse(response, task, INSTANCE_ID).status).toBe('succeeded')
    expect(() => normalizeExecutorResponse({
      ...response,
      verification: { confirmed: true, observed_status: 'shipped' }
    }, task, INSTANCE_ID)).toThrow('写后状态必须为 waiting_arrival')
  })

  it('敏感值不会写入消息字段', () => {
    expect(redactMessage('Cookie=session-secret Authorization=Bearer-secret password=abc')).not.toContain('session-secret')
    expect(redactMessage('Cookie=session-secret Authorization=Bearer-secret password=abc')).not.toContain('Bearer-secret')
  })

  it('executing 状态和续租都校验机器、实例、lease 与 fencing token', async () => {
    const taskRow = {
      task_id: 'task-001',
      workflow_id: 'wf-001',
      order_ref_id: 'ord-001',
      command: 'exception.order.check',
      target_machine_code: MACHINE_CODE,
      bound_machine_code: MACHINE_CODE,
      instance_machine_code: MACHINE_CODE,
      claimed_executor_instance_id: INSTANCE_ID,
      lease_id: 'lease-001',
      lease_fencing_token: 2,
      transport_status: 'leased',
      expires_at: '2026-08-13T01:10:00.000Z',
      lease_expires_at: '2026-08-13T01:01:00.000Z',
      machine_status: 'online',
      instance_status: 'online',
      active_executor_instance_id: INSTANCE_ID,
      instance_heartbeat_at: NOW.toISOString()
    }
    const makePool = () => {
      const connection = {
        beginTransaction: vi.fn(async () => {}),
        commit: vi.fn(async () => {}),
        rollback: vi.fn(async () => {}),
        release: vi.fn(),
        execute: vi.fn(async sql => {
          if (sql.includes('SELECT t.*')) return [[taskRow]]
          return [{ affectedRows: 1 }]
        })
      }
      return { pool: { getConnection: async () => connection }, connection }
    }
    const statusFixture = makePool()
    await expect(reportExecuting(statusFixture.pool, { machineCode: MACHINE_CODE }, 'task-001', {
      protocol_version: '1.0',
      machine_code: MACHINE_CODE,
      executor_instance_id: INSTANCE_ID,
      lease_id: 'lease-001',
      fencing_token: 2,
      status: 'executing',
      reported_at: NOW.toISOString()
    }, NOW)).resolves.toMatchObject({ accepted: true, status: 'executing' })

    const renewFixture = makePool()
    await expect(renewLease(renewFixture.pool, { machineCode: MACHINE_CODE }, 'task-001', {
      protocol_version: '1.0',
      machine_code: MACHINE_CODE,
      executor_instance_id: INSTANCE_ID,
      lease_id: 'lease-001',
      fencing_token: 2,
      requested_extension_seconds: 60
    }, NOW)).resolves.toMatchObject({
      lease_id: 'lease-001',
      fencing_token: 2,
      renew_after_seconds: 20
    })
  })

  it('完整结果落库并返回可安全重放的确认回执', async () => {
    const calls = []
    const taskRow = {
      task_id: 'task-001',
      workflow_id: 'wf-001',
      order_ref_id: 'ord-001',
      command: 'exception.order.check',
      created_at: '2026-08-13T00:59:00.000Z',
      target_machine_code: MACHINE_CODE,
      bound_machine_code: MACHINE_CODE,
      instance_machine_code: MACHINE_CODE,
      claimed_executor_instance_id: INSTANCE_ID,
      lease_id: 'lease-001',
      lease_fencing_token: 2,
      transport_status: 'executing',
      expires_at: '2026-08-13T01:10:00.000Z',
      lease_expires_at: '2026-08-13T01:01:00.000Z',
      machine_status: 'online',
      instance_status: 'online',
      active_executor_instance_id: INSTANCE_ID,
      instance_heartbeat_at: NOW.toISOString(),
      response_hash: null
    }
    const connection = {
      beginTransaction: vi.fn(async () => {}),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      release: vi.fn(),
      execute: vi.fn(async (sql, params) => {
        calls.push({ sql, params })
        if (sql.includes('SELECT t.*')) return [[taskRow]]
        return [{ affectedRows: 1 }]
      })
    }
    const response = {
      protocol_version: '1.0',
      task_id: 'task-001',
      command: 'exception.order.check',
      order_id: 'ord-001',
      status: 'succeeded',
      reason: 'business_state_confirmed',
      message: '',
      delivery: { received: true, executed: true, business_confirmed: true },
      result: {
        exception_snapshot_ref: '',
        exception_count: 0,
        queried_at: NOW.toISOString(),
        exceptions: []
      },
      verification: { confirmed: true, observed_status: '' },
      executor: { device_id: '', executor_instance_id: INSTANCE_ID },
      completed_at: NOW.toISOString()
    }
    const ack = await recordTaskResult(
      { getConnection: async () => connection },
      { machineCode: MACHINE_CODE },
      'task-001',
      { lease_id: 'lease-001', fencing_token: 2, response },
      NOW
    )
    expect(ack).toEqual({
      accepted: true,
      task_id: 'task-001',
      recorded_at: NOW.toISOString(),
      replayed: false
    })
    const resultUpdate = calls.find(call => call.sql.includes('response_redacted_json'))
    expect(resultUpdate).toBeTruthy()
    expect(JSON.stringify(resultUpdate.params)).toContain('business_state_confirmed')
  })
})

describe('执行器 HTTPS 门槛', () => {
  it('生产环境远程 HTTP 请求返回 426', () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const json = vi.fn()
    const res = { status: vi.fn(() => ({ json })) }
    const next = vi.fn()
    executorRoute.requireHttps({
      secure: false,
      headers: {},
      ip: '10.0.0.8',
      socket: { remoteAddress: '10.0.0.8' }
    }, res, next)
    expect(res.status).toHaveBeenCalledWith(426)
    expect(next).not.toHaveBeenCalled()
    process.env.NODE_ENV = previous
  })
})
