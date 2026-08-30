const INVALID_REFUND_TARGET_STATUSES = new Set([
  'pending',
  'cancelled',
  'failed',
  'purchase_failed',
  'unpaid'
])

function normalizeText(value) {
  return value == null ? '' : String(value).trim()
}

function normalizeStatus(value) {
  return normalizeText(value).toLowerCase()
}

function isEligibleRefundPurchase(purchase) {
  return !INVALID_REFUND_TARGET_STATUSES.has(normalizeStatus(purchase?.status))
}

function getPurchaseSalesOrderNo(purchase) {
  return normalizeText(purchase?.linked_sales_order_no || purchase?.sales_order_no)
}

function dedupePurchases(purchases) {
  const unique = new Map()
  for (const purchase of Array.isArray(purchases) ? purchases : []) {
    const key = normalizeText(purchase?.id || purchase?.purchase_no)
    if (key && !unique.has(key)) unique.set(key, purchase)
  }
  return [...unique.values()]
}

function groupReturnRecords(records) {
  const grouped = new Map()
  for (const record of Array.isArray(records) ? records : []) {
    const safeRecord = {
      store_id: Number(record?.store_id) || 0,
      store_name: normalizeText(record?.store_name),
      sales_order_no: normalizeText(record?.sales_order_no),
      jd_sku: normalizeText(record?.jd_sku),
      logistics_no: normalizeText(record?.logistics_no),
      logistics_company: normalizeText(record?.logistics_company),
      captured_at: record?.captured_at || null
    }
    if (!safeRecord.store_id || !safeRecord.sales_order_no || !safeRecord.logistics_no) continue

    const key = [
      safeRecord.store_id,
      safeRecord.sales_order_no,
      safeRecord.jd_sku,
      safeRecord.logistics_no
    ].join(':')
    const afsServiceId = normalizeText(record?.afs_service_id)
    const existing = grouped.get(key)
    if (existing) {
      if (afsServiceId && !existing.afs_service_ids.includes(afsServiceId)) {
        existing.afs_service_ids.push(afsServiceId)
      }
      if (record?.captured_at && (!existing.captured_at || record.captured_at > existing.captured_at)) {
        existing.captured_at = record.captured_at
      }
      continue
    }
    grouped.set(key, {
      ...safeRecord,
      afs_service_ids: afsServiceId ? [afsServiceId] : []
    })
  }
  return [...grouped.values()]
}

function matchReturnRecordToPurchases(record, purchases) {
  const salesOrderNo = normalizeText(record?.sales_order_no)
  const jdSku = normalizeText(record?.jd_sku)
  const orderPurchases = dedupePurchases(purchases).filter(
    (purchase) => getPurchaseSalesOrderNo(purchase) === salesOrderNo
  )
  const eligibleOrderPurchases = orderPurchases.filter(isEligibleRefundPurchase)
  const eligibleExactPurchases = jdSku
    ? eligibleOrderPurchases.filter((purchase) => normalizeText(purchase?.sku) === jdSku)
    : []

  let matchMode = 'not_found'
  let needsManualReview = true
  let matches = []

  if (eligibleExactPurchases.length === 1) {
    matchMode = 'exact'
    needsManualReview = false
    matches = eligibleExactPurchases
  } else if (eligibleExactPurchases.length > 1) {
    matchMode = 'exact_multiple'
    matches = eligibleExactPurchases
  } else if (eligibleOrderPurchases.length > 0) {
    matchMode = 'sales_order_fallback'
    matches = eligibleOrderPurchases
  }

  return {
    ...record,
    match_mode: matchMode,
    needs_manual_review: needsManualReview,
    matches,
    candidate_count: matches.length,
    excluded_purchase_count: orderPurchases.length - eligibleOrderPurchases.length
  }
}

function buildReturnPackageLookup(records, purchases) {
  const groupedRecords = groupReturnRecords(records)
  const uniquePurchases = dedupePurchases(purchases)
  const packages = groupedRecords.map((record) => matchReturnRecordToPurchases(record, uniquePurchases))
  const matchedPurchaseIds = new Set()
  for (const packageRecord of packages) {
    for (const purchase of packageRecord.matches) {
      const key = normalizeText(purchase?.id || purchase?.purchase_no)
      if (key) matchedPurchaseIds.add(key)
    }
  }
  return {
    packages,
    package_count: packages.length,
    matched_purchase_count: matchedPurchaseIds.size,
    needs_manual_review: packages.some((record) => record.needs_manual_review)
  }
}

module.exports = {
  INVALID_REFUND_TARGET_STATUSES,
  isEligibleRefundPurchase,
  matchReturnRecordToPurchases,
  buildReturnPackageLookup
}
