import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('采购单关联销售订单详情入口', () => {
  it('在采购订单卡片销售单号后提供查看详情并使用对应店铺浏览器', () => {
    const source = fs.readFileSync(path.resolve('src/renderer/src/views/purchase/PurchaseOrder.vue'), 'utf8')

    expect(source).toContain('class="sales-order-detail-link"')
    expect(source).toContain('>查看详情</el-button>')
    expect(source).toContain('async function handleSalesOrderDetail(row)')
    expect(source).toContain('await fetchRelatedSales(row.id)')
    expect(source).toContain("invoke('open-store-backend-url'")
    expect(source).toContain('/jdm/trade/orders/order-details?orderId=')
    expect(source).toContain('focusExisting: false')
  })

  it('销售订单列表查看入口统一进入具备采购面板的店铺浏览器', () => {
    const source = fs.readFileSync(path.resolve('src/renderer/src/views/sales/OrderList.vue'), 'utf8')
    const start = source.indexOf('function handleView(row)')
    const end = source.indexOf('// 判断订单是否为代销订单', start)
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(handler).toContain("invoke('open-store-backend-url'")
    expect(handler).toContain('/jdm/trade/orders/order-details?orderId=')
    expect(handler).not.toContain("invoke('open-jd-order-detail'")
  })
})
