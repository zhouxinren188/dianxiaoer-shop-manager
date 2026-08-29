import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const serverSource = fs.readFileSync(path.resolve('server/index.js'), 'utf8')
const dbSource = fs.readFileSync(path.resolve('server/db.js'), 'utf8')
const warehouseRouteSource = fs.readFileSync(path.resolve('server/routes/warehouse.js'), 'utf8')

function routeSource(startMarker, endMarker) {
  const start = serverSource.indexOf(startMarker)
  const end = serverSource.indexOf(endMarker, start + startMarker.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return serverSource.slice(start, end)
}

describe('inventory lifecycle', () => {
  it('migrates existing inventory rows to active without deleting business data', () => {
    expect(dbSource).toContain('is_active TINYINT(1) NOT NULL DEFAULT 1')
    expect(dbSource).toContain('disabled_at DATETIME DEFAULT NULL')
    expect(dbSource).toContain('idx_owner_active (owner_id, is_active)')
  })

  it('keeps inactive products out of normal desktop and mini-program lists', () => {
    expect(serverSource).toContain("if (status === 'inactive') where += ' AND i.is_active = 0'")
    expect(serverSource).toContain("else if (status !== 'all') where += ' AND i.is_active = 1'")
    expect(warehouseRouteSource).toContain("if (status === 'inactive') where += ' AND i.is_active = 0'")
    expect(warehouseRouteSource).toContain("else if (status !== 'all') where += ' AND i.is_active = 1'")
  })

  it('deletes SKU bindings in the same transaction before deleting an unused product', () => {
    const source = routeSource("app.delete('/api/inventory/:id'", "app.post('/api/sku-bindings'")
    const formalUnbind = source.indexOf('DELETE FROM sku_bindings WHERE inventory_id = ? AND owner_id = ?')
    const pendingUnbind = source.indexOf('DELETE FROM pending_sku_bindings WHERE inventory_id = ? AND owner_id = ?')
    const inventoryDelete = source.indexOf('DELETE FROM inventory WHERE id = ? AND owner_id = ?')

    expect(source).toContain('await connection.beginTransaction()')
    expect(source).toContain('await connection.commit()')
    expect(formalUnbind).toBeGreaterThanOrEqual(0)
    expect(pendingUnbind).toBeGreaterThan(formalUnbind)
    expect(inventoryDelete).toBeGreaterThan(pendingUnbind)
    expect(source).toContain('unbound_count')
  })

  it('supports explicit resolved and pending unbinds scoped to the owner and inventory product', () => {
    const source = routeSource("app.delete('/api/sku-bindings/:id'", "app.delete('/api/sku-bindings'")
    expect(source).toContain("['resolved', 'pending'].includes(bindingState)")
    expect(source).toContain("bindingState === 'pending' ? 'pending_sku_bindings' : 'sku_bindings'")
    expect(source).toContain('WHERE id = ? AND inventory_id = ? AND owner_id = ?')
  })

  it('cleans old orphan bindings before checking whether a SKU is occupied', () => {
    const source = routeSource("app.post('/api/sku-bindings'", "app.put('/api/sku-bindings/package-num'")
    expect(source).toContain('DELETE sb FROM sku_bindings sb')
    expect(source).toContain('DELETE psb FROM pending_sku_bindings psb')
    expect(source).toContain('i.id IS NULL')
  })
})
