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

  it('首页在快车消耗更新后实时计算毛利', () => {
    expect(homeSource).toContain('calculateDashboardProfit(')
    expect(homeSource).toContain('{{ overviewPeriodLabel }}预估毛利')
    expect(homeSource).toContain("'is-negative'")
  })

  it('云仓成本按店铺所属且已绑定机器码的仓库统计', () => {
    expect(serverSource).toContain('INNER JOIN cloud_warehouse_machine_bindings cloud_binding')
    expect(serverSource).toContain('cloud_binding.warehouse_id = cloud_store.cloud_warehouse_id')
    expect(serverSource).toContain('cloudOrderCount: Number(r[0].cloud_cnt || 0)')
  })
})
