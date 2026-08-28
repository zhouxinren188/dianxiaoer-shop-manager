import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { extractPendingInvoices, normalizePendingInvoice } = require('../src/main/pending-invoices')

describe('京东待开发票明细提取', () => {
  it('仅保留首页展示所需字段并把订单号保存为字符串', () => {
    const result = extractPendingInvoices({
      code: 200,
      data: {
        totalCount: 2,
        data: [{
          orderId: 3548493006727882,
          invoiceTitle: '重庆安喆商贸有限公司',
          invoiceAmount: 345.8,
          companyName: '宿迁兔乐兔电子商务有限公司',
          applyTime: 1787713559000,
          countdownEndTime: 1,
          consumerPhone: '不应保存'
        }]
      }
    })

    expect(result).toEqual({
      total: 2,
      items: [{
        orderId: '3548493006727882',
        invoiceTitle: '重庆安喆商贸有限公司',
        invoiceAmount: 345.8,
        companyName: '宿迁兔乐兔电子商务有限公司',
        applyTime: 1787713559000,
        countdownEndTime: 1788577559000
      }]
    })
    expect(result.items[0]).not.toHaveProperty('consumerPhone')
  })

  it('过滤无效订单、去重并安全处理异常字段', () => {
    const duplicate = {
      orderId: '3548493006727882',
      invoiceTitle: '测试抬头',
      invoiceAmount: 'not-a-number',
      companyName: '测试主体',
      applyTime: -1,
      countdownEndTime: 1788577559000
    }
    const result = extractPendingInvoices({
      data: { data: [duplicate, duplicate, { orderId: 'bad' }] }
    })

    expect(result.total).toBe(1)
    expect(result.items).toEqual([{
      orderId: '3548493006727882',
      invoiceTitle: '测试抬头',
      invoiceAmount: 0,
      companyName: '测试主体',
      applyTime: null,
      countdownEndTime: null
    }])
    expect(normalizePendingInvoice(null)).toBeNull()
  })
})
