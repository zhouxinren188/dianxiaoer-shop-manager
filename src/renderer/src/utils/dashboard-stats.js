const REQUIRED_PERIODS = ['today', 'yesterday', 'yesterdayFull', 'thisMonth', 'lastMonth', 'thisYear', 'lastYear']
const REQUIRED_NUMBER_FIELDS = ['salesAmount', 'orderCount', 'purchaseAmount', 'purchaseCount']

export function isDashboardStatsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  return REQUIRED_PERIODS.every((period) => {
    const values = payload[period]
    if (!values || typeof values !== 'object' || Array.isArray(values)) return false
    return REQUIRED_NUMBER_FIELDS.every((field) => Number.isFinite(Number(values[field])))
  })
}

export async function loadDashboardStatsWithRetry(fetchStats, options = {}) {
  const delays = Array.isArray(options.delays) ? options.delays : [0, 500, 1200]
  let lastError = null

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    const delay = Number(delays[attempt] || 0)
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      const payload = await fetchStats(attempt)
      if (!isDashboardStatsPayload(payload)) {
        throw new Error('经营统计响应不完整')
      }
      return payload
    } catch (error) {
      lastError = error
    }
  }

  throw lastError || new Error('经营统计加载失败')
}
