const { BrowserWindow, ipcMain, session } = require('electron')
const path = require('path')
const http = require('http')
const https = require('https')

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
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 10000
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
      const isBackend = (currentUrl.includes('shop.jd.com') || currentUrl.includes('sz.jd.com') ||
        currentUrl.includes('jd.com/index')) &&
        !currentUrl.includes('passport') && !currentUrl.includes('login')

      if (isBackend) {
        setTimeout(() => {
          if (win.isDestroyed()) return
          win.webContents.executeJavaScript(`
            (function() {
              var info = {};
              var debugLog = [];
              try {
                // === 店铺名提取 ===
                // 1. 从 document.title 提取
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
                // 2. 从 DOM 提取店铺名
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
                // 策略：从同一数据源同时找到 venderId+shopId 才采用，避免错配

                // 3. 扫描内嵌 <script>，找包含 BOTH venderId 和 shopId 的块（最可靠）
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

                // 4. 从全局变量找配对数据
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
                        // 同一对象中同时找到两个值，优先采用
                        if (gvm && gsm) {
                          info.venderId = gvm[1];
                          info.shopId = gsm[1];
                          debugLog.push('paired from ' + globalKeys[k] + ': venderId=' + gvm[1] + ' shopId=' + gsm[1]);
                          break;
                        }
                        // 只找到一个，补充缺失的
                        if (!info.venderId && gvm) { info.venderId = gvm[1]; debugLog.push('venderId from ' + globalKeys[k]); }
                        if (!info.shopId && gsm) { info.shopId = gsm[1]; debugLog.push('shopId from ' + globalKeys[k]); }
                        if (!info.storeName && obj.shopName) info.storeName = obj.shopName;
                      }
                    } catch(e3) {}
                  }
                }

                // 5. 直接 window 属性
                if (!info.venderId && window.venderId) { info.venderId = String(window.venderId); debugLog.push('venderId from window.venderId'); }
                if (!info.shopId && window.shopId) { info.shopId = String(window.shopId); debugLog.push('shopId from window.shopId'); }

                // 6. 如果仍缺少，从内嵌 script 单独提取（降级方案）
                if (!info.venderId || !info.shopId) {
                  for (var s2 = 0; s2 < scripts.length; s2++) {
                    var txt2 = scripts[s2].textContent || '';
                    if (txt2.length < 20 || txt2.length > 500000) continue;
                    if (!info.venderId) {
                      var vm3 = txt2.match(/venderId['"\\s:=]+(\\d{5,})/);
                      if (vm3) { info.venderId = vm3[1]; debugLog.push('venderId fallback from script#' + s2); }
                    }
                    if (!info.shopId) {
                      var sm3 = txt2.match(/shopId['"\\s:=]+(\\d{5,})/);
                      if (sm3) { info.shopId = sm3[1]; debugLog.push('shopId fallback from script#' + s2); }
                    }
                    if (info.venderId && info.shopId) break;
                  }
                }

                // 7. URL 参数
                if (!info.venderId || !info.shopId) {
                  var urlParams = new URLSearchParams(window.location.search);
                  if (!info.venderId) {
                    var uv = urlParams.get('venderId') || urlParams.get('venderid') || urlParams.get('vender_id');
                    if (uv) { info.venderId = uv; debugLog.push('venderId from URL param'); }
                  }
                  if (!info.shopId) {
                    var us = urlParams.get('shopId') || urlParams.get('shopid') || urlParams.get('shop_id');
                    if (us) { info.shopId = us; debugLog.push('shopId from URL param'); }
                  }
                }

                // 8. localStorage / sessionStorage（找配对）
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
          `).then(info => {
            if (info) {
              console.log('[PlatformWindow] 页面提取 debug:', info._debug || 'none')
              delete info._debug
              if (Object.keys(info).length > 0) {
                const prev = storeExtractedInfo.get(storeId) || {}
                storeExtractedInfo.set(storeId, { ...prev, ...info })
                console.log('[PlatformWindow] 页面提取到商家信息:', info)
              }
            }
          }).catch((err) => { console.log('[PlatformWindow] executeJS 失败:', err.message) })
        }, 3000)
      }
    })

    // 窗口关闭时自动保存 Cookie 和店铺信息
    win.on('closed', async () => {
      const plat = storePlatforms.get(storeId)
      const cred = storeCredentials.get(storeId) || {}

      console.log('[PlatformWindow] 窗口关闭，保存信息 storeId=', storeId, 'account=', cred.account)

      if (plat) {
        await saveStoreInfo(mainWindow, storeId, plat, cred.account, cred.password)
      }

      platformWindows.delete(storeId)
      storePlatforms.delete(storeId)
      storeCredentials.delete(storeId)
      storeExtractedInfo.delete(storeId)
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
    const partitionName = `persist:platform-${storeId}`
    const ses = session.fromPartition(partitionName)
    const cookies = await ses.cookies.get({})

    console.log('[PlatformWindow] 获取到 cookie 数量:', cookies ? cookies.length : 0)

    if (cookies && cookies.length > 0) {
      const cookieData = JSON.stringify(cookies)

      await httpRequest(`${BUSINESS_SERVER}/api/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_id: storeId, cookie_data: cookieData, domain: platform })
      })
      console.log('[PlatformWindow] Cookie 已保存，共', cookies.length, '条')
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
      await httpRequest(`${BUSINESS_SERVER}/api/stores/${storeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateBody)
      })
      console.log('[PlatformWindow] 已更新店铺信息:', updateBody)
    }

    // 5. 更新在线状态
    await httpRequest(`${BUSINESS_SERVER}/api/stores/${storeId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ online: true })
    })

    // 6. 通知主窗口刷新列表
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('platform-login-success', { storeId, account })
    }

    console.log('[PlatformWindow] 保存完成 storeId=', storeId)
  } catch (err) {
    console.error('[PlatformWindow] 保存失败:', err.message)
  }
}

module.exports = { registerPlatformWindowIpc, platformWindows }
