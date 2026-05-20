/**
 * Chrome 采购窗口模块 — 使用真实 Chrome + 扩展，完全无 CDP
 *
 * 架构（和 dl 一致）：
 * 1. 用 child_process 启动真实 Chrome 浏览器 + 加载扩展
 * 2. 扩展的 content script 在 PDD 页面中执行自动化
 * 3. Electron 和扩展通过本地 HTTP 服务器通信
 * 4. 无 puppeteer、无 CDP — PDD 完全无法检测
 */

const { spawn } = require('child_process')
const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')

// Chrome 可执行文件路径
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

// 扩展目录 — 使用项目根目录的 resources（__dirname 在构建后指向 out/main/，需要回到项目根）
const EXTENSION_DIR = path.resolve(__dirname, '..', '..', 'resources', 'dxe-purchase-extension')

// 本地通信端口
const LOCAL_PORT = 19527

// 活跃的 Chrome 采购窗口
const activeChromeWindows = new Map()

// 本地 HTTP 服务器
let localServer = null

/**
 * 启动本地 HTTP 服务器，用于与 Chrome 扩展通信
 */
function ensureLocalServer(mainWindow, deps) {
  if (localServer) return localServer

  const { httpRequest, BUSINESS_SERVER } = deps

  localServer = http.createServer((req, res) => {
    // CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    const url = req.url

    // ========== GET /dxe/config — 扩展拉取采购配置 ==========
    if (url === '/dxe/config' && req.method === 'GET') {
      for (const [, state] of activeChromeWindows) {
        if (state.config && !state.resolved) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(state.config))
          return
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({}))
      return
    }

    // ========== POST /dxe/order-captured — 扩展上报订单号 ==========
    if (url === '/dxe/order-captured' && req.method === 'POST') {
      readBody(req, (data) => {
        const { purchaseNo, orderNo, amount } = data
        console.log(`[ChromePurchase] Order captured via extension: ${orderNo}`)

        const state = activeChromeWindows.get(purchaseNo)
        if (state && !state.resolved && state.onOrderCaptured) {
          state.onOrderCaptured(orderNo, amount)
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    // ========== POST /dxe/price-captured — 扩展上报价格信息 ==========
    if (url === '/dxe/price-captured' && req.method === 'POST') {
      readBody(req, (data) => {
        const { purchaseNo, priceInfo } = data
        console.log(`[ChromePurchase] Price captured: actualFee=${priceInfo?.actualFee}, goodsPrice=${priceInfo?.goodsPrice}, postFee=${priceInfo?.postFee}`)

        const state = activeChromeWindows.get(purchaseNo)
        if (state && !state.resolved) {
          state.capturedPriceInfo = priceInfo
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    // ========== POST /dxe/product-cached — 扩展上报商品信息 ==========
    if (url === '/dxe/product-cached' && req.method === 'POST') {
      readBody(req, (data) => {
        console.log(`[ChromePurchase] Product cached: title=${(data.productInfo?.title || '').substring(0, 40)}`)
        const state = activeChromeWindows.get(data.purchaseNo)
        if (state && !state.resolved) {
          state.cachedProductInfo = data.productInfo
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    // ========== POST /dxe/page-event — 扩展上报页面事件 ==========
    if (url === '/dxe/page-event' && req.method === 'POST') {
      readBody(req, (data) => {
        console.log(`[ChromePurchase] Page: ${data.event} ${data.url?.substring(0, 80)}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    // ========== POST /dxe/cookies-snapshot — 扩展上报 Cookie ==========
    if (url === '/dxe/cookies-snapshot' && req.method === 'POST') {
      readBody(req, (data) => {
        const { purchaseNo, cookies } = data
        if (cookies && cookies.length > 0) {
          const state = activeChromeWindows.get(purchaseNo)
          if (state && state.accountId) {
            // PDD domain 规范化：hostOnly 的 mobile.yangkeduo.com 必须加前导点
            const normalized = cookies.map(c => c.domain === 'mobile.yangkeduo.com' && c.hostOnly ? { ...c, domain: '.mobile.yangkeduo.com', hostOnly: false } : c)
            httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${state.accountId}/cookies`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cookie_data: JSON.stringify(normalized), platform: 'pinduoduo' })
            }).then(() => {
              console.log(`[ChromePurchase] Cookies saved: ${normalized.length}`)
            }).catch(e => {
              console.warn('[ChromePurchase] Cookie save failed:', e.message)
            })
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  localServer.listen(LOCAL_PORT, '127.0.0.1', () => {
    console.log(`[ChromePurchase] Local server listening on http://localhost:${LOCAL_PORT}`)
  })

  localServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`[ChromePurchase] Port ${LOCAL_PORT} in use, assuming server already running`)
    } else {
      console.error('[ChromePurchase] Local server error:', e.message)
    }
  })

  return localServer
}

function readBody(req, callback) {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    try {
      callback(JSON.parse(body))
    } catch (e) {
      callback({})
    }
  })
}

/**
 * 打开 Chrome 采购窗口
 */
async function openChromePurchaseWindow({ accountId, accountName, password, purchaseUrl, platform, purchaseInfo, mainWindow, deps }) {
  const { httpRequest, BUSINESS_SERVER, autoCreateAndBind, isValidProductTitle, isValidProductImage } = deps
  const { purchaseNo } = purchaseInfo

  purchaseInfo.accountId = accountId
  purchaseInfo.accountName = accountName || ''
  purchaseInfo.accountPassword = password || ''

  // 防重复
  if (activeChromeWindows.has(purchaseNo)) {
    return { success: true, message: '窗口已打开' }
  }

  console.log(`[ChromePurchase] Opening Chrome window: url=${purchaseUrl}`)
  console.log(`[ChromePurchase] Account: accountId=${accountId}, accountName="${accountName || ''}"`)

  // 确保本地服务器在运行
  ensureLocalServer(mainWindow, deps)

  // ========== 从服务器加载 Cookie ==========
  let serverCookies = []
  try {
    const cookieRes = await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, { method: 'GET' })
    if (cookieRes.statusCode === 200 && cookieRes.data) {
      const json = JSON.parse(cookieRes.data)
      if (json.code === 0 && json.data && json.data.cookie_data) {
        const cookies = typeof json.data.cookie_data === 'string'
          ? JSON.parse(json.data.cookie_data) : json.data.cookie_data
        if (Array.isArray(cookies)) {
          const now = Date.now() / 1000
          serverCookies = cookies.filter(ck => {
            if (ck.expirationDate && ck.expirationDate > 0 && ck.expirationDate < now) return false
            return ck.name && ck.domain
          })
          console.log(`[ChromePurchase] Cookie loaded: ${serverCookies.length} from server`)
        }
      }
    }
  } catch (e) {
    console.warn('[ChromePurchase] Cookie load failed:', e.message)
  }

  // ========== 采购配置（扩展通过 HTTP 拉取） ==========
  const config = {
    purchaseNo,
    platform,
    accountName: accountName || '',
    shippingName: purchaseInfo.shippingName || '',
    shippingPhone: purchaseInfo.shippingPhone || '',
    shippingAddress: purchaseInfo.shippingAddress || '',
    cookies: serverCookies,  // Cookie 注入数据，扩展会通过 chrome.cookies.set 注入
  }

  // ========== 状态管理 ==========
  let resolved = false
  let cachedProductInfo = null
  let chromeProcess = null

  const state = {
    config,
    resolved: false,
    accountId,
    cachedProductInfo: null,
    onOrderCaptured: null,
  }

  // ========== 订单捕获回调 ==========
  function onOrderCaptured(orderNo, amount) {
    if (resolved) return
    resolved = true
    state.resolved = true
    console.log(`[ChromePurchase] onOrderCaptured: ${orderNo}`)

    let capturedAmount = amount || null

    // 应用缓存的价格信息（从 asyncBought API 获取）
    if (state.capturedPriceInfo) {
      const pi = state.capturedPriceInfo
      if (pi.actualFee && pi.actualFee > 0) {
        capturedAmount = pi.actualFee
        console.log(`[ChromePurchase] 价格信息(actualFee): ¥${pi.actualFee}`)
      }
      // 优先使用扩展计算好的 goodsPrice；若没有则用 purchaseInfo.quantity 回退计算
      if (pi.goodsPrice && pi.goodsPrice > 0) {
        purchaseInfo.purchasePrice = pi.goodsPrice
        console.log(`[ChromePurchase] 商品单价(goodsPrice): ¥${pi.goodsPrice}`)
      } else if (pi.actualFee && pi.actualFee > 0) {
        // 扩展未算出单价，用 purchaseInfo.quantity 回退计算: 单价 = (actualFee - postFee) / quantity
        const calcQuantity = pi.quantity || purchaseInfo.quantity || 0
        const shippingFee = pi.postFee || 0
        if (calcQuantity > 0) {
          const goodsTotal = pi.actualFee - shippingFee
          if (goodsTotal > 0) {
            purchaseInfo.purchasePrice = Math.round((goodsTotal / calcQuantity) * 100) / 100
            console.log(`[ChromePurchase] 商品单价(回退计算): (¥${pi.actualFee} - ¥${shippingFee}) / ${calcQuantity} = ¥${purchaseInfo.purchasePrice}`)
          }
        }
      }
      if (pi.postFee && pi.postFee > 0) {
        purchaseInfo.shippingFee = pi.postFee
        console.log(`[ChromePurchase] 运费(postFee): ¥${pi.postFee}`)
      }
    }

    // 应用缓存的商品信息
    if (cachedProductInfo) {
      if (cachedProductInfo.title && isValidProductTitle(cachedProductInfo.title)) {
        purchaseInfo.goodsName = cachedProductInfo.title
      }
      if (cachedProductInfo.image && isValidProductImage(cachedProductInfo.image)) {
        purchaseInfo.image = cachedProductInfo.image
      }
      if (cachedProductInfo.sku) {
        purchaseInfo.sku = cachedProductInfo.sku
      }
    }

    // purchasePrice 回退：如果上面没有计算出来，用 capturedAmount / quantity
    if (!purchaseInfo.purchasePrice && capturedAmount && capturedAmount > 0) {
      const fallbackQty = purchaseInfo.quantity || 0
      if (fallbackQty > 0 && (capturedAmount - (purchaseInfo.shippingFee || 0)) > 0) {
        purchaseInfo.purchasePrice = Math.round(((capturedAmount - (purchaseInfo.shippingFee || 0)) / fallbackQty) * 100) / 100
        console.log(`[ChromePurchase] 商品单价(最终回退): (¥${capturedAmount} - ¥${purchaseInfo.shippingFee || 0}) / ${fallbackQty} = ¥${purchaseInfo.purchasePrice}`)
      } else {
        purchaseInfo.purchasePrice = capturedAmount
        console.log(`[ChromePurchase] 商品单价(无数量回退): ¥${capturedAmount}`)
      }
    }
    // totalAmount 从 actualFee 取
    if (capturedAmount && capturedAmount > 0) {
      purchaseInfo.totalAmount = capturedAmount
    }

    autoCreateAndBind(purchaseInfo, orderNo, platform, capturedAmount)
      .then(async () => {
        console.log(`[ChromePurchase] Auto-bind 成功: ${purchaseNo}, orderNo=${orderNo}`)
        if (purchaseInfo.salesOrderId) {
          try {
            const purchasePriceText = capturedAmount || purchaseInfo.purchasePrice || ''
            const sysRemark = `【${purchaseNo}】${orderNo} ${purchasePriceText}（${purchaseInfo.accountName || ''}）`
            await httpRequest(`${BUSINESS_SERVER}/api/sales-orders/${purchaseInfo.salesOrderId}/sys-remark`, {
              method: 'PUT',
              body: JSON.stringify({ sys_remark: sysRemark })
            })
          } catch (e) {}
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('purchase-order-captured', {
            purchaseNo, platformOrderNo: orderNo, platform, success: true,
            sysRemark: `【${purchaseNo}】${orderNo} ${capturedAmount || purchaseInfo.purchasePrice || ''}（${purchaseInfo.accountName || ''}）`,
            salesOrderId: purchaseInfo.salesOrderId || null
          })
        }
      })
      .catch(err => {
        console.error(`[ChromePurchase] Auto-bind 失败:`, err.message)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('purchase-order-captured', {
            purchaseNo, platformOrderNo: orderNo, platform, success: false, error: err.message
          })
        }
      })
  }

  state.onOrderCaptured = onOrderCaptured
  activeChromeWindows.set(purchaseNo, state)

  // ========== 启动 Chrome ==========
  const userDataDir = path.join(os.homedir(), 'AppData', 'Local', 'dxe-chrome-profiles', `purchase-${accountId}`)

  // 每次启动前删除旧 Profile，避免被 PDD 标记（之前 CDP/puppeteer 会话可能已污染 profile）
  try {
    if (fs.existsSync(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true })
      console.log(`[ChromePurchase] Cleared stale Chrome profile: ${userDataDir}`)
    }
  } catch (e) {
    console.warn(`[ChromePurchase] Failed to clear profile: ${e.message}`)
  }

  const chromeArgs = [
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${EXTENSION_DIR}`,
    '--disable-extensions-except=' + EXTENSION_DIR,
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=1280,860`,
    purchaseUrl,
  ]

  console.log(`[ChromePurchase] Launching Chrome...`)
  console.log(`[ChromePurchase] Extension: ${EXTENSION_DIR}`)
  console.log(`[ChromePurchase] Profile: ${userDataDir}`)

  chromeProcess = spawn(CHROME_PATH, chromeArgs, {
    stdio: 'ignore',
    detached: false,
  })

  chromeProcess.on('error', (err) => {
    console.error('[ChromePurchase] Chrome launch error:', err.message)
  })

  chromeProcess.on('exit', (code) => {
    console.log(`[ChromePurchase] Chrome exited (code ${code})`)
    if (!resolved) {
      resolved = true
      state.resolved = true
      activeChromeWindows.delete(purchaseNo)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('purchase-window-closed', { purchaseNo, captured: false })
      }
    }
  })

  return { success: true, message: 'Chrome窗口已打开' }
}

/**
 * 关闭指定采购号的 Chrome 窗口
 */
async function closeChromePurchaseWindow(purchaseNo) {
  const state = activeChromeWindows.get(purchaseNo)
  if (!state) return
  try {
    if (state.chromeProcess && !state.chromeProcess.killed) {
      state.chromeProcess.kill()
    }
  } catch (e) {}
  activeChromeWindows.delete(purchaseNo)
}

/**
 * 检查 Chrome 是否可用
 */
function isChromeAvailable() {
  try {
    return fs.existsSync(CHROME_PATH)
  } catch (e) {
    return false
  }
}

module.exports = {
  openChromePurchaseWindow,
  closeChromePurchaseWindow,
  isChromeAvailable,
  activeChromeWindows
}
