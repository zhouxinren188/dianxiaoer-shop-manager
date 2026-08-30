import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildPurchaseOrderSalesLogisticsFilter,
  buildPurchaseOrderSalesReturnLogisticsFilter
} = require('../server/services/purchase-order-sales-status-filter')

describe('采购订单关联销售物流筛选', () => {
  it('按销售订单主键或销售单号查询发货物流，并隔离所属用户', () => {
    const filter = buildPurchaseOrderSalesLogisticsFilter({ logisticsNo: '  JT123  ', ownerId: 42 })

    expect(filter.sql).toContain('filter_so_log_id.id = CAST(po.sales_order_id AS UNSIGNED)')
    expect(filter.sql).toContain('filter_so_log_no.order_id = po.sales_order_no')
    expect(filter.sql).toContain('filter_store_log_id.owner_id = ?')
    expect(filter.sql).toContain('filter_store_log_no.owner_id = ?')
    expect(filter.sql).toContain('logistics_no LIKE ?')
    expect(filter.params).toEqual([42, '%JT123%', 42, '%JT123%'])
  })

  it('按销售订单主键或销售单号查询退货物流，并隔离所属用户', () => {
    const filter = buildPurchaseOrderSalesReturnLogisticsFilter({ logisticsNo: ' SF987 ', ownerId: 7 })

    expect(filter.sql).toContain('INNER JOIN sales_return_logistics filter_return_id')
    expect(filter.sql).toContain('filter_so_return_id.id = CAST(po.sales_order_id AS UNSIGNED)')
    expect(filter.sql).toContain('filter_return_no.sales_order_no = po.sales_order_no')
    expect(filter.sql).toContain('filter_return_id.logistics_no LIKE ?')
    expect(filter.sql).toContain('filter_return_no.logistics_no LIKE ?')
    expect(filter.params).toEqual([7, '%SF987%', 7, '%SF987%'])
  })

  it('空物流单号不生成条件，并拒绝不安全的表别名', () => {
    expect(buildPurchaseOrderSalesLogisticsFilter({ logisticsNo: '', ownerId: 1 })).toEqual({ sql: '', params: [] })
    expect(buildPurchaseOrderSalesReturnLogisticsFilter({ logisticsNo: '   ', ownerId: 1 })).toEqual({ sql: '', params: [] })
    expect(() => buildPurchaseOrderSalesLogisticsFilter({
      logisticsNo: 'JT123', ownerId: 1, purchaseAlias: 'po; DROP TABLE'
    })).toThrow('Invalid purchase order table alias')
  })

  it('前后端接入两种物流筛选，空退货物流不展示名称', () => {
    const rendererSource = fs.readFileSync(path.resolve('src/renderer/src/views/purchase/PurchaseOrder.vue'), 'utf8')
    const orderListSource = fs.readFileSync(path.resolve('src/renderer/src/views/sales/OrderList.vue'), 'utf8')
    const serverSource = fs.readFileSync(path.resolve('server/index.js'), 'utf8')

    expect(rendererSource).toContain('v-model="filterForm.salesOrderLogisticsNo"')
    expect(rendererSource).toContain('v-model="filterForm.salesOrderReturnLogisticsNo"')
    expect(rendererSource).toContain('params.salesOrderLogisticsNo = filterForm.salesOrderLogisticsNo')
    expect(rendererSource).toContain('params.salesOrderReturnLogisticsNo = filterForm.salesOrderReturnLogisticsNo')
    expect(serverSource).toContain('buildPurchaseOrderSalesLogisticsFilter')
    expect(serverSource).toContain('buildPurchaseOrderSalesReturnLogisticsFilter')
    expect(serverSource).toContain('countByStatusSql += salesReturnLogisticsFilter.sql')
    expect(orderListSource).toContain("filter(group => group.key !== 'return' || group.items.length > 0)")
  })
})
