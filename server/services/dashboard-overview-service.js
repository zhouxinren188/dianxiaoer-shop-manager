'use strict'

const JD_COMMISSION_RATE = 0.08
const CLOUD_SHIPPING_FEE_PER_ORDER = 10

const DASHBOARD_PERIODS = Object.freeze([
  { key: 'today', label: '今日', statsKey: 'today', comparisonStatsKey: 'yesterday', comparisonLabel: '昨日同期' },
  { key: 'yesterday', label: '昨日', statsKey: 'yesterdayFull', comparisonStatsKey: null, comparisonLabel: null },
  { key: 'month', label: '本月', statsKey: 'thisMonth', comparisonStatsKey: 'lastMonth', comparisonLabel: '上月同期' },
  { key: 'year', label: '本年', statsKey: 'thisYear', comparisonStatsKey: 'lastYear', comparisonLabel: '去年同期' }
])

const RAW_PERIOD_KEYS = Object.freeze([
  'today',
  'yesterday',
  'yesterdayFull',
  'thisMonth',
  'lastMonth',
  'thisYear',
  'lastYear'
])

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function roundMoney(value) {
  return Math.round((toFiniteNumber(value) + Number.EPSILON) * 100) / 100
}

function normalizeCount(value) {
  return Math.max(0, Math.trunc(toFiniteNumber(value)))
}

function calculateChangePercent(current, previous) {
  const currentValue = toFiniteNumber(current)
  const previousValue = toFiniteNumber(previous)
  if (previousValue === 0) return currentValue > 0 ? 100 : 0
  return Math.round(((currentValue - previousValue) / previousValue) * 1000) / 10
}

function enrichDashboardPeriod(period = {}) {
  const salesAmount = roundMoney(period.salesAmount)
  const orderCount = normalizeCount(period.orderCount)
  const orderCostAmount = roundMoney(period.orderCostAmount ?? period.purchaseAmount)
  const costKnownOrderCount = normalizeCount(period.costKnownOrderCount ?? period.purchaseCount)
  const costPendingOrderCount = normalizeCount(
    period.costPendingOrderCount ?? Math.max(0, orderCount - costKnownOrderCount)
  )
  const actualPurchaseAmount = roundMoney(period.actualPurchaseAmount)
  const actualPurchaseCount = normalizeCount(period.actualPurchaseCount)
  const cloudOrderCount = normalizeCount(period.cloudOrderCount)
  const adSpendAvailable = period.adSpend !== null &&
    period.adSpend !== undefined &&
    period.adSpend !== '' &&
    Number.isFinite(Number(period.adSpend))
  const adSpend = adSpendAvailable ? roundMoney(period.adSpend) : null
  const jdCommissionAmount = roundMoney(salesAmount * JD_COMMISSION_RATE)
  const cloudShippingAmount = roundMoney(cloudOrderCount * CLOUD_SHIPPING_FEE_PER_ORDER)
  const costComplete = costPendingOrderCount === 0
  const costCoveragePercent = orderCount > 0
    ? Math.round((Math.min(orderCount, costKnownOrderCount) / orderCount) * 1000) / 10
    : 100
  const adTotalStoreCount = normalizeCount(period.adTotalStoreCount)
  const adSyncedStoreCount = normalizeCount(period.adSyncedStoreCount)
  const adSpendStatus = !adSpendAvailable
    ? 'waiting_sync'
    : (adTotalStoreCount === 0
        ? 'not_applicable'
        : (adSyncedStoreCount < adTotalStoreCount ? 'partial' : 'ready'))

  if (!adSpendAvailable) {
    return {
      ...period,
      salesAmount,
      orderCount,
      purchaseAmount: orderCostAmount,
      purchaseCount: costKnownOrderCount,
      orderCostAmount,
      orderCostKnownOrderCount: costKnownOrderCount,
      orderCostPendingOrderCount: costPendingOrderCount,
      costKnownOrderCount,
      costPendingOrderCount,
      actualPurchaseAmount,
      actualPurchaseCount,
      cloudOrderCount,
      adSpend: null,
      adSpendAvailable: false,
      adSpendStatus,
      jdCommissionAmount,
      cloudShippingAmount,
      costComplete,
      costCoveragePercent,
      estimatedProfit: null,
      estimatedProfitRate: null,
      profitStatus: 'waiting_ad_spend'
    }
  }

  const estimatedProfit = roundMoney(
    salesAmount - orderCostAmount - jdCommissionAmount - cloudShippingAmount - adSpend
  )

  return {
    ...period,
    salesAmount,
    orderCount,
    purchaseAmount: orderCostAmount,
    purchaseCount: costKnownOrderCount,
    orderCostAmount,
    orderCostKnownOrderCount: costKnownOrderCount,
    orderCostPendingOrderCount: costPendingOrderCount,
    costKnownOrderCount,
    costPendingOrderCount,
    actualPurchaseAmount,
    actualPurchaseCount,
    cloudOrderCount,
    adSpend,
    adSpendAvailable: true,
    adSpendStatus,
    jdCommissionAmount,
    cloudShippingAmount,
    costComplete,
    costCoveragePercent,
    estimatedProfit,
    estimatedProfitRate: salesAmount > 0
      ? Math.round(((estimatedProfit / salesAmount) * 100 + Number.EPSILON) * 10) / 10
      : 0,
    profitStatus: costComplete ? 'ready' : 'partial_cost'
  }
}

function buildDashboardOverviewPayload(rawPeriods = {}, options = {}) {
  const periods = {}
  for (const key of RAW_PERIOD_KEYS) {
    periods[key] = enrichDashboardPeriod(rawPeriods[key] || {})
  }

  const displayPeriods = DASHBOARD_PERIODS.map((config) => {
    const current = periods[config.statsKey]
    const previous = config.comparisonStatsKey ? periods[config.comparisonStatsKey] : null
    return {
      ...config,
      hasComparison: Boolean(previous),
      salesChangePercent: previous
        ? calculateChangePercent(current.salesAmount, previous.salesAmount)
        : null,
      orderCostChangePercent: previous
        ? calculateChangePercent(current.orderCostAmount, previous.orderCostAmount)
        : null
    }
  })

  const generatedAt = options.now instanceof Date ? options.now : new Date()
  return {
    ...periods,
    overview: {
      contractVersion: 1,
      generatedAt: generatedAt.toISOString(),
      currency: 'CNY',
      defaultPeriod: 'today',
      metricOrder: ['salesAmount', 'orderCostAmount', 'adSpend', 'estimatedProfit'],
      metrics: [
        { key: 'salesAmount', label: '销售', nullable: false },
        { key: 'orderCostAmount', label: '订单成本', nullable: false },
        { key: 'adSpend', label: '快车消耗', nullable: true },
        { key: 'estimatedProfit', label: '预估毛利', nullable: true }
      ],
      displayPeriods,
      rules: {
        orderCostBasis: 'sales_order_date',
        actualPurchaseBasis: 'purchase_created_at',
        jdCommissionRate: JD_COMMISSION_RATE,
        cloudShippingFeePerOrder: CLOUD_SHIPPING_FEE_PER_ORDER,
        profitFormula: 'salesAmount-orderCostAmount-jdCommissionAmount-cloudShippingAmount-adSpend'
      }
    }
  }
}

module.exports = {
  CLOUD_SHIPPING_FEE_PER_ORDER,
  DASHBOARD_PERIODS,
  JD_COMMISSION_RATE,
  buildDashboardOverviewPayload,
  calculateChangePercent,
  enrichDashboardPeriod
}
