import { describe, expect, it, vi } from 'vitest'
import routingService from '../server/services/cloud-warehouse-routing-service.js'

const { resolveOrderMachineRoute } = routingService

function normalized(sql) {
  return String(sql).replace(/\s+/g, ' ').trim()
}

describe('云仓订单机器路由', () => {
  it('根据销售订单所属店铺找到仓库机器并保存订单快照', async () => {
    let snapshotReadCount = 0
    const execute = vi.fn(async sql => {
      const text = normalized(sql)
      if (text.includes('FROM purchase_orders po')) {
        snapshotReadCount += 1
        if (snapshotReadCount === 1) {
          return [[{
            cloud_warehouse_id: null,
            cloud_machine_code: '',
            cloud_machine_binding_version: 0,
            cloud_machine_routed_at: null
          }]]
        }
        return [[{
          cloud_warehouse_id: 12,
          cloud_warehouse_name: '九问1号库',
          cloud_machine_code: 'YC-7F3K-92MX',
          cloud_machine_binding_version: 3,
          cloud_machine_routed_at: '2026-09-08 12:00:00'
        }]]
      }
      if (text.includes('FROM stores s')) {
        return [[{
          store_id: 8,
          cloud_warehouse_id: 12,
          warehouse_name: '九问1号库',
          warehouse_status: 'enabled',
          machine_code: 'YC-7F3K-92MX',
          binding_version: 3
        }]]
      }
      if (text.startsWith('UPDATE purchase_orders')) return [{ affectedRows: 1 }]
      throw new Error(`unexpected_sql:${text}`)
    })

    await expect(resolveOrderMachineRoute({ execute }, {
      ownerId: 18,
      purchaseOrderId: 99,
      storeId: 8
    })).resolves.toMatchObject({
      warehouseId: 12,
      warehouseName: '九问1号库',
      machineCode: 'YC-7F3K-92MX',
      bindingVersion: 3,
      source: 'store_warehouse'
    })
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('cloud_machine_routed_at = NOW(3)'),
      [12, 'YC-7F3K-92MX', 3, 99, 18]
    )
  })

  it('已经锁定机器的旧订单不会因店铺改仓而重新路由', async () => {
    const execute = vi.fn(async sql => {
      const text = normalized(sql)
      if (text.includes('FROM purchase_orders po')) {
        return [[{
          cloud_warehouse_id: 12,
          cloud_warehouse_name: '九问1号库',
          cloud_machine_code: 'YC-7F3K-92MX',
          cloud_machine_binding_version: 1,
          cloud_machine_routed_at: '2026-09-08 12:00:00'
        }]]
      }
      throw new Error(`unexpected_sql:${text}`)
    })

    const route = await resolveOrderMachineRoute({ execute }, {
      ownerId: 18,
      purchaseOrderId: 99,
      storeId: 8
    })
    expect(route.source).toBe('order_snapshot')
    expect(route.machineCode).toBe('YC-7F3K-92MX')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('已有仓库级绑定后，未分配仓库的店铺不会误用旧账号绑定', async () => {
    const execute = vi.fn(async sql => {
      const text = normalized(sql)
      if (text.includes('FROM purchase_orders po')) {
        return [[{
          cloud_warehouse_id: null,
          cloud_machine_code: '',
          cloud_machine_binding_version: 0
        }]]
      }
      if (text.includes('FROM stores s')) {
        return [[{
          store_id: 8,
          cloud_warehouse_id: null,
          warehouse_name: null,
          warehouse_status: null,
          machine_code: null
        }]]
      }
      if (text.includes('COUNT(*) AS total FROM cloud_warehouse_machine_bindings')) {
        return [[{ total: 2 }]]
      }
      throw new Error(`unexpected_sql:${text}`)
    })

    await expect(resolveOrderMachineRoute({ execute }, {
      ownerId: 18,
      purchaseOrderId: 99,
      storeId: 8
    })).rejects.toMatchObject({
      code: 'store_cloud_warehouse_missing'
    })
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('FROM cloud_machine_bindings'))).toBe(false)
  })

  it('尚未配置任何仓库机器时保留旧单机器绑定兼容', async () => {
    let snapshotReadCount = 0
    const execute = vi.fn(async sql => {
      const text = normalized(sql)
      if (text.includes('FROM purchase_orders po')) {
        snapshotReadCount += 1
        if (snapshotReadCount === 1) {
          return [[{
            cloud_warehouse_id: null,
            cloud_machine_code: '',
            cloud_machine_binding_version: 0
          }]]
        }
        return [[{
          cloud_warehouse_id: null,
          cloud_machine_code: 'YC-7F3K-92MX',
          cloud_machine_binding_version: 1,
          cloud_machine_routed_at: '2026-09-08 12:00:00'
        }]]
      }
      if (text.includes('FROM stores s')) {
        return [[{ store_id: 8, cloud_warehouse_id: null, machine_code: null }]]
      }
      if (text.includes('COUNT(*) AS total FROM cloud_warehouse_machine_bindings')) {
        return [[{ total: 0 }]]
      }
      if (text.includes('COUNT(*) AS total FROM cloud_warehouse_machine_binding_audit')) {
        return [[{ total: 0 }]]
      }
      if (text.includes('FROM cloud_machine_bindings')) {
        return [[{ machine_code: 'YC-7F3K-92MX', binding_version: 1 }]]
      }
      if (text.startsWith('UPDATE purchase_orders')) return [{ affectedRows: 1 }]
      throw new Error(`unexpected_sql:${text}`)
    })

    const route = await resolveOrderMachineRoute({ execute }, {
      ownerId: 18,
      purchaseOrderId: 99,
      storeId: 8
    })
    expect(route).toMatchObject({
      warehouseId: null,
      machineCode: 'YC-7F3K-92MX',
      source: 'legacy_owner_binding'
    })
  })

  it('仓库级配置解绑后保留旧记录但不重新启用旧账号绑定', async () => {
    const execute = vi.fn(async sql => {
      const text = normalized(sql)
      if (text.includes('FROM purchase_orders po')) {
        return [[{ cloud_warehouse_id: null, cloud_machine_code: '' }]]
      }
      if (text.includes('FROM stores s')) {
        return [[{ store_id: 8, cloud_warehouse_id: null, machine_code: null }]]
      }
      if (text.includes('COUNT(*) AS total FROM cloud_warehouse_machine_bindings')) {
        return [[{ total: 0 }]]
      }
      if (text.includes('COUNT(*) AS total FROM cloud_warehouse_machine_binding_audit')) {
        return [[{ total: 1 }]]
      }
      throw new Error(`unexpected_sql:${text}`)
    })

    await expect(resolveOrderMachineRoute({ execute }, {
      ownerId: 18,
      purchaseOrderId: 99,
      storeId: 8
    })).rejects.toMatchObject({ code: 'store_cloud_warehouse_missing' })
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('FROM cloud_machine_bindings'))).toBe(false)
  })
})
