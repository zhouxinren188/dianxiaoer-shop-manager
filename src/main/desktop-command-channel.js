const crypto = require('crypto')
const fs = require('fs')
const https = require('https')
const path = require('path')

const PROTOCOL_VERSION = '1.0'
const DEFAULT_CHANNEL_BASE_URL = 'https://150.158.54.108/api/desktop-channel'
const MAX_REQUEST_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 256 * 1024
const JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const JOURNAL_MAX_ENTRIES = 200

function createChannelError(code, message, extras = {}) {
  return Object.assign(new Error(message), { code, ...extras })
}

function redactMessage(value, maxLength = 500) {
  return String(value || '')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(authorization|cookie|token|password|api[_ -]?key)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, maxLength)
}

function normalizeErrorCode(value, fallback = 'desktop_handler_failed') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80)
  return /^[a-z][a-z0-9_]{0,79}$/.test(normalized) ? normalized : fallback
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createChannelError('invalid_channel_data', field + ' must be an object')
  }
  return value
}

function taskFingerprint(task) {
  return crypto
    .createHash('sha256')
    .update(String(task?.command || '') + '\n' + JSON.stringify(task?.payload || {}), 'utf8')
    .digest('hex')
}

function makeInstanceId() {
  const randomPart = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex')
  return 'instance_' + randomPart
}

function createHttpsJsonClient({
  baseUrl = DEFAULT_CHANNEL_BASE_URL,
  timeoutMs = 12000,
  httpsModule = https,
  selfSignedHosts = ['150.158.54.108']
} = {}) {
  const base = new URL(baseUrl)
  if (base.protocol !== 'https:') throw new Error('Desktop command channel must use HTTPS')
  const basePath = base.pathname.replace(/\/$/, '')
  const allowedSelfSignedHosts = new Set(selfSignedHosts)

  return function requestJson({ method = 'GET', endpoint, token, body }) {
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(String(endpoint || ''))) {
      return Promise.reject(createChannelError('invalid_endpoint', 'Desktop command endpoint is invalid'))
    }
    if (!token) return Promise.reject(createChannelError('auth_unavailable', 'Desktop login token is unavailable'))

    const requestUrl = new URL(base.origin + basePath + endpoint)
    if (requestUrl.origin !== base.origin || !requestUrl.pathname.startsWith(basePath + '/')) {
      return Promise.reject(createChannelError('invalid_endpoint', 'Desktop command endpoint escaped its fixed origin'))
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    if (payload && payload.length > MAX_REQUEST_BYTES) {
      return Promise.reject(createChannelError('request_too_large', 'Desktop command request is too large'))
    }

    return new Promise((resolve, reject) => {
      const req = httpsModule.request({
        protocol: requestUrl.protocol,
        hostname: requestUrl.hostname,
        port: requestUrl.port || 443,
        path: requestUrl.pathname + requestUrl.search,
        method,
        timeout: timeoutMs,
        rejectUnauthorized: !allowedSelfSignedHosts.has(requestUrl.hostname),
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + token,
          ...(payload ? {
            'Content-Type': 'application/json',
            'Content-Length': String(payload.length)
          } : {})
        }
      }, response => {
        const chunks = []
        let responseBytes = 0
        response.on('data', chunk => {
          responseBytes += chunk.length
          if (responseBytes > MAX_RESPONSE_BYTES) {
            req.destroy(createChannelError('response_too_large', 'Desktop command response is too large'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          let json
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          } catch {
            reject(createChannelError('invalid_response', 'Desktop command server returned invalid JSON', {
              statusCode: Number(response.statusCode || 0)
            }))
            return
          }
          const statusCode = Number(response.statusCode || 0)
          if (statusCode < 200 || statusCode >= 300 || json.code !== 0) {
            reject(createChannelError(
              normalizeErrorCode(json.error_code, 'http_' + (statusCode || 500)),
              redactMessage(json.message || 'Desktop command request failed with HTTP ' + (statusCode || 500)),
              { statusCode }
            ))
            return
          }
          resolve(json.data || {})
        })
      })
      req.on('timeout', () => req.destroy(createChannelError('request_timeout', 'Desktop command request timed out')))
      req.on('error', error => reject(error))
      if (payload) req.write(payload)
      req.end()
    })
  }
}

class DesktopCommandJournal {
  constructor(filePath, { now = () => Date.now(), fsImpl = fs } = {}) {
    if (!path.isAbsolute(filePath)) throw new Error('Desktop command journal path must be absolute')
    this.filePath = filePath
    this.now = now
    this.fs = fsImpl
    this.loaded = false
    this.state = { version: 1, entries: {} }
  }

  load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'))
      if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        this.state = parsed
      }
    } catch {
      this.state = { version: 1, entries: {} }
    }
    this.prune(false)
  }

  get(task) {
    const entry = this.getRecord(task)
    return entry?.outcome && typeof entry.outcome === 'object' ? entry.outcome : null
  }

  getRecord(task) {
    this.load()
    const entry = this.state.entries[String(task?.task_id || '')]
    if (!entry || entry.fingerprint !== taskFingerprint(task)) return null
    return entry
  }

  wasStarted(task) {
    return Boolean(this.getRecord(task)?.execution_started_at)
  }

  markStarted(task) {
    this.load()
    const taskId = String(task?.task_id || '')
    if (!/^desktop_task_[a-zA-Z0-9-]{8,100}$/.test(taskId)) {
      throw createChannelError('invalid_channel_data', 'Desktop task id is invalid')
    }
    const existing = this.getRecord(task)
    if (existing?.outcome) return
    this.state.entries[taskId] = {
      command: String(task.command || ''),
      fingerprint: taskFingerprint(task),
      outcome: null,
      execution_started_at: existing?.execution_started_at || new Date(this.now()).toISOString(),
      recorded_at: existing?.recorded_at || new Date(this.now()).toISOString(),
      acknowledged_at: ''
    }
    this.persist()
  }

  record(task, outcome) {
    this.load()
    const taskId = String(task?.task_id || '')
    if (!/^desktop_task_[a-zA-Z0-9-]{8,100}$/.test(taskId)) {
      throw createChannelError('invalid_channel_data', 'Desktop task id is invalid')
    }
    const existing = this.getRecord(task)
    this.state.entries[taskId] = {
      command: String(task.command || ''),
      fingerprint: taskFingerprint(task),
      outcome,
      execution_started_at: existing?.execution_started_at || new Date(this.now()).toISOString(),
      recorded_at: new Date(this.now()).toISOString(),
      acknowledged_at: ''
    }
    this.prune(false)
    this.persist()
  }

  acknowledge(taskId) {
    this.load()
    const entry = this.state.entries[String(taskId || '')]
    if (!entry) return
    entry.acknowledged_at = new Date(this.now()).toISOString()
    this.persist()
  }

  prune(shouldPersist = true) {
    if (!this.loaded) this.load()
    const cutoff = this.now() - JOURNAL_RETENTION_MS
    const entries = Object.entries(this.state.entries)
      .filter(([, entry]) => {
        const recordedAt = new Date(entry?.recorded_at || 0).getTime()
        return Number.isFinite(recordedAt) && recordedAt >= cutoff
      })
      .sort((left, right) => new Date(right[1].recorded_at).getTime() - new Date(left[1].recorded_at).getTime())
      .slice(0, JOURNAL_MAX_ENTRIES)
    this.state.entries = Object.fromEntries(entries)
    if (shouldPersist) this.persist()
  }

  persist() {
    const directory = path.dirname(this.filePath)
    this.fs.mkdirSync(directory, { recursive: true })
    const temporaryPath = this.filePath + '.' + process.pid + '.tmp'
    this.fs.writeFileSync(temporaryPath, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 })
    this.fs.copyFileSync(temporaryPath, this.filePath)
    try { this.fs.unlinkSync(temporaryPath) } catch { /* temporary file cleanup is best effort */ }
  }
}

class DesktopCommandChannelClient {
  constructor({
    requestJson,
    getToken,
    deviceId,
    instanceId = makeInstanceId(),
    appVersion,
    handlers,
    journal,
    logger = () => {},
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    idlePollMs = 3000,
    noAuthPollMs = 1500,
    maxBackoffMs = 60000
  }) {
    if (typeof requestJson !== 'function' || typeof getToken !== 'function') {
      throw new TypeError('requestJson and getToken are required')
    }
    if (!/^device_[a-zA-Z0-9-]{16,80}$/.test(String(deviceId || ''))) {
      throw new TypeError('deviceId is invalid')
    }
    if (!/^instance_[a-zA-Z0-9-]{8,100}$/.test(String(instanceId || ''))) {
      throw new TypeError('instanceId is invalid')
    }
    assertPlainObject(handlers, 'handlers')
    if (!journal || typeof journal.get !== 'function' || typeof journal.record !== 'function') {
      throw new TypeError('journal is required')
    }
    this.requestJson = requestJson
    this.getToken = getToken
    this.deviceId = deviceId
    this.instanceId = instanceId
    this.appVersion = String(appVersion || '').slice(0, 40)
    this.handlers = Object.freeze({ ...handlers })
    this.journal = journal
    this.logger = logger
    this.now = now
    this.setTimeoutFn = setTimeoutFn
    this.clearTimeoutFn = clearTimeoutFn
    this.setIntervalFn = setIntervalFn
    this.clearIntervalFn = clearIntervalFn
    this.idlePollMs = idlePollMs
    this.noAuthPollMs = noAuthPollMs
    this.maxBackoffMs = maxBackoffMs
    this.timer = null
    this.running = false
    this.started = false
    this.stopped = true
    this.failureCount = 0
    this.nextHeartbeatAt = 0
    this.lastToken = ''
    this.active = null
  }

  get capabilities() {
    return Object.fromEntries(Object.keys(this.handlers).map(command => [command, true]))
  }

  start() {
    if (this.started && !this.stopped) return
    this.started = true
    this.stopped = false
    this.schedule(0)
  }

  stop() {
    this.stopped = true
    if (this.timer) this.clearTimeoutFn(this.timer)
    this.timer = null
    this.stopRenewal(this.active)
    if (this.active) this.active.cancelled = true
  }

  notifyAuthChanged() {
    this.lastToken = ''
    this.nextHeartbeatAt = 0
    if (!this.stopped) this.schedule(0)
  }

  schedule(delayMs) {
    if (this.stopped) return
    if (this.timer) this.clearTimeoutFn(this.timer)
    this.timer = this.setTimeoutFn(() => {
      this.timer = null
      this.tick().catch(() => {})
    }, Math.max(0, delayMs))
    this.timer?.unref?.()
  }

  async tick() {
    if (this.stopped || this.running) return
    this.running = true
    let delayMs = this.idlePollMs
    try {
      const result = await this.runOnce()
      this.failureCount = 0
      delayMs = result.state === 'unauthenticated' ? this.noAuthPollMs : this.idlePollMs
    } catch (error) {
      this.failureCount += 1
      delayMs = Math.min(this.maxBackoffMs, 1000 * (2 ** Math.min(this.failureCount - 1, 6)))
      this.log('cycle_failed code=' + (error.code || 'unknown') + ' message=' + redactMessage(error.message))
    } finally {
      this.running = false
      this.schedule(delayMs)
    }
  }

  currentToken() {
    return String(this.getToken() || '').trim()
  }

  async authorizedRequest(options) {
    const token = this.currentToken()
    if (!token) throw createChannelError('auth_unavailable', 'Desktop login token is unavailable')
    return this.requestJson({ ...options, token })
  }

  async runOnce() {
    const token = this.currentToken()
    if (!token) {
      this.lastToken = ''
      this.nextHeartbeatAt = 0
      return { state: 'unauthenticated' }
    }
    if (token !== this.lastToken) {
      this.lastToken = token
      this.nextHeartbeatAt = 0
    }
    if (this.now() >= this.nextHeartbeatAt) await this.sendHeartbeat()
    if (this.active) return { state: 'busy' }

    const claim = await this.authorizedRequest({
      method: 'POST',
      endpoint: '/tasks/claim',
      body: {
        protocol_version: PROTOCOL_VERSION,
        device_id: this.deviceId,
        instance_id: this.instanceId,
        available_slots: 1
      }
    })
    if (!claim?.task) return { state: 'idle' }
    await this.handleClaim(claim)
    return { state: 'handled', taskId: claim.task.task_id }
  }

  async sendHeartbeat(forceActiveCount) {
    const activeTaskCount = forceActiveCount === undefined ? (this.active ? 1 : 0) : Number(forceActiveCount)
    const response = await this.authorizedRequest({
      method: 'POST',
      endpoint: '/heartbeat',
      body: {
        protocol_version: PROTOCOL_VERSION,
        device_id: this.deviceId,
        instance_id: this.instanceId,
        app_version: this.appVersion,
        reported_at: new Date(this.now()).toISOString(),
        capabilities: this.capabilities,
        active_task_count: activeTaskCount
      }
    })
    const intervalSeconds = Math.max(5, Math.min(60, Number(response.heartbeat_interval_seconds || 20)))
    this.nextHeartbeatAt = this.now() + intervalSeconds * 1000
    return response
  }

  validateClaim(claim) {
    assertPlainObject(claim, 'claim')
    const task = assertPlainObject(claim.task, 'claim.task')
    const lease = assertPlainObject(claim.lease, 'claim.lease')
    if (!/^desktop_task_[a-zA-Z0-9-]{8,100}$/.test(String(task.task_id || ''))) {
      throw createChannelError('invalid_channel_data', 'Claimed desktop task id is invalid')
    }
    if (!/^lease_[a-zA-Z0-9-]{8,100}$/.test(String(lease.lease_id || ''))) {
      throw createChannelError('invalid_channel_data', 'Claimed desktop lease id is invalid')
    }
    if (!Number.isSafeInteger(Number(lease.fencing_token)) || Number(lease.fencing_token) < 1) {
      throw createChannelError('invalid_channel_data', 'Claimed desktop fencing token is invalid')
    }
    assertPlainObject(task.payload, 'claim.task.payload')
    return { task, lease }
  }

  leaseBody(active, progress = active.progress || {}) {
    return {
      device_id: this.deviceId,
      instance_id: this.instanceId,
      lease_id: active.lease.lease_id,
      fencing_token: Number(active.lease.fencing_token),
      progress
    }
  }

  async updateProgress(active, progress) {
    assertPlainObject(progress, 'progress')
    if (Buffer.byteLength(JSON.stringify(progress), 'utf8') > 8192) {
      throw createChannelError('progress_too_large', 'Desktop command progress is too large')
    }
    if (active.cancelled || this.active !== active) {
      throw createChannelError('lease_inactive', 'Desktop command lease is no longer active')
    }
    active.progress = progress
    return this.authorizedRequest({
      method: 'POST',
      endpoint: '/tasks/' + active.task.task_id + '/status',
      body: this.leaseBody(active, progress)
    })
  }

  startRenewal(active) {
    const seconds = Math.max(5, Math.min(30, Number(active.lease.renew_after_seconds || 20)))
    active.renewTimer = this.setIntervalFn(async () => {
      if (active.renewing || active.cancelled || this.active !== active) return
      active.renewing = true
      try {
        await this.authorizedRequest({
          method: 'POST',
          endpoint: '/tasks/' + active.task.task_id + '/lease/renew',
          body: this.leaseBody(active)
        })
        await this.sendHeartbeat(1)
      } catch (error) {
        this.log(
          'lease_renew_failed task=' + active.task.task_id +
          ' code=' + (error.code || 'unknown') +
          ' message=' + redactMessage(error.message)
        )
        if (['lease_invalid', 'task_not_found'].includes(error.code) || error.statusCode === 410) {
          active.cancelled = true
        }
      } finally {
        active.renewing = false
      }
    }, seconds * 1000)
    active.renewTimer?.unref?.()
  }

  stopRenewal(active) {
    if (!active?.renewTimer) return
    this.clearIntervalFn(active.renewTimer)
    active.renewTimer = null
  }

  makeFailureOutcome(error) {
    return {
      status: 'failed',
      result: {},
      error_code: normalizeErrorCode(error?.code),
      error_message: redactMessage(error?.message || 'Desktop command handler failed'),
      completed_at: new Date(this.now()).toISOString()
    }
  }

  async handleClaim(claim) {
    const { task, lease } = this.validateClaim(claim)
    const active = {
      task,
      lease,
      progress: { phase: 'accepted' },
      cancelled: false,
      renewing: false,
      renewTimer: null
    }
    this.active = active
    this.log(
      'claimed task=' + task.task_id +
      ' command=' + task.command +
      ' attempt=' + Number(task.attempt || 0)
    )
    try {
      const cachedOutcome = this.journal.get(task)
      const interruptedExecution = !cachedOutcome && this.journal.wasStarted?.(task)
      await this.updateProgress(
        active,
        cachedOutcome || interruptedExecution ? { phase: 'recovering_result' } : { phase: 'executing' }
      )
      this.startRenewal(active)

      let outcome = cachedOutcome
      if (!outcome) {
        if (interruptedExecution) {
          outcome = this.makeFailureOutcome(createChannelError(
            'execution_interrupted',
            'A previous desktop execution ended without a terminal result; automatic replay was blocked'
          ))
        } else {
          this.journal.markStarted?.(task)
        }
        const handler = this.handlers[task.command]
        if (!outcome && typeof handler !== 'function') {
          outcome = this.makeFailureOutcome(createChannelError(
            'command_not_supported',
            'The claimed desktop command has no local allow-listed handler'
          ))
        } else if (!outcome) {
          try {
            const result = await handler(task.payload, {
              taskId: task.task_id,
              deviceId: this.deviceId,
              instanceId: this.instanceId,
              reportProgress: progress => this.updateProgress(active, progress),
              assertActive: () => {
                if (active.cancelled || this.active !== active) {
                  throw createChannelError('lease_inactive', 'Desktop command lease is no longer active')
                }
              }
            })
            assertPlainObject(result, 'handler result')
            outcome = {
              status: 'succeeded',
              result,
              error_code: '',
              error_message: '',
              completed_at: new Date(this.now()).toISOString()
            }
          } catch (error) {
            outcome = this.makeFailureOutcome(error)
          }
        }
        this.journal.record(task, outcome)
      }

      await this.authorizedRequest({
        method: 'POST',
        endpoint: '/tasks/' + task.task_id + '/result',
        body: {
          ...this.leaseBody(active),
          status: outcome.status,
          result: outcome.result,
          error_code: outcome.error_code,
          error_message: outcome.error_message,
          completed_at: outcome.completed_at
        }
      })
      this.journal.acknowledge?.(task.task_id)
      this.log(
        'completed task=' + task.task_id +
        ' command=' + task.command +
        ' status=' + outcome.status +
        ' recovered=' + (cachedOutcome ? 1 : 0)
      )
    } finally {
      this.stopRenewal(active)
      if (this.active === active) this.active = null
    }
  }

  log(message) {
    try { this.logger(redactMessage(message, 1000)) } catch { /* logging must not break the channel */ }
  }
}

function createMainDesktopCommandChannel(app) {
  const { getAuthToken } = require('./auth-store')
  const { getDeviceId } = require('./device-identity')
  const { getStoragePaths } = require('./storage-manager')
  const { getCurrentVersion } = require('./hot-updater')
  const { submitVendorRemark } = require('./sales-order-fetch')
  const {
    BUSINESS_PROXY_BASE_URL,
    createDesktopCommandBusinessHandlers
  } = require('./desktop-command-business-handlers')
  const runtimeLog = require('./runtime-logger')
  const deviceId = getDeviceId()
  const storageRoot = getStoragePaths().storageRoot
  const journal = new DesktopCommandJournal(path.join(storageRoot, 'desktop-command', 'journal.json'))
  const appVersion = String(getCurrentVersion() || app.getVersion())
  const businessRequestJson = createHttpsJsonClient({ baseUrl: BUSINESS_PROXY_BASE_URL })
  const businessHandlers = createDesktopCommandBusinessHandlers({
    submitVendorRemark,
    requestApi: options => businessRequestJson({
      ...options,
      token: getAuthToken()
    })
  })

  return new DesktopCommandChannelClient({
    requestJson: createHttpsJsonClient(),
    getToken: getAuthToken,
    deviceId,
    appVersion,
    journal,
    logger: message => runtimeLog.writeLog('REMOTE_TASK', message),
    handlers: {
      'system.ping': async () => ({
        pong: true,
        device_id: deviceId,
        app_version: appVersion,
        handled_at: new Date().toISOString()
      }),
      ...businessHandlers
    }
  })
}

module.exports = {
  DEFAULT_CHANNEL_BASE_URL,
  DesktopCommandChannelClient,
  DesktopCommandJournal,
  PROTOCOL_VERSION,
  createHttpsJsonClient,
  createMainDesktopCommandChannel,
  makeInstanceId,
  normalizeErrorCode,
  redactMessage,
  taskFingerprint
}
