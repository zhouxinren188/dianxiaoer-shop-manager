const crypto = require('crypto')
const { assertMachineCode, getTenantOwnerId } = require('./cloud-warehouse-protocol')
const { normalizeOrderYear, readAccessiblePurchaseOrder, readRelatedSalesLocator } = require('./cloud-warehouse-order-service')

const ENABLED_COMMANDS = Object.freeze(['exception.order.check', 'exception.order.resolve'])
const ACTIVE_STATUSES = new Set(['submitting', 'submission_unknown', 'accepted', 'pending', 'queued', 'executing'])
const SENSITIVE_KEY_PATTERN = /(authorization|api[_-]?key|cookie|token|password|secret|credential)/i

function serviceError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function assertEnabledCommand(value) {
  const command = String(value || '').trim()
  if (!ENABLED_COMMANDS.includes(command)) {
    throw serviceError('command_not_allowed', '第一阶段只允许异常查询和异常处理命令')
  }
  return command
}

function unwrapData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : value
}

function sanitizeExternalValue(value, depth = 0) {
  if (depth > 6) return '[已省略]'
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeExternalValue(item, depth + 1))
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') return value.slice(0, 1000)
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
    return String(value || '').slice(0, 1000)
  }
  const sanitized = {}
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    sanitized[String(key).slice(0, 100)] = SENSITIVE_KEY_PATTERN.test(key)
      ? '[已脱敏]'
      : sanitizeExternalValue(item, depth + 1)
  }
  return sanitized
}

function normalizeMachineStatus(response, expectedMachineCode) {
  const payload = unwrapData(response?.body)
  const returnedMachineCode = String(payload.machine_code || payload.machineCode || '').trim().toUpperCase()
  if (returnedMachineCode && returnedMachineCode !== expectedMachineCode) {
    throw serviceError('cloud_api_invalid_response', '云仓助手返回的机器码与查询目标不一致')
  }
  if (typeof payload.online !== 'boolean') {
    throw serviceError('cloud_api_invalid_response', '云仓助手在线查询响应缺少 online 字段')
  }
  const state = String(payload.state || '').trim().toLowerCase()
  const capabilities = Object.fromEntries(ENABLED_COMMANDS.map(command => [
    command,
    payload.capabilities?.[command] === true
  ]))
  return {
    machineCode: expectedMachineCode,
    online: payload.online,
    busy: state === 'busy',
    status: payload.online ? (state || 'online') : 'offline',
    capabilities,
    activeRequestId: String(payload.active_request_id || '').trim() || null,
    checkedAt: payload.checked_at || new Date().toISOString()
  }
}

function normalizeCommandResponse(response, expectedRequestId, command) {
  const payload = unwrapData(response?.body)
  const returnedRequestId = String(payload.request_id || payload.requestId || '').trim()
  if (returnedRequestId && returnedRequestId !== expectedRequestId) {
    throw serviceError('cloud_api_invalid_response', '云仓助手返回的 request_id 与请求不一致')
  }
  const returnedCommand = String(payload.command || '').trim()
  if (returnedCommand && returnedCommand !== command) {
    throw serviceError('cloud_api_invalid_response', '云仓助手返回的 command 与请求不一致')
  }
  const httpStatus = Number(response?.httpStatus || 0)
  const status = String(payload.status || (httpStatus === 202 ? 'accepted' : '')).trim().toLowerCase()
  if (!status) throw serviceError('cloud_api_invalid_response', '云仓助手指令响应缺少 status 字段')
  const execution = payload.response && typeof payload.response === 'object' && !Array.isArray(payload.response)
    ? payload.response
    : null
  const final = httpStatus === 200 && status === 'completed'
  if (final && !execution) {
    throw serviceError('cloud_api_invalid_response', '云仓助手最终响应缺少 response 字段')
  }
  return {
    requestId: expectedRequestId,
    command,
    httpStatus,
    status,
    final,
    executionStatus: String(execution?.status || '').trim().toLowerCase(),
    reason: String(execution?.reason || '').slice(0, 100),
    message: String(execution?.message || '').slice(0, 500),
    result: sanitizeExternalValue(execution?.result || {}),
    response: sanitizeExternalValue(response?.body || {}),
    completedAt: payload.completed_at || null
  }
}

function buildCommandPayload({ requestId, machineCode, command, orderNo, orderYear }) {
  const normalizedOrderNo = String(orderNo || '').trim()
  if (!normalizedOrderNo || normalizedOrderNo.length > 100) {
    throw serviceError('platform_order_no_invalid', '销售订单号无效')
  }
  return {
    request_id: String(requestId),
    machine_code: assertMachineCode(machineCode),
    command: assertEnabledCommand(command),
    order_no: normalizedOrderNo,
    order_year: normalizeOrderYear(orderYear)
  }
}

function createRequestId() {
  return crypto.randomUUID()
}

async function readBinding(pool, ownerId) {
  const [rows] = await pool.execute(
    'SELECT machine_code, binding_version, bound_at, updated_at FROM cloud_machine_bindings WHERE owner_id = ? LIMIT 1',
    [ownerId]
  )
  return rows[0] || null
}

async function readCommand(pool, ownerId, requestId) {
  const [rows] = await pool.execute(
    `SELECT request_id, purchase_order_id, machine_code, command, order_no, order_year,
            transport_status, http_status, reason, message_redacted, response_json,
            created_at, updated_at, completed_at
       FROM cloud_external_commands
      WHERE owner_id = ? AND request_id = ?`,
    [ownerId, requestId]
  )
  return rows[0] || null
}

function parseStoredResponse(value) {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value
  try { return JSON.parse(value) } catch { return {} }
}

function commandRowSummary(row) {
  if (!row) return null
  const response = parseStoredResponse(row.response_json)
  const payload = unwrapData(response)
  const execution = payload.response && typeof payload.response === 'object' ? payload.response : {}
  return {
    requestId: row.request_id,
    command: row.command,
    status: row.transport_status || '',
    final: row.transport_status === 'completed',
    executionStatus: String(execution.status || '').slice(0, 50),
    reason: row.reason || String(execution.reason || '').slice(0, 100),
    message: row.message_redacted || String(execution.message || '').slice(0, 500),
    result: sanitizeExternalValue(execution.result || {}),
    response: sanitizeExternalValue(response),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    completedAt: row.completed_at || payload.completed_at || null
  }
}

async function persistCommandResponse(pool, ownerId, normalized) {
  await pool.execute(
    `UPDATE cloud_external_commands
        SET transport_status = ?, http_status = ?, reason = ?, message_redacted = ?,
            response_json = ?, completed_at = ?, updated_at = NOW(3)
      WHERE owner_id = ? AND request_id = ?`,
    [
      normalized.status,
      normalized.httpStatus,
      normalized.reason,
      normalized.message,
      JSON.stringify(normalized.response),
      normalized.final ? (normalized.completedAt ? new Date(normalized.completedAt) : new Date()) : null,
      ownerId,
      normalized.requestId
    ]
  )
}

async function queryMachineStatus(pool, apiClient, user) {
  const ownerId = getTenantOwnerId(user)
  const binding = await readBinding(pool, ownerId)
  if (!binding) throw serviceError('machine_binding_missing', '请先绑定云仓助手机器码')
  const machineCode = assertMachineCode(binding.machine_code)
  return normalizeMachineStatus(await apiClient.getMachineStatus(machineCode), machineCode)
}

async function submitOrderCommand(pool, apiClient, { user, purchaseOrderId, command }) {
  const normalizedCommand = assertEnabledCommand(command)
  const ownerId = getTenantOwnerId(user)
  const order = await readAccessiblePurchaseOrder(pool, user, purchaseOrderId)
  const locator = await readRelatedSalesLocator(pool, order)
  const binding = await readBinding(pool, ownerId)
  if (!binding) throw serviceError('machine_binding_missing', '请先绑定云仓助手机器码')
  const machineCode = assertMachineCode(binding.machine_code)
  const machine = normalizeMachineStatus(await apiClient.getMachineStatus(machineCode), machineCode)
  if (!machine.online) throw serviceError('machine_offline', '绑定的云仓助手当前离线')
  if (machine.busy) throw serviceError('machine_busy', '绑定的云仓助手当前忙碌，请稍后再试')
  if (machine.capabilities[normalizedCommand] !== true) {
    throw serviceError('capability_unavailable', '绑定的云仓助手尚未启用该命令')
  }

  if (normalizedCommand === 'exception.order.resolve') {
    const [checkRows] = await pool.execute(
      `SELECT request_id, purchase_order_id, machine_code, command, order_no, order_year,
              transport_status, http_status, reason, message_redacted, response_json,
              created_at, updated_at, completed_at
         FROM cloud_external_commands
        WHERE owner_id = ? AND purchase_order_id = ? AND command = 'exception.order.check'
        ORDER BY created_at DESC LIMIT 1`,
      [ownerId, Number(order.id)]
    )
    const latestException = exceptionFromCommand(commandRowSummary(checkRows[0]))
    if (!latestException?.resultShapeValid || latestException.state !== 'exception_found' || latestException.exceptionCount <= 0) {
      throw serviceError('precondition_not_met', '请先完成异常查询并确认当前订单存在异常')
    }
  }

  const [activeRows] = await pool.execute(
    `SELECT request_id FROM cloud_external_commands
      WHERE owner_id = ? AND purchase_order_id = ? AND command = ?
        AND transport_status IN ('submitting', 'submission_unknown', 'accepted', 'pending', 'queued', 'executing')
      ORDER BY created_at DESC LIMIT 1`,
    [ownerId, Number(order.id), normalizedCommand]
  )
  if (activeRows.length) return commandRowSummary(await readCommand(pool, ownerId, activeRows[0].request_id))

  const requestId = createRequestId()
  const payload = buildCommandPayload({
    requestId,
    machineCode,
    command: normalizedCommand,
    orderNo: locator.platformOrderNo,
    orderYear: locator.orderYear
  })
  await pool.execute(
    `INSERT INTO cloud_external_commands
       (request_id, owner_id, purchase_order_id, requested_by_user_id, machine_code,
        command, order_no, order_year, transport_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitting')`,
    [requestId, ownerId, Number(order.id), Number(user.id), machineCode,
      normalizedCommand, locator.platformOrderNo, locator.orderYear]
  )
  try {
    const normalized = normalizeCommandResponse(await apiClient.submitCommand(payload), requestId, normalizedCommand)
    await persistCommandResponse(pool, ownerId, normalized)
    return commandRowSummary(await readCommand(pool, ownerId, requestId))
  } catch (error) {
    await pool.execute(
      `UPDATE cloud_external_commands
          SET transport_status = 'submission_unknown', reason = ?, message_redacted = ?, updated_at = NOW(3)
        WHERE owner_id = ? AND request_id = ?`,
      [String(error.code || 'cloud_api_error').slice(0, 100), String(error.message || '').slice(0, 500), ownerId, requestId]
    )
    error.requestId = requestId
    throw error
  }
}

async function refreshCommandResult(pool, apiClient, user, requestId) {
  const ownerId = getTenantOwnerId(user)
  const row = await readCommand(pool, ownerId, requestId)
  if (!row) throw serviceError('cloud_command_not_found', '云仓指令不存在或当前账号无权查看')
  if (!ACTIVE_STATUSES.has(String(row.transport_status || '').toLowerCase())) return commandRowSummary(row)
  const normalized = normalizeCommandResponse(await apiClient.getCommandResult(requestId), requestId, row.command)
  await persistCommandResponse(pool, ownerId, normalized)
  return commandRowSummary(await readCommand(pool, ownerId, requestId))
}

function exceptionFromCommand(command) {
  if (!command || command.command !== 'exception.order.check') return null
  const result = command.result && typeof command.result === 'object' ? command.result : {}
  const rawExceptions = Array.isArray(result.exceptions) ? result.exceptions : []
  const declaredCount = Number(result.exception_count)
  const countValid = Number.isInteger(declaredCount) && declaredCount >= 0 && declaredCount === rawExceptions.length
  const success = command.status === 'completed' && command.executionStatus === 'succeeded'
  return {
    taskId: command.requestId,
    transportStatus: command.status,
    status: command.executionStatus || command.status,
    reason: command.reason,
    message: command.message,
    resultShapeValid: success && countValid,
    exceptionCount: countValid ? declaredCount : rawExceptions.length,
    exceptionSnapshotRef: String(result.exception_snapshot_ref || '').slice(0, 200),
    state: String(result.state || '').slice(0, 50),
    queriedAt: result.queried_at || command.completedAt || null,
    exceptions: rawExceptions.map(item => ({
      source: String(item?.source || '').slice(0, 50),
      exceptionTypeMasked: String(item?.exception_type_masked || '').slice(0, 200),
      reasonMasked: String(item?.reason_masked || '').slice(0, 500),
      solutionMasked: String(item?.solution_masked || '').slice(0, 500)
    }))
  }
}

function resolutionFromCommand(command) {
  if (!command || command.command !== 'exception.order.resolve') return null
  return {
    taskId: command.requestId,
    transportStatus: command.status,
    status: command.executionStatus || command.status,
    reason: command.reason,
    message: command.message,
    observedStatus: String(command.result?.state || command.result?.observed_status || '').slice(0, 80),
    completedAt: command.completedAt || null
  }
}

async function attachExternalCommands(pool, user, purchaseOrderId, configuration) {
  const ownerId = getTenantOwnerId(user)
  const [rows] = await pool.execute(
    `SELECT request_id, purchase_order_id, machine_code, command, order_no, order_year,
            transport_status, http_status, reason, message_redacted, response_json,
            created_at, updated_at, completed_at
       FROM cloud_external_commands
      WHERE owner_id = ? AND purchase_order_id = ?
        AND command IN ('exception.order.check', 'exception.order.resolve')
      ORDER BY created_at DESC
      LIMIT 20`,
    [ownerId, Number(purchaseOrderId)]
  )
  const check = rows.find(row => row.command === 'exception.order.check')
  const resolve = rows.find(row => row.command === 'exception.order.resolve')
  const active = rows.find(row => ACTIVE_STATUSES.has(String(row.transport_status || '').toLowerCase()))
  const checkSummary = commandRowSummary(check)
  const resolveSummary = commandRowSummary(resolve)
  const exception = exceptionFromCommand(checkSummary)
  const exceptionResolution = resolutionFromCommand(resolveSummary)
  let state = ''
  if (active) state = 'executing'
  else if (exception?.status === 'succeeded' && exception?.resultShapeValid) {
    state = exception.state === 'exception_found' || exception.exceptionCount > 0
      ? 'exception_found'
      : 'exception_clear'
  } else if (checkSummary?.final) state = 'review_required'
  if (exceptionResolution?.status === 'succeeded') state = exceptionResolution.observedStatus || 'resolved'
  else if (resolveSummary?.final) state = 'review_required'

  return {
    ...configuration,
    orderRefId: '',
    exception,
    exceptionResolution,
    workflow: rows.length ? {
      workflowId: '',
      state,
      currentTask: active ? {
        taskId: active.request_id,
        command: active.command,
        transportStatus: active.transport_status,
        executionStatus: '',
        createdAt: active.created_at || null,
        expiresAt: null
      } : null,
      lastObservedStatus: exceptionResolution?.observedStatus || '',
      lastReason: resolveSummary?.reason || checkSummary?.reason || '',
      lastMessage: resolveSummary?.message || checkSummary?.message || '',
      reviewReason: state === 'review_required' ? (resolveSummary?.reason || checkSummary?.reason || 'result_unconfirmed') : '',
      createdAt: rows[rows.length - 1]?.created_at || null,
      updatedAt: rows[0]?.updated_at || null
    } : null,
    transportEnabled: true,
    transportMode: 'third_party'
  }
}

module.exports = {
  ACTIVE_STATUSES,
  ENABLED_COMMANDS,
  assertEnabledCommand,
  attachExternalCommands,
  buildCommandPayload,
  commandRowSummary,
  createRequestId,
  exceptionFromCommand,
  normalizeCommandResponse,
  normalizeMachineStatus,
  queryMachineStatus,
  refreshCommandResult,
  resolutionFromCommand,
  sanitizeExternalValue,
  submitOrderCommand
}
