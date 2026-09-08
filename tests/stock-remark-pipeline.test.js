import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const serverSource = fs.readFileSync(path.resolve('server/index.js'), 'utf8')
const dbSource = fs.readFileSync(path.resolve('server/db.js'), 'utf8')
const mainSource = fs.readFileSync(path.resolve('src/main/sales-order-fetch.js'), 'utf8')
const preloadSource = fs.readFileSync(path.resolve('src/preload/index.js'), 'utf8')
const rendererApiSource = fs.readFileSync(path.resolve('src/renderer/src/api/salesOrder.js'), 'utf8')

describe('stock deduction JD remark pipeline', () => {
  it('persists retryable remark state on sales orders', () => {
    expect(dbSource).toContain('stock_remark_text VARCHAR(1000)')
    expect(dbSource).toContain("stock_remark_status VARCHAR(20) NOT NULL DEFAULT 'none'")
    expect(dbSource).toContain('idx_stock_remark_retry')
  })

  it('queues a remark only after successful stock deduction and returns pending work', () => {
    expect(serverSource).toContain('await queueStockDeductionRemark(store_id, o.orderId, stockResult.remark)')
    expect(serverSource).toContain('const stockRemarkTasks = await listPendingStockRemarkTasks(store_id, ownerId)')
    expect(serverSource).toContain('res.json(ok({ saved, stockRemarkTasks }))')
    expect(serverSource).toContain("? { stockStatus: 0, remark: '' }")
  })

  it('submits tasks through the existing JD vendor remark API and acknowledges the result', () => {
    expect(mainSource).toContain("await submitVendorRemark({")
    expect(mainSource).toContain("/stock-remark-result`")
    expect(mainSource).toContain('enqueueStockRemarkTasks(storeId, json.data?.stockRemarkTasks)')
    expect(preloadSource).toContain("'process-stock-remark-tasks'")
    expect(rendererApiSource).toContain("window.electronAPI.invoke('process-stock-remark-tasks'")
  })

  it('signs in the existing logged-in JD window before calling the remark API', () => {
    const directCall = mainSource.indexOf('const directResult = await _executeVendorRemarkApi(existingContents, orderId, remark)')
    expect(directCall).toBeGreaterThan(-1)
    expect(mainSource).toContain('getStoreBackendWebContents(storeId)')
    expect(mainSource).toContain("'store-backend-tab-signed'")
    expect(mainSource).toContain('new window.ParamsSign')
    expect(mainSource).toContain("'h5st': encodeURI(signed.h5st)")
    expect(mainSource).not.toContain('_waitForSffHeaders(existingWin')
  })

  it('keeps failed JD remarks retryable without failing order synchronization', () => {
    expect(serverSource).toContain("so.stock_remark_status='failed'")
    expect(serverSource).toContain('DATE_SUB(NOW(), INTERVAL 5 MINUTE)')
    expect(mainSource).toContain("result=ack_failed")
  })
})
