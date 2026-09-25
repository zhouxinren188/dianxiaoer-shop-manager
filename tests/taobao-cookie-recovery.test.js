import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  filterCookiesForPlatform,
  hasValidPlatformCookies
} = require('../src/main/purchase-order-sync/common')

describe('淘宝采购账号 Cookie 恢复', () => {
  it('追踪 Cookie 不算登录，必须存在淘宝账号登录 Cookie', () => {
    expect(hasValidPlatformCookies([
      { name: 'cna', value: 'tracking', domain: '.taobao.com' },
      { name: '_m_h5_tk', value: 'mtop-token', domain: 'h5api.m.taobao.com' }
    ], 'taobao')).toBe(false)
    expect(hasValidPlatformCookies([
      { name: 'cookie2', value: 'login-token', domain: '.taobao.com' }
    ], 'taobao')).toBe(true)
  })

  it('恢复和导出只接受当前平台域名', () => {
    expect(filterCookiesForPlatform([
      { name: 'cookie2', domain: '.taobao.com' },
      { name: 'ali-token', domain: '.1688.com' },
      { name: 'evil', domain: '.fake-taobao.com' }
    ], 'taobao')).toEqual([{ name: 'cookie2', domain: '.taobao.com' }])
  })

  it('本地淘宝会话失效时绕过缓存并强制恢复云端后复核', () => {
    const source = fs.readFileSync(path.resolve('src/main/purchase-order-sync/taobao.js'), 'utf8')
    expect(source).toContain("restoreCookiesFromServer(accountId, 'taobao', { force: true })")
    expect(source).toContain("validateTaobaoPurchaseAccount({ accountId, ses, force: true })")
    expect(source.match(/await prepareTaobaoSession\(accountId, ses,/g)).toHaveLength(2)
  })

  it('账号管理的手动检测也会在本地无效时先恢复云端一次', () => {
    const source = fs.readFileSync(path.resolve('src/main/platform-window.js'), 'utf8')
    const handlerStart = source.indexOf("ipcMain.handle('validate-taobao-purchase-account'")
    const handlerEnd = source.indexOf("// 导出采购账号 Cookie", handlerStart)
    const handler = source.slice(handlerStart, handlerEnd)
    expect(handler).toContain("restoreCookiesFromServer(accountId, 'taobao', { force: true })")
    expect(handler).toContain("validation.status === 'invalid' || validation.status === 'mismatch'")
    expect(handler).toContain("validateTaobaoPurchaseAccount({ accountId, ses, force: true })")
  })
})
