const { BrowserWindow, ipcMain, session } = require('electron')
const path = require('path')
const http = require('http')
const https = require('https')
const { getAuthToken } = require('./auth-store')

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

function registerPlatformWindowIpc(mainWindow) {
  const preloadPath = path.join(__dirname, '../../resources/platform-login-preload.js')
  console.log('[PlatformWindow] preload path:', preloadPath)

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
            console.log('[PlatformWindow] 提取成功，执行保存并3秒后自动关闭窗口')
            const cred = storeCredentials.get(sid) || {}
            
            // 保存店铺信息
            saveStoreInfo(mw, sid, plat, cred.account, cred.password).then(() => {
              // 保存成功后，3秒后自动关闭窗口
              setTimeout(() => {
                if (!win.isDestroyed()) {
                  console.log('[PlatformWindow] 信息已保存，3秒后自动关闭窗口')
                  win._saveDone = true // 标记已保存，避免close事件再次保存
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

    if (Object.keys(updateBody).length > 0) {
      try {
        // 如果有 merchant_id，先检查是否已存在于其他店铺
        let targetStoreId = storeId
        if (merchantId) {
          try {
            const checkRes = await httpRequest(`${BUSINESS_SERVER}/api/stores?merchant_id=${merchantId}`, {
              method: 'GET'
            })
            const checkJson = JSON.parse(checkRes.data)
            if (checkJson.code === 0 && checkJson.data && checkJson.data.list && checkJson.data.list.length > 0) {
              // 检查是否是不同的店铺
              const existingStore = checkJson.data.list.find(s => s.id !== storeId)
              if (existingStore) {
                console.log(`[PlatformWindow] 发现重复 merchant_id=${merchantId}，更新原有店铺 ${existingStore.id} 而不是 ${storeId}`)
                targetStoreId = existingStore.id
              }
            }
          } catch (e) {
            console.warn('[PlatformWindow] 检查重复店铺失败:', e.message)
          }
        }
        
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
      } catch (e) {
        console.error('[PlatformWindow] 更新店铺信息失败:', e.message)
      }
    } else {
      console.log('[PlatformWindow] 无可更新的店铺信息字段 (updateBody 为空)')
    }

    // 5. 更新在线状态
    try {
      const statusRes = await httpRequest(`${BUSINESS_SERVER}/api/stores/${storeId}/status`, {
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

    // 6. 通知主窗口刷新列表（无论前面是否出错，都要通知刷新）
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('platform-login-success', { storeId, account })
    }

    console.log('[PlatformWindow] 保存完成 storeId=', storeId)
  } catch (err) {
    console.error('[PlatformWindow] 保存失败:', err.message)
    // 即使保存失败，也通知界面刷新
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('platform-login-success', { storeId, account })
    }
  }
}

// ==================== 采购账号登录窗口 ====================

// 采购平台登录 URL
const PURCHASE_LOGIN_URLS = {
  taobao: 'https://login.taobao.com/member/login.jhtml',
  pinduoduo: 'https://mobile.pinduoduo.com/login.html',
  douyin: 'https://www.douyin.com/login'
}

// 采购平台后台 URL（用于登录成功检测）
const PURCHASE_BACKEND_URLS = {
  taobao: 'https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm',
  pinduoduo: 'https://mobile.pinduoduo.com/personal.html',
  douyin: 'https://www.douyin.com/'
}

// 已打开的采购账号窗口 Map<accountId, BrowserWindow>
const purchaseWindows = new Map()

function registerPurchaseAccountIpc(mainWindow) {
  const preloadPath = path.join(__dirname, '../../resources/platform-login-preload.js')

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

    win.loadURL(loginUrl)

    win.once('ready-to-show', () => { win.focus() })
    setTimeout(() => { if (!win.isDestroyed()) win.focus() }, 500)

    purchaseWindows.set(accountId, win)

    // 登录成功检测：延迟确认策略
    let loginDetected = false
    win.webContents.on('did-navigate', (e, url) => {
      if (loginDetected) return
      const backendUrl = PURCHASE_BACKEND_URLS[platform] || ''
      // 如果导航到了非登录页面（后台页面），视为登录成功
      const isLoginPage = url.includes('login') || url.includes('passport') || url.includes('sign')
      if (!isLoginPage && backendUrl) {
        loginDetected = true
        console.log('[PurchaseWindow] 检测到登录成功:', url)
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
    win.on('close', async () => {
      if (win._purchaseSaveDone) return
      win._purchaseSaveDone = true

      ipcMain.removeListener('platform-login-credentials', credHandler)

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
          const cookieData = JSON.stringify(cookies)
          await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookie`, {
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
}

module.exports = { registerPlatformWindowIpc, registerPurchaseAccountIpc, platformWindows }
