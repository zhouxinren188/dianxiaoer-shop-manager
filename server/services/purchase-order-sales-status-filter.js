const STATUS_ALIAS_MAP = Object.freeze({
  '等待付款': '待付款',
  '等待出库': '待出库',
  '锁定': '暂停订单',
  '暂停': '暂停订单',
  '已发货': '已出库'
})

function normalizeStatusText(statusText) {
  return STATUS_ALIAS_MAP[statusText] || statusText
}

function getSalesOrderStatusVariants(status) {
  const normalizedStatus = String(status || '').trim()
  if (!normalizedStatus) return []

  const variants = [normalizedStatus]
  for (const [alias, canonicalStatus] of Object.entries(STATUS_ALIAS_MAP)) {
    if (canonicalStatus === normalizedStatus) variants.push(alias)
  }
  return [...new Set(variants)]
}

function buildPurchaseOrderSalesStatusFilter({ status, ownerId, purchaseAlias = 'po' }) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(purchaseAlias)) {
    throw new Error('Invalid purchase order table alias')
  }

  const statusVariants = getSalesOrderStatusVariants(status)
  if (!statusVariants.length) return { sql: '', params: [] }

  const statusPlaceholders = statusVariants.map(() => '?').join(',')
  const sql = ` AND (
    EXISTS (
      SELECT 1
      FROM sales_orders filter_so_id
      INNER JOIN stores filter_store_id ON filter_store_id.id = filter_so_id.store_id
      WHERE filter_store_id.owner_id = ?
        AND ${purchaseAlias}.sales_order_id IS NOT NULL
        AND ${purchaseAlias}.sales_order_id <> ''
        AND filter_so_id.id = CAST(${purchaseAlias}.sales_order_id AS UNSIGNED)
        AND filter_so_id.status_text IN (${statusPlaceholders})
    )
    OR EXISTS (
      SELECT 1
      FROM stores filter_store_no
      STRAIGHT_JOIN sales_orders filter_so_no
        ON filter_so_no.store_id = filter_store_no.id
       AND filter_so_no.order_id = ${purchaseAlias}.sales_order_no
      WHERE filter_store_no.owner_id = ?
        AND ${purchaseAlias}.sales_order_no IS NOT NULL
        AND ${purchaseAlias}.sales_order_no <> ''
        AND filter_so_no.status_text IN (${statusPlaceholders})
    )
  )`

  return {
    sql,
    params: [ownerId, ...statusVariants, ownerId, ...statusVariants]
  }
}

module.exports = {
  STATUS_ALIAS_MAP,
  buildPurchaseOrderSalesStatusFilter,
  getSalesOrderStatusVariants,
  normalizeStatusText
}
