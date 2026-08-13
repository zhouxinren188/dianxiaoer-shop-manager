const crypto = require('crypto')
const {
  EXECUTION_STATUSES,
  PROTOCOL_VERSION,
  WRITE_COMMANDS,
  normalizeCapabilities,
  validateSuccessfulWriteResponse
} = require('./cloud-warehouse-protocol')
const {
  assertExactKeys,
  assertIdentifier,
  assertProtocolVersion,
  parseIsoTime,
  serviceError,
  toIsoTime,
  toMysqlDate
} = require('./cloud-warehouse-executor-auth-service')

const ENABLED_EXECUTOR_COMMANDS = Object.freeze([
  'exception.order.check',
  'exception.order.resolve'
])
const ENABLED_COMMAND_SET = new Set(ENABLED_EXECUTOR_COMMANDS)
const LEASE_SECONDS = 60
const LEASE_RENEW_AFTER_SECONDS = 20
const HEARTBEAT_INTERVAL_SECONDS = 30
const OFFLINE_AFTER_SECONDS = 90
const EXCEPTION_SOURCES = new Set(['billexception', 'soExceptionCentre'])

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

function normalizeEnabledCapabilities(capabilities) {
  const normalized = normalizeCapabilities(capabilities)
  for (const command of Object.keys(normalized)) {
    if (!ENABLED_COMMAND_SET.has(command)) normalized[command] = false
  }
  return normalized
}

async function markExpiredWriteTasksForReview(connection, machineCode, now) {
  const [expiredRows] = await connection.execute(
    `SELECT task_id, workflow_id
       FROM cloud_order_tasks
      WHERE target_machine_code = ?
        AND command = 'exception.order.resolve'
        AND transport_status IN ('leased', 'executing')
        AND lease_expires_at <= ?
      FOR UPDATE`,
    [machineCode, toMysqlDate(now)]
  )
  for (const task of expiredRows) {
    await connection.execute(
      `UPDATE cloud_order_tasks
          SET transport_status = 'review_required', execution_status = 'review_required',
              reason = 'execution_result_unknown', completed_at = COALESCE(completed_at, ?)
        WHERE task_id = ?`,
      [toMysqlDate(now), task.task_id]
    )
    await connection.execute(
      `UPDATE cloud_order_workflows
          SET state = 'review_required', state_version = state_version + 1,
              current_task_id = NULL, review_reason = 'execution_result_unknown',
              review_required_at = ?, updated_at = ?
        WHERE workflow_id = ? AND current_task_id = ?`,
      [toMysqlDate(now), toMysqlDate(now), task.workflow_id, task.task_id]
    )
    await connection.execute(
      'DELETE FROM cloud_order_write_locks WHERE task_id = ?',
      [task.task_id]
    )
    await connection.execute(
      `INSERT INTO cloud_task_events
         (workflow_id, task_id, event_type, actor_type, actor_id, data_redacted_json)
       VALUES (?, ?, 'write_lease_expired', 'system', 'central-service', ?)`,
      [task.workflow_id, task.task_id, JSON.stringify({ reason: 'execution_result_unknown' })]
    )
  }
  return expiredRows.length
}

async function markExpiredReadTasksForReview(connection, now) {
  const [expiredRows] = await connection.execute(
    `SELECT task_id, workflow_id
       FROM cloud_order_tasks
      WHERE command = 'exception.order.check'
        AND transport_status IN ('pending', 'leased', 'executing')
        AND expires_at <= ?
      FOR UPDATE`,
    [toMysqlDate(now)]
  )
  for (const task of expiredRows) {
    await connection.execute(
      `UPDATE cloud_order_tasks
          SET transport_status = 'review_required', execution_status = 'review_required',
              reason = 'task_expired', completed_at = COALESCE(completed_at, ?)
        WHERE task_id = ?`,
      [toMysqlDate(now), task.task_id]
    )
    await connection.execute(
      `UPDATE cloud_order_workflows
          SET state = 'review_required', state_version = state_version + 1,
              current_task_id = NULL, review_reason = 'task_expired',
              review_required_at = ?, updated_at = ?
        WHERE workflow_id = ? AND current_task_id = ?`,
      [toMysqlDate(now), toMysqlDate(now), task.workflow_id, task.task_id]
    )
    await connection.execute(
      `INSERT INTO cloud_task_events
         (workflow_id, task_id, event_type, actor_type, actor_id, data_redacted_json)
       VALUES (?, ?, 'read_task_expired', 'system', 'central-service', ?)`,
      [task.workflow_id, task.task_id, JSON.stringify({ reason: 'task_expired' })]
    )
  }
  return expiredRows.length
}

async function runExecutorMaintenance(pool, now = new Date()) {
  const staleBefore = new Date(now.getTime() - OFFLINE_AFTER_SECONDS * 1000)
  let connection
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    const [machineRows] = await connection.execute(
      `SELECT task_id, target_machine_code AS machine_code
         FROM cloud_order_tasks
        WHERE command = 'exception.order.resolve'
          AND transport_status IN ('leased', 'executing')
          AND lease_expires_at <= ?
        FOR UPDATE`,
      [toMysqlDate(now)]
    )
    let reviewedTaskCount = 0
    for (const machineCode of new Set(machineRows.map(row => row.machine_code))) {
      reviewedTaskCount += await markExpiredWriteTasksForReview(connection, machineCode, now)
    }
    reviewedTaskCount += await markExpiredReadTasksForReview(connection, now)
    const [instanceResult] = await connection.execute(
      `UPDATE cloud_executor_instances
          SET status = 'offline'
        WHERE status <> 'offline' AND last_heartbeat_at < ?`,
      [toMysqlDate(staleBefore)]
    )
    const [machineResult] = await connection.execute(
      `UPDATE cloud_executor_machines
          SET status = 'offline', active_executor_instance_id = '',
              last_failure_reason = 'heartbeat_timeout'
        WHERE status <> 'offline' AND last_heartbeat_at < ?`,
      [toMysqlDate(staleBefore)]
    )
    await connection.commit()
    return {
      reviewedTaskCount,
      offlineInstanceCount: Number(instanceResult.affectedRows || 0),
      offlineMachineCount: Number(machineResult.affectedRows || 0)
    }
  } catch (error) {
    if (connection) {
      try { await connection.rollback() } catch { /* ignore rollback failure */ }
    }
    throw error
  } finally {
    if (connection) connection.release()
  }
}

function assertAuthMachine(auth, machineCode) {
  const normalized = String(machineCode || '').trim().toUpperCase()
  if (!auth?.machineCode || auth.machineCode !== normalized) {
    throw serviceError('machine_code_mismatch', '请求机器码与访问令牌不匹配')
  }
  return normalized
}

function assertInteger(value, field, min, max) {
  const normalized = Number(value)
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw serviceError('invalid_request', `${field} 无效`)
  }
  return normalized
}

function redactMessage(value, maxLength = 500) {
  return String(value || '')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(authorization|cookie|token|password|api[_ -]?key)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, maxLength)
}

function normalizeReason(value) {
  const reason = String(value || '').trim()
  if (reason && !/^[a-z][a-z0-9_]{0,79}$/.test(reason)) {
    throw serviceError('invalid_request', 'response.reason 必须是安全原因码')
  }
  return reason
}

function normalizeExceptionCheckResult(result, status) {
  assertExactKeys(
    result,
    ['exception_snapshot_ref', 'exception_count', 'queried_at', 'exceptions'],
    'response.result',
    status === 'succeeded' ? ['exception_count', 'queried_at', 'exceptions'] : []
  )
  if (status !== 'succeeded') {
    if (Object.keys(result).length) throw serviceError('invalid_request', '未成功的异常查询 result 必须为空对象')
    return {}
  }
  const exceptionCount = assertInteger(result.exception_count, 'response.result.exception_count', 0, 100)
  if (!Array.isArray(result.exceptions) || result.exceptions.length !== exceptionCount) {
    throw serviceError('invalid_request', '异常数量与脱敏异常列表不一致')
  }
  const queriedAt = parseIsoTime(result.queried_at, 'response.result.queried_at').toISOString()
  const exceptions = result.exceptions.map((item, index) => {
    assertExactKeys(
      item,
      ['source', 'exception_type_masked', 'reason_masked'],
      `response.result.exceptions[${index}]`
    )
    if (!EXCEPTION_SOURCES.has(item.source)) {
      throw serviceError('invalid_request', '异常来源不在固定枚举中')
    }
    return {
      source: item.source,
      exception_type_masked: redactMessage(item.exception_type_masked, 200),
      reason_masked: redactMessage(item.reason_masked, 500)
    }
  })
  const snapshotRef = String(result.exception_snapshot_ref || '').trim()
  if (exceptionCount > 0 && (!snapshotRef.startsWith('exsnap-') || snapshotRef.length > 200)) {
    throw serviceError('invalid_request', '存在异常时必须返回有效 exception_snapshot_ref')
  }
  if (exceptionCount === 0 && snapshotRef) {
    throw serviceError('invalid_request', '无异常时不得返回 exception_snapshot_ref')
  }
  return {
    exception_snapshot_ref: snapshotRef,
    exception_count: exceptionCount,
    queried_at: queriedAt,
    exceptions
  }
}

function normalizeExecutorResponse(response, task, expectedExecutorInstanceId) {
  assertExactKeys(response, [
    'protocol_version',
    'task_id',
    'command',
    'order_id',
    'status',
    'reason',
    'message',
    'delivery',
    'result',
    'verification',
    'executor',
    'completed_at'
  ], 'response')
  assertProtocolVersion(response.protocol_version)
  if (response.task_id !== task.task_id || response.command !== task.command || response.order_id !== task.order_ref_id) {
    throw serviceError('result_conflict', '回执与任务标识不一致')
  }
  if (!ENABLED_COMMAND_SET.has(response.command)) {
    throw serviceError('capability_unavailable', '该命令尚未在中央服务启用')
  }
  const status = String(response.status || '')
  if (!EXECUTION_STATUSES.includes(status) || status === 'executing') {
    throw serviceError('invalid_request', '结果回传必须使用终态 status')
  }
  const reason = normalizeReason(response.reason)
  assertExactKeys(response.delivery, ['received', 'executed', 'business_confirmed'], 'response.delivery')
  assertExactKeys(response.verification, ['confirmed', 'observed_status'], 'response.verification')
  assertExactKeys(response.executor, ['device_id', 'executor_instance_id'], 'response.executor')
  const executorInstanceId = assertIdentifier(
    response.executor.executor_instance_id,
    'response.executor.executor_instance_id'
  )
  if (executorInstanceId !== expectedExecutorInstanceId) {
    throw serviceError('lease_mismatch', '回执执行器实例与任务租约不匹配')
  }
  const delivery = {
    received: response.delivery.received === true,
    executed: response.delivery.executed === true,
    business_confirmed: response.delivery.business_confirmed === true
  }
  const verification = {
    confirmed: response.verification.confirmed === true,
    observed_status: String(response.verification.observed_status || '').trim().slice(0, 80)
  }
  let result
  if (response.command === 'exception.order.check') {
    result = normalizeExceptionCheckResult(response.result, status)
  } else {
    assertExactKeys(response.result, [], 'response.result', [])
    result = {}
  }
  const completedAt = parseIsoTime(response.completed_at, 'response.completed_at').toISOString()
  const normalized = {
    protocol_version: PROTOCOL_VERSION,
    task_id: task.task_id,
    command: task.command,
    order_id: task.order_ref_id,
    status,
    reason,
    message: redactMessage(response.message),
    delivery,
    result,
    verification,
    executor: {
      device_id: String(response.executor.device_id || '').trim().slice(0, 100),
      executor_instance_id: executorInstanceId
    },
    completed_at: completedAt
  }
  if (status === 'succeeded') {
    if (!delivery.received || !delivery.executed || !delivery.business_confirmed || !verification.confirmed ||
        reason !== 'business_state_confirmed') {
      throw serviceError('business_state_unconfirmed', '成功回执缺少完整业务确认')
    }
    if (WRITE_COMMANDS.has(task.command)) {
      const validation = validateSuccessfulWriteResponse(normalized)
      if (!validation.valid) {
        throw serviceError('unexpected_business_state', `写后状态必须为 ${validation.expectedStatus}`)
      }
    }
  }
  return normalized
}

function responseFingerprint(response) {
  return crypto.createHash('sha256').update(JSON.stringify(response), 'utf8').digest('hex')
}

function formatTaskEnvelope(row) {
  const envelope = {
    protocol_version: row.protocol_version,
    task_id: row.task_id,
    trace_id: row.trace_id,
    command: row.command,
    order_id: row.order_ref_id,
    idempotency_key: row.idempotency_key,
    created_at: toIsoTime(row.created_at),
    expires_at: toIsoTime(row.expires_at),
    requested_by: parseJsonObject(row.requested_by_json),
    target: { machine_code: row.target_machine_code },
    params: parseJsonObject(row.params_json)
  }
  const confirmation = parseJsonObject(row.confirmation_json)
  if (Object.keys(confirmation).length) envelope.confirmation = confirmation
  return envelope
}

function normalizeHeartbeatPayload(payload, auth) {
  assertExactKeys(payload, [
    'protocol_version',
    'machine_code',
    'executor_instance_id',
    'reported_at',
    'status',
    'executor_version',
    'capabilities',
    'readiness',
    'active_task_count',
    'last_failure_reason'
  ], 'request')
  assertProtocolVersion(payload.protocol_version)
  const machineCode = assertAuthMachine(auth, payload.machine_code)
  const executorInstanceId = assertIdentifier(payload.executor_instance_id, 'executor_instance_id')
  parseIsoTime(payload.reported_at, 'reported_at')
  if (payload.status !== 'online') throw serviceError('invalid_request', '心跳 status 必须是 online')
  const executorVersion = assertIdentifier(payload.executor_version, 'executor_version', 50)
  if (!payload.capabilities || typeof payload.capabilities !== 'object' || Array.isArray(payload.capabilities)) {
    throw serviceError('invalid_request', 'capabilities 必须是对象')
  }
  assertExactKeys(payload.readiness, ['printer_available', 'login_environment_available'], 'readiness')
  return {
    machineCode,
    executorInstanceId,
    executorVersion,
    capabilities: normalizeEnabledCapabilities(payload.capabilities),
    printerAvailable: payload.readiness.printer_available === true,
    loginEnvironmentAvailable: payload.readiness.login_environment_available === true,
    activeTaskCount: assertInteger(payload.active_task_count, 'active_task_count', 0, 100),
    lastFailureReason: redactMessage(payload.last_failure_reason, 255),
    reportedAt: parseIsoTime(payload.reported_at, 'reported_at')
  }
}

async function recordHeartbeat(pool, auth, payload, now = new Date()) {
  const heartbeat = normalizeHeartbeatPayload(payload, auth)
  if (Math.abs(heartbeat.reportedAt.getTime() - now.getTime()) > 5 * 60 * 1000) {
    throw serviceError('invalid_request', 'reported_at 与服务器时间偏差过大')
  }
  const staleBefore = new Date(now.getTime() - OFFLINE_AFTER_SECONDS * 1000)
  let connection
  let conflict = false
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    const [machineRows] = await connection.execute(
      `SELECT m.machine_code, b.machine_code AS bound_machine_code
         FROM cloud_executor_machines m
         LEFT JOIN cloud_machine_bindings b ON b.machine_code = m.machine_code
        WHERE m.machine_code = ?
        FOR UPDATE`,
      [heartbeat.machineCode]
    )
    if (!machineRows.length || !machineRows[0].bound_machine_code) {
      throw serviceError('machine_binding_missing', '机器码尚未绑定或执行器未登记')
    }
    await markExpiredWriteTasksForReview(connection, heartbeat.machineCode, now)
    const [instanceRows] = await connection.execute(
      'SELECT machine_code FROM cloud_executor_instances WHERE executor_instance_id = ? FOR UPDATE',
      [heartbeat.executorInstanceId]
    )
    if (instanceRows.length && instanceRows[0].machine_code !== heartbeat.machineCode) {
      throw serviceError('executor_instance_conflict', '执行器实例标识已属于其他机器码')
    }
    await connection.execute(
      `INSERT INTO cloud_executor_instances
         (executor_instance_id, machine_code, status, protocol_version, executor_version,
          capabilities_json, printer_available, login_environment_available,
          last_heartbeat_at, created_at)
       VALUES (?, ?, 'online', ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE machine_code = VALUES(machine_code), status = 'online',
          protocol_version = VALUES(protocol_version), executor_version = VALUES(executor_version),
          capabilities_json = VALUES(capabilities_json), printer_available = VALUES(printer_available),
          login_environment_available = VALUES(login_environment_available),
          last_heartbeat_at = VALUES(last_heartbeat_at)`,
      [
        heartbeat.executorInstanceId,
        heartbeat.machineCode,
        PROTOCOL_VERSION,
        heartbeat.executorVersion,
        JSON.stringify(heartbeat.capabilities),
        heartbeat.printerAvailable ? 1 : 0,
        heartbeat.loginEnvironmentAvailable ? 1 : 0,
        toMysqlDate(now),
        toMysqlDate(now)
      ]
    )
    await connection.execute(
      `UPDATE cloud_executor_instances
          SET status = 'offline'
        WHERE machine_code = ? AND last_heartbeat_at < ?`,
      [heartbeat.machineCode, toMysqlDate(staleBefore)]
    )
    const [liveRows] = await connection.execute(
      `SELECT executor_instance_id
         FROM cloud_executor_instances
        WHERE machine_code = ? AND status = 'online' AND last_heartbeat_at >= ?
        FOR UPDATE`,
      [heartbeat.machineCode, toMysqlDate(staleBefore)]
    )
    conflict = liveRows.length > 1
    await connection.execute(
      `UPDATE cloud_executor_machines
          SET status = ?, active_executor_instance_id = ?, protocol_version = ?,
              executor_version = ?, capabilities_json = ?, printer_available = ?,
              login_environment_available = ?, last_heartbeat_at = ?, last_failure_reason = ?
        WHERE machine_code = ?`,
      [
        conflict ? 'conflict' : 'online',
        conflict ? '' : heartbeat.executorInstanceId,
        PROTOCOL_VERSION,
        heartbeat.executorVersion,
        JSON.stringify(conflict ? normalizeEnabledCapabilities({}) : heartbeat.capabilities),
        conflict ? 0 : (heartbeat.printerAvailable ? 1 : 0),
        conflict ? 0 : (heartbeat.loginEnvironmentAvailable ? 1 : 0),
        toMysqlDate(now),
        conflict ? 'executor_instance_conflict' : heartbeat.lastFailureReason,
        heartbeat.machineCode
      ]
    )
    await connection.commit()
  } catch (error) {
    if (connection) {
      try { await connection.rollback() } catch { /* ignore rollback failure */ }
    }
    throw error
  } finally {
    if (connection) connection.release()
  }
  if (conflict) throw serviceError('executor_instance_conflict', '同一机器码存在多个活跃执行器实例')
  return {
    accepted: true,
    server_time: now.toISOString(),
    heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
    offline_after_seconds: OFFLINE_AFTER_SECONDS
  }
}

function normalizeClaimPayload(payload, auth) {
  assertExactKeys(payload, [
    'protocol_version',
    'machine_code',
    'executor_instance_id',
    'available_slots',
    'wait_seconds'
  ], 'request')
  assertProtocolVersion(payload.protocol_version)
  return {
    machineCode: assertAuthMachine(auth, payload.machine_code),
    executorInstanceId: assertIdentifier(payload.executor_instance_id, 'executor_instance_id'),
    availableSlots: assertInteger(payload.available_slots, 'available_slots', 1, 10),
    waitSeconds: assertInteger(payload.wait_seconds, 'wait_seconds', 0, 25)
  }
}

async function assertActiveInstance(connection, claim, now) {
  const staleBefore = new Date(now.getTime() - OFFLINE_AFTER_SECONDS * 1000)
  const [rows] = await connection.execute(
    `SELECT m.status AS machine_status, m.active_executor_instance_id,
            m.capabilities_json, m.printer_available, m.login_environment_available,
            m.last_heartbeat_at AS machine_heartbeat_at,
            i.machine_code AS instance_machine_code, i.status AS instance_status,
            i.last_heartbeat_at AS instance_heartbeat_at,
            b.machine_code AS bound_machine_code
       FROM cloud_executor_machines m
       JOIN cloud_executor_instances i ON i.executor_instance_id = ?
       LEFT JOIN cloud_machine_bindings b ON b.machine_code = m.machine_code
      WHERE m.machine_code = ?
      FOR UPDATE`,
    [claim.executorInstanceId, claim.machineCode]
  )
  const row = rows[0]
  if (!row || !row.bound_machine_code || row.instance_machine_code !== claim.machineCode) {
    throw serviceError('machine_binding_missing', '执行器机器码未绑定')
  }
  if (row.machine_status === 'conflict') {
    throw serviceError('executor_instance_conflict', '同一机器码存在多个活跃执行器实例')
  }
  if (row.machine_status !== 'online' || row.instance_status !== 'online' ||
      row.active_executor_instance_id !== claim.executorInstanceId ||
      new Date(row.machine_heartbeat_at).getTime() < staleBefore.getTime() ||
      new Date(row.instance_heartbeat_at).getTime() < staleBefore.getTime()) {
    throw serviceError('capability_unavailable', '执行器心跳已过期或实例未激活')
  }
  return {
    capabilities: normalizeEnabledCapabilities(parseJsonObject(row.capabilities_json)),
    printerAvailable: Number(row.printer_available || 0) === 1,
    loginEnvironmentAvailable: Number(row.login_environment_available || 0) === 1
  }
}

async function claimTask(pool, auth, payload, now = new Date()) {
  const claim = normalizeClaimPayload(payload, auth)
  let connection
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    const route = await assertActiveInstance(connection, claim, now)
    await markExpiredWriteTasksForReview(connection, claim.machineCode, now)
    const claimableCommands = ENABLED_EXECUTOR_COMMANDS.filter(command => route.capabilities[command] === true)
    if (!claimableCommands.length || !route.loginEnvironmentAvailable) {
      await connection.commit()
      return { lease: null, task: null, retry_after_seconds: 3 }
    }
    const placeholders = claimableCommands.map(() => '?').join(', ')
    const [taskRows] = await connection.execute(
      `SELECT t.*
         FROM cloud_order_tasks t
        WHERE t.target_machine_code = ?
          AND t.command IN (${placeholders})
          AND t.expires_at > ?
          AND (t.scheduled_for IS NULL OR t.scheduled_for <= ?)
          AND (
            t.transport_status = 'pending'
            OR (t.command = 'exception.order.check'
                AND t.transport_status IN ('leased', 'executing')
                AND t.lease_expires_at <= ?)
          )
          AND (
            t.command <> 'exception.order.resolve'
            OR NOT EXISTS (
              SELECT 1 FROM cloud_order_write_locks l
               WHERE l.order_ref_id = t.order_ref_id
                 AND l.lease_expires_at > ?
                 AND l.task_id <> t.task_id
            )
          )
        ORDER BY t.created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [
        claim.machineCode,
        ...claimableCommands,
        toMysqlDate(now),
        toMysqlDate(now),
        toMysqlDate(now),
        toMysqlDate(now)
      ]
    )
    if (!taskRows.length) {
      await connection.commit()
      return { lease: null, task: null, retry_after_seconds: 3 }
    }
    const task = taskRows[0]
    if (WRITE_COMMANDS.has(task.command)) {
      // 串行锁定订单级写锁键，避免两个领取事务同时通过 NOT EXISTS 后互相覆盖。
      const [writeLockRows] = await connection.execute(
        'SELECT task_id, lease_expires_at FROM cloud_order_write_locks WHERE order_ref_id = ? FOR UPDATE',
        [task.order_ref_id]
      )
      const activeOtherLock = writeLockRows.find(lock =>
        lock.task_id !== task.task_id && new Date(lock.lease_expires_at).getTime() > now.getTime()
      )
      if (activeOtherLock) throw serviceError('device_locked', '该订单已有写任务正在执行')
    }
    const taskExpiresAt = new Date(task.expires_at)
    const leaseExpiresAt = new Date(Math.min(taskExpiresAt.getTime(), now.getTime() + LEASE_SECONDS * 1000))
    const leaseId = createLeaseId()
    const fencingToken = Number(task.lease_fencing_token || 0) + 1
    await connection.execute(
      `UPDATE cloud_order_tasks
          SET transport_status = 'leased', execution_status = NULL,
              lease_id = ?, lease_fencing_token = ?, lease_expires_at = ?,
              last_renewed_at = ?, claimed_executor_instance_id = ?,
              received_at = COALESCE(received_at, ?), delivery_received = 1
        WHERE task_id = ?`,
      [
        leaseId,
        fencingToken,
        toMysqlDate(leaseExpiresAt),
        toMysqlDate(now),
        claim.executorInstanceId,
        toMysqlDate(now),
        task.task_id
      ]
    )
    if (WRITE_COMMANDS.has(task.command)) {
      await connection.execute(
        `INSERT INTO cloud_order_write_locks
           (order_ref_id, workflow_id, task_id, fencing_token, lease_expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE workflow_id = VALUES(workflow_id), task_id = VALUES(task_id),
                                 fencing_token = VALUES(fencing_token),
                                 lease_expires_at = VALUES(lease_expires_at)`,
        [task.order_ref_id, task.workflow_id, task.task_id, fencingToken, toMysqlDate(leaseExpiresAt)]
      )
    }
    await connection.execute(
      `INSERT INTO cloud_task_events
         (workflow_id, task_id, event_type, actor_type, actor_id, data_redacted_json)
       VALUES (?, ?, 'task_claimed', 'executor', ?, ?)`,
      [task.workflow_id, task.task_id, claim.executorInstanceId, JSON.stringify({
        lease_id: leaseId,
        fencing_token: fencingToken
      })]
    )
    await connection.commit()
    return {
      lease: {
        lease_id: leaseId,
        fencing_token: fencingToken,
        expires_at: leaseExpiresAt.toISOString(),
        renew_after_seconds: LEASE_RENEW_AFTER_SECONDS
      },
      task: formatTaskEnvelope(task)
    }
  } catch (error) {
    if (connection) {
      try { await connection.rollback() } catch { /* ignore rollback failure */ }
    }
    throw error
  } finally {
    if (connection) connection.release()
  }
}

function createLeaseId() {
  return `lease_${crypto.randomUUID()}`
}

function normalizeLeaseIdentity(payload, auth, { includeStatus = false, includeExtension = false } = {}) {
  const allowed = [
    'protocol_version',
    'machine_code',
    'executor_instance_id',
    'lease_id',
    'fencing_token'
  ]
  if (includeStatus) allowed.push('status', 'reported_at')
  if (includeExtension) allowed.push('requested_extension_seconds')
  assertExactKeys(payload, allowed, 'request')
  assertProtocolVersion(payload.protocol_version)
  const normalized = {
    machineCode: assertAuthMachine(auth, payload.machine_code),
    executorInstanceId: assertIdentifier(payload.executor_instance_id, 'executor_instance_id'),
    leaseId: assertIdentifier(payload.lease_id, 'lease_id', 64),
    fencingToken: assertInteger(payload.fencing_token, 'fencing_token', 1, Number.MAX_SAFE_INTEGER)
  }
  if (includeStatus) {
    if (payload.status !== 'executing') throw serviceError('invalid_request', '状态回传只接受 executing')
    normalized.reportedAt = parseIsoTime(payload.reported_at, 'reported_at')
  }
  if (includeExtension) {
    normalized.extensionSeconds = assertInteger(
      payload.requested_extension_seconds,
      'requested_extension_seconds',
      1,
      LEASE_SECONDS
    )
  }
  return normalized
}

async function readLeasedTaskForUpdate(connection, taskId, identity, now) {
  const [rows] = await connection.execute(
    `SELECT t.*, w.owner_id AS workflow_owner_id,
            b.machine_code AS bound_machine_code,
            i.machine_code AS instance_machine_code,
            i.status AS instance_status, i.last_heartbeat_at AS instance_heartbeat_at,
            m.status AS machine_status, m.active_executor_instance_id
       FROM cloud_order_tasks t
       JOIN cloud_order_workflows w ON w.workflow_id = t.workflow_id
       LEFT JOIN cloud_machine_bindings b ON b.owner_id = w.owner_id
       LEFT JOIN cloud_executor_instances i ON i.executor_instance_id = ?
       LEFT JOIN cloud_executor_machines m ON m.machine_code = t.target_machine_code
      WHERE t.task_id = ?
      FOR UPDATE`,
    [identity.executorInstanceId, taskId]
  )
  const task = rows[0]
  if (!task) throw serviceError('task_not_found', '任务不存在')
  if (task.target_machine_code !== identity.machineCode || task.bound_machine_code !== identity.machineCode ||
      task.instance_machine_code !== identity.machineCode) {
    throw serviceError('machine_code_mismatch', '任务目标机器码不匹配')
  }
  if (task.claimed_executor_instance_id !== identity.executorInstanceId || task.lease_id !== identity.leaseId) {
    throw serviceError('lease_mismatch', '任务租约或执行器实例不匹配')
  }
  if (Number(task.lease_fencing_token) !== identity.fencingToken) {
    throw serviceError('fencing_token_stale', '租约 fencing token 已失效')
  }
  if (!['leased', 'executing'].includes(task.transport_status)) {
    throw serviceError('lease_mismatch', '任务不处于可执行租约状态')
  }
  if (new Date(task.expires_at).getTime() <= now.getTime()) {
    throw serviceError('task_expired', '任务已过期')
  }
  if (new Date(task.lease_expires_at).getTime() <= now.getTime()) {
    throw serviceError('lease_expired', '任务租约已过期')
  }
  const staleBefore = now.getTime() - OFFLINE_AFTER_SECONDS * 1000
  if (task.machine_status !== 'online' || task.instance_status !== 'online' ||
      task.active_executor_instance_id !== identity.executorInstanceId ||
      new Date(task.instance_heartbeat_at).getTime() < staleBefore) {
    throw serviceError('executor_instance_conflict', '执行器实例不再是当前活跃实例')
  }
  return task
}

async function reportExecuting(pool, auth, taskId, payload, now = new Date()) {
  const identity = normalizeLeaseIdentity(payload, auth, { includeStatus: true })
  let connection
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    const task = await readLeasedTaskForUpdate(connection, taskId, identity, now)
    await connection.execute(
      `UPDATE cloud_order_tasks
          SET transport_status = 'executing', execution_status = 'executing',
              started_at = COALESCE(started_at, ?), delivery_executed = 1
        WHERE task_id = ?`,
      [toMysqlDate(now), task.task_id]
    )
    await connection.execute(
      `INSERT INTO cloud_task_events
         (workflow_id, task_id, event_type, actor_type, actor_id, data_redacted_json)
       VALUES (?, ?, 'execution_started', 'executor', ?, ?)`,
      [task.workflow_id, task.task_id, identity.executorInstanceId, JSON.stringify({
        reported_at: identity.reportedAt.toISOString()
      })]
    )
    await connection.commit()
    return {
      accepted: true,
      task_id: task.task_id,
      status: 'executing',
      recorded_at: now.toISOString()
    }
  } catch (error) {
    if (connection) {
      try { await connection.rollback() } catch { /* ignore rollback failure */ }
    }
    throw error
  } finally {
    if (connection) connection.release()
  }
}

async function renewLease(pool, auth, taskId, payload, now = new Date()) {
  const identity = normalizeLeaseIdentity(payload, auth, { includeExtension: true })
  let connection
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    const task = await readLeasedTaskForUpdate(connection, taskId, identity, now)
    const taskExpiresAt = new Date(task.expires_at)
    const leaseExpiresAt = new Date(Math.min(
      taskExpiresAt.getTime(),
      now.getTime() + identity.extensionSeconds * 1000
    ))
    if (leaseExpiresAt.getTime() <= now.getTime()) throw serviceError('task_expired', '任务已过期')
    await connection.execute(
      `UPDATE cloud_order_tasks
          SET lease_expires_at = ?, last_renewed_at = ?
        WHERE task_id = ?`,
      [toMysqlDate(leaseExpiresAt), toMysqlDate(now), task.task_id]
    )
    if (WRITE_COMMANDS.has(task.command)) {
      await connection.execute(
        `UPDATE cloud_order_write_locks
            SET lease_expires_at = ?
          WHERE task_id = ? AND fencing_token = ?`,
        [toMysqlDate(leaseExpiresAt), task.task_id, identity.fencingToken]
      )
    }
    await connection.commit()
    return {
      lease_id: identity.leaseId,
      fencing_token: identity.fencingToken,
      expires_at: leaseExpiresAt.toISOString(),
      renew_after_seconds: LEASE_RENEW_AFTER_SECONDS
    }
  } catch (error) {
    if (connection) {
      try { await connection.rollback() } catch { /* ignore rollback failure */ }
    }
    throw error
  } finally {
    if (connection) connection.release()
  }
}

function normalizeMappingPayload(payload, auth) {
  assertExactKeys(payload, [
    'protocol_version',
    'machine_code',
    'executor_instance_id',
    'lease_id',
    'fencing_token',
    'order_id'
  ], 'request')
  assertProtocolVersion(payload.protocol_version)
  return {
    machineCode: assertAuthMachine(auth, payload.machine_code),
    executorInstanceId: assertIdentifier(payload.executor_instance_id, 'executor_instance_id'),
    leaseId: assertIdentifier(payload.lease_id, 'lease_id', 64),
    fencingToken: assertInteger(payload.fencing_token, 'fencing_token', 1, Number.MAX_SAFE_INTEGER),
    orderRefId: assertIdentifier(payload.order_id, 'order_id', 64)
  }
}

function nextWorkflowState(task, response) {
  if (response.status !== 'succeeded') return 'review_required'
  if (task.command === 'exception.order.check') {
    return response.result.exception_count > 0 ? 'exception_found' : 'exception_clear'
  }
  if (task.command === 'exception.order.resolve') return 'waiting_arrival'
  return 'review_required'
}

async function recordTaskResult(pool, auth, taskId, payload, now = new Date()) {
  assertExactKeys(payload, ['lease_id', 'fencing_token', 'response'], 'request')
  const leaseId = assertIdentifier(payload.lease_id, 'lease_id', 64)
  const fencingToken = assertInteger(payload.fencing_token, 'fencing_token', 1, Number.MAX_SAFE_INTEGER)
  let connection
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    const [rows] = await connection.execute(
      `SELECT t.*, w.owner_id AS workflow_owner_id,
              b.machine_code AS bound_machine_code,
              i.machine_code AS instance_machine_code,
              i.status AS instance_status, i.last_heartbeat_at AS instance_heartbeat_at,
              m.status AS machine_status, m.active_executor_instance_id
         FROM cloud_order_tasks t
         JOIN cloud_order_workflows w ON w.workflow_id = t.workflow_id
         LEFT JOIN cloud_machine_bindings b ON b.owner_id = w.owner_id
         LEFT JOIN cloud_executor_instances i ON i.executor_instance_id = t.claimed_executor_instance_id
         LEFT JOIN cloud_executor_machines m ON m.machine_code = t.target_machine_code
        WHERE t.task_id = ?
        FOR UPDATE`,
      [taskId]
    )
    const task = rows[0]
    if (!task) throw serviceError('task_not_found', '任务不存在')
    if (task.target_machine_code !== auth.machineCode || task.bound_machine_code !== auth.machineCode) {
      throw serviceError('machine_code_mismatch', '任务目标机器码不匹配')
    }
    if (task.lease_id !== leaseId) throw serviceError('lease_mismatch', '结果租约不匹配')
    if (Number(task.lease_fencing_token) !== fencingToken) {
      throw serviceError('fencing_token_stale', '结果 fencing token 已失效')
    }
    const normalizedResponse = normalizeExecutorResponse(
      payload.response,
      task,
      task.claimed_executor_instance_id
    )
    const completedAtMs = new Date(normalizedResponse.completed_at).getTime()
    if (completedAtMs < new Date(task.created_at).getTime() - 5 * 60 * 1000 ||
        completedAtMs > now.getTime() + 5 * 60 * 1000) {
      throw serviceError('invalid_request', 'completed_at 超出任务允许的时间范围')
    }
    const responseHash = responseFingerprint(normalizedResponse)
    if (task.response_hash) {
      if (task.response_hash !== responseHash) throw serviceError('result_conflict', '同一任务回传了不同结果')
      await connection.commit()
      return {
        accepted: true,
        task_id: task.task_id,
        recorded_at: toIsoTime(task.result_recorded_at || task.updated_at || now),
        replayed: true
      }
    }
    const identity = {
      machineCode: auth.machineCode,
      executorInstanceId: task.claimed_executor_instance_id,
      leaseId,
      fencingToken
    }
    await readLeasedTaskForUpdate(connection, taskId, identity, now)
    const workflowState = nextWorkflowState(task, normalizedResponse)
    await connection.execute(
      `UPDATE cloud_order_tasks
          SET transport_status = 'completed', execution_status = ?, reason = ?,
              message_redacted = ?, completed_at = ?, delivery_received = ?,
              delivery_executed = ?, business_confirmed = ?,
              verification_confirmed = ?, observed_status = ?, observed_at = ?,
              result_redacted_json = ?, response_redacted_json = ?, response_hash = ?,
              result_recorded_at = ?
        WHERE task_id = ?`,
      [
        normalizedResponse.status,
        normalizedResponse.reason,
        normalizedResponse.message,
        toMysqlDate(normalizedResponse.completed_at),
        normalizedResponse.delivery.received ? 1 : 0,
        normalizedResponse.delivery.executed ? 1 : 0,
        normalizedResponse.delivery.business_confirmed ? 1 : 0,
        normalizedResponse.verification.confirmed ? 1 : 0,
        normalizedResponse.verification.observed_status,
        toMysqlDate(normalizedResponse.completed_at),
        JSON.stringify(normalizedResponse.result),
        JSON.stringify(normalizedResponse),
        responseHash,
        toMysqlDate(now),
        task.task_id
      ]
    )
    const [workflowUpdate] = await connection.execute(
      `UPDATE cloud_order_workflows
          SET state = ?, state_version = state_version + 1, current_task_id = NULL,
              last_observed_status = ?, last_observed_at = ?, last_reason = ?,
              last_message_redacted = ?,
              review_reason = CASE WHEN ? = 'review_required' THEN ? ELSE '' END,
              review_required_at = CASE WHEN ? = 'review_required' THEN ? ELSE NULL END
        WHERE workflow_id = ? AND current_task_id = ?`,
      [
        workflowState,
        normalizedResponse.verification.observed_status,
        toMysqlDate(normalizedResponse.completed_at),
        normalizedResponse.reason,
        normalizedResponse.message,
        workflowState,
        normalizedResponse.reason || normalizedResponse.status,
        workflowState,
        toMysqlDate(now),
        task.workflow_id,
        task.task_id
      ]
    )
    if (workflowUpdate.affectedRows !== 1) {
      throw serviceError('result_conflict', '工作流当前任务已经变化')
    }
    if (WRITE_COMMANDS.has(task.command)) {
      await connection.execute(
        'DELETE FROM cloud_order_write_locks WHERE task_id = ? AND fencing_token = ?',
        [task.task_id, fencingToken]
      )
    }
    await connection.execute(
      `INSERT INTO cloud_task_events
         (workflow_id, task_id, event_type, actor_type, actor_id, data_redacted_json)
       VALUES (?, ?, 'result_recorded', 'executor', ?, ?)`,
      [task.workflow_id, task.task_id, task.claimed_executor_instance_id, JSON.stringify({
        status: normalizedResponse.status,
        reason: normalizedResponse.reason,
        observed_status: normalizedResponse.verification.observed_status
      })]
    )
    await connection.commit()
    return {
      accepted: true,
      task_id: task.task_id,
      recorded_at: now.toISOString(),
      replayed: false
    }
  } catch (error) {
    if (connection) {
      try { await connection.rollback() } catch { /* ignore rollback failure */ }
    }
    throw error
  } finally {
    if (connection) connection.release()
  }
}

module.exports = {
  ENABLED_EXECUTOR_COMMANDS,
  HEARTBEAT_INTERVAL_SECONDS,
  LEASE_RENEW_AFTER_SECONDS,
  LEASE_SECONDS,
  OFFLINE_AFTER_SECONDS,
  assertAuthMachine,
  claimTask,
  normalizeClaimPayload,
  normalizeEnabledCapabilities,
  normalizeExecutorResponse,
  normalizeHeartbeatPayload,
  normalizeMappingPayload,
  markExpiredWriteTasksForReview,
  markExpiredReadTasksForReview,
  recordHeartbeat,
  recordTaskResult,
  redactMessage,
  renewLease,
  reportExecuting,
  responseFingerprint,
  runExecutorMaintenance
}
