import fs from 'fs'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync('src/renderer/src/views/sales/OrderList.vue', 'utf8')

describe('采购下单弹窗销售单上下文', () => {
  it('展示当前销售单仓库和订单状态', () => {
    expect(source).toContain('class="sales-order-context-banner"')
    expect(source).toContain("purchaseInfo.salesWarehouseName || '未设置'")
    expect(source).toContain("purchaseInfo.salesOrderStatus || '未知'")
    expect(source).toContain('orderStatusTagType(purchaseInfo.salesOrderStatus)')
  })

  it('从点击的销售订单复制仓库和状态，不复用采购收货仓库', () => {
    expect(source).toContain("purchaseInfo.salesWarehouseName = order.warehouseName || ''")
    expect(source).toContain("purchaseInfo.salesOrderStatus = order.orderStatus || ''")
    expect(source).toContain("purchaseInfo.warehouseName = ''")
  })

  it('明确提示用户判断代发或仓库转发', () => {
    expect(source).toContain('请据此确认下方选择三方代发或仓库转发')
  })
})
