const {
  assertMachineCode,
  createOrderRefId,
  getTenantOwnerId
} = require('./cloud-warehouse-protocol')

const RELIABLE_YEAR_SOURCES = new Set(['platform_order_time', 'manual_confirmed'])
const EXCEPTION_SOURCES = new Set(['billexception', 'soExceptionCentre'])

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

function normalizeOrderYear(value) {
  const year = Number(value)
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw serviceError('order_year_invalid', '订单年份必须是 2000 至 2100 之间的四位年份')
  }
  return year
}

function hasReliableOrderYear(order) {
  return Number.isInteger(Number(order?.order_year)) && RELIABLE_YEAR_SOURCES.has(order?.order_year_source)
}

async function readAccessiblePurchaseOrder(db, user, purchaseOrderId, { forUpdate = false } = {}) {
  const id = Number(purchaseOrderId)
  if (!Number.isInteger(id) || id <= 0) throw serviceError('purchase_order_invalid', '采购订单标识无效')
  const ownerId = getTenantOwnerId(user)
  const lock = forUpdate ? ' FOR UPDATE' : ''
  let rows
  if (user.user_type === 'master') {
    ;[rows] = await db.execute(
      `SELECT po.id, po.owner_id, po.purchase_no, po.platform_order_no, po.platform,
              po.account_id, po.created_by, po.platform_order_time, po.order_year,
              po.order_year_source, po.order_year_confirmed_by, po.order_year_confirmed_at,
              po.cloud_locator_version
         FROM purchase_orders po
        WHERE po.id = ? AND po.owner_id = ?${lock}`,
      [id, ownerId]
    )
  } else {
    ;[rows] = await db.execute(
      `SELECT po.id, po.owner_id, po.purchase_no, po.platform_order_no, po.platform,
              po.account_id, po.created_by, po.platform_order_time, po.order_year,
              po.order_year_source, po.order_year_confirmed_by, po.order_year_confirmed_at,
              po.cloud_locator_version
         FROM purchase_orders po
        WHERE po.id = ? AND po.owner_id = ?
          AND (EXISTS (
                 SELECT 1 FROM user_purchase_accounts upa
                  WHERE upa.account_id = po.account_id AND upa.user_id = ?
               )
               OR (po.account_id IS NULL AND (po.created_by = ? OR po.created_by IS NULL)))${lock}`,
      [id, ownerId, Number(user.id), Number(user.id)]
    )
  }
  if (!rows.length) throw serviceError('purchase_order_not_found', '采购订单不存在或当前账号无权访问')
  return rows[0]
}

async function readOrderRef(db, ownerId, purchaseOrderId) {
  const [rows] = await db.execute(
    'SELECT order_ref_id FROM cloud_order_refs WHERE owner_id = ? AND purchase_order_id = ?',
    [ownerId, purchaseOrderId]
  )
  return rows[0]?.order_ref_id || ''
}

async function ensureOrderRef(db, user, order) {
  const ownerId = getTenantOwnerId(user)
  const existing = await readOrderRef(db, ownerId, order.id)
  if (existing) return existing
  const orderRefId = createOrderRefId()
  await db.execute(
    `INSERT INTO cloud_order_refs
       (order_ref_id, owner_id, purchase_order_id, created_by_user_id)
     VALUES (?, ?, ?, ?)`,
    [orderRefId, ownerId, Number(order.id), Number(user.id)]
  )
  return orderRefId
}

function assertOrderLocatorReady(order) {
  if (!String(order.platform_order_no || '').trim()) {
    throw serviceError('platform_order_no_missing', '采购订单尚未绑定准确的平台订单号')
  }
  if (!hasReliableOrderYear(order)) {
    throw serviceError('order_year_unconfirmed', '请先根据平台实际下单时间确认订单年份')
  }
}

async function getOrderConfiguration(pool, user, purchaseOrderId) {
  const order = await readAccessiblePurchaseOrder(pool, user, purchaseOrderId)
  const ownerId = getTenantOwnerId(user)
  const orderRefId = await readOrderRef(pool, ownerId, order.id)
  let exception = null
  if (orderRefId) {
    const [taskRows] = await pool.execute(
      `SELECT t.task_id, t.execution_status, t.reason, t.message_redacted,
              t.result_redacted_json, t.observed_status, t.completed_at
         FROM cloud_order_tasks t
         JOIN cloud_order_workflows w ON w.workflow_id = t.workflow_id
        WHERE w.owner_id = ? AND t.order_ref_id = ?
          AND t.command = 'exception.order.check'
        ORDER BY t.created_at DESC
        LIMIT 1`,
      [ownerId, orderRefId]
    )
    if (taskRows.length) exception = normalizeExceptionSummary(taskRows[0])
  }
  return {
    purchaseOrderId: Number(order.id),
    purchaseNo: order.purchase_no || '',
    platformOrderNo: order.platform_order_no || '',
    platform: order.platform || '',
    orderYear: order.order_year ? Number(order.order_year) : null,
    orderYearSource: order.order_year_source || '',
    orderYearConfirmedAt: order.order_year_confirmed_at || null,
    locatorReady: !!String(order.platform_order_no || '').trim() && hasReliableOrderYear(order),
    orderRefId,
    exception,
    transportEnabled: false
  }
}

async function confirmManualOrderYear(pool, user, purchaseOrderId, orderYear, confirmed) {
  if (confirmed !== true) throw serviceError('order_year_confirmation_required', '保存订单年份前需要人工确认')
  const normalizedYear = normalizeOrderYear(orderYear)
  let connection
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    const order = await readAccessiblePurchaseOrder(connection, user, purchaseOrderId, { forUpdate: true })
    if (!String(order.platform_order_no || '').trim()) {
      throw serviceError('platform_order_no_missing', '请先绑定准确的平台采购订单号')
    }
    const orderRefId = await ensureOrderRef(connection, user, order)
    const locatorChanged = Number(order.order_year) !== normalizedYear || order.order_year_source !== 'manual_confirmed'
    await connection.execute(
      `UPDATE purchase_orders
          SET order_year = ?, order_year_source = 'manual_confirmed',
              order_year_confirmed_by = ?, order_year_confirmed_at = NOW(3),
              cloud_locator_version = cloud_locator_version + ?, updated_at = NOW()
        WHERE id = ? AND owner_id = ?`,
      [normalizedYear, Number(user.id), locatorChanged ? 1 : 0, Number(order.id), getTenantOwnerId(user)]
    )
    if (locatorChanged && order.order_year) {
      await connection.execute(
        `UPDATE cloud_order_workflows w
         JOIN cloud_order_refs r ON r.order_ref_id = w.order_ref_id
            SET w.state = 'review_required', w.review_reason = 'order_locator_changed',
                w.review_required_at = NOW(3), w.next_check_at = NULL, w.updated_at = NOW(3)
          WHERE r.owner_id = ? AND r.purchase_order_id = ?
            AND w.completed_at IS NULL`,
        [getTenantOwnerId(user), Number(order.id)]
      )
    }
    await connection.execute(
      `INSERT INTO cloud_order_locator_audit
         (order_ref_id, purchase_order_id, owner_id, actor_user_id,
          old_order_year, new_order_year, source)
       VALUES (?, ?, ?, ?, ?, ?, 'manual_confirmed')`,
      [orderRefId, Number(order.id), getTenantOwnerId(user), Number(user.id),
        order.order_year ? Number(order.order_year) : null, normalizedYear]
    )
    await connection.commit()
    return await getOrderConfiguration(pool, user, purchaseOrderId)
  } catch (error) {
    if (connection) {
      try { await connection.rollback() } catch { /* ignore rollback failure */ }
    }
    throw error
  } finally {
    if (connection) connection.release()
  }
}

async function prepareOrderRef(pool, user, purchaseOrderId) {
  let connection
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    const order = await readAccessiblePurchaseOrder(connection, user, purchaseOrderId, { forUpdate: true })
    assertOrderLocatorReady(order)
    await ensureOrderRef(connection, user, order)
    await connection.commit()
    return await getOrderConfiguration(pool, user, purchaseOrderId)
  } catch (error) {
    if (connection) {
      try { await connection.rollback() } catch { /* ignore rollback failure */ }
    }
    throw error
  } finally {
    if (connection) connection.release()
  }
}

function normalizeExceptionSummary(task) {
  const result = parseJsonObject(task.result_redacted_json)
  const rawExceptions = Array.isArray(result.exceptions) ? result.exceptions : []
  const sourcesValid = rawExceptions.every(item => EXCEPTION_SOURCES.has(item?.source))
  const exceptions = rawExceptions.slice(0, 100).map(item => ({
    source: EXCEPTION_SOURCES.has(item?.source) ? item.source : '',
    exceptionTypeMasked: String(item?.exception_type_masked || '').slice(0, 200),
    reasonMasked: String(item?.reason_masked || '').slice(0, 500)
  }))
  const declaredCount = Number(result.exception_count)
  const countValid = Number.isInteger(declaredCount) && declaredCount >= 0 && declaredCount === rawExceptions.length
  const resultShapeValid = sourcesValid && countValid && rawExceptions.length <= 100
  return {
    taskId: task.task_id,
    status: task.execution_status || '',
    reason: task.reason || '',
    message: task.message_redacted || '',
    exceptionSnapshotRef: String(result.exception_snapshot_ref || ''),
    resultShapeValid,
    exceptionCount: countValid ? declaredCount : exceptions.length,
    queriedAt: result.queried_at || task.completed_at || null,
    exceptions
  }
}

/**
 * 执行器控制面完成认证和任务领取后调用。不得直接暴露为无认证 HTTP 路由。
 * 映射只返回平台订单号和可靠年份，不返回采购单、租户或用户信息。
 */
async function resolveTrustedOrderMapping(pool, {
  taskId,
  orderRefId,
  machineCode,
  executorInstanceId
}) {
  const normalizedMachineCode = assertMachineCode(machineCode)
  const [rows] = await pool.execute(
    `SELECT t.task_id, t.order_ref_id, t.target_machine_code, t.transport_status,
            t.claimed_executor_instance_id, t.expires_at, t.lease_expires_at,
            w.owner_id AS workflow_owner_id,
            r.owner_id AS ref_owner_id, r.purchase_order_id,
            po.owner_id AS order_owner_id, po.platform_order_no, po.order_year,
            po.order_year_source, po.cloud_locator_version,
            w.locator_version AS workflow_locator_version,
            b.machine_code AS bound_machine_code, b.binding_version AS current_binding_version,
            w.binding_version AS workflow_binding_version,
            i.machine_code AS instance_machine_code, i.status AS instance_status,
            i.last_heartbeat_at AS instance_last_heartbeat_at
       FROM cloud_order_tasks t
       JOIN cloud_order_workflows w ON w.workflow_id = t.workflow_id
       JOIN cloud_order_refs r ON r.order_ref_id = t.order_ref_id
       JOIN purchase_orders po ON po.id = r.purchase_order_id
       JOIN cloud_machine_bindings b ON b.owner_id = w.owner_id
       JOIN cloud_executor_instances i ON i.executor_instance_id = ?
      WHERE t.task_id = ? AND t.order_ref_id = ?`,
    [String(executorInstanceId || ''), String(taskId || ''), String(orderRefId || '')]
  )
  if (!rows.length) throw serviceError('order_mapping_forbidden', '订单映射不存在或执行器无权解析')
  const row = rows[0]
  const ownerConsistent = Number(row.workflow_owner_id) === Number(row.ref_owner_id) &&
    Number(row.ref_owner_id) === Number(row.order_owner_id)
  const machineConsistent = row.target_machine_code === normalizedMachineCode &&
    row.bound_machine_code === normalizedMachineCode &&
    row.instance_machine_code === normalizedMachineCode &&
    row.claimed_executor_instance_id === String(executorInstanceId || '') &&
    Number(row.workflow_binding_version) === Number(row.current_binding_version)
  const locatorConsistent = Number(row.workflow_locator_version) === Number(row.cloud_locator_version)
  const heartbeatAt = new Date(row.instance_last_heartbeat_at).getTime()
  const heartbeatFresh = Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= 90 * 1000
  if (!ownerConsistent || !machineConsistent || !locatorConsistent || row.instance_status !== 'online' || !heartbeatFresh) {
    throw serviceError('order_mapping_forbidden', '订单归属或目标执行器校验失败')
  }
  if (!['leased', 'executing'].includes(row.transport_status) ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      new Date(row.lease_expires_at).getTime() <= Date.now()) {
    throw serviceError('task_expired', '任务未处于有效领取状态')
  }
  assertOrderLocatorReady(row)
  return {
    platform_order_no: String(row.platform_order_no),
    order_year: Number(row.order_year)
  }
}

module.exports = {
  RELIABLE_YEAR_SOURCES,
  assertOrderLocatorReady,
  confirmManualOrderYear,
  getOrderConfiguration,
  hasReliableOrderYear,
  normalizeExceptionSummary,
  normalizeOrderYear,
  prepareOrderRef,
  readAccessiblePurchaseOrder,
  resolveTrustedOrderMapping
}
