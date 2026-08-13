const crypto = require('crypto')
const {
  PROTOCOL_VERSION,
  assertMachineCode,
  createOpaqueId
} = require('./cloud-warehouse-protocol')

const ENROLLMENT_TTL_MS = 10 * 60 * 1000
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60

function serviceError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function hashOpaqueSecret(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')
}

function safeHashEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8')
  const rightBuffer = Buffer.from(String(right || ''), 'utf8')
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function randomSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`
}

function assertProtocolVersion(value) {
  if (value !== PROTOCOL_VERSION) {
    throw serviceError('invalid_protocol_version', `仅支持协议版本 ${PROTOCOL_VERSION}`)
  }
  return value
}

function assertIdentifier(value, field, maxLength = 100) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw serviceError('invalid_request', `${field} 无效`)
  }
  return normalized
}

function parseIsoTime(value, field) {
  const normalized = assertIdentifier(value, field, 40)
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(normalized)) {
    throw serviceError('invalid_request', `${field} 必须是 ISO 时间`)
  }
  return date
}

function toMysqlDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw serviceError('invalid_request', '时间无效')
  const pad = number => String(number).padStart(2, '0')
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${milliseconds}`
}

function toIsoTime(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function assertExactKeys(value, allowedKeys, field, requiredKeys = allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw serviceError('invalid_request', `${field} 必须是对象`)
  }
  const allowed = new Set(allowedKeys)
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length) throw serviceError('invalid_request', `${field} 包含未知字段`)
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw serviceError('invalid_request', `${field}.${key} 不能为空`)
    }
  }
  return value
}

async function createEnrollment(pool, { ownerId, actorUserId, machineCode, now = new Date() }) {
  const normalizedMachineCode = assertMachineCode(machineCode)
  const enrollmentCode = randomSecret('enroll')
  const enrollmentId = createOpaqueId('enrollment')
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS)
  let connection
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    const [bindingRows] = await connection.execute(
      'SELECT machine_code FROM cloud_machine_bindings WHERE owner_id = ? FOR UPDATE',
      [Number(ownerId)]
    )
    if (!bindingRows.length) throw serviceError('machine_binding_missing', '当前主账号体系尚未绑定云仓助手机器码')
    if (bindingRows[0].machine_code !== normalizedMachineCode) {
      throw serviceError('machine_binding_changed', '机器码绑定已经变化')
    }
    await connection.execute(
      `UPDATE cloud_executor_enrollments
          SET used_at = COALESCE(used_at, NOW(3))
        WHERE machine_code = ? AND used_at IS NULL`,
      [normalizedMachineCode]
    )
    await connection.execute(
      `INSERT INTO cloud_executor_enrollments
         (enrollment_id, owner_id, machine_code, code_hash, expires_at, issued_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        enrollmentId,
        Number(ownerId),
        normalizedMachineCode,
        hashOpaqueSecret(enrollmentCode),
        toMysqlDate(expiresAt),
        Number(actorUserId),
        toMysqlDate(now)
      ]
    )
    await connection.commit()
    return {
      machine_code: normalizedMachineCode,
      enrollment_code: enrollmentCode,
      expires_at: expiresAt.toISOString()
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

async function revokeMachineAccess(connection, machineCode, reason = 'credential_revoked') {
  const normalizedMachineCode = assertMachineCode(machineCode)
  await connection.execute(
    `UPDATE cloud_executor_credentials
        SET status = 'revoked', revoked_at = NOW(3), revoke_reason = ?
      WHERE machine_code = ? AND status = 'active'`,
    [String(reason).slice(0, 80), normalizedMachineCode]
  )
  await connection.execute(
    `UPDATE cloud_executor_access_tokens
        SET revoked_at = COALESCE(revoked_at, NOW(3))
      WHERE machine_code = ? AND revoked_at IS NULL`,
    [normalizedMachineCode]
  )
  await connection.execute(
    `UPDATE cloud_executor_instances
        SET status = 'offline'
      WHERE machine_code = ?`,
    [normalizedMachineCode]
  )
  await connection.execute(
    `UPDATE cloud_executor_machines
        SET status = 'offline', active_executor_instance_id = '',
            last_failure_reason = ?
      WHERE machine_code = ?`,
    [String(reason).slice(0, 255), normalizedMachineCode]
  )
  await connection.execute(
    `UPDATE cloud_order_workflows w
       JOIN cloud_order_tasks t ON t.task_id = w.current_task_id
        SET w.state = 'review_required', w.state_version = w.state_version + 1,
            w.current_task_id = NULL, w.review_reason = ?,
            w.review_required_at = NOW(3), w.updated_at = NOW(3)
      WHERE t.target_machine_code = ?
        AND t.transport_status IN ('leased', 'executing')`,
    [String(reason).slice(0, 80), normalizedMachineCode]
  )
  await connection.execute(
    `UPDATE cloud_order_tasks
        SET transport_status = 'review_required', execution_status = 'review_required',
            reason = ?, lease_expires_at = NOW(3), completed_at = COALESCE(completed_at, NOW(3))
      WHERE target_machine_code = ?
        AND transport_status IN ('leased', 'executing')`,
    [String(reason).slice(0, 80), normalizedMachineCode]
  )
  await connection.execute(
    `DELETE FROM cloud_order_write_locks
      WHERE task_id IN (
        SELECT task_id FROM cloud_order_tasks
         WHERE target_machine_code = ? AND transport_status = 'review_required'
      )`,
    [normalizedMachineCode]
  )
}

async function enrollExecutor(pool, payload, now = new Date()) {
  assertExactKeys(payload, [
    'protocol_version',
    'machine_code',
    'enrollment_code',
    'executor_instance_id',
    'executor_version',
    'started_at'
  ], 'request')
  assertProtocolVersion(payload.protocol_version)
  const machineCode = assertMachineCode(payload.machine_code)
  const enrollmentCode = assertIdentifier(payload.enrollment_code, 'enrollment_code', 100)
  const executorInstanceId = assertIdentifier(payload.executor_instance_id, 'executor_instance_id')
  const executorVersion = assertIdentifier(payload.executor_version, 'executor_version', 50)
  const startedAt = parseIsoTime(payload.started_at, 'started_at')
  const credentialId = createOpaqueId('execred')
  const clientId = createOpaqueId('exec')
  const clientSecret = randomSecret('execsec')
  let connection
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    const [enrollmentRows] = await connection.execute(
      `SELECT e.enrollment_id, e.owner_id, e.machine_code, e.expires_at, e.used_at,
              b.machine_code AS bound_machine_code
         FROM cloud_executor_enrollments e
         JOIN cloud_machine_bindings b ON b.owner_id = e.owner_id
        WHERE e.code_hash = ?
        FOR UPDATE`,
      [hashOpaqueSecret(enrollmentCode)]
    )
    if (enrollmentRows.length !== 1) throw serviceError('unauthorized_executor', '登记码无效')
    const enrollment = enrollmentRows[0]
    if (enrollment.machine_code !== machineCode || enrollment.bound_machine_code !== machineCode) {
      throw serviceError('machine_code_mismatch', '登记码与绑定机器码不匹配')
    }
    if (enrollment.used_at || new Date(enrollment.expires_at).getTime() <= now.getTime()) {
      throw serviceError('credential_revoked', '登记码已使用或已过期')
    }

    await connection.execute(
      `INSERT INTO cloud_executor_machines
         (machine_code, status, protocol_version, executor_version, created_at)
       VALUES (?, 'offline', ?, ?, ?)
       ON DUPLICATE KEY UPDATE protocol_version = VALUES(protocol_version),
                               executor_version = VALUES(executor_version)`,
      [machineCode, PROTOCOL_VERSION, executorVersion, toMysqlDate(now)]
    )
    const [instanceRows] = await connection.execute(
      'SELECT machine_code FROM cloud_executor_instances WHERE executor_instance_id = ? FOR UPDATE',
      [executorInstanceId]
    )
    if (instanceRows.length && instanceRows[0].machine_code !== machineCode) {
      throw serviceError('executor_instance_conflict', '执行器实例标识已属于其他机器码')
    }
    await revokeMachineAccess(connection, machineCode, 'credential_reissued')
    await connection.execute(
      `INSERT INTO cloud_executor_credentials
         (credential_id, client_id, machine_code, secret_hash, status, issued_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      [credentialId, clientId, machineCode, hashOpaqueSecret(clientSecret), toMysqlDate(now)]
    )
    await connection.execute(
      `INSERT INTO cloud_executor_instances
         (executor_instance_id, machine_code, status, protocol_version, executor_version, started_at)
       VALUES (?, ?, 'offline', ?, ?, ?)
       ON DUPLICATE KEY UPDATE machine_code = VALUES(machine_code), status = 'offline',
                               protocol_version = VALUES(protocol_version),
                               executor_version = VALUES(executor_version),
                               started_at = VALUES(started_at)`,
      [executorInstanceId, machineCode, PROTOCOL_VERSION, executorVersion, toMysqlDate(startedAt)]
    )
    await connection.execute(
      'UPDATE cloud_executor_enrollments SET used_at = ? WHERE enrollment_id = ?',
      [toMysqlDate(now), enrollment.enrollment_id]
    )
    await connection.commit()
    return {
      credential_id: credentialId,
      client_id: clientId,
      client_secret: clientSecret,
      machine_code: machineCode,
      issued_at: now.toISOString()
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

async function issueExecutorToken(pool, payload, now = new Date()) {
  assertExactKeys(payload, ['grant_type', 'client_id', 'client_secret'], 'request')
  if (payload.grant_type !== 'client_credentials') {
    throw serviceError('invalid_request', 'grant_type 必须是 client_credentials')
  }
  const clientId = assertIdentifier(payload.client_id, 'client_id', 64)
  const clientSecret = assertIdentifier(payload.client_secret, 'client_secret', 100)
  const [rows] = await pool.execute(
    `SELECT c.credential_id, c.machine_code, c.secret_hash, c.status,
            b.machine_code AS bound_machine_code
       FROM cloud_executor_credentials c
       LEFT JOIN cloud_machine_bindings b ON b.machine_code = c.machine_code
      WHERE c.client_id = ?`,
    [clientId]
  )
  const credential = rows[0]
  const suppliedHash = hashOpaqueSecret(clientSecret)
  if (!credential || credential.status !== 'active' || !credential.bound_machine_code ||
      !safeHashEqual(credential.secret_hash, suppliedHash)) {
    throw serviceError('unauthorized_executor', '执行器凭据无效')
  }
  const accessToken = randomSecret('exectok')
  const expiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000)
  await pool.execute(
    `INSERT INTO cloud_executor_access_tokens
       (token_hash, credential_id, machine_code, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      hashOpaqueSecret(accessToken),
      credential.credential_id,
      credential.machine_code,
      toMysqlDate(expiresAt),
      toMysqlDate(now)
    ]
  )
  await pool.execute(
    'UPDATE cloud_executor_credentials SET last_used_at = ? WHERE credential_id = ?',
    [toMysqlDate(now), credential.credential_id]
  )
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    machine_code: credential.machine_code
  }
}

async function authenticateAccessToken(pool, accessToken, now = new Date()) {
  const normalizedToken = assertIdentifier(accessToken, 'access_token', 120)
  const [rows] = await pool.execute(
    `SELECT t.credential_id, t.machine_code, t.expires_at, t.revoked_at,
            c.status AS credential_status,
            b.machine_code AS bound_machine_code
       FROM cloud_executor_access_tokens t
       JOIN cloud_executor_credentials c ON c.credential_id = t.credential_id
       LEFT JOIN cloud_machine_bindings b ON b.machine_code = t.machine_code
      WHERE t.token_hash = ?`,
    [hashOpaqueSecret(normalizedToken)]
  )
  const token = rows[0]
  if (!token || token.revoked_at || token.credential_status !== 'active' || !token.bound_machine_code) {
    throw serviceError('unauthorized_executor', '执行器访问令牌无效')
  }
  if (new Date(token.expires_at).getTime() <= now.getTime()) {
    throw serviceError('unauthorized_executor', '执行器访问令牌已过期')
  }
  pool.execute(
    'UPDATE cloud_executor_access_tokens SET last_used_at = ? WHERE token_hash = ?',
    [toMysqlDate(now), hashOpaqueSecret(normalizedToken)]
  ).catch(() => {})
  return {
    credentialId: token.credential_id,
    machineCode: token.machine_code,
    expiresAt: toIsoTime(token.expires_at)
  }
}

module.exports = {
  ACCESS_TOKEN_TTL_SECONDS,
  ENROLLMENT_TTL_MS,
  assertExactKeys,
  assertIdentifier,
  assertProtocolVersion,
  authenticateAccessToken,
  createEnrollment,
  enrollExecutor,
  hashOpaqueSecret,
  issueExecutorToken,
  parseIsoTime,
  revokeMachineAccess,
  safeHashEqual,
  serviceError,
  toIsoTime,
  toMysqlDate
}
