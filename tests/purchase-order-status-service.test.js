import { describe, expect, it, vi } from 'vitest'
import statusService from '../server/services/purchase-order-status-service.js'

const {
  markPendingPrintAfterExceptionResolution,
  mergePurchaseOrderStatus
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
})
