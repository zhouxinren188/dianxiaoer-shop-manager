import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { extractMetrics } = require('../src/main/aftersale-metrics')

describe('京东首页待办指标提取', () => {
  it('提取消费者发票和物流异常并忽略尚未映射的首页指标', () => {
    const metrics = extractMetrics({
      data: {
        realSchedules: [{
          id: 101,
          name: '订单',
          data: [
            { id: 1011, name: '物流异常', value: '2' },
            { id: 1012, name: '消费者发票', value: '3' },
            { id: 1999, name: '以后首页使用的指标', value: '9' }
          ]
        }]
      }
    })

    expect(metrics).toEqual({
      pending_logistics_exceptions: 2,
      pending_consumer_invoices: 3
    })
  })

  it('无效数字按零处理且缺失响应不会报错', () => {
    expect(extractMetrics({})).toEqual({})
    expect(extractMetrics({
      data: { realSchedules: [{ data: [{ id: 1012, value: '未知' }] }] }
    })).toEqual({ pending_consumer_invoices: 0 })
  })
})
