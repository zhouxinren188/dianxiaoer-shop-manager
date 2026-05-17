const { BrowserWindow, ipcMain, session, dialog, app } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const { getAuthToken } = require('./auth-store')
const { resolveAppPath } = require('./hot-updater')

const BUSINESS_SERVER = 'http://150.158.54.108:3002'

// 平台后台 URL 映射
const PLATFORM_URLS = {
  taobao: 'https://myseller.taobao.com/',
  tmall: 'https://myseller.taobao.com/',
  jd: 'https://shop.jd.com/',
  pdd: 'https://mms.pinduoduo.com/',
  douyin: 'https://fxg.jinritemai.com/'
}

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

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const urlObj = new URL(url)

    // 自动附带 auth token
    const headers = { ...options.headers }
    const token = getAuthToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    } else {
      console.warn('[PlatformWindow] httpRequest: 主进程没有 auth token! 请求可能被 401 拒绝. URL:', url)
    }

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers,
      timeout: 10000,
      rejectUnauthorized: false
    }

    const req = mod.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, data }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
    if (options.body) req.write(options.body)
    req.end()
  })
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
    if (type === 'password' || type === 'hidden' || type === 'submit' || type === 'checkbox' || type === 'radio') return false;
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

  // 判断是否为后台 URL（排除登录页）
  function isBackendUrl(url) {
    return (url.includes('shop.jd.com') || url.includes('sz.jd.com') ||
      url.includes('jd.com/index')) &&
      !url.includes('passport') && !url.includes('login')
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
            console.log('[PlatformWindow] 提取成功，执行保存')
            const cred = storeCredentials.get(sid) || {}
            
            // 保存店铺信息
            saveStoreInfo(mw, sid, plat, cred.account, cred.password).then(() => {
              // 3秒后自动关闭平台窗口
              setTimeout(() => {
                if (!win.isDestroyed()) {
                  console.log('[PlatformWindow] 3秒后自动关闭平台窗口')
                  win._saveDone = true
                  win.close()
                }
              }, 3000)
            }).catch(err => {
              console.error('[PlatformWindow] 保存失败:', err.message)
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

  // 打开平台登录窗口
  ipcMain.handle('open-platform-window', async (event, { storeId, platform, keepCookie, account, password }) => {
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

    const partitionName = `persist:platform-${storeId}`

    // keepCookie=true（登录按钮）保留已有 cookie；否则（新增店铺）清除
    if (!keepCookie) {
      const ses = session.fromPartition(partitionName)
      await ses.clearStorageData({ storages: ['cookies'] })
    }

    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      title: `店铺登录 - ${platform}`,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: partitionName,
        preload: preloadPath
      }
    })

    win.loadURL(targetUrl)

    // 确保平台窗口在最前面，防止被主窗口遮挡
    win.once('ready-to-show', () => {
      win.focus()
    })
    // 延迟再聚焦一次，防止主窗口的 ElMessage/router 操作抢焦点
    setTimeout(() => {
      if (!win.isDestroyed()) win.focus()
    }, 500)

    platformWindows.set(storeId, win)
    storePlatforms.set(storeId, platform)
    storeCredentials.delete(storeId)
    storeExtractedInfo.delete(storeId)

    // 暂存登录凭证
    if (account || password) {
      storeCredentials.set(storeId, { account: account || '', password: password || '' })
    }

    // 页面加载完成后：自动填充凭证 + 提取商家信息
    win.webContents.on('did-finish-load', () => {
      if (win.isDestroyed()) return
      const currentUrl = win.webContents.getURL()

      // 1. 自动填充登录凭证（如果有）
      const cred = storeCredentials.get(storeId)
      if (cred && (cred.account || cred.password)) {
        win.webContents.send('fill-credentials', { account: cred.account || '', password: cred.password || '' })
      }

      // 2. 在后台页面提取商家信息（排除登录页）
      const isBackend = isBackendUrl(currentUrl)

      if (isBackend) {
        console.log('[PlatformWindow] 检测到后台页面:', currentUrl)
        // 启动重试提取机制（3s, 6s, 9s, 12s）
        startExtractionRetry(win, storeId, mainWindow, platform)
      }
    })

    // 窗口关闭前保存 Cookie 和店铺信息
    // 使用 e.preventDefault() 阻止窗口在异步保存完成前被销毁
    win.on('close', (e) => {
      // 只执行一次
      if (win._saveDone) return
      win._saveDone = true

      e.preventDefault() // 阻止窗口立即关闭

      const plat = storePlatforms.get(storeId)
      const cred = storeCredentials.get(storeId) || {}
      const extracted = storeExtractedInfo.get(storeId) || {}

      console.log('[PlatformWindow] 窗口关闭，检查店铺信息 storeId=', storeId)

      const doSaveAndDestroy = async () => {
        // 检查是否获取到了关键信息（venderId 或 shopId）
        const hasKeyInfo = extracted.venderId || extracted.shopId

        if (!hasKeyInfo && plat) {
          // 未获取到关键信息，删除空白店铺卡片
          console.log('[PlatformWindow] 未获取到店铺信息，删除空白店铺 storeId=', storeId)
          try {
            await httpRequest(`${BUSINESS_SERVER}/api/stores/${storeId}`, {
              method: 'DELETE'
            })
            console.log('[PlatformWindow] 空白店铺已删除 storeId=', storeId)
          } catch (err) {
            console.error('[PlatformWindow] 删除空白店铺失败:', err.message)
          }
          // 通知前端刷新列表（storeId=null 表示删除而非更新）
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('platform-login-success', { storeId: null })
          }
        } else if (plat) {
          // 有关键信息，正常保存
          try {
            await saveStoreInfo(mainWindow, storeId, plat, cred.account, cred.password)
          } catch (err) {
            console.error('[PlatformWindow] 保存失败:', err.message)
            // 即使保存失败也通知界面刷新
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('platform-login-success', { storeId, account: cred.account })
            }
          }
        }

        platformWindows.delete(storeId)
        storePlatforms.delete(storeId)
        storeCredentials.delete(storeId)
        storeExtractedInfo.delete(storeId)

        // 销毁窗口前先刷盘，确保 session 数据（Cookie等）持久化到磁盘
        // 避免 win.destroy() 后内存中 session 数据丢失导致心跳检测不到 Cookie
        try {
          const ses = session.fromPartition(`persist:platform-${storeId}`)
          // 刷盘持久化（5秒超时防止卡死）
          await Promise.race([
            new Promise(resolve => ses.flushStorageData(resolve)),
            new Promise(resolve => setTimeout(resolve, 5000))
          ])
          console.log('[PlatformWindow] Session数据已刷盘 storeId=', storeId)
        } catch (e) {
          console.error('[PlatformWindow] Session刷盘失败:', e.message)
        }

        // 保存/删除完成后真正销毁窗口
        win.destroy()
      }

      doSaveAndDestroy()
    })

    return { success: true }
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

    const cred = storeCredentials.get(storeId) || {}
    await saveStoreInfo(mainWindow, storeId, platform, cred.account, cred.password)

    win.close()
    return { success: true }
  })

  // 关闭平台窗口
  ipcMain.handle('close-platform-window', async (event, { storeId }) => {
    const win = platformWindows.get(storeId)
    if (win && !win.isDestroyed()) {
      win.close() // close 触发 closed 事件，会自动保存
    }
    return { success: true }
  })
}

// 保存店铺信息：Cookie + 账号密码 + 商家信息 + 在线状态
async function saveStoreInfo(mainWindow, storeId, platform, account, password) {

  try {
    // 1. 提取 Cookie（获取 session 中所有 cookie，不限定域名）
    let cookies = []
    try {
      const partitionName = `persist:platform-${storeId}`
      const ses = session.fromPartition(partitionName)
      cookies = await ses.cookies.get({})
      console.log('[PlatformWindow] 获取到 cookie 数量:', cookies ? cookies.length : 0)
    } catch (e) {
      console.error('[PlatformWindow] 获取 Cookie 失败:', e.message)
    }

    if (cookies && cookies.length > 0) {
      try {
        const cookieData = JSON.stringify(cookies)
        const cookieRes = await httpRequest(`${BUSINESS_SERVER}/api/cookies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ store_id: storeId, cookie_data: cookieData, domain: platform })
        })
        if (cookieRes.statusCode >= 400) {
          console.error('[PlatformWindow] 保存 Cookie 服务端拒绝:', cookieRes.statusCode, cookieRes.data)
        } else {
          console.log('[PlatformWindow] Cookie 已保存，共', cookies.length, '条')
        }
      } catch (e) {
        console.error('[PlatformWindow] 保存 Cookie 失败:', e.message)
      }
    }

    // 2. 从 Cookie 中提取商家信息（仅精确匹配 cookie 名称）
    let cookieMerchantId = ''
    let cookieShopId = ''
    let pinName = ''
    if (cookies && cookies.length > 0) {
      // 打印所有 cookie 名称用于调试
      const cookieNames = cookies.map(c => `${c.name}=${c.value}`).filter(s => s.length < 80).join('; ')
      console.log('[PlatformWindow] Cookie 列表(部分):', cookieNames.substring(0, 1000))

      for (const cookie of cookies) {
        const name = cookie.name
        const nameLow = name.toLowerCase()
        const val = cookie.value || ''
        if (!val) continue

        // 商家ID：只精确匹配已知的 cookie 名
        if (!cookieMerchantId && (name === 'venderId' || nameLow === 'venderid' || nameLow === 'merchant_id')) {
          cookieMerchantId = val
          console.log('[PlatformWindow] Cookie 精确匹配 merchantId:', name, '=', val)
        }
        // 店铺ID：只精确匹配已知的 cookie 名
        if (!cookieShopId && (name === 'shopId' || nameLow === 'shopid' || nameLow === 'shop_id')) {
          cookieShopId = val
          console.log('[PlatformWindow] Cookie 精确匹配 shopId:', name, '=', val)
        }
        // 用户 pin
        if (!pinName && nameLow === 'pin') {
          try { pinName = decodeURIComponent(val) } catch (e) { pinName = val }
        }
      }

      console.log('[PlatformWindow] Cookie 提取结果: merchantId=', cookieMerchantId, 'shopId=', cookieShopId, 'pin=', pinName)
    }

    // 3. 合并页面提取的信息（页面提取优先，cookie 提取作为补充）
    const extracted = storeExtractedInfo.get(storeId) || {}
    console.log('[PlatformWindow] 页面提取结果:', extracted)

    // 页面提取优先级高于 cookie（页面脚本中的 venderId/shopId 更准确）
    const merchantId = extracted.venderId || cookieMerchantId
    const shopId = extracted.shopId || cookieShopId

    // 4. 更新店铺信息（账号、密码、商家ID、店铺ID、店铺名）
    const updateBody = {}
    if (account) updateBody.account = account
    if (password) updateBody.password = password
    if (merchantId) updateBody.merchant_id = merchantId
    if (shopId) updateBody.shop_id = shopId
    if (extracted.storeName) updateBody.name = extracted.storeName
    // 如果没有从输入框捕获到账号但 cookie 有 pin，用 pin 作为账号
    if (!account && pinName) updateBody.account = pinName

    // 提升到外层作用域，以便 catch 块也能访问
    let targetStoreId = storeId

    if (Object.keys(updateBody).length > 0) {
      try {
        // 检查是否有 merchant_id 重复，如果有则更新已有店铺并删除新店铺
        let shouldDeleteNewStore = false

        if (merchantId) {
          try {
            const checkRes = await httpRequest(`${BUSINESS_SERVER}/api/stores?merchant_id=${encodeURIComponent(merchantId)}`, {
              method: 'GET'
            })
            if (checkRes.statusCode === 200) {
              const checkResult = JSON.parse(checkRes.data)
              if (checkResult.code === 0 && checkResult.data && checkResult.data.list && checkResult.data.list.length > 0) {
                const existingStore = checkResult.data.list[0]
                if (String(existingStore.id) !== String(storeId)) {
                  // 发现重复的 merchant_id，使用已存在的店铺
                  console.log(`[PlatformWindow] 发现重复 merchant_id=${merchantId}，已存在店铺 id=${existingStore.id}，将更新该店铺并删除新店铺 id=${storeId}`)
                  targetStoreId = existingStore.id
                  shouldDeleteNewStore = true
                }
              }
            }
          } catch (checkErr) {
            console.error('[PlatformWindow] 检查 merchant_id 重复失败:', checkErr.message)
          }
        }

        // 更新目标店铺（可能是已存在的，也可能是当前的）
        const updateRes = await httpRequest(`${BUSINESS_SERVER}/api/stores/${targetStoreId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updateBody)
        })
        if (updateRes.statusCode >= 400) {
          console.error('[PlatformWindow] 更新店铺信息服务端拒绝:', updateRes.statusCode, updateRes.data)
        } else {
          console.log(`[PlatformWindow] 已更新店铺信息 (storeId=${targetStoreId}):`, updateBody)
        }

        // 如果是重复店铺，删除新创建的空白店铺
        if (shouldDeleteNewStore) {
          try {
            const deleteRes = await httpRequest(`${BUSINESS_SERVER}/api/stores/${storeId}`, {
              method: 'DELETE'
            })
            if (deleteRes.statusCode === 200) {
              console.log(`[PlatformWindow] 已删除重复的新店铺 id=${storeId}`)
            }
          } catch (deleteErr) {
            console.error('[PlatformWindow] 删除重复店铺失败:', deleteErr.message)
          }
        }

        // 5. 更新在线状态
        try {
          const statusRes = await httpRequest(`${BUSINESS_SERVER}/api/stores/${targetStoreId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ online: true })
          })
          if (statusRes.statusCode >= 400) {
            console.error('[PlatformWindow] 更新在线状态服务端拒绝:', statusRes.statusCode, statusRes.data)
          }
        } catch (e) {
          console.error('[PlatformWindow] 更新在线状态失败:', e.message)
        }

        // 6. 通知前端刷新列表
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('platform-login-success', { storeId: targetStoreId, account })
        }
      } catch (e) {
        console.error('[PlatformWindow] 更新店铺信息失败:', e.message)
      }
    } else {
      console.log('[PlatformWindow] 无可更新的店铺信息字段 (updateBody 为空)')
    }
  } catch (err) {
    console.error('[PlatformWindow] 保存失败:', err.message)
    // 即使保存失败，也通知界面刷新
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('platform-login-success', { storeId: targetStoreId, account })
    }
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
          const serverCookies = raw.filter(ck => {
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
          ses.flushStorageData(() => {
            console.log(`[PurchaseWindow] 后台刷盘完成, accountId=${accountId}`)
          })
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

  // 打开采购账号登录窗口
  ipcMain.handle('open-purchase-login-window', async (event, { accountId, platform, account, password }) => {
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

    // 新账号清除旧 cookie
    if (!account) {
      const ses = session.fromPartition(partitionName)
      await ses.clearStorageData({ storages: ['cookies'] })
    }

    const win = new BrowserWindow({
      width: 1100,
      height: 750,
      title: `采购账号登录 - ${platform}`,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: partitionName,
        preload: preloadPath
      }
    })

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
          const hasH5Tk = cookies.some(c => c.name === '_m_h5_tk')
          await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie_data: JSON.stringify(cookies), platform })
          })
          console.log(`[PurchaseWindow] Cookies 已保存: ${cookies.length} 条, _m_h5_tk=${hasH5Tk ? '有' : '无'}`)

          // 验证关键 cookie 是否齐全
          const criticalNames = PLATFORM_CRITICAL_COOKIES[platform] || []
          const cookieNames = new Set(cookies.map(c => c.name))
          const missing = criticalNames.filter(n => !cookieNames.has(n))
          if (missing.length > 0) {
            console.warn(`[PurchaseWindow] 关键 cookie 缺失: ${missing.join(', ')}，将在 8 秒后重试保存`)
            return { count: cookies.length, hasH5Tk, missingCritical: missing }
          }

          return { count: cookies.length, hasH5Tk }
        }
        return { count: 0, hasH5Tk: false }
      } catch (err) {
        console.error('[PurchaseWindow] Cookies 保存失败:', err.message)
        return null
      }
    }

    // 淘宝账号需要 _m_h5_tk：如果没有则导航到已买到的商品页面来获取
    // PDD 账号如果关键 cookie 缺失，延迟重试等待 JS 异步设置 cookie
    async function ensureH5TokenAndSave() {
      if (win.isDestroyed() || h5WarmupDone) return
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
          if (result2 && result2.hasH5Tk) {
            console.log('[PurchaseWindow] _m_h5_tk 已获取并保存')
          } else {
            console.warn('[PurchaseWindow] 导航后仍未获取到 _m_h5_tk')
          }
        }, 8000)
      }
    }

    win.webContents.on('did-navigate', (e, url) => {
      if (loginDetected) return
      const backendUrl = PURCHASE_BACKEND_URLS[platform] || ''
      // 如果导航到了非登录页面（后台页面），视为登录成功
      const isLoginPage = url.includes('login') || url.includes('passport') || url.includes('sign')
      if (!isLoginPage && backendUrl) {
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
    // ★ 关键修复：必须 event.preventDefault() 防止窗口在异步保存完成前被销毁
    win.on('close', async (event) => {
      if (win._purchaseSaveDone) return
      event.preventDefault()  // 阻止立即关闭，等异步保存完成后再 destroy
      win._purchaseSaveDone = true

      ipcMain.removeListener('platform-login-credentials', credHandler)

      // 清理 session 上的 onBeforeSendHeaders 监听器（防止泄漏）
      try {
        const ses = session.fromPartition(partitionName)
        ses.webRequest.onBeforeSendHeaders(null)
      } catch (e) {}

      console.log('[PurchaseWindow] 窗口关闭，保存采购账号 accountId=', accountId)

      // 1. 提取 Cookie
      let cookies = []
      try {
        const ses = session.fromPartition(partitionName)
        cookies = await ses.cookies.get({})
        console.log('[PurchaseWindow] 获取到 cookie 数量:', cookies.length)
      } catch (e) {
        console.error('[PurchaseWindow] 获取 Cookie 失败:', e.message)
      }

      // 2. 保存 Cookie 到服务器
      if (cookies && cookies.length > 0) {
        try {
          // 验证关键 cookie 是否齐全，缺失则等待 3 秒后重读（等待 JS 异步设置）
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
              const retryNames = new Set(retryCookies.map(c => c.name))
              const stillMissing = criticalNames.filter(n => !retryNames.has(n))
              if (stillMissing.length < missing.length) {
                console.log(`[PurchaseWindow] 重读后关键 cookie 补回: ${missing.filter(n => retryNames.has(n)).join(', ')}`)
              }
            } catch (e) {
              console.warn('[PurchaseWindow] 重读 cookie 失败:', e.message)
            }
          }

          cookies = normalizePddCookieDomain(cookies)
          const cookieData = JSON.stringify(cookies)
          await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie_data: cookieData, platform })
          })
          console.log('[PurchaseWindow] Cookie 已保存，共', cookies.length, '条')
        } catch (e) {
          console.error('[PurchaseWindow] 保存 Cookie 失败:', e.message)
        }
      }

      // 3. 更新账号信息
      const updateBody = { platform }
      if (capturedAccount) updateBody.account = capturedAccount
      if (capturedPassword) updateBody.password = capturedPassword
      if (loginDetected || (cookies && cookies.length > 0)) {
        updateBody.online = true
      }

      try {
        await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updateBody)
        })
        console.log('[PurchaseWindow] 已更新采购账号:', updateBody)
      } catch (e) {
        console.error('[PurchaseWindow] 更新采购账号失败:', e.message)
      }

      // 4. 通知前端刷新
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('purchase-account-login-success', { accountId, account: capturedAccount, platform })
      }

      purchaseWindows.delete(accountId)

      // 5. 刷盘确保 persist:partition 数据持久化到磁盘（关键！否则重启后cookie丢失）
      // 5秒超时防止卡死
      try {
        const purchaseSes = session.fromPartition(partitionName)
        await Promise.race([
          new Promise(resolve => purchaseSes.flushStorageData(resolve)),
          new Promise(resolve => setTimeout(resolve, 5000))
        ])
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
      console.log(`[PurchaseWindow] 已清除账号 ${accountId} 的 cookies`)
      return { success: true }
    } catch (err) {
      console.error('[PurchaseWindow] 清除 cookies 失败:', err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('refresh-purchase-cookies', async (event, { accountId, platform }) => {
    try {
      const partitionName = `persist:purchase-${accountId}`
      const ses = session.fromPartition(partitionName)
      let cookies = await ses.cookies.get({})
      if (cookies && cookies.length > 0) {
        if (platform === 'pinduoduo') cookies = cookies.map(c => c.domain === 'mobile.yangkeduo.com' && c.hostOnly ? { ...c, domain: '.mobile.yangkeduo.com', hostOnly: false } : c)
        await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cookie_data: JSON.stringify(cookies), platform })
        })
        // 检查是否有 _m_h5_tk（淘宝 H5 API 签名所需）
        const hasH5Tk = cookies.some(c => c.name === '_m_h5_tk')
        console.log(`[PurchaseWindow] 刷新 cookies 到服务器: ${cookies.length} 条, _m_h5_tk=${hasH5Tk ? '有' : '无'}`)
        return { success: true, count: cookies.length, hasH5Tk }
      }
      return { success: true, count: 0, hasH5Tk: false }
    } catch (err) {
      console.error('[PurchaseWindow] 刷新 cookies 失败:', err.message)
      return { success: false, error: err.message }
    }
  })

  // 导出采购账号 Cookie 到文件
  ipcMain.handle('export-purchase-cookies', async (event, { accountId, accountName, platform }) => {
    try {
      const partitionName = `persist:purchase-${accountId}`
      const ses = session.fromPartition(partitionName)
      const allCookies = await ses.cookies.get({})

      if (!allCookies || allCookies.length === 0) {
        return { success: false, error: '该账号没有Cookie，请先登录' }
      }

      // 按平台过滤Cookie
      const PLATFORM_DOMAINS = {
        pinduoduo: ['pinduoduo.com', 'yangkeduo.com', 'pdd.net'],
        taobao: ['taobao.com', 'tmall.com', 'alibaba.com'],
        '1688': ['1688.com', 'alibaba.com'],
        jd: ['jd.com', 'jd.hk'],
        douyin: ['jinritemai.com', 'douyin.com']
      }
      const domains = PLATFORM_DOMAINS[platform] || []
      const filteredCookies = domains.length > 0
        ? allCookies.filter(c => c.domain && domains.some(d => c.domain.includes(d)))
        : allCookies

      if (filteredCookies.length === 0) {
        return { success: false, error: `未找到${platform || '该平台'}的Cookie，请先登录` }
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
      await Promise.race([
        new Promise(resolve => ses.flushStorageData(resolve)),
        new Promise(resolve => setTimeout(resolve, 5000))
      ])

      // 同步保存到服务器数据库
      try {
        let allCookies = await ses.cookies.get({})
        if (allCookies.length > 0) {
          // PDD domain 规范化
          if (platform === 'pinduoduo') allCookies = allCookies.map(c => c.domain === 'mobile.yangkeduo.com' && c.hostOnly ? { ...c, domain: '.mobile.yangkeduo.com', hostOnly: false } : c)
          await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie_data: JSON.stringify(allCookies), platform })
          })
          console.log(`[PurchaseWindow] Cookie已同步到服务器: ${allCookies.length}条`)
        }
      } catch (e) {
        console.warn('[PurchaseWindow] Cookie同步到服务器失败:', e.message)
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
