'use strict'

const {
  MAX_PENDING_INVOICES_PER_STORE,
  normalizePendingInvoice
} = require('./pending-invoices')

const PENDING_METRIC_CHANNEL = 'store-backend-pending-metric-observed'
const PENDING_VIOLATION_METRIC = 'pending_violations'
const PENDING_VIOLATION_API = 'dsm.pop.legal.shop.api.dsm.VednerPenaltyApiService.queryManualVenderPenaltyList'
const PENDING_FOLLOW_UP_METRIC = 'pending_follow_ups'
const PENDING_FOLLOW_UP_API = 'dsm.seller.around.center.soa.service.dsm.OrderDeliveryCuidanDsmService.queryCuiDanListByPage'
const PENDING_INVOICE_METRIC = 'pending_consumer_invoices'
const PENDING_INVOICE_API = 'dsm.pop.finance.vendor.spi.cinvoice.ApplyOrderDsmProvider.queryPendingReviewApplyOrderList'

function isPendingViolationPageUrl(value) {
  try {
    const target = new URL(String(value || ''))
    return target.protocol === 'https:'
      && target.hostname.toLowerCase() === 'illegal-jdm.shop.jd.com'
      && /^\/legal(?:\/|$)/i.test(target.pathname)
  } catch (_error) {
    return false
  }
}

function isPendingFollowUpPageUrl(value) {
  try {
    const target = new URL(String(value || ''))
    return target.protocol === 'https:'
      && target.hostname.toLowerCase() === 'shop.jd.com'
      && /^\/jdm\/trade\/risk\/warning-center(?:\/|$)/i.test(target.pathname)
  } catch (_error) {
    return false
  }
}

function isPendingInvoicePageUrl(value) {
  try {
    const target = new URL(String(value || ''))
    return target.protocol === 'https:'
      && target.hostname.toLowerCase() === 'shop.jd.com'
      && /^\/jdm\/finance\/consumerInvoice\/cinvoiceOrder(?:\/|$)/i.test(target.pathname)
  } catch (_error) {
    return false
  }
}

function isPendingMetricPageUrl(metric, value) {
  if (metric === PENDING_VIOLATION_METRIC) return isPendingViolationPageUrl(value)
  if (metric === PENDING_FOLLOW_UP_METRIC) return isPendingFollowUpPageUrl(value)
  if (metric === PENDING_INVOICE_METRIC) return isPendingInvoicePageUrl(value)
  return false
}

function normalizePendingMetricObservation(payload) {
  if (!payload || typeof payload !== 'object') return null

  if (payload.metric === PENDING_INVOICE_METRIC) {
    if (payload.api !== PENDING_INVOICE_API || payload.evidence !== 'response_capture') return null
    const value = Number(payload.value)
    if (!Number.isSafeInteger(value) || value < 0 || value > 1000000) return null

    const invoices = []
    const seen = new Set()
    const source = Array.isArray(payload.invoices) ? payload.invoices : []
    for (const item of source) {
      const invoice = normalizePendingInvoice(item)
      if (!invoice || seen.has(invoice.orderId)) continue
      seen.add(invoice.orderId)
      invoices.push(invoice)
      if (invoices.length >= MAX_PENDING_INVOICES_PER_STORE) break
    }
    if (invoices.length > value) return null

    return {
      metric: PENDING_INVOICE_METRIC,
      value,
      api: PENDING_INVOICE_API,
      invoices,
      evidence: payload.evidence,
      observedAt: Number.isFinite(Number(payload.observedAt))
        ? Number(payload.observedAt)
        : Date.now()
    }
  }

  if (payload.metric === PENDING_FOLLOW_UP_METRIC) {
    if (payload.api !== PENDING_FOLLOW_UP_API) return null
    if (!['active_query', 'response_capture'].includes(payload.evidence)) return null
    const query = payload.query && typeof payload.query === 'object' ? payload.query : {}
    if (Number(query.handlingState) !== 0) return null
    const value = Number(payload.value)
    if (!Number.isSafeInteger(value) || value < 0 || value > 1000000) return null
    return {
      metric: PENDING_FOLLOW_UP_METRIC,
      value,
      api: PENDING_FOLLOW_UP_API,
      handlingState: 0,
      evidence: payload.evidence,
      observedAt: Number.isFinite(Number(payload.observedAt))
        ? Number(payload.observedAt)
        : Date.now()
    }
  }

  if (payload.metric !== PENDING_VIOLATION_METRIC) return null
  if (payload.api !== PENDING_VIOLATION_API) return null
  if (!['active_query', 'pending_tab_label', 'response_fallback'].includes(payload.evidence)) return null

  const query = payload.query && typeof payload.query === 'object' ? payload.query : {}
  const checkStatusSet = Array.isArray(query.checkStatusSet)
    ? query.checkStatusSet.map(Number)
    : []
  if (!checkStatusSet.includes(6)
    || Number(query.penaltyType) !== 1
    || String(query.radio1 || '').trim() !== '待处理') {
    return null
  }

  const value = Number(payload.value)
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000000) return null

  return {
    metric: PENDING_VIOLATION_METRIC,
    value,
    api: PENDING_VIOLATION_API,
    radio1: '待处理',
    evidence: payload.evidence,
    observedAt: Number.isFinite(Number(payload.observedAt))
      ? Number(payload.observedAt)
      : Date.now()
  }
}

module.exports = {
  PENDING_METRIC_CHANNEL,
  PENDING_VIOLATION_METRIC,
  PENDING_VIOLATION_API,
  PENDING_FOLLOW_UP_METRIC,
  PENDING_FOLLOW_UP_API,
  PENDING_INVOICE_METRIC,
  PENDING_INVOICE_API,
  isPendingViolationPageUrl,
  isPendingFollowUpPageUrl,
  isPendingInvoicePageUrl,
  isPendingMetricPageUrl,
  normalizePendingMetricObservation
}
