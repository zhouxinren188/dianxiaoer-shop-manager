import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const preloadSource = readFileSync(new URL('../src/preload/index.js', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../src/main/purchase-order-capture.js', import.meta.url), 'utf8')
const salesSource = readFileSync(new URL('../src/renderer/src/views/sales/OrderList.vue', import.meta.url), 'utf8')
const warehouseSource = readFileSync(new URL('../src/renderer/src/views/warehouse/GoodsManage.vue', import.meta.url), 'utf8')

describe('采购弹窗低配置设备首开优化', () => {
  it.each([
    ['销售订单', salesSource, "showPurchaseDialogShell('sales')"],
    ['仓库进货', warehouseSource, "showPurchaseDialogShell('warehouse')"]
  ])('%s先绘制轻量骨架，再挂载完整内容', (name, source, openCall) => {
    expect(source).toContain('v-if="purchaseDialogPreparing"')
    expect(source).toContain('v-else-if="purchaseInfo.step === 1')
    expect(source).toContain(':transition="purchaseDialogTransition"')
    expect(source).toContain("Object.freeze({ name: 'purchase-dialog-instant', duration: 0 })")
    expect(source).toContain('await waitForPurchaseDialogFrame()')
    expect(source).toContain('fallbackTimer = window.setTimeout(finish, timeoutMs)')
    expect(source).toContain("reportPurchaseDialogTiming(context, 'shell_painted', startedAt)")
    expect(source).toContain("reportPurchaseDialogTiming(context, 'content_painted', startedAt)")
    expect(source).toContain(openCall)
  })

  it('绘制阶段通过白名单 IPC 写入运行日志', () => {
    expect(preloadSource).toContain("'purchase-dialog-render-timing'")
    expect(mainSource).toContain("ipcMain.handle('purchase-dialog-render-timing'")
    expect(mainSource).toContain("runtimeLog.writeLog('PurchaseDialogTiming'")
  })

  it('仓库发货优先自动选择当前店铺所属云仓', () => {
    expect(salesSource).toContain('fetchStore(purchaseInfo.storeId)')
    expect(salesSource).toContain('purchaseInfo.storeCloudWarehouseId = storeRes?.cloud_warehouse_id')
    expect(salesSource).toContain('function applyStoreCloudWarehouse()')
    expect(salesSource).toContain('const selectedStoreWarehouse = applyStoreCloudWarehouse()')
    expect(salesSource).toMatch(/if \(selectedStoreWarehouse\) \{[\s\S]{0,180}updateDropshipShipping\(\)/)
    expect(salesSource).toContain('if (!selectedStoreWarehouse && lastWhId)')
    expect(salesSource).toContain("if (type === 'warehouse' || type === 'warehouse_in') {")
    expect(salesSource.indexOf('applyStoreCloudWarehouse()', salesSource.indexOf('watch(() => purchaseInfo.purchaseType')))
      .toBeLessThan(salesSource.indexOf('updateWarehouseShipping()', salesSource.indexOf('watch(() => purchaseInfo.purchaseType')))
  })
})
