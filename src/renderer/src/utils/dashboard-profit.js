export const JD_COMMISSION_RATE = 0.08
export const CLOUD_SHIPPING_FEE_PER_ORDER = 10

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function roundMoney(value) {
  return Math.round((toFiniteNumber(value) + Number.EPSILON) * 100) / 100
}

export function calculateDashboardProfit(period = {}) {
  const salesAmount = toFiniteNumber(period.salesAmount)
  const purchaseAmount = toFiniteNumber(period.purchaseAmount)
  const cloudOrderCount = Math.max(0, Math.trunc(toFiniteNumber(period.cloudOrderCount)))
  const adSpendAvailable = period.adSpend !== null &&
    period.adSpend !== undefined &&
    period.adSpend !== '' &&
    Number.isFinite(Number(period.adSpend))
  const pendingCostOrderCount = Math.max(0, Math.trunc(toFiniteNumber(period.costPendingOrderCount)))
  const jdCommissionAmount = roundMoney(salesAmount * JD_COMMISSION_RATE)
  const cloudShippingAmount = roundMoney(cloudOrderCount * CLOUD_SHIPPING_FEE_PER_ORDER)

  if (!adSpendAvailable) {
    return {
      ...period,
      jdCommissionAmount,
      cloudShippingAmount,
      costComplete: pendingCostOrderCount === 0,
      estimatedProfit: null,
      estimatedProfitRate: null
    }
  }

  const adSpend = toFiniteNumber(period.adSpend)
  const estimatedProfit = roundMoney(
    salesAmount - purchaseAmount - jdCommissionAmount - cloudShippingAmount - adSpend
  )
  return {
    ...period,
    adSpend,
    jdCommissionAmount,
    cloudShippingAmount,
    costComplete: pendingCostOrderCount === 0,
    estimatedProfit,
    estimatedProfitRate: salesAmount > 0
      ? Math.round((estimatedProfit / salesAmount * 100 + Number.EPSILON) * 10) / 10
      : 0
  }
}
