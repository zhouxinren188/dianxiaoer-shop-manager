import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { decideTaobaoCookieSource } = require('../src/main/taobao-cookie-source-policy')

describe('淘宝采购窗口 Cookie 来源策略', () => {
  it('本地缺少登录 Cookie 时恢复云端', () => {
    expect(decideTaobaoCookieSource({ hasLocalLogin: false, validationStatus: 'invalid' })).toEqual({
      restoreFromServer: true,
      reason: 'local_login_cookie_missing'
    })
  })

  it.each(['invalid', 'mismatch'])('本地被明确判定为 %s 时恢复云端', status => {
    expect(decideTaobaoCookieSource({ hasLocalLogin: true, validationStatus: status }).restoreFromServer).toBe(true)
  })

  it.each(['valid', 'unknown', 'risk'])('本地状态为 %s 时保留当前设备会话', status => {
    expect(decideTaobaoCookieSource({ hasLocalLogin: true, validationStatus: status }).restoreFromServer).toBe(false)
  })

  it('验证过程异常时按 unknown 处理，不清空本地 Cookie', () => {
    expect(decideTaobaoCookieSource({ hasLocalLogin: true })).toEqual({
      restoreFromServer: false,
      reason: 'local_session_preserved_unknown'
    })
  })
})
