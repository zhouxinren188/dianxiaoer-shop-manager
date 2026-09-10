import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildDashboardOverviewPayload,
  enrichDashboardPeriod
} = require('../server/services/dashboard-overview-service')

const serverSource = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
const publishSource = readFileSync(new URL('../scripts/publish-full.js', import.meta.url), 'utf8')

describe('小程序经营概览接口', () => {
  it('由服务端返回与桌面首页一致的毛利明细及完整度', () => {
    expect(enrichDashboardPeriod({
      salesAmount: 1000,
      orderCount: 10,
      purchaseAmount: 600,
      costKnownOrderCount: 8,
      costPendingOrderCount: 2,
      actualPurchaseAmount: 650,
      actualPurchaseCount: 9,
      cloudOrderCount: 10,
      adSpend: 50,
      adSyncedStoreCount: 2,
      adTotalStoreCount: 3
    })).toMatchObject({
      orderCostAmount: 600,
      orderCostKnownOrderCount: 8,
      orderCostPendingOrderCount: 2,
      costCoveragePercent: 80,
      jdCommissionAmount: 80,
      cloudShippingAmount: 100,
      estimatedProfit: 170,
      estimatedProfitRate: 17,
      profitStatus: 'partial_cost',
      adSpendStatus: 'partial'
    })
  })

  it('快车消耗未知时明确返回空毛利，避免小程序展示虚高数据', () => {
    expect(enrichDashboardPeriod({
      salesAmount: 1000,
      purchaseAmount: 600,
      cloudOrderCount: 10,
      adSpend: null
    })).toMatchObject({
      adSpendAvailable: false,
      estimatedProfit: null,
      estimatedProfitRate: null,
      profitStatus: 'waiting_ad_spend'
    })
  })

  it('一次返回今日、昨日、本月、本年配置及同期涨跌参数', () => {
    const period = {
      orderCount: 2,
      purchaseCount: 2,
      costPendingOrderCount: 0,
      cloudOrderCount: 0,
      adSpend: 0
    }
    const payload = buildDashboardOverviewPayload({
      today: { ...period, salesAmount: 100, purchaseAmount: 60 },
      yesterday: { ...period, salesAmount: 80, purchaseAmount: 50 },
      yesterdayFull: { ...period, salesAmount: 90, purchaseAmount: 55 },
      thisMonth: { ...period, salesAmount: 1000, purchaseAmount: 600 },
      lastMonth: { ...period, salesAmount: 800, purchaseAmount: 500 },
      thisYear: { ...period, salesAmount: 5000, purchaseAmount: 3000 },
      lastYear: { ...period, salesAmount: 4000, purchaseAmount: 2500 }
    }, { now: new Date('2026-09-10T06:00:00.000Z') })

    expect(payload.overview).toMatchObject({
      contractVersion: 1,
      generatedAt: '2026-09-10T06:00:00.000Z',
      currency: 'CNY',
      defaultPeriod: 'today',
      metricOrder: ['salesAmount', 'orderCostAmount', 'adSpend', 'estimatedProfit']
    })
    expect(payload.overview.displayPeriods.map((item) => item.label)).toEqual(['今日', '昨日', '本月', '本年'])
    expect(payload.overview.displayPeriods[0]).toMatchObject({
      statsKey: 'today',
      comparisonStatsKey: 'yesterday',
      salesChangePercent: 25,
      orderCostChangePercent: 20
    })
    expect(payload.overview.displayPeriods[1]).toMatchObject({
      statsKey: 'yesterdayFull',
      hasComparison: false,
      salesChangePercent: null
    })
  })

  it('新旧接口共享处理器，并确保新增服务会随全量版本部署', () => {
    expect(serverSource).toContain("app.get('/api/dashboard-stats', handleDashboardStats)")
    expect(serverSource).toContain("app.get('/api/dashboard/operating-overview', handleDashboardStats)")
    expect(serverSource).toContain('buildDashboardOverviewPayload(dashboardPeriods)')
    expect(publishSource).toContain("'dashboard-overview-service.js'")
  })
})
