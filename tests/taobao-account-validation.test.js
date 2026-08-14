import { describe, expect, it } from 'vitest'
import validation from '../src/main/taobao-account-validation.js'

const {
  buildTaobaoUserSimpleRequest,
  classifyTaobaoUserSimpleResponse,
  createTaobaoCookieFingerprint,
  extractTaobaoSimpleUser,
  hasTaobaoLoginCookie,
  selectTaobaoMtopToken
} = validation

describe('淘宝采购账号轻量校验', () => {
  it('按 MTOP 规则使用完整毫秒时间戳动态签名', () => {
    const request = buildTaobaoUserSimpleRequest('token-value', 1786512859772)
    const url = new URL(request.url)

    expect(url.pathname).toContain('/mtop.user.getusersimple/1.0/')
    expect(url.searchParams.get('api')).toBe('mtop.user.getUserSimple')
    expect(url.searchParams.get('t')).toBe('1786512859772')
    expect(url.searchParams.get('data')).toBe('{}')
    expect(request.sign).toMatch(/^[a-f0-9]{32}$/)
    expect(request.sign).toBe(buildTaobaoUserSimpleRequest('token-value', 1786512859772).sign)
    expect(request.sign).not.toBe(buildTaobaoUserSimpleRequest('other-token', 1786512859772).sign)
  })

  it('只接受未过期的淘宝登录 Cookie', () => {
    const future = Date.now() / 1000 + 3600
    const past = Date.now() / 1000 - 3600
    expect(hasTaobaoLoginCookie([{ name: 'cookie2', value: 'ok', domain: '.taobao.com', expirationDate: future }])).toBe(true)
    expect(hasTaobaoLoginCookie([{ name: 'cookie2', value: 'old', domain: '.taobao.com', expirationDate: past }])).toBe(false)
    expect(hasTaobaoLoginCookie([{ name: 'cookie2', value: 'wrong', domain: '.pinduoduo.com' }])).toBe(false)
  })

  it('优先选择实际发往 h5api 域的 Token', () => {
    const token = selectTaobaoMtopToken([
      { name: '_m_h5_tk', value: 'root-token_123', domain: '.taobao.com', path: '/' },
      { name: '_m_h5_tk', value: 'api-token_456', domain: 'h5api.m.taobao.com', path: '/' }
    ])
    expect(token).toBe('api-token')
  })

  it('Cookie 指纹随账号身份或 Token 变化且不暴露原值', () => {
    const first = createTaobaoCookieFingerprint([
      { name: 'unb', value: '10001', domain: '.taobao.com', path: '/' },
      { name: '_m_h5_tk', value: 'secret-token_123', domain: '.taobao.com', path: '/' }
    ])
    const same = createTaobaoCookieFingerprint([
      { name: '_m_h5_tk', value: 'secret-token_123', domain: '.taobao.com', path: '/' },
      { name: 'unb', value: '10001', domain: '.taobao.com', path: '/' }
    ])
    const changed = createTaobaoCookieFingerprint([
      { name: 'unb', value: '10002', domain: '.taobao.com', path: '/' },
      { name: '_m_h5_tk', value: 'secret-token_123', domain: '.taobao.com', path: '/' }
    ])

    expect(first).toBe(same)
    expect(first).not.toBe(changed)
    expect(first).not.toContain('secret-token')
  })

  it('从成功响应中提取稳定用户 ID 和昵称', () => {
    const payload = {
      ret: ['SUCCESS::调用成功'],
      data: { userInfo: { userId: '2208045741511', nick: '淘宝用户' }, isLogin: true }
    }
    expect(extractTaobaoSimpleUser(payload)).toEqual({
      userId: '2208045741511',
      nick: '淘宝用户',
      isLogin: true
    })
    expect(classifyTaobaoUserSimpleResponse(payload)).toMatchObject({
      status: 'valid',
      userId: '2208045741511',
      nick: '淘宝用户'
    })
  })

  it('明确区分失效、风控、Token 初始化和繁忙，避免误判离线', () => {
    expect(classifyTaobaoUserSimpleResponse({ ret: ['FAIL_SYS_SESSION_EXPIRED::会话过期'] }).status).toBe('invalid')
    expect(classifyTaobaoUserSimpleResponse({ ret: ['FAIL_SYS_USER_VALIDATE::需要验证'] }).status).toBe('risk')
    expect(classifyTaobaoUserSimpleResponse({ ret: ['FAIL_SYS_TOKEN_EXPIRED::令牌过期'] }).status).toBe('token')
    expect(classifyTaobaoUserSimpleResponse({ ret: ['FAIL_SYS_TRAFFIC_LIMIT::被挤爆'] }).status).toBe('unknown')
    expect(classifyTaobaoUserSimpleResponse({ ret: ['SUCCESS::调用成功'], data: {} }).status).toBe('unknown')
  })
})
