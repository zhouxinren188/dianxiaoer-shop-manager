import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import skuBindingInput from '../server/services/sku-binding-input.js'

const { normalizeSkuBindingInput } = skuBindingInput

describe('SKU binding input', () => {
  it('normalizes a manual unsold-SKU binding payload', () => {
    expect(normalizeSkuBindingInput({
      store_id: '12',
      inventory_id: '34',
      sku_id: '  10214934933733  ',
      package_num: '2'
    })).toEqual({
      storeId: 12,
      inventoryId: 34,
      skuId: '10214934933733',
      packageNum: 2
    })
  })

  it('defaults the package base to one and rejects invalid identifiers', () => {
    expect(normalizeSkuBindingInput({ inventory_id: 2, sku_id: 'SKU-A' })).toEqual({
      storeId: null,
      inventoryId: 2,
      skuId: 'SKU-A',
      packageNum: 1
    })
    expect(() => normalizeSkuBindingInput({ store_id: 0, inventory_id: 2, sku_id: 'SKU-A' })).toThrow('店铺无效')
    expect(() => normalizeSkuBindingInput({ store_id: 1, inventory_id: 2, sku_id: '   ' })).toThrow('销售SKU不能为空')
    expect(() => normalizeSkuBindingInput({ store_id: 1, inventory_id: 2, sku_id: 'SKU-A', package_num: 0 })).toThrow('包装规格无效')
  })

  it('keeps unsold bindings visible by using a left join and a placeholder', () => {
    const serverSource = fs.readFileSync(path.resolve('server/index.js'), 'utf8')
    const routeStart = serverSource.indexOf("app.get('/api/inventory/:id/bound-products'")
    const routeEnd = serverSource.indexOf("app.get('/api/sales-skus/unbound'", routeStart)
    const routeSource = serverSource.slice(routeStart, routeEnd)

    expect(routeSource).toContain('LEFT JOIN sales_orders')
    expect(routeSource).toContain('待首次销售后补齐')
    expect(routeSource).toContain('COUNT(so.id) AS sales_record_count')
    expect(routeSource).toContain('pending_sku_bindings')
  })

  it('promotes a pending SKU binding when its first order is synchronized', () => {
    const serverSource = fs.readFileSync(path.resolve('server/index.js'), 'utf8')
    const resolverStart = serverSource.indexOf('async function resolveSkuBindingForOrder')
    const resolverEnd = serverSource.indexOf('async function attemptStockDeduction', resolverStart)
    const resolverSource = serverSource.slice(resolverStart, resolverEnd)

    expect(resolverSource).toContain('FROM pending_sku_bindings')
    expect(resolverSource).toContain('INSERT INTO sku_bindings')
    expect(resolverSource).toContain('DELETE FROM pending_sku_bindings')
    expect(serverSource).toContain('const binding = await resolveSkuBindingForOrder')
  })
})
