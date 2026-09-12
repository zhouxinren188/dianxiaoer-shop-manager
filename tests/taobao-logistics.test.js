import { describe, expect, it } from 'vitest'
import taobaoLogistics from '../src/main/purchase-order-sync/taobao-logistics.js'

const {
  parseTaobaoPickupCode,
  extractTaobaoPickupInfo,
  shouldFetchTaobaoLogisticsDetails,
  isRelevantTaobaoLogisticsResult
} = taobaoLogistics

describe('淘宝物流取件信息解析', () => {
  it('从 package 标题提取取件码', () => {
    expect(parseTaobaoPickupCode('待取件 8-9-1234')).toBe('8-9-1234')
    expect(parseTaobaoPickupCode('运输中')).toBe('')
    expect(parseTaobaoPickupCode('待取件')).toBe('待取件')
  })

  it('按 DL 结构提取取件码和第一条物流详情地址', () => {
    const result = extractTaobaoPickupInfo({
      popupBodyCompony: {
        fields: { name: '圆通速递', mailNo: 'YT123' }
      },
      package: {
        tag: 'package',
        type: 'native$logisticsdetail_package',
        fields: { title: [{ text: '待取件 ' }, { text: 'A-12-08' }] }
      },
      logisticsDetailLine_0: {
        tag: 'logisticsDetailLine',
        fields: {
          desc: [{ text: '包裹已到达 沭阳菜鸟驿站' }, { text: '，请及时取件' }]
        }
      },
      logisticsDetailLine_1: {
        tag: 'logisticsDetailLine',
        fields: { desc: [{ text: '较晚的一条物流信息' }] }
      }
    })

    expect(result).toEqual({
      pickup_code: 'A-12-08',
      pickup_address: '包裹已到达 沭阳菜鸟驿站，请及时取件'
    })
  })

  it('已取得运单号时即使订单状态仍为已下单也会进入物流页', () => {
    expect(shouldFetchTaobaoLogisticsDetails({
      status: 'ordered',
      logistics_no: '611710192455234',
      logistics_tracking: null,
      pickup_code: '',
      pickup_address: ''
    }, 'ordered')).toBe(true)
  })

  it('接受不携带平台订单号但包含预期运单或真实轨迹的物流响应', () => {
    expect(isRelevantTaobaoLogisticsResult({
      logistics_no: '611710192455234',
      logistics_tracking: null
    }, { data: { mailNo: '611710192455234' } }, '5127742765049036021', '611710192455234')).toBe(true)

    expect(isRelevantTaobaoLogisticsResult({
      logistics_no: '',
      logistics_tracking: [{ time: '2026-09-12 10:00', context: '包裹运输中' }]
    }, { data: {} }, '5127742765049036021')).toBe(true)
  })
})
