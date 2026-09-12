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

const FORWARDED_SOURCE_STATUSES = Object.freeze([
  'pending_print',
  'shipped',
  'in_transit',
  'received'
])

const TRACKING_REFINABLE_STATUSES = new Set([
  'ordered',
  'pending',
  'shipped',
  'in_transit'
])

function parseTrackingItems(tracking) {
  if (Array.isArray(tracking)) return tracking
  if (typeof tracking !== 'string' || !tracking.trim()) return []

  try {
    const parsed = JSON.parse(tracking)
    return Array.isArray(parsed) ? parsed : []
  } catch (_) {
    return []
  }
}

function trackingItemText(item) {
  if (item === null || item === undefined) return ''
  if (typeof item === 'string') return item
  if (typeof item !== 'object') return String(item)

  return [
    item.context,
    item.desc,
    item.description,
    item.message,
    item.status,
    item.content
  ].filter(Boolean).join(' ')
}

/**
 * 平台交易状态偶尔仍是“已下单”，但本地已经保存了完整物流轨迹。
 * 服务端在最终回写前再次按真实物流证据修正状态，避免依赖客户端本次
 * 是否成功抓到物流详情页。
 */
function refinePurchaseOrderStatusByTracking(status, tracking, logisticsStatus = '') {
  const current = String(status || '').trim()
  if (!TRACKING_REFINABLE_STATUSES.has(current)) return current

  const logisticsText = String(logisticsStatus || '')
  if (/已拒收|拒收|拒签/.test(logisticsText)) return 'rejected'
  if (/已签收|已投递|已妥投|家人签收|代收/.test(logisticsText)) return 'received'

  let hasTransitEvidence = /运输中|派送中|配送中|正在派送|已揽收|揽件成功|已取件|已出库|分拣中|已发往|到达.*(?:中心|网点|站点)/.test(logisticsText)
  let hasShippedEvidence = /已发货|卖家已发货|等待揽收|待揽收/.test(logisticsText)

  for (const item of parseTrackingItems(tracking)) {
    const text = trackingItemText(item)
    if (/拒收|拒签|拒绝签收|退回/.test(text)) return 'rejected'
    if (/已签收|已投递|已妥投|家人签收|代收|本人签收/.test(text)) return 'received'
    if (/通知.*取件|取件.*通知/.test(text)) continue
    if (/运输中|派送中|配送中|正在派送|已揽收|揽件成功|已取件|已出库|分拣|发往|到达.*(?:中心|网点|站点)|离开.*(?:中心|网点|站点)/.test(text)) {
      hasTransitEvidence = true
    } else if (/已发货|卖家已发货|等待揽收|待揽收/.test(text)) {
      hasShippedEvidence = true
    }
  }

  if (hasTransitEvidence && current !== 'in_transit') return 'in_transit'
  if (hasShippedEvidence && (current === 'ordered' || current === 'pending')) return 'shipped'
  return current
}

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

async function markForwardedAfterCloudOutbound(pool, { ownerId, purchaseOrderId }) {
  const normalizedOwnerId = Number(ownerId)
  const normalizedPurchaseOrderId = Number(purchaseOrderId)
  if (!Number.isInteger(normalizedOwnerId) || normalizedOwnerId <= 0 ||
      !Number.isInteger(normalizedPurchaseOrderId) || normalizedPurchaseOrderId <= 0) {
    return false
  }

  const placeholders = FORWARDED_SOURCE_STATUSES.map(() => '?').join(', ')
  const [result] = await pool.execute(
    `UPDATE purchase_orders
        SET status = 'forwarded', updated_at = NOW()
      WHERE id = ? AND owner_id = ? AND status IN (${placeholders})`,
    [normalizedPurchaseOrderId, normalizedOwnerId, ...FORWARDED_SOURCE_STATUSES]
  )
  return Number(result?.affectedRows || 0) > 0
}

module.exports = {
  FORWARDED_SOURCE_STATUSES,
  LOCAL_WORKFLOW_STATUSES,
  PENDING_PRINT_SOURCE_STATUSES,
  PLATFORM_TERMINAL_STATUSES,
  TRACKING_REFINABLE_STATUSES,
  markForwardedAfterCloudOutbound,
  markPendingPrintAfterExceptionResolution,
  mergePurchaseOrderStatus,
  parseTrackingItems,
  refinePurchaseOrderStatusByTracking
}
