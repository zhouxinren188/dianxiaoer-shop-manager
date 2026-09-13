import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const serverSource = fs.readFileSync(
  path.resolve(process.cwd(), 'server/index.js'),
  'utf8'
)

describe('sales order persistence payload safety', () => {
  it('raises the server JSON limit above the Express 100KB default', () => {
    expect(serverSource).toContain("app.use('/api/sales-orders/batch', express.json({ limit: '10mb' }))")
    expect(serverSource).toContain('app.use(express.json())')
  })

  it('keeps the larger parser scoped to the sales order batch endpoint', () => {
    const scopedParser = serverSource.indexOf("app.use('/api/sales-orders/batch', express.json({ limit: '10mb' }))")
    const defaultParser = serverSource.indexOf('app.use(express.json())')
    expect(scopedParser).toBeGreaterThan(-1)
    expect(defaultParser).toBeGreaterThan(scopedParser)
  })
})
