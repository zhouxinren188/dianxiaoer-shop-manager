const { BrowserWindow, ipcMain, session } = require('electron')
const http = require('http')
const { getAuthToken } = require('./auth-store')

const BUSINESS_SERVER = 'http://150.158.54.108:3002'

// 活跃的采购下单窗口 Map<purchaseNo, { win, pollTimer, resolved }>
const activePurchaseWindows = new Map()

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const headers = { 'Content-Type': 'application/json', ...options.headers }
    const token = getAuthToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers,
      timeout: 10000
    }
    const req = http.request(reqOptions, (res) => {
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

// ============ API 拦截器脚本（纯捕获，不修改请求） ============
const PURCHASE_INTERCEPTOR = `
(function() {
  if (window.__purchaseInterceptorInstalled) return;
  window.__purchaseInterceptorInstalled = true;
  window.__capturedPurchaseResponses = [];

  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    var urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    return origFetch.call(this, input, init).then(function(response) {
      try {
        var cloned = response.clone();
        cloned.text().then(function(body) {
          if (body.length > 20) {
            window.__capturedPurchaseResponses.push({
              url: urlStr.substring(0, 1000),
              status: response.status,
              body: body.substring(0, 100000),
              time: Date.now()
            });
          }
        }).catch(function(){});
      } catch(e) {}
      return response;
    });
  };

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__capUrl = (url || '').toString().substring(0, 1000);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    var xhr = this;
    xhr.addEventListener('load', function() {
      try {
        var resp = xhr.responseText || '';
        if (resp.length > 20) {
          window.__capturedPurchaseResponses.push({
            url: xhr.__capUrl,
            status: xhr.status,
            body: resp.substring(0, 100000),
            time: Date.now()
          });
        }
      } catch(e) {}
    });
    return origSend.call(this, body);
  };
})()
`

// 读取捕获的响应（读后清空）
const READ_CAPTURED_PURCHASES = `
(function() {
  var data = window.__capturedPurchaseResponses || [];
  window.__capturedPurchaseResponses = [];
  return data;
})()
`

// ============ 地址自动填充脚本 ============

// 结算页面URL关键词（各平台）
const CHECKOUT_URL_PATTERNS = {
  taobao: ['buy.taobao.com', 'buyertrade.taobao.com', 'buy.tmall.com'],
  pinduoduo: ['yangkeduo.com/order', 'mobile.yangkeduo.com/order', 'mms.pinduoduo.com/order'],
  '1688': ['trade.1688.com', 'buyer.trade.1688.com']
}

/**
 * 生成地址自动填充脚本（平台无关的通用策略 + 平台特定策略）
 * 策略：在结算页面查找收货地址区域的输入框，尝试填入目标地址
 */
function buildAddressAutoFillScript(shippingName, shippingPhone, shippingAddress, platform) {
  // 将参数安全编码到脚本中
  const name = (shippingName || '').replace(/'/g, "\\'").replace(/\\/g, '\\\\')
  const phone = (shippingPhone || '').replace(/'/g, "\\'").replace(/\\/g, '\\\\')
  const addr = (shippingAddress || '').replace(/'/g, "\\'").replace(/\\/g, '\\\\')

  return `
(function() {
  if (window.__addressAutoFillDone) return;
  var targetName = '${name}';
  var targetPhone = '${phone}';
  var targetAddr = '${addr}';
  if (!targetName && !targetPhone && !targetAddr) return;

  console.log('[AddressAutoFill] Attempting to fill address:', targetName, targetPhone, targetAddr);

  // 通用辅助：模拟用户输入（触发框架的数据绑定）
  function simulateInput(el, value) {
    if (!el || !value) return false;
    var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeInputValueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  // 通用辅助：模拟textarea输入
  function simulateTextareaInput(el, value) {
    if (!el || !value) return false;
    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  // 通用策略：根据 placeholder/label 匹配输入框
  function tryGenericFill() {
    var inputs = document.querySelectorAll('input[type="text"], input:not([type]), textarea');
    var filled = 0;
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var ph = (el.placeholder || '').toLowerCase();
      var ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      var name = (el.name || '').toLowerCase();
      var hint = ph + ' ' + ariaLabel + ' ' + name;

      if (hint.match(/收货人|姓名|收件人|consignee|receiver|name/) && targetName) {
        if (el.tagName === 'TEXTAREA') simulateTextareaInput(el, targetName);
        else simulateInput(el, targetName);
        filled++;
      } else if (hint.match(/手机|电话|联系|phone|mobile|tel/) && targetPhone) {
        if (el.tagName === 'TEXTAREA') simulateTextareaInput(el, targetPhone);
        else simulateInput(el, targetPhone);
        filled++;
      } else if (hint.match(/详细地址|收货地址|街道|address|detail/) && targetAddr) {
        if (el.tagName === 'TEXTAREA') simulateTextareaInput(el, targetAddr);
        else simulateInput(el, targetAddr);
        filled++;
      }
    }
    return filled;
  }

  // 延迟执行，等待页面渲染完成
  var attempts = 0;
  var maxAttempts = 10;
  function tryFill() {
    attempts++;
    var filled = tryGenericFill();
    if (filled > 0) {
      window.__addressAutoFillDone = true;
      window.__addressAutoFillResult = filled;
      console.log('[AddressAutoFill] Success! Filled ' + filled + ' fields on attempt ' + attempts);
      // 在页面中显示浮动提示
      var toast = document.createElement('div');
      toast.innerHTML = '\u2705 \u5730\u5740\u5df2\u81ea\u52a8\u586b\u5145\uff08\u5171' + filled + '\u4e2a\u5b57\u6bb5\uff09\uff0c\u8bf7\u6838\u5bf9\u540e\u63d0\u4ea4\u8ba2\u5355';
      toast.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:999999;background:linear-gradient(135deg,#52c41a,#73d13d);color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:500;box-shadow:0 4px 16px rgba(82,196,26,0.4);pointer-events:none;animation:addrToastIn 0.4s ease;';
      var style = document.createElement('style');
      style.textContent = '@keyframes addrToastIn{from{opacity:0;transform:translateX(-50%) translateY(-20px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}';
      document.head.appendChild(style);
      document.body.appendChild(toast);
      setTimeout(function(){ toast.style.transition='opacity 0.5s'; toast.style.opacity='0'; }, 5000);
      setTimeout(function(){ if(toast.parentNode) toast.parentNode.removeChild(toast); }, 5500);
    } else if (attempts < maxAttempts) {
      setTimeout(tryFill, 1500);
    } else {
      console.log('[AddressAutoFill] Could not find address fields after ' + maxAttempts + ' attempts');
    }
  }

  // 首次延迟2秒等结算页面加载
  setTimeout(tryFill, 2000);
})()
`
}

/**
 * 判断URL是否为结算/确认订单页面
 */
function isCheckoutPage(url, platform) {
  if (!url) return false
  const lower = url.toLowerCase()
  const patterns = CHECKOUT_URL_PATTERNS[platform] || []
  return patterns.some(p => lower.includes(p.toLowerCase()))
}

/**
 * 轮询检测地址填充结果，成功后通知主窗口
 */
function pollAddressFillResult(win, mainWindow, purchaseNo) {
  let checkCount = 0
  const maxChecks = 15 // 最多检测30秒
  const timer = setInterval(() => {
    checkCount++
    if (!win || win.isDestroyed() || checkCount > maxChecks) {
      clearInterval(timer)
      return
    }
    win.webContents.executeJavaScript('window.__addressAutoFillResult || 0')
      .then(result => {
        if (result > 0) {
          clearInterval(timer)
          console.log(`[PurchaseCapture] Address fill confirmed: ${result} fields`)
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('purchase-address-filled', {
              purchaseNo,
              filledCount: result
            })
          }
        }
      })
      .catch(() => {})
  }, 2000)
}

// ============ 平台订单号检测 ============

// 平台配置：URL关键词 + 字段名 + 最小长度
const PLATFORM_DETECTION = {
  taobao: {
    urlKeywords: ['submitOrder', 'create_order', 'buy_now', 'confirmOrder', 'buyertrade', 'createOrder', 'placeOrder'],
    fields: ['orderId', 'bizOrderId', 'tradeNo', 'orderIds'],
    minLength: 15
  },
  pinduoduo: {
    urlKeywords: ['order/submit', 'order_confirm', 'create_order', 'order/create', 'bg_order'],
    fields: ['order_sn', 'order_id', 'orderSn', 'orderId'],
    minLength: 10
  },
  '1688': {
    urlKeywords: ['trade/create', 'order/create', 'fastCreate', 'trademanager', 'createOrder'],
    fields: ['orderId', 'orderNo', 'tradeId'],
    minLength: 10
  }
}

/**
 * 递归搜索 JSON 对象中的目标字段
 * @param {object} obj - JSON对象
 * @param {string[]} targetFields - 要查找的字段名
 * @param {number} minLen - 值的最小长度
 * @param {number} depth - 当前深度
 * @returns {string|null} 找到的订单号
 */
function deepSearch(obj, targetFields, minLen, depth) {
  if (depth > 4 || !obj || typeof obj !== 'object') return null

  for (const key of Object.keys(obj)) {
    const val = obj[key]

    // 检查是否是目标字段
    if (targetFields.includes(key)) {
      // 值是字符串或数字
      if (typeof val === 'string' && /^\d+$/.test(val) && val.length >= minLen) {
        return val
      }
      if (typeof val === 'number' && String(val).length >= minLen) {
        return String(val)
      }
      // 值是数组（如 orderIds）
      if (Array.isArray(val) && val.length > 0) {
        const first = val[0]
        if (typeof first === 'string' && /^\d+$/.test(first) && first.length >= minLen) {
          return first
        }
        if (typeof first === 'number' && String(first).length >= minLen) {
          return String(first)
        }
      }
    }

    // 递归搜索子对象
    if (typeof val === 'object' && val !== null) {
      const found = deepSearch(val, targetFields, minLen, depth + 1)
      if (found) return found
    }
  }
  return null
}

/**
 * 从捕获的响应中检测订单号
 */
function detectOrderNo(responses, platform) {
  const config = PLATFORM_DETECTION[platform]
  if (!config) return null

  for (const r of responses) {
    // 先检查 URL 是否匹配关键词（收窄范围，减少误判）
    const urlLower = (r.url || '').toLowerCase()
    const urlMatch = config.urlKeywords.some(kw => urlLower.includes(kw.toLowerCase()))
    if (!urlMatch) continue

    // 尝试解析 JSON
    try {
      const json = JSON.parse(r.body)
      const orderNo = deepSearch(json, config.fields, config.minLength, 0)
      if (orderNo) {
        console.log(`[PurchaseCapture] Order detected! platform=${platform}, orderNo=${orderNo}, url=${r.url.substring(0, 100)}`)
        return orderNo
      }
    } catch (e) {
      // 非 JSON 响应，跳过
    }
  }
  return null
}

// ============ IPC 注册 ============

function registerPurchaseOrderCaptureIpc(mainWindow) {
  // 打开采购下单窗口
  ipcMain.handle('open-purchase-order-window', async (event, params) => {
    const { accountId, purchaseUrl, platform, purchaseInfo } = params
    const { purchaseNo } = purchaseInfo

    // 防重复
    if (activePurchaseWindows.has(purchaseNo)) {
      const existing = activePurchaseWindows.get(purchaseNo)
      if (existing.win && !existing.win.isDestroyed()) {
        existing.win.focus()
        return { success: true, message: '窗口已打开' }
      }
    }

    const partitionName = `persist:purchase-${accountId}`
    console.log(`[PurchaseCapture] Opening window: partition=${partitionName}, url=${purchaseUrl}`)

    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      title: `采购下单 - ${platform}`,
      webPreferences: {
        partition: partitionName,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    let resolved = false
    let pollTimer = null
    const windowState = { win, pollTimer, resolved }
    activePurchaseWindows.set(purchaseNo, windowState)

    function cleanup() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      windowState.pollTimer = null
      activePurchaseWindows.delete(purchaseNo)
    }

    function onOrderCaptured(platformOrderNo) {
      if (resolved) return
      resolved = true
      windowState.resolved = true
      cleanup()

      // 自动调用服务端API创建采购单和绑定
      autoCreateAndBind(purchaseInfo, platformOrderNo, platform)
        .then(() => {
          console.log(`[PurchaseCapture] Auto-bindSuccess: purchaseNo=${purchaseNo}, orderNo=${platformOrderNo}`)
        })
        .catch(err => {
          console.error(`[PurchaseCapture] Auto-bind failed:`, err.message)
        })

      // 通知前端
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('purchase-order-captured', {
          purchaseNo,
          platformOrderNo,
          platform
        })
      }

      // 3秒后关闭窗口
      setTimeout(() => {
        if (win && !win.isDestroyed()) {
          win.destroy()
        }
      }, 3000)
    }

    function onWindowClosed() {
      if (resolved) return
      resolved = true
      windowState.resolved = true
      cleanup()

      // 通知前端：未捕获到订单号
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('purchase-window-closed', {
          purchaseNo,
          captured: false
        })
      }
    }

    // 注入 API 拦截器 + 地址自动填充
    win.webContents.on('dom-ready', () => {
      if (win.isDestroyed() || resolved) return
      win.webContents.executeJavaScript(PURCHASE_INTERCEPTOR).catch(() => {})
      console.log('[PurchaseCapture] Interceptor injected')

      // 检测是否为结算页面，是则注入地址填充脚本
      const currentUrl = win.webContents.getURL()
      const { shippingName, shippingPhone, shippingAddress } = purchaseInfo
      if (shippingName || shippingPhone || shippingAddress) {
        if (isCheckoutPage(currentUrl, platform)) {
          const fillScript = buildAddressAutoFillScript(shippingName, shippingPhone, shippingAddress, platform)
          win.webContents.executeJavaScript(fillScript).catch(() => {})
          console.log(`[PurchaseCapture] Address auto-fill injected for checkout page: ${currentUrl.substring(0, 80)}`)
        }
      }
    })

    // 页面导航后也检测（用户从商品页跳转到结算页）
    win.webContents.on('did-navigate', (event, url) => {
      if (win.isDestroyed() || resolved) return
      const { shippingName, shippingPhone, shippingAddress } = purchaseInfo
      if ((shippingName || shippingPhone || shippingAddress) && isCheckoutPage(url, platform)) {
        // 等待 dom-ready 会自动注入，但 SPA 页面可能不触发 dom-ready，这里延迟补充注入
        setTimeout(() => {
          if (win.isDestroyed() || resolved) return
          const fillScript = buildAddressAutoFillScript(shippingName, shippingPhone, shippingAddress, platform)
          win.webContents.executeJavaScript(fillScript).catch(() => {})
          pollAddressFillResult(win, mainWindow, purchaseNo)
          console.log(`[PurchaseCapture] Address auto-fill injected after navigation: ${url.substring(0, 80)}`)
        }, 3000)
      }
    })

    // SPA内的hash/pushState导航
    win.webContents.on('did-navigate-in-page', (event, url) => {
      if (win.isDestroyed() || resolved) return
      const { shippingName, shippingPhone, shippingAddress } = purchaseInfo
      if ((shippingName || shippingPhone || shippingAddress) && isCheckoutPage(url, platform)) {
        setTimeout(() => {
          if (win.isDestroyed() || resolved) return
          const fillScript = buildAddressAutoFillScript(shippingName, shippingPhone, shippingAddress, platform)
          win.webContents.executeJavaScript(fillScript).catch(() => {})
          console.log(`[PurchaseCapture] Address auto-fill injected after in-page navigation: ${url.substring(0, 80)}`)
        }, 3000)
      }
    })

    // 窗口关闭
    win.on('closed', () => {
      onWindowClosed()
    })

    // 加载 URL
    try {
      await win.loadURL(purchaseUrl)
    } catch (e) {
      console.error('[PurchaseCapture] loadURL failed:', e.message)
    }

    // 启动轮询检测订单号
    pollTimer = setInterval(() => {
      if (win.isDestroyed() || resolved) {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        return
      }

      win.webContents.executeJavaScript(READ_CAPTURED_PURCHASES)
        .then(responses => {
          if (!responses || responses.length === 0) return
          console.log(`[PurchaseCapture] Poll: ${responses.length} new responses`)

          const orderNo = detectOrderNo(responses, platform)
          if (orderNo) {
            onOrderCaptured(orderNo)
          }
        })
        .catch(() => {})
    }, 2000)

    windowState.pollTimer = pollTimer

    return { success: true }
  })

  // 关闭采购下单窗口
  ipcMain.handle('close-purchase-order-window', async (event, { purchaseNo }) => {
    const state = activePurchaseWindows.get(purchaseNo)
    if (state && state.win && !state.win.isDestroyed()) {
      state.win.destroy()
    }
    return { success: true }
  })
}

/**
 * 自动调用服务端 API 创建采购单并绑定
 */
async function autoCreateAndBind(purchaseInfo, platformOrderNo, platform) {
  const { purchaseNo, salesOrderId, salesOrderNo, goodsName, sku, skuId, quantity, purchasePrice, remark, sourceUrl, purchaseType, shippingName, shippingPhone, shippingAddress } = purchaseInfo

  // 1. 创建采购单
  await httpRequest(`${BUSINESS_SERVER}/api/purchase-orders`, {
    method: 'POST',
    body: JSON.stringify({
      purchase_no: purchaseNo,
      sales_order_id: salesOrderId,
      sales_order_no: salesOrderNo,
      goods_name: goodsName,
      sku: sku,
      quantity: quantity,
      source_url: sourceUrl,
      platform: platform,
      purchase_price: purchasePrice,
      remark: remark,
      purchase_type: purchaseType || 'dropship',
      shipping_name: shippingName || '',
      shipping_phone: shippingPhone || '',
      shipping_address: shippingAddress || ''
    })
  })

  // 2. 绑定平台订单号
  await httpRequest(`${BUSINESS_SERVER}/api/purchase-orders/${purchaseNo}/bind`, {
    method: 'PUT',
    body: JSON.stringify({
      platform_order_no: platformOrderNo
    })
  })

  // 3. 保存 SKU 采购配置
  if (skuId) {
    await httpRequest(`${BUSINESS_SERVER}/api/sku-purchase-config`, {
      method: 'POST',
      body: JSON.stringify({
        sku_id: skuId,
        platform: platform,
        purchase_link: sourceUrl,
        purchase_price: purchasePrice,
        remark: remark
      })
    })
  }
}

module.exports = { registerPurchaseOrderCaptureIpc }
module.exports = { registerPurchaseOrderCaptureIpc }
