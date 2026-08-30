import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const serverSource = fs.readFileSync(path.resolve('server/index.js'), 'utf8')

function salesRecordsRouteSource() {
  const start = serverSource.indexOf("app.get('/api/inventory/:id/sales-records'")
  const end = serverSource.indexOf("app.get('/api/sales-skus/unbound'", start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return serverSource.slice(start, end)
}

describe('inventory sales records route', () => {
  it('scopes inventory and sales records to the authenticated owner', () => {
    const source = salesRecordsRouteSource()
    expect(source).toContain('inventory WHERE id = ? AND owner_id = ?')
    expect(source).toContain('sb.inventory_id = ? AND sb.owner_id = ?')
    expect(source).toContain('s.owner_id = ?')
  })

  it('excludes unpaid and cancelled orders through bound parameters', () => {
    const source = salesRecordsRouteSource()
    expect(source).toContain('const excludedStatuses =')
    expect(source).toContain("NOT IN (?, ?, ?)")
  })

  it('returns paginated records with total count and total quantity', () => {
    const source = salesRecordsRouteSource()
    expect(source).toContain('COUNT(*) AS total')
    expect(source).toContain('SUM(so.quantity)')
    expect(source).toContain('LIMIT ${pageSize} OFFSET ${offset}')
    expect(source).toContain('Math.min(100')
    expect(source).toContain('total_quantity:')
    expect(source).toContain('page_size: pageSize')
  })
})
