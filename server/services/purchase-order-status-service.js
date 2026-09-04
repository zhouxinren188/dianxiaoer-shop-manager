const LOCAL_WORKFLOW_STATUSES = new Set([
  'pending_print',
  'forwarded',
  'stocked',
  'completed'
])

const PLATFORM_TERMINAL_STATUSES = new Set([
  'cancelled',
  'refunded',
  'rejected'
])

const PENDING_PRINT_SOURCE_STATUSES = Object.freeze([
  'shipped',
  'in_transit',
  'received'
])

// 采购平台同步只描述上游交易/物流状态，不能把店小二自己的后续处理阶段倒退掉。
function mergePurchaseOrderStatus(currentStatus, platformStatus) {
  const current = String(currentStatus || '').trim()
  const incoming = String(platformStatus || '').trim()
  if (!incoming) return current
  if (LOCAL_WORKFLOW_STATUSES.has(current) && !PLATFORM_TERMINAL_STATUSES.has(incoming)) {
    return current
  }
  return incoming
}

async function markPendingPrintAfterExceptionResolution(pool, { ownerId, purchaseOrderId }) {
  const normalizedOwnerId = Number(ownerId)
  const normalizedPurchaseOrderId = Number(purchaseOrderId)
  if (!Number.isInteger(normalizedOwnerId) || normalizedOwnerId <= 0 ||
      !Number.isInteger(normalizedPurchaseOrderId) || normalizedPurchaseOrderId <= 0) {
    return false
  }

  const placeholders = PENDING_PRINT_SOURCE_STATUSES.map(() => '?').join(', ')
  const [result] = await pool.execute(
    `UPDATE purchase_orders
        SET status = 'pending_print', updated_at = NOW()
      WHERE id = ? AND owner_id = ? AND status IN (${placeholders})`,
    [normalizedPurchaseOrderId, normalizedOwnerId, ...PENDING_PRINT_SOURCE_STATUSES]
  )
  return Number(result?.affectedRows || 0) > 0
}

module.exports = {
  LOCAL_WORKFLOW_STATUSES,
  PENDING_PRINT_SOURCE_STATUSES,
  PLATFORM_TERMINAL_STATUSES,
  markPendingPrintAfterExceptionResolution,
  mergePurchaseOrderStatus
}
