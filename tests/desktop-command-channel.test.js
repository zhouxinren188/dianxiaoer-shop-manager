import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  ENABLED_DESKTOP_COMMANDS,
  PROTOCOL_VERSION,
  normalizeCapabilities,
  normalizeCreateTaskRequest,
  normalizeExceptionCheckResult,
  normalizeJdRemarkResult,
  normalizeHeartbeatRequest,
  normalizeResultRequest,
  redactMessage
} = require('../server/services/desktop-command-protocol')
const {
  claimTask,
  createTask,
  recordHeartbeat,
  recordTaskResult
} = require('../server/services/desktop-command-channel-service')
const {
  requireDesktopDevice
} = require('../server/routes/desktop-command-channel')
const {
  createProxyHandler,
  isAllowedRequest,
  requireHttps,
  resolveUpstreamPath
} = require('../server-api/desktop-command-proxy')

const DEVICE_ID = 'device_12345678'
const INSTANCE_ID = 'instance_12345678'
const dbSource = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8')

function heartbeatBody(overrides = {}) {
  return {
    protocol_version: PROTOCOL_VERSION,
    device_id: DEVICE_ID,
    instance_id: INSTANCE_ID,
    app_version: '1.9.73',
    reported_at: '2026-08-31T01:00:00.000Z',
    capabilities: { 'system.ping': true },
    active_task_count: 0,
    ...overrides
  }
}

describe('desktop command protocol', () => {
  it('enables only the diagnostic, JD remark and two legacy purchase exception commands', () => {
    expect(ENABLED_DESKTOP_COMMANDS).toEqual([
      'system.ping',
      'purchase.jd.remark',
      'purchase.exception.check',
      'purchase.exception.resolve'
    ])
    expect(normalizeCreateTaskRequest({ command: 'system.ping', payload: {} })).toMatchObject({
      command: 'system.ping',
      payload: {},
      expiresInSeconds: 120
    })
  })

  it('rejects business commands and arbitrary payload fields', () => {
    expect(() => normalizeCreateTaskRequest({
      command: 'order.exception.resolve',
      payload: { order_id: '1' }
    })).toThrowError(/not enabled/i)
    expect(() => normalizeCreateTaskRequest({
      command: 'system.ping',
      payload: { shell: 'whoami' }
    })).toThrowError(/unknown field/i)
    expect(() => normalizeCreateTaskRequest({
      command: 'purchase.exception.resolve',
      payload: { purchase_order_id: 12, confirmed: false }
    })).toThrowError(/confirmed/i)
  })

  it('normalizes capabilities and rejects unknown heartbeat fields', () => {
    expect(normalizeCapabilities({ 'system.ping': true, 'future.command': true })).toEqual({
      'system.ping': true,
      'purchase.jd.remark': false,
      'purchase.exception.check': false,
      'purchase.exception.resolve': false
    })
    expect(() => normalizeHeartbeatRequest(heartbeatBody({ token: 'must-not-be-here' })))
      .toThrowError(/unknown field/i)
  })

  it('binds terminal results to the claiming device', () => {
    const base = {
      device_id: DEVICE_ID,
      instance_id: INSTANCE_ID,
      lease_id: 'lease_12345678',
      fencing_token: 1,
      status: 'succeeded',
      result: {
        pong: true,
        device_id: 'device_87654321',
        app_version: '1.9.73',
        handled_at: '2026-08-31T01:00:01.000Z'
      },
      completed_at: '2026-08-31T01:00:01.000Z'
    }
    expect(() => normalizeResultRequest(base, 'system.ping')).toThrowError(/claiming device/i)
  })

  it('reads the UUID idempotency key from the snake_case request-body field unchanged', () => {
    const idempotencyKey = '4355ef4c-4ffe-4c10-957c-354cf14ec6c2'
    expect(normalizeCreateTaskRequest({
      command: 'purchase.exception.resolve',
      payload: { purchase_order_id: 8110, confirmed: true },
      idempotency_key: idempotencyKey
    })).toMatchObject({
      command: 'purchase.exception.resolve',
      payload: { purchase_order_id: 8110, confirmed: true },
      idempotencyKey
    })
  })

  it('stores idempotency keys without case folding or prefix truncation', () => {
    expect(dbSource).toContain('idempotency_key VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL')
    expect(dbSource).toContain('UNIQUE KEY uk_desktop_command_idempotency (user_id, idempotency_key)')
  })

  it('binds a business result to the purchase order in the original task payload', () => {
    const body = {
      device_id: DEVICE_ID,
      instance_id: INSTANCE_ID,
      lease_id: 'lease_12345678',
      fencing_token: 1,
      status: 'succeeded',
      result: {
        purchase_order_id: 13,
        state: 'exception_clear',
        exception_count: 0,
        message: '暂无异常',
        checked_at: '2026-08-31T01:00:01.000Z'
      },
      completed_at: '2026-08-31T01:00:01.000Z'
    }
    expect(() => normalizeResultRequest(
      body,
      'purchase.exception.check',
      { purchase_order_id: 12 }
    )).toThrowError(/does not match/i)
  })

  it('redacts credentials before an error can be persisted', () => {
    const redacted = redactMessage('Authorization=secret Bearer abc.def Cookie=session Password=hunter2')
    expect(redacted).not.toContain('secret')
    expect(redacted).not.toContain('abc.def')
    expect(redacted).not.toContain('session')
    expect(redacted).not.toContain('hunter2')
  })

  it('validates the compact exception query result shape', () => {
    expect(normalizeExceptionCheckResult({
      purchase_order_id: 12,
      state: 'exception_found',
      exception_count: 2,
      message: '发现异常',
      checked_at: '2026-08-31T01:00:01.000Z'
    })).toMatchObject({
      purchase_order_id: 12,
      state: 'exception_found',
      exception_count: 2
    })
    expect(() => normalizeExceptionCheckResult({
      purchase_order_id: 12,
      state: 'exception_clear',
      exception_count: 1,
      message: '',
      checked_at: '2026-08-31T01:00:01.000Z'
    })).toThrowError(/does not match/i)
  })

  it('validates the compact JD remark result shape', () => {
    expect(normalizeJdRemarkResult({
      purchase_order_id: 12,
      remark_succeeded: true,
      remark_message: '采购编号已备注',
      remarked_at: '2026-09-09T01:00:01.000Z'
    })).toMatchObject({
      purchase_order_id: 12,
      remark_succeeded: true
    })
  })
})

describe('desktop command channel service', () => {
  it('uses server time for heartbeat persistence', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }])
    const now = new Date('2026-08-31T02:00:00.000Z')
    const result = await recordHeartbeat({ execute }, { userId: 7 }, heartbeatBody(), now)
    expect(result.accepted).toBe(true)
    expect(result.server_time).toBe(now.toISOString())
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][1][0]).toBe(7)
    expect(execute.mock.calls[0][1][1]).toBe(DEVICE_ID)
    expect(execute.mock.calls[0][1][3]).toBe(PROTOCOL_VERSION)
  })

  it('returns the idempotent task row selected after an upsert', async () => {
    const row = {
      task_id: 'desktop_task_12345678',
      command: 'system.ping',
      status: 'queued',
      target_device_id: '',
      claimed_device_id: '',
      attempt_count: 0,
      created_at: '2026-08-31 02:00:00.000',
      expires_at: '2026-08-31 02:02:00.000',
      updated_at: '2026-08-31 02:00:00.000'
    }
    const execute = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[row]])
    const task = await createTask({ execute }, { userId: 7 }, {
      command: 'system.ping',
      payload: {},
      idempotency_key: 'ping:device:12345678'
    }, new Date('2026-08-31T02:00:00.000Z'))
    expect(task.task_id).toBe(row.task_id)
    expect(task.status).toBe('queued')
    expect(execute.mock.calls[1][1]).toEqual([7, 'ping:device:12345678'])
  })

  it('accepts a newly created task when MySQL reorders JSON object keys', async () => {
    const idempotencyKey = '4355ef4c-4ffe-4c10-957c-354cf14ec6c2'
    const row = {
      task_id: 'desktop_task_12345678',
      command: 'purchase.exception.resolve',
      payload_json: { confirmed: true, purchase_order_id: 8110 },
      status: 'queued',
      target_device_id: '',
      claimed_device_id: '',
      attempt_count: 0,
      created_at: '2026-09-08 19:07:14.000',
      expires_at: '2026-09-08 19:17:14.000',
      updated_at: '2026-09-08 19:07:14.000'
    }
    const execute = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[row]])

    const task = await createTask({ execute }, { userId: 29 }, {
      command: 'purchase.exception.resolve',
      payload: { purchase_order_id: 8110, confirmed: true },
      idempotency_key: idempotencyKey
    }, new Date('2026-09-08T11:07:14.000Z'))

    expect(task.task_id).toBe(row.task_id)
    expect(execute.mock.calls[0][1][5]).toBe(idempotencyKey)
    expect(execute.mock.calls[1][1]).toEqual([29, idempotencyKey])
  })

  it('returns the original task for the same key and structurally identical request', async () => {
    const row = {
      task_id: 'desktop_task_original',
      command: 'purchase.exception.resolve',
      payload_json: JSON.stringify({ confirmed: true, purchase_order_id: 8110 }),
      status: 'succeeded',
      target_device_id: '',
      claimed_device_id: DEVICE_ID,
      attempt_count: 1,
      created_at: '2026-09-08 19:07:14.000',
      expires_at: '2026-09-08 19:17:14.000',
      updated_at: '2026-09-08 19:07:20.000'
    }
    const execute = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[row]])

    const task = await createTask({ execute }, { userId: 29 }, {
      command: 'purchase.exception.resolve',
      payload: { purchase_order_id: 8110, confirmed: true },
      idempotency_key: 'same-request-8110'
    })

    expect(task.task_id).toBe('desktop_task_original')
    expect(task.status).toBe('succeeded')
  })

  it('rejects the same key only when the canonical request fingerprint differs', async () => {
    const row = {
      task_id: 'desktop_task_original',
      command: 'purchase.exception.resolve',
      payload_json: { confirmed: true, purchase_order_id: 8111 },
      status: 'queued',
      target_device_id: '',
      claimed_device_id: '',
      attempt_count: 0,
      created_at: '2026-09-08 19:07:14.000',
      expires_at: '2026-09-08 19:17:14.000',
      updated_at: '2026-09-08 19:07:14.000'
    }
    const execute = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[row]])

    await expect(createTask({ execute }, { userId: 29 }, {
      command: 'purchase.exception.resolve',
      payload: { purchase_order_id: 8110, confirmed: true },
      idempotency_key: 'different-request-8110'
    })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('rejects reuse of an idempotency key for a different target device', async () => {
    const row = {
      task_id: 'desktop_task_12345678',
      command: 'system.ping',
      payload_json: '{}',
      status: 'queued',
      target_device_id: 'device_11111111',
      claimed_device_id: '',
      attempt_count: 0,
      created_at: '2026-08-31 02:00:00.000',
      expires_at: '2026-08-31 02:02:00.000',
      updated_at: '2026-08-31 02:00:00.000'
    }
    const execute = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[row]])
    await expect(createTask({ execute }, { userId: 7 }, {
      command: 'system.ping',
      payload: {},
      idempotency_key: 'ping:device:12345678',
      target_device_id: 'device_22222222'
    }, new Date('2026-08-31T02:00:00.000Z'))).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
  })

  it('requires a live heartbeat before leasing a task', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[]])
    const connection = {
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
      execute
    }
    await expect(claimTask({ getConnection: async () => connection }, { userId: 7 }, {
      protocol_version: PROTOCOL_VERSION,
      device_id: DEVICE_ID,
      instance_id: INSTANCE_ID,
      available_slots: 1
    }, new Date('2026-08-31T02:00:00.000Z'))).rejects.toMatchObject({ code: 'device_not_ready' })
    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(connection.release).toHaveBeenCalledOnce()
  })

  it('leases one allow-listed task with a fencing token', async () => {
    const taskRow = {
      task_id: 'desktop_task_12345678',
      command: 'system.ping',
      payload_json: '{}',
      status: 'queued',
      attempt_count: 0,
      fencing_token: 4,
      created_at: '2026-08-31 02:00:00.000',
      expires_at: '2026-08-31 02:02:00.000'
    }
    const execute = vi.fn()
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[{ capabilities_json: JSON.stringify({ 'system.ping': true }) }]])
      .mockResolvedValueOnce([[taskRow]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
    const connection = {
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
      execute
    }
    const claim = await claimTask({ getConnection: async () => connection }, { userId: 7 }, {
      protocol_version: PROTOCOL_VERSION,
      device_id: DEVICE_ID,
      instance_id: INSTANCE_ID,
      available_slots: 1
    }, new Date('2026-08-31T02:00:00.000Z'))
    expect(claim.task.command).toBe('system.ping')
    expect(claim.task.attempt).toBe(1)
    expect(claim.lease.fencing_token).toBe(5)
    expect(claim.lease.lease_id).toMatch(/^lease_/)
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(connection.release).toHaveBeenCalledOnce()
  })

  it('rejects terminal result replay from a different device lease', async () => {
    const task = {
      task_id: 'desktop_task_12345678',
      command: 'system.ping',
      status: 'succeeded',
      claimed_device_id: DEVICE_ID,
      claimed_instance_id: INSTANCE_ID,
      lease_id: 'lease_12345678',
      fencing_token: 4,
      result_hash: 'already-recorded'
    }
    const execute = vi.fn().mockResolvedValueOnce([[task]])
    const connection = {
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
      execute
    }
    await expect(recordTaskResult(
      { getConnection: async () => connection },
      { userId: 7 },
      task.task_id,
      {
        device_id: 'device_87654321',
        instance_id: 'instance_87654321',
        lease_id: 'lease_87654321',
        fencing_token: 5,
        status: 'succeeded',
        result: {
          pong: true,
          device_id: 'device_87654321',
          app_version: '1.9.73',
          handled_at: '2026-08-31T02:00:01.000Z'
        },
        completed_at: '2026-08-31T02:00:01.000Z'
      },
      new Date('2026-08-31T02:00:02.000Z')
    )).rejects.toMatchObject({ code: 'lease_invalid' })
    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(connection.release).toHaveBeenCalledOnce()
  })
})

describe('desktop command HTTPS boundary', () => {
  it('allows only fixed channel paths and methods', () => {
    expect(isAllowedRequest('POST', '/api/desktop-channel/heartbeat')).toBe(true)
    expect(isAllowedRequest('GET', '/api/desktop-channel/tasks/desktop_task_12345678')).toBe(true)
    expect(isAllowedRequest('POST', '/api/desktop-channel/admin/execute')).toBe(false)
    expect(isAllowedRequest('DELETE', '/api/desktop-channel/tasks/desktop_task_12345678')).toBe(false)
    expect(isAllowedRequest(
      'POST',
      '/api/desktop-channel/business/purchase-orders/12/exception/resolve'
    )).toBe(true)
    expect(isAllowedRequest(
      'POST',
      '/api/desktop-channel/business/purchase-orders/12/delete'
    )).toBe(false)
    expect(resolveUpstreamPath(
      'POST',
      '/api/desktop-channel/business/purchase-orders/12/exception/resolve'
    )).toBe('/api/cloud-warehouse/orders/12/exception/resolve')
    expect(resolveUpstreamPath(
      'GET',
      '/api/desktop-channel/business/purchase-orders/12/related-sales'
    )).toBe('/api/purchase-orders/12/related-sales')
  })

  it('persists terminal completion time from the server clock', async () => {
    const task = {
      task_id: 'desktop_task_12345678',
      command: 'system.ping',
      payload_json: '{}',
      status: 'executing',
      claimed_device_id: DEVICE_ID,
      claimed_instance_id: INSTANCE_ID,
      lease_id: 'lease_12345678',
      lease_expires_at: '2026-09-09T01:05:00.000Z',
      fencing_token: 1
    }
    const execute = vi.fn()
      .mockResolvedValueOnce([[task]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
    const connection = {
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
      execute
    }
    await recordTaskResult(
      { getConnection: async () => connection },
      { userId: 7 },
      task.task_id,
      {
        device_id: DEVICE_ID,
        instance_id: INSTANCE_ID,
        lease_id: task.lease_id,
        fencing_token: 1,
        status: 'succeeded',
        result: {
          pong: true,
          device_id: DEVICE_ID,
          app_version: '1.9.82',
          handled_at: '2026-09-09T01:00:04.000Z'
        },
        completed_at: '2026-09-09T01:00:04.000Z'
      },
      new Date('2026-09-09T01:00:01.000Z')
    )
    expect(execute.mock.calls[1][1][5]).toBe('2026-09-09 09:00:01.000')
    expect(execute.mock.calls[1][1][6]).toBe('2026-09-09 09:00:01.000')
  })

  it('cannot be configured as an arbitrary upstream proxy', () => {
    expect(() => createProxyHandler({ upstreamHost: 'example.com', upstreamPort: 443 }))
      .toThrowError(/fixed to loopback/i)
  })

  it('rejects mini-program access to desktop-only business support routes', () => {
    const status = vi.fn().mockReturnThis()
    const json = vi.fn().mockReturnThis()
    createProxyHandler()({
      method: 'GET',
      originalUrl: '/api/desktop-channel/business/purchase-orders/12',
      authDevice: 'miniprogram'
    }, { status, json })
    expect(status).toHaveBeenCalledWith(403)
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      error_code: 'desktop_device_required'
    }))
  })

  it('rejects plaintext requests before authentication or proxying', () => {
    const status = vi.fn().mockReturnThis()
    const json = vi.fn().mockReturnThis()
    const next = vi.fn()
    requireHttps({ secure: false, socket: {} }, { status, json }, next)
    expect(status).toHaveBeenCalledWith(426)
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error_code: 'https_required' }))
    expect(next).not.toHaveBeenCalled()
  })

  it('allows only desktop logins to execute claimed tasks', () => {
    const status = vi.fn().mockReturnThis()
    const json = vi.fn().mockReturnThis()
    const next = vi.fn()
    requireDesktopDevice({ authDevice: 'miniprogram' }, { status, json }, next)
    expect(status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()

    requireDesktopDevice({ authDevice: 'desktop' }, { status, json }, next)
    expect(next).toHaveBeenCalledOnce()
  })
})
