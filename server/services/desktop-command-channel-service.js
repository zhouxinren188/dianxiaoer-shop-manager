const crypto = require('crypto')
const {
  ENABLED_DESKTOP_COMMANDS,
  PROTOCOL_VERSION,
  normalizeClaimRequest,
  normalizeCreateTaskRequest,
  normalizeHeartbeatRequest,
  normalizeLeaseRequest,
  normalizeResultRequest,
  protocolError
} = require('./desktop-command-protocol')

const LEASE_SECONDS = 60
const HEARTBEAT_INTERVAL_SECONDS = 20
const OFFLINE_AFTER_SECONDS = 70
const MAX_ATTEMPTS = 3

function toMysqlDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  const pad = number => String(number).padStart(2, '0')
  const millis = String(date.getMilliseconds()).padStart(3, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${millis}`
}

function toIsoTime(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function parseJsonObject(value) {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function makeId(prefix) {
  const randomPart = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex')
  return `${prefix}${randomPart}`
}

function hashResult(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function formatTask(row, { includePayload = false } = {}) {
  if (!row) return null
  const task = {
    protocol_version: PROTOCOL_VERSION,
    task_id: row.task_id,
    command: row.command,
    status: row.status,
    target_device_id: row.target_device_id || '',
    claimed_device_id: row.claimed_device_id || '',
    attempt_count: Number(row.attempt_count || 0),
    progress: parseJsonObject(row.progress_json),
    result: parseJsonObject(row.result_json),
    error_code: row.error_code || '',
    error_message: row.error_message || '',
    created_at: toIsoTime(row.created_at),
    expires_at: toIsoTime(row.expires_at),
    started_at: toIsoTime(row.started_at),
    completed_at: toIsoTime(row.completed_at),
    updated_at: toIsoTime(row.updated_at)
  }
  if (includePayload) task.payload = parseJsonObject(row.payload_json)
  return task
}

function formatClaim(row, leaseId, fencingToken, leaseExpiresAt) {
  return {
    task: {
      protocol_version: PROTOCOL_VERSION,
      task_id: row.task_id,
      command: row.command,
      payload: parseJsonObject(row.payload_json),
      created_at: toIsoTime(row.created_at),
      expires_at: toIsoTime(row.expires_at),
      attempt: Number(row.attempt_count || 0) + 1
    },
    lease: {
      lease_id: leaseId,
      fencing_token: fencingToken,
      expires_at: leaseExpiresAt.toISOString(),
      renew_after_seconds: 20
    }
  }
}

async function createTask(pool, auth, body, now = new Date()) {
  const input = normalizeCreateTaskRequest(body)
  const taskId = makeId('desktop_task_')
  const idempotencyKey = input.idempotencyKey || makeId('desktop_idem_')
  const expiresAt = new Date(now.getTime() + input.expiresInSeconds * 1000)
  await pool.execute(
    `INSERT IGNORE INTO desktop_command_tasks
       (task_id, user_id, requested_by_user_id, command, payload_json, idempotency_key,
        target_device_id, status, created_at, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    [
      taskId,
      auth.userId,
      auth.userId,
      input.command,
      JSON.stringify(input.payload),
      idempotencyKey,
      input.targetDeviceId,
      toMysqlDate(now),
      toMysqlDate(expiresAt),
      toMysqlDate(now)
    ]
  )
  const [rows] = await pool.execute(
    `SELECT * FROM desktop_command_tasks WHERE user_id = ? AND idempotency_key = ? LIMIT 1`,
    [auth.userId, idempotencyKey]
  )
  if (!rows.length) throw protocolError('task_create_failed', 'The desktop task could not be created')
  const existingTask = rows[0]
  const sameRequest = existingTask.command === input.command &&
    String(existingTask.target_device_id || '') === input.targetDeviceId &&
    JSON.stringify(parseJsonObject(existingTask.payload_json)) === JSON.stringify(input.payload)
  if (!sameRequest) {
    throw protocolError(
      'idempotency_conflict',
      'The idempotency key is already associated with a different desktop task request'
    )
  }
  return formatTask(rows[0])
}

async function getTask(pool, auth, taskId) {
  const [rows] = await pool.execute(
    `SELECT * FROM desktop_command_tasks WHERE user_id = ? AND task_id = ? LIMIT 1`,
    [auth.userId, String(taskId || '').trim()]
  )
  if (!rows.length) throw protocolError('task_not_found', 'Desktop task not found')
  return formatTask(rows[0])
}

async function listDevices(pool, auth, now = new Date()) {
  const [rows] = await pool.execute(
    `SELECT device_id, instance_id, app_version, status, capabilities_json,
            active_task_count, last_heartbeat_at, created_at, updated_at
       FROM desktop_command_devices
      WHERE user_id = ?
      ORDER BY last_heartbeat_at DESC`,
    [auth.userId]
  )
  const onlineAfter = now.getTime() - OFFLINE_AFTER_SECONDS * 1000
  return rows.map(row => {
    const heartbeat = new Date(row.last_heartbeat_at).getTime()
    return {
      device_id: row.device_id,
      instance_id: row.instance_id,
      app_version: row.app_version || '',
      status: heartbeat >= onlineAfter ? 'online' : 'offline',
      capabilities: parseJsonObject(row.capabilities_json),
      active_task_count: Number(row.active_task_count || 0),
      last_heartbeat_at: toIsoTime(row.last_heartbeat_at)
    }
  })
}

async function recordHeartbeat(pool, auth, body, now = new Date()) {
  const input = normalizeHeartbeatRequest(body)
  await pool.execute(
    `INSERT INTO desktop_command_devices
       (user_id, device_id, instance_id, protocol_version, app_version, status, capabilities_json,
        active_task_count, last_heartbeat_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'online', ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       instance_id = VALUES(instance_id), protocol_version = VALUES(protocol_version),
       app_version = VALUES(app_version), status = 'online',
       capabilities_json = VALUES(capabilities_json), active_task_count = VALUES(active_task_count),
       last_heartbeat_at = VALUES(last_heartbeat_at), updated_at = VALUES(updated_at)`,
    [
      auth.userId,
      input.deviceId,
      input.instanceId,
      input.protocolVersion,
      input.appVersion,
      JSON.stringify(input.capabilities),
      input.activeTaskCount,
      toMysqlDate(now),
      toMysqlDate(now),
      toMysqlDate(now)
    ]
  )
  return {
    accepted: true,
    server_time: now.toISOString(),
    heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
    offline_after_seconds: OFFLINE_AFTER_SECONDS
  }
}

async function maintainExpiredTasks(connection, userId, now) {
  const mysqlNow = toMysqlDate(now)
  await connection.execute(
    `UPDATE desktop_command_tasks
        SET status = 'expired', completed_at = COALESCE(completed_at, ?), updated_at = ?
      WHERE user_id = ? AND status = 'queued' AND expires_at <= ?`,
    [mysqlNow, mysqlNow, userId, mysqlNow]
  )
  await connection.execute(
    `UPDATE desktop_command_tasks
        SET status = 'queued', claimed_device_id = '', claimed_instance_id = '',
            lease_id = '', lease_expires_at = NULL, progress_json = NULL, updated_at = ?
      WHERE user_id = ? AND status IN ('leased', 'executing')
        AND lease_expires_at <= ? AND expires_at > ? AND attempt_count < ?`,
    [mysqlNow, userId, mysqlNow, mysqlNow, MAX_ATTEMPTS]
  )
  await connection.execute(
    `UPDATE desktop_command_tasks
        SET status = 'failed', error_code = 'lease_exhausted',
            error_message = 'Desktop task lease expired too many times',
            completed_at = COALESCE(completed_at, ?), updated_at = ?
      WHERE user_id = ? AND status IN ('leased', 'executing')
        AND lease_expires_at <= ? AND attempt_count >= ?`,
    [mysqlNow, mysqlNow, userId, mysqlNow, MAX_ATTEMPTS]
  )
}

async function claimTask(pool, auth, body, now = new Date()) {
  const input = normalizeClaimRequest(body)
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await maintainExpiredTasks(connection, auth.userId, now)
    const activeAfter = new Date(now.getTime() - OFFLINE_AFTER_SECONDS * 1000)
    const [deviceRows] = await connection.execute(
      `SELECT instance_id, capabilities_json
         FROM desktop_command_devices
        WHERE user_id = ? AND device_id = ? AND instance_id = ?
          AND last_heartbeat_at > ?
        FOR UPDATE`,
      [auth.userId, input.deviceId, input.instanceId, toMysqlDate(activeAfter)]
    )
    if (!deviceRows.length) throw protocolError('device_not_ready', 'The desktop device has no active heartbeat')
    const capabilities = parseJsonObject(deviceRows[0].capabilities_json)
    const enabledCommands = ENABLED_DESKTOP_COMMANDS.filter(command => capabilities[command] === true)
    if (!enabledCommands.length) {
      await connection.commit()
      return { task: null, lease: null }
    }
    const placeholders = enabledCommands.map(() => '?').join(', ')
    const [rows] = await connection.execute(
      `SELECT * FROM desktop_command_tasks
        WHERE user_id = ? AND status = 'queued'
          AND expires_at > ?
          AND (target_device_id = '' OR target_device_id = ?)
          AND command IN (${placeholders})
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE`,
      [auth.userId, toMysqlDate(now), input.deviceId, ...enabledCommands]
    )
    if (!rows.length) {
      await connection.commit()
      return { task: null, lease: null }
    }
    const row = rows[0]
    const leaseId = makeId('lease_')
    const fencingToken = Number(row.fencing_token || 0) + 1
    const leaseExpiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000)
    const [updateResult] = await connection.execute(
      `UPDATE desktop_command_tasks
          SET status = 'leased', claimed_device_id = ?, claimed_instance_id = ?,
              lease_id = ?, fencing_token = ?, lease_expires_at = ?,
              attempt_count = attempt_count + 1, updated_at = ?
        WHERE task_id = ? AND user_id = ? AND status = 'queued'`,
      [
        input.deviceId,
        input.instanceId,
        leaseId,
        fencingToken,
        toMysqlDate(leaseExpiresAt),
        toMysqlDate(now),
        row.task_id,
        auth.userId
      ]
    )
    if (Number(updateResult.affectedRows || 0) !== 1) {
      throw protocolError('task_claim_conflict', 'The desktop task was claimed concurrently')
    }
    await connection.commit()
    return formatClaim(row, leaseId, fencingToken, leaseExpiresAt)
  } catch (error) {
    try { await connection.rollback() } catch { /* ignore rollback failure */ }
    throw error
  } finally {
    connection.release()
  }
}

async function updateTaskStatus(pool, auth, taskId, body, now = new Date()) {
  const input = normalizeLeaseRequest(body, { allowProgress: true })
  const [result] = await pool.execute(
    `UPDATE desktop_command_tasks
        SET status = 'executing', progress_json = ?, started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE task_id = ? AND user_id = ? AND status IN ('leased', 'executing')
        AND claimed_device_id = ? AND claimed_instance_id = ?
        AND lease_id = ? AND fencing_token = ? AND lease_expires_at > ?`,
    [
      JSON.stringify(input.progress),
      toMysqlDate(now),
      toMysqlDate(now),
      String(taskId || '').trim(),
      auth.userId,
      input.deviceId,
      input.instanceId,
      input.leaseId,
      input.fencingToken,
      toMysqlDate(now)
    ]
  )
  if (Number(result.affectedRows || 0) !== 1) {
    throw protocolError('lease_invalid', 'The desktop task lease is invalid or expired')
  }
  return { accepted: true, server_time: now.toISOString() }
}

async function renewLease(pool, auth, taskId, body, now = new Date()) {
  const input = normalizeLeaseRequest(body, { allowProgress: true })
  const leaseExpiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000)
  const [result] = await pool.execute(
    `UPDATE desktop_command_tasks
        SET lease_expires_at = ?, progress_json = ?, updated_at = ?
      WHERE task_id = ? AND user_id = ? AND status IN ('leased', 'executing')
        AND claimed_device_id = ? AND claimed_instance_id = ?
        AND lease_id = ? AND fencing_token = ? AND lease_expires_at > ?`,
    [
      toMysqlDate(leaseExpiresAt),
      JSON.stringify(input.progress),
      toMysqlDate(now),
      String(taskId || '').trim(),
      auth.userId,
      input.deviceId,
      input.instanceId,
      input.leaseId,
      input.fencingToken,
      toMysqlDate(now)
    ]
  )
  if (Number(result.affectedRows || 0) !== 1) {
    throw protocolError('lease_invalid', 'The desktop task lease is invalid or expired')
  }
  return { accepted: true, lease_expires_at: leaseExpiresAt.toISOString() }
}

async function recordTaskResult(pool, auth, taskId, body, now = new Date()) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [rows] = await connection.execute(
      `SELECT * FROM desktop_command_tasks WHERE task_id = ? AND user_id = ? FOR UPDATE`,
      [String(taskId || '').trim(), auth.userId]
    )
    if (!rows.length) throw protocolError('task_not_found', 'Desktop task not found')
    const task = rows[0]
    const input = normalizeResultRequest(body, task.command)
    const normalizedResult = {
      status: input.status,
      result: input.result,
      error_code: input.errorCode,
      error_message: input.errorMessage,
      completed_at: input.completedAt
    }
    const resultHash = hashResult(normalizedResult)
    const sameClaim = task.claimed_device_id === input.deviceId &&
      task.claimed_instance_id === input.instanceId &&
      task.lease_id === input.leaseId &&
      Number(task.fencing_token) === input.fencingToken
    if (['succeeded', 'failed'].includes(task.status)) {
      if (!sameClaim) {
        throw protocolError('lease_invalid', 'The terminal result replay does not match the original desktop task lease')
      }
      if (task.result_hash === resultHash) {
        await connection.commit()
        return { accepted: true, task_id: task.task_id, replayed: true }
      }
      throw protocolError('result_conflict', 'A different terminal result was already recorded')
    }
    if (
      !sameClaim ||
      new Date(task.lease_expires_at).getTime() <= now.getTime()
    ) {
      throw protocolError('lease_invalid', 'The desktop task lease is invalid or expired')
    }
    await connection.execute(
      `UPDATE desktop_command_tasks
          SET status = ?, result_json = ?, result_hash = ?, error_code = ?, error_message = ?,
              completed_at = ?, lease_expires_at = NULL, updated_at = ?
        WHERE task_id = ? AND user_id = ?`,
      [
        input.status,
        JSON.stringify(input.result),
        resultHash,
        input.errorCode,
        input.errorMessage,
        toMysqlDate(input.completedAt),
        toMysqlDate(now),
        task.task_id,
        auth.userId
      ]
    )
    await connection.commit()
    return { accepted: true, task_id: task.task_id, replayed: false }
  } catch (error) {
    try { await connection.rollback() } catch { /* ignore rollback failure */ }
    throw error
  } finally {
    connection.release()
  }
}

module.exports = {
  HEARTBEAT_INTERVAL_SECONDS,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  OFFLINE_AFTER_SECONDS,
  claimTask,
  createTask,
  formatTask,
  getTask,
  listDevices,
  maintainExpiredTasks,
  recordHeartbeat,
  recordTaskResult,
  renewLease,
  toMysqlDate,
  updateTaskStatus
}
