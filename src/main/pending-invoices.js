const MAX_PENDING_INVOICES_PER_STORE = 100
const PENDING_INVOICE_DEADLINE_MS = 10 * 24 * 60 * 60 * 1000

function toSafeText(value, maxLength = 200) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function toTimestamp(value) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.trunc(timestamp) : null
}

function normalizePendingInvoice(item) {
  const orderId = toSafeText(item?.orderId, 30)
  if (!/^\d{10,30}$/.test(orderId)) return null

  const amount = Number(item?.invoiceAmount)
  const applyTime = toTimestamp(item?.applyTime)
  return {
    orderId,
    invoiceTitle: toSafeText(item?.invoiceTitle),
    invoiceAmount: Number.isFinite(amount) && amount >= 0 ? amount : 0,
    companyName: toSafeText(item?.companyName),
    applyTime,
    countdownEndTime: applyTime ? applyTime + PENDING_INVOICE_DEADLINE_MS : null
  }
}

function extractPendingInvoices(apiResponse) {
  const responseData = apiResponse?.data
  const source = Array.isArray(responseData?.data) ? responseData.data : []
  const seen = new Set()
  const items = []

  for (const entry of source) {
    const invoice = normalizePendingInvoice(entry)
    if (!invoice || seen.has(invoice.orderId)) continue
    seen.add(invoice.orderId)
    items.push(invoice)
    if (items.length >= MAX_PENDING_INVOICES_PER_STORE) break
  }

  const parsedTotal = Number(responseData?.totalCount)
  return {
    total: Number.isSafeInteger(parsedTotal) && parsedTotal >= 0 ? parsedTotal : items.length,
    items
  }
}

module.exports = {
  MAX_PENDING_INVOICES_PER_STORE,
  PENDING_INVOICE_DEADLINE_MS,
  normalizePendingInvoice,
  extractPendingInvoices
}
