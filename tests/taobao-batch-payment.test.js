import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  EXTRACT_ALIPAY_TAOBAO_ORDER_CANDIDATES,
  buildBatchPaymentManualBindingNoticeScript,
  extractTrustedTaobaoOrderNoFromUrl,
  isTaobaoBatchPaymentUrl,
  selectSingleTaobaoOrderCandidate
} = require('../src/main/taobao-batch-payment')

describe('淘宝合并支付订单号处理', () => {
  it('只识别支付宝合并支付，不把普通单笔支付标记为批量支付', () => {
    expect(isTaobaoBatchPaymentUrl('https://tbapi.alipay.com/trade/batch_payment.htm?x=1')).toBe(true)
    expect(isTaobaoBatchPaymentUrl('https://cashierea178.alipay.com/business/acceptPay.htm?tradeNo=1%3B2&bizIdentity=merge10001')).toBe(true)
    expect(isTaobaoBatchPaymentUrl('https://tbapi.alipay.com/trade/trade_payment.htm?x=1')).toBe(false)
    expect(isTaobaoBatchPaymentUrl('https://item.taobao.com/item.htm?id=1005306455324')).toBe(false)
  })

  it('拒绝支付宝 tradeNo，只接受受信任淘宝订单详情链接里的订单号', () => {
    expect(extractTrustedTaobaoOrderNoFromUrl(
      'https://cashierea178.alipay.com/business/acceptPay.htm?tradeNo=2026082823001142941433495287'
    )).toBe('')
    expect(extractTrustedTaobaoOrderNoFromUrl(
      'https://buyertrade.taobao.com/trade/detail/trade_order_detail.htm?bizOrderId=4123456789012345678'
    )).toBe('4123456789012345678')
    expect(extractTrustedTaobaoOrderNoFromUrl(
      'https://trade.taobao.com/trade/detail/trade_item_detail.htm?biz_order_id=5123456789012345678'
    )).toBe('5123456789012345678')
    expect(extractTrustedTaobaoOrderNoFromUrl(
      'https://item.taobao.com/item.htm?orderId=4123456789012345678&id=1005306455324'
    )).toBe('')
  })

  it('支付页只出现一个可信候选时返回订单号，多个候选时停止自动绑定', () => {
    expect(selectSingleTaobaoOrderCandidate([
      { url: 'https://cashier.alipay.com', candidates: [{ field: 'out_trade_no', value: '4123456789012345678' }] }
    ])).toMatchObject({ orderNo: '4123456789012345678', reason: 'single_out_trade_no' })

    expect(selectSingleTaobaoOrderCandidate([
      {
        url: 'https://cashier.alipay.com',
        candidates: [
          { field: 'out_trade_no', value: '4123456789012345678' },
          { field: 'out_trade_no', value: '5123456789012345678' }
        ]
      }
    ])).toMatchObject({ orderNo: '', reason: 'ambiguous_out_trade_no_candidates' })
  })

  it('强字段唯一时优先于页面内其他外部交易号', () => {
    expect(selectSingleTaobaoOrderCandidate([
      {
        url: 'https://cashier.alipay.com',
        candidates: [
          { field: 'bizOrderId', value: '4123456789012345678' },
          { field: 'out_trade_no', value: '5123456789012345678' }
        ]
      }
    ])).toMatchObject({ orderNo: '4123456789012345678', reason: 'single_strong_candidate' })
  })

  it('提取脚本和手动绑定提示脚本均可编译，提示包含查看订单指引', () => {
    expect(() => new Function(`return ${EXTRACT_ALIPAY_TAOBAO_ORDER_CANDIDATES}`)).not.toThrow()
    const notice = buildBatchPaymentManualBindingNoticeScript('A9251')
    expect(() => new Function(notice)).not.toThrow()
    expect(notice).toContain('重要提醒')
    expect(notice).toContain('查看订单')
    expect(notice).toContain('手动绑定')
    expect(notice).toContain('A9251')
  })
})
