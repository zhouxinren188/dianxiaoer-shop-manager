// 注意：不再全局禁用 TLS 证书验证（process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'）
// 改为仅对特定自签名服务器在请求级别设置 rejectUnauthorized: false

const { app, BrowserWindow, Menu, session, ipcMain } = require('electron')
const path = require('path')

// 防止 EPIPE broken pipe 错误弹窗（stdout/stderr 管道断开时忽略）
process.stdout?.on?.('error', () => {})
process.stderr?.on?.('error', () => {})
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.message?.includes('EPIPE')) return
  console.error('[UncaughtException]', err)
})

const { getHotUpdateRendererPath, getCurrentVersion, clearHotUpdate } = require('./hot-updater')
const { initUpdateManager } = require('./update-manager')
const { registerPlatformWindowIpc, registerPurchaseAccountIpc } = require('./platform-window')
const { registerPurchaseOrderCaptureIpc } = require('./purchase-order-capture')
const { registerPurchaseOrderSyncIpc } = require('./purchase-order-sync')
const { registerPacketCaptureIpc } = require('./packet-capture')
const { registerSupplyOrderIpc } = require('./supply-order-fetch')
const { registerSalesOrderIpc, startAutoSync } = require('./sales-order-fetch')
const { registerAftersaleFetchIpc } = require('./aftersale-fetch')
const { startHeartbeat } = require('./cookie-heartbeat')
const { startServer } = require('./server')
const { setAuthToken, getAuthToken } = require('./auth-store')

// 允许自签名证书（仅用于连接内部服务器API）
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (url.includes('150.158.54.108')) {
    event.preventDefault()
    callback(true)
  } else {
    callback(false)
  }
})

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 620,
    height: 400,
    resizable: false,
    title: '店小二网店管家',
    frame: false,
    center: true,
    show: false,
    backgroundColor: '#001529',
    icon: path.join(process.resourcesPath, 'app.asar', 'resources', 'icon.ico'),
    webPreferences: {
      // 开发模式: __dirname 指向 out/main/，用相对路径找到 out/preload/index.js
      // 生产模式: __dirname 指向 app.asar/out/main/，同样用相对路径找到 app.asar/out/preload/index.js
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 等页面渲染完成后再显示窗口，避免先显示底色再显示内容
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.show()
  })

  // 生产模式隐藏菜单栏 & 禁用 DevTools 快捷键
  if (app.isPackaged) {
    Menu.setApplicationMenu(null)
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' ||
        (input.control && input.shift && (input.key === 'I' || input.key === 'i' || input.key === 'J' || input.key === 'j' || input.key === 'C' || input.key === 'c')) ||
        (input.control && (input.key === 'U' || input.key === 'u'))) {
        event.preventDefault()
      }
    })
  }

  // 开发模式不自动打开 DevTools（避免闪烁），按 F12 手动打开
  // if (!app.isPackaged) {
  //   mainWindow.webContents.openDevTools({ mode: 'right' })
  // }

  // 右键菜单（剪切/复制/粘贴/全选/刷新）
  mainWindow.webContents.on('context-menu', (event, params) => {
    const menu = Menu.buildFromTemplate([
      { label: '剪切', role: 'cut', enabled: params.editFlags.canCut },
      { label: '复制', role: 'copy', enabled: params.editFlags.canCopy },
      { label: '粘贴', role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: '全选', role: 'selectAll' },
      { type: 'separator' },
      { label: '刷新页面', role: 'reload' }
    ])
    menu.popup()
  })

  // 加载页面
  if (app.isPackaged) {
    // 生产模式：优先加载热更新目录，否则加载内置文件
    const hotRendererPath = getHotUpdateRendererPath()
    if (hotRendererPath) {
      console.log('[Main] 从热更新目录加载:', hotRendererPath)
      mainWindow.loadFile(hotRendererPath)
    } else {
      mainWindow.loadFile(path.join(process.resourcesPath, 'app.asar', 'out', 'renderer', 'index.html'))
    }
  } else {
    // 开发模式：加载 vite 开发服务器
    const devUrl = process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173'
    mainWindow.loadURL(devUrl).catch(err => {
      console.error('loadURL failed:', err.message)
      const altUrl = devUrl.replace('5173', '5174')
      mainWindow.loadURL(altUrl).catch(err2 => {
        console.error('Alternate URL also failed:', err2.message)
      })
    })
  }

  return mainWindow
}

// 注册窗口控制 IPC
ipcMain.handle('window-minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize()
})
ipcMain.handle('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) win.isMaximized() ? win.unmaximize() : win.maximize()
})
ipcMain.handle('window-close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close()
})
ipcMain.handle('get-app-version', () => getCurrentVersion())
ipcMain.handle('open-external-url', (event, { url }) => {
  if (!url) return { success: false, message: '网址为空' }

  const urlWin = new BrowserWindow({
    width: 1200,
    height: 800,
    title: new URL(url).hostname,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  urlWin.loadURL(url).catch(err => {
    console.error('[OpenURL] loadURL failed:', err.message)
  })

  // 如果正在抓包，立即监听此窗口的 session
  try {
    const { isCapturing, getCaptureCallback } = require('./packet-capture')
    if (isCapturing()) {
      urlWin.webContents.session.webRequest.onCompleted({ urls: ['*://*/*'] }, getCaptureCallback())
    }
  } catch {
    // packet-capture 模块未加载时忽略
  }

  return { success: true }
})

ipcMain.handle('open-product-url', (event, { storeId, skuId }) => {
  if (!skuId) return { success: false, message: 'SKU为空' }
  const url = `https://item.jd.com/${skuId}.html`
  const partitionName = `persist:platform-${storeId}`
  const urlWin = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `商品详情 - ${skuId}`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: storeId ? partitionName : undefined
    }
  })
  urlWin.loadURL(url).catch(err => {
    console.error('[OpenProductURL] loadURL failed:', err.message)
  })
  return { success: true }
})

// 用店铺cookie打开京东后台指定页面（售后/纠纷/合规等）
ipcMain.handle('open-store-backend-url', (event, { storeId, url, title }) => {
  if (!url || !storeId) return { success: false, message: '参数不完整' }
  const partitionName = `persist:platform-${storeId}`
  const urlWin = new BrowserWindow({
    width: 1200,
    height: 800,
    title: title || new URL(url).hostname,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: partitionName
    }
  })
  urlWin.loadURL(url).catch(err => {
    console.error('[OpenStoreBackendURL] loadURL failed:', err.message)
  })
  return { success: true }
})

// 用采购账号cookie打开指定页面（如淘宝退款、拼多多订单详情页面）
const PURCHASE_COOKIE_SERVER = 'http://150.158.54.108:3002'

ipcMain.handle('open-purchase-url', async (event, { accountId, url, title, platform }) => {
  if (!url || !accountId) return { success: false, message: '参数不完整' }
  const partitionName = `persist:purchase-${accountId}`
  const ses = session.fromPartition(partitionName)

  // ★ 采用和采购账号登录窗口一致的配置（contextIsolation: true，无反检测 preload）
  const chromeVersion = process.versions.chrome || '134.0.0.0'
  const cleanUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`

  const urlWin = new BrowserWindow({
    width: 1200,
    height: 800,
    title: title || new URL(url).hostname,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: partitionName
    }
  })
  urlWin.webContents.setUserAgent(cleanUA)

  // PDD 域名请求头注入（和采购登录窗口一致，仅拦截 PDD 域名）
  if (platform === 'pinduoduo') {
    const secChUa = `"Chromium";v="${chromeVersion.split('.')[0]}", "Google Chrome";v="${chromeVersion.split('.')[0]}", "Not-A.Brand";v="99"`
    ses.webRequest.onBeforeSendHeaders({ urls: ['*://*.yangkeduo.com/*', '*://*.pinduoduo.com/*', '*://*.pdd.net/*'] }, (details, callback) => {
      if (details.requestHeaders) {
        details.requestHeaders['Sec-CH-UA'] = secChUa
        details.requestHeaders['Sec-CH-UA-Platform'] = '"Windows"'
        details.requestHeaders['User-Agent'] = cleanUA
      }
      callback({ requestHeaders: details.requestHeaders })
    })
  }

  // ★ 非阻塞加载：先 loadURL 让页面立即开始渲染，再后台异步恢复 cookie
  // （和采购登录窗口一致的模式，避免同步等 cookie 恢复导致白屏/延迟）
  urlWin.loadURL(url).catch(err => {
    console.error('[OpenPurchaseURL] loadURL failed:', err.message)
  })

  // 后台异步恢复 cookie（不 await，不阻塞页面加载）
  ;(async () => {
    try {
      const cookieData = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('请求超时')), 10000)
        const urlObj = new URL(`${PURCHASE_COOKIE_SERVER}/api/purchase-accounts/${accountId}/cookies`)
        const token = getAuthToken()
        const headers = {}
        if (token) headers['Authorization'] = `Bearer ${token}`
        const req = require('http').request({
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname,
          method: 'GET',
          headers
        }, (res) => {
          let data = ''
          res.on('data', chunk => data += chunk)
          res.on('end', () => { clearTimeout(timeout); resolve({ statusCode: res.statusCode, data }) })
        })
        req.on('error', (e) => { clearTimeout(timeout); reject(e) })
        req.end()
      })
      if (cookieData.statusCode === 200 && cookieData.data) {
        const json = JSON.parse(cookieData.data)
        if (json.code === 0 && json.data && json.data.cookie_data) {
          const raw = typeof json.data.cookie_data === 'string'
            ? JSON.parse(json.data.cookie_data)
            : json.data.cookie_data
          if (Array.isArray(raw) && raw.length > 0) {
            const now = Date.now() / 1000
            const serverCookies = raw.filter(ck => {
              if (ck.expirationDate && ck.expirationDate > 0 && ck.expirationDate < now) return false
              return true
            })

            // PDD：清除旧 cookie 防止 hostOnly cookie 冲突
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
                    const removeUrl = (secure ? 'https://' : 'http://') + (old.domain || '').replace(/^\./, '') + (old.path || '/')
                    await ses.cookies.remove(removeUrl, old.name)
                  } catch (e) { /* ignore */ }
                }
              } catch (e) { /* ignore */ }
            }

            // 淘宝：清除旧 cookie 防止 hostOnly cookie 冲突
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
                    const removeUrl = (secure ? 'https://' : 'http://') + (old.domain || '').replace(/^\./, '') + (old.path || '/')
                    await ses.cookies.remove(removeUrl, old.name)
                  } catch (e) { /* ignore */ }
                }
              } catch (e) { /* ignore */ }
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
              } catch (e2) { /* ignore */ }
            }
            console.log(`[OpenPurchaseURL] 后台cookie恢复: ${setOk} 条, accountId=${accountId}, platform=${platform}`)

            // cookie 恢复成功后：刷新页面让新 cookie 生效
            if (urlWin && !urlWin.isDestroyed() && setOk > 0) {
              try {
                const currentUrl = urlWin.webContents.getURL()
                if (platform === 'pinduoduo') {
                  const pddLoginUrls = ['yangkeduo.com/proxy/api/login', 'pinduoduo.com/login', 'login.yangkeduo.com']
                  const isOnLoginPage = pddLoginUrls.some(u => currentUrl.includes(u))
                  if (isOnLoginPage) {
                    console.log('[OpenPurchaseURL] PDD Cookie恢复成功，重新加载目标页面')
                    urlWin.loadURL(url)
                  } else if (currentUrl.includes('yangkeduo.com') || currentUrl.includes('pinduoduo.com')) {
                    console.log('[OpenPurchaseURL] PDD Cookie恢复成功，刷新当前页面')
                    urlWin.webContents.reload()
                  }
                } else if (platform === 'taobao') {
                  const isOnLoginPage = currentUrl.includes('login.taobao.com') || currentUrl.includes('login.tmall.com')
                  if (isOnLoginPage) {
                    console.log('[OpenPurchaseURL] 淘宝Cookie恢复成功，重新加载目标页面')
                    urlWin.loadURL(url)
                  } else if (currentUrl.includes('taobao.com') || currentUrl.includes('tmall.com')) {
                    console.log('[OpenPurchaseURL] 淘宝Cookie恢复成功，刷新当前页面')
                    urlWin.webContents.reload()
                  }
                }
              } catch (e) { /* ignore */ }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[OpenPurchaseURL] 后台cookie恢复失败:', err.message)
    }
  })()

  // 窗口关闭时清理 onBeforeSendHeaders 监听器（防止泄漏到其他窗口）
  urlWin.on('closed', () => {
    try {
      const s = session.fromPartition(partitionName)
      s.webRequest.onBeforeSendHeaders(null)
    } catch (e) { /* ignore */ }
  })

  return { success: true }
})

// 用店铺cookie打开京东订单详情页
ipcMain.handle('open-jd-order-detail', (event, { storeId, orderId }) => {
  if (!storeId || !orderId) return { success: false, message: '参数不完整' }
  const partitionName = `persist:platform-${storeId}`
  const detailUrl = `https://shop.jd.com/jdm/trade/orders/order-details?orderId=${orderId}`

  const detailWin = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `订单详情 - ${orderId}`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: partitionName
    }
  })
  detailWin.loadURL(detailUrl).catch(err => {
    console.error('[OpenJdOrderDetail] loadURL failed:', err.message)
  })

  detailWin.once('ready-to-show', () => {
    detailWin.focus()
  })

  return { success: true }
})

// 用店铺cookie打开京东出库页面并自动点击出库按钮
ipcMain.handle('open-jd-outbound', (event, { storeId, orderId, title }) => {
  if (!storeId) return { success: false, message: '参数不完整' }
  const partitionName = `persist:platform-${storeId}`
  const outStoreUrl = 'https://shop.jd.com/jdm/trade/orders/order-list?tabType=waitOut'

  // 初始大窗口加载页面，点击后缩小到只显示出库卡片
  const urlWin = new BrowserWindow({
    width: 1200,
    height: 800,
    title: title || '店铺发货 - 京东',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: partitionName
    }
  })
  urlWin.loadURL(outStoreUrl).catch(err => {
    console.error('[OpenJdOutbound] loadURL failed:', err.message)
  })

  // 自动搜索+点击脚本：
  // 1. 如果有订单号，先在搜索框输入订单号并触发搜索
  // 2. 等搜索结果出来后，再点击对应订单的出库按钮
  // 3. 如果没有订单号，直接点击页面上第一个出库按钮
  const autoClickScript = `
    (function() {
      var orderId = ${JSON.stringify(orderId || '')};
      var clicked = false;
      var searched = false;

      // 在筛选区的"订单编号"输入框输入订单号并点击"查询"
      function searchByOrderId() {
        if (!orderId || searched) return;
        searched = true;
        console.log('[JD Outbound] Searching for order: ' + orderId);

        var searchInput = null;

        // 策略1：通过 placeholder 精确定位（"多个查询请以逗号/空格隔开"是京东订单编号输入框的特征）
        var allInputs = document.querySelectorAll('input[type="text"], input:not([type])');
        for (var i = 0; i < allInputs.length; i++) {
          var ph = allInputs[i].placeholder || '';
          if (ph.indexOf('\\u9017\\u53f7') !== -1 || ph.indexOf('\\u7a7a\\u683c') !== -1) {
            searchInput = allInputs[i];
            console.log('[JD Outbound] Found order input by placeholder');
            break;
          }
        }

        // 策略2：通过"订单编号"标签定位相邻的输入框
        if (!searchInput) {
          var labels = document.querySelectorAll('label, span, div, p');
          for (var j = 0; j < labels.length; j++) {
            var label = labels[j];
            if ((label.textContent || '').trim().indexOf('\\u8ba2\\u5355\\u7f16\\u53f7') !== -1) {
              // 在标签的父容器中查找输入框
              var container = label.parentElement || label.closest('div, form, [class*="filter"], [class*="search"]');
              if (container) {
                var inputs = container.querySelectorAll('input');
                for (var k = 0; k < inputs.length; k++) {
                  if (inputs[k].offsetWidth > 0 && inputs[k].offsetHeight > 0) {
                    searchInput = inputs[k];
                    console.log('[JD Outbound] Found order input by label');
                    break;
                  }
                }
              }
              if (searchInput) break;
            }
          }
        }

        // 策略3：查找 name 或 id 包含 orderId/order_id/orderId 的输入框
        if (!searchInput) {
          for (var m = 0; m < allInputs.length; m++) {
            var name = (allInputs[m].name || '').toLowerCase();
            var id = (allInputs[m].id || '').toLowerCase();
            if ((name.indexOf('orderid') !== -1 || name.indexOf('order_id') !== -1 ||
                 id.indexOf('orderid') !== -1 || id.indexOf('order_id') !== -1) &&
                allInputs[m].offsetWidth > 0) {
              searchInput = allInputs[m];
              console.log('[JD Outbound] Found order input by name/id');
              break;
            }
          }
        }

        if (!searchInput) {
          console.log('[JD Outbound] Order search input not found, skip search');
          return;
        }

        // 模拟输入订单号
        searchInput.focus();
        var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(searchInput, orderId);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[JD Outbound] Filled orderId into order input');

        // 点击"查询"按钮（延迟让 React/Vue 响应 input 事件）
        setTimeout(function() {
          var buttons = document.querySelectorAll('button, [class*="btn"], [role="button"], a, span');
          for (var n = 0; n < buttons.length; n++) {
            var btnText = (buttons[n].textContent || '').trim();
            // 京东筛选区的查询按钮文字是"查询"
            if (btnText === '\\u67e5\\u8be2') {
              buttons[n].click();
              console.log('[JD Outbound] Clicked query button');
              return;
            }
          }
          // 没找到查询按钮，回车触发
          searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          searchInput.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          console.log('[JD Outbound] Pressed Enter in order input');
        }, 800);
      }

      function findAndClickOutboundBtn() {
        if (clicked) return true;

        // 策略1：如果提供了订单号，先定位到该订单行，再在行内查找出库按钮
        if (orderId) {
          var rows = document.querySelectorAll('tr, [class*="order-row"], [class*="orderRow"], [class*="table-row"], [class*="order-item"]');
          for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var rowText = row.textContent || '';
            if (rowText.indexOf(orderId) !== -1) {
              var btns = row.querySelectorAll('button, a, [class*="btn"], [role="button"]');
              for (var j = 0; j < btns.length; j++) {
                var btnText = (btns[j].textContent || '').trim();
                if (btnText.indexOf('\\u51fa\\u5e93') !== -1) {
                  btns[j].click();
                  clicked = true;
                  console.log('[JD Outbound] Clicked outbound btn in order row for: ' + orderId);
                  return true;
                }
              }
            }
          }
        }

        // 策略2：查找所有包含"出库"文字的可点击元素
        var allBtns = document.querySelectorAll('button, a, [class*="btn"], [role="button"], span[class*="click"], div[class*="action"]');
        for (var k = 0; k < allBtns.length; k++) {
          var text = (allBtns[k].textContent || '').trim();
          if (text.indexOf('\\u51fa\\u5e93') !== -1) {
            if (text === '\\u51fa\\u5e93' || text === '\\u51fa\\u5e93 ' || text === ' \\u51fa\\u5e93') {
              allBtns[k].click();
              clicked = true;
              console.log('[JD Outbound] Clicked exact outbound btn');
              return true;
            }
          }
        }

        // 策略3：模糊匹配 — 任何包含"出库"的可点击元素
        for (var m = 0; m < allBtns.length; m++) {
          var t = (allBtns[m].textContent || '').trim();
          if (t.indexOf('\\u51fa\\u5e93') !== -1 && t.length < 10) {
            allBtns[m].click();
            clicked = true;
            console.log('[JD Outbound] Clicked fuzzy outbound btn, text=' + t);
            return true;
          }
        }

        // 策略4：class名包含 out/ship/delivery 的按钮
        var classBtns = document.querySelectorAll('[class*="outbound"], [class*="out-store"], [class*="ship-btn"], [class*="delivery-btn"]');
        for (var n = 0; n < classBtns.length; n++) {
          classBtns[n].click();
          clicked = true;
          console.log('[JD Outbound] Clicked class-matched btn');
          return true;
        }

        return false;
      }

      // 执行流程：先搜索（如有订单号），等待搜索结果后点击出库
      var delays;
      if (orderId) {
        // 有订单号：先搜索，延迟后再点击出库
        setTimeout(searchByOrderId, 2000);
        delays = [5000, 7000, 9000, 12000, 16000];
      } else {
        // 无订单号：直接点击第一个出库按钮
        delays = [2000, 4000, 6000, 9000, 13000];
      }

      delays.forEach(function(delay) {
        setTimeout(function() {
          if (!clicked) {
            var result = findAndClickOutboundBtn();
            if (!result && delay === delays[delays.length - 1]) {
              console.log('[JD Outbound] Auto-click failed after all retries');
            }
          }
        }, delay);
      });
    })()
  `

  // 隐藏背景页面的CSS，只保留出库弹窗/抽屉卡片
  const hideBackgroundCSS = `
    /* 隐藏页面主体内容（侧边栏、顶部导航、订单列表等） */
    body > #app > *:not([class*="drawer"]):not([class*="modal"]):not([class*="dialog"]):not([class*="overlay"]):not([class*="popup"]) {
      display: none !important;
    }
    /* 常见京东后台布局容器 */
    .ant-layout,
    [class*="layout-sidebar"],
    [class*="layout-header"],
    [class*="layout-content"],
    [class*="sider"],
    [class*="sidebar"],
    [class*="header"],
    [class*="nav-bar"],
    [class*="navbar"],
    [class*="menu"],
    [class*="breadcrumb"],
    [class*="order-list"],
    [class*="orderList"],
    [class*="table-wrapper"],
    [class*="tabs"] {
      display: none !important;
    }
    /* 确保弹窗/抽屉可见 */
    [class*="drawer"],
    [class*="modal"],
    [class*="dialog"],
    [class*="overlay"],
    [class*="popup"] {
      display: block !important;
    }
    /* 遮罩层透明化，只保留弹窗内容 */
    [class*="drawer"]-mask,
    [class*="modal"]-mask,
    .ant-drawer-mask,
    .ant-modal-mask,
    [class*="overlay-mask"],
    [class*="mask"] {
      background: transparent !important;
    }
    /* 抽屉从左侧弹出时去掉偏移，让它居左显示 */
    [class*="drawer"]-content,
    .ant-drawer-content,
    [class*="drawer"]-content-wrapper,
    .ant-drawer-content-wrapper {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      margin: 0 !important;
    }
  `

  // 出库按钮点击成功后，用 insertCSS 隐藏背景并缩小窗口
  // 通过 executeJavaScript 在点击成功后发回通知
  const notifyClickScript = `
    (function() {
      var checkCount = 0;
      var maxChecks = 20;
      function checkDrawerOpen() {
        if (checkCount >= maxChecks) return;
        checkCount++;
        var drawer = document.querySelector(
          '[class*="drawer-content"], [class*="drawerContent"], ' +
          '[class*="modal-content"], [class*="modalContent"], ' +
          '[class*="dialog-content"], [class*="dialogContent"], ' +
          '[class*="popup-content"], [class*="popupContent"]'
        );
        if (drawer && drawer.offsetParent !== null) {
          // 弹窗已出现，获取其尺寸用于调整窗口
          var rect = drawer.getBoundingClientRect();
          var w = Math.ceil(rect.width) + 20;
          var h = Math.ceil(rect.height) + 20;
          window.__jdOutboundReady = true;
          // 通过 DOM 数据属性传递尺寸给主进程
          document.documentElement.setAttribute('data-outbound-width', w);
          document.documentElement.setAttribute('data-outbound-height', h);
          console.log('[JD Outbound] Drawer detected, size=' + w + 'x' + h);
        } else {
          setTimeout(checkDrawerOpen, 800);
        }
      }
      checkDrawerOpen();
    })()
  `

  let cssInjected = false

  urlWin.webContents.on('did-finish-load', () => {
    if (urlWin.isDestroyed()) return
    console.log('[OpenJdOutbound] Page loaded, injecting auto-click script, orderId=', orderId)
    // 先注入自动点击脚本
    urlWin.webContents.executeJavaScript(autoClickScript).catch(err => {
      console.error('[OpenJdOutbound] executeJavaScript failed:', err.message)
    })
  })

  // 轮询检测弹窗是否出现，出现后注入CSS并缩小窗口
  const resizeInterval = setInterval(() => {
    if (urlWin.isDestroyed()) {
      clearInterval(resizeInterval)
      return
    }
    if (cssInjected) {
      clearInterval(resizeInterval)
      return
    }
    urlWin.webContents.executeJavaScript(`
      (function() {
        var ready = window.__jdOutboundReady;
        var w = document.documentElement.getAttribute('data-outbound-width');
        var h = document.documentElement.getAttribute('data-outbound-height');
        if (ready && w && h) return { width: parseInt(w), height: parseInt(h) };
        return null;
      })()
    `).then(result => {
      if (result && !cssInjected) {
        cssInjected = true
        console.log('[OpenJdOutbound] Drawer ready, injecting CSS and resizing window to', result.width, 'x', result.height)
        // 用 insertCSS 隐藏背景（比 executeJavaScript 插入 <style> 更隐蔽）
        urlWin.webContents.insertCSS(hideBackgroundCSS)
        // 缩小窗口到弹窗大小
        const winWidth = Math.min(result.width + 40, 900)
        const winHeight = Math.min(result.height + 40, 900)
        urlWin.setSize(winWidth, winHeight)
        urlWin.center()
      }
    }).catch(() => {})
  }, 1500)

  // 30秒后停止轮询
  setTimeout(() => { clearInterval(resizeInterval) }, 30000)

  return { success: true }
})

// 窗口尺寸切换：登录页 <-> 主页
ipcMain.handle('window-set-login-size', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  win.webContents.closeDevTools()
  win.setResizable(true)
  win.setMinimumSize(620, 400)
  win.setSize(620, 400)
  win.setResizable(false)
  win.center()
})
ipcMain.handle('window-set-main-size', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  win.setResizable(true)
  win.setMinimumSize(1024, 680)
  win.maximize()
})

// 更新 IPC 通道由 update-manager 统一注册

// 注册 auth token 同步（渲染进程登录后将 token 传递给主进程）
ipcMain.handle('set-auth-token', (event, token) => {
  setAuthToken(token || null)
  console.log('[Main] Auth token 已同步', token ? '(有效)' : '(清除)')
})

// 注册抓包 IPC（使用 ipcMain.handle，需在 app.whenReady 前注册）
registerPacketCaptureIpc()

// 注册供销订单获取 IPC
registerSupplyOrderIpc()

app.whenReady().then(async () => {
  // 启动诊断：检查用户数据目录是否可写（影响localStorage持久化和缓存）
  try {
    const fs = require('fs')
    const userDataPath = app.getPath('userData')
    console.log(`[Main] 用户数据目录: ${userDataPath}`)
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true })
      console.log('[Main] 用户数据目录已创建')
    }
    // 测试写入权限
    const testFile = path.join(userDataPath, '.write-test')
    fs.writeFileSync(testFile, 'ok')
    fs.unlinkSync(testFile)
    console.log('[Main] 用户数据目录可写')
  } catch (e) {
    console.error('[Main] 用户数据目录不可写:', e.message)
  }

  // 启动本地后端服务
  startServer(3002)

  // 允许 renderer 进程 fetch 访问自签名 HTTPS API
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (request.hostname === '150.158.54.108') {
      callback(0)
    } else {
      callback(-3)
    }
  })

  // 启动前清除缓存，防止旧缓存导致页面内容错误
  try {
    await session.defaultSession.clearCache()
  } catch (e) {
    // 忽略清理失败
  }

  // ★ 全量更新后清理过期热更新（必须在 createWindow 之前！）
  // 原因：全量更新安装后重启，旧版本的热更新 renderer/main 仍留在 hot-update 目录，
  // createWindow() 会优先加载热更新 renderer，旧 renderer 与新主进程不兼容导致白屏
  // cleanupStaleHotUpdate 在 initUpdateManager 中也会调用，但那时窗口已加载旧 renderer，为时已晚
  try {
    if (app.isPackaged) {
      const hotVersion = getCurrentVersion()
      const appVersion = app.getVersion()
      const parseVersion = (v) => {
        const parts = String(v || '0.0.0').split('.').map(Number)
        return parts[0] * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0)
      }
      if (parseVersion(appVersion) >= parseVersion(hotVersion) && hotVersion !== appVersion) {
        clearHotUpdate()
        console.log('[Main] 全量更新后清理过期热更新 (app:', appVersion, 'hot:', hotVersion, ')')
      }
    }
  } catch (e) {
    console.warn('[Main] 清理过期热更新失败:', e.message)
  }

  const mainWindow = createWindow()

  // 初始化统一更新管理器（协调全量更新 + 热更新）
  initUpdateManager(mainWindow)

  // 注册平台窗口 IPC（需要 mainWindow 引用）
  registerPlatformWindowIpc(mainWindow)

  // 注册销售订单获取 IPC（需要 mainWindow 引用用于自动同步）
  registerSalesOrderIpc(mainWindow)

  // 注册售后纠纷指标获取 IPC
  registerAftersaleFetchIpc(mainWindow)

  // 注册采购账号登录窗口 IPC
  registerPurchaseAccountIpc(mainWindow)

  // 注册采购下单捕获 IPC
  registerPurchaseOrderCaptureIpc(mainWindow)

  // 注册采购订单浏览器同步 IPC
  registerPurchaseOrderSyncIpc(mainWindow)

  // 启动心跳检测
  startHeartbeat(mainWindow)

  // 启动订单自动同步（每10分钟，多店铺逐个执行）
  // startAutoSync(mainWindow) // 已取消全局自动同步，改为用户手动控制

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 应用退出前刷盘所有 persist: 分区数据（关键！防止重启后cookie丢失）
// persist: 分区的数据存储在磁盘，但 Chromium 会缓冲写入，如果不主动 flush，退出时可能丢失
app.on('before-quit', () => {
  try {
    // 扫描所有 partition session 并 flush（Electron 的 session API 不提供列举方法，
    // 所以 flush defaultSession + 已知的 partition pattern）
    session.defaultSession.flushStorageData(() => {
      console.log('[Main] Default session flushed on quit')
    })
  } catch (e) {
    // 忽略刷盘失败
  }
})
