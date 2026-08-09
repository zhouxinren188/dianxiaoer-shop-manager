import { describe, expect, it } from 'vitest'
import jdVendorSession from '../src/main/jd-vendor-session.js'

const { parseJdVendorSessionResponse } = jdVendorSession

describe('parseJdVendorSessionResponse', () => {
  it('确认当前商家身份匹配', () => {
    const result = parseJdVendorSessionResponse({
      statusCode: 200,
      body: JSON.stringify({ currentVendor: { vendorId: 92032658, shopName: '测试店铺' } }),
      expectedMerchantId: '92032658'
    })

    expect(result).toMatchObject({
      valid: true,
      reason: 'vendor_identity_verified',
      vendorId: '92032658',
      vendorName: '测试店铺'
    })
  })

  it('兼容 data.currentVendor 和 JSONP', () => {
    const result = parseJdVendorSessionResponse({
      statusCode: 200,
      body: 'callback({"data":{"currentVendor":{"venderId":"123456"}}});'
    })

    expect(result).toMatchObject({
      valid: true,
      reason: 'vendor_identity_verified_without_expected_id',
      vendorId: '123456'
    })
  })

  it('商家身份不匹配时明确失败', () => {
    const result = parseJdVendorSessionResponse({
      statusCode: 200,
      body: JSON.stringify({ currentVendor: { vendorId: '222222' } }),
      expectedMerchantId: '111111'
    })

    expect(result).toMatchObject({
      valid: false,
      reason: 'vendor_identity_mismatch',
      vendorId: '222222',
      expectedMerchantId: '111111'
    })
  })

  it('登录重定向时明确失败', () => {
    const result = parseJdVendorSessionResponse({
      statusCode: 302,
      headers: { location: 'https://passport.jd.com/new/login.aspx' }
    })

    expect(result).toMatchObject({ valid: false, reason: 'login_redirect' })
  })

  it.each([403, 404, 429, 500, 502])('HTTP %s 只判定为不确定', (statusCode) => {
    expect(parseJdVendorSessionResponse({ statusCode })).toMatchObject({
      valid: null,
      reason: `http_${statusCode}`
    })
  })

  it('响应结构变化时保持不确定', () => {
    expect(parseJdVendorSessionResponse({
      statusCode: 200,
      body: JSON.stringify({ code: 200, data: {} })
    })).toMatchObject({ valid: null, reason: 'current_vendor_missing' })
  })

  it('登录文本响应时明确失败', () => {
    expect(parseJdVendorSessionResponse({
      statusCode: 200,
      body: '<html>请先登录 <a href="https://passport.jd.com">登录</a></html>'
    })).toMatchObject({ valid: false, reason: 'login_response' })
  })
})
