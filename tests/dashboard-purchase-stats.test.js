import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const serverSource = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
const dbSource = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8')
const homeSource = readFileSync(new URL('../src/renderer/src/views/home/HomePage.vue', import.meta.url), 'utf8')

describe('首页采购统计', () => {
  it('可切换展示本月与今日采购金额和采购单数', () => {
    expect(homeSource).toContain('<el-radio-button label="month">本月</el-radio-button>')
    expect(homeSource).toContain('<el-radio-button label="today">今日</el-radio-button>')
    expect(homeSource).toContain('{{ overviewPeriodLabel }}采购')
    expect(homeSource).toContain('activeOverviewStats.purchaseAmount')
    expect(homeSource).toContain('formatPurchaseCount(activeOverviewStats)')
  })

  it('优先统计实付总额并为旧采购单回退计算金额', () => {
    expect(serverSource).toContain('WHEN COALESCE(po.total_amount, 0) > 0 THEN po.total_amount')
    expect(serverSource).toContain('COALESCE(po.purchase_price, 0) * COALESCE(po.quantity, 0) + COALESCE(po.shipping_fee, 0)')
    expect(serverSource).toContain("po.status NOT IN ('cancelled', 'refunded')")
    expect(serverSource).toContain('purchaseAmount: Number(purchaseAmount || 0)')
    expect(serverSource).toContain('purchaseCount: Number(purchaseCount || 0)')
  })

  it('子账号采购统计沿用采购账号权限并使用日期索引', () => {
    expect(serverSource).toContain('EXISTS (')
    expect(serverSource).toContain('FROM user_purchase_accounts upa')
    expect(serverSource).toContain('upa.account_id = po.account_id AND upa.user_id = ?')
    expect(dbSource).toContain('idx_purchase_owner_created')
  })
})
