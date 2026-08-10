import { describe, expect, it } from 'vitest'
import shippingTimeliness from '../server/services/shipping-timeliness-service.js'

const {
  normalizeRegion,
  getSourceShipFrom,
  getSourceKey,
  parseTrackingTime,
  extractTrackingRoute,
  extractTrackingMilestones,
  isSameDispatchContext,
  recommendSources,
  recordTimelinessObservation,
  recommendSourcesFromDatabase,
  loadTimelinessConfig
} = shippingTimeliness

function sourceUrl(shipFrom) {
  const metadata = encodeURIComponent(JSON.stringify({ v: 1, shipFrom }))
  return `https://item.taobao.com/item.htm?id=10001#dxeSku=${metadata}`
}

describe('采购物流时效学习与推荐', () => {
  it('识别完整收货地址和淘宝短发货地', () => {
    expect(normalizeRegion('河南省郑州市金水区未来路88号')).toMatchObject({
      province: '河南', city: '郑州', county: '金水'
    })
    expect(normalizeRegion('河北保定')).toMatchObject({
      province: '河北', city: '保定'
    })
    expect(getSourceShipFrom(sourceUrl('江苏南京'))).toBe('江苏南京')
  })

  it('从乱序轨迹提取最早揽收与最晚签收', () => {
    const result = extractTrackingMilestones([
      { time: '2026-08-04 15:30', context: '您的包裹已签收' },
      { time: '2026-08-02 12:00', context: '运输中，已到达郑州转运中心' },
      { time: '2026-08-01 10:00', context: '快件已被保定集散中心揽收' }
    ], new Date('2026-08-05 12:00'))

    expect(result).not.toBeNull()
    expect(result.transitHours).toBeCloseTo(77.5, 1)
  })

  it('从物流轨迹识别金华揽收和宿迁沭阳目的地', () => {
    const tracking = [
      { time: '08-07 11:59', context: '【宿迁市】快件已到达 宿迁市沭阳县', status_tag: '运输中' },
      { time: '08-07 11:33', context: '【淮安市】快件已发往宿迁市沭阳县', status_tag: '运输中' },
      { time: '08-06 23:47', context: '【金华市】快件已发往义乌转运中心', status_tag: '运输中' },
      { time: '08-06 10:10', context: '【金华市】快件已由金华市义乌市揽收', status_tag: '已揽件' }
    ]
    const route = extractTrackingRoute(tracking, new Date('2026-08-05 18:07'))

    expect(route.origin).toMatchObject({ province: '浙江', city: '金华', county: '义乌' })
    expect(route.destination).toMatchObject({ province: '江苏', city: '宿迁', county: '沭阳' })
  })

  it('将旧链路补成2001的物流年份纠正为采购单年份', () => {
    const parsed = parseTrackingTime('2001/08/06 10:10', new Date('2026-08-05 18:07'))
    expect(parsed.getFullYear()).toBe(2026)
    expect(parsed.getMonth()).toBe(7)
    expect(parsed.getDate()).toBe(6)
  })

  it('正确解析跨年且未携带年份的物流节点', () => {
    const parsed = parseTrackingTime('01-01 10:20', new Date('2026-12-31 18:00'))
    expect(parsed.getFullYear()).toBe(2027)
    expect(parsed.getMonth()).toBe(0)
    expect(parsed.getDate()).toBe(1)
  })

  it('拒收和退回轨迹不进入学习样本', () => {
    const result = extractTrackingMilestones([
      { time: '2026-08-01 10:00', context: '已揽收' },
      { time: '2026-08-03 10:00', context: '客户拒收，包裹退回' },
      { time: '2026-08-04 10:00', context: '已签收' }
    ], new Date('2026-08-05 12:00'))
    expect(result).toBeNull()
  })

  it('历史样本充足时优先使用真实路线时效', () => {
    const config = loadTimelinessConfig()
    const observations = [42, 46, 50, 52, 54].map(hours => ({
      origin_province: '河北',
      origin_city: '保定',
      destination_province: '河南',
      destination_city: '郑州',
      transit_hours: hours,
      total_hours: hours + 12
    }))
    const result = recommendSources({
      destination: '河南省郑州市金水区未来路88号',
      sources: [
        { id: 'hebei', ship_from: '河北保定' },
        { id: 'xinjiang', ship_from: '新疆乌鲁木齐' }
      ],
      observations,
      config
    })

    const hebei = result.results.find(item => item.id === 'hebei')
    const xinjiang = result.results.find(item => item.id === 'xinjiang')
    expect(hebei.estimate).toMatchObject({ confidence: 'high', sampleCount: 5 })
    expect(hebei.recommended).toBe(true)
    expect(xinjiang.estimate).toMatchObject({ confidence: 'default', minDays: 4, maxDays: 7 })
    expect(xinjiang.recommended).toBe(false)
  })

  it('收货地址切换后会按新目的地重新比较', () => {
    const config = loadTimelinessConfig()
    const sources = [
      { id: 'nanjing', ship_from: '江苏南京' },
      { id: 'guangzhou', ship_from: '广东广州' }
    ]
    const toNanjing = recommendSources({ destination: '江苏省南京市江宁区', sources, config })
    const toGuangzhou = recommendSources({ destination: '广东省广州市天河区', sources, config })

    expect(toNanjing.results.find(item => item.id === 'nanjing').recommended).toBe(true)
    expect(toNanjing.results.find(item => item.id === 'guangzhou').recommended).toBe(false)
    expect(toGuangzhou.results.find(item => item.id === 'guangzhou').recommended).toBe(true)
    expect(toGuangzhou.results.find(item => item.id === 'nanjing').recommended).toBe(false)
  })

  it('时效相同的货源只推荐采购价更低的一条', () => {
    const config = loadTimelinessConfig()
    const result = recommendSources({
      destination: '江苏省宿迁市沭阳县',
      sources: [
        { id: 'cheap', ship_from: '上海', purchase_price: 7.01 },
        { id: 'expensive', ship_from: '上海', purchase_price: 7.10 }
      ],
      config
    })

    expect(result.results.find(item => item.id === 'cheap').recommended).toBe(true)
    expect(result.results.find(item => item.id === 'expensive').recommended).toBe(false)
  })

  it('相同发货地会按不同货源的商家发货速度区分推荐', () => {
    const config = loadTimelinessConfig()
    const fastLink = sourceUrl('河北保定').replace('id=10001', 'id=20001')
    const slowLink = sourceUrl('河北保定').replace('id=10001', 'id=20002')
    const routeRows = [38, 42, 46].map(hours => ({
      outcome: 'delivered',
      origin_province: '河北', origin_city: '保定',
      destination_province: '河南', destination_city: '郑州',
      transit_hours: hours
    }))
    const ordered_at = '2026-08-10 18:00:00'
    const sourceRows = [
      ...[6, 8, 10].map(hours => ({ source_key: getSourceKey(fastLink), outcome: 'delivered', dispatch_hours: hours, ordered_at })),
      ...[48, 60, 72].map(hours => ({ source_key: getSourceKey(slowLink), outcome: 'delivered', dispatch_hours: hours, ordered_at })),
      { source_key: getSourceKey(slowLink), outcome: 'unshipped_overdue', dispatch_hours: null, ordered_at },
      { source_key: getSourceKey(slowLink), outcome: 'unshipped_failed', dispatch_hours: null, ordered_at }
    ]
    const result = recommendSources({
      destination: '河南省郑州市金水区',
      sources: [
        { id: 'fast', ship_from: '河北保定', purchase_link: fastLink },
        { id: 'slow', ship_from: '河北保定', purchase_link: slowLink }
      ],
      observations: [...routeRows, ...sourceRows],
      config,
      requestedAt: new Date('2026-08-10 18:30:00')
    })

    const fast = result.results.find(item => item.id === 'fast')
    const slow = result.results.find(item => item.id === 'slow')
    expect(fast.recommended).toBe(true)
    expect(slow.recommended).toBe(false)
    expect(fast.estimate.sourcePerformance.dispatchP80Hours).toBeLessThan(slow.estimate.sourcePerformance.dispatchP80Hours)
    expect(slow.estimate.dispatchRisk).toBe('high')
  })

  it('商家发货表现只比较相近下单时段，不使用统一截单时间', () => {
    expect(isSameDispatchContext('2026-08-10 17:00:00', '2026-08-10 18:30:00')).toBe(true)
    expect(isSameDispatchContext('2026-08-10 09:00:00', '2026-08-10 18:30:00')).toBe(false)
    expect(isSameDispatchContext('2026-08-09 18:00:00', '2026-08-10 18:30:00')).toBe(false)
  })

  it('超过72小时仍未揽收会记录为货源发货风险', async () => {
    let savedSql = ''
    let savedParams = []
    const pool = {
      execute: async (sql, params) => {
        savedSql = sql
        savedParams = params
        return [{ affectedRows: 1 }]
      }
    }
    const result = await recordTimelinessObservation(pool, {
      id: 99,
      owner_id: 1,
      platform: 'taobao',
      platform_order_no: 'TB99',
      source_url: sourceUrl('河北保定'),
      shipping_address: '河南省郑州市金水区未来路88号',
      created_at: new Date(Date.now() - 96 * 3600000),
      status: 'pending'
    }, [], { status: 'pending', verifiedByPlatformSync: true })

    expect(result).toMatchObject({ recorded: true, outcome: 'unshipped_overdue' })
    expect(savedSql).toContain('shipping_timeliness_observations')
    expect((savedSql.match(/\?/g) || []).length).toBe(savedParams.length)
    expect(savedParams.at(-1)).toBe('unshipped_overdue')
  })

  it('旧货源无发货地且超时未揽收时仍可记录货源风险', async () => {
    let savedParams = []
    const pool = {
      execute: async (_sql, params) => {
        savedParams = params
        return [{ affectedRows: 1 }]
      }
    }
    const result = await recordTimelinessObservation(pool, {
      id: 101,
      owner_id: 1,
      platform: 'taobao',
      platform_order_no: 'TB101',
      source_url: 'https://item.taobao.com/item.htm?id=101',
      shipping_address: '江苏省宿迁市沭阳县迎宾大道88号',
      created_at: new Date(Date.now() - 96 * 3600000),
      status: 'pending'
    }, [], { status: 'pending', verifiedByPlatformSync: true })

    expect(result).toMatchObject({ recorded: true, outcome: 'unshipped_overdue' })
    expect(savedParams[4]).toBe('taobao:item:101')
    expect(savedParams.slice(6, 9)).toEqual(['', '', ''])
  })

  it('普通取消订单不误判为商家未发货风险', async () => {
    let writes = 0
    const pool = {
      execute: async () => {
        writes++
        return [{ affectedRows: 1 }]
      }
    }
    const result = await recordTimelinessObservation(pool, {
      id: 102,
      source_url: sourceUrl('浙江金华'),
      shipping_address: '江苏省宿迁市沭阳县',
      created_at: new Date(Date.now() - 96 * 3600000),
      status: 'cancelled'
    }, [], { status: 'cancelled' })

    expect(result).toMatchObject({ recorded: false, reason: 'missing_milestones' })
    expect(writes).toBe(0)
  })

  it('未经平台同步确认的陈旧pending订单不计入未发货风险', async () => {
    let writes = 0
    const pool = {
      execute: async () => {
        writes++
        return [{ affectedRows: 1 }]
      }
    }
    const result = await recordTimelinessObservation(pool, {
      id: 103,
      source_url: sourceUrl('浙江金华'),
      shipping_address: '江苏省宿迁市沭阳县',
      created_at: new Date(Date.now() - 96 * 3600000),
      status: 'pending'
    }, [], { status: 'pending' })

    expect(result).toMatchObject({ recorded: false, reason: 'missing_milestones' })
    expect(writes).toBe(0)
  })

  it('旧货源链接没有发货地时仍从物流记录学习路线', async () => {
    let savedParams = []
    const pool = {
      execute: async (_sql, params) => {
        savedParams = params
        return [{ affectedRows: 1 }]
      }
    }
    const result = await recordTimelinessObservation(pool, {
      id: 100,
      owner_id: 1,
      platform: 'taobao',
      platform_order_no: 'TB100',
      source_url: 'https://item.taobao.com/item.htm?id=10001',
      shipping_address: '江苏省宿迁市沭阳县迎宾大道88号',
      created_at: new Date('2026-08-05 18:07'),
      status: 'completed'
    }, [
      { time: '2001/08/08 12:00', context: '【宿迁市】您的快件已签收', status_tag: '已签收' },
      { time: '2001/08/06 10:10', context: '【金华市】快件已由金华市义乌市张师傅（13459492572）揽收', status_tag: '已揽件' }
    ])

    expect(result).toMatchObject({ recorded: true, outcome: 'delivered', originSource: 'tracking' })
    expect(savedParams[5]).toBe('浙江金华义乌')
    expect(savedParams[5]).not.toContain('13459492572')
    expect(savedParams.slice(6, 12)).toEqual(['浙江', '金华', '义乌', '江苏', '宿迁', '沭阳'])
  })

  it('旧货源没有发货地元数据时可由历史物流样本反推发货地', () => {
    const config = loadTimelinessConfig()
    const oldLink = 'https://item.taobao.com/item.htm?id=778899'
    const sourceKey = getSourceKey(oldLink)
    const observations = [30, 34, 38].map(transit_hours => ({
      source_key: sourceKey,
      outcome: 'delivered',
      origin_province: '浙江',
      origin_city: '金华',
      origin_county: '义乌',
      destination_province: '江苏',
      destination_city: '宿迁',
      destination_county: '沭阳',
      transit_hours,
      ordered_at: '2026-08-10 18:00:00',
      dispatch_hours: 16
    }))
    const result = recommendSources({
      destination: '江苏省宿迁市沭阳县',
      sources: [
        { id: 'legacy', purchase_link: oldLink, purchase_price: 10 },
        { id: 'remote', ship_from: '新疆乌鲁木齐', purchase_price: 9 }
      ],
      observations,
      config,
      requestedAt: new Date('2026-08-10 18:30:00')
    })

    const legacy = result.results.find(item => item.id === 'legacy')
    expect(legacy.origin).toMatchObject({ province: '浙江', city: '金华', county: '义乌' })
    expect(legacy.estimate).toMatchObject({ confidence: 'high', sampleCount: 3 })
    expect(legacy.recommended).toBe(true)
  })

  it('偶发一次未发货只留样本，不直接标记高风险', () => {
    const config = loadTimelinessConfig()
    const link = sourceUrl('河北保定').replace('id=10001', 'id=30001')
    const sourceKey = getSourceKey(link)
    const ordered_at = '2026-08-10 18:00:00'
    const observations = [8, 10, 12, 14].map(dispatch_hours => ({
      source_key: sourceKey,
      outcome: 'delivered',
      dispatch_hours,
      ordered_at
    }))
    observations.push({ source_key: sourceKey, outcome: 'unshipped_overdue', dispatch_hours: null, ordered_at })

    const result = recommendSources({
      destination: '河南省郑州市金水区',
      sources: [
        { id: 'target', ship_from: '河北保定', purchase_link: link },
        { id: 'other', ship_from: '新疆乌鲁木齐', purchase_link: sourceUrl('新疆乌鲁木齐') }
      ],
      observations,
      config,
      requestedAt: new Date('2026-08-10 18:30:00')
    })
    expect(result.results.find(item => item.id === 'target').estimate.dispatchRisk).toBeUndefined()
  })

  it('数据库推荐只读取相关路线和相关货源样本', async () => {
    let querySql = ''
    let queryParams = []
    const link = sourceUrl('浙江金华').replace('id=10001', 'id=40001')
    const sourceKey = getSourceKey(link)
    const observations = [24, 30, 36].map(transit_hours => ({
      source_key: sourceKey,
      outcome: 'delivered',
      origin_province: '浙江', origin_city: '金华', origin_county: '义乌',
      destination_province: '江苏', destination_city: '宿迁', destination_county: '沭阳',
      ordered_at: '2026-08-10 18:00:00', dispatch_hours: 12, transit_hours
    }))
    const pool = {
      execute: async (sql, params) => {
        querySql = sql
        queryParams = params
        return [observations]
      }
    }
    const result = await recommendSourcesFromDatabase(pool, {
      destination: '江苏省宿迁市沭阳县',
      sources: [{ id: 'target', ship_from: '浙江金华', purchase_link: link }],
      requested_at: '2026-08-10T18:30:00+08:00'
    })

    expect(querySql).toContain('destination_province=?')
    expect(querySql).toContain('source_key IN (?)')
    expect(queryParams).toEqual(['江苏', '浙江', sourceKey])
    expect(result.results[0].estimate).toMatchObject({ confidence: 'high', sampleCount: 3 })
  })
})
