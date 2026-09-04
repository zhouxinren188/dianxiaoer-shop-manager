import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  hasValidPlatformCookies,
  evaluatePurchaseCookieState,
  sanitizePurchaseAccountRow,
  purchaseAccountMetadataChanged
} = require('../server/services/purchase-account-policy')

describe('采购账号安全与 Cookie 状态策略', () => {
  const now = 2_000_000_000

  it('只把平台域名内且未过期的 Cookie 判定为有效', () => {
    expect(hasValidPlatformCookies([
      { name: 'sid', value: 'ok', domain: '.taobao.com', expirationDate: now + 60 }
    ], 'taobao', now)).toBe(true)

    expect(hasValidPlatformCookies([
      { name: 'sid', value: 'expired', domain: '.taobao.com', expirationDate: now - 1 },
      { name: 'sid', value: 'wrong-domain', domain: '.example.com', expirationDate: now + 60 }
    ], 'taobao', now)).toBe(false)

    expect(hasValidPlatformCookies([
      { name: 'api_uid', value: 'session-cookie', domain: '.yangkeduo.com', session: true }
    ], 'pinduoduo', now)).toBe(true)
  })

  it('淘宝服务端曾校验成功也不能掩盖本地 Cookie 已过期', () => {
    expect(evaluatePurchaseCookieState({
      platform: 'taobao',
      cookie_status: 'valid',
      cookie_data: JSON.stringify([
        { name: '_m_h5_tk', value: 'expired', domain: '.taobao.com', expirationDate: now - 1 }
      ])
    }, now)).toEqual({ cookieValid: false, status: 'invalid' })
  })

  it('账号列表只返回是否已保存密码，不泄露密码和 Cookie 原文', () => {
    const safe = sanitizePurchaseAccountRow({
      id: 7,
      account: 'buyer-a',
      password: 'secret-password',
      platform: '1688',
      cookie_data: JSON.stringify([
        { name: 'token', value: 'secret-cookie', domain: '.1688.com', expirationDate: now + 60 }
      ])
    }, now)

    expect(safe).not.toHaveProperty('password')
    expect(safe).not.toHaveProperty('cookie_data')
    expect(safe.has_password).toBe(true)
    expect(safe.cookie_valid).toBe(true)
    expect(safe.online).toBe(1)
  })

  it('只有账号或平台发生实质变化时才要求清理旧会话', () => {
    const current = { account: 'buyer-a', platform: 'taobao' }
    expect(purchaseAccountMetadataChanged(current, { account: 'buyer-a', platform: 'taobao' })).toBe(false)
    expect(purchaseAccountMetadataChanged(current, { account: 'buyer-b' })).toBe(true)
    expect(purchaseAccountMetadataChanged(current, { platform: '1688' })).toBe(true)
  })

  it('主进程和界面接入业务响应校验、完整分区清理和密码脱敏', () => {
    const mainSource = fs.readFileSync(path.resolve('src/main/platform-window.js'), 'utf8')
    const preloadSource = fs.readFileSync(path.resolve('src/preload/index.js'), 'utf8')
    const rendererSource = fs.readFileSync(path.resolve('src/renderer/src/views/purchase/PurchaseOrder.vue'), 'utf8')
    const serverSource = fs.readFileSync(path.resolve('server/index.js'), 'utf8')

    expect(mainSource).toContain('requireBusinessResponse(saveResponse')
    expect(mainSource).toContain("ipcMain.handle('reset-purchase-account-session'")
    expect(mainSource).toContain("ipcMain.handle('remove-purchase-account-session'")
    expect(mainSource).toContain('await ses.clearStorageData()')
    expect(mainSource).toContain('ses.flushStorageData()')
    expect(mainSource).not.toContain('new Promise(resolve => ses.flushStorageData(resolve))')
    expect(mainSource).toContain('session_replaced: sessionReplaced')
    expect(mainSource).toContain('if (loginDetected && cookies && cookies.length > 0)')
    expect(mainSource).toContain('const sessionReplaced = loginDetected && !persistenceFailed && cookies.length > 0')
    expect(mainSource).toContain('loginDetected && !persistenceFailed && cookies.length > 0)')
    expect(preloadSource).toContain("'reset-purchase-account-session'")
    expect(preloadSource).toContain("'remove-purchase-account-session'")
    expect(rendererSource).toContain("row.has_password ? '已保存' : '未设置'")
    expect(rendererSource).not.toContain('{{ row.password }}')
    expect(rendererSource).toContain('账号信息已更新，但本地登录会话清理失败')
    expect(rendererSource).toContain('账号已删除，但本地登录会话清理失败')
    expect(serverSource).toContain('...sanitizePurchaseAccountRow(row)')
    expect(serverSource).toContain("req.user.user_type === 'sub'")
    expect(serverSource).toContain('session_reset_required: metadataChanged && !sessionReplaced')
    expect(serverSource).toContain("SET online = 0, cookie_status = 'unknown'")
    expect(serverSource).toContain("SET cookie_status = 'unknown', cookie_status_reason = 'login_session_replaced'")
  })
})
