/**
 * 采购订单浏览器窗口同步模块 - 单元测试
 * 测试纯函数：解析、查找、聚合、状态映射、平台配置
 */
import { describe, it, expect } from 'vitest'
import {
  CP_CODE_MAP,
  resolveLogisticsCompany,
  PLATFORM_CONFIG,
  parseTaobaoH5Response,
  parse1688OrderResponse,
  parsePddOrderResponse,
  parseOrdersByPlatform,
  findOrderByPlatformOrderNo,
  findAllOrders,
  STATUS_MAP,
  computeSyncUpdate
} from './browser-sync-helpers.js'

// ============ 平台配置测试 ============

describe('PLATFORM_CONFIG', () => {
  it('应有 taobao/1688/pinduoduo 三个平台', () => {
    expect(Object.keys(PLATFORM_CONFIG).sort()).toEqual(['1688', 'pinduoduo', 'taobao'])
  })

  it('每个平台应有 entryUrl、loginCheck、apiKeywords', () => {
    for (const [, config] of Object.entries(PLATFORM_CONFIG)) {
      expect(config.entryUrl).toBeTruthy()
      expect(typeof config.loginCheck).toBe('function')
      expect(Array.isArray(config.apiKeywords)).toBe(true)
      expect(config.apiKeywords.length).toBeGreaterThan(0)
    }
  })

  it('淘宝 entryUrl 应指向已买到的商品页面', () => {
    expect(PLATFORM_CONFIG.taobao.entryUrl).toContain('list_bought_items')
  })

  it('淘宝 apiKeywords 应包含 mtop.taobao.order', () => {
    expect(PLATFORM_CONFIG.taobao.apiKeywords).toContain('mtop.taobao.order')
  })

  it('1688 apiKeywords 应包含 orderList 和 trade', () => {
    expect(PLATFORM_CONFIG['1688'].apiKeywords).toContain('orderList')
    expect(PLATFORM_CONFIG['1688'].apiKeywords).toContain('trade')
  })

  it('拼多多 apiKeywords 应包含 orderList', () => {
    expect(PLATFORM_CONFIG.pinduoduo.apiKeywords).toContain('orderList')
  })
})

describe('PLATFORM_CONFIG loginCheck', () => {
  it('淘宝登录检测', () => {
    expect(PLATFORM_CONFIG.taobao.loginCheck('https://login.taobao.com/')).toBe(true)
    expect(PLATFORM_CONFIG.taobao.loginCheck('https://login.tmall.com/')).toBe(true)
    expect(PLATFORM_CONFIG.taobao.loginCheck('https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm')).toBe(false)
  })

  it('1688 登录检测', () => {
    expect(PLATFORM_CONFIG['1688'].loginCheck('https://login.1688.com/')).toBe(true)
    expect(PLATFORM_CONFIG['1688'].loginCheck('https://member.1688.com/login?from=trade')).toBe(true)
    expect(PLATFORM_CONFIG['1688'].loginCheck('https://trade.1688.com/order/buyer_order_list.htm')).toBe(false)
  })

  it('拼多多登录检测', () => {
    expect(PLATFORM_CONFIG.pinduoduo.loginCheck('https://login.yangkeduo.com/')).toBe(true)
    expect(PLATFORM_CONFIG.pinduoduo.loginCheck('https://mobile.yangkeduo.com/orders.html')).toBe(false)
  })

  it('登录检测应大小写不敏感', () => {
    expect(PLATFORM_CONFIG.taobao.loginCheck('https://Login.Taobao.com/')).toBe(true)
    expect(PLATFORM_CONFIG.taobao.loginCheck('https://LOGIN.TMALL.COM/')).toBe(true)
  })
})

// ============ 淘宝 H5 响应解析测试 ============

describe('parseTaobaoH5Response', () => {
  const makeTaobaoResponse = (data, ret = ['SUCCESS::调用成功']) => {
    return JSON.stringify({ ret, data })
  }

  it('应解析基本的组件化布局响应', () => {
    const response = makeTaobaoResponse({
      shopInfo_12345: {
        id: 'ORDER-001',
        fields: { tradeTitle: '卖家已发货' }
      },
      orderStatus_12345: {
        id: 'ORDER-001',
        fields: {
          mailNo: 'YT1234567890',
          cpCode: 'YTO',
          title: '已发货'
        }
      },
      orderLogistics_12345: {
        id: 'ORDER-001',
        fields: {
          packagePreview: {
            packageViewList: [{ cpName: '圆通速递' }]
          }
        }
      }
    })
    const orders = parseTaobaoH5Response(response)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('ORDER-001')
    expect(orders[0].status).toBe('卖家已发货')
    expect(orders[0].logistics_no).toBe('YT1234567890')
    expect(orders[0].logistics_company).toBe('圆通速递')
    expect(orders[0].logistics_company_code).toBe('YTO')
    expect(orders[0].logistics_status).toBe('已发货')
  })

  it('应在无 cpName 时用 cpCode 映射物流公司', () => {
    const response = makeTaobaoResponse({
      shopInfo_111: { id: 'ORDER-002', fields: { tradeTitle: '待收货' } },
      orderStatus_111: {
        id: 'ORDER-002',
        fields: { mailNo: 'SF9876543210', cpCode: 'SF' }
      }
    })
    const orders = parseTaobaoH5Response(response)
    expect(orders).toHaveLength(1)
    expect(orders[0].logistics_company).toBe('顺丰速运')
  })

  it('应处理 data.data 嵌套结构', () => {
    const response = makeTaobaoResponse({
      data: {
        shopInfo_999: { id: 'ORDER-NESTED', fields: { tradeTitle: '交易成功' } },
        orderStatus_999: { id: 'ORDER-NESTED', fields: {} }
      },
      ret: ['SUCCESS::调用成功']
    })
    const orders = parseTaobaoH5Response(response)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('ORDER-NESTED')
    expect(orders[0].status).toBe('交易成功')
  })

  it('不应解包包含 shopInfo_ 键的 data.data', () => {
    const innerData = {
      shopInfo_555: { id: 'ORDER-FLAT', fields: { tradeTitle: '已发货' } }
    }
    const response = makeTaobaoResponse({
      data: innerData,
      ret: ['SUCCESS::调用成功']
    })
    const orders = parseTaobaoH5Response(response)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('ORDER-FLAT')
  })

  it('应处理字符串 data', () => {
    const innerData = { shopInfo_777: { id: 'ORDER-STR', fields: { tradeTitle: '待发货' } } }
    const response = JSON.stringify({
      ret: ['SUCCESS::调用成功'],
      data: JSON.stringify(innerData)
    })
    const orders = parseTaobaoH5Response(response)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('ORDER-STR')
  })

  it('应返回空数组当 ret 不是 SUCCESS', () => {
    const response = makeTaobaoResponse({}, ['FAIL_SYS_TOKEN_EXOIRED::Token过期'])
    expect(parseTaobaoH5Response(response)).toEqual([])
  })

  it('应返回空数组当无 data', () => {
    expect(parseTaobaoH5Response('{"ret":["SUCCESS::调用成功"]}')).toEqual([])
  })

  it('应返回空数组当无效 JSON', () => {
    expect(parseTaobaoH5Response('not json')).toEqual([])
  })

  it('应跳过无 id 的组件', () => {
    const response = makeTaobaoResponse({
      shopInfo_noid: { fields: { tradeTitle: '测试' } }
    })
    expect(parseTaobaoH5Response(response)).toEqual([])
  })

  it('应聚合多个订单', () => {
    const response = makeTaobaoResponse({
      shopInfo_1: { id: 'A001', fields: { tradeTitle: '已发货' } },
      orderStatus_1: { id: 'A001', fields: { mailNo: 'NO1' } },
      shopInfo_2: { id: 'A002', fields: { tradeTitle: '待发货' } },
      orderStatus_2: { id: 'A002', fields: {} }
    })
    const orders = parseTaobaoH5Response(response)
    expect(orders).toHaveLength(2)
    expect(orders.find(o => o.order_no === 'A001').logistics_no).toBe('NO1')
    expect(orders.find(o => o.order_no === 'A002').status).toBe('待发货')
  })
})

// ============ 1688 响应解析测试 ============

describe('parse1688OrderResponse', () => {
  it('应解析 data 数组格式', () => {
    const response = JSON.stringify({
      data: [
        { orderId: '1688-001', statusText: '已发货', logisticsOrderNo: 'YTO123' }
      ]
    })
    const orders = parse1688OrderResponse(response)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('1688-001')
    expect(orders[0].logistics_no).toBe('YTO123')
  })

  it('应解析 data.orderList 格式', () => {
    const response = JSON.stringify({
      data: {
        orderList: [
          { orderNo: '1688-002', orderStatusText: '待发货' }
        ]
      }
    })
    const orders = parse1688OrderResponse(response)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('1688-002')
    expect(orders[0].status).toBe('待发货')
  })

  it('应解析 data.list 格式', () => {
    const response = JSON.stringify({
      data: {
        list: [
          { id: '1688-003', status: '已完成', expressNo: 'SF456' }
        ]
      }
    })
    const orders = parse1688OrderResponse(response)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('1688-003')
    expect(orders[0].logistics_no).toBe('SF456')
  })

  it('应解析 data.result 格式', () => {
    const response = JSON.stringify({
      data: {
        result: [
          { orderId: '1688-004', logisticsCompanyName: '中通快递' }
        ]
      }
    })
    const orders = parse1688OrderResponse(response)
    expect(orders).toHaveLength(1)
    expect(orders[0].logistics_company).toBe('中通快递')
  })

  it('应返回空数组当无匹配结构', () => {
    expect(parse1688OrderResponse('{"data":{}}')).toEqual([])
    expect(parse1688OrderResponse('{"data":[]}')).toEqual([])
  })

  it('应返回空数组当无效 JSON', () => {
    expect(parse1688OrderResponse('bad')).toEqual([])
  })

  it('应兼容多种字段名', () => {
    const response = JSON.stringify({
      data: [
        {
          orderNo: 'ALT-001',
          expressCompany: '韵达快递',
          logisticsNo: 'YD789',
          logisticsStatus: '派送中'
        }
      ]
    })
    const orders = parse1688OrderResponse(response)
    expect(orders[0].order_no).toBe('ALT-001')
    expect(orders[0].logistics_company).toBe('韵达快递')
    expect(orders[0].logistics_no).toBe('YD789')
    expect(orders[0].logistics_status).toBe('派送中')
  })
})

// ============ 拼多多响应解析测试 ============

describe('parsePddOrderResponse', () => {
  it('应解析 data.list 格式', () => {
    const response = JSON.stringify({
      data: {
        list: [
          { order_sn: 'PDD-001', order_status_text: '已发货', shipping_no: 'ZTO111' }
        ]
      }
    })
    const orders = parsePddOrderResponse(response)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('PDD-001')
    expect(orders[0].status).toBe('已发货')
    expect(orders[0].logistics_no).toBe('ZTO111')
  })

  it('应解析 data.orderList 格式', () => {
    const response = JSON.stringify({
      data: {
        orderList: [
          { orderSn: 'PDD-002', orderStatusName: '待收货', trackingNumber: 'SF222' }
        ]
      }
    })
    const orders = parsePddOrderResponse(response)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('PDD-002')
    expect(orders[0].logistics_no).toBe('SF222')
  })

  it('应解析 data 数组格式', () => {
    const response = JSON.stringify({
      data: [
        { id: 'PDD-003', status_text: '已签收', shipping_company: '圆通速递' }
      ]
    })
    const orders = parsePddOrderResponse(response)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('PDD-003')
    expect(orders[0].logistics_company).toBe('圆通速递')
  })

  it('应返回空数组当无效 JSON', () => {
    expect(parsePddOrderResponse('err')).toEqual([])
  })

  it('应兼容 order_no 字段名', () => {
    const response = JSON.stringify({
      data: {
        list: [
          { order_no: 'PDD-004', logistics_id: 'ZTO', shipping_status: '运输中' }
        ]
      }
    })
    const orders = parsePddOrderResponse(response)
    expect(orders[0].order_no).toBe('PDD-004')
    expect(orders[0].logistics_company_code).toBe('ZTO')
    expect(orders[0].logistics_status).toBe('运输中')
  })
})

// ============ parseOrdersByPlatform 路由测试 ============

describe('parseOrdersByPlatform', () => {
  it('应路由到淘宝解析器', () => {
    const response = JSON.stringify({
      ret: ['SUCCESS::调用成功'],
      data: { shopInfo_1: { id: 'TB-001', fields: { tradeTitle: '已发货' } } }
    })
    const orders = parseOrdersByPlatform('taobao', response)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('TB-001')
  })

  it('应路由到 1688 解析器', () => {
    const response = JSON.stringify({
      data: [{ orderId: 'ALI-001', statusText: '待发货' }]
    })
    const orders = parseOrdersByPlatform('1688', response)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('ALI-001')
  })

  it('应路由到拼多多解析器', () => {
    const response = JSON.stringify({
      data: { list: [{ order_sn: 'PDD-001', order_status_text: '已发货' }] }
    })
    const orders = parseOrdersByPlatform('pinduoduo', response)
    expect(orders).toHaveLength(1)
    expect(orders[0].order_no).toBe('PDD-001')
  })

  it('未知平台应返回空数组', () => {
    expect(parseOrdersByPlatform('unknown', '{}')).toEqual([])
  })
})

// ============ findOrderByPlatformOrderNo 测试 ============

describe('findOrderByPlatformOrderNo', () => {
  const makeResponse = (url, status, body) => ({ url, status, body, bodyLen: body.length })

  it('应从淘宝响应中找到指定订单', () => {
    const taobaoBody = JSON.stringify({
      ret: ['SUCCESS::调用成功'],
      data: {
        shopInfo_1: { id: 'TB-FIND-001', fields: { tradeTitle: '卖家已发货' } },
        orderStatus_1: { id: 'TB-FIND-001', fields: { mailNo: 'YT999', cpCode: 'YTO' } }
      }
    })
    const responses = [makeResponse('https://h5api.m.taobao.com/...', 200, taobaoBody)]
    const found = findOrderByPlatformOrderNo('taobao', 'TB-FIND-001', responses)
    expect(found).not.toBeNull()
    expect(found.order_no).toBe('TB-FIND-001')
    expect(found.logistics_no).toBe('YT999')
  })

  it('应返回 null 当订单不存在', () => {
    const responses = [makeResponse('url', 200, '{"ret":["SUCCESS::调用成功"],"data":{}}')]
    expect(findOrderByPlatformOrderNo('taobao', 'NOT-EXIST', responses)).toBeNull()
  })

  it('应跳过非 200 响应', () => {
    const responses = [makeResponse('url', 500, '{"error":true}')]
    expect(findOrderByPlatformOrderNo('taobao', 'ANY', responses)).toBeNull()
  })

  it('应跳过无 body 的响应', () => {
    const responses = [{ url: 'test', status: 200, body: null }]
    expect(findOrderByPlatformOrderNo('taobao', 'ANY', responses)).toBeNull()
  })

  it('应从多个响应中找到目标', () => {
    const body1 = JSON.stringify({
      ret: ['SUCCESS::调用成功'],
      data: { shopInfo_1: { id: 'AA', fields: { tradeTitle: '待发货' } } }
    })
    const body2 = JSON.stringify({
      ret: ['SUCCESS::调用成功'],
      data: { shopInfo_2: { id: 'BB', fields: { tradeTitle: '已发货' } } }
    })
    const responses = [
      makeResponse('url1', 200, body1),
      makeResponse('url2', 200, body2)
    ]
    const found = findOrderByPlatformOrderNo('taobao', 'BB', responses)
    expect(found).not.toBeNull()
    expect(found.order_no).toBe('BB')
    expect(found.status).toBe('已发货')
  })
})

// ============ findAllOrders 测试 ============

describe('findAllOrders', () => {
  const makeResponse = (url, status, body) => ({ url, status, body, bodyLen: body.length })

  it('应提取所有订单并去重', () => {
    const body1 = JSON.stringify({
      ret: ['SUCCESS::调用成功'],
      data: { shopInfo_1: { id: 'AA', fields: { tradeTitle: '待发货' } } }
    })
    const body2 = JSON.stringify({
      ret: ['SUCCESS::调用成功'],
      data: {
        shopInfo_1: { id: 'AA', fields: { tradeTitle: '待发货' } },
        shopInfo_2: { id: 'BB', fields: { tradeTitle: '已发货' } }
      }
    })
    const responses = [
      makeResponse('url1', 200, body1),
      makeResponse('url2', 200, body2)
    ]
    const orders = findAllOrders('taobao', responses)
    expect(orders).toHaveLength(2)
    expect(orders.map(o => o.order_no).sort()).toEqual(['AA', 'BB'])
  })

  it('应返回空数组当无响应', () => {
    expect(findAllOrders('taobao', [])).toEqual([])
  })

  it('应跳过非 200 响应', () => {
    const body = JSON.stringify({ data: [{ orderId: 'X1' }] })
    const responses = [makeResponse('url', 403, body)]
    expect(findAllOrders('1688', responses)).toEqual([])
  })

  it('应处理 1688 多格式响应', () => {
    const body = JSON.stringify({
      data: [
        { orderId: 'ALI-001', statusText: '已发货' },
        { orderId: 'ALI-002', statusText: '待发货' }
      ]
    })
    const responses = [makeResponse('url', 200, body)]
    const orders = findAllOrders('1688', responses)
    expect(orders).toHaveLength(2)
  })
})

// ============ 状态映射测试 ============

describe('STATUS_MAP', () => {
  it('应包含所有核心状态映射', () => {
    expect(STATUS_MAP['卖家已发货']).toBe('shipped')
    expect(STATUS_MAP['已发货']).toBe('shipped')
    expect(STATUS_MAP['待收货']).toBe('shipped')
    expect(STATUS_MAP['已签收']).toBe('received')
    expect(STATUS_MAP['交易成功']).toBe('received')
    expect(STATUS_MAP['已成交']).toBe('completed')
    expect(STATUS_MAP['已取消']).toBe('cancelled')
    expect(STATUS_MAP['退款成功']).toBe('refunded')
    expect(STATUS_MAP['退款中']).toBe('refunded')
    expect(STATUS_MAP['运输中']).toBe('in_transit')
    expect(STATUS_MAP['派送中']).toBe('in_transit')
    expect(STATUS_MAP['等待买家付款']).toBe('pending')
    expect(STATUS_MAP['待发货']).toBe('pending')
  })

  it('应有 15 个映射条目', () => {
    expect(Object.keys(STATUS_MAP)).toHaveLength(15)
  })
})

// ============ computeSyncUpdate 测试 ============

describe('computeSyncUpdate', () => {
  it('应检测状态变化', () => {
    const result = computeSyncUpdate(
      { status: '卖家已发货', logistics_no: '', logistics_company: '', logistics_status: '' },
      { status: 'pending', logistics_no: '', logistics_company: '' }
    )
    expect(result.result.status).toBe('shipped')
    expect(result.hasChanges).toBe(true)
    expect(result.updateFields).toContain('status')
  })

  it('应保留未变化的状态', () => {
    const result = computeSyncUpdate(
      { status: '待发货', logistics_no: '', logistics_company: '', logistics_status: '' },
      { status: 'pending', logistics_no: '', logistics_company: '' }
    )
    expect(result.result.status).toBe('pending')
    expect(result.updateFields).not.toContain('status')
  })

  it('应合并新物流信息', () => {
    const result = computeSyncUpdate(
      { status: '卖家已发货', logistics_no: 'YT123', logistics_company: '圆通速递', logistics_status: '运输中' },
      { status: 'shipped', logistics_no: '', logistics_company: '' }
    )
    expect(result.result.logistics_no).toBe('YT123')
    expect(result.result.logistics_company).toBe('圆通速递')
    expect(result.result.logistics_status).toBe('运输中')
    expect(result.hasChanges).toBe(true)
  })

  it('应保留已有物流信息当新信息为空', () => {
    const result = computeSyncUpdate(
      { status: '卖家已发货', logistics_no: '', logistics_company: '', logistics_status: '' },
      { status: 'shipped', logistics_no: 'SF999', logistics_company: '顺丰速递' }
    )
    expect(result.result.logistics_no).toBe('SF999')
    expect(result.result.logistics_company).toBe('顺丰速递')
  })

  it('应处理未知状态（无法映射）', () => {
    const result = computeSyncUpdate(
      { status: '未知状态', logistics_no: '', logistics_company: '', logistics_status: '' },
      { status: 'pending', logistics_no: '', logistics_company: '' }
    )
    expect(result.result.status).toBe('pending') // 保持不变
  })

  it('应有变化当仅新增物流单号', () => {
    const result = computeSyncUpdate(
      { status: '已发货', logistics_no: 'ZTO888', logistics_company: '', logistics_status: '' },
      { status: 'shipped', logistics_no: '', logistics_company: '' }
    )
    expect(result.hasChanges).toBe(true)
    expect(result.result.logistics_no).toBe('ZTO888')
  })
})

// ============ resolveLogisticsCompany 测试 ============

describe('resolveLogisticsCompany', () => {
  it('应优先使用 cpName', () => {
    expect(resolveLogisticsCompany('圆通速递', 'YTO')).toBe('圆通速递')
  })

  it('应在无 cpName 时用 cpCode 映射', () => {
    expect(resolveLogisticsCompany('', 'ZTO')).toBe('中通快递')
    expect(resolveLogisticsCompany(null, 'SF')).toBe('顺丰速运')
  })

  it('应大小写不敏感', () => {
    expect(resolveLogisticsCompany('', 'sf')).toBe('顺丰速运')
    expect(resolveLogisticsCompany('', 'Yto')).toBe('圆通速递')
  })

  it('应 trim cpName', () => {
    expect(resolveLogisticsCompany(' 韵达快递 ', 'YUNDA')).toBe('韵达快递')
  })

  it('应在两者都为空时返回空字符串', () => {
    expect(resolveLogisticsCompany('', '')).toBe('')
    expect(resolveLogisticsCompany(null, null)).toBe('')
  })

  it('应在 cpCode 无法映射时返回空字符串', () => {
    expect(resolveLogisticsCompany('', 'UNKNOWN_CODE')).toBe('')
  })
})

// ============ CP_CODE_MAP 测试 ============

describe('CP_CODE_MAP', () => {
  it('应包含主要快递公司代码', () => {
    const essential = ['YUNDA', 'ZTO', 'STO', 'SF', 'YTO', 'HTKY', 'JD', 'EMS', 'DBL']
    for (const code of essential) {
      expect(CP_CODE_MAP[code]).toBeTruthy()
    }
  })

  it('所有值都应为非空字符串', () => {
    for (const [code, name] of Object.entries(CP_CODE_MAP)) {
      expect(name).toBeTruthy()
      expect(typeof name).toBe('string')
    }
  })
})

// ============ CDP 网络捕获逻辑模拟测试 ============

describe('CDP API 关键词匹配逻辑', () => {
  const apiKeywords = PLATFORM_CONFIG.taobao.apiKeywords

  it('应匹配 mtop.taobao.order URL', () => {
    const url = 'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistv2/1.0/?data=...'
    const isTarget = apiKeywords.some(kw => url.toLowerCase().includes(kw.toLowerCase()))
    expect(isTarget).toBe(true)
  })

  it('应匹配 queryboughtlist URL', () => {
    const url = 'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistv2/1.0/'
    const isTarget = apiKeywords.some(kw => url.toLowerCase().includes(kw.toLowerCase()))
    expect(isTarget).toBe(true)
  })

  it('不应匹配无关 URL', () => {
    const url = 'https://img.alicdn.com/imgextra/i3/O1CN01.png'
    const isTarget = apiKeywords.some(kw => url.toLowerCase().includes(kw.toLowerCase()))
    expect(isTarget).toBe(false)
  })

  it('1688 应匹配含 orderList 的 URL', () => {
    const url = 'https://trade.1688.com/order/orderList.htm'
    const kw = PLATFORM_CONFIG['1688'].apiKeywords
    const isTarget = kw.some(k => url.toLowerCase().includes(k.toLowerCase()))
    expect(isTarget).toBe(true)
  })

  it('1688 应匹配含 trade 的 URL', () => {
    const url = 'https://trade.1688.com/api/trade/list'
    const kw = PLATFORM_CONFIG['1688'].apiKeywords
    const isTarget = kw.some(k => url.toLowerCase().includes(k.toLowerCase()))
    expect(isTarget).toBe(true)
  })

  it('拼多多应匹配含 orders 的 URL', () => {
    const url = 'https://mobile.yangkeduo.com/proxy/api/orders/list'
    const kw = PLATFORM_CONFIG.pinduoduo.apiKeywords
    const isTarget = kw.some(k => url.toLowerCase().includes(k.toLowerCase()))
    expect(isTarget).toBe(true)
  })
})

// ============ 端到端同步流程模拟测试 ============

describe('端到端同步流程模拟', () => {
  it('模拟淘宝单个订单同步 - CDP 捕获 → 解析 → 查找', () => {
    // 模拟 CDP 捕获的淘宝 API 响应
    const cdpResponseBody = JSON.stringify({
      ret: ['SUCCESS::调用成功'],
      data: {
        shopInfo_380847555: {
          id: '380847555123456',
          fields: { tradeTitle: '卖家已发货' }
        },
        orderStatus_380847555: {
          id: '380847555123456',
          fields: {
            mailNo: 'YT9388278500899',
            cpCode: 'YTO',
            title: '运输中'
          }
        },
        orderLogistics_380847555: {
          id: '380847555123456',
          fields: {
            packagePreview: {
              packageViewList: [{ cpName: '圆通速递' }]
            }
          }
        }
      }
    })

    // 模拟 CDP 捕获结果
    const capturedResponses = [
      {
        url: 'https://h5api.m.taobao.com/h5/mtop.taobao.order.queryboughtlistv2/1.0/',
        status: 200,
        body: cdpResponseBody,
        bodyLen: cdpResponseBody.length,
        time: Date.now()
      }
    ]

    // 查找目标订单
    const orderInfo = findOrderByPlatformOrderNo('taobao', '380847555123456', capturedResponses)
    expect(orderInfo).not.toBeNull()
    expect(orderInfo.order_no).toBe('380847555123456')
    expect(orderInfo.status).toBe('卖家已发货')
    expect(orderInfo.logistics_no).toBe('YT9388278500899')
    expect(orderInfo.logistics_company).toBe('圆通速递')

    // 模拟 computeSyncUpdate
    const updateResult = computeSyncUpdate(orderInfo, {
      status: 'pending',
      logistics_no: '',
      logistics_company: ''
    })
    expect(updateResult.result.status).toBe('shipped')
    expect(updateResult.result.logistics_no).toBe('YT9388278500899')
    expect(updateResult.result.logistics_company).toBe('圆通速递')
    expect(updateResult.hasChanges).toBe(true)
  })

  it('模拟淘宝批量同步 - CDP 捕获多个 API 响应 → 去重', () => {
    const body1 = JSON.stringify({
      ret: ['SUCCESS::调用成功'],
      data: {
        shopInfo_1: { id: 'ORDER-A', fields: { tradeTitle: '已发货' } },
        shopInfo_2: { id: 'ORDER-B', fields: { tradeTitle: '待发货' } }
      }
    })
    const body2 = JSON.stringify({
      ret: ['SUCCESS::调用成功'],
      data: {
        shopInfo_1: { id: 'ORDER-A', fields: { tradeTitle: '已发货' } },
        shopInfo_3: { id: 'ORDER-C', fields: { tradeTitle: '交易成功' } }
      }
    })

    const capturedResponses = [
      { url: 'https://h5api.m.taobao.com/mtop1', status: 200, body: body1, bodyLen: body1.length },
      { url: 'https://h5api.m.taobao.com/mtop2', status: 200, body: body2, bodyLen: body2.length }
    ]

    const allOrders = findAllOrders('taobao', capturedResponses)
    expect(allOrders).toHaveLength(3) // A, B, C (A 不重复)
    const orderNos = allOrders.map(o => o.order_no).sort()
    expect(orderNos).toEqual(['ORDER-A', 'ORDER-B', 'ORDER-C'])
  })

  it('模拟登录过期场景 - loginCheck 检测', () => {
    // 模拟 CDP 捕获到跳转登录页面
    const loginUrl = 'https://login.taobao.com/newlogin/login.htm'
    expect(PLATFORM_CONFIG.taobao.loginCheck(loginUrl)).toBe(true)
    // 此时应返回 needsRelogin: true
  })

  it('模拟无 API 响应场景 - 空捕获结果', () => {
    const capturedResponses = []
    const found = findOrderByPlatformOrderNo('taobao', 'ANY-ORDER', capturedResponses)
    expect(found).toBeNull()

    const all = findAllOrders('taobao', capturedResponses)
    expect(all).toEqual([])
  })
})
