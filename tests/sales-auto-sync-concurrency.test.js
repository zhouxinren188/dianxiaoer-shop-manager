import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/main/sales-order-fetch.js'),
  'utf8'
)
const preloadSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/preload/index.js'),
  'utf8'
)
const rendererSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/src/views/sales/OrderList.vue'),
  'utf8'
)

describe('sales order auto sync concurrency wiring', () => {
  it('uses exactly two store lanes while keeping the ten-minute cycle guard', () => {
    expect(source).toContain('const AUTO_SYNC_CONCURRENCY = 2')
    expect(source).toContain('await runWithConcurrency(')
    expect(source).toContain('if (autoSyncRunning)')
    expect(source).toContain('phase=cycle_skip reason=previous_cycle_running')
    expect(source).toContain("hasValidPlatformCookies(jdCookies, 'jd')")
    expect(source).toContain('phase=enable_during_cycle action=keep_current_cycle')
  })

  it('starts the next timer only after the complete cycle has finished', () => {
    expect(source).toContain('await autoSyncAllStores(mainWindow)')
    expect(source).toContain('scheduleAutoSync(mainWindow, AUTO_SYNC_INTERVAL, generation)')
    expect(source).toContain('running: autoSyncEnabled')
    expect(source).not.toContain('autoSyncTimer = setInterval')
  })

  it('keeps the store lock until after active-order secondary sync', () => {
    const secondaryStart = source.indexOf('// === 二次同步：更新活跃订单状态 ===')
    const secondaryEnd = source.indexOf('} catch (activeErr)', secondaryStart)
    const releaseLock = source.indexOf("await releaseSyncLock(store.store_id, 'sales'", secondaryEnd)

    expect(secondaryStart).toBeGreaterThan(-1)
    expect(secondaryEnd).toBeGreaterThan(secondaryStart)
    expect(releaseLock).toBeGreaterThan(secondaryEnd)
  })

  it('records cycle, store, primary, secondary and unexpected-error diagnostics', () => {
    for (const phase of [
      'phase=cycle_start',
      'phase=cycle_finish',
      'phase=store_start',
      'phase=store_finish',
      'phase=primary_finish',
      'phase=secondary_finish',
      'phase=store_unhandled_exception'
    ]) {
      expect(source).toContain(phase)
    }
    expect(source).toContain("result=${secondaryFailed ? 'failed' : 'success'}")
    expect(source).toContain('failed_batch_count=${secondaryFailedBatchCount}')
  })

  it('clears the UI status only after the complete concurrent cycle finishes', () => {
    expect(preloadSource).toContain("'auto-sync-cycle-finish'")
    expect(source).toContain("webContents.send('auto-sync-cycle-finish'")
    expect(rendererSource).toContain("onUpdate('auto-sync-cycle-finish'")

    const resultListener = rendererSource.slice(
      rendererSource.indexOf("onUpdate('auto-sync-result'"),
      rendererSource.indexOf("onUpdate('auto-sync-progress'")
    )
    expect(resultListener).not.toContain("mainProcessSyncStatus.value = ''")
  })
})
