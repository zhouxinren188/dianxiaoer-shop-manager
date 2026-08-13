const {
  assertMachineCode,
  createOrderRefId,
  getTenantOwnerId
} = require('./cloud-warehouse-protocol')

const EXCEPTION_SOURCES = new Set(['billexception', 'soExceptionCentre'])
const LOCATOR_ERRORS = new Set([
  'sales_order_not_linked',
  'sales_order_not_found',
  'sales_order_relation_ambiguous',
  'sales_order_relation_conflict',
  'platform_order_no_missing',
  'sales_order_time_missing',
  'sales_order_time_invalid'
])

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
    throw serviceError('sales_order_time_invalid', '关联销售订单的下单时间无效，无法可靠确定订单年份')
  }
  return year
}

async function readAccessiblePurchaseOrder(db, user, purchaseOrderId, { forUpdate = false } = {}) {
  const id = Number(purchaseOrderId)
  if (!Number.isInteger(id) || id <= 0) throw serviceError('purchase_order_invalid', '采购订单标识无效')
  const ownerId = getTenantOwnerId(user)
  const lock = forUpdate ? ' FOR UPDATE' : ''
  let rows
  if (user.user_type === 'master') {
    ;[rows] = await db.execute(
      `SELECT po.id, po.owner_id, po.purchase_no, po.platform,
              po.account_id, po.created_by, po.sales_order_id, po.sales_order_no,
              po.purchase_type, po.status, po.cloud_locator_version
         FROM purchase_orders po
        WHERE po.id = ? AND po.owner_id = ?${lock}`,
      [id, ownerId]
    )
  } else {
    ;[rows] = await db.execute(
      `SELECT po.id, po.owner_id, po.purchase_no, po.platform,
              po.account_id, po.created_by, po.sales_order_id, po.sales_order_no,
              po.purchase_type, po.status, po.cloud_locator_version
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

async function readRelatedSalesLocator(db, order, { forUpdate = false } = {}) {
  const salesOrderId = Number(order?.sales_order_id)
  const salesOrderNo = String(order?.sales_order_no || '').trim()
  if ((!Number.isInteger(salesOrderId) || salesOrderId <= 0) && !salesOrderNo) {
    throw serviceError('sales_order_not_linked', '采购单尚未关联销售订单')
  }

  const lock = forUpdate ? ' FOR UPDATE' : ''
  let rows
  if (Number.isInteger(salesOrderId) && salesOrderId > 0) {
    ;[rows] = await db.execute(
      `SELECT so.id AS sales_order_id, so.order_id AS platform_order_no,
              so.order_time AS sales_order_time, YEAR(so.order_time) AS order_year,
              s.owner_id AS store_owner_id
         FROM sales_orders so
         JOIN stores s ON s.id = so.store_id
        WHERE so.id = ? AND s.owner_id = ?${lock}`,
      [salesOrderId, Number(order.owner_id)]
    )
  } else {
    ;[rows] = await db.execute(
      `SELECT so.id AS sales_order_id, so.order_id AS platform_order_no,
              so.order_time AS sales_order_time, YEAR(so.order_time) AS order_year,
              s.owner_id AS store_owner_id
         FROM sales_orders so
         JOIN stores s ON s.id = so.store_id
        WHERE so.order_id = ? AND s.owner_id = ?
        ORDER BY so.id
        LIMIT 2${lock}`,
      [salesOrderNo, Number(order.owner_id)]
    )
  }

  if (!rows.length) throw serviceError('sales_order_not_found', '未找到当前主账号体系内的关联销售订单')
  if (rows.length !== 1) throw serviceError('sales_order_relation_ambiguous', '关联销售订单不唯一，需要人工核对')

  const row = rows[0]
  const platformOrderNo = String(row.platform_order_no || '').trim()
  if (!platformOrderNo) throw serviceError('platform_order_no_missing', '关联销售订单缺少订单号')
  if (salesOrderNo && salesOrderNo !== platformOrderNo) {
    throw serviceError('sales_order_relation_conflict', '采购单记录的销售订单号与关联销售订单不一致')
  }
  if (!String(row.sales_order_time || '').trim()) {
    throw serviceError('sales_order_time_missing', '关联销售订单缺少平台实际下单时间')
  }

  return {
    salesOrderId: Number(row.sales_order_id),
    platformOrderNo,
    salesOrderTime: row.sales_order_time,
    orderYear: normalizeOrderYear(row.order_year),
    locatorVersion: Number(order.cloud_locator_version || 1)
  }
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

function assertOrderLocatorReady(locator) {
  if (!String(locator?.platformOrderNo || locator?.platform_order_no || '').trim()) {
    throw serviceError('platform_order_no_missing', '关联销售订单缺少订单号')
  }
  return normalizeOrderYear(locator?.orderYear ?? locator?.order_year)
}

async function getOrderConfiguration(pool, user, purchaseOrderId) {
  const order = await readAccessiblePurchaseOrder(pool, user, purchaseOrderId)
  const ownerId = getTenantOwnerId(user)
  const orderRefId = await readOrderRef(pool, ownerId, order.id)
  const [bindingRows] = await pool.execute(
    'SELECT 1 FROM cloud_machine_bindings WHERE owner_id = ? LIMIT 1',
    [ownerId]
  )
  let locator = null
  let locatorError = null
  try {
    locator = await readRelatedSalesLocator(pool, order)
  } catch (error) {
    if (!LOCATOR_ERRORS.has(error?.code)) throw error
    locatorError = error
  }

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
    platformOrderNo: locator?.platformOrderNo || '',
    salesOrderTime: locator?.salesOrderTime || null,
    platform: order.platform || '',
    orderYear: locator?.orderYear || null,
    orderYearSource: locator ? 'sales_order_time' : '',
    locatorReady: !!locator,
    locatorReason: locatorError?.code || '',
    locatorMessage: locatorError?.message || '',
    machineBound: bindingRows.length > 0,
    manualForwardAllowed: bindingRows.length === 0 && order.purchase_type === 'warehouse',
    orderRefId,
    exception,
    transportEnabled: false
  }
}

async function markManualForwarded(pool, user, purchaseOrderId) {
  let connection
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    const order = await readAccessiblePurchaseOrder(connection, user, purchaseOrderId, { forUpdate: true })
    if (order.purchase_type !== 'warehouse') {
      throw serviceError('manual_forward_not_applicable', '只有仓库转发采购单可以手工标记已转发')
    }
    const [bindingRows] = await connection.execute(
      'SELECT machine_code FROM cloud_machine_bindings WHERE owner_id = ? FOR UPDATE',
      [getTenantOwnerId(user)]
    )
    if (bindingRows.length > 0) {
      throw serviceError('manual_forward_requires_cloud_workflow', '当前主账号体系已绑定云仓助手，请通过云仓状态复验流程完成发货')
    }
    if (order.status !== 'forwarded') {
      await connection.execute(
        "UPDATE purchase_orders SET status = 'forwarded', updated_at = NOW() WHERE id = ? AND owner_id = ?",
        [Number(order.id), getTenantOwnerId(user)]
      )
    }
    await connection.commit()
    return {
      purchaseOrderId: Number(order.id),
      status: 'forwarded',
      manual: true
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

async function prepareOrderRef(pool, user, purchaseOrderId) {
  let connection
  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    const order = await readAccessiblePurchaseOrder(connection, user, purchaseOrderId, { forUpdate: true })
    const locator = await readRelatedSalesLocator(connection, order, { forUpdate: true })
    assertOrderLocatorReady(locator)
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
 * 执行器控制面完成认证和任务领取后调用，不得直接暴露为无认证 HTTP 路由。
 * 映射只返回关联销售订单号和由销售订单下单时间确定的年份。
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
            po.owner_id AS order_owner_id, po.sales_order_id AS linked_sales_order_id,
            po.sales_order_no AS linked_sales_order_no, po.cloud_locator_version,
            so.id AS resolved_sales_order_id, so.order_id AS platform_order_no,
            so.order_time AS sales_order_time, YEAR(so.order_time) AS order_year,
            s.owner_id AS store_owner_id,
            w.locator_version AS workflow_locator_version,
            b.machine_code AS bound_machine_code, b.binding_version AS current_binding_version,
            w.binding_version AS workflow_binding_version,
            i.machine_code AS instance_machine_code, i.status AS instance_status,
            i.last_heartbeat_at AS instance_last_heartbeat_at
       FROM cloud_order_tasks t
       JOIN cloud_order_workflows w ON w.workflow_id = t.workflow_id
       JOIN cloud_order_refs r ON r.order_ref_id = t.order_ref_id
       JOIN purchase_orders po ON po.id = r.purchase_order_id
       JOIN sales_orders so ON (
              (COALESCE(po.sales_order_id, 0) > 0 AND so.id = po.sales_order_id)
           OR (COALESCE(po.sales_order_id, 0) = 0 AND so.order_id = po.sales_order_no)
       )
       JOIN stores s ON s.id = so.store_id AND s.owner_id = po.owner_id
       JOIN cloud_machine_bindings b ON b.owner_id = w.owner_id
       JOIN cloud_executor_instances i ON i.executor_instance_id = ?
      WHERE t.task_id = ? AND t.order_ref_id = ?`,
    [String(executorInstanceId || ''), String(taskId || ''), String(orderRefId || '')]
  )
  if (rows.length !== 1) throw serviceError('order_mapping_forbidden', '订单映射不存在、不唯一或执行器无权解析')
  const row = rows[0]
  const ownerConsistent = Number(row.workflow_owner_id) === Number(row.ref_owner_id) &&
    Number(row.ref_owner_id) === Number(row.order_owner_id) &&
    Number(row.order_owner_id) === Number(row.store_owner_id)
  const machineConsistent = row.target_machine_code === normalizedMachineCode &&
    row.bound_machine_code === normalizedMachineCode &&
    row.instance_machine_code === normalizedMachineCode &&
    row.claimed_executor_instance_id === String(executorInstanceId || '') &&
    Number(row.workflow_binding_version) === Number(row.current_binding_version)
  const linkedSalesOrderId = Number(row.linked_sales_order_id)
  const platformOrderNo = String(row.platform_order_no || '').trim()
  const relationshipConsistent = linkedSalesOrderId > 0
    ? linkedSalesOrderId === Number(row.resolved_sales_order_id) &&
      (!String(row.linked_sales_order_no || '').trim() || String(row.linked_sales_order_no).trim() === platformOrderNo)
    : String(row.linked_sales_order_no || '').trim() === platformOrderNo
  const locatorConsistent = Number(row.workflow_locator_version) === Number(row.cloud_locator_version)
  const heartbeatAt = new Date(row.instance_last_heartbeat_at).getTime()
  const heartbeatFresh = Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= 90 * 1000
  if (!ownerConsistent || !machineConsistent || !relationshipConsistent || !locatorConsistent ||
      row.instance_status !== 'online' || !heartbeatFresh) {
    throw serviceError('order_mapping_forbidden', '订单归属、销售订单关系或目标执行器校验失败')
  }
  if (!['leased', 'executing'].includes(row.transport_status) ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      new Date(row.lease_expires_at).getTime() <= Date.now()) {
    throw serviceError('task_expired', '任务未处于有效领取状态')
  }
  assertOrderLocatorReady({ platform_order_no: platformOrderNo, order_year: row.order_year })
  return {
    platform_order_no: platformOrderNo,
    order_year: normalizeOrderYear(row.order_year)
  }
}

module.exports = {
  assertOrderLocatorReady,
  getOrderConfiguration,
  markManualForwarded,
  normalizeExceptionSummary,
  normalizeOrderYear,
  prepareOrderRef,
  readAccessiblePurchaseOrder,
  readRelatedSalesLocator,
  resolveTrustedOrderMapping
}
