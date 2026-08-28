import { describe, expect, it } from 'vitest'
import common from '../src/main/purchase-order-sync/common.js'

const { normalizeTrackingTime, normalizeTrackingItems } = common

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
