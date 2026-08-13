const {
  WRITE_COMMANDS,
  assertCommand,
  buildTaskEnvelope,
  createWorkflowId,
  fingerprintTaskEnvelope,
  getTenantOwnerId,
  normalizeCapabilities
} = require('./cloud-warehouse-protocol')
const {
  assertOrderLocatorReady,
  prepareOrderRef
} = require('./cloud-warehouse-order-service')

const ENABLED_TASK_COMMANDS = new Set([
  'exception.order.check',
  'exception.order.resolve'
])
const EXECUTOR_TRANSPORT_ENABLED = true

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
  const pad = number => String(number).padStart(2, '0')
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${milliseconds}`
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
  if (!ENABLED_TASK_COMMANDS.has(command)) {
    throw serviceError('capability_unavailable', '该命令尚未在中央服务启用')
  }
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
 * 调用方无法传入 target。第一轮只允许创建异常查询和异常处理任务。
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
  now = new Date(),
  connection: providedConnection = null
}) {
  if (!EXECUTOR_TRANSPORT_ENABLED) {
    throw serviceError('transport_disabled', '云仓助手中央传输尚未启用')
  }
  if (!user?.id) throw serviceError('requested_by_invalid', '当前操作账号无效')
  const normalizedCommand = assertCommand(command)
  if (scheduledPoll && normalizedCommand !== 'warehouse.order.check') {
    throw serviceError('scheduled_poll_command_invalid', '30秒可恢复调度只允许创建到仓查询任务')
  }

  const ownsTransaction = !providedConnection
  let connection = providedConnection
  try {
    if (ownsTransaction) {
      connection = await pool.getConnection()
      await connection.beginTransaction()
    }

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
      `SELECT po.cloud_locator_version, so.order_id AS platform_order_no,
              YEAR(so.order_time) AS order_year
         FROM cloud_order_refs r
         JOIN purchase_orders po ON po.id = r.purchase_order_id
         JOIN sales_orders so ON (
                (COALESCE(po.sales_order_id, 0) > 0 AND so.id = po.sales_order_id)
             OR (COALESCE(po.sales_order_id, 0) = 0 AND so.order_id = po.sales_order_no)
         )
         JOIN stores s ON s.id = so.store_id AND s.owner_id = po.owner_id
        WHERE r.order_ref_id = ? AND r.owner_id = ?`,
      [orderRefId, ownerId]
    )
    if (locatorRows.length !== 1 || Number(workflow.locator_version) !== Number(locatorRows[0].cloud_locator_version)) {
      throw serviceError('order_locator_changed', '订单定位信息已变化，需要人工复核')
    }
    assertOrderLocatorReady(locatorRows[0])
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

    if (ownsTransaction) await connection.commit()
    return envelope
  } catch (error) {
    if (connection && ownsTransaction) {
      try { await connection.rollback() } catch { /* ignore rollback failure */ }
    }
    throw error
  } finally {
    if (connection && ownsTransaction) connection.release()
  }
}

async function createExceptionWorkflow(pool, {
  user,
  orderRefId,
  now = new Date()
}) {
  const ownerId = getTenantOwnerId(user)
  const workflowId = createWorkflowId()
  let connection
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    const [locatorRows] = await connection.execute(
      `SELECT po.cloud_locator_version, so.order_id AS platform_order_no,
              YEAR(so.order_time) AS order_year
         FROM cloud_order_refs r
         JOIN purchase_orders po ON po.id = r.purchase_order_id
         JOIN sales_orders so ON (
                (COALESCE(po.sales_order_id, 0) > 0 AND so.id = po.sales_order_id)
             OR (COALESCE(po.sales_order_id, 0) = 0 AND so.order_id = po.sales_order_no)
         )
         JOIN stores s ON s.id = so.store_id AND s.owner_id = po.owner_id
        WHERE r.order_ref_id = ? AND r.owner_id = ?
        FOR UPDATE`,
      [orderRefId, ownerId]
    )
    if (locatorRows.length !== 1) throw serviceError('order_locator_changed', '订单定位信息已变化，需要人工复核')
    assertOrderLocatorReady(locatorRows[0])

    const [activeRows] = await connection.execute(
      `SELECT w.workflow_id, w.state, w.current_task_id, t.command AS current_task_command
         FROM cloud_order_workflows w
         LEFT JOIN cloud_order_tasks t ON t.task_id = w.current_task_id
        WHERE w.owner_id = ? AND w.order_ref_id = ?
        ORDER BY w.created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [ownerId, orderRefId]
    )
    const active = activeRows[0]
    if (active?.current_task_id) {
      if (active.current_task_command !== 'exception.order.check') {
        throw serviceError('workflow_task_active', '当前订单已有云仓任务正在执行')
      }
      await connection.commit()
      return {
        workflowId: active.workflow_id,
        task: { task_id: active.current_task_id },
        state: active.state,
        reused: true
      }
    }

    const route = await readLockedMachineRoute(connection, ownerId)
    assertRouteReady(route, 'exception.order.check')
    await connection.execute(
      `INSERT INTO cloud_order_workflows
         (workflow_id, order_ref_id, owner_id, created_by_user_id, state,
          target_machine_code, binding_version, locator_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'checking_exception', ?, ?, ?, ?, ?)`,
      [
        workflowId,
        orderRefId,
        ownerId,
        Number(user.id),
        route.machineCode,
        route.bindingVersion,
        Number(locatorRows[0].cloud_locator_version || 1),
        toMysqlDate(now),
        toMysqlDate(now)
      ]
    )
    const task = await createRoutedTaskRecord(pool, {
      user,
      workflowId,
      orderRefId,
      command: 'exception.order.check',
      params: {},
      now,
      connection
    })
    await connection.commit()
    return { workflowId, task, state: 'checking_exception', reused: false }
  } catch (error) {
    if (connection) {
      try { await connection.rollback() } catch { /* ignore rollback failure */ }
    }
    throw error
  } finally {
    if (connection) connection.release()
  }
}

async function startExceptionCheckTask(pool, {
  user,
  purchaseOrderId,
  now = new Date()
}) {
  const configuration = await prepareOrderRef(pool, user, purchaseOrderId)
  const created = await createExceptionWorkflow(pool, {
    user,
    orderRefId: configuration.orderRefId,
    now
  })
  return {
    workflowId: created.workflowId,
    taskId: created.task.task_id,
    state: created.state,
    reused: created.reused
  }
}

function readSnapshotRef(result) {
  const parsed = parseJsonObject(result)
  return String(parsed.exception_snapshot_ref || '').trim()
}

async function findExceptionSnapshotWorkflow(db, ownerId, orderRefId, snapshotRef, now, { forUpdate = false } = {}) {
  const lock = forUpdate ? ' FOR UPDATE' : ''
  const [rows] = await db.execute(
    `SELECT w.workflow_id, w.state, w.current_task_id,
            t.task_id, t.execution_status, t.completed_at, t.result_redacted_json
       FROM cloud_order_workflows w
       JOIN cloud_order_tasks t ON t.workflow_id = w.workflow_id
      WHERE w.owner_id = ? AND w.order_ref_id = ?
        AND t.command = 'exception.order.check'
      ORDER BY t.created_at DESC
      LIMIT 1${lock}`,
    [ownerId, orderRefId]
  )
  const matched = rows[0]
  if (!matched || readSnapshotRef(matched.result_redacted_json) !== snapshotRef ||
      matched.execution_status !== 'succeeded') {
    throw serviceError('precondition_not_met', '异常快照不是当前订单的最新成功查询结果')
  }
  if (matched.state !== 'exception_found') {
    throw serviceError('precondition_not_met', '当前工作流不处于可处理异常状态')
  }
  if (matched.current_task_id) throw serviceError('workflow_task_active', '当前订单已有云仓任务正在执行')
  const result = parseJsonObject(matched.result_redacted_json)
  if (!Number.isInteger(Number(result.exception_count)) || Number(result.exception_count) <= 0) {
    throw serviceError('precondition_not_met', '该异常快照没有可处理的异常记录')
  }
  const completedAt = new Date(matched.completed_at).getTime()
  if (!Number.isFinite(completedAt) || now.getTime() - completedAt > 10 * 60 * 1000) {
    throw serviceError('precondition_not_met', '异常快照已超过10分钟，请重新查询')
  }
  return matched
}

async function startExceptionResolveTask(pool, {
  user,
  purchaseOrderId,
  exceptionSnapshotRef,
  confirmed,
  now = new Date()
}) {
  if (confirmed !== true) throw serviceError('confirmation_required', '处理异常前需要人工确认')
  const snapshotRef = String(exceptionSnapshotRef || '').trim()
  if (!snapshotRef) throw serviceError('adapter_params_invalid', 'exception_snapshot_ref 不能为空')
  const configuration = await prepareOrderRef(pool, user, purchaseOrderId)
  const ownerId = getTenantOwnerId(user)
  let connection
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    await connection.execute(
      'SELECT order_ref_id FROM cloud_order_refs WHERE owner_id = ? AND order_ref_id = ? FOR UPDATE',
      [ownerId, configuration.orderRefId]
    )
    const workflow = await findExceptionSnapshotWorkflow(
      connection,
      ownerId,
      configuration.orderRefId,
      snapshotRef,
      now,
      { forUpdate: true }
    )
    const task = await createRoutedTaskRecord(pool, {
      user,
      workflowId: workflow.workflow_id,
      orderRefId: configuration.orderRefId,
      command: 'exception.order.resolve',
      confirmation: { confirmed: true },
      params: { exception_snapshot_ref: snapshotRef },
      now,
      connection
    })
    await connection.commit()
    return {
      workflowId: workflow.workflow_id,
      taskId: task.task_id,
      state: workflow.state,
      reused: false
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
  ENABLED_TASK_COMMANDS,
  EXECUTOR_TRANSPORT_ENABLED,
  assertRouteReady,
  createRoutedTaskRecord,
  findExceptionSnapshotWorkflow,
  readLockedMachineRoute,
  startExceptionCheckTask,
  startExceptionResolveTask,
  toMysqlDate
}
