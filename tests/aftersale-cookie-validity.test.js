import { describe, expect, it } from 'vitest'
import common from '../src/main/purchase-order-sync/common.js'

const { hasValidPlatformCookies } = common

describe('售后同步京东 Cookie 有效性', () => {
  it('只接受未过期的京东域名 Cookie', () => {
    const now = Date.now() / 1000
    expect(hasValidPlatformCookies([
      { domain: '.jd.com', expirationDate: now + 60 }
    ], 'jd')).toBe(true)
    expect(hasValidPlatformCookies([
      { domain: '.jd.com', expirationDate: now - 60 }
    ], 'jd')).toBe(false)
    expect(hasValidPlatformCookies([
      { domain: '.taobao.com', expirationDate: now + 60 }
    ], 'jd')).toBe(false)
  })

  it('接受京东会话 Cookie 与 jd.hk 域名', () => {
    expect(hasValidPlatformCookies([
      { domain: '.jd.hk' }
    ], 'jd')).toBe(true)
  })
})
