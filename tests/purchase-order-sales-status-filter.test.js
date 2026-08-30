import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildPurchaseOrderSalesStatusFilter,
  getSalesOrderStatusVariants,
  normalizeStatusText
} = require('../server/services/purchase-order-sales-status-filter')

describe('采购订单关联销售交易状态筛选', () => {
  it('兼容销售订单接口的历史状态名称', () => {
    expect(getSalesOrderStatusVariants('待出库')).toEqual(['待出库', '等待出库'])
    expect(getSalesOrderStatusVariants('暂停订单')).toEqual(['暂停订单', '锁定', '暂停'])
    expect(getSalesOrderStatusVariants('已出库')).toEqual(['已出库', '已发货'])
    expect(getSalesOrderStatusVariants('已完成')).toEqual(['已完成'])
    expect(normalizeStatusText('锁定')).toBe('暂停订单')
    expect(normalizeStatusText('已发货')).toBe('已出库')
  })

  it('按销售订单主键或销售单号筛选，且不在销售订单索引列上做 CAST', () => {
    const filter = buildPurchaseOrderSalesStatusFilter({
      status: '待出库',
      ownerId: 42
    })

    expect(filter.sql).toContain('filter_so_id.id = CAST(po.sales_order_id AS UNSIGNED)')
    expect(filter.sql).toContain('filter_so_no.order_id = po.sales_order_no')
    expect(filter.sql).toContain('filter_store_id.owner_id = ?')
    expect(filter.sql).toContain('filter_store_no.owner_id = ?')
    expect(filter.sql).not.toContain('CAST(filter_so_id.id AS CHAR)')
    expect(filter.params).toEqual([42, '待出库', '等待出库', 42, '待出库', '等待出库'])
  })

  it('空状态不生成查询条件，并拒绝不安全的表别名', () => {
    expect(buildPurchaseOrderSalesStatusFilter({ status: '', ownerId: 1 })).toEqual({
      sql: '',
      params: []
    })
    expect(() => buildPurchaseOrderSalesStatusFilter({
      status: '已完成',
      ownerId: 1,
      purchaseAlias: 'po; DROP TABLE'
    })).toThrow('Invalid purchase order table alias')
  })

  it('采购页面传递筛选参数，服务端将条件应用到列表总数与状态统计', () => {
    const rendererSource = fs.readFileSync(
      path.resolve('src/renderer/src/views/purchase/PurchaseOrder.vue'),
      'utf8'
    )
    const serverSource = fs.readFileSync(path.resolve('server/index.js'), 'utf8')
    const publishSource = fs.readFileSync(path.resolve('scripts/publish-full.js'), 'utf8')

    expect(rendererSource).toContain('v-model="filterForm.salesOrderStatus"')
    expect(rendererSource).toContain("const salesOrderStatusOptions = ['待出库', '暂停订单', '已出库', '已完成', '已取消']")
    expect(rendererSource).not.toContain("const salesOrderStatusOptions = ['待付款'")
    expect(rendererSource).toContain('params.salesOrderStatus = filterForm.salesOrderStatus')

    expect(serverSource).toContain('salesOrderNo, salesOrderLogisticsNo, salesOrderReturnLogisticsNo, salesOrderStatus, purchaseType')
    expect(serverSource).toContain('sql += salesStatusFilter.sql')
    expect(serverSource).toContain('countSql += salesStatusFilter.sql')
    expect(serverSource).toContain('countByStatusSql += salesStatusFilter.sql')
    expect(serverSource).toContain('row.sales_order_status = normalizeStatusText(so.status_text)')

    expect(publishSource).toContain("services', 'purchase-order-sales-status-filter.js'")
  })
})
