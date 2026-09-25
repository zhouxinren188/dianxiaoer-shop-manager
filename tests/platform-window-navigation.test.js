import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { isExpectedNavigationAbort, createStandardChromeIdentity } = require('../src/main/platform-window-navigation')

describe('平台登录窗口的初始导航', () => {
  it('把 Electron 的 ERR_ABORTED（-3）识别为正常重定向，而非页面加载失败', () => {
    expect(isExpectedNavigationAbort({ code: 'ERR_ABORTED' })).toBe(true)
    expect(isExpectedNavigationAbort(new Error("ERR_ABORTED (-3) loading 'https://passport.shop.jd.com/'"))).toBe(true)
    expect(isExpectedNavigationAbort(new Error('ERR_CONNECTION_TIMED_OUT (-118)'))).toBe(false)
  })

  it('京东登录窗口使用标准 Chrome 身份，避免 Electron 标识影响初始化配置接口', () => {
    const identity = createStandardChromeIdentity('140.0.7339.2')
    expect(identity.userAgent).toContain('Chrome/140.0.7339.2')
    expect(identity.userAgent).not.toContain('Electron')
    expect(identity.secChUa).toContain('Google Chrome";v="140"')
  })
})
