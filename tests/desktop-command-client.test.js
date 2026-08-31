import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  DesktopCommandChannelClient
} = require('../src/main/desktop-command-channel')

const DEVICE_ID = 'device_1234567890123456'
const INSTANCE_ID = 'instance_12345678'
const TASK_ID = 'desktop_task_12345678'

function makeJournal() {
  const entries = new Map()
  const started = new Set()
  return {
    get: vi.fn(task => entries.get(task.task_id) || null),
    wasStarted: vi.fn(task => started.has(task.task_id)),
    markStarted: vi.fn(task => started.add(task.task_id)),
    record: vi.fn((task, outcome) => entries.set(task.task_id, outcome)),
    acknowledge: vi.fn()
  }
}

function makeClaim(leaseId = 'lease_12345678', fencingToken = 1, command = 'system.ping') {
  return {
    task: {
      protocol_version: '1.0',
      task_id: TASK_ID,
      command,
      payload: {},
      created_at: '2026-08-31T01:00:00.000Z',
      expires_at: '2026-08-31T01:02:00.000Z',
      attempt: fencingToken
    },
    lease: {
      lease_id: leaseId,
      fencing_token: fencingToken,
      expires_at: '2026-08-31T01:01:00.000Z',
      renew_after_seconds: 20
    }
  }
}

function makeClient(overrides = {}) {
  const journal = overrides.journal || makeJournal()
  const pingHandler = overrides.pingHandler || vi.fn(async () => ({
    pong: true,
    device_id: DEVICE_ID,
    app_version: '1.9.73',
    handled_at: '2026-08-31T01:00:01.000Z'
  }))
  const client = new DesktopCommandChannelClient({
    requestJson: overrides.requestJson || vi.fn(),
    getToken: overrides.getToken || (() => 'desktop-token'),
    deviceId: DEVICE_ID,
    instanceId: INSTANCE_ID,
    appVersion: '1.9.73',
    handlers: overrides.handlers || { 'system.ping': pingHandler },
    journal,
    now: overrides.now || (() => Date.parse('2026-08-31T01:00:00.000Z')),
    setIntervalFn: overrides.setIntervalFn || (() => ({ unref() {} })),
    clearIntervalFn: overrides.clearIntervalFn || (() => {})
  })
  return { client, journal, pingHandler }
}

describe('desktop command channel client', () => {
  it('does not contact the channel before the desktop user logs in', async () => {
    const requestJson = vi.fn()
    const { client } = makeClient({ requestJson, getToken: () => '' })
    await expect(client.runOnce()).resolves.toEqual({ state: 'unauthenticated' })
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('completes heartbeat, claim, status and diagnostic ping result reporting', async () => {
    const requests = []
    const requestJson = vi.fn(async request => {
      requests.push(request)
      if (request.endpoint === '/heartbeat') {
        return { accepted: true, heartbeat_interval_seconds: 20 }
      }
      if (request.endpoint === '/tasks/claim') return makeClaim()
      if (request.endpoint.endsWith('/status')) return { accepted: true }
      if (request.endpoint.endsWith('/result')) return { accepted: true, replayed: false }
      throw new Error('unexpected request')
    })
    const { client, journal, pingHandler } = makeClient({ requestJson })

    await expect(client.runOnce()).resolves.toEqual({ state: 'handled', taskId: TASK_ID })
    expect(requests.map(request => request.endpoint)).toEqual([
      '/heartbeat',
      '/tasks/claim',
      '/tasks/' + TASK_ID + '/status',
      '/tasks/' + TASK_ID + '/result'
    ])
    expect(requests[0].body.capabilities).toEqual({ 'system.ping': true })
    expect(requests[0].body.active_task_count).toBe(0)
    expect(requests[2].body.progress).toEqual({ phase: 'executing' })
    expect(requests[3].body).toMatchObject({
      device_id: DEVICE_ID,
      instance_id: INSTANCE_ID,
      lease_id: 'lease_12345678',
      fencing_token: 1,
      status: 'succeeded',
      result: { pong: true, device_id: DEVICE_ID }
    })
    expect(requests[3].body).not.toHaveProperty('progress')
    expect(pingHandler).toHaveBeenCalledOnce()
    expect(journal.markStarted).toHaveBeenCalledOnce()
    expect(journal.record).toHaveBeenCalledOnce()
    expect(journal.acknowledge).toHaveBeenCalledWith(TASK_ID)
  })

  it('reuses a journaled terminal outcome after a lost result response', async () => {
    let claimCount = 0
    let resultCount = 0
    const resultBodies = []
    const requestJson = vi.fn(async request => {
      if (request.endpoint === '/heartbeat') {
        return { accepted: true, heartbeat_interval_seconds: 20 }
      }
      if (request.endpoint === '/tasks/claim') {
        claimCount += 1
        return claimCount === 1
          ? makeClaim('lease_11111111', 1)
          : makeClaim('lease_22222222', 2)
      }
      if (request.endpoint.endsWith('/status')) return { accepted: true }
      if (request.endpoint.endsWith('/result')) {
        resultBodies.push(request.body)
        resultCount += 1
        if (resultCount === 1) {
          throw Object.assign(new Error('network disconnected'), { code: 'connection_lost' })
        }
        return { accepted: true, replayed: false }
      }
      throw new Error('unexpected request')
    })
    const { client, journal, pingHandler } = makeClient({ requestJson })

    await expect(client.runOnce()).rejects.toMatchObject({ code: 'connection_lost' })
    expect(journal.record).toHaveBeenCalledOnce()
    expect(pingHandler).toHaveBeenCalledOnce()

    await expect(client.runOnce()).resolves.toEqual({ state: 'handled', taskId: TASK_ID })
    expect(pingHandler).toHaveBeenCalledOnce()
    expect(journal.record).toHaveBeenCalledOnce()
    expect(resultBodies).toHaveLength(2)
    expect(resultBodies[0].result).toEqual(resultBodies[1].result)
    expect(resultBodies[1]).toMatchObject({
      lease_id: 'lease_22222222',
      fencing_token: 2,
      status: 'succeeded'
    })
  })

  it('never executes an unregistered command and reports a safe failure', async () => {
    let terminalBody
    const requestJson = vi.fn(async request => {
      if (request.endpoint === '/heartbeat') {
        return { accepted: true, heartbeat_interval_seconds: 20 }
      }
      if (request.endpoint === '/tasks/claim') {
        return makeClaim('lease_33333333', 3, 'system.not-allowed')
      }
      if (request.endpoint.endsWith('/status')) return { accepted: true }
      if (request.endpoint.endsWith('/result')) {
        terminalBody = request.body
        return { accepted: true }
      }
      throw new Error('unexpected request')
    })
    const pingHandler = vi.fn()
    const { client } = makeClient({ requestJson, pingHandler })

    await client.runOnce()
    expect(pingHandler).not.toHaveBeenCalled()
    expect(terminalBody).toMatchObject({
      status: 'failed',
      result: {},
      error_code: 'command_not_supported'
    })
  })

  it('blocks automatic replay when a prior execution ended before recording a result', async () => {
    let terminalBody
    const journal = makeJournal()
    journal.wasStarted.mockReturnValue(true)
    const requestJson = vi.fn(async request => {
      if (request.endpoint === '/heartbeat') {
        return { accepted: true, heartbeat_interval_seconds: 20 }
      }
      if (request.endpoint === '/tasks/claim') return makeClaim('lease_44444444', 4)
      if (request.endpoint.endsWith('/status')) return { accepted: true }
      if (request.endpoint.endsWith('/result')) {
        terminalBody = request.body
        return { accepted: true }
      }
      throw new Error('unexpected request')
    })
    const pingHandler = vi.fn()
    const { client } = makeClient({ requestJson, pingHandler, journal })

    await client.runOnce()
    expect(pingHandler).not.toHaveBeenCalled()
    expect(terminalBody).toMatchObject({
      status: 'failed',
      error_code: 'execution_interrupted'
    })
  })
})
