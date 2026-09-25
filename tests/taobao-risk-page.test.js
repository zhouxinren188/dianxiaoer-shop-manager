import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { findTaobaoRiskMarker, TAOBAO_RISK_PAGE_PROBE_SCRIPT } = require('../src/main/taobao-risk-page')

describe('淘宝访问异常页识别', () => {
  it('识别淘宝商品页访问异常提示', () => {
    expect(findTaobaoRiskMarker('系统检测到当前访问存在异常，为避免您的个人信息泄露')).toBe('当前访问存在异常')
  })

  it('普通商品文案不误报', () => {
    expect(findTaobaoRiskMarker('商品详情 立即购买 加入购物车')).toBe('')
  })

  it('探测脚本只读取页面状态，不修改 DOM', () => {
    expect(TAOBAO_RISK_PAGE_PROBE_SCRIPT).toContain('document.body.innerText')
    expect(TAOBAO_RISK_PAGE_PROBE_SCRIPT).not.toContain('appendChild')
    expect(TAOBAO_RISK_PAGE_PROBE_SCRIPT).not.toContain('remove()')
  })
})
