const { assertMachineCode } = require('./cloud-warehouse-protocol')

function serviceError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function formatSnapshot(row) {
  const machineCode = String(row?.cloud_machine_code || '').trim().toUpperCase()
  if (!machineCode) return null
  return {
    warehouseId: Number(row.cloud_warehouse_id || 0) || null,
    warehouseName: String(row.cloud_warehouse_name || ''),
    machineCode: assertMachineCode(machineCode),
    bindingVersion: Number(row.cloud_machine_binding_version || 0),
    routedAt: row.cloud_machine_routed_at || null,
    source: 'order_snapshot'
  }
}

async function readStoreWarehouseRoute(db, ownerId, storeId) {
  const [rows] = await db.execute(
    `SELECT s.id AS store_id, s.cloud_warehouse_id,
            w.name AS warehouse_name, w.status AS warehouse_status,
            b.machine_code, b.binding_version
       FROM stores s
       LEFT JOIN warehouses w
         ON w.id = s.cloud_warehouse_id AND w.owner_id = s.owner_id
       LEFT JOIN cloud_warehouse_machine_bindings b
         ON b.warehouse_id = w.id AND b.owner_id = w.owner_id
      WHERE s.id = ? AND s.owner_id = ?`,
    [Number(storeId), Number(ownerId)]
  )
  return rows[0] || null
}

async function readLegacyOwnerBinding(db, ownerId) {
  const [newBindingRows] = await db.execute(
    'SELECT COUNT(*) AS total FROM cloud_warehouse_machine_bindings WHERE owner_id = ?',
    [Number(ownerId)]
  )
  if (Number(newBindingRows[0]?.total || 0) > 0) return null

  // 保留旧绑定数据用于兼容，但只要账号曾经配置过仓库级机器，就不再回退旧模型。
  // 这样解绑后不会让已经退休的旧机器码意外重新生效，也不需要删除历史数据。
  const [auditRows] = await db.execute(
    'SELECT COUNT(*) AS total FROM cloud_warehouse_machine_binding_audit WHERE owner_id = ?',
    [Number(ownerId)]
  )
  if (Number(auditRows[0]?.total || 0) > 0) return null

  const [rows] = await db.execute(
    'SELECT machine_code, binding_version FROM cloud_machine_bindings WHERE owner_id = ? LIMIT 1',
    [Number(ownerId)]
  )
  if (!rows.length) return null
  return {
    warehouseId: null,
    warehouseName: '',
    machineCode: assertMachineCode(rows[0].machine_code),
    bindingVersion: Number(rows[0].binding_version || 1),
    routedAt: null,
    source: 'legacy_owner_binding'
  }
}

async function persistOrderRoute(db, ownerId, purchaseOrderId, route) {
  await db.execute(
    `UPDATE purchase_orders
        SET cloud_warehouse_id = ?, cloud_machine_code = ?,
            cloud_machine_binding_version = ?, cloud_machine_routed_at = NOW(3)
      WHERE id = ? AND owner_id = ?
        AND COALESCE(cloud_machine_code, '') = ''`,
    [
      route.warehouseId,
      route.machineCode,
      route.bindingVersion,
      Number(purchaseOrderId),
      Number(ownerId)
    ]
  )
  const [rows] = await db.execute(
    `SELECT po.cloud_warehouse_id, po.cloud_machine_code,
            po.cloud_machine_binding_version, po.cloud_machine_routed_at,
            w.name AS cloud_warehouse_name
       FROM purchase_orders po
       LEFT JOIN warehouses w
         ON w.id = po.cloud_warehouse_id AND w.owner_id = po.owner_id
      WHERE po.id = ? AND po.owner_id = ?`,
    [Number(purchaseOrderId), Number(ownerId)]
  )
  if (!rows.length) throw serviceError('purchase_order_not_found', '采购订单不存在')
  return formatSnapshot(rows[0])
}

async function resolveOrderMachineRoute(db, {
  ownerId,
  purchaseOrderId,
  storeId,
  allowLegacy = true
}) {
  const normalizedOwnerId = Number(ownerId)
  const normalizedPurchaseOrderId = Number(purchaseOrderId)
  const normalizedStoreId = Number(storeId)
  if (!Number.isInteger(normalizedOwnerId) || normalizedOwnerId <= 0) {
    throw serviceError('tenant_owner_invalid', '无法确定订单所属主账号')
  }
  if (!Number.isInteger(normalizedPurchaseOrderId) || normalizedPurchaseOrderId <= 0) {
    throw serviceError('purchase_order_invalid', '采购订单标识无效')
  }

  const [snapshotRows] = await db.execute(
    `SELECT po.cloud_warehouse_id, po.cloud_machine_code,
            po.cloud_machine_binding_version, po.cloud_machine_routed_at,
            w.name AS cloud_warehouse_name
       FROM purchase_orders po
       LEFT JOIN warehouses w
         ON w.id = po.cloud_warehouse_id AND w.owner_id = po.owner_id
      WHERE po.id = ? AND po.owner_id = ?`,
    [normalizedPurchaseOrderId, normalizedOwnerId]
  )
  if (!snapshotRows.length) throw serviceError('purchase_order_not_found', '采购订单不存在')
  const existing = formatSnapshot(snapshotRows[0])
  if (existing) return existing

  if (!Number.isInteger(normalizedStoreId) || normalizedStoreId <= 0) {
    throw serviceError('sales_order_store_missing', '关联销售订单缺少所属店铺，无法选择云仓')
  }
  const storeRoute = await readStoreWarehouseRoute(db, normalizedOwnerId, normalizedStoreId)
  if (!storeRoute) throw serviceError('sales_order_store_missing', '关联销售订单所属店铺不存在')

  let route = null
  if (storeRoute.cloud_warehouse_id && storeRoute.machine_code) {
    if (storeRoute.warehouse_status !== 'enabled') {
      throw serviceError('cloud_warehouse_disabled', '店铺所属云仓已停用，请先调整店铺配置')
    }
    route = {
      warehouseId: Number(storeRoute.cloud_warehouse_id),
      warehouseName: String(storeRoute.warehouse_name || ''),
      machineCode: assertMachineCode(storeRoute.machine_code),
      bindingVersion: Number(storeRoute.binding_version || 1),
      routedAt: null,
      source: 'store_warehouse'
    }
  } else if (allowLegacy) {
    route = await readLegacyOwnerBinding(db, normalizedOwnerId)
  }

  if (!route) {
    if (!storeRoute.cloud_warehouse_id) {
      throw serviceError('store_cloud_warehouse_missing', '该店铺尚未选择所属云仓')
    }
    throw serviceError('warehouse_machine_binding_missing', '店铺所属云仓尚未绑定云仓助手机器码')
  }

  const snapshot = await persistOrderRoute(db, normalizedOwnerId, normalizedPurchaseOrderId, route)
  return {
    ...snapshot,
    warehouseName: route.warehouseName,
    source: route.source
  }
}

module.exports = {
  formatSnapshot,
  persistOrderRoute,
  readLegacyOwnerBinding,
  readStoreWarehouseRoute,
  resolveOrderMachineRoute,
  serviceError
}
