'use strict'

const DEFAULT_FRESHNESS_MS = 3 * 60 * 60 * 1000

function toNonNegativeNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function toNonNegativeInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback
}

function normalizeDate(value) {
  if (!value) return ''
  if (typeof value === 'string') return value.slice(0, 10)
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function getYesterdayYmd(now = new Date()) {
  const date = new Date(now)
  date.setDate(date.getDate() - 1)
  return normalizeDate(date)
}

function normalizeSettlementMetrics(input = {}) {
  const walletBalance = toNonNegativeNumber(input.walletBalance)
  const frozenAmount = Math.min(walletBalance, toNonNegativeNumber(input.frozenAmount))
  const suppliedWithdrawable = Number(input.withdrawableAmount)
  const withdrawableAmount = Number.isFinite(suppliedWithdrawable) && suppliedWithdrawable >= 0
    ? Math.min(walletBalance, suppliedWithdrawable)
    : Math.max(0, walletBalance - frozenAmount)

  return {
    pendingAmount: toNonNegativeNumber(input.pendingAmount),
    pendingOrderCount: toNonNegativeInteger(input.pendingOrderCount),
    yesterdaySettledAmount: toNonNegativeNumber(input.yesterdaySettledAmount),
    walletBalance,
    frozenAmount,
    withdrawableAmount,
    statisticsDate: normalizeDate(input.statisticsDate)
  }
}

function buildSettlementOverview(rows = [], options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now())
  const targetStatisticsDate = options.statisticsDate || getYesterdayYmd(now)
  const freshnessMs = Number(options.freshnessMs) > 0
    ? Number(options.freshnessMs)
    : DEFAULT_FRESHNESS_MS

  const list = rows.map(row => {
    const hasData = Boolean(row.updated_at)
    const updatedAt = hasData ? new Date(row.updated_at) : null
    const updatedAtMs = updatedAt && Number.isFinite(updatedAt.getTime()) ? updatedAt.getTime() : 0
    const metrics = normalizeSettlementMetrics({
      pendingAmount: row.pending_amount,
      pendingOrderCount: Number(row.pending_order_count),
      yesterdaySettledAmount: row.yesterday_settled_amount,
      walletBalance: row.wallet_balance,
      frozenAmount: row.frozen_amount,
      withdrawableAmount: row.withdrawable_amount,
      statisticsDate: row.statistics_date
    })
    const statisticsCurrent = metrics.statisticsDate === targetStatisticsDate
    const stale = !hasData || !updatedAtMs || now.getTime() - updatedAtMs > freshnessMs || !statisticsCurrent

    return {
      storeId: Number(row.store_id),
      storeName: String(row.store_name || ''),
      hasData,
      stale,
      statisticsCurrent,
      updatedAt: hasData ? row.updated_at : null,
      ...metrics,
      yesterdaySettledAmount: statisticsCurrent ? metrics.yesterdaySettledAmount : null
    }
  })

  const available = list.filter(item => item.hasData)
  const currentYesterday = available.filter(item => item.statisticsCurrent)
  const sum = (items, field) => items.reduce((total, item) => total + toNonNegativeNumber(item[field]), 0)
  const latestUpdatedAt = available.reduce((latest, item) => {
    const time = new Date(item.updatedAt).getTime()
    return Number.isFinite(time) && time > latest.time ? { time, value: item.updatedAt } : latest
  }, { time: 0, value: null }).value

  return {
    summary: {
      pendingAmount: sum(available, 'pendingAmount'),
      pendingOrderCount: available.reduce((total, item) => total + item.pendingOrderCount, 0),
      yesterdaySettledAmount: sum(currentYesterday, 'yesterdaySettledAmount'),
      walletBalance: sum(available, 'walletBalance'),
      frozenAmount: sum(available, 'frozenAmount'),
      withdrawableAmount: sum(available, 'withdrawableAmount'),
      storeCount: list.length,
      matchedStoreCount: available.length,
      yesterdayMatchedStoreCount: currentYesterday.length,
      staleStoreCount: list.filter(item => item.stale).length,
      statisticsDate: targetStatisticsDate,
      updatedAt: latestUpdatedAt
    },
    list
  }
}

module.exports = {
  DEFAULT_FRESHNESS_MS,
  buildSettlementOverview,
  getYesterdayYmd,
  normalizeSettlementMetrics
}
