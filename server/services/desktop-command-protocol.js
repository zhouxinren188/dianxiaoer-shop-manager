const PROTOCOL_VERSION = '1.0'
const ENABLED_DESKTOP_COMMANDS = Object.freeze(['system.ping'])
const ENABLED_COMMAND_SET = new Set(ENABLED_DESKTOP_COMMANDS)

function protocolError(code, message) {
  return Object.assign(new Error(message), { code })
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertPlainObject(value, field) {
  if (!isPlainObject(value)) throw protocolError('invalid_request', `${field} must be an object`)
  return value
}

function assertExactKeys(value, allowedKeys, field, requiredKeys = []) {
  assertPlainObject(value, field)
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw protocolError('invalid_request', `${field} contains an unknown field: ${key}`)
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw protocolError('invalid_request', `${field}.${key} is required`)
    }
  }
}

function normalizeIdentifier(value, field, prefix) {
  const normalized = String(value || '').trim()
  const pattern = new RegExp(`^${prefix}[a-zA-Z0-9-]{8,100}$`)
  if (!pattern.test(normalized)) throw protocolError('invalid_request', `${field} is invalid`)
  return normalized
}

function normalizeDeviceId(value) {
  return normalizeIdentifier(value, 'device_id', 'device_')
}

function normalizeInstanceId(value) {
  return normalizeIdentifier(value, 'instance_id', 'instance_')
}

function normalizeLeaseId(value) {
  return normalizeIdentifier(value, 'lease_id', 'lease_')
}

function normalizeIsoTime(value, field) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) throw protocolError('invalid_request', `${field} is invalid`)
  return date.toISOString()
}

function normalizeCapabilities(value) {
  assertPlainObject(value, 'capabilities')
  const normalized = {}
  for (const command of ENABLED_DESKTOP_COMMANDS) normalized[command] = value[command] === true
  return normalized
}

function normalizeCommandPayload(command, payload) {
  assertPlainObject(payload, 'payload')
  if (command === 'system.ping') {
    assertExactKeys(payload, [], 'payload')
    return {}
  }
  throw protocolError('command_not_allowed', 'The command is not enabled for the desktop channel')
}

function normalizeCreateTaskRequest(body) {
  assertExactKeys(
    body,
    ['command', 'payload', 'idempotency_key', 'target_device_id', 'expires_in_seconds'],
    'request',
    ['command', 'payload']
  )
  const command = String(body.command || '').trim()
  if (!ENABLED_COMMAND_SET.has(command)) {
    throw protocolError('command_not_allowed', 'The command is not enabled for the desktop channel')
  }
  const idempotencyKey = String(body.idempotency_key || '').trim()
  if (idempotencyKey && !/^[a-zA-Z0-9_.:-]{8,120}$/.test(idempotencyKey)) {
    throw protocolError('invalid_request', 'idempotency_key is invalid')
  }
  const targetDeviceId = String(body.target_device_id || '').trim()
  if (targetDeviceId) normalizeDeviceId(targetDeviceId)
  const expiresInSeconds = body.expires_in_seconds === undefined
    ? 120
    : Number(body.expires_in_seconds)
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 30 || expiresInSeconds > 600) {
    throw protocolError('invalid_request', 'expires_in_seconds must be between 30 and 600')
  }
  return {
    command,
    payload: normalizeCommandPayload(command, body.payload),
    idempotencyKey,
    targetDeviceId,
    expiresInSeconds
  }
}

function normalizeHeartbeatRequest(body) {
  assertExactKeys(
    body,
    ['protocol_version', 'device_id', 'instance_id', 'app_version', 'reported_at', 'capabilities', 'active_task_count'],
    'request',
    ['protocol_version', 'device_id', 'instance_id', 'app_version', 'reported_at', 'capabilities', 'active_task_count']
  )
  if (body.protocol_version !== PROTOCOL_VERSION) {
    throw protocolError('protocol_version_unsupported', 'Unsupported desktop channel protocol version')
  }
  const activeTaskCount = Number(body.active_task_count)
  if (!Number.isInteger(activeTaskCount) || activeTaskCount < 0 || activeTaskCount > 1) {
    throw protocolError('invalid_request', 'active_task_count is invalid')
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: normalizeDeviceId(body.device_id),
    instanceId: normalizeInstanceId(body.instance_id),
    appVersion: String(body.app_version || '').trim().slice(0, 40),
    reportedAt: normalizeIsoTime(body.reported_at, 'reported_at'),
    capabilities: normalizeCapabilities(body.capabilities),
    activeTaskCount
  }
}

function normalizeClaimRequest(body) {
  assertExactKeys(
    body,
    ['protocol_version', 'device_id', 'instance_id', 'available_slots'],
    'request',
    ['protocol_version', 'device_id', 'instance_id', 'available_slots']
  )
  if (body.protocol_version !== PROTOCOL_VERSION) {
    throw protocolError('protocol_version_unsupported', 'Unsupported desktop channel protocol version')
  }
  if (Number(body.available_slots) !== 1) {
    throw protocolError('invalid_request', 'available_slots must be 1')
  }
  return {
    deviceId: normalizeDeviceId(body.device_id),
    instanceId: normalizeInstanceId(body.instance_id)
  }
}

function normalizeLeaseRequest(body, { allowProgress = false } = {}) {
  const allowed = ['device_id', 'instance_id', 'lease_id', 'fencing_token']
  if (allowProgress) allowed.push('progress')
  assertExactKeys(body, allowed, 'request', ['device_id', 'instance_id', 'lease_id', 'fencing_token'])
  const fencingToken = Number(body.fencing_token)
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
    throw protocolError('invalid_request', 'fencing_token is invalid')
  }
  let progress = {}
  if (allowProgress && body.progress !== undefined) {
    assertPlainObject(body.progress, 'progress')
    const serialized = JSON.stringify(body.progress)
    if (Buffer.byteLength(serialized, 'utf8') > 8192) {
      throw protocolError('invalid_request', 'progress is too large')
    }
    progress = body.progress
  }
  return {
    deviceId: normalizeDeviceId(body.device_id),
    instanceId: normalizeInstanceId(body.instance_id),
    leaseId: normalizeLeaseId(body.lease_id),
    fencingToken,
    progress
  }
}

function redactMessage(value, maxLength = 500) {
  return String(value || '')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(authorization|cookie|token|password|api[_ -]?key)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, maxLength)
}

function normalizeResultRequest(body, command) {
  assertExactKeys(
    body,
    ['device_id', 'instance_id', 'lease_id', 'fencing_token', 'status', 'result', 'error_code', 'error_message', 'completed_at'],
    'request',
    ['device_id', 'instance_id', 'lease_id', 'fencing_token', 'status', 'result', 'completed_at']
  )
  const lease = normalizeLeaseRequest({
    device_id: body.device_id,
    instance_id: body.instance_id,
    lease_id: body.lease_id,
    fencing_token: body.fencing_token
  })
  const status = String(body.status || '')
  if (!['succeeded', 'failed'].includes(status)) {
    throw protocolError('invalid_request', 'status must be succeeded or failed')
  }
  assertPlainObject(body.result, 'result')
  let result = {}
  if (status === 'succeeded' && command === 'system.ping') {
    assertExactKeys(body.result, ['pong', 'device_id', 'app_version', 'handled_at'], 'result', ['pong', 'device_id', 'app_version', 'handled_at'])
    if (body.result.pong !== true || normalizeDeviceId(body.result.device_id) !== lease.deviceId) {
      throw protocolError('invalid_result', 'The ping result does not match the claiming device')
    }
    result = {
      pong: true,
      device_id: lease.deviceId,
      app_version: String(body.result.app_version || '').trim().slice(0, 40),
      handled_at: normalizeIsoTime(body.result.handled_at, 'result.handled_at')
    }
  } else {
    assertExactKeys(body.result, [], 'result')
  }
  const errorCode = String(body.error_code || '').trim()
  if (errorCode && !/^[a-z][a-z0-9_]{0,79}$/.test(errorCode)) {
    throw protocolError('invalid_request', 'error_code is invalid')
  }
  if (status === 'failed' && !errorCode) {
    throw protocolError('invalid_request', 'error_code is required for a failed result')
  }
  return {
    ...lease,
    status,
    result,
    errorCode,
    errorMessage: redactMessage(body.error_message),
    completedAt: normalizeIsoTime(body.completed_at, 'completed_at')
  }
}

module.exports = {
  ENABLED_DESKTOP_COMMANDS,
  PROTOCOL_VERSION,
  assertExactKeys,
  normalizeCapabilities,
  normalizeClaimRequest,
  normalizeCreateTaskRequest,
  normalizeHeartbeatRequest,
  normalizeLeaseRequest,
  normalizeResultRequest,
  protocolError,
  redactMessage
}
