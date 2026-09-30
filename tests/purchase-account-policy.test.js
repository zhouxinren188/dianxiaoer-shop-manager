import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  hasValidPlatformCookies,
  evaluatePurchaseCookieState,
  normalizePurchaseCookieSnapshot,
  sanitizePurchaseAccountRow,
  purchaseAccountMetadataChanged
} = require('../server/services/purchase-account-policy')

describe('采购账号安全与 Cookie 状态策略', () => {
  const now = 2_000_000_000

  it('只把平台域名内且未过期的 Cookie 判定为有效', () => {
    expect(hasValidPlatformCookies([
      { name: 'cookie2', value: 'ok', domain: '.taobao.com', expirationDate: now + 60 }
    ], 'taobao', now)).toBe(true)

    expect(hasValidPlatformCookies([
      { name: 'cookie2', value: 'expired', domain: '.taobao.com', expirationDate: now - 1 },
      { name: 'sid', value: 'wrong-domain', domain: '.example.com', expirationDate: now + 60 }
    ], 'taobao', now)).toBe(false)

    expect(hasValidPlatformCookies([
      { name: 'api_uid', value: 'session-cookie', domain: '.yangkeduo.com', session: true }
    ], 'pinduoduo', now)).toBe(true)
  })

  it('淘宝追踪 Cookie 不能冒充登录凭证', () => {
    expect(hasValidPlatformCookies([
      { name: 'cna', value: 'tracking-only', domain: '.taobao.com', expirationDate: now + 60 },
      { name: '_m_h5_tk', value: 'token-only', domain: '.taobao.com', expirationDate: now + 60 }
    ], 'taobao', now)).toBe(false)
    expect(evaluatePurchaseCookieState({
      platform: 'taobao',
      cookie_status: 'valid',
      cookie_data: JSON.stringify([
        { name: 'cna', value: 'tracking-only', domain: '.taobao.com', expirationDate: now + 60 }
      ])
    }, now)).toEqual({ cookieValid: false, status: 'invalid' })
  })

  it('Cookie 保存使用当前平台完整快照，过滤其他平台且不保留旧快照', () => {
    const snapshot = normalizePurchaseCookieSnapshot([
      { name: 'cookie2', value: 'old', domain: '.taobao.com', path: '/' },
      { name: 'cookie2', value: 'new', domain: '.taobao.com', path: '/' },
      { name: 'ali-token', value: 'wrong-platform', domain: '.1688.com', path: '/' },
      { name: 'alipay-session', value: 'related', domain: '.alipay.com', path: '/' }
    ], 'taobao')
    expect(snapshot).toEqual([
      { name: 'cookie2', value: 'new', domain: '.taobao.com', path: '/' },
      { name: 'alipay-session', value: 'related', domain: '.alipay.com', path: '/' }
    ])
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
    const commonSource = fs.readFileSync(path.resolve('src/main/purchase-order-sync/common.js'), 'utf8')
    const preloadSource = fs.readFileSync(path.resolve('src/preload/index.js'), 'utf8')
    const rendererSource = fs.readFileSync(path.resolve('src/renderer/src/views/purchase/PurchaseOrder.vue'), 'utf8')
    const serverSource = fs.readFileSync(path.resolve('server/index.js'), 'utf8')

    expect(mainSource).toContain('requireBusinessResponse(saveResponse')
    expect(mainSource).toContain("ipcMain.handle('reset-purchase-account-session'")
    expect(mainSource).toContain("ipcMain.handle('remove-purchase-account-session'")
    expect(mainSource).toContain('await ses.clearStorageData()')
    expect(mainSource).toContain('ses.flushStorageData()')
    expect(mainSource).not.toContain('new Promise(resolve => ses.flushStorageData(resolve))')
    expect(commonSource).not.toContain('new Promise(resolve => ses.flushStorageData(resolve))')
    expect(mainSource).toContain('session_replaced: sessionReplaced')
    expect(mainSource).toContain('if (loginDetected && cookies && cookies.length > 0)')
    expect(mainSource).toContain('const sessionReplaced = loginDetected && !persistenceFailed && cookies.length > 0')
    expect(mainSource).toContain('loginDetected && !persistenceFailed && cookies.length > 0)')
    expect(preloadSource).toContain("'reset-purchase-account-session'")
    expect(preloadSource).toContain("'remove-purchase-account-session'")
    expect(rendererSource).toContain("row.has_password ? '已保存' : '未设置'")
    expect(rendererSource).not.toContain('{{ row.password }}')
    expect(rendererSource).toContain('账号信息已更新，但本机凭据或登录会话处理不完整')
    expect(rendererSource).toContain('账号已删除，但本地登录会话清理失败')
    expect(serverSource).toContain('...sanitizePurchaseAccountRow(row)')
    expect(serverSource).toContain("req.user.user_type === 'sub'")
    expect(serverSource).toContain('session_reset_required: metadataChanged && !sessionReplaced')
    expect(serverSource).toContain("SET online = 0, cookie_status = 'unknown'")
    expect(serverSource).toContain("SET cookie_status = 'unknown', cookie_status_reason = 'login_session_replaced'")
    expect(serverSource).toContain('normalizePurchaseCookieSnapshot(submittedCookies, normalizedPlatform)')
    expect(serverSource).not.toContain('const mergedCookies = [...cookieMap.values()]')
  })

  it('采购登录从本机加密凭据代填，并兼容迁移旧版已保存密码', () => {
    const mainSource = fs.readFileSync(path.resolve('src/main/platform-window.js'), 'utf8')
    const vaultSource = fs.readFileSync(path.resolve('src/main/purchase-account-credential-vault.js'), 'utf8')
    const rendererSource = fs.readFileSync(path.resolve('src/renderer/src/views/purchase/PurchaseOrder.vue'), 'utf8')
    const serverSource = fs.readFileSync(path.resolve('server/index.js'), 'utf8')

    expect(vaultSource).toContain('safeStorage.encryptString')
    expect(vaultSource).toContain('safeStorage.decryptString')
    expect(vaultSource).toContain("const VAULT_FILE = 'purchase-account-credentials.enc.json'")
    expect(mainSource).toContain('getPurchaseAccountCredential(accountId)')
    expect(mainSource).toContain('serverCredentialMayBeNewer')
    expect(mainSource).toContain('/login-credential`')
    expect(mainSource).toContain("ipcMain.handle('save-purchase-account-credential'")
    expect(mainSource).toContain('deletePurchaseAccountCredential(accountId)')
    expect(mainSource).toContain('即使 Chromium 分区清理失败，也必须继续删除本机加密凭据')
    expect(mainSource).toContain('closeAfterSuccessfulCookieSave(result')
    expect(mainSource).toContain('phase=auto_close scheduled=yes')
    expect(mainSource).toContain('if (autoCloseOnSuccess !== true) return false')
    expect(mainSource).toContain('h5WarmupDone || !loginDetected')
    expect(mainSource).toContain('if (isLoginPage)')
    expect(mainSource).toContain('loginDetected = false')
    expect(mainSource).toContain("closeAfterSuccessfulCookieSave(result2, 'taobao-h5-warmup')")
    expect(mainSource).toContain("ipcMain.on('platform-login-ready', fillReadyHandler)")
    expect(mainSource).toContain("win.webContents.send('fill-credentials', { account, password })")
    expect(mainSource).toContain("platform === 'pinduoduo'")
    expect(mainSource).toContain('if (clearSession === true)')
    expect(rendererSource).toContain('clearSession: true')
    expect(rendererSource).toContain('autoCloseOnSuccess: true')
    expect(rendererSource).toContain('account: row.username')
    expect(rendererSource).toContain("invoke('save-purchase-account-credential'")
    expect(rendererSource).toContain('>进入后台</el-button>')
    expect(rendererSource).toContain('async function refreshPurchaseAccountStatuses()')
    expect(rendererSource).toContain("invoke('validate-taobao-purchase-account'")
    expect(rendererSource).toContain("row.validatingCookie ? '检测中'")
    expect(rendererSource).toContain("valid: '有效'")
    expect(rendererSource).not.toContain("return row.status === 'online' ? '在线' : '离线'")
    expect(rendererSource).not.toContain('>检测</el-button>')
    expect(serverSource).toContain("app.get('/api/purchase-accounts/:id/login-credential'")
    expect(serverSource).toContain("res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')")

    const browseHandler = rendererSource.slice(
      rendererSource.indexOf('function handleLoginAccount(row)'),
      rendererSource.indexOf('function handleReloginAccount(row)')
    )
    expect(browseHandler).not.toContain('autoCloseOnSuccess: true')

    const reloginHandler = rendererSource.slice(
      rendererSource.indexOf('function handleReloginAccount(row)'),
      rendererSource.indexOf('function purchaseAccountCookieStatusLabel(row)')
    )
    expect(reloginHandler).toContain('autoCloseOnSuccess: true')
  })

  it('采购账号登录窗口使用带店小二图标的原生标题栏', () => {
    const mainSource = fs.readFileSync(path.resolve('src/main/platform-window.js'), 'utf8')
    const handlerStart = mainSource.indexOf("ipcMain.handle('open-purchase-login-window'")
    const handlerEnd = mainSource.indexOf('// 关闭采购账号窗口', handlerStart)
    const purchaseLoginHandler = mainSource.slice(handlerStart, handlerEnd)

    expect(purchaseLoginHandler).toContain("title: `店小二网店管家 - ${platformTitle}安全登录`")
    expect(purchaseLoginHandler).toContain("icon: resolveAppPath('resources/icon.ico')")
    expect(purchaseLoginHandler).not.toContain("titleBarStyle: 'hidden'")
    expect(purchaseLoginHandler).not.toContain('titleBarOverlay:')
    expect(purchaseLoginHandler).not.toContain('--dxe-custom-platform-titlebar=1')
  })
})
