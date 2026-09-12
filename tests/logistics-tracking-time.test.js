import { describe, expect, it } from 'vitest'
import common from '../src/main/purchase-order-sync/common.js'

const { normalizeTrackingTime, normalizeTrackingItems, refineStatusByTracking } = common

describe('物流轨迹时间绝对化', () => {
  const reference = new Date(2026, 0, 1, 10, 0, 0)

  it('把今天、昨天和前天转换为完整日期，并正确处理跨年', () => {
    expect(normalizeTrackingTime('今天 00:41', reference)).toBe('2026-01-01 00:41')
    expect(normalizeTrackingTime('昨天 22:29', reference)).toBe('2025-12-31 22:29')
    expect(normalizeTrackingTime('前天 05:38', reference)).toBe('2025-12-30 05:38')
  })

  it('为省略年份的月日补上正确年份，避免被解析成2001年', () => {
    expect(normalizeTrackingTime('08/26 22:01', new Date(2026, 7, 28, 12, 0, 0))).toBe('2026-08-26 22:01')
    expect(normalizeTrackingTime('12/31 23:10', reference)).toBe('2025-12-31 23:10')
    expect(normalizeTrackingTime('2026/08/28 00:41', reference)).toBe('2026-08-28 00:41')
  })

  it('在整组轨迹写入服务器前统一时间且保留描述', () => {
    expect(normalizeTrackingItems([
      { time: '今天 00:41', context: '快件离开转运中心' },
      { timestamp: '昨天 22:29', desc: '快件到达转运中心' }
    ], reference)).toEqual([
      { time: '2026-01-01 00:41', context: '快件离开转运中心' },
      { time: '2025-12-31 22:29', context: '快件到达转运中心' }
    ])
  })
})

describe('采购单状态按真实物流轨迹修正', () => {
  it('平台仍返回已下单时，明确签收轨迹可修正为已签收', () => {
    expect(refineStatusByTracking('ordered', [
      { time: '2026-09-12 15:18', context: '您的包裹已送达签收，由本人签收' }
    ], '')).toBe('received')
  })

  it('平台仍返回待发货时，真实运输轨迹可修正为运输中', () => {
    expect(refineStatusByTracking('pending', [
      { time: '2026-09-12 09:20', context: '快件已到达宿迁转运中心' }
    ], '')).toBe('in_transit')
  })

  it('不会用物流轨迹覆盖取消等业务终态', () => {
    expect(refineStatusByTracking('cancelled', [
      { time: '2026-09-12 15:18', context: '您的包裹已由本人签收' }
    ], '已签收')).toBe('cancelled')
  })

  it('仅有通知快递取件的文案不会误判为运输中', () => {
    expect(refineStatusByTracking('ordered', [
      { time: '2026-09-12 08:00', context: '商家正在通知中通快递取件' }
    ], '')).toBe('ordered')
  })
})
