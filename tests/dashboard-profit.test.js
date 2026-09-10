import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CLOUD_SHIPPING_FEE_PER_ORDER,
  JD_COMMISSION_RATE,
  calculateDashboardProfit
} from '../src/renderer/src/utils/dashboard-profit'

const homeSource = readFileSync(new URL('../src/renderer/src/views/home/HomePage.vue', import.meta.url), 'utf8')
const serverSource = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')

describe('首页预估毛利', () => {
  it('扣除采购含运费、8%京东佣金、云仓运费和快车消耗', () => {
    const result = calculateDashboardProfit({
      salesAmount: 1000,
      purchaseAmount: 600,
      cloudOrderCount: 10,
      adSpend: 50
    })
    expect(JD_COMMISSION_RATE).toBe(0.08)
    expect(CLOUD_SHIPPING_FEE_PER_ORDER).toBe(10)
    expect(result).toMatchObject({
      jdCommissionAmount: 80,
      cloudShippingAmount: 100,
      estimatedProfit: 170,
      estimatedProfitRate: 17
    })
  })

  it('快车消耗尚未同步时不展示可能高估的毛利', () => {
    expect(calculateDashboardProfit({
      salesAmount: 1000,
      purchaseAmount: 600,
      cloudOrderCount: 10,
      adSpend: null
    })).toMatchObject({
      jdCommissionAmount: 80,
      cloudShippingAmount: 100,
      estimatedProfit: null,
      estimatedProfitRate: null
    })
  })

  it('销售订单成本未归集完整时仍展示暂估毛利并标记口径不完整', () => {
    expect(calculateDashboardProfit({
      salesAmount: 1000,
      purchaseAmount: 300,
      costPendingOrderCount: 2,
      cloudOrderCount: 0,
      adSpend: 50
    })).toMatchObject({
      costComplete: false,
      estimatedProfit: 570,
      estimatedProfitRate: 57
    })
  })

  it('首页在快车消耗更新后实时计算毛利', () => {
    expect(homeSource).toContain('calculateDashboardProfit(')
    expect(homeSource).toContain('{{ overviewPeriodLabel }}预估毛利')
    expect(homeSource).toContain('{{ overviewPeriodLabel }}订单成本')
    expect(homeSource).toContain('formatOrderCostCoverage(activeOverviewStats)')
    expect(homeSource).toContain('formatActualPurchaseNote(activeOverviewStats)')
    expect(homeSource).toContain('跨日采购回算到销售日')
    expect(homeSource).toContain('部分成本暂估值')
    expect(homeSource).toContain('单成本待归集')
    expect(homeSource).toContain("'is-negative'")
  })

  it('默认展示当日，计算口径仅在毛利标题问号中悬浮展示', () => {
    expect(homeSource).toContain("const overviewPeriod = ref('today')")
    expect(homeSource).toContain('class="overview-profit-help"')
    expect(homeSource).not.toContain('class="overview-rule"')
  })

  it('经营周期按今日、昨日、本月、本年排序并使用对应同期数据', () => {
    const todayIndex = homeSource.indexOf('<el-radio-button label="today">今日</el-radio-button>')
    const yesterdayIndex = homeSource.indexOf('<el-radio-button label="yesterday">昨日</el-radio-button>')
    const monthIndex = homeSource.indexOf('<el-radio-button label="month">本月</el-radio-button>')
    const yearIndex = homeSource.indexOf('<el-radio-button label="year">本年</el-radio-button>')
    expect(todayIndex).toBeGreaterThan(-1)
    expect(todayIndex).toBeLessThan(yesterdayIndex)
    expect(yesterdayIndex).toBeLessThan(monthIndex)
    expect(monthIndex).toBeLessThan(yearIndex)
    expect(homeSource).toContain("year: { current: 'thisYear', previous: 'lastYear', label: '本年', compareLabel: '去年同期' }")
    expect(homeSource).toContain('getLatestLocalJdExpressPeriods')
    expect(serverSource).toContain('FROM jd_express_daily_spend')
    expect(homeSource).not.toContain('result.yearSpend')
    expect(serverSource).toContain('thisYear: fmt(r5')
    expect(serverSource).toContain('lastYear: fmt(r6')
  })

  it('销售趋势模块比原高度增加50像素', () => {
    expect(homeSource).toContain('class="chart-body sales-trend-body"')
    expect(homeSource).toContain('const chartH = 370')
    expect(homeSource).toContain('.sales-trend-body {\n  min-height: 310px;')
  })

  it('云仓成本按店铺所属且已绑定机器码的仓库统计', () => {
    expect(serverSource).toContain('INNER JOIN cloud_warehouse_machine_bindings cloud_binding')
    expect(serverSource).toContain('cloud_binding.warehouse_id = cloud_store.cloud_warehouse_id')
    expect(serverSource).toContain('cloudOrderCount: Number(r[0].cloud_cnt || 0)')
  })

  it('单个未知或失败店铺不隐藏已同步快车店铺的历史消耗', () => {
    expect(serverSource).toContain('const hasStoredAdSpend = Boolean(adSpend.first_date)')
    expect(serverSource).toContain('jdStoreCount === 0 || hasStoredAdSpend || syncedStoreCount > 0')
    expect(serverSource).toContain('adTotalStoreCount: activeStoreCount + unknownStoreCount')
    expect(serverSource).not.toContain('syncedStoreCount === activeStoreCount')
  })
})
