import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isDashboardStatsPayload, loadDashboardStatsWithRetry } from '../src/renderer/src/utils/dashboard-stats'

const serverSource = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
const dbSource = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8')
const homeSource = readFileSync(new URL('../src/renderer/src/views/home/HomePage.vue', import.meta.url), 'utf8')
const requestSource = readFileSync(new URL('../src/renderer/src/api/request.js', import.meta.url), 'utf8')

function createDashboardPayload(purchaseAmount = 332.27) {
  const period = { salesAmount: 0, orderCount: 0, purchaseAmount, purchaseCount: 9 }
  return {
    today: { ...period },
    yesterday: { ...period },
    yesterdayFull: { ...period },
    thisMonth: { ...period },
    lastMonth: { ...period },
    thisYear: { ...period },
    lastYear: { ...period }
  }
}

describe('首页采购统计', () => {
  it('可切换展示本月与今日订单成本和成本覆盖情况', () => {
    expect(homeSource).toContain('<el-radio-button label="month">本月</el-radio-button>')
    expect(homeSource).toContain('<el-radio-button label="today">今日</el-radio-button>')
    expect(homeSource).toContain('<el-radio-button label="yesterday">昨日</el-radio-button>')
    expect(homeSource).toContain('{{ overviewPeriodLabel }}订单成本')
    expect(homeSource).toContain('activeOverviewStats.purchaseAmount')
    expect(homeSource).toContain('formatOrderCostCoverage(activeOverviewStats)')
  })

  it('昨日使用完整自然日数据且不混用昨日同期', () => {
    expect(homeSource).toContain("yesterday: { current: 'yesterdayFull', previous: null")
    expect(serverSource).toContain('AND so.order_time < CURDATE()')
    expect(serverSource).toContain('AS yesterday_full_amt')
    expect(serverSource).toContain('AS yesterday_full_cnt')
    expect(serverSource).toContain('yesterdayFull: fmt(r7, fmtWh(whYesterday)')
  })

  it('经营概览支持手动从服务器刷新', () => {
    expect(homeSource).toContain('aria-label="刷新经营概览"')
    expect(homeSource).toContain('async function refreshOverviewStats()')
    expect(homeSource).toContain("loadStats({ force: true })")
    expect(homeSource).toContain("force || attempt > 0 ? { _ts: Date.now() } : undefined")
  })

  it('登录恢复窗口内首次请求失败时会重试并校验完整统计响应', async () => {
    let attempts = 0
    const result = await loadDashboardStatsWithRetry(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('未登录或 token 无效')
      return createDashboardPayload()
    }, { delays: [0, 0] })

    expect(attempts).toBe(2)
    expect(result.today.purchaseAmount).toBe(332.27)
    expect(isDashboardStatsPayload({ code: 1, message: '未登录或 token 无效' })).toBe(false)
    expect(homeSource).toContain('loadDashboardStatsWithRetry')
  })

  it('公共请求封装不再把未登录响应伪装成成功数据', () => {
    expect(requestSource).not.toContain('401 未登录错误不抛出，由调用方处理')
    expect(requestSource).toContain('isAuthSessionFailure(res, json)')
    expect(requestSource).toContain('response?.status === 401')
    expect(requestSource).toContain("window.dispatchEvent(new CustomEvent('force-logout'")
    expect(requestSource).toContain('err.httpStatus = res.status')
  })

  it('优先统计实付总额并为旧采购单回退计算金额', () => {
    expect(serverSource).toContain('WHEN COALESCE(po.total_amount, 0) > 0 THEN po.total_amount')
    expect(serverSource).toContain('COALESCE(po.purchase_price, 0) * COALESCE(po.quantity, 0) + COALESCE(po.shipping_fee, 0)')
    expect(serverSource).toContain("po.status NOT IN ('ordered', 'cancelled', 'refunded')")
    expect(serverSource).toContain('actualPurchaseAmount: Number(actualPurchaseAmount || 0)')
    expect(serverSource).toContain('actualPurchaseCount: Number(actualPurchaseCount || 0)')
  })

  it('等待付款订单不计入，后续同步为已付款状态后再纳入', () => {
    expect(serverSource).toContain('ordered 表示等待付款/已下单未付款，不计入经营采购数据')
    expect(serverSource).toContain("po.status NOT IN ('ordered', 'cancelled', 'refunded')")
  })

  it('订单成本按销售日期归集并单独保留实际采购支出', () => {
    expect(serverSource).toContain('昨日销售、今日补采不会冲减今日毛利')
    expect(serverSource).toContain('AS order_cost')
    expect(serverSource).toContain('actualPurchaseAmount: Number(actualPurchaseAmount || 0)')
    expect(serverSource).toContain('costPendingOrderCount: Math.max(0, orderCount - costKnownOrderCount)')
    expect(serverSource).toContain('inventory_item.price * COALESCE(sales.quantity, 0)')
  })

  it('子账号采购统计跟随可访问店铺而不是采购账号权限', () => {
    expect(serverSource).toContain('const purchaseStorePlaceholders = storeIds.map')
    expect(serverSource).toContain('visible_sales_by_no.store_id IN (${purchaseStorePlaceholders})')
    expect(serverSource).toContain('visible_sales_by_no.order_id = po.sales_order_no')
    expect(serverSource).toContain("visible_sales_by_id.id = CAST(NULLIF(po.sales_order_id, '') AS UNSIGNED)")
    expect(serverSource).not.toContain('upa.account_id = po.account_id AND upa.user_id = ?\n           )\n           OR (po.account_id IS NULL')
    expect(dbSource).toContain('idx_purchase_owner_created')
  })
})
