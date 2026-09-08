const crypto = require('crypto')
const { assertMachineCode, getTenantOwnerId } = require('./cloud-warehouse-protocol')
const { normalizeOrderYear, readAccessiblePurchaseOrder, readRelatedSalesLocator } = require('./cloud-warehouse-order-service')
const { resolveOrderMachineRoute } = require('./cloud-warehouse-routing-service')
const {
  markForwardedAfterCloudOutbound,
  markPendingPrintAfterExceptionResolution
} = require('./purchase-order-status-service')

const ENABLED_COMMANDS = Object.freeze([
  'exception.order.check',
  'exception.order.resolve',
  'warehouse.order.check',
  'warehouse.order.print',
  'warehouse.order.outbound',
  'warehouse.order.reprint'
])
const ACTIVE_STATUSES = new Set(['submitting', 'submission_unknown', 'accepted', 'pending', 'queued', 'executing'])
const WRITE_RESULT_STATUSES = Object.freeze({
  'warehouse.order.print': 'printed_unshipped',
  'warehouse.order.outbound': 'shipped'
})
const SENSITIVE_KEY_PATTERN = /(authorization|api[_-]?key|cookie|token|password|secret|credential)/i
const PRINT_READY_STATUSES = new Set([
  'pending_print',
  'waiting_print',
  'ready_to_print',
  '待打印',
  '待打单'
])

function serviceError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function assertEnabledCommand(value) {
  const command = String(value || '').trim()
  if (!ENABLED_COMMANDS.includes(command)) {
    throw serviceError('command_not_allowed', '该云仓助手命令尚未在店小二启用')
  }
  return command
}

function unwrapData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : value
}

function sanitizeExternalValue(value, depth = 0) {
  if (depth > 6) return '[已省略]'
  if (Array.isArray(value)) return value.slice(0, 500).map(item => sanitizeExternalValue(item, depth + 1))
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
    businessConfirmed: execution?.delivery?.business_confirmed === true,
    verificationConfirmed: execution?.verification?.confirmed === true,
    observedStatus: String(execution?.verification?.observed_status || '').slice(0, 80),
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
            scope_order_nos, transport_status, http_status, reason, message_redacted, response_json,
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

function sanitizeProcessLogMessage(value) {
  return String(value || '')
    .replace(/((?:authorization|api[_-]?key|cookie|token|password|secret|credential)\s*[:=]\s*)\S+/ig, '$1[已脱敏]')
    .slice(0, 500)
}

function normalizeOrderScope(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))].slice(0, 1000)
}

function parseStoredOrderScope(value) {
  if (Array.isArray(value)) return normalizeOrderScope(value)
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    return normalizeOrderScope(JSON.parse(value))
  } catch {
    return []
  }
}

function isRemoteCommandMissingError(error) {
  if (error?.code !== 'cloud_api_request_failed') return false
  const httpStatus = Number(error?.httpStatus || 0)
  if (httpStatus === 404 || httpStatus === 410) return true
  let responseText = ''
  try { responseText = JSON.stringify(error?.responseBody || {}) } catch { /* ignore invalid error body */ }
  return /指令不存在|命令不存在|command[^\n]{0,40}not found|request[^\n]{0,40}not found/i.test(
    `${error?.message || ''} ${responseText}`
  )
}

async function persistTerminalCommandFailure(pool, ownerId, requestId, error) {
  const httpStatus = Number(error?.httpStatus || 0) || null
  const message = sanitizeProcessLogMessage(error?.message || '云仓助手未找到该指令，请重新操作')
  const response = sanitizeExternalValue(error?.responseBody || {})
  await pool.execute(
    `UPDATE cloud_external_commands
        SET transport_status = 'failed', http_status = ?, reason = 'remote_command_not_found',
            message_redacted = ?, response_json = ?, completed_at = NOW(3), updated_at = NOW(3)
      WHERE owner_id = ? AND request_id = ?
        AND transport_status IN ('submitting', 'submission_unknown', 'accepted', 'pending', 'queued', 'executing')`,
    [httpStatus, message, JSON.stringify(response), ownerId, requestId]
  )
}

function commandRowSummary(row) {
  if (!row) return null
  const response = parseStoredResponse(row.response_json)
  const payload = unwrapData(response)
  const execution = payload.response && typeof payload.response === 'object' ? payload.response : {}
  return {
    requestId: row.request_id,
    purchaseOrderId: row.purchase_order_id == null ? null : Number(row.purchase_order_id),
    command: row.command,
    machineCode: String(row.machine_code || ''),
    orderNo: String(row.order_no || '').trim(),
    orderYear: row.order_year == null ? null : Number(row.order_year),
    scopeOrderNos: parseStoredOrderScope(row.scope_order_nos),
    httpStatus: Number(row.http_status || 0) || null,
    status: row.transport_status || '',
    final: row.transport_status === 'completed',
    executionStatus: String(execution.status || '').slice(0, 50),
    reason: row.reason || String(execution.reason || '').slice(0, 100),
    message: row.message_redacted || String(execution.message || '').slice(0, 500),
    result: sanitizeExternalValue(execution.result || {}),
    businessConfirmed: execution?.delivery?.business_confirmed === true,
    verificationConfirmed: execution?.verification?.confirmed === true,
    observedStatus: String(execution?.verification?.observed_status || '').slice(0, 80),
    response: sanitizeExternalValue(response),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    completedAt: row.completed_at || payload.completed_at || null
  }
}

function reprintFromCommand(command) {
  if (!command || command.command !== 'warehouse.order.reprint') return null
  const printedCount = Number(command.result?.printedCount)
  const terminal = !ACTIVE_STATUSES.has(String(command.status || '').toLowerCase())
  const resultShapeValid = command.httpStatus === 200 &&
    command.status === 'completed' &&
    command.executionStatus === 'succeeded' &&
    command.businessConfirmed === true &&
    command.result?.code === 'reprinted' &&
    Number.isFinite(printedCount) && printedCount > 0
  return {
    requestId: command.requestId,
    command: command.command,
    httpStatus: command.httpStatus,
    transportStatus: command.status,
    status: command.executionStatus || command.status,
    final: command.final,
    terminal,
    succeeded: resultShapeValid,
    resultShapeValid,
    businessConfirmed: command.businessConfirmed === true,
    code: String(command.result?.code || '').slice(0, 80),
    printedCount: Number.isFinite(printedCount) ? printedCount : 0,
    reason: command.reason,
    message: command.message || (terminal && !resultShapeValid
      ? '补打回执未满足成功条件，请先查询原请求结果或人工确认'
      : ''),
    createdAt: command.createdAt || null,
    updatedAt: command.updatedAt || null,
    completedAt: command.completedAt || null
  }
}

function writeResultFromCommand(command) {
  const expectedStatus = WRITE_RESULT_STATUSES[command?.command]
  if (!command || !expectedStatus) return null
  const terminal = !ACTIVE_STATUSES.has(String(command.status || '').toLowerCase())
  const resultShapeValid = command.httpStatus === 200 &&
    command.status === 'completed' &&
    command.executionStatus === 'succeeded' &&
    command.businessConfirmed === true &&
    command.verificationConfirmed === true &&
    command.observedStatus === expectedStatus
  const actionLabel = command.command === 'warehouse.order.print' ? '打印' : '发货'
  return {
    requestId: command.requestId,
    command: command.command,
    httpStatus: command.httpStatus,
    transportStatus: command.status,
    status: command.executionStatus || command.status,
    final: command.final,
    terminal,
    succeeded: resultShapeValid,
    resultShapeValid,
    businessConfirmed: command.businessConfirmed === true,
    verificationConfirmed: command.verificationConfirmed === true,
    observedStatus: command.observedStatus,
    expectedStatus,
    reason: command.reason,
    message: command.message || (terminal && !resultShapeValid
      ? `${actionLabel}回执未满足成功条件，请先查询原请求结果或人工确认`
      : ''),
    createdAt: command.createdAt || null,
    updatedAt: command.updatedAt || null,
    completedAt: command.completedAt || null
  }
}

function commandProcessLog(row) {
  const command = commandRowSummary(row)
  if (!command) return null
  const active = ACTIVE_STATUSES.has(String(command.status || '').toLowerCase())
  const writeResult = writeResultFromCommand(command)
  const succeeded = command.command === 'warehouse.order.reprint'
    ? reprintFromCommand(command)?.succeeded === true
    : (writeResult ? writeResult.succeeded === true : command.final && command.executionStatus === 'succeeded')
  const normalizedWriteResult = command.command === 'warehouse.order.reprint'
    ? reprintFromCommand(command)
    : writeResult
  const action = command.command === 'exception.order.resolve'
    ? 'exception_resolve'
    : (command.command === 'warehouse.order.check'
        ? 'warehouse_check'
        : (command.command === 'warehouse.order.reprint'
        ? 'warehouse_reprint'
        : (command.command === 'warehouse.order.print'
            ? 'warehouse_print'
            : (command.command === 'warehouse.order.outbound' ? 'warehouse_outbound' : 'exception_check'))))
  return {
    id: `command:${command.requestId}`,
    action,
    status: active ? 'processing' : (succeeded ? 'succeeded' : 'failed'),
    reason: command.reason || '',
    message: command.message || normalizedWriteResult?.message ||
      (active ? '已提交，等待云仓助手返回结果' : '云仓助手未返回明确结果'),
    occurredAt: command.updatedAt || command.createdAt || null
  }
}

function localProcessLog(row) {
  return {
    id: `local:${row.id}`,
    action: row.action,
    status: row.status,
    reason: '',
    message: row.message_redacted || '',
    occurredAt: row.created_at || null
  }
}

function sortProcessLogs(logs) {
  return logs.filter(Boolean).sort((left, right) => {
    const leftTime = new Date(left.occurredAt || 0).getTime()
    const rightTime = new Date(right.occurredAt || 0).getTime()
    return leftTime - rightTime
  })
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

async function applyConfirmedExceptionResolutionStatus(pool, ownerId, purchaseOrderId, command) {
  if (command?.command !== 'exception.order.resolve' ||
      command.status !== 'completed' || command.executionStatus !== 'succeeded') {
    return false
  }
  try {
    return await markPendingPrintAfterExceptionResolution(pool, { ownerId, purchaseOrderId })
  } catch (error) {
    // 云仓权威回执已经成功时不能因本地状态投影失败把指令误写回“提交未知”；
    // 配置读取会继续幂等补偿该状态。
    console.error('[CloudWarehouse] 异常处理成功后更新待打印状态失败:', error.message)
    return false
  }
}

async function applyConfirmedOrderCommandStatus(pool, ownerId, purchaseOrderId, command) {
  if (command?.command === 'exception.order.resolve') {
    return applyConfirmedExceptionResolutionStatus(pool, ownerId, purchaseOrderId, command)
  }
  const writeResult = writeResultFromCommand(command)
  if (command?.command !== 'warehouse.order.outbound' || writeResult?.succeeded !== true) return false
  try {
    return await markForwardedAfterCloudOutbound(pool, { ownerId, purchaseOrderId })
  } catch (error) {
    console.error('[CloudWarehouse] 云仓发货成功后更新已转发状态失败:', error.message)
    return false
  }
}

function buildWarehouseOrderCheckPayload({ requestId, machineCode }) {
  return {
    request_id: String(requestId),
    machine_code: assertMachineCode(machineCode),
    command: assertEnabledCommand('warehouse.order.check')
  }
}

async function queryMachineStatus(pool, apiClient, user) {
  const ownerId = getTenantOwnerId(user)
  const binding = await readBinding(pool, ownerId)
  if (!binding) throw serviceError('machine_binding_missing', '请先绑定云仓助手机器码')
  const machineCode = assertMachineCode(binding.machine_code)
  return normalizeMachineStatus(await apiClient.getMachineStatus(machineCode), machineCode)
}

function normalizeWarehouseOrderStatus(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizeWarehouseOrderItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const orderNo = String(
    item.order_no || item.orderNo || item.sales_order_no || item.salesOrderNo || ''
  ).trim()
  if (!orderNo || orderNo.length > 100) return null
  const status = String(
    item.status || item.order_status || item.orderStatus || item.state || item.observed_status || ''
  ).trim()
  const normalizedStatus = normalizeWarehouseOrderStatus(status)
  const explicitlyPrintable = typeof item.printable === 'boolean' ? item.printable : null
  return {
    orderNo,
    status: status.slice(0, 80),
    logisticsNo: String(
      item.logistics_no || item.logisticsNo || item.tracking_no || item.trackingNo ||
      item.waybill_no || item.waybillNo || ''
    ).trim().slice(0, 100),
    logisticsCompany: String(
      item.logistics_company || item.logisticsCompany || item.carrier || ''
    ).trim().slice(0, 100),
    printable: explicitlyPrintable === null
      ? PRINT_READY_STATUSES.has(normalizedStatus)
      : explicitlyPrintable
  }
}

function warehouseOrdersFromCommand(command) {
  if (!command || command.command !== 'warehouse.order.check') return null
  const result = command.result && typeof command.result === 'object' ? command.result : {}
  const legacyOrders = Array.isArray(result.orders)
    ? result.orders
    : (Array.isArray(result.order_list) ? result.order_list : null)
  const singleOrderResult = typeof result.exists === 'boolean' && String(command.orderNo || '').trim()
    ? [{
        order_no: command.orderNo,
        status: result.state || '',
        waybill_no: result.waybill_no || '',
        printable: result.exists === true
      }]
    : null
  const rawOrders = legacyOrders || singleOrderResult
  const success = command.status === 'completed' && command.executionStatus === 'succeeded'
  const scope = normalizeOrderScope(command.scopeOrderNos)
  const allowed = scope.length ? new Set(scope) : null
  const returnedOrders = (rawOrders || [])
    .map(normalizeWarehouseOrderItem)
    .filter(order => order && (!allowed || allowed.has(order.orderNo)))
  const returnedOrderMap = new Map(returnedOrders.map(order => [order.orderNo, order]))
  const orders = success && Array.isArray(rawOrders) && scope.length
    ? scope.map(orderNo => returnedOrderMap.get(orderNo) || {
        orderNo,
        status: 'waiting_arrival',
        logisticsNo: '',
        logisticsCompany: '',
        printable: false
      })
    : returnedOrders
  return {
    requestId: command.requestId,
    machineCode: command.machineCode || '',
    transportStatus: command.status,
    status: command.executionStatus || command.status,
    final: command.final === true,
    reason: command.reason,
    message: command.message,
    resultShapeValid: success && Array.isArray(rawOrders),
    queriedAt: result.queried_at || command.completedAt || null,
    orders
  }
}

async function readSingleQueryMachineCode(pool, ownerId) {
  // 旧客户端仍会发送空请求体；升级期间优先沿用其单机器绑定。
  const legacy = await readBinding(pool, ownerId)
  if (legacy) return assertMachineCode(legacy.machine_code)

  const [rows] = await pool.execute(
    `SELECT DISTINCT machine_code
       FROM cloud_warehouse_machine_bindings
      WHERE owner_id = ?
      ORDER BY machine_code
      LIMIT 2`,
    [ownerId]
  )
  if (rows.length === 1) return assertMachineCode(rows[0].machine_code)
  if (rows.length > 1) {
    throw serviceError('machine_selection_required', '当前账号配置了多个云仓助手，请按订单所属店铺查询')
  }
  throw serviceError('machine_binding_missing', '请先在仓库设置中绑定云仓助手机器码')
}

async function submitWarehouseOrderCheck(pool, apiClient, {
  user,
  machineCode: requestedMachineCode = '',
  scopeOrderNos = []
}) {
  const command = assertEnabledCommand('warehouse.order.check')
  const ownerId = getTenantOwnerId(user)
  const machineCode = requestedMachineCode
    ? assertMachineCode(requestedMachineCode)
    : await readSingleQueryMachineCode(pool, ownerId)
  const normalizedScopeOrderNos = normalizeOrderScope(scopeOrderNos)
  if (!normalizedScopeOrderNos.length) {
    throw serviceError('invalid_request', '没有可用于匹配云仓结果的销售订单号')
  }

  const [activeRows] = await pool.execute(
    `SELECT request_id, scope_order_nos FROM cloud_external_commands
      WHERE owner_id = ? AND command = 'warehouse.order.check'
        AND machine_code = ? AND requested_by_user_id = ?
        AND purchase_order_id IS NULL
        AND transport_status IN ('submitting', 'submission_unknown', 'accepted', 'pending', 'queued', 'executing')
      ORDER BY created_at DESC LIMIT 1`,
    [ownerId, machineCode, Number(user.id)]
  )
  if (activeRows.length) {
    const mergedScope = normalizeOrderScope([
      ...parseStoredOrderScope(activeRows[0].scope_order_nos),
      ...normalizedScopeOrderNos
    ])
    await pool.execute(
      'UPDATE cloud_external_commands SET scope_order_nos = ?, updated_at = NOW(3) WHERE owner_id = ? AND request_id = ?',
      [JSON.stringify(mergedScope), ownerId, activeRows[0].request_id]
    )
    return warehouseOrdersFromCommand(await refreshCommandResult(
      pool,
      apiClient,
      user,
      activeRows[0].request_id
    ))
  }

  const machine = normalizeMachineStatus(await apiClient.getMachineStatus(machineCode), machineCode)
  if (!machine.online) throw serviceError('machine_offline', '绑定的云仓助手当前离线')
  if (machine.busy) throw serviceError('machine_busy', '绑定的云仓助手当前忙碌，请稍后再试')
  if (machine.capabilities[command] !== true) {
    throw serviceError('capability_unavailable', '绑定的云仓助手尚未启用云仓订单查询')
  }

  const requestId = createRequestId()
  const payload = buildWarehouseOrderCheckPayload({
    requestId,
    machineCode
  })
  await pool.execute(
    `INSERT INTO cloud_external_commands
       (request_id, owner_id, purchase_order_id, requested_by_user_id, machine_code,
        command, order_no, order_year, scope_order_nos, transport_status)
     VALUES (?, ?, NULL, ?, ?, 'warehouse.order.check', '', NULL, ?, 'submitting')`,
    [requestId, ownerId, Number(user.id), machineCode, JSON.stringify(normalizedScopeOrderNos)]
  )
  try {
    const normalized = normalizeCommandResponse(await apiClient.submitCommand(payload), requestId, command)
    await persistCommandResponse(pool, ownerId, normalized)
    return warehouseOrdersFromCommand(commandRowSummary(await readCommand(pool, ownerId, requestId)))
  } catch (error) {
    if (isRemoteCommandMissingError(error)) {
      await persistTerminalCommandFailure(pool, ownerId, requestId, error)
    } else {
      await pool.execute(
        `UPDATE cloud_external_commands
            SET transport_status = 'submission_unknown', reason = ?, message_redacted = ?, updated_at = NOW(3)
          WHERE owner_id = ? AND request_id = ?`,
        [String(error.code || 'cloud_api_error').slice(0, 100), String(error.message || '').slice(0, 500), ownerId, requestId]
      )
    }
    error.requestId = requestId
    throw error
  }
}

function combineWarehouseOrderChecks(checks, issues = []) {
  const validChecks = (checks || []).filter(Boolean)
  const orderMap = new Map()
  for (const check of validChecks) {
    for (const order of check.orders || []) {
      const previous = orderMap.get(order.orderNo)
      orderMap.set(order.orderNo, previous?.printable ? previous : order)
    }
  }
  return {
    batch: true,
    checks: validChecks,
    issues,
    final: validChecks.length > 0 && validChecks.every(check => check.final === true),
    resultShapeValid: validChecks.length > 0 &&
      validChecks.every(check => check.resultShapeValid === true),
    orders: [...orderMap.values()]
  }
}

function scopeWarehouseOrderChecks(checks, allowedOrderNos) {
  const allowed = allowedOrderNos instanceof Set
    ? allowedOrderNos
    : new Set((allowedOrderNos || []).map(value => String(value || '').trim()).filter(Boolean))
  return (checks || []).filter(Boolean).map(check => ({
    ...check,
    orders: (check.orders || []).filter(order => allowed.has(String(order?.orderNo || '').trim()))
  }))
}

async function submitWarehouseOrderChecksForOrders(pool, apiClient, { user, purchaseOrderIds }) {
  const ids = [...new Set((purchaseOrderIds || []).map(Number).filter(id => Number.isInteger(id) && id > 0))]
  if (!ids.length || ids.length > 100) {
    throw serviceError('invalid_request', '请提供 1 至 100 个当前页采购订单标识')
  }
  const ownerId = getTenantOwnerId(user)
  const machineGroups = new Map()
  const issues = []
  for (const purchaseOrderId of ids) {
    try {
      const order = await readAccessiblePurchaseOrder(pool, user, purchaseOrderId)
      const locator = await readRelatedSalesLocator(pool, order)
      const route = await resolveOrderMachineRoute(pool, {
        ownerId,
        purchaseOrderId: order.id,
        storeId: locator.storeId
      })
      const orderNo = String(locator.platformOrderNo || '').trim()
      const group = machineGroups.get(route.machineCode) || {
        machineCode: route.machineCode,
        purchaseOrderIds: [],
        orderNos: []
      }
      group.purchaseOrderIds.push(Number(order.id))
      group.orderNos.push(orderNo)
      machineGroups.set(route.machineCode, group)
    } catch (error) {
      issues.push({
        purchaseOrderId,
        reason: String(error?.code || 'machine_route_unavailable').slice(0, 100),
        message: String(error?.message || '未能确定订单对应的云仓助手').slice(0, 300)
      })
    }
  }

  const checks = []
  for (const group of machineGroups.values()) {
    try {
      checks.push(await submitWarehouseOrderCheck(pool, apiClient, {
        user,
        machineCode: group.machineCode,
        scopeOrderNos: group.orderNos
      }))
    } catch (error) {
      for (const purchaseOrderId of group.purchaseOrderIds) {
        issues.push({
          purchaseOrderId,
          reason: String(error?.code || 'cloud_query_failed').slice(0, 100),
          message: String(error?.message || '云仓订单查询失败').slice(0, 300)
        })
      }
    }
  }
  return combineWarehouseOrderChecks(checks, issues)
}

async function refreshWarehouseOrderCheck(pool, apiClient, user, requestId) {
  const command = await refreshCommandResult(pool, apiClient, user, requestId)
  if (command?.command !== 'warehouse.order.check') {
    throw serviceError('cloud_command_mismatch', '该 requestId 不是云仓订单查询指令')
  }
  return warehouseOrdersFromCommand(command)
}

async function recordAutomaticRemarkLog(pool, user, purchaseOrderId, result) {
  const ownerId = getTenantOwnerId(user)
  const order = await readAccessiblePurchaseOrder(pool, user, purchaseOrderId)
  const status = result?.success === true ? 'succeeded' : 'failed'
  const message = sanitizeProcessLogMessage(result?.message || (
    status === 'succeeded' ? '采购编号已自动备注到京东订单' : '京东自动备注未成功'
  ))
  const [insertResult] = await pool.execute(
    `INSERT INTO cloud_order_process_logs
       (owner_id, purchase_order_id, actor_user_id, action, status, message_redacted)
     VALUES (?, ?, ?, 'auto_remark', ?, ?)`,
    [ownerId, Number(order.id), Number(user.id), status, message]
  )
  return {
    id: `local:${insertResult.insertId}`,
    action: 'auto_remark',
    status,
    reason: '',
    message,
    occurredAt: new Date().toISOString()
  }
}

async function submitOrderCommand(pool, apiClient, { user, purchaseOrderId, command }) {
  const normalizedCommand = assertEnabledCommand(command)
  const ownerId = getTenantOwnerId(user)
  const order = await readAccessiblePurchaseOrder(pool, user, purchaseOrderId)
  const [activeRows] = await pool.execute(
    `SELECT request_id FROM cloud_external_commands
      WHERE owner_id = ? AND purchase_order_id = ? AND command = ?
        AND transport_status IN ('submitting', 'submission_unknown', 'accepted', 'pending', 'queued', 'executing')
      ORDER BY created_at DESC LIMIT 1`,
    [ownerId, Number(order.id), normalizedCommand]
  )
  if (activeRows.length) return commandRowSummary(await readCommand(pool, ownerId, activeRows[0].request_id))

  const locator = await readRelatedSalesLocator(pool, order)
  const binding = await resolveOrderMachineRoute(pool, {
    ownerId,
    purchaseOrderId: order.id,
    storeId: locator.storeId
  })
  const machineCode = assertMachineCode(binding.machineCode)
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
    const commandSummary = commandRowSummary(await readCommand(pool, ownerId, requestId))
    await applyConfirmedOrderCommandStatus(pool, ownerId, order.id, commandSummary)
    return commandSummary
  } catch (error) {
    if (isRemoteCommandMissingError(error)) {
      await persistTerminalCommandFailure(pool, ownerId, requestId, error)
    } else {
      await pool.execute(
        `UPDATE cloud_external_commands
            SET transport_status = 'submission_unknown', reason = ?, message_redacted = ?, updated_at = NOW(3)
          WHERE owner_id = ? AND request_id = ?`,
        [String(error.code || 'cloud_api_error').slice(0, 100), String(error.message || '').slice(0, 500), ownerId, requestId]
      )
    }
    error.requestId = requestId
    throw error
  }
}

async function submitOrderReprint(pool, apiClient, { user, purchaseOrderId }) {
  return reprintFromCommand(await submitOrderCommand(pool, apiClient, {
    user,
    purchaseOrderId,
    command: 'warehouse.order.reprint'
  }))
}

async function submitOrderPrint(pool, apiClient, { user, purchaseOrderId }) {
  return writeResultFromCommand(await submitOrderCommand(pool, apiClient, {
    user,
    purchaseOrderId,
    command: 'warehouse.order.print'
  }))
}

async function submitOrderOutbound(pool, apiClient, { user, purchaseOrderId }) {
  return writeResultFromCommand(await submitOrderCommand(pool, apiClient, {
    user,
    purchaseOrderId,
    command: 'warehouse.order.outbound'
  }))
}

async function refreshCommandResult(pool, apiClient, user, requestId) {
  const ownerId = getTenantOwnerId(user)
  const row = await readCommand(pool, ownerId, requestId)
  if (!row) throw serviceError('cloud_command_not_found', '云仓指令不存在或当前账号无权查看')
  if (!ACTIVE_STATUSES.has(String(row.transport_status || '').toLowerCase())) {
    const commandSummary = commandRowSummary(row)
    await applyConfirmedOrderCommandStatus(pool, ownerId, row.purchase_order_id, commandSummary)
    return commandSummary
  }
  try {
    const normalized = normalizeCommandResponse(await apiClient.getCommandResult(requestId), requestId, row.command)
    await persistCommandResponse(pool, ownerId, normalized)
  } catch (error) {
    if (!isRemoteCommandMissingError(error)) throw error
    await persistTerminalCommandFailure(pool, ownerId, requestId, error)
  }
  const commandSummary = commandRowSummary(await readCommand(pool, ownerId, requestId))
  await applyConfirmedOrderCommandStatus(pool, ownerId, row.purchase_order_id, commandSummary)
  return commandSummary
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
    resultRecordedAt: command.updatedAt || command.completedAt || null,
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
    completedAt: command.completedAt || null,
    resultRecordedAt: command.updatedAt || command.completedAt || null
  }
}

async function attachExternalCommands(pool, user, purchaseOrderId, configuration) {
  const ownerId = getTenantOwnerId(user)
  const platformOrderNo = String(configuration?.platformOrderNo || '').trim()
  const [rows] = await pool.execute(
    `SELECT request_id, purchase_order_id, machine_code, command, order_no, order_year,
            scope_order_nos, transport_status, http_status, reason, message_redacted, response_json,
            created_at, updated_at, completed_at
       FROM cloud_external_commands
      WHERE owner_id = ? AND (
        purchase_order_id = ? OR (
          purchase_order_id IS NULL AND command = 'warehouse.order.check'
          AND scope_order_nos IS NOT NULL
          AND JSON_CONTAINS(scope_order_nos, JSON_QUOTE(?))
        )
      )
        AND command IN ('exception.order.check', 'exception.order.resolve', 'warehouse.order.check', 'warehouse.order.print', 'warehouse.order.outbound', 'warehouse.order.reprint')
      ORDER BY created_at DESC
      LIMIT 20`,
    [ownerId, Number(purchaseOrderId), platformOrderNo]
  )
  const [localLogRows] = await pool.execute(
    `SELECT id, action, status, message_redacted, created_at
       FROM cloud_order_process_logs
      WHERE owner_id = ? AND purchase_order_id = ?
      ORDER BY created_at DESC
      LIMIT 20`,
    [ownerId, Number(purchaseOrderId)]
  )
  const check = rows.find(row => row.command === 'exception.order.check')
  const resolve = rows.find(row => row.command === 'exception.order.resolve')
  const warehouseCheckCommand = rows.find(row => row.command === 'warehouse.order.check')
  const print = rows.find(row => row.command === 'warehouse.order.print')
  const outbound = rows.find(row => row.command === 'warehouse.order.outbound')
  const reprint = rows.find(row => row.command === 'warehouse.order.reprint')
  const active = rows.find(row => ACTIVE_STATUSES.has(String(row.transport_status || '').toLowerCase()))
  const checkSummary = commandRowSummary(check)
  const resolveSummary = commandRowSummary(resolve)
  const printSummary = writeResultFromCommand(commandRowSummary(print))
  const outboundSummary = writeResultFromCommand(commandRowSummary(outbound))
  const reprintSummary = reprintFromCommand(commandRowSummary(reprint))
  await applyConfirmedOrderCommandStatus(pool, ownerId, purchaseOrderId, resolveSummary)
  await applyConfirmedOrderCommandStatus(pool, ownerId, purchaseOrderId, commandRowSummary(outbound))
  const exception = exceptionFromCommand(checkSummary)
  const exceptionResolution = resolutionFromCommand(resolveSummary)
  const warehouseCheck = warehouseOrdersFromCommand(commandRowSummary(warehouseCheckCommand))
  const warehouseOrder = warehouseCheck?.orders?.find(order => (
    String(order?.orderNo || '').trim() === String(configuration?.platformOrderNo || '').trim()
  )) || null
  const checkIsLatest = !!check && (!resolve || rows.indexOf(check) < rows.indexOf(resolve))
  const latestCommand = commandRowSummary(rows[0])
  const latestReprintResult = reprintFromCommand(latestCommand)
  const latestWriteResult = writeResultFromCommand(latestCommand)
  const latestSuccessfulWrite = rows
    .map(row => writeResultFromCommand(commandRowSummary(row)))
    .find(result => result?.succeeded === true)
  const reviewSummary = latestReprintResult?.terminal && !latestReprintResult.succeeded
    ? latestReprintResult
    : (latestWriteResult?.terminal && !latestWriteResult.succeeded ? latestWriteResult : null)
  let state = ''
  if (active) state = 'executing'
  else if (reviewSummary) state = 'review_required'
  else if (latestWriteResult?.succeeded) state = latestWriteResult.observedStatus
  else if (!checkIsLatest && exceptionResolution?.status === 'succeeded') {
    state = exceptionResolution.observedStatus || 'resolved'
  } else if (!checkIsLatest && resolveSummary?.final) {
    state = 'review_required'
  } else if (exception?.status === 'succeeded' && exception?.resultShapeValid) {
    state = exception.state === 'exception_found' || exception.exceptionCount > 0
      ? 'exception_found'
      : 'exception_clear'
  } else if (checkSummary?.final) state = 'review_required'

  return {
    ...configuration,
    orderRefId: '',
    exception,
    exceptionResolution,
    warehouseCheck,
    wmsOrderEntered: warehouseCheck?.resultShapeValid === true && warehouseOrder?.printable === true,
    print: printSummary,
    outbound: outboundSummary,
    reprint: reprintSummary,
    processLogs: sortProcessLogs([
      ...rows.map(commandProcessLog),
      ...localLogRows.map(localProcessLog)
    ]),
    workflow: (active || check || resolve || print || outbound || state === 'review_required') ? {
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
      lastObservedStatus: latestSuccessfulWrite?.observedStatus || exceptionResolution?.observedStatus || '',
      lastReason: (state === 'review_required' ? (reviewSummary?.reason || 'result_unconfirmed') : '') ||
        resolveSummary?.reason || checkSummary?.reason || '',
      lastMessage: (state === 'review_required' ? reviewSummary?.message : '') ||
        resolveSummary?.message || checkSummary?.message || '',
      reviewReason: state === 'review_required'
        ? (reviewSummary?.reason || resolveSummary?.reason || checkSummary?.reason || 'result_unconfirmed')
        : '',
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
  WRITE_RESULT_STATUSES,
  applyConfirmedOrderCommandStatus,
  applyConfirmedExceptionResolutionStatus,
  assertEnabledCommand,
  attachExternalCommands,
  buildCommandPayload,
  buildWarehouseOrderCheckPayload,
  combineWarehouseOrderChecks,
  scopeWarehouseOrderChecks,
  commandRowSummary,
  commandProcessLog,
  createRequestId,
  exceptionFromCommand,
  isRemoteCommandMissingError,
  normalizeCommandResponse,
  normalizeMachineStatus,
  queryMachineStatus,
  recordAutomaticRemarkLog,
  refreshCommandResult,
  refreshWarehouseOrderCheck,
  reprintFromCommand,
  resolutionFromCommand,
  sanitizeExternalValue,
  submitOrderCommand,
  submitOrderOutbound,
  submitOrderPrint,
  submitOrderReprint,
  submitWarehouseOrderCheck,
  submitWarehouseOrderChecksForOrders,
  warehouseOrdersFromCommand,
  writeResultFromCommand
}
