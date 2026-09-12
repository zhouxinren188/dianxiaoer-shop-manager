import { describe, expect, it, vi } from 'vitest'
import statusService from '../server/services/purchase-order-status-service.js'

const {
  markForwardedAfterCloudOutbound,
  markPendingPrintAfterExceptionResolution,
  mergePurchaseOrderStatus,
  parseTrackingItems,
  refinePurchaseOrderStatusByTracking
} = statusService

describe('purchase order workflow status', () => {
  it('keeps local print and fulfillment stages when platform sync still reports received', () => {
    expect(mergePurchaseOrderStatus('pending_print', 'received')).toBe('pending_print')
    expect(mergePurchaseOrderStatus('forwarded', 'received')).toBe('forwarded')
    expect(mergePurchaseOrderStatus('stocked', 'received')).toBe('stocked')
  })

  it('allows platform terminal states to close a local workflow order', () => {
    expect(mergePurchaseOrderStatus('pending_print', 'cancelled')).toBe('cancelled')
    expect(mergePurchaseOrderStatus('forwarded', 'refunded')).toBe('refunded')
  })

  it('uses previously stored tracking JSON to correct a stale ordered status', () => {
    const storedTracking = JSON.stringify([
      { time: '2026-09-12 15:18', context: '快件已由本人签收' }
    ])

    expect(parseTrackingItems(storedTracking)).toHaveLength(1)
    expect(refinePurchaseOrderStatusByTracking('ordered', storedTracking, '')).toBe('received')
  })

  it('uses logistics progress to promote stale platform states', () => {
    expect(refinePurchaseOrderStatusByTracking('ordered', [
      { desc: '快件已到达南京转运中心' }
    ], '')).toBe('in_transit')
    expect(refinePurchaseOrderStatusByTracking('pending', [], '已发货')).toBe('shipped')
  })

  it('does not overwrite local workflow or terminal states with tracking', () => {
    const signed = [{ message: '已签收' }]
    expect(refinePurchaseOrderStatusByTracking('pending_print', signed, '')).toBe('pending_print')
    expect(refinePurchaseOrderStatusByTracking('cancelled', signed, '')).toBe('cancelled')
  })

  it('moves a received order to pending print inside the same tenant only', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }])
    await expect(markPendingPrintAfterExceptionResolution({ execute }, {
      ownerId: 7,
      purchaseOrderId: 23
    })).resolves.toBe(true)
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'pending_print'"),
      [23, 7, 'shipped', 'in_transit', 'received']
    )
  })

  it('moves a confirmed cloud outbound order to forwarded inside the same tenant only', async () => {
    const execute = vi.fn().mockResolvedValue([{ affectedRows: 1 }])
    await expect(markForwardedAfterCloudOutbound({ execute }, {
      ownerId: 7,
      purchaseOrderId: 23
    })).resolves.toBe(true)
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'forwarded'"),
      [23, 7, 'pending_print', 'shipped', 'in_transit', 'received']
    )
  })
})
