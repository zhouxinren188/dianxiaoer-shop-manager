import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const {
  JD_STORE_LOGIN_FALLBACK_URL,
  JD_STORE_LOGIN_URL,
  findJdLoginRiskMarker,
  getJdLoginCookieState,
  parseJdStoreProfileText,
  validateJdStoreIdentity
} = require('../src/main/jd-store-login')
const preloadSource = readFileSync(new URL('../src/preload/index.js', import.meta.url), 'utf8')
const platformLoginPreloadSource = readFileSync(new URL('../resources/platform-login-preload.js', import.meta.url), 'utf8')

describe('京东店铺安全登录', () => {
  it('preload 放行店铺管理使用的全部登录状态事件', () => {
    expect(preloadSource).toContain("'platform-login-success'")
    expect(preloadSource).toContain("'platform-login-failed'")
    expect(preloadSource).toContain("'platform-login-risk'")
    expect(preloadSource).toContain("'platform-login-closed'")
  })

  it('使用京东 JZT 官方登录入口并返回店铺身份接口', () => {
    const url = new URL(JD_STORE_LOGIN_URL)
    expect(url.hostname).toBe('passport.jd.com')
    expect(url.pathname).toBe('/common/loginPage')
    expect(url.searchParams.get('from')).toBe('jzt')
    expect(url.searchParams.get('ReturnUrl')).toBe('https://shop.jd.com/json/navigation/getPinBaseInfo.action')

    const fallbackUrl = new URL(JD_STORE_LOGIN_FALLBACK_URL)
    expect(fallbackUrl.hostname).toBe('passport.jd.com')
    expect(fallbackUrl.pathname).toBe('/new/login.aspx')
    expect(fallbackUrl.searchParams.get('ReturnUrl')).toBe('https://shop.jd.com/json/navigation/getPinBaseInfo.action')
  })

  it('解析京东返回的真实商家和店铺身份', () => {
    expect(parseJdStoreProfileText(JSON.stringify({
      venderBaseInfo: {
        venderId: 92032658,
        shopId: 12345678,
        shopName: '测试店铺',
        pin: 'test_pin'
      }
    }))).toEqual({
      venderId: '92032658',
      shopId: '12345678',
      storeName: '测试店铺',
      account: 'test_pin'
    })
    expect(parseJdStoreProfileText(JSON.stringify({
      data: {},
      result: {
        vendorBaseInfo: {
          vendorId: '92032659',
          shopId: '12345679',
          vendorName: '嵌套店铺'
        }
      }
    }))).toMatchObject({
      venderId: '92032659',
      shopId: '12345679',
      storeName: '嵌套店铺'
    })
  })

  it('只有认证 Cookie 和身份 Cookie 同时有效才视为登录完成', () => {
    const now = 2_000_000_000
    expect(getJdLoginCookieState([
      { name: 'thor', value: 'auth', domain: '.jd.com', expirationDate: now + 100 },
      { name: 'pin', value: 'user', domain: '.jd.com', expirationDate: now + 100 }
    ], now).valid).toBe(true)
    expect(getJdLoginCookieState([
      { name: 'thor', value: 'expired', domain: '.jd.com', expirationDate: now - 1 },
      { name: 'pin', value: 'user', domain: '.jd.com', expirationDate: now + 100 }
    ], now).valid).toBe(false)
    expect(getJdLoginCookieState([
      { name: 'thor', value: 'auth', domain: '.jd.com', expirationDate: now + 100 }
    ], now).valid).toBe(false)
  })

  it('识别认证魔方并要求人工验证', () => {
    expect(findJdLoginRiskMarker('账号存在安全风险，请勿使用三方工具')).toBe('存在安全风险')
    expect(findJdLoginRiskMarker('特殊场景请使用主账号登录，完成登录验证后重试')).toBe('特殊场景请使用主账号登录')
    expect(findJdLoginRiskMarker('京东商家后台首页')).toBe('')
  })

  it('重新登录时拒绝用另一家店铺覆盖原店铺', () => {
    expect(validateJdStoreIdentity(
      { venderId: '222', shopId: '444' },
      { merchantId: '111', shopId: '444' }
    )).toMatchObject({ valid: false, reason: 'merchant_id_mismatch' })
    expect(validateJdStoreIdentity(
      { venderId: '111', shopId: '444' },
      { merchantId: '111', shopId: '444' }
    )).toMatchObject({ valid: true })
  })

  it('京东登录窗口使用临时分区并只从本机加密凭据代填', () => {
    const source = readFileSync(new URL('../src/main/platform-window.js', import.meta.url), 'utf8')
    const vaultSource = readFileSync(new URL('../src/main/jd-store-credential-vault.js', import.meta.url), 'utf8')
    expect(source).toContain('`jd-store-login-${storeId}-${Date.now()}`')
    expect(source).toContain('webPreferences.preload = preloadPath')
    expect(source).toContain('getJdStoreCredential(storeId)')
    expect(source).toContain('saveJdStoreCredential(targetStoreId')
    expect(vaultSource).toContain('safeStorage.encryptString')
    expect(vaultSource).toContain('safeStorage.decryptString')
    expect(source).toContain('partitionName !== targetPartitionName')
    expect(source).toContain('if (win._jdLoginProbe) return win._jdLoginProbe')
    expect(source).toContain('cookiesToRequestHeader(cookies, JD_VENDOR_LIST_URL)')
    expect(source).toContain('await win.loadURL(JD_STORE_LOGIN_FALLBACK_URL)')
    expect(source).toContain('phase=primary_entry_failed action=fallback')
    expect(source).toContain('phase=primary_entry_blank action=fallback')
  })

  it('登录代填只修改真实输入框并为异步密码框补填', () => {
    const platformWindowSource = readFileSync(new URL('../src/main/platform-window.js', import.meta.url), 'utf8')
    const purchaseCaptureSource = readFileSync(new URL('../src/main/purchase-order-capture.js', import.meta.url), 'utf8')
    expect(platformLoginPreloadSource).toContain("const ACCOUNT_INPUT_TYPES = new Set(['', 'text', 'tel', 'email'])")
    expect(platformLoginPreloadSource).toContain('if (!ACCOUNT_INPUT_TYPES.has(type) || el.disabled || el.readOnly) return false')
    expect(platformLoginPreloadSource).toContain('const accountInput = findBestAccountInput()')
    expect(platformLoginPreloadSource).toContain('[0, 150, 500, 1200, 2500, 4500]')
    expect(platformLoginPreloadSource).toContain("ipcRenderer.send('platform-login-ready')")
    expect(platformLoginPreloadSource).toContain("ipcRenderer.send('platform-login-fill-result', result)")
    expect(platformLoginPreloadSource).toContain("if (!el || el.tagName !== 'INPUT') return false")
    expect(platformWindowSource).toContain("if (type !== '' && type !== 'text' && type !== 'tel' && type !== 'email') return false;")
    expect(purchaseCaptureSource).toContain("if (type !== '' && type !== 'text' && type !== 'tel' && type !== 'email') return false;")
  })

  it('登录窗口使用店小二自有标题栏并隐藏系统菜单', () => {
    const source = readFileSync(new URL('../src/main/platform-window.js', import.meta.url), 'utf8')
    expect(source).toContain('width: 960')
    expect(source).toContain('height: 680')
    expect(source).toContain('show: false')
    expect(source).toContain('win.show()')
    expect(source).toContain("titleBarStyle: 'hidden'")
    expect(source).toContain("color: '#0b4776'")
    expect(source).toContain('win.setMenuBarVisibility(false)')
    expect(source).toContain("additionalArguments: ['--dxe-custom-platform-titlebar=1']")
    expect(platformLoginPreloadSource).toContain("const APP_TITLEBAR_ID = 'dxe-platform-titlebar'")
    expect(platformLoginPreloadSource).toContain("const APP_TITLEBAR_SPACER_ID = 'dxe-platform-titlebar-spacer'")
    expect(platformLoginPreloadSource).toContain('document.body.prepend(spacer)')
    expect(platformLoginPreloadSource).toContain('if (!CUSTOM_TITLEBAR_ENABLED')
    expect(platformLoginPreloadSource).toContain("platformTitle = '京东官方安全登录'")
  })

  it('服务端拒绝错店覆盖并清理京东历史密码', () => {
    const source = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
    const dbSource = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8')
    expect(source).toContain('storedMerchantId !== merchantId')
    expect(source).toContain('storedShopId !== shopId')
    expect(source).toContain("if (cookieDomain === 'jd') updateFields.push(\"password = ''\")")
    expect(source).toContain("String(row.platform || '').toLowerCase() === 'jd' ? '' : row.password")
    expect(source).toContain("if (key === 'password' && effectivePlatform === 'jd') continue")
    expect(source).toContain("if (cookieDomain === 'jd') updateFields.push(\"password = ''\")")
    expect(source).toContain("if (column === 'password' && cookieDomain === 'jd') continue")
    expect(dbSource).toContain("UPDATE stores SET password = '' WHERE LOWER(platform) = 'jd'")
  })
})
