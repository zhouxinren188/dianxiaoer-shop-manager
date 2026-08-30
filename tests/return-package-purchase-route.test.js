import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(testDir, '..', 'server', 'index.js'), 'utf8')
const routeStart = source.indexOf("app.get('/api/purchase-orders/by-return-logistics/:logisticsNo'")
const nextRouteStart = source.indexOf("app.get('/api/sales-orders'", routeStart)
const routeSource = source.slice(routeStart, nextRouteStart)

describe('return logistics purchase lookup route', () => {
  it('is registered before generic purchase order routes', () => {
    expect(routeStart).toBeGreaterThan(-1)
    expect(routeStart).toBeLessThan(source.indexOf("app.get('/api/purchase-orders/:id'"))
  })

  it('limits return records to the owner and accessible stores', () => {
    expect(routeSource).toContain('getAccessibleStoreIds(req.user)')
    expect(routeSource).toContain('WHERE srl.owner_id = ? AND srl.logistics_no = ?')
    expect(routeSource).toContain('AND srl.store_id IN (${storePlaceholders})')
    expect(routeSource).toContain('[ownerId, logisticsNo, ...accessibleStoreIds]')
  })

  it('keeps sub-account purchase-account assignment filtering', () => {
    expect(routeSource).toContain("req.user.user_type === 'sub'")
    expect(routeSource).toContain('LEFT JOIN user_purchase_accounts upa')
    expect(routeSource).toContain('upa.user_id IS NOT NULL')
  })

  it('uses parameterized order lookups and delegates matching to the matcher', () => {
    expect(routeSource).toContain('po.sales_order_no IN (${salesOrderPlaceholders})')
    expect(routeSource).toContain('po.sales_order_id IN (${linkedSalesOrderIds.map')
    expect(routeSource).toContain('buildReturnPackageLookup(returnRows, purchaseRows)')
  })

  it('does not select or return customer contact fields', () => {
    expect(routeSource).not.toMatch(/buyer_(?:name|phone|address)/)
    expect(routeSource).not.toMatch(/customer_(?:name|phone|address)/)
    expect(routeSource).not.toContain('shipping_address')
  })
})
