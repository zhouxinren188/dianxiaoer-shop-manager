import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  ENABLED_DESKTOP_COMMANDS,
  PROTOCOL_VERSION,
  normalizeCapabilities,
  normalizeCreateTaskRequest,
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
  requireHttps
} = require('../server-api/desktop-command-proxy')

const DEVICE_ID = 'device_12345678'
const INSTANCE_ID = 'instance_12345678'

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
  it('starts with only the diagnostic ping command enabled', () => {
    expect(ENABLED_DESKTOP_COMMANDS).toEqual(['system.ping'])
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
  })

  it('normalizes capabilities and rejects unknown heartbeat fields', () => {
    expect(normalizeCapabilities({ 'system.ping': true, 'future.command': true })).toEqual({
      'system.ping': true
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

  it('redacts credentials before an error can be persisted', () => {
    const redacted = redactMessage('Authorization=secret Bearer abc.def Cookie=session Password=hunter2')
    expect(redacted).not.toContain('secret')
    expect(redacted).not.toContain('abc.def')
    expect(redacted).not.toContain('session')
    expect(redacted).not.toContain('hunter2')
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

  it('returns the idempotent task row selected after INSERT IGNORE', async () => {
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
  })

  it('cannot be configured as an arbitrary upstream proxy', () => {
    expect(() => createProxyHandler({ upstreamHost: 'example.com', upstreamPort: 443 }))
      .toThrowError(/fixed to loopback/i)
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
