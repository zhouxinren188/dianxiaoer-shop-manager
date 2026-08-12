const crypto = require('crypto')

const PROTOCOL_VERSION = '1.0'
const MACHINE_CODE_PATTERN = /^YC-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/

const COMMANDS = Object.freeze([
  'exception.order.check',
  'exception.order.resolve',
  'warehouse.order.check',
  'warehouse.order.print',
  'warehouse.order.outbound'
])

const READ_COMMANDS = new Set([
  'exception.order.check',
  'warehouse.order.check'
])

const WRITE_COMMANDS = new Set([
  'exception.order.resolve',
  'warehouse.order.print',
  'warehouse.order.outbound'
])

const EXECUTION_STATUSES = Object.freeze([
  'refused',
  'executing',
  'succeeded',
  'failed',
  'review_required'
])

const WRITE_SUCCESS_STATUSES = Object.freeze({
  'exception.order.resolve': 'waiting_arrival',
  'warehouse.order.print': 'printed_unshipped',
  'warehouse.order.outbound': 'shipped'
})

const READ_TTL_MS = 10 * 60 * 1000
const WRITE_TTL_MS = 2 * 60 * 1000

function normalizeMachineCode(value) {
  return String(value || '').trim().toUpperCase()
}

function isValidMachineCode(value) {
  return MACHINE_CODE_PATTERN.test(normalizeMachineCode(value))
}

function assertMachineCode(value) {
  const machineCode = normalizeMachineCode(value)
  if (!MACHINE_CODE_PATTERN.test(machineCode)) {
    const error = new Error('机器码格式无效，请输入云仓助手生成的 YC-XXXX-XXXX')
    error.code = 'machine_code_invalid'
    throw error
  }
  return machineCode
}

function getTenantOwnerId(user) {
  const ownerId = user?.user_type === 'master' ? Number(user.id) : Number(user?.parent_id)
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    const error = new Error('无法确定当前登录账号所属的主账号体系')
    error.code = 'tenant_owner_invalid'
    throw error
  }
  return ownerId
}

function canManageMachineBinding(user) {
  return user?.user_type === 'master' || user?.role === 'admin'
}

function assertCommand(command) {
  const normalized = String(command || '').trim()
  if (!COMMANDS.includes(normalized)) {
    const error = new Error('命令不在云仓助手固定命令白名单中')
    error.code = 'command_not_allowed'
    throw error
  }
  return normalized
}

function createOpaqueId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`
}

function createOrderRefId() {
  return createOpaqueId('ord')
}

function createWorkflowId() {
  return createOpaqueId('wf')
}

function normalizeRequestedBy(requestedBy) {
  const actorId = String(requestedBy?.actor_id || '').trim()
  if (!actorId) {
    const error = new Error('requested_by.actor_id 不能为空')
    error.code = 'requested_by_invalid'
    throw error
  }
  return {
    actor_id: actorId,
    actor_type: 'user',
    display_name: String(requestedBy?.display_name || '').trim().slice(0, 100)
  }
}

function normalizeConfirmation(command, confirmation, createdAt) {
  if (!WRITE_COMMANDS.has(command)) return undefined
  if (confirmation?.confirmed !== true || confirmation?.action !== command) {
    const error = new Error('写命令需要与 command 完全一致的人工确认')
    error.code = 'confirmation_required'
    throw error
  }
  const actorId = String(confirmation.actor_id || '').trim()
  if (!actorId) {
    const error = new Error('confirmation.actor_id 不能为空')
    error.code = 'confirmation_required'
    throw error
  }
  return {
    confirmed: true,
    confirmed_at: confirmation.confirmed_at || createdAt,
    actor_id: actorId,
    action: command
  }
}

function buildTaskEnvelope({
  command,
  orderRefId,
  workflowId,
  requestedBy,
  machineCode,
  confirmation,
  now = new Date(),
  taskId = createOpaqueId('task'),
  idempotencyKey = createOpaqueId('idem')
}) {
  const normalizedCommand = assertCommand(command)
  const normalizedOrderRefId = String(orderRefId || '').trim()
  const normalizedWorkflowId = String(workflowId || '').trim()
  if (!normalizedOrderRefId || !normalizedWorkflowId) {
    const error = new Error('order_ref_id 和 workflow_id 不能为空')
    error.code = 'workflow_reference_invalid'
    throw error
  }

  const createdAt = new Date(now)
  if (Number.isNaN(createdAt.getTime())) {
    const error = new Error('任务创建时间无效')
    error.code = 'task_time_invalid'
    throw error
  }
  const ttlMs = WRITE_COMMANDS.has(normalizedCommand) ? WRITE_TTL_MS : READ_TTL_MS
  const createdAtIso = createdAt.toISOString()
  const envelope = {
    protocol_version: PROTOCOL_VERSION,
    task_id: String(taskId),
    trace_id: normalizedWorkflowId,
    command: normalizedCommand,
    order_id: normalizedOrderRefId,
    idempotency_key: String(idempotencyKey),
    created_at: createdAtIso,
    expires_at: new Date(createdAt.getTime() + ttlMs).toISOString(),
    requested_by: normalizeRequestedBy(requestedBy),
    target: {
      machine_code: assertMachineCode(machineCode)
    },
    params: {}
  }

  const normalizedConfirmation = normalizeConfirmation(normalizedCommand, confirmation, createdAtIso)
  if (normalizedConfirmation) envelope.confirmation = normalizedConfirmation
  return envelope
}

function fingerprintTaskEnvelope(envelope) {
  return crypto.createHash('sha256').update(JSON.stringify(envelope)).digest('hex')
}

function normalizeCapabilities(capabilities) {
  const normalized = {}
  for (const command of COMMANDS) normalized[command] = capabilities?.[command] === true
  return normalized
}

function validateSuccessfulWriteResponse(response) {
  const command = assertCommand(response?.command)
  if (!WRITE_COMMANDS.has(command)) return { valid: true }
  const expectedStatus = WRITE_SUCCESS_STATUSES[command]
  const valid = response?.status === 'succeeded' &&
    response?.delivery?.business_confirmed === true &&
    response?.verification?.confirmed === true &&
    response?.verification?.observed_status === expectedStatus
  return {
    valid,
    expectedStatus,
    reason: valid ? 'business_state_confirmed' : 'business_state_unconfirmed'
  }
}

module.exports = {
  COMMANDS,
  EXECUTION_STATUSES,
  MACHINE_CODE_PATTERN,
  PROTOCOL_VERSION,
  READ_COMMANDS,
  READ_TTL_MS,
  WRITE_COMMANDS,
  WRITE_SUCCESS_STATUSES,
  WRITE_TTL_MS,
  assertCommand,
  assertMachineCode,
  buildTaskEnvelope,
  canManageMachineBinding,
  createOpaqueId,
  createOrderRefId,
  createWorkflowId,
  fingerprintTaskEnvelope,
  getTenantOwnerId,
  isValidMachineCode,
  normalizeCapabilities,
  normalizeMachineCode,
  validateSuccessfulWriteResponse
}
