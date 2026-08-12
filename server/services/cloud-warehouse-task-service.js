const {
  WRITE_COMMANDS,
  assertCommand,
  buildTaskEnvelope,
  fingerprintTaskEnvelope,
  getTenantOwnerId,
  normalizeCapabilities
} = require('./cloud-warehouse-protocol')

// 双方基础字段、服务地址和控制面认证确认前保持硬禁用，不能通过环境变量提前开启。
const EXECUTOR_TRANSPORT_ENABLED = false

function serviceError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
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

function toMysqlDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw serviceError('task_time_invalid', '任务时间无效')
  return date.toISOString().replace('T', ' ').replace('Z', '')
}

async function readLockedMachineRoute(connection, ownerId) {
  const [rows] = await connection.execute(
    `SELECT b.machine_code, b.binding_version,
            m.status, m.capabilities_json, m.printer_available,
            m.login_environment_available, m.last_heartbeat_at,
            CASE WHEN m.status = 'online'
                   AND m.last_heartbeat_at >= DATE_SUB(NOW(3), INTERVAL 90 SECOND)
                 THEN 1 ELSE 0 END AS assistant_online
       FROM cloud_machine_bindings b
       LEFT JOIN cloud_executor_machines m ON m.machine_code = b.machine_code
      WHERE b.owner_id = ?
      FOR UPDATE`,
    [ownerId]
  )
  if (!rows.length) throw serviceError('machine_binding_missing', '当前主账号体系尚未绑定云仓助手机器码')
  const row = rows[0]
  return {
    machineCode: row.machine_code,
    bindingVersion: Number(row.binding_version || 1),
    online: Number(row.assistant_online || 0) === 1,
    capabilities: normalizeCapabilities(parseJsonObject(row.capabilities_json)),
    printerAvailable: Number(row.printer_available || 0) === 1,
    loginEnvironmentAvailable: Number(row.login_environment_available || 0) === 1
  }
}

function assertRouteReady(route, command) {
  if (!route.online) throw serviceError('machine_offline', '绑定的云仓助手当前离线')
  if (route.capabilities[command] !== true) {
    throw serviceError('capability_unavailable', '绑定的云仓助手尚未启用该命令能力')
  }
  if (!route.loginEnvironmentAvailable) {
    throw serviceError('login_environment_unavailable', '云仓助手登录环境当前不可用')
  }
  if (['warehouse.order.print', 'warehouse.order.outbound'].includes(command) && !route.printerAvailable) {
    throw serviceError('printer_unavailable', '云仓助手打印机当前不可用')
  }
}

/**
 * 为已有工作流创建一条定向任务。
 *
 * 这是中央服务内部能力，不暴露给 renderer。machine_code 必须从发起人所属主账号体系的绑定表读取，
 * 调用方无法传入 target。正式执行器控制面启用前 transportEnabled 必须保持 false。
 */
async function createRoutedTaskRecord(pool, {
  user,
  workflowId,
  orderRefId,
  command,
  confirmation,
  params = {},
  scheduledPoll = false,
  scheduledFor = null,
  now = new Date()
}) {
  if (!EXECUTOR_TRANSPORT_ENABLED) {
    throw serviceError('transport_disabled', '云仓助手中央传输尚未启用')
  }
  if (!user?.id) throw serviceError('requested_by_invalid', '当前操作账号无效')
  const normalizedCommand = assertCommand(command)
  if (scheduledPoll && normalizedCommand !== 'warehouse.order.check') {
    throw serviceError('scheduled_poll_command_invalid', '30秒可恢复调度只允许创建到仓查询任务')
  }

  let connection
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()

    const [workflowRows] = await connection.execute(
      `SELECT workflow_id, order_ref_id, owner_id, state, state_version, poll_sequence,
              current_task_id, target_machine_code, binding_version, locator_version
         FROM cloud_order_workflows
        WHERE workflow_id = ? AND order_ref_id = ?
        FOR UPDATE`,
      [workflowId, orderRefId]
    )
    if (!workflowRows.length) throw serviceError('workflow_not_found', '云仓工作流不存在')
    const workflow = workflowRows[0]
    const ownerId = getTenantOwnerId(user)
    if (Number(workflow.owner_id) !== ownerId) throw serviceError('workflow_forbidden', '无权操作该云仓工作流')
    if (workflow.current_task_id) throw serviceError('workflow_task_active', '该工作流已有进行中的任务')

    const route = await readLockedMachineRoute(connection, ownerId)
    if (workflow.target_machine_code !== route.machineCode || Number(workflow.binding_version) !== route.bindingVersion) {
      throw serviceError('machine_binding_changed', '工作流创建后机器码绑定已变化，需要人工复核')
    }
    const [locatorRows] = await connection.execute(
      `SELECT po.cloud_locator_version
         FROM cloud_order_refs r
         JOIN purchase_orders po ON po.id = r.purchase_order_id
        WHERE r.order_ref_id = ? AND r.owner_id = ?`,
      [orderRefId, ownerId]
    )
    if (!locatorRows.length || Number(workflow.locator_version) !== Number(locatorRows[0].cloud_locator_version)) {
      throw serviceError('order_locator_changed', '订单定位信息已变化，需要人工复核')
    }
    assertRouteReady(route, normalizedCommand)

    const requestedBy = {
      actor_id: String(user.id),
      actor_type: 'user',
      display_name: String(user.real_name || user.username || '')
    }
    // 确认人及确认时间由当前认证会话和中央服务生成，不信任页面提交的 actor_id/action。
    const serverConfirmation = WRITE_COMMANDS.has(normalizedCommand) ? {
      confirmed: confirmation?.confirmed === true,
      actor_id: String(user.id),
      action: normalizedCommand
    } : undefined
    const envelope = buildTaskEnvelope({
      command: normalizedCommand,
      orderRefId,
      workflowId,
      requestedBy,
      machineCode: route.machineCode,
      confirmation: serverConfirmation,
      params,
      now
    })
    const pollSequence = scheduledPoll ? Number(workflow.poll_sequence || 0) + 1 : null

    await connection.execute(
      `INSERT INTO cloud_order_tasks
         (task_id, workflow_id, trace_id, order_ref_id, requested_by_user_id,
          poll_sequence, protocol_version, command, idempotency_key, payload_hash,
          requested_by_json, target_machine_code, confirmation_json, params_json,
          scheduled_for, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        envelope.task_id,
        workflowId,
        envelope.trace_id,
        orderRefId,
        Number(user.id),
        pollSequence,
        envelope.protocol_version,
        envelope.command,
        envelope.idempotency_key,
        fingerprintTaskEnvelope(envelope),
        JSON.stringify(envelope.requested_by),
        route.machineCode,
        envelope.confirmation ? JSON.stringify(envelope.confirmation) : null,
        JSON.stringify(envelope.params),
        scheduledFor ? toMysqlDate(scheduledFor) : null,
        toMysqlDate(envelope.created_at),
        toMysqlDate(envelope.expires_at)
      ]
    )

    const updateFields = ['current_task_id = ?', 'updated_at = NOW(3)']
    const updateParams = [envelope.task_id]
    if (scheduledPoll) {
      updateFields.push('poll_sequence = ?', 'next_check_at = NULL')
      updateParams.push(pollSequence)
    }
    updateParams.push(workflowId, Number(workflow.state_version))
    const [updateResult] = await connection.execute(
      `UPDATE cloud_order_workflows
          SET ${updateFields.join(', ')}, state_version = state_version + 1
        WHERE workflow_id = ? AND state_version = ?`,
      updateParams
    )
    if (updateResult.affectedRows !== 1) throw serviceError('workflow_version_conflict', '云仓工作流状态已变化')

    await connection.execute(
      `INSERT INTO cloud_task_events
         (workflow_id, task_id, event_type, actor_type, actor_id, data_redacted_json)
       VALUES (?, ?, 'task_created', 'user', ?, ?)`,
      [workflowId, envelope.task_id, String(user.id), JSON.stringify({
        command: envelope.command,
        target: envelope.target,
        poll_sequence: pollSequence
      })]
    )

    await connection.commit()
    return envelope
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
  EXECUTOR_TRANSPORT_ENABLED,
  assertRouteReady,
  createRoutedTaskRecord,
  readLockedMachineRoute,
  toMysqlDate
}
