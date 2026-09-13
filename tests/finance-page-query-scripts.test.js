import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  PENDING_INVOICE_QUERY_RENDERER_SOURCE,
  SETTLEMENT_QUERY_RENDERER_SOURCE
} = require('../src/main/finance-page-query-scripts')

const settlementFetchSource = readFileSync(
  new URL('../src/main/settlement-fetch.js', import.meta.url),
  'utf8'
)
const aftersaleFetchSource = readFileSync(
  new URL('../src/main/aftersale-fetch.js', import.meta.url),
  'utf8'
)

describe('正式版京麦财务页面脚本', () => {
  it('结算概况使用静态源码，不依赖字节码函数序列化', () => {
    expect(settlementFetchSource).toContain("require('./finance-page-query-scripts')")
    expect(settlementFetchSource).not.toContain('querySettlement.toString()')
    expect(SETTLEMENT_QUERY_RENDERER_SOURCE).not.toContain('[native code]')
    expect(SETTLEMENT_QUERY_RENDERER_SOURCE).toContain('post(config.pendingApi, pendingBody)')
    expect(settlementFetchSource).toContain('querySumBalAndCount')
    expect(() => new Function(`return ${SETTLEMENT_QUERY_RENDERER_SOURCE}`)).not.toThrow()
  })

  it('待开票明细使用静态源码，不依赖字节码函数序列化', () => {
    expect(aftersaleFetchSource).toContain("require('./finance-page-query-scripts')")
    expect(aftersaleFetchSource).not.toContain('queryPendingInvoices.toString()')
    expect(PENDING_INVOICE_QUERY_RENDERER_SOURCE).not.toContain('[native code]')
    expect(PENDING_INVOICE_QUERY_RENDERER_SOURCE).toContain('signer.sign({ body: bodyHash, appId, api')
    expect(aftersaleFetchSource).toContain('queryPendingReviewApplyOrderList')
    expect(() => new Function(`return ${PENDING_INVOICE_QUERY_RENDERER_SOURCE}`)).not.toThrow()
  })
})
