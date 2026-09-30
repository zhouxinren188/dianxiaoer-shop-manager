const { BrowserWindow, ipcMain, session, dialog, app } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const { getAuthToken } = require('./auth-store')
const { getDeviceId } = require('./device-identity')
const { setCookieRevision } = require('./cookie-revision-store')
const runtimeLog = require('./runtime-logger')
const {
  invalidateTaobaoAccountValidation,
  validateTaobaoPurchaseAccount
} = require('./taobao-account-validation')
const {
  reportStoreDeviceStatus,
  uploadCookiesToServer
} = require('./cookie-heartbeat')
const { isExpectedNavigationAbort, createStandardChromeIdentity } = require('./platform-window-navigation')
const {
  filterCookiesForPlatform,
  hasValidPlatformCookies,
  invalidateCookieRestoreCache,
  restoreCookiesFromServer
} = require('./purchase-order-sync/common')
const { parseJdVendorSessionResponse } = require('./jd-vendor-session')
const {
  JD_STORE_LOGIN_FALLBACK_URL,
  JD_STORE_LOGIN_URL,
  JD_STORE_PROFILE_URL,
  findJdLoginRiskMarker,
  getJdLoginCookieState,
  parseJdStoreProfileText,
  validateJdStoreIdentity
} = require('./jd-store-login')
const {
  getJdStoreCredential,
  saveJdStoreCredential,
  moveJdStoreCredential
} = require('./jd-store-credential-vault')
const {
  getPurchaseAccountCredential,
  savePurchaseAccountCredential,
  deletePurchaseAccountCredential
} = require('./purchase-account-credential-vault')

// 解析应用资源路径（直接从 app 根目录查找）
function resolveAppPath(relativePath) {
  return path.join(app.getAppPath(), relativePath)
}

const BUSINESS_SERVER = 'http://150.158.54.108:3002'

// 平台后台 URL 映射
const PLATFORM_URLS = {
  taobao: 'https://myseller.taobao.com/',
  tmall: 'https://myseller.taobao.com/',
  jd: JD_STORE_LOGIN_URL,
  pdd: 'https://mms.pinduoduo.com/',
  douyin: 'https://fxg.jinritemai.com/'
}
const JD_VENDOR_LIST_URL = 'https://i.shop.jd.com/switch/vendor/list?appName=shop&callback=&v=5111'

// Cookie 提取域名映射
const PLATFORM_COOKIE_URLS = {
  taobao: 'https://taobao.com',
  tmall: 'https://taobao.com',
  jd: 'https://jd.com',
  pdd: 'https://pinduoduo.com',
  douyin: 'https://jinritemai.com'
}

// 已打开的平台窗口 Map<storeId, BrowserWindow>
const platformWindows = new Map()
// 店铺平台映射 Map<storeId, platform>
const storePlatforms = new Map()
// 暂存登录凭证 Map<storeId, {account, password}>
const storeCredentials = new Map()
// 暂存提取的商家信息 Map<storeId, {storeName, venderId, shopId}>
const storeExtractedInfo = new Map()
// 暂存是否为重新登录（keepCookie） Map<storeId, boolean>
const storeKeepCookie = new Map()
// 同一店铺一次只允许一个保存任务，避免页面重复加载/手动确认造成并发写入。
const storeSaveTasks = new Map()
const storeOriginalCookies = new Map()
// 京东登录使用一次性内存分区，登录成功后才复制到正式店铺分区。
const storeLoginPartitions = new Map()
const storeExpectedIdentities = new Map()

function cleanupPlatformWindowState(storeId) {
  const loginPartition = storeLoginPartitions.get(storeId)
  if (loginPartition && !loginPartition.startsWith('persist:')) {
    session.fromPartition(loginPartition).clearStorageData().catch(error => {
      runtimeLog.writeLog(
        'STORE_LOGIN',
        `store_id=${storeId} phase=temp_session_cleanup result=failed reason=${String(error.message || error).slice(0, 160)}`
      )
    })
  }
  platformWindows.delete(storeId)
  storePlatforms.delete(storeId)
  storeKeepCookie.delete(storeId)
  storeCredentials.delete(storeId)
  storeExtractedInfo.delete(storeId)
  storeSaveTasks.delete(storeId)
  storeOriginalCookies.delete(storeId)
  storeLoginPartitions.delete(storeId)
  storeExpectedIdentities.delete(storeId)
}

function cookieUrl(cookie) {
  const domain = String(cookie?.domain || '').replace(/^\./, '')
  return `${cookie?.secure === false ? 'http' : 'https'}://${domain}${cookie?.path || '/'}`
}

async function restoreOriginalCookies(storeId) {
  const originalCookies = storeOriginalCookies.get(storeId)
  if (!Array.isArray(originalCookies)) return
  const ses = session.fromPartition(`persist:platform-${storeId}`)
  await ses.clearStorageData({ storages: ['cookies'] })
  let restored = 0
  for (const cookie of originalCookies) {
    try {
      const details = {
        url: cookieUrl(cookie),
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        secure: cookie.secure !== false,
        httpOnly: !!cookie.httpOnly
      }
      if (cookie.expirationDate) details.expirationDate = cookie.expirationDate
      if (cookie.sameSite && ['no_restriction', 'lax', 'strict', 'unspecified'].includes(cookie.sameSite)) {
        details.sameSite = cookie.sameSite
      }
      await ses.cookies.set(details)
      restored++
    } catch { /* 单条Cookie恢复失败不阻断其余条目 */ }
  }
  runtimeLog.writeLog('STORE_LOGIN', `store_id=${storeId} phase=cancel_restore restored=${restored}/${originalCookies.length}`)
}

// 明确登录成功并归并到已有店铺时，将刚捕获的 Cookie 同步到目标店铺的
// 本机 partition。该操作只发生在当前设备，不会触碰其他电脑的会话。
async function replaceLocalStoreCookies(storeId, cookies) {
  const ses = session.fromPartition(`persist:platform-${storeId}`)
  await ses.clearStorageData({ storages: ['cookies'] })
  let restored = 0
  for (const cookie of cookies) {
    try {
      const details = {
        url: cookieUrl(cookie),
        name: cookie.name,
        value: cookie.value || '',
        domain: cookie.domain,
        path: cookie.path || '/',
        secure: cookie.secure !== false,
        httpOnly: !!cookie.httpOnly
      }
      if (cookie.expirationDate) details.expirationDate = cookie.expirationDate
      if (cookie.sameSite && ['no_restriction', 'lax', 'strict', 'unspecified'].includes(cookie.sameSite)) {
        details.sameSite = cookie.sameSite
      }
      await ses.cookies.set(details)
      restored++
    } catch (error) {
      runtimeLog.writeLog(
        'STORE_LOGIN',
        `store_id=${storeId} phase=merge_local_cookie result=single_failed name=${cookie?.name || ''} reason=${error.message}`
      )
    }
  }
  await ses.flushStorageData()
  return restored
}

function parseBusinessResponse(response, fallbackMessage) {
  let body = null
  try { body = JSON.parse(response?.data || '{}') } catch { /* ignore */ }
  if (!response || response.statusCode < 200 || response.statusCode >= 300 || body?.code !== 0) {
    return {
      success: false,
      statusCode: Number(response?.statusCode || 0),
      message: body?.message || body?.msg || fallbackMessage
    }
  }
  return { success: true, statusCode: response.statusCode, data: body.data }
}

function requireBusinessResponse(response, fallbackMessage) {
  const result = parseBusinessResponse(response, fallbackMessage)
  if (!result.success) throw new Error(result.message)
  return result.data
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const urlObj = new URL(url)

    // 自动附带 auth token
    const headers = { ...options.headers }
    const token = getAuthToken()
    if (token && options.includeAuth !== false) {
      headers['Authorization'] = `Bearer ${token}`
    } else if (options.includeAuth !== false) {
      console.warn('[PlatformWindow] httpRequest: 主进程没有 auth token! 请求可能被 401 拒绝. URL:', url)
    }

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers,
      timeout: 10000,
      rejectUnauthorized: options.rejectUnauthorized !== false
    }

    const req = mod.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, data }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
    if (options.body) req.write(options.body)
    req.end()
  })
}

function cookiesToRequestHeader(cookies, requestUrl) {
  const target = new URL(requestUrl)
  const hostname = target.hostname.toLowerCase()
  const pathname = target.pathname || '/'
  return (Array.isArray(cookies) ? cookies : [])
    .filter(cookie => {
      if (!cookie?.name || cookie?.value === undefined) return false
      if (cookie.secure && target.protocol !== 'https:') return false
      const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase()
      if (!domain) return false
      const domainMatches = cookie.hostOnly
        ? hostname === domain
        : hostname === domain || hostname.endsWith(`.${domain}`)
      if (!domainMatches) return false
      const cookiePath = String(cookie.path || '/')
      return pathname === cookiePath || pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`)
    })
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ')
}

function decodeCookieIdentity(cookie) {
  const value = String(cookie?.value || '')
  if (!value) return ''
  try { return decodeURIComponent(value) } catch { return value }
}

async function fetchJdVendorIdentity(cookies, browserIdentity, expectedMerchantId = '') {
  const cookieHeader = cookiesToRequestHeader(cookies, JD_VENDOR_LIST_URL)
  if (!cookieHeader) return { valid: false, reason: 'cookie_header_empty' }
  try {
    const response = await httpRequest(JD_VENDOR_LIST_URL, {
      includeAuth: false,
      headers: {
        Cookie: cookieHeader,
        'User-Agent': browserIdentity.userAgent,
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://shop.jd.com/'
      }
    })
    return parseJdVendorSessionResponse({
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.data,
      expectedMerchantId
    })
  } catch (error) {
    return { valid: null, reason: 'request_failed', message: error.message }
  }
}

async function fetchJdStoreProfile(ses, browserIdentity) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await ses.fetch(JD_STORE_PROFILE_URL, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://shop.jd.com/',
        'User-Agent': browserIdentity.userAgent
      }
    })
    const text = await response.text()
    if (!response.ok) return null
    return parseJdStoreProfileText(text)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function cleanupPendingStoreOnServer(storeId, context = 'cancel') {
  const pendingResponse = await httpRequest(`${BUSINESS_SERVER}/api/stores/${storeId}/pending`, {
    method: 'DELETE'
  })
  let result = parseBusinessResponse(pendingResponse, '清理临时店铺失败')

  // 兼容尚未部署新接口的开发环境；新服务端不会进入此分支。
  if (!result.success && result.statusCode === 404) {
    const legacyResponse = await httpRequest(`${BUSINESS_SERVER}/api/stores/${storeId}`, {
      method: 'DELETE'
    })
    result = parseBusinessResponse(legacyResponse, '清理临时店铺失败')
  }

  runtimeLog.writeLog(
    'STORE_LOGIN',
    `store_id=${storeId} phase=pending_cleanup context=${context} result=${result.success ? 'success' : 'failed'} http=${result.statusCode} message=${result.success ? 'none' : String(result.message || '').replace(/[\r\n\t]+/g, ' ').slice(0, 160)}`
  )
  return result
}

async function finalizeStoreLoginOnServer(storeId, updateBody) {
  const response = await httpRequest(`${BUSINESS_SERVER}/api/stores/${storeId}/finalize-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateBody)
  })
  const result = parseBusinessResponse(response, '保存店铺资料失败')
  if (result.success || result.statusCode !== 404) return result

  // 兼容新服务端部署前的开发版：保留精确商家ID查询，但严格检查业务响应。
  let targetStoreId = storeId
  let merged = false
  if (updateBody.merchant_id) {
    const checkResponse = await httpRequest(
      `${BUSINESS_SERVER}/api/stores?merchant_id=${encodeURIComponent(updateBody.merchant_id)}`,
      { method: 'GET' }
    )
    const checkResult = parseBusinessResponse(checkResponse, '检查商家ID失败')
    if (!checkResult.success) return checkResult
    const existingStore = Array.isArray(checkResult.data?.list)
      ? checkResult.data.list.find(store => String(store.id) !== String(storeId))
      : null
    if (existingStore) {
      targetStoreId = Number(existingStore.id)
      merged = true
    }
  }

  const updateResponse = await httpRequest(`${BUSINESS_SERVER}/api/stores/${targetStoreId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateBody)
  })
  const updateResult = parseBusinessResponse(updateResponse, '保存店铺资料失败')
  if (!updateResult.success) return updateResult

  if (merged) {
    const cleanupResult = await cleanupPendingStoreOnServer(storeId, 'legacy_merge')
    if (!cleanupResult.success) return cleanupResult
  }
  return { success: true, data: { store_id: targetStoreId, merged, legacy: true } }
}

// 生成登录表单自动填充脚本（注入到采购登录窗口）
// 与 purchase-order-capture.js 中的 buildLoginAutoFillScript 保持一致
function buildLoginAutoFillScript(accountName, password) {
  if (!accountName && !password) return ''
  return `
(function() {
  var account = ${JSON.stringify(accountName || '')};
  var password = ${JSON.stringify(password || '')};
  if (!account && !password) return;
  if (window.__loginAutoFillDone) return;
  window.__loginAutoFillDone = true;

  function setInputValue(el, value) {
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function isAccountInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    var type = (el.type || '').toLowerCase();
    if (type !== '' && type !== 'text' && type !== 'tel' && type !== 'email') return false;
    if (el.disabled || el.readOnly) return false;
    var name = (el.name || '').toLowerCase();
    var id = (el.id || '').toLowerCase();
    var placeholder = (el.placeholder || '').toLowerCase();
    var cls = (el.className || '').toLowerCase();
    var autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    // 属性匹配
    var matched = name.includes('login') || name.includes('user') || name.includes('account') ||
      name.includes('phone') || name.includes('mobile') || name.includes('uname') ||
      id.includes('login') || id.includes('user') || id.includes('account') ||
      id.includes('phone') || id.includes('mobile') || id.includes('uname') ||
      placeholder.includes('\\u8d26\\u53f7') || placeholder.includes('\\u7528\\u6237\\u540d') ||
      placeholder.includes('\\u624b\\u673a\\u53f7') || placeholder.includes('\\u90ae\\u7bb1') || placeholder.includes('\\u4f1a\\u5458\\u540d') ||
      placeholder.includes('\\u767b\\u5f55\\u540d') ||
      cls.includes('login') || cls.includes('user') || cls.includes('account') ||
      autocomplete.includes('username') || autocomplete.includes('email');
    if (matched) return true;
    // 回退：文本类型输入框（type=text/tel/email 或无 type）视为候选
    if (type === '' || type === 'text' || type === 'tel' || type === 'email') return 'maybe';
    return false;
  }

  function isPasswordInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    if (el.type !== 'password') return false;
    var name = (el.name || '').toLowerCase();
    return !name.includes('verify') && !name.includes('captcha') && !name.includes('code');
  }

  function isVisible(el) {
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  }

  function fillLoginForm() {
    var inputs = document.querySelectorAll('input');
    var filled = 0;
    var accountEl = null;
    var maybeAccountEls = [];
    var passwordEl = null;

    inputs.forEach(function(el) {
      if (!isVisible(el)) return;
      if (password && isPasswordInput(el)) {
        passwordEl = el;
      }
      if (account) {
        var result = isAccountInput(el);
        if (result === true) {
          accountEl = el;
        } else if (result === 'maybe') {
          maybeAccountEls.push(el);
        }
      }
    });

    // 如果属性匹配未找到账号框，回退到位置匹配：取密码框之前的最后一个候选文本输入框
    if (!accountEl && account && maybeAccountEls.length > 0) {
      if (passwordEl) {
        for (var i = maybeAccountEls.length - 1; i >= 0; i--) {
          if (maybeAccountEls[i].compareDocumentPosition(passwordEl) & Node.DOCUMENT_POSITION_FOLLOWING) {
            accountEl = maybeAccountEls[i];
            break;
          }
        }
      }
      if (!accountEl) {
        accountEl = maybeAccountEls[0];
      }
    }

    if (accountEl && account) {
      setInputValue(accountEl, account);
      filled++;
    }
    if (passwordEl && password) {
      setInputValue(passwordEl, password);
      filled++;
    }
    if (filled > 0) {
      console.log('[LoginAutoFill] Filled ' + filled + ' fields');
    }
  }

  // 多次重试，兼容 React 异步渲染
  fillLoginForm();
  setTimeout(fillLoginForm, 1500);
  setTimeout(fillLoginForm, 3000);

  console.log('[LoginAutoFill] Credentials injected, account=' + (account ? 'YES' : 'NO') + ', password=' + (password ? 'YES' : 'NO'));
})()
`
}

function registerPlatformWindowIpc(mainWindow) {
  const preloadPath = resolveAppPath('resources/platform-login-preload.js')

  function findPlatformWindowBySender(sender) {
    for (const [storeId, win] of platformWindows.entries()) {
      if (!win.isDestroyed() && win.webContents === sender) return { storeId, win }
    }
    return null
  }

  function sendPlatformLoginCredentials(storeId, win, source) {
    if (!win || win.isDestroyed()) return false
    const credential = storeCredentials.get(storeId) || {}
    const hasAccount = !!credential.account
    const hasPassword = !!credential.password
    runtimeLog.writeLog(
      'STORE_LOGIN',
      `store_id=${storeId} phase=credential_fill_send source=${source} account=${hasAccount ? 'yes' : 'no'} password=${hasPassword ? 'yes' : 'no'}`
    )
    if (!hasAccount && !hasPassword) return false
    win.webContents.send('fill-credentials', {
      account: credential.account || '',
      password: credential.password || ''
    })
    return true
  }

  // 判断是否为后台 URL（排除登录页）
  function isBackendUrl(url, platform = 'jd') {
    try {
      const parsed = new URL(url)
      const host = parsed.hostname.toLowerCase()
      const pathAndQuery = `${parsed.pathname}${parsed.search}`.toLowerCase()
      if (/(passport|login)/.test(host) || /(^|[/?&_-])login([/?&_.=-]|$)/.test(pathAndQuery)) return false
      const platformHosts = {
        jd: ['shop.jd.com', 'sz.jd.com'],
        taobao: ['myseller.taobao.com', 'seller.taobao.com'],
        tmall: ['myseller.taobao.com', 'seller.taobao.com'],
        pdd: ['mms.pinduoduo.com'],
        douyin: ['fxg.jinritemai.com']
      }
      return (platformHosts[platform] || []).some(domain => host === domain || host.endsWith(`.${domain}`))
    } catch {
      return false
    }
  }

  // 页面商家信息提取脚本
  const extractionScript = `
    (function() {
      var info = {};
      var debugLog = [];
      try {
        // === 店铺名提取 ===
        if (document.title) {
          var parts = document.title.split(/[-_|\\u2013\\u2014]/).map(function(s){ return s.trim(); });
          for (var i = 0; i < parts.length; i++) {
            var p = parts[i];
            if (p && p.length > 1 && p.length < 30 &&
                ['首页','京麦','京东','后台','JD','商家后台','shop','loading','index'].indexOf(p.toLowerCase()) === -1) {
              info.storeName = p;
              break;
            }
          }
        }
        var nameSelectors = ['.shop-name','.store-name','.shopName','.J_shopName',
          '[class*="shopName"]','[class*="shop-name"]','.header .name'];
        for (var j = 0; j < nameSelectors.length; j++) {
          try {
            var el = document.querySelector(nameSelectors[j]);
            if (el && el.textContent && el.textContent.trim().length > 1) {
              info.storeName = el.textContent.trim();
              break;
            }
          } catch(e2) {}
        }

        // === venderId / shopId 提取（配对优先） ===
        var scripts = document.querySelectorAll('script:not([src])');
        for (var s = 0; s < scripts.length; s++) {
          var txt = scripts[s].textContent || '';
          if (txt.length < 20 || txt.length > 500000) continue;
          var vm = txt.match(/venderId['"\\s:=]+(\\d{5,})/);
          var sm = txt.match(/shopId['"\\s:=]+(\\d{5,})/);
          if (vm && sm) {
            info.venderId = vm[1];
            info.shopId = sm[1];
            debugLog.push('paired from script block: venderId=' + vm[1] + ' shopId=' + sm[1]);
            break;
          }
        }

        if (!info.venderId || !info.shopId) {
          var globalKeys = ['pageConfig','__INITIAL_STATE__','__NEXT_DATA__','GLOBAL_CONFIG',
            'shopConfig','storeConfig','merchantConfig','jdConfig'];
          for (var k = 0; k < globalKeys.length; k++) {
            try {
              var obj = window[globalKeys[k]];
              if (obj && typeof obj === 'object') {
                var jsonStr = JSON.stringify(obj);
                var gvm = jsonStr.match(/"venderId"\\s*:\\s*"?(\\d+)"?/);
                var gsm = jsonStr.match(/"shopId"\\s*:\\s*"?(\\d+)"?/);
                if (gvm && gsm) {
                  info.venderId = gvm[1];
                  info.shopId = gsm[1];
                  debugLog.push('paired from ' + globalKeys[k]);
                  break;
                }
                if (!info.venderId && gvm) { info.venderId = gvm[1]; debugLog.push('venderId from ' + globalKeys[k]); }
                if (!info.shopId && gsm) { info.shopId = gsm[1]; debugLog.push('shopId from ' + globalKeys[k]); }
                if (!info.storeName && obj.shopName) info.storeName = obj.shopName;
              }
            } catch(e3) {}
          }
        }

        if (!info.venderId && window.venderId) { info.venderId = String(window.venderId); debugLog.push('venderId from window'); }
        if (!info.shopId && window.shopId) { info.shopId = String(window.shopId); debugLog.push('shopId from window'); }

        if (!info.venderId || !info.shopId) {
          for (var s2 = 0; s2 < scripts.length; s2++) {
            var txt2 = scripts[s2].textContent || '';
            if (txt2.length < 20 || txt2.length > 500000) continue;
            if (!info.venderId) {
              var vm3 = txt2.match(/venderId['"\\s:=]+(\\d{5,})/);
              if (vm3) { info.venderId = vm3[1]; debugLog.push('venderId fallback script#' + s2); }
            }
            if (!info.shopId) {
              var sm3 = txt2.match(/shopId['"\\s:=]+(\\d{5,})/);
              if (sm3) { info.shopId = sm3[1]; debugLog.push('shopId fallback script#' + s2); }
            }
            if (info.venderId && info.shopId) break;
          }
        }

        if (!info.venderId || !info.shopId) {
          var urlParams = new URLSearchParams(window.location.search);
          if (!info.venderId) {
            var uv = urlParams.get('venderId') || urlParams.get('venderid') || urlParams.get('vender_id');
            if (uv) { info.venderId = uv; debugLog.push('venderId from URL'); }
          }
          if (!info.shopId) {
            var us = urlParams.get('shopId') || urlParams.get('shopid') || urlParams.get('shop_id');
            if (us) { info.shopId = us; debugLog.push('shopId from URL'); }
          }
        }

        if (!info.venderId || !info.shopId) {
          try {
            var storages = [localStorage, sessionStorage];
            for (var si = 0; si < storages.length; si++) {
              var storage = storages[si];
              for (var ki2 = 0; ki2 < storage.length; ki2++) {
                var sval = storage.getItem(storage.key(ki2)) || '';
                if (sval.length < 10 || sval.length > 50000) continue;
                var lvm = sval.match(/venderId['"\\s:=]+(\\d{5,})/);
                var lsm = sval.match(/shopId['"\\s:=]+(\\d{5,})/);
                if (lvm && lsm) {
                  if (!info.venderId) info.venderId = lvm[1];
                  if (!info.shopId) info.shopId = lsm[1];
                  debugLog.push('paired from storage');
                  break;
                }
              }
              if (info.venderId && info.shopId) break;
            }
          } catch(e4) {}
        }

        info._debug = debugLog.join(' | ');
      } catch(e) { info._debug = 'error: ' + e.message; }
      return info;
    })()
  `

  // 重试提取机制：在检测到后台页面后多次尝试提取，提取成功后自动保存
  function startExtractionRetry(win, sid, mw, plat) {
    let retryCount = 0
    const maxRetries = 4
    const delays = [3000, 5000, 8000, 12000] // 3s, 5s, 8s, 12s

    function tryExtract() {
      if (win.isDestroyed() || retryCount >= maxRetries) return
      const delay = delays[retryCount] || 3000
      retryCount++

      setTimeout(() => {
        if (win.isDestroyed()) return
        win.webContents.executeJavaScript(extractionScript).then(info => {
          if (!info) return
          console.log(`[PlatformWindow] 提取尝试 #${retryCount} debug:`, info._debug || 'none')
          delete info._debug

          if (Object.keys(info).length > 0) {
            const prev = storeExtractedInfo.get(sid) || {}
            storeExtractedInfo.set(sid, { ...prev, ...info })
            console.log('[PlatformWindow] 页面提取到商家信息:', info)
          }

          // 如果已经拿到 venderId 或 shopId，立即执行保存
          const extracted = storeExtractedInfo.get(sid) || {}
          if (extracted.venderId || extracted.shopId) {
            if (win._saveStarted || win._saveDone) return
            win._saveStarted = true
            console.log('[PlatformWindow] 提取成功，执行保存')
            const cred = storeCredentials.get(sid) || {}
            saveStoreInfo(mw, sid, plat, cred.account, cred.password, { verifiedLogin: true }).then(result => {
              if (!result.success) {
                win._saveStarted = false
                if (mw && !mw.isDestroyed()) {
                  mw.webContents.send('platform-login-failed', {
                    requestedStoreId: sid,
                    message: result.message || '店铺登录信息保存失败，请重试'
                  })
                }
                return
              }
              // 保存一成功就立即禁止 close 处理器恢复登录前 Cookie。此前这里要等
              // 3 秒后才置位，用户在提示成功后马上关窗会把刚保存的新会话回滚。
              win._saveDone = true
              setTimeout(() => {
                if (!win.isDestroyed()) {
                  console.log('[PlatformWindow] 登录保存成功，3秒后自动关闭平台窗口')
                  win.close()
                }
              }, 3000)
            }).catch(error => {
              win._saveStarted = false
              console.error('[PlatformWindow] 保存异常:', error.message)
            })
          } else if (retryCount < maxRetries) {
            // 还没拿到关键数据，继续重试
            console.log(`[PlatformWindow] 未提取到关键数据，将重试 (${retryCount}/${maxRetries})`)
            tryExtract()
          }
        }).catch(err => {
          console.log('[PlatformWindow] executeJS 失败:', err.message)
          if (retryCount < maxRetries) tryExtract()
        })
      }, delay)
    }

    tryExtract()
  }

  async function completeJdStoreLoginOnce(win, storeId, { manual = false } = {}) {
    if (!win || win.isDestroyed()) return { success: false, message: '京东登录窗口已关闭' }
    if (win._loginCancelled) return { success: false, cancelled: true, message: '京东登录已取消' }
    if (win._saveDone) return { success: true }
    if (win._saveStarted) return { success: false, pending: true, message: '正在核验店铺身份，请稍候' }

    let pageSnapshot = { url: win.webContents.getURL(), title: '', text: '' }
    try {
      pageSnapshot = await win.webContents.executeJavaScript(`(() => ({
        url: String(location.href || ''),
        title: String(document.title || ''),
        text: String(document.body && document.body.innerText || '').slice(0, 200000)
      }))()`, true)
    } catch { /* 页面跳转过程中读取失败，等待下一次加载 */ }

    const riskMarker = findJdLoginRiskMarker(`${pageSnapshot.title}\n${pageSnapshot.text}`)
    if (riskMarker) {
      if (win._lastJdRiskMarker !== riskMarker) {
        win._lastJdRiskMarker = riskMarker
        runtimeLog.writeLog(
          'STORE_LOGIN',
          `store_id=${storeId} phase=jd_risk result=manual_verification_required marker=${riskMarker}`
        )
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('platform-login-risk', {
            requestedStoreId: storeId,
            message: '京东触发安全验证，请使用主账号或短信验证码完成验证；系统不会自动重试或恢复旧 Cookie。'
          })
        }
      }
      return {
        success: false,
        pending: true,
        risk: true,
        message: '京东正在进行安全验证，请完成主账号或短信验证'
      }
    }

    const sessionPartition = storeLoginPartitions.get(storeId)
    const ses = session.fromPartition(sessionPartition)
    const allCookies = await ses.cookies.get({})
    const cookieState = getJdLoginCookieState(allCookies)
    if (!cookieState.valid) {
      return {
        success: false,
        pending: true,
        message: manual ? '尚未取得完整京东登录凭证，请先完成登录或安全验证' : '等待京东登录完成'
      }
    }

    let profile = parseJdStoreProfileText(pageSnapshot.text) || {}
    if (isBackendUrl(pageSnapshot.url, 'jd') && (!profile.venderId || !profile.shopId || !profile.storeName)) {
      try {
        const extracted = await win.webContents.executeJavaScript(extractionScript, true)
        if (extracted && typeof extracted === 'object') {
          delete extracted._debug
          profile = { ...extracted, ...profile }
        }
      } catch { /* JSON 响应页不一定具备普通后台 DOM，继续走商家身份接口 */ }
    }

    const expected = storeExpectedIdentities.get(storeId) || {}
    const browserIdentity = win._browserIdentity || createStandardChromeIdentity(process.versions.chrome)
    if (!profile.venderId || !profile.shopId || !profile.storeName) {
      const fetchedProfile = await fetchJdStoreProfile(ses, browserIdentity)
      if (fetchedProfile) {
        for (const [key, value] of Object.entries(fetchedProfile)) {
          if (String(value || '').trim()) profile[key] = value
        }
      }
    }
    const vendorIdentity = await fetchJdVendorIdentity(
      cookieState.cookies,
      browserIdentity,
      expected.merchantId || ''
    )
    if (vendorIdentity.valid === true) {
      profile.venderId = profile.venderId || vendorIdentity.vendorId || ''
      profile.storeName = profile.storeName || vendorIdentity.vendorName || ''
    } else if (vendorIdentity.reason === 'vendor_identity_mismatch') {
      profile.venderId = vendorIdentity.vendorId || profile.venderId || ''
    }
    profile.account = profile.account || decodeCookieIdentity(cookieState.identityCookie)

    // 核验接口返回前用户可能已经关窗。取消发生后禁止继续写入服务器或正式分区。
    if (win.isDestroyed() || win._loginCancelled) {
      return { success: false, cancelled: true, message: '京东登录已取消' }
    }

    const identityCheck = validateJdStoreIdentity(profile, expected)
    if (!identityCheck.valid) {
      if (identityCheck.reason.endsWith('_missing')) {
        return {
          success: false,
          pending: true,
          message: '登录已完成，但尚未取得完整店铺身份，请稍候或重新打开登录窗口'
        }
      }
      const label = identityCheck.reason === 'merchant_id_mismatch' ? '商家ID' : '店铺ID'
      const message = `${label}与原店铺不一致（原 ${identityCheck.expected}，当前 ${identityCheck.actual}），已停止覆盖 Cookie`
      runtimeLog.writeLog(
        'STORE_LOGIN',
        `store_id=${storeId} phase=identity_check result=mismatch type=${identityCheck.reason} expected=${identityCheck.expected} actual=${identityCheck.actual}`
      )
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('platform-login-failed', { requestedStoreId: storeId, message })
      }
      setTimeout(() => {
        if (!win.isDestroyed()) win.close()
      }, 0)
      return { success: false, message }
    }

    if (!profile.venderId && !profile.shopId) {
      return {
        success: false,
        pending: true,
        message: '登录已完成，但京东尚未返回商家ID或店铺ID，请稍候'
      }
    }

    storeExtractedInfo.set(storeId, {
      venderId: String(profile.venderId || '').trim(),
      shopId: String(profile.shopId || '').trim(),
      storeName: String(profile.storeName || '').trim()
    })
    win._saveStarted = true
    const result = await saveStoreInfo(mainWindow, storeId, 'jd', profile.account || '', '', {
      verifiedLogin: true,
      sessionPartition,
      expectedMerchantId: expected.merchantId || '',
      expectedShopId: expected.shopId || ''
    })
    if (!result.success) {
      win._saveStarted = false
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('platform-login-failed', {
          requestedStoreId: storeId,
          message: result.message || '京东店铺登录信息保存失败，请重试'
        })
      }
      return result
    }

    // 只有店铺身份和 Cookie 都核验成功后，才把本次输入的账号密码保存到
    // 当前 Windows 用户的加密安全存储。京东密码不会上传服务端。
    const capturedCredential = storeCredentials.get(storeId) || {}
    try {
      const targetStoreId = Number(result.storeId || storeId)
      if (targetStoreId !== Number(storeId)) {
        moveJdStoreCredential(storeId, targetStoreId)
      }
      const credentialSaveResult = saveJdStoreCredential(targetStoreId, {
        account: capturedCredential.account || profile.account || '',
        password: capturedCredential.password || ''
      })
      runtimeLog.writeLog(
        'STORE_LOGIN',
        `store_id=${targetStoreId} phase=credential_vault result=${credentialSaveResult.success ? 'success' : 'failed'} account=${capturedCredential.account || profile.account ? 'yes' : 'no'} password=${capturedCredential.password ? 'yes' : 'no'}${credentialSaveResult.reason ? ` reason=${String(credentialSaveResult.reason).slice(0, 120)}` : ''}`
      )
    } catch (error) {
      runtimeLog.writeLog(
        'STORE_LOGIN',
        `store_id=${storeId} phase=credential_vault result=failed reason=${String(error.message || error).slice(0, 160)}`
      )
    }

    win._saveDone = true
    setTimeout(() => {
      if (!win.isDestroyed()) win.close()
    }, 1000)
    return result
  }

  function completeJdStoreLogin(win, storeId, options = {}) {
    if (!win || win.isDestroyed()) {
      return Promise.resolve({ success: false, message: '京东登录窗口已关闭' })
    }
    // 登录成功会连续触发多次页面加载事件，手动确认也可能与自动检测同时发生。
    // 复用同一个核验 Promise，防止重复请求京东身份接口或重复提交 Cookie。
    if (win._jdLoginProbe) return win._jdLoginProbe
    const probe = completeJdStoreLoginOnce(win, storeId, options)
    win._jdLoginProbe = probe
    return probe.finally(() => {
      if (win._jdLoginProbe === probe) win._jdLoginProbe = null
    })
  }

  // 打开平台登录窗口
  ipcMain.handle('open-platform-window', async (event, {
    storeId,
    platform,
    keepCookie,
    account,
    password,
    expectedMerchantId,
    expectedShopId
  }) => {
    if (platformWindows.has(storeId)) {
      const existWin = platformWindows.get(storeId)
      if (!existWin.isDestroyed()) {
        existWin.focus()
        return { success: true, message: '窗口已打开' }
      }
      platformWindows.delete(storeId)
    }

    const targetUrl = PLATFORM_URLS[platform]
    if (!targetUrl) {
      return { success: false, message: `不支持的平台: ${platform}` }
    }

    const permanentPartitionName = `persist:platform-${storeId}`
    const isIsolatedJdLogin = platform === 'jd'
    const partitionName = isIsolatedJdLogin
      ? `jd-store-login-${storeId}-${Date.now()}`
      : permanentPartitionName
    const platformSession = session.fromPartition(partitionName)
    storeLoginPartitions.set(storeId, partitionName)
    storeExpectedIdentities.set(storeId, {
      merchantId: String(expectedMerchantId || '').trim(),
      shopId: String(expectedShopId || '').trim()
    })

    // 京东始终在一次性内存分区中登录，不把已失效 Cookie 带进登录页；正式分区
    // 只有在身份校验和服务端保存都成功后才会被替换。其他平台保持原有逻辑。
    if (isIsolatedJdLogin) {
      storeOriginalCookies.delete(storeId)
      await platformSession.clearStorageData()
    } else if (keepCookie) {
      storeOriginalCookies.set(storeId, await platformSession.cookies.get({}))
    } else {
      storeOriginalCookies.delete(storeId)
      await platformSession.clearStorageData({ storages: ['cookies'] })
    }

    const webPreferences = {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: partitionName,
      additionalArguments: ['--dxe-custom-platform-titlebar=1']
    }
    // 登录凭据只通过隔离 preload 在内存中捕获；京东登录成功后写入本机
    // Windows 加密存储，不再上传服务端或写入普通配置文件。
    webPreferences.preload = preloadPath

    const win = new BrowserWindow({
      width: 960,
      height: 680,
      minWidth: 820,
      minHeight: 560,
      show: false,
      title: platform === 'jd' ? '京东店铺安全登录' : `店铺登录 - ${platform}`,
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#0b4776',
        symbolColor: '#ffffff',
        height: 43
      },
      backgroundColor: '#ffffff',
      icon: resolveAppPath('resources/icon.ico'),
      webPreferences
    })
    win.setMenuBarVisibility(false)

    // 使用与当前 Chromium 运行时一致的标准 Chrome UA。Client Hints 由 Chromium
    // 自己生成，避免请求头与页面中的 navigator.userAgentData 互相矛盾。
    if (platform === 'jd') {
      const browserIdentity = createStandardChromeIdentity(process.versions.chrome)
      win._browserIdentity = browserIdentity
      win.webContents.setUserAgent(browserIdentity.userAgent)
      platformSession.webRequest.onErrorOccurred({ urls: ['*://*.jd.com/*'] }, (details) => {
        if (details.error === 'net::ERR_ABORTED') return
        runtimeLog.writeLog(
          'STORE_LOGIN',
          `store_id=${storeId} phase=jd_request_failed code=${details.error} url=${details.url}`
        )
      })
    }

    const loadPromise = win.loadURL(targetUrl)
    let jdFallbackAttempted = false

    // 首屏绘制完成前保持隐藏，避免 Chromium 新窗口初始表面短暂透出
    // 主窗口/白屏。ready-to-show 后再一次性展示完整登录页。
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return
      win.show()
      win.focus()
    })
    // 延迟再聚焦一次，防止主窗口的 ElMessage/router 操作抢焦点
    setTimeout(() => {
      if (!win.isDestroyed()) win.focus()
    }, 500)

    platformWindows.set(storeId, win)
    storePlatforms.set(storeId, platform)
    storeKeepCookie.set(storeId, !!keepCookie)  // ★ 记录是否为重新登录，关闭时用于判断是否删除空白店铺
    storeCredentials.delete(storeId)
    storeExtractedInfo.delete(storeId)

    let initialAccount = account || ''
    let initialPassword = password || ''
    if (platform === 'jd') {
      try {
        const savedCredential = getJdStoreCredential(storeId)
        initialAccount = savedCredential?.account || initialAccount
        initialPassword = savedCredential?.password || initialPassword
        runtimeLog.writeLog(
          'STORE_LOGIN',
          `store_id=${storeId} phase=credential_vault_read result=success account=${initialAccount ? 'yes' : 'no'} password=${initialPassword ? 'yes' : 'no'}`
        )
      } catch (error) {
        runtimeLog.writeLog(
          'STORE_LOGIN',
          `store_id=${storeId} phase=credential_vault_read result=failed reason=${String(error.message || error).slice(0, 160)}`
        )
      }
    }
    if (initialAccount || initialPassword) {
      storeCredentials.set(storeId, { account: initialAccount, password: initialPassword })
    }

    // 页面加载完成后：自动填充凭证 + 提取商家信息
    win.webContents.on('did-finish-load', () => {
      if (win.isDestroyed()) return
      const currentUrl = win.webContents.getURL()

      if (platform === 'jd') {
        sendPlatformLoginCredentials(storeId, win, 'did-finish-load')
        completeJdStoreLogin(win, storeId).catch(error => {
          runtimeLog.writeLog(
            'STORE_LOGIN',
            `store_id=${storeId} phase=jd_login_probe result=failed reason=${String(error.message || error).slice(0, 180)}`
          )
        })
        return
      }

      // 1. 自动填充登录凭证（如果有）
      sendPlatformLoginCredentials(storeId, win, 'did-finish-load')

      // 2. 在后台页面提取商家信息（排除登录页）
      const isBackend = isBackendUrl(currentUrl, platform)

      if (isBackend) {
        console.log('[PlatformWindow] 检测到后台页面:', currentUrl)
        // 启动重试提取机制（3s, 6s, 9s, 12s）
        startExtractionRetry(win, storeId, mainWindow, platform)
      }
    })

    // 关闭/X/取消都不再隐式保存；只有已验证的自动保存或“确认已登录”可以写入。
    win.on('close', (e) => {
      if (win._saveDone) return
      e.preventDefault()
      if (win._closing) return
      win._closing = true
      win._loginCancelled = true

      const closeWithoutSaving = async () => {
        let saveSucceeded = false
        const activeSave = storeSaveTasks.get(storeId)
        if (activeSave) {
          const result = await activeSave
          saveSucceeded = result.success === true
        }

        const usesTemporaryLoginSession = !String(storeLoginPartitions.get(storeId) || '').startsWith('persist:')
        if (!saveSucceeded) {
          if (storeKeepCookie.get(storeId) && !usesTemporaryLoginSession) {
            await restoreOriginalCookies(storeId)
          } else {
            // 已有京东店铺使用临时登录分区，取消时正式 Cookie 完全未动；只有新增
            // 店铺（keepCookie=false）才需要删除服务端 pending 记录。
            if (!storeKeepCookie.get(storeId)) {
              const cleanupResult = await cleanupPendingStoreOnServer(
                storeId,
                activeSave ? 'close_after_save_failure' : 'window_cancel'
              )
              if (!cleanupResult.success && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('platform-login-failed', {
                  requestedStoreId: storeId,
                  message: cleanupResult.message || '取消登录后清理临时店铺失败'
                })
              }
              if (!usesTemporaryLoginSession) {
                const pendingSession = session.fromPartition(permanentPartitionName)
                await pendingSession.clearStorageData()
              }
            }
          }
        }

        try {
          const ses = session.fromPartition(partitionName)
          ses.flushStorageData()
        } catch (error) {
          console.error('[PlatformWindow] Session刷盘失败:', error.message)
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('platform-login-closed', { requestedStoreId: storeId })
        }
        win._saveDone = true
        win.destroy()
      }
      closeWithoutSaving().catch(error => {
        console.error('[PlatformWindow] 关闭登录窗口失败:', error.message)
        win._saveDone = true
        win.destroy()
      })
    })

    win.on('closed', () => cleanupPlatformWindowState(storeId))

    try {
      await loadPromise
      if (platform === 'jd' && !win.isDestroyed()) {
        // 该 JZT 地址在部分网络环境会返回 200 + 空响应体，loadURL 可能仍然
        // resolve。主动识别空文档，否则用户只会看到一个无法操作的白窗。
        const hasUsableDocument = await win.webContents.executeJavaScript(`
          Boolean(document.body && (document.body.children.length || document.body.innerText.trim()))
        `).catch(() => false)
        if (!hasUsableDocument) {
          jdFallbackAttempted = true
          runtimeLog.writeLog(
            'STORE_LOGIN',
            `store_id=${storeId} phase=primary_entry_blank action=fallback url=${targetUrl}`
          )
          await win.loadURL(JD_STORE_LOGIN_FALLBACK_URL)
          return { success: true, fallback: true }
        }
      }
      return { success: true }
    } catch (error) {
      // 登录页可能通过服务端或页面脚本继续导航。Electron 会将初始 loadURL
      // 标为 ERR_ABORTED（-3），但目标页仍在窗口中加载，不能误判为失败。
      if (!win.isDestroyed() && isExpectedNavigationAbort(error)) {
        const currentUrl = win.webContents.getURL()
        runtimeLog.writeLog(
          'STORE_LOGIN',
          `store_id=${storeId} phase=initial_redirect result=continue url=${currentUrl || targetUrl}`
        )
        console.log('[PlatformWindow] 初始导航被正常重定向，继续等待登录页:', currentUrl || targetUrl)
        return { success: true, redirected: true }
      }

      // 京东 JZT 登录入口有时会直接让 Electron 返回 ERR_FAILED(-2)，这并不
      // 代表 passport 整体不可用。自动切换到京东通用账号登录页，登录完成后
      // 仍由同一套 Cookie + 店铺身份校验接管，安全边界不变。
      if (platform === 'jd' && !jdFallbackAttempted && !win.isDestroyed()) {
        runtimeLog.writeLog(
          'STORE_LOGIN',
          `store_id=${storeId} phase=primary_entry_failed action=fallback code=${error.code || ''} reason=${String(error.message || error).slice(0, 180)}`
        )
        try {
          await win.loadURL(JD_STORE_LOGIN_FALLBACK_URL)
          runtimeLog.writeLog(
            'STORE_LOGIN',
            `store_id=${storeId} phase=fallback_entry result=loaded url=${JD_STORE_LOGIN_FALLBACK_URL}`
          )
          return { success: true, fallback: true }
        } catch (fallbackError) {
          if (!win.isDestroyed() && isExpectedNavigationAbort(fallbackError)) {
            const currentUrl = win.webContents.getURL()
            runtimeLog.writeLog(
              'STORE_LOGIN',
              `store_id=${storeId} phase=fallback_redirect result=continue url=${currentUrl || JD_STORE_LOGIN_FALLBACK_URL}`
            )
            return { success: true, redirected: true, fallback: true }
          }
          error = fallbackError
        }
      }
      if (keepCookie && !isIsolatedJdLogin) {
        await restoreOriginalCookies(storeId)
      } else {
        if (!keepCookie) await cleanupPendingStoreOnServer(storeId, 'load_failed')
        await platformSession.clearStorageData()
      }
      win._saveDone = true
      if (!win.isDestroyed()) win.destroy()
      cleanupPlatformWindowState(storeId)
      return { success: false, message: `平台登录页面加载失败: ${error.message}` }
    }
  })

  // 监听账号密码输入（平台窗口 preload 发送）
  ipcMain.on('platform-login-credentials', (event, { account, password }) => {
    for (const [sid, win] of platformWindows.entries()) {
      if (win.webContents === event.sender) {
        const prev = storeCredentials.get(sid) || {}
        storeCredentials.set(sid, {
          account: account || prev.account || '',
          password: password || prev.password || ''
        })
        console.log('[PlatformWindow] 收到凭证 storeId=', sid, 'account=', account || prev.account)
        break
      }
    }
  })

  ipcMain.on('platform-login-ready', event => {
    const matched = findPlatformWindowBySender(event.sender)
    if (!matched) return
    sendPlatformLoginCredentials(matched.storeId, matched.win, 'preload-ready')
  })

  ipcMain.on('platform-login-fill-result', (event, result = {}) => {
    const matched = findPlatformWindowBySender(event.sender)
    if (!matched) return
    runtimeLog.writeLog(
      'STORE_LOGIN',
      `store_id=${matched.storeId} phase=credential_fill_result account_provided=${result.accountProvided ? 'yes' : 'no'} password_provided=${result.passwordProvided ? 'yes' : 'no'} account_found=${result.accountFound ? 'yes' : 'no'} password_found=${result.passwordFound ? 'yes' : 'no'} account_filled=${result.accountFilled ? 'yes' : 'no'} password_filled=${result.passwordFilled ? 'yes' : 'no'}`
    )
  })

  // 监听商家信息提取（平台窗口 preload 发送）
  ipcMain.on('platform-store-info', (event, info) => {
    for (const [sid, win] of platformWindows.entries()) {
      if (win.webContents === event.sender) {
        const prev = storeExtractedInfo.get(sid) || {}
        storeExtractedInfo.set(sid, { ...prev, ...info })
        console.log('[PlatformWindow] preload 提取到商家信息 storeId=', sid, info)
        break
      }
    }
  })

  // 确认登录（手动触发，功能保留）
  ipcMain.handle('confirm-platform-login', async (event, { storeId, platform }) => {
    const win = platformWindows.get(storeId)
    if (!win || win.isDestroyed()) {
      return { success: false, message: '平台窗口未打开或已关闭' }
    }

    const actualPlatform = storePlatforms.get(storeId) || platform
    if (actualPlatform === 'jd') {
      return completeJdStoreLogin(win, storeId, { manual: true })
    }
    if (!isBackendUrl(win.webContents.getURL(), actualPlatform)) {
      return { success: false, message: '尚未进入店铺后台，请先完成登录' }
    }

    const cred = storeCredentials.get(storeId) || {}
    const result = await saveStoreInfo(mainWindow, storeId, actualPlatform, cred.account, cred.password, {
      verifiedLogin: true
    })
    if (!result.success) return result

    win._saveDone = true
    win.close()
    return result
  })

  // 关闭平台窗口
  ipcMain.handle('close-platform-window', async (event, { storeId }) => {
    const win = platformWindows.get(storeId)
    if (win && !win.isDestroyed()) {
      win.close()
    }
    return { success: true }
  })
}

// 保存店铺信息：只有确认进入后台后，才事务化提交店铺资料和 Cookie。
async function saveStoreInfo(mainWindow, storeId, platform, account, password, {
  verifiedLogin = false,
  sessionPartition = '',
  expectedMerchantId = '',
  expectedShopId = ''
} = {}) {
  if (storeSaveTasks.has(storeId)) return storeSaveTasks.get(storeId)

  const saveTask = (async () => {
    const failSave = (phase, message) => {
      runtimeLog.writeLog(
        'STORE_LOGIN',
        `store_id=${storeId} phase=${phase} result=failed reason=${String(message || 'unknown').replace(/[\r\n\t]+/g, ' ').slice(0, 180)}`
      )
      return { success: false, message }
    }
    if (!verifiedLogin) {
      return failSave('verify_backend', '尚未进入店铺后台，请先完成登录')
    }

    const partitionName = sessionPartition || `persist:platform-${storeId}`
    const ses = session.fromPartition(partitionName)
    const cookies = await ses.cookies.get({})
    if (!Array.isArray(cookies) || cookies.length === 0) {
      return failSave('read_cookie', '未获取到登录Cookie，请重新登录后再确认')
    }

    let cookieMerchantId = ''
    let cookieShopId = ''
    let pinName = ''
    for (const cookie of cookies) {
      const name = String(cookie?.name || '')
      const nameLow = name.toLowerCase()
      const value = String(cookie?.value || '')
      if (!value) continue
      if (!cookieMerchantId && (name === 'venderId' || nameLow === 'venderid' || nameLow === 'merchant_id')) {
        cookieMerchantId = value
      }
      if (!cookieShopId && (name === 'shopId' || nameLow === 'shopid' || nameLow === 'shop_id')) {
        cookieShopId = value
      }
      if (!pinName && ['pin', 'pt_pin', 'pinid'].includes(nameLow)) {
        try { pinName = decodeURIComponent(value) } catch { pinName = value }
      }
    }

    const extracted = storeExtractedInfo.get(storeId) || {}
    const merchantId = String(extracted.venderId || cookieMerchantId || '').trim()
    const shopId = String(extracted.shopId || cookieShopId || '').trim()
    if (platform === 'jd') {
      const cookieState = getJdLoginCookieState(cookies)
      if (!cookieState.valid) {
        return failSave('verify_cookie', '未取得完整京东登录凭证，请重新登录后再试')
      }
      const identityCheck = validateJdStoreIdentity(
        { venderId: merchantId, shopId },
        { merchantId: expectedMerchantId, shopId: expectedShopId }
      )
      if (!identityCheck.valid) {
        return failSave('verify_identity', '当前登录店铺与原店铺不一致，已停止覆盖 Cookie')
      }
    }
    const updateBody = {
      cookie_data: cookies,
      domain: platform,
      device_id: getDeviceId()
    }
    if (account) updateBody.account = account
    if (platform !== 'jd' && password) updateBody.password = password
    if (merchantId) updateBody.merchant_id = merchantId
    if (shopId) updateBody.shop_id = shopId
    if (extracted.storeName) updateBody.name = extracted.storeName
    if (!account && pinName) updateBody.account = pinName
    if (expectedMerchantId) updateBody.expected_merchant_id = String(expectedMerchantId).trim()
    if (expectedShopId) updateBody.expected_shop_id = String(expectedShopId).trim()

    const finalized = await finalizeStoreLoginOnServer(storeId, updateBody)
    if (!finalized.success) {
      return failSave('finalize', finalized.message || '保存店铺资料失败')
    }

    const targetStoreId = Number(finalized.data?.store_id || storeId)
    let cookieRevision = Number(finalized.data?.cookie_revision || 0)
    const targetPartitionName = `persist:platform-${targetStoreId}`
    if (targetStoreId !== Number(storeId) || partitionName !== targetPartitionName) {
      const restored = await replaceLocalStoreCookies(targetStoreId, cookies)
      runtimeLog.writeLog(
        'STORE_LOGIN',
        `store_id=${storeId} target_store_id=${targetStoreId} phase=replace_local_cookie source_partition=${partitionName.startsWith('persist:') ? 'persistent' : 'temporary'} restored=${restored}/${cookies.length}`
      )
      if (platform === 'jd') {
        const targetCookies = await session.fromPartition(targetPartitionName).cookies.get({})
        if (!getJdLoginCookieState(targetCookies).valid) {
          return failSave('replace_local_cookie', '京东登录已保存到云端，但本机登录状态写入失败，请重新打开登录窗口重试')
        }
      }
    }
    if (cookieRevision > 0) setCookieRevision(targetStoreId, cookieRevision)

    // 兼容旧服务端：旧接口只完成资料归并，Cookie 仍走原版本化接口。
    if (finalized.data?.cookie_saved !== true) {
      const cookieResult = await uploadCookiesToServer(targetStoreId, platform, cookies, {
        sourceType: 'login_capture',
        verified: true,
        context: 'platform_login_capture'
      })
      if (!cookieResult.success) {
        return failSave('legacy_cookie_upload', cookieResult.reason || '保存Cookie失败')
      }
      cookieRevision = Number(cookieResult.revision || 0)
    }

    const statusResult = await reportStoreDeviceStatus(targetStoreId, {
      online: true,
      verified: true,
      reason: 'platform_login_capture',
      context: 'platform_login_status'
    })
    ses.flushStorageData()

    runtimeLog.writeLog(
      'STORE_LOGIN',
      `store_id=${storeId} target_store_id=${targetStoreId} phase=save result=success merged=${finalized.data?.merged === true} cookies=${cookies.length} revision=${cookieRevision} status_reported=${statusResult.success === true}`
    )
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('platform-login-success', {
        requestedStoreId: storeId,
        storeId: targetStoreId,
        account: updateBody.account || ''
      })
    }
    return {
      success: true,
      storeId: targetStoreId,
      merged: finalized.data?.merged === true,
      cookieRevision,
      statusReported: statusResult.success === true
    }
  })().catch(error => {
    runtimeLog.writeLog(
      'STORE_LOGIN',
      `store_id=${storeId} phase=save result=failed reason=${String(error.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 180)}`
    )
    return { success: false, message: error.message || '店铺登录信息保存失败' }
  })

  storeSaveTasks.set(storeId, saveTask)
  try {
    return await saveTask
  } finally {
    if (storeSaveTasks.get(storeId) === saveTask) storeSaveTasks.delete(storeId)
  }
}

// ==================== 采购账号登录窗口 ====================

// 采购平台登录 URL
const PURCHASE_LOGIN_URLS = {
  taobao: 'https://login.taobao.com/member/login.jhtml',
  // ★ PDD登录必须在 yangkeduo.com 域上完成（对齐dl系统）：
  //   登录在 yangkeduo.com → cookie设在 .yangkeduo.com → 商品页(yangkeduo.com)能用
  //   登录在 pinduoduo.com → cookie只在 .pinduoduo.com → 商品页(yangkeduo.com)零cookie→跳登录
  pinduoduo: 'https://mobile.yangkeduo.com/login.html',
  douyin: 'https://www.douyin.com/login',
  '1688': 'https://login.1688.com/'
}

// 采购平台后台 URL（用于登录成功检测）
const PURCHASE_BACKEND_URLS = {
  taobao: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
  pinduoduo: 'https://mobile.yangkeduo.com/personal.html',
  douyin: 'https://www.douyin.com/',
  '1688': 'https://trade.1688.com/order/buyer_order_list.htm'
}

// 已打开的采购账号窗口 Map<accountId, BrowserWindow>
const purchaseWindows = new Map()

// 后台恢复采购账号 cookie（不阻塞窗口加载，消除白屏等待）
async function restorePurchaseCookiesInBackground(accountId, platform, partitionName, win) {
  try {
    const ses = session.fromPartition(partitionName)
    const now = Date.now() / 1000
    const cookieRes = await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
      method: 'GET'
    })
    if (cookieRes.statusCode === 200 && cookieRes.data) {
      const json = JSON.parse(cookieRes.data)
      if (json.code === 0 && json.data && json.data.cookie_data) {
        const raw = typeof json.data.cookie_data === 'string'
          ? JSON.parse(json.data.cookie_data)
          : json.data.cookie_data
        if (Array.isArray(raw) && raw.length > 0) {
          const serverCookies = filterCookiesForPlatform(raw, platform).filter(ck => {
            if (ck.expirationDate && ck.expirationDate > 0 && ck.expirationDate < now) return false
            return true
          })
          console.log(`[PurchaseWindow] 后台恢复cookie: ${serverCookies.length}/${raw.length} 条, accountId=${accountId}`)

          // PDD：恢复前先清除 partition 中该平台域名的旧 cookie
          // 原因：旧 cookie 可能是 hostOnly（domain 无前导点），与服务器的新格式（有前导点）不同
          // ses.cookies.set() 不会删除旧格式 cookie，导致新旧并存，PDD 优先使用旧的失效 cookie
          if (platform === 'pinduoduo') {
            try {
              const existing = await ses.cookies.get({})
              const pddDomains = ['yangkeduo.com', 'pinduoduo.com', 'pdd.net']
              const oldPddCookies = existing.filter(c =>
                pddDomains.some(d => c.domain && c.domain.includes(d))
              )
              for (const old of oldPddCookies) {
                try {
                  const secure = old.secure || false
                  const url = (secure ? 'https://' : 'http://') + (old.domain || '').replace(/^\./, '') + (old.path || '/')
                  await ses.cookies.remove(url, old.name)
                } catch (e) { /* ignore */ }
              }
              console.log(`[PurchaseWindow] PDD 旧 cookie 已清除: ${oldPddCookies.length} 条, accountId=${accountId}`)
            } catch (clearErr) {
              console.warn(`[PurchaseWindow] PDD 旧 cookie 清除失败:`, clearErr.message)
            }
          }

          // 淘宝：恢复前先清除 partition 中该平台域名的旧 cookie
          // 原因：旧 cookie 可能是 hostOnly（domain 无前导点如 taobao.com），与服务器新格式（有前导点如 .taobao.com）不同
          // Chromium 视为不同 cookie，新旧并存时淘宝优先使用旧的失效 cookie，导致滑块验证或登录重定向
          if (platform === 'taobao') {
            try {
              const existing = await ses.cookies.get({})
              const tbDomains = ['taobao.com', 'tmall.com', 'tmall.hk', 'alipay.com']
              const oldTbCookies = existing.filter(c =>
                tbDomains.some(d => c.domain && c.domain.includes(d))
              )
              for (const old of oldTbCookies) {
                try {
                  const secure = old.secure || false
                  const url = (secure ? 'https://' : 'http://') + (old.domain || '').replace(/^\./, '') + (old.path || '/')
                  await ses.cookies.remove(url, old.name)
                } catch (e) { /* ignore */ }
              }
              console.log(`[PurchaseWindow] 淘宝旧 cookie 已清除: ${oldTbCookies.length} 条, accountId=${accountId}`)
            } catch (clearErr) {
              console.warn(`[PurchaseWindow] 淘宝旧 cookie 清除失败:`, clearErr.message)
            }
          }

          let setOk = 0
          for (const ck of serverCookies) {
            try {
              const sameSite = ck.sameSite || undefined
              const secure = sameSite === 'no_restriction' ? true : (ck.secure || false)
              await ses.cookies.set({
                url: (secure ? 'https://' : 'http://') + (ck.domain || '').replace(/^\./, '') + (ck.path || '/'),
                name: ck.name,
                value: ck.value || '',
                domain: ck.domain,
                path: ck.path || '/',
                secure,
                httpOnly: ck.httpOnly || false,
                expirationDate: ck.expirationDate || undefined,
                sameSite
              })
              setOk++
            } catch (e2) {
              // ignore individual cookie set errors
            }
          }
          // 非阻塞刷盘（不 await，与 purchase-order-capture 一致）
          ses.flushStorageData()
          console.log(`[PurchaseWindow] 后台刷盘已触发, accountId=${accountId}`)
          console.log(`[PurchaseWindow] 后台恢复写入: ${setOk} 成功, accountId=${accountId}`)

          // 恢复成功后：如果窗口还显示登录页，刷新到后台页面
          // 时序问题：win.loadURL 先执行（加载登录页），后台恢复后 cookie 已写入但页面不知道
          // 需要让页面重新加载才能使用新 cookie

          // PDD 平台：检测 PDD 登录页并刷新到后台
          if (platform === 'pinduoduo' && win && !win.isDestroyed() && setOk > 0) {
            try {
              const currentUrl = win.webContents.getURL()
              const pddLoginUrls = [
                'yangkeduo.com/proxy/api/login',
                'pinduoduo.com/login',
                'login.yangkeduo.com'
              ]
              const isOnPddLoginPage = pddLoginUrls.some(u => currentUrl.includes(u))
              if (isOnPddLoginPage) {
                console.log(`[PurchaseWindow] PDD Cookie恢复成功，刷新页面到后台: https://mobile.yangkeduo.com`)
                win.loadURL('https://mobile.yangkeduo.com')
              } else if (currentUrl.includes('yangkeduo.com') || currentUrl.includes('pinduoduo.com')) {
                console.log(`[PurchaseWindow] PDD Cookie恢复成功，刷新当前页面`)
                win.webContents.reload()
              }
            } catch (e) {
              // 忽略刷新失败
            }
          }

          // 淘宝平台：检测淘宝登录页并刷新到后台（已买到的商品页面）
          // 淘宝登录页 URL 包含 login.taobao.com，恢复 cookie 后需导航到后台页面才能使用
          if (platform === 'taobao' && win && !win.isDestroyed() && setOk > 0) {
            try {
              const currentUrl = win.webContents.getURL()
              const isOnTbLoginPage = currentUrl.includes('login.taobao.com') || currentUrl.includes('login.tmall.com')
              if (isOnTbLoginPage) {
                const tbBackendUrl = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm'
                console.log(`[PurchaseWindow] 淘宝Cookie恢复成功，刷新页面到后台: ${tbBackendUrl}`)
                win.loadURL(tbBackendUrl)
              } else if (currentUrl.includes('taobao.com') || currentUrl.includes('tmall.com')) {
                console.log(`[PurchaseWindow] 淘宝Cookie恢复成功，刷新当前页面`)
                win.webContents.reload()
              }
            } catch (e) {
              // 忽略刷新失败
            }
          }
        }
      }
    }
  } catch (restoreErr) {
    console.warn(`[PurchaseWindow] 后台恢复cookie失败: accountId=${accountId}`, restoreErr.message)
  }
}

function registerPurchaseAccountIpc(mainWindow) {
  const preloadPath = resolveAppPath('resources/platform-login-preload.js')

  async function resolvePurchaseLoginCredential(
    accountId,
    platform,
    requestedAccount,
    requestedPassword,
    requestedServerUpdatedAt
  ) {
    const normalizedPlatform = String(platform || '').toLowerCase()
    let account = String(requestedAccount || '')
    let password = String(requestedPassword || '')
    let source = password ? 'request' : 'none'
    let localServerUpdatedAt = ''

    try {
      const local = getPurchaseAccountCredential(accountId)
      if (local && (!local.platform || local.platform === normalizedPlatform)) {
        const usedLocal = (!account && !!local.account) || (!password && !!local.password)
        account = account || local.account
        password = password || local.password
        localServerUpdatedAt = local.serverUpdatedAt || ''
        if (usedLocal) source = 'local-vault'
      }
    } catch (error) {
      runtimeLog.writeLog(
        'PURCHASE_LOGIN',
        `account_id=${accountId} phase=credential_vault_read result=failed reason=${String(error.message || error).slice(0, 160)}`
      )
    }

    // 老版本只把密码保存在服务器。首次打开时迁移到本机 safeStorage，
    // 后续登录优先读取本机加密凭据，避免把密码交给 renderer。
    const requestedUpdatedMs = Date.parse(String(requestedServerUpdatedAt || ''))
    const localUpdatedMs = Date.parse(localServerUpdatedAt)
    const serverCredentialMayBeNewer = Number.isFinite(requestedUpdatedMs) &&
      (!Number.isFinite(localUpdatedMs) || requestedUpdatedMs > localUpdatedMs)
    if (!account || !password || serverCredentialMayBeNewer) {
      try {
        const response = await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/login-credential`)
        const remote = requireBusinessResponse(response, '读取采购账号登录凭据失败') || {}
        const remotePlatform = String(remote.platform || '').toLowerCase()
        if (!remotePlatform || remotePlatform === normalizedPlatform) {
          if (serverCredentialMayBeNewer) {
            account = String(remote.account || account)
            password = String(remote.password || password)
          } else {
            account = account || String(remote.account || '')
            password = password || String(remote.password || '')
          }
          localServerUpdatedAt = String(remote.updated_at || requestedServerUpdatedAt || localServerUpdatedAt)
          if (remote.account || remote.password) source = 'server-migration'
        }
      } catch (error) {
        runtimeLog.writeLog(
          'PURCHASE_LOGIN',
          `account_id=${accountId} phase=credential_migration result=failed reason=${String(error.message || error).slice(0, 160)}`
        )
      }
    }

    if (account || password) {
      try {
        const saved = savePurchaseAccountCredential(accountId, {
          account,
          password,
          platform: normalizedPlatform,
          serverUpdatedAt: localServerUpdatedAt
        })
        runtimeLog.writeLog(
          'PURCHASE_LOGIN',
          `account_id=${accountId} phase=credential_vault_write result=${saved.success ? 'success' : 'failed'} source=${source} account=${account ? 'yes' : 'no'} password=${password ? 'yes' : 'no'}${saved.reason ? ` reason=${String(saved.reason).slice(0, 120)}` : ''}`
        )
      } catch (error) {
        runtimeLog.writeLog(
          'PURCHASE_LOGIN',
          `account_id=${accountId} phase=credential_vault_write result=failed source=${source} reason=${String(error.message || error).slice(0, 160)}`
        )
      }
    }

    return { account, password }
  }

  // 打开采购账号登录窗口
  ipcMain.handle('open-purchase-login-window', async (event, {
    accountId,
    platform,
    account: requestedAccount,
    password: requestedPassword,
    credentialUpdatedAt,
    clearSession = false,
    autoCloseOnSuccess = false
  }) => {
    if (purchaseWindows.has(accountId)) {
      const existWin = purchaseWindows.get(accountId)
      if (!existWin.isDestroyed()) {
        existWin.focus()
        return { success: true, message: '窗口已打开' }
      }
      purchaseWindows.delete(accountId)
    }

    const loginUrl = PURCHASE_LOGIN_URLS[platform]
    if (!loginUrl) {
      return { success: false, message: `不支持的采购平台: ${platform}` }
    }

    const partitionName = `persist:purchase-${accountId}`
    const resolvedCredential = await resolvePurchaseLoginCredential(
      accountId,
      platform,
      requestedAccount,
      requestedPassword,
      credentialUpdatedAt
    )
    const account = resolvedCredential.account
    const password = resolvedCredential.password
    const platformTitle = {
      taobao: '淘宝/天猫',
      tmall: '淘宝/天猫',
      pinduoduo: '拼多多',
      '1688': '阿里巴巴',
      douyin: '抖音'
    }[platform] || platform

    // “重登”明确清除旧会话；不再用“是否传账号”推断，以免清 Cookie 后丢失代填凭据。
    if (clearSession === true) {
      const ses = session.fromPartition(partitionName)
      await ses.clearStorageData({ storages: ['cookies'] })
      invalidateTaobaoAccountValidation(accountId)
      invalidateCookieRestoreCache(accountId, platform)
    }

    const win = new BrowserWindow({
      width: 1100,
      height: 750,
      title: `店小二网店管家 - ${platformTitle}安全登录`,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      icon: resolveAppPath('resources/icon.ico'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: partitionName,
        preload: preloadPath
      }
    })
    win.setMenuBarVisibility(false)

    // 反检测：伪装 Electron 指纹为标准 Chrome（和采购窗口一致）
    const chromeVersion = process.versions.chrome || '134.0.0.0'
    const cleanUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
    win.webContents.setUserAgent(cleanUA)
    const ses = session.fromPartition(partitionName)
    const secChUa = `"Chromium";v="${chromeVersion.split('.')[0]}", "Google Chrome";v="${chromeVersion.split('.')[0]}", "Not-A.Brand";v="99"`
    ses.webRequest.onBeforeSendHeaders({ urls: ['*://*.yangkeduo.com/*', '*://*.pinduoduo.com/*', '*://*.pdd.net/*'] }, (details, callback) => {
      if (details.requestHeaders) {
        details.requestHeaders['Sec-CH-UA'] = secChUa
        details.requestHeaders['Sec-CH-UA-Platform'] = '"Windows"'
        details.requestHeaders['User-Agent'] = cleanUA
      }
      callback({ requestHeaders: details.requestHeaders })
    })

    // ★ 快速检查 partition 现有 cookie → 确定初始 URL → 立即加载（消除白屏等待）
    // 后台再从服务器恢复 cookie（PDD 始终恢复，非 PDD 仅在无有效 cookie 时恢复）
    let targetUrl = loginUrl
    let needServerRestore = false

    if (account) {
      try {
        const ses = session.fromPartition(partitionName)
        const cookies = await ses.cookies.get({})
        const now = Date.now() / 1000

        const PLATFORM_COOKIE_CONFIG = {
          pinduoduo: {
            domains: ['pinduoduo.com', 'yangkeduo.com'],
            keys: ['PDDAccessToken', 'pdd_user_uin', 'pdd_user_id', 'pdd_vds', 'api_uid']
          },
          '1688': {
            domains: ['1688.com', 'alibaba.com'],
            keys: ['cookie2', '_nk_', 'sgcookie', '_m_h5_tk', 'csg_token']
          },
          taobao: {
            domains: ['taobao.com', 'tmall.com'],
            keys: ['cookie2', '_nk_', 'sgcookie', '_m_h5_tk', 'SUB']
          },
          douyin: {
            domains: ['douyin.com', 'jinritemai.com'],
            keys: ['sessionid', 'sessionid_ss', 'sid_guard', 'uid_tt', 'uid_tt_ss']
          }
        }

        const cookieConfig = PLATFORM_COOKIE_CONFIG[platform]
        if (cookieConfig) {
          const { domains, keys } = cookieConfig
          const platformCookieCount = cookies.filter(c =>
            c.domain && domains.some(d => c.domain.includes(d))
          ).length
          let hasValidCookie = cookies.some(c => {
            if (!c.domain || !domains.some(d => c.domain.includes(d))) return false
            if (keys.includes(c.name) && c.value && c.value.length > 5) {
              if (c.expirationDate && c.expirationDate > 0 && c.expirationDate < now) return false
              return true
            }
            return false
          })
          // 兜底：大量平台域cookie（>5条）可能有效，但 PDD/淘宝除外
          if (!hasValidCookie && platformCookieCount > 5 && platform !== 'pinduoduo' && platform !== 'taobao') {
            hasValidCookie = true
          }

          // PDD 始终需要从服务器恢复（即使 partition 有有效 cookie）
          // PDDAccessToken 可能在本地未过期但服务端已失效
          // 淘宝始终需要从服务器恢复（即使 partition 有有效 cookie）
          // SUB/cookie2 可能在本地未过期但服务端已撤销/轮换，导致滑块验证；多台电脑共享需获取最新 cookie
          // 其他平台仅在无有效 cookie 时恢复
          needServerRestore = !hasValidCookie || platform === 'pinduoduo' || platform === 'taobao'

          if (hasValidCookie) {
            const backendUrl = PURCHASE_BACKEND_URLS[platform]
            if (backendUrl) targetUrl = backendUrl
          }
        }
      } catch (e) {
        needServerRestore = true
      }
    }

    function sendPurchaseLoginCredentials(source) {
      if (win.isDestroyed() || platform === 'pinduoduo' || (!account && !password)) return false
      runtimeLog.writeLog(
        'PURCHASE_LOGIN',
        `account_id=${accountId} phase=credential_fill_send source=${source} account=${account ? 'yes' : 'no'} password=${password ? 'yes' : 'no'}`
      )
      win.webContents.send('fill-credentials', { account, password })
      return true
    }

    // preload 在每次导航后都会重新发送 ready。必须在 loadURL 前注册，
    // 避免淘宝页面较快时错过首次握手。
    const fillReadyHandler = event => {
      if (win.isDestroyed() || win.webContents !== event.sender) return
      sendPurchaseLoginCredentials('preload-ready')
    }
    const fillResultHandler = (event, result = {}) => {
      if (win.isDestroyed() || win.webContents !== event.sender) return
      runtimeLog.writeLog(
        'PURCHASE_LOGIN',
        `account_id=${accountId} phase=credential_fill_result account_provided=${result.accountProvided ? 'yes' : 'no'} password_provided=${result.passwordProvided ? 'yes' : 'no'} account_found=${result.accountFound ? 'yes' : 'no'} password_found=${result.passwordFound ? 'yes' : 'no'} account_filled=${result.accountFilled ? 'yes' : 'no'} password_filled=${result.passwordFilled ? 'yes' : 'no'}`
      )
    }
    ipcMain.on('platform-login-ready', fillReadyHandler)
    ipcMain.on('platform-login-fill-result', fillResultHandler)
    const removePurchaseFillListeners = () => {
      ipcMain.removeListener('platform-login-ready', fillReadyHandler)
      ipcMain.removeListener('platform-login-fill-result', fillResultHandler)
    }
    win.once('closed', removePurchaseFillListeners)

    // ★ 立即加载 URL（页面开始渲染，不再白屏等待）
    win.loadURL(targetUrl)

    // ★ 后台从服务器恢复 cookie（不阻塞页面加载）
    if (needServerRestore && account) {
      restorePurchaseCookiesInBackground(accountId, platform, partitionName, win)
    }

    win.webContents.on('did-fail-load', (e, code, desc, url) => {
      console.log(`[PurchaseWindow] did-fail-load: code=${code}, desc=${desc}, url=${url}`)
    })

    win.once('ready-to-show', () => { win.focus() })
    setTimeout(() => { if (!win.isDestroyed()) win.focus() }, 500)

    purchaseWindows.set(accountId, win)

    // 登录成功检测：延迟确认策略
    let loginDetected = false
    let h5WarmupDone = false

    // 各平台关键认证 cookie 名称（缺失则 PDD 会报"未登录"，淘宝会无法调 H5 API）
    const PLATFORM_CRITICAL_COOKIES = {
      pinduoduo: ['PDDAccessToken', 'pdd_user_uin', 'pdd_user_id'],
      taobao: ['_m_h5_tk', 'cookie2', '_nk_'],
      '1688': ['cookie2', '_nk_', 'csg_token'],
      douyin: ['sessionid', 'uid_tt']
    }

    // PDD cookie domain 规范化：mobile.yangkeduo.com（hostOnly）必须加前导点变为 .mobile.yangkeduo.com（非hostOnly）
    // 否则其他电脑恢复后 cookie 不跨子域共享，PDD 无法识别登录状态
    function normalizePddCookieDomain(cookies) {
      if (platform !== 'pinduoduo') return cookies
      let normalized = 0
      const result = cookies.map(c => {
        if (c.domain === 'mobile.yangkeduo.com' && c.hostOnly) {
          normalized++
          return { ...c, domain: '.mobile.yangkeduo.com', hostOnly: false }
        }
        return c
      })
      if (normalized > 0) console.log(`[PurchaseWindow] PDD domain 规范化: ${normalized} 条 cookie 加前导点 (platform=${platform})`)
      return result
    }

    // 保存 cookies 到服务器的通用函数
    async function saveCookiesToServer() {
      if (win.isDestroyed()) return null
      try {
        const ses = session.fromPartition(partitionName)
        let cookies = await ses.cookies.get({})
        if (cookies && cookies.length > 0) {
          cookies = normalizePddCookieDomain(cookies)
          let hasH5Tk = cookies.some(c => c.name === '_m_h5_tk')
          const saveResponse = await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie_data: JSON.stringify(cookies), platform })
          })
          requireBusinessResponse(saveResponse, '保存采购账号 Cookie 失败')
          invalidateCookieRestoreCache(accountId, platform)
          console.log(`[PurchaseWindow] Cookies 已保存: ${cookies.length} 条, _m_h5_tk=${hasH5Tk ? '有' : '无'}`)

          let validationStatus = ''
          if (platform === 'taobao') {
            const validation = await validateTaobaoPurchaseAccount({ accountId, ses })
            validationStatus = String(validation.status || '')
            console.log(`[PurchaseWindow] 淘宝账号轻量校验: status=${validation.status}, reason=${validation.reason}`)
            if (validation.cookieChanged) {
              cookies = await ses.cookies.get({})
              hasH5Tk = cookies.some(c => c.name === '_m_h5_tk')
            }
          }

          // 验证关键 cookie 是否齐全
          const criticalNames = PLATFORM_CRITICAL_COOKIES[platform] || []
          const cookieNames = new Set(cookies.map(c => c.name))
          const missing = criticalNames.filter(n => !cookieNames.has(n))
          if (missing.length > 0) {
            console.warn(`[PurchaseWindow] 关键 cookie 缺失: ${missing.join(', ')}，将在 8 秒后重试保存`)
            return { count: cookies.length, hasH5Tk, validationStatus, missingCritical: missing }
          }

          return { count: cookies.length, hasH5Tk, validationStatus }
        }
        return { count: 0, hasH5Tk: false }
      } catch (err) {
        console.error('[PurchaseWindow] Cookies 保存失败:', err.message)
        return null
      }
    }

    // 淘宝账号需要 _m_h5_tk：如果没有则导航到已买到的商品页面来获取
    // PDD 账号如果关键 cookie 缺失，延迟重试等待 JS 异步设置 cookie
    let loginAutoCloseScheduled = false
    function closeAfterSuccessfulCookieSave(result, source) {
      // “进入后台”是浏览/操作入口，即使 Cookie 有效也必须保持窗口打开；
      // 只有新增账号和“重登”这种明确的登录流程才在保存成功后自动关闭。
      if (autoCloseOnSuccess !== true) return false
      if (loginAutoCloseScheduled || !result || result.count <= 0 || result.missingCritical?.length) return false
      // 淘宝关键 Cookie 即使齐全也可能已经被服务端判定失效。只有轻量接口
      // 明确验证为 valid 才能关闭登录窗口，避免用户还未真正登录成功就被关掉。
      if (platform === 'taobao' && (!result.hasH5Tk || result.validationStatus !== 'valid')) return false
      loginAutoCloseScheduled = true
      runtimeLog.writeLog(
        'PURCHASE_LOGIN',
        `account_id=${accountId} phase=auto_close scheduled=yes source=${source} cookies=${result.count}`
      )
      setTimeout(() => {
        if (!win.isDestroyed()) win.close()
      }, 500)
      return true
    }

    async function ensureH5TokenAndSave() {
      // 首次访问后台地址经常会先触发一次非登录导航，随后才被平台重定向到
      // 登录页。只有窗口此刻仍处于已登录状态时才开始保存，避免提前消耗
      // h5WarmupDone，导致用户真正登录后无法再次保存并自动关闭。
      if (win.isDestroyed() || h5WarmupDone || !loginDetected) return
      h5WarmupDone = true

      // 第一次保存
      const result = await saveCookiesToServer()

      // PDD：关键 cookie 缺失时延迟重试（pdd_user_uin/pdd_user_id 由 JS 异步设置）
      if (platform === 'pinduoduo' && result && result.missingCritical) {
        setTimeout(async () => {
          if (win.isDestroyed()) return
          const retry = await saveCookiesToServer()
          if (retry && !retry.missingCritical) {
            console.log('[PurchaseWindow] PDD 关键 cookie 重试保存成功')
            closeAfterSuccessfulCookieSave(retry, 'pdd-retry')
          } else if (retry && retry.missingCritical) {
            console.warn(`[PurchaseWindow] PDD 关键 cookie 仍缺失: ${retry.missingCritical.join(', ')}`)
          }
        }, 8000)
      }

      // 淘宝平台：如果没有 _m_h5_tk，需要导航到商品列表页触发 H5 API 来获取
      if (platform === 'taobao' && result && !result.hasH5Tk) {
        console.log('[PurchaseWindow] 未找到 _m_h5_tk，导航到已买到的商品页面获取...')
        const h5WarmupUrl = 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm'
        try {
          await win.loadURL(h5WarmupUrl)
        } catch (e) {
          console.warn('[PurchaseWindow] 导航到商品列表页失败:', e.message)
        }
        // 等页面加载和 JS 执行完毕后再次保存
        setTimeout(async () => {
          const result2 = await saveCookiesToServer()
          if (result2 && result2.hasH5Tk && !result2.missingCritical?.length) {
            console.log('[PurchaseWindow] _m_h5_tk 已获取并保存')
            closeAfterSuccessfulCookieSave(result2, 'taobao-h5-warmup')
          } else {
            console.warn('[PurchaseWindow] 导航后仍未获取到 _m_h5_tk')
          }
        }, 8000)
      }

      const waitingForPddRetry = platform === 'pinduoduo' && !!result?.missingCritical?.length
      const waitingForTaobaoWarmup = platform === 'taobao' && !!result && !result.hasH5Tk
      if (!waitingForPddRetry && !waitingForTaobaoWarmup) {
        closeAfterSuccessfulCookieSave(result, 'initial-save')
      }
    }

    win.webContents.on('did-navigate', (e, url) => {
      const backendUrl = PURCHASE_BACKEND_URLS[platform] || ''
      const isLoginPage = url.includes('login') || url.includes('passport') || url.includes('sign')

      // 后台入口可能先加载一次再跳转登录页。看到登录页时必须撤销此前的
      // 临时判断，保证用户登录后离开登录页时能够重新触发 Cookie 保存。
      if (isLoginPage) {
        loginDetected = false
        h5WarmupDone = false
      } else if (!loginDetected && backendUrl) {
        loginDetected = true
        console.log('[PurchaseWindow] 检测到登录成功:', url)
        // 延迟5秒保存cookies（等页面JS执行完毕，H5 API请求完成）
        setTimeout(ensureH5TokenAndSave, 5000)
      }

      // 登录页自动填充账号密码（PDD禁用：程序化input事件无keyboard事件，易触发风控）
      if (isLoginPage && platform !== 'pinduoduo' && (account || password)) {
        setTimeout(() => {
          if (win.isDestroyed() || loginDetected) return
          const script = buildLoginAutoFillScript(account || '', password || '')
          if (script) {
            win.webContents.executeJavaScript(script).catch(() => {})
            console.log('[PurchaseWindow] Login auto-fill script injected, account=' + (account ? 'YES' : 'NO') + ', password=' + (password ? 'YES' : 'NO'))
          }
        }, 1000)
      }
    })

    // 监听凭证输入
    let capturedAccount = account || ''
    let capturedPassword = password || ''
    const credHandler = (event, { account: acc, password: pwd }) => {
      if (win.isDestroyed()) return
      if (win.webContents === event.sender) {
        if (acc) capturedAccount = acc
        if (pwd) capturedPassword = pwd
      }
    }
    ipcMain.on('platform-login-credentials', credHandler)

    // 窗口关闭时保存采购账号 Cookie
    // ★ 策略：先同步提取 cookie 并隐藏窗口（用户感知立即关闭），再后台异步保存+刷盘+destroy
    let isClosing = false
    win.on('close', async (event) => {
      if (isClosing) {
        event.preventDefault()
        return
      }
      isClosing = true
      event.preventDefault()

      // 立即隐藏窗口，用户感知为"已关闭"
      win.hide()

      ipcMain.removeListener('platform-login-credentials', credHandler)
      removePurchaseFillListeners()

      // 清理 session 上的 onBeforeSendHeaders 监听器（防止泄漏）
      try {
        const ses = session.fromPartition(partitionName)
        ses.webRequest.onBeforeSendHeaders(null)
      } catch (e) {}

      console.log('[PurchaseWindow] 窗口关闭，保存采购账号 accountId=', accountId)

      // 1. 提取 Cookie（同步完成，窗口已隐藏）
      let cookies = []
      let persistenceFailed = false
      try {
        const ses = session.fromPartition(partitionName)
        cookies = await ses.cookies.get({})
        console.log('[PurchaseWindow] 获取到 cookie 数量:', cookies.length)
      } catch (e) {
        console.error('[PurchaseWindow] 获取 Cookie 失败:', e.message)
      }

      // 2. 关键 cookie 缺失时延迟重读（等待 JS 异步设置）
      if (loginDetected && cookies && cookies.length > 0) {
        try {
          const criticalNames = PLATFORM_CRITICAL_COOKIES[platform] || []
          const cookieNames = new Set(cookies.map(c => c.name))
          const missing = criticalNames.filter(n => !cookieNames.has(n))
          if (missing.length > 0 && loginDetected) {
            console.warn(`[PurchaseWindow] 窗口关闭时关键 cookie 缺失: ${missing.join(', ')}，等待 3 秒后重读...`)
            await new Promise(r => setTimeout(r, 3000))
            try {
              const ses2 = session.fromPartition(partitionName)
              const retryCookies = await ses2.cookies.get({})
              if (retryCookies.length > cookies.length) {
                console.log(`[PurchaseWindow] 重读后 cookie 增加: ${cookies.length} → ${retryCookies.length}`)
                cookies = retryCookies
              }
            } catch (e) {
              console.warn('[PurchaseWindow] 重读 cookie 失败:', e.message)
            }
          }

          // 保存 Cookie 到服务器
          cookies = normalizePddCookieDomain(cookies)
          const cookieData = JSON.stringify(cookies)
          const saveResponse = await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie_data: cookieData, platform })
          })
          requireBusinessResponse(saveResponse, '保存采购账号 Cookie 失败')
          invalidateCookieRestoreCache(accountId, platform)
          console.log('[PurchaseWindow] Cookie 已保存，共', cookies.length, '条')

          if (platform === 'taobao') {
            const validationSession = session.fromPartition(partitionName)
            const validation = await validateTaobaoPurchaseAccount({ accountId, ses: validationSession })
            console.log(`[PurchaseWindow] 关闭前淘宝账号轻量校验: status=${validation.status}, reason=${validation.reason}`)
            if (validation.cookieChanged) cookies = await validationSession.cookies.get({})
          }
        } catch (e) {
          persistenceFailed = true
          console.error('[PurchaseWindow] 保存 Cookie 失败:', e.message)
        }
      }

      // 3. 只有 Cookie 已成功持久化，才允许把本次登录视为完整的新会话。
      // 保存失败时不更新捕获到的账号/密码，避免账号元数据与旧 Cookie 串用。
      const sessionReplaced = loginDetected && !persistenceFailed && cookies.length > 0
      const updateBody = { platform, session_replaced: sessionReplaced }
      if (sessionReplaced && capturedAccount) updateBody.account = capturedAccount
      if (sessionReplaced && capturedPassword) updateBody.password = capturedPassword

      try {
        const updateResponse = await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updateBody)
        })
        requireBusinessResponse(updateResponse, '更新采购账号失败')
        console.log('[PurchaseWindow] 已更新采购账号:', updateBody)
        if (sessionReplaced && (capturedAccount || capturedPassword)) {
          try {
            const credentialSaveResult = savePurchaseAccountCredential(accountId, {
              account: capturedAccount,
              password: capturedPassword,
              platform
            })
            runtimeLog.writeLog(
              'PURCHASE_LOGIN',
              `account_id=${accountId} phase=credential_vault_write result=${credentialSaveResult.success ? 'success' : 'failed'} source=successful-login account=${capturedAccount ? 'yes' : 'no'} password=${capturedPassword ? 'yes' : 'no'}${credentialSaveResult.reason ? ` reason=${String(credentialSaveResult.reason).slice(0, 120)}` : ''}`
            )
          } catch (error) {
            runtimeLog.writeLog(
              'PURCHASE_LOGIN',
              `account_id=${accountId} phase=credential_vault_write result=failed source=successful-login reason=${String(error.message || error).slice(0, 160)}`
            )
          }
        }
        // 账号身份变化会清空旧淘宝身份；更新后重新校验一次，确保最终在线状态
        // 来自当前 Cookie，而不是“保存成功”这一中间步骤。
        if (sessionReplaced && platform === 'taobao') {
          const validationSession = session.fromPartition(partitionName)
          await validateTaobaoPurchaseAccount({ accountId, ses: validationSession, force: true })
        }
      } catch (e) {
        persistenceFailed = true
        console.error('[PurchaseWindow] 更新采购账号失败:', e.message)
      }

      // 4. 仅在服务器保存成功且确实取得 Cookie 时通知前端成功
      if (mainWindow && !mainWindow.isDestroyed() && loginDetected && !persistenceFailed && cookies.length > 0) {
        mainWindow.webContents.send('purchase-account-login-success', { accountId, account: capturedAccount, platform })
      }

      purchaseWindows.delete(accountId)

      // 5. 刷盘确保 persist:partition 数据持久化到磁盘（关键！否则重启后cookie丢失）
      try {
        const purchaseSes = session.fromPartition(partitionName)
        purchaseSes.flushStorageData()
        console.log('[PurchaseWindow] Purchase partition数据已刷盘 accountId=', accountId)
      } catch (e) {
        console.error('[PurchaseWindow] Purchase partition刷盘失败:', e.message)
      }

      // 6. 所有异步操作完成后才真正销毁窗口
      win.destroy()
    })

    return { success: true }
  })

  // 关闭采购账号窗口
  ipcMain.handle('close-purchase-login-window', async (event, { accountId }) => {
    const win = purchaseWindows.get(accountId)
    if (win && !win.isDestroyed()) {
      win.close()
    }
    return { success: true }
  })

  // 从浏览器 session 刷新 cookies 到服务器数据库
  // 前端在同步之前调用此接口，确保服务器能拿到最新的 _m_h5_tk 等 token
  // 清除采购账号的 partition cookies（重新登录用）
  ipcMain.handle('clear-purchase-cookies', async (event, { accountId }) => {
    try {
      const partitionName = `persist:purchase-${accountId}`
      const ses = session.fromPartition(partitionName)
      await ses.clearStorageData({ storages: ['cookies'] })
      invalidateTaobaoAccountValidation(accountId)
      invalidateCookieRestoreCache(accountId)
      console.log(`[PurchaseWindow] 已清除账号 ${accountId} 的 cookies`)
      return { success: true }
    } catch (err) {
      console.error('[PurchaseWindow] 清除 cookies 失败:', err.message)
      return { success: false, error: err.message }
    }
  })

  async function clearPurchaseAccountSession(accountId) {
    const normalizedAccountId = String(accountId)
    const win = purchaseWindows.get(normalizedAccountId) || purchaseWindows.get(accountId)
    if (win && !win.isDestroyed()) win.destroy()
    purchaseWindows.delete(normalizedAccountId)
    purchaseWindows.delete(accountId)

    const partitionName = `persist:purchase-${normalizedAccountId}`
    const ses = session.fromPartition(partitionName)
    await ses.clearStorageData()
    ses.flushStorageData()
    invalidateTaobaoAccountValidation(normalizedAccountId)
    invalidateCookieRestoreCache(normalizedAccountId)
    console.log(`[PurchaseWindow] 已清除账号 ${normalizedAccountId} 的完整本地会话`)
    return { success: true }
  }

  ipcMain.handle('reset-purchase-account-session', async (event, { accountId }) => {
    try {
      return await clearPurchaseAccountSession(accountId)
    } catch (err) {
      console.error('[PurchaseWindow] 重置本地会话失败:', err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('save-purchase-account-credential', async (event, payload = {}) => {
    try {
      const result = savePurchaseAccountCredential(payload.accountId, {
        account: payload.account,
        password: payload.password,
        platform: payload.platform,
        serverUpdatedAt: payload.serverUpdatedAt
      })
      return result.success ? { success: true } : { success: false, error: result.reason }
    } catch (err) {
      console.error('[PurchaseWindow] 保存本机采购账号凭据失败:', err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('remove-purchase-account-session', async (event, { accountId }) => {
    let sessionError = ''
    try {
      await clearPurchaseAccountSession(accountId)
    } catch (err) {
      sessionError = err.message
      console.error('[PurchaseWindow] 删除本地会话失败:', err.message)
    }

    // 即使 Chromium 分区清理失败，也必须继续删除本机加密凭据，避免账号
    // 已从服务器删除后仍在凭据保险库中残留密码。
    try {
      const credentialResult = deletePurchaseAccountCredential(accountId)
      if (!credentialResult.success) {
        return { success: false, error: credentialResult.reason || sessionError || '删除本机登录凭据失败' }
      }
    } catch (err) {
      console.error('[PurchaseWindow] 删除本机登录凭据失败:', err.message)
      return { success: false, error: err.message }
    }

    return sessionError ? { success: false, error: sessionError } : { success: true }
  })

  ipcMain.handle('refresh-purchase-cookies', async (event, { accountId, platform }) => {
    try {
      const partitionName = `persist:purchase-${accountId}`
      const ses = session.fromPartition(partitionName)
      let cookies = await ses.cookies.get({})
      if (cookies && cookies.length > 0) {
        if (platform === 'pinduoduo') cookies = cookies.map(c => c.domain === 'mobile.yangkeduo.com' && c.hostOnly ? { ...c, domain: '.mobile.yangkeduo.com', hostOnly: false } : c)
        const saveResponse = await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookie_data: JSON.stringify(cookies), platform })
        })
        requireBusinessResponse(saveResponse, '刷新采购账号 Cookie 失败')
        invalidateCookieRestoreCache(accountId, platform)
        // 检查是否有 _m_h5_tk（淘宝 H5 API 签名所需）
        let hasH5Tk = cookies.some(c => c.name === '_m_h5_tk')
        console.log(`[PurchaseWindow] 刷新 cookies 到服务器: ${cookies.length} 条, _m_h5_tk=${hasH5Tk ? '有' : '无'}`)
        let validation = null
        if (platform === 'taobao') {
          validation = await validateTaobaoPurchaseAccount({ accountId, ses, force: true })
          if (validation.cookieChanged) {
            cookies = await ses.cookies.get({})
            hasH5Tk = cookies.some(c => c.name === '_m_h5_tk')
          }
        }
        return { success: true, count: cookies.length, hasH5Tk, validation }
      }
      return { success: true, count: 0, hasH5Tk: false }
    } catch (err) {
      console.error('[PurchaseWindow] 刷新 cookies 失败:', err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('validate-taobao-purchase-account', async (event, { accountId, force = true }) => {
    try {
      const partitionName = `persist:purchase-${accountId}`
      const ses = session.fromPartition(partitionName)
      let cookies = await ses.cookies.get({})
      let restoreAttempted = false

      // “检测”可能发生在另一台设备，本地 partition 为空不等于云端账号已失效。
      // 先恢复该采购账号的云端快照，再进行真实接口校验。
      if (!hasValidPlatformCookies(cookies, 'taobao')) {
        restoreAttempted = true
        await restoreCookiesFromServer(accountId, 'taobao', { force: true })
      }

      let validation = await validateTaobaoPurchaseAccount({ accountId, ses, force })
      if (!restoreAttempted && (validation.status === 'invalid' || validation.status === 'mismatch')) {
        // 当前设备的 Cookie 实际不可用或串号时，只从云端抢救一次；仍失败才保留
        // 最终失效/账号不符结果，避免重复使用无效 Cookie。
        restoreAttempted = true
        await restoreCookiesFromServer(accountId, 'taobao', { force: true })
        cookies = await ses.cookies.get({})
        if (hasValidPlatformCookies(cookies, 'taobao')) {
          validation = await validateTaobaoPurchaseAccount({ accountId, ses, force: true })
        }
      }
      return validation
    } catch (error) {
      runtimeLog.writeLog('TaobaoAccountCheck', `accountId=${accountId}, status=unknown, reason=ipc_error, error=${String(error.message || error).slice(0, 160)}`)
      return { status: 'unknown', reason: 'ipc_error', message: error.message }
    }
  })

  // 导出采购账号 Cookie 到文件
  ipcMain.handle('export-purchase-cookies', async (event, { accountId, accountName, platform }) => {
    try {
      const partitionName = `persist:purchase-${accountId}`
      const ses = session.fromPartition(partitionName)
      let allCookies = await ses.cookies.get({})
      let filteredCookies = filterCookiesForPlatform(allCookies, platform)

      // 当前设备可能还没有该账号的本地分区，但云端已有登录快照。导出前
      // 强制恢复一次，避免错误提示“没有 Cookie”。
      if (!hasValidPlatformCookies(filteredCookies, platform)) {
        await restoreCookiesFromServer(accountId, platform, { force: true })
        allCookies = await ses.cookies.get({})
        filteredCookies = filterCookiesForPlatform(allCookies, platform)
      }

      if (!hasValidPlatformCookies(filteredCookies, platform)) {
        return { success: false, error: `本机和云端均未找到${platform || '该平台'}的有效登录 Cookie，请先登录` }
      }

      // 生成导出内容：注释头 + JSON行格式（每行一个cookie，保留完整属性用于精确恢复）
      const lines = [
        `# Cookie Export - Account: ${accountName || accountId} - ${platform || 'unknown'}`,
        `# Exported at: ${new Date().toISOString()}`,
        `# 由店小二系统导出，可通过"导入Cookie"功能恢复`,
        `# 格式：每行一个JSON对象，包含name/value/domain/path/secure/httpOnly/sameSite/expirationDate`,
        ''
      ]
      for (const ck of filteredCookies) {
        const obj = {
          name: ck.name,
          value: ck.value,
          domain: ck.domain,
          path: ck.path || '/',
          secure: ck.secure || false,
          httpOnly: ck.httpOnly || false,
          sameSite: ck.sameSite || undefined,
          expirationDate: ck.expirationDate || undefined
        }
        lines.push(JSON.stringify(obj))
      }

      // 弹出保存文件对话框
      const result = await dialog.showSaveDialog({
        title: '导出Cookie',
        defaultPath: `${accountName || 'account'}_${platform || 'cookie'}.txt`,
        filters: [{ name: '文本文件', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }]
      })

      if (result.canceled) {
        return { success: false, error: '用户取消' }
      }

      fs.writeFileSync(result.filePath, lines.join('\n'), 'utf-8')
      console.log(`[PurchaseWindow] Cookie已导出: ${filteredCookies.length}条 → ${result.filePath}`)
      return { success: true, count: filteredCookies.length, filePath: result.filePath }
    } catch (err) {
      console.error('[PurchaseWindow] Cookie导出失败:', err.message)
      return { success: false, error: err.message }
    }
  })

  // 导入采购账号 Cookie 从文件
  ipcMain.handle('import-purchase-cookies', async (event, { accountId, platform }) => {
    try {
      // 弹出文件选择对话框
      const result = await dialog.showOpenDialog({
        title: '导入Cookie',
        filters: [{ name: '文本文件', extensions: ['txt'] }, { name: 'JSON文件', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }],
        properties: ['openFile']
      })

      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { success: false, error: '用户取消' }
      }

      const filePath = result.filePaths[0]
      const content = fs.readFileSync(filePath, 'utf-8')

      // 解析文件：支持两种格式
      // 格式1：JSON行格式（带#注释，由店小二导出功能生成）
      // 格式2：DL系统的 name=value;name2=value2 格式（纯文本）
      let cookies = []

      const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))

      if (lines.length === 0) {
        return { success: false, error: '文件为空或格式无法识别' }
      }

      // 检测格式：如果第一行以{开头，则是JSON行格式
      if (lines[0].startsWith('{')) {
        // JSON行格式
        for (const line of lines) {
          try {
            const obj = JSON.parse(line)
            if (obj.name) {
              cookies.push(obj)
            }
          } catch (e) {
            // 跳过无法解析的行
          }
        }
      } else {
        // DL系统格式：name=value;name2=value2
        const fullStr = lines.join(';')
        const pairs = fullStr.split(';').map(p => p.trim()).filter(p => p)
        const PLATFORM_DOMAINS = {
          pinduoduo: '.yangkeduo.com',
          taobao: '.taobao.com',
          '1688': '.1688.com',
          jd: '.jd.com',
          douyin: '.jinritemai.com'
        }
        const defaultDomain = PLATFORM_DOMAINS[platform] || ''

        for (const pair of pairs) {
          const eqIdx = pair.indexOf('=')
          if (eqIdx < 1) continue
          const name = pair.substring(0, eqIdx).trim()
          const value = pair.substring(eqIdx + 1).trim()
          // 跳过DL系统的内部cookie
          if (['dlUserToken', 'dlBuyID', 'dlSetReceiver', 'dlGoodsID'].includes(name)) continue
          if (name && value) {
            const isPdd = defaultDomain.includes('yangkeduo') || defaultDomain.includes('pinduoduo')
            cookies.push({
              name,
              value,
              domain: defaultDomain,
              path: '/',
              secure: isPdd,
              httpOnly: false,
              sameSite: isPdd ? 'no_restriction' : 'lax'
            })
          }
        }
      }

      if (cookies.length === 0) {
        return { success: false, error: '文件中未找到有效的Cookie数据' }
      }

      cookies = filterCookiesForPlatform(cookies, platform)
      if (cookies.length === 0) {
        return { success: false, error: `文件中没有${platform || '该平台'}域名的 Cookie` }
      }

      // 写入到partition session
      const partitionName = `persist:purchase-${accountId}`
      const ses = session.fromPartition(partitionName)

      let setOk = 0, setFail = 0
      for (const ck of cookies) {
        try {
          const sameSite = ck.sameSite || undefined
          const secure = sameSite === 'no_restriction' ? true : (ck.secure || false)
          const domain = ck.domain || ''
          const url = (secure ? 'https://' : 'http://') + domain.replace(/^\./, '') + (ck.path || '/')
          await ses.cookies.set({
            url,
            name: ck.name,
            value: ck.value || '',
            domain,
            path: ck.path || '/',
            secure,
            httpOnly: ck.httpOnly || false,
            expirationDate: ck.expirationDate || undefined,
            sameSite
          })
          setOk++
        } catch (e2) {
          setFail++
          console.warn(`[PurchaseWindow] Cookie导入失败: ${ck.name} domain=${ck.domain} err=${e2.message}`)
        }
      }

      // 刷盘确保持久化（5秒超时防止卡死）
      ses.flushStorageData()

      // 同步保存到服务器数据库
      try {
        let allCookies = await ses.cookies.get({})
        if (allCookies.length > 0) {
          // PDD domain 规范化
          if (platform === 'pinduoduo') allCookies = allCookies.map(c => c.domain === 'mobile.yangkeduo.com' && c.hostOnly ? { ...c, domain: '.mobile.yangkeduo.com', hostOnly: false } : c)
          const saveResponse = await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie_data: JSON.stringify(allCookies), platform })
          })
          requireBusinessResponse(saveResponse, '导入 Cookie 后同步服务器失败')
          invalidateCookieRestoreCache(accountId, platform)
          console.log(`[PurchaseWindow] Cookie已同步到服务器: ${allCookies.length}条`)
          if (platform === 'taobao') {
            const validation = await validateTaobaoPurchaseAccount({ accountId, ses, force: true })
            console.log(`[PurchaseWindow] 导入后淘宝账号轻量校验: status=${validation.status}, reason=${validation.reason}`)
          }
        }
      } catch (e) {
        console.warn('[PurchaseWindow] Cookie同步到服务器失败:', e.message)
        return { success: false, error: e.message, count: setOk, failed: setFail }
      }

      console.log(`[PurchaseWindow] Cookie已导入: ${setOk}成功, ${setFail}失败`)
      return { success: true, count: setOk, failed: setFail }
    } catch (err) {
      console.error('[PurchaseWindow] Cookie导入失败:', err.message)
      return { success: false, error: err.message }
    }
  })
}

module.exports = { registerPlatformWindowIpc, registerPurchaseAccountIpc, platformWindows }
