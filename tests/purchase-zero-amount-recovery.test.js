import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/main/purchase-order-capture.js', import.meta.url), 'utf8')

describe('淘宝采购金额为 0 的付款成功页补抓', () => {
  it('只为首次未抓到实付金额的淘宝/天猫订单保留补抓状态', () => {
    expect(source).toContain("(platform === 'taobao' || platform === 'tmall')")
    expect(source).toContain('!(Number(capturedAmount) > 0)')
    expect(source).toContain('首次未抓到实付金额，准备从收银台或淘宝会话补抓')
  })

  it('页面内抓取失败后使用当前采购账号 session 直查金额', () => {
    expect(source).toContain('async function fetchTaobaoOrderAmountFromSession(ses, platformOrderNo)')
    expect(source).toContain('await ses.fetch(')
    expect(source).toContain('淘宝会话直查获取金额')
  })

  it('优先读取已经渲染的收银台实付金额并写回对应订单', () => {
    expect(source).toContain('executeJavaScript(EXTRACT_PAYMENT_AMOUNT, true)')
    expect(source).toContain("source: 'payment_page'")
    expect(source).toContain('row.platform_order_no) === recoveryOrderNo')
    expect(source).toContain('amountUpdated: true')
  })

  it('由页面导航事件触发一次性补抓，不创建后台轮询定时器', () => {
    expect(source).toContain("recoverTaobaoAmountAfterCapture(url, 'did-navigate')")
    expect(source).toContain("recoverTaobaoAmountAfterCapture(url, 'did-navigate-in-page')")
    expect(source).toContain("recoverTaobaoAmountAfterCapture(url, 'dom-ready')")

    const recoveryBlock = source.slice(
      source.indexOf('async function recoverTaobaoAmountAfterCapture'),
      source.indexOf('function onOrderCaptured')
    )
    expect(recoveryBlock).not.toContain('setTimeout(')
    expect(recoveryBlock).not.toContain('setInterval(')
  })

  it('可信支付成功页会把未付款状态立即更新为已付款待发货', () => {
    expect(source).toContain('async function markTaobaoPaidFromTrustedSuccess(url, source)')
    expect(source).toContain('trustedOrderNo !== capturedPlatformOrderNo')
    expect(source).toContain("purchaseRow.status === 'ordered'")
    expect(source).toContain("body: JSON.stringify({ status: 'pending' })")
    expect(source).toContain('statusUpdated: true')
  })
})
