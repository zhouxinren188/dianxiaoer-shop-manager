import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')

describe('店铺报表广告指标契约', () => {
  it('服务端按报表周期聚合快车消耗，并返回最新京准通余额', () => {
    const source = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8')
    expect(source).toContain('FROM jd_express_daily_spend spend')
    expect(source).toContain('spend.spend_date >= ? AND spend.spend_date <= ?')
    expect(source).toContain('MAX(express_status.jzt_balance) as jztBalance')
    expect(source).toContain('jztBalanceSyncedAt')
  })

  it('店铺报表展示快车消耗与京准通余额，未知值显示占位而不是零', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/src/views/report/StoreSalesReport.vue'),
      'utf8'
    )
    expect(source).toContain('label="快车消耗"')
    expect(source).toContain('label="京准通余额"')
    expect(source).toContain("if (value == null || value === '') return '--'")
  })
})
