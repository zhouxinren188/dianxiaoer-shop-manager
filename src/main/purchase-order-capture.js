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
 * 生成地址自动填充脚本（多阶段策略）
 * 阶段1: 淘宝特定选择器（J_Name等）
 * 阶段2: 宽泛的label/上下文文本匹配
 * 阶段3: 点击"使用新地址"按钮触发表单显示
 * 阶段4: 若全部失败，展示浮动提示帮助用户手动复制
 */
function buildAddressAutoFillScript(shippingName, shippingPhone, shippingAddress, platform) {
  // 先转义反斜杠，再转义单引号（顺序很重要）
  const name = (shippingName || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const phone = (shippingPhone || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const addr = (shippingAddress || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")

  return `
(function() {
  if (window.__addressAutoFillDone) return;
  var targetName = '${name}';
  var targetPhone = '${phone}';
  var targetAddr = '${addr}';
  if (!targetName && !targetPhone && !targetAddr) return;

  console.log('[AddressAutoFill] Start. platform=${platform}, name=' + targetName + ', phone=' + targetPhone + ', addr=' + targetAddr.substring(0, 30));

  // ---- 辅助函数 ----

  // 模拟输入（兼容React/Vue等框架的数据绑定）
  function simulateType(el, value) {
    if (!el || !value) return false;
    try {
      var proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) {
        setter.set.call(el, value);
      } else {
        el.value = value;
      }
    } catch(e) {
      el.value = value;
    }
    el.focus();
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    // React 16+ 需要额外的合成事件
    try {
      var nativeEvent = new Event('input', { bubbles: true });
      Object.defineProperty(nativeEvent, 'target', { writable: false, value: el });
      Object.defineProperty(nativeEvent, 'currentTarget', { writable: false, value: el });
      el.dispatchEvent(nativeEvent);
    } catch(e) {}
    return true;
  }

  // 判断元素是否可见
  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // 获取输入框周围的上下文文本（用于匹配字段含义）
  function getContextText(el) {
    var texts = [];
    // placeholder / aria-label / name / id
    if (el.placeholder) texts.push(el.placeholder);
    if (el.getAttribute('aria-label')) texts.push(el.getAttribute('aria-label'));
    if (el.name) texts.push(el.name);
    if (el.id) texts.push(el.id);
    // 关联的 <label for="...">
    if (el.id) {
      var lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl) texts.push(lbl.textContent);
    }
    // 父级 <label> 包裹
    var parentLabel = el.closest('label');
    if (parentLabel) texts.push(parentLabel.textContent);
    // 前面的兄弟元素文本
    var prev = el.previousElementSibling;
    if (prev) texts.push(prev.textContent);
    // 父元素中排除输入框后的文本
    var parent = el.parentElement;
    if (parent) {
      var clone = parent.cloneNode(true);
      var kids = clone.querySelectorAll('input, textarea, select');
      kids.forEach(function(k) { k.remove(); });
      var pt = clone.textContent.trim();
      if (pt.length < 50) texts.push(pt);
    }
    // 最近的表单项容器
    var wrapper = el.closest('.form-item, .form-group, .field, .item, [class*="form-item"], [class*="field-item"], [class*="addr-item"], [class*="address-item"], .next-form-item');
    if (wrapper) {
      var wClone = wrapper.cloneNode(true);
      var wKids = wClone.querySelectorAll('input, textarea, select');
      wKids.forEach(function(k) { k.remove(); });
      var wt = wClone.textContent.trim();
      if (wt.length < 80) texts.push(wt);
    }
    return texts.join(' ');
  }

  // ---- 阶段1: 平台特定选择器 ----
  function tryPlatformSpecific() {
    var filled = 0;
    // 淘宝/天猫常用选择器
    var tbNameSelectors = '#J_Name, #consignee-name, input[name="receiverName"], input[name="consigneeName"], input[data-meta="Field"][aria-label*="收货人"], input[aria-label*="收货人"]';
    var tbPhoneSelectors = '#J_Phone, #J_Mobile, input[name="receiverMobile"], input[name="receiverPhone"], input[name="consigneeMobile"], input[data-meta="Field"][aria-label*="手机"], input[aria-label*="手机"]';
    var tbAddrSelectors = '#J_DetailAddr, #J_Addr, textarea[name="receiverAddress"], textarea[name="detailAddress"], input[name="receiverAddress"], textarea[data-meta="Field"][aria-label*="地址"], textarea[aria-label*="地址"]';

    if (targetName) {
      var nameEl = document.querySelector(tbNameSelectors);
      if (nameEl && isVisible(nameEl)) { simulateType(nameEl, targetName); filled++; console.log('[AddressAutoFill] Phase1: filled name via platform selector'); }
    }
    if (targetPhone) {
      var phoneEl = document.querySelector(tbPhoneSelectors);
      if (phoneEl && isVisible(phoneEl)) { simulateType(phoneEl, targetPhone); filled++; console.log('[AddressAutoFill] Phase1: filled phone via platform selector'); }
    }
    if (targetAddr) {
      var addrEl = document.querySelector(tbAddrSelectors);
      if (addrEl && isVisible(addrEl)) { simulateType(addrEl, targetAddr); filled++; console.log('[AddressAutoFill] Phase1: filled address via platform selector'); }
    }
    return filled;
  }

  // ---- 阶段2: 上下文文本智能匹配 ----
  function tryContextMatch() {
    var allInputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="image"]):not([type="file"]):not([type="password"]), textarea');
    var nameField = null, phoneField = null, addrField = null;
    var filled = 0;

    for (var i = 0; i < allInputs.length; i++) {
      var el = allInputs[i];
      if (!isVisible(el)) continue;
      var ctx = getContextText(el);
      console.log('[AddressAutoFill] Phase2: input[' + i + '] ctx="' + ctx.substring(0, 80).replace(/\\n/g, ' ') + '" tag=' + el.tagName);

      if (!nameField && ctx.match(/收货人|姓名|收件人|联系人|consignee|receiver(?!Addr)/i) && targetName) {
        nameField = el;
      } else if (!phoneField && ctx.match(/手机|电话|联系电话|手机号|mobile|phone|tel/i) && targetPhone) {
        phoneField = el;
      } else if (!addrField && ctx.match(/详细地址|收货地址|街道|所在地址|地址信息|detailaddr|address/i) && targetAddr) {
        addrField = el;
      }
    }

    if (nameField) { simulateType(nameField, targetName); filled++; console.log('[AddressAutoFill] Phase2: filled name'); }
    if (phoneField) { simulateType(phoneField, targetPhone); filled++; console.log('[AddressAutoFill] Phase2: filled phone'); }
    if (addrField) { simulateType(addrField, targetAddr); filled++; console.log('[AddressAutoFill] Phase2: filled address'); }
    return filled;
  }

  // ---- 阶段3: 点击"使用新地址"按钮 ----
  var expandedAddrList = false;
  function tryClickNewAddress() {
    // 第一步：先尝试展开地址列表（淘宝默认折叠，"使用新地址"可能在折叠区内）
    if (!expandedAddrList) {
      var expandPatterns = ['显示全部地址', '展开全部', '更多地址', '全部地址'];
      var allEls = document.querySelectorAll('a, span, div, em, p');
      for (var e = 0; e < allEls.length; e++) {
        var txt = (allEls[e].textContent || '').trim();
        if (txt.length > 20) continue;
        for (var ep = 0; ep < expandPatterns.length; ep++) {
          if (txt.indexOf(expandPatterns[ep]) !== -1) {
            console.log('[AddressAutoFill] Phase3: expanding addr list, clicking "' + txt + '"');
            allEls[e].click();
            expandedAddrList = true;
            return 'expanded';
          }
        }
      }
    }
    // 第二步：查找"使用新地址"按钮
    var triggerPatterns = ['使用新地址', '新增收货地址', '添加新地址', '添加地址', '新增地址', '换个地址', '管理收货地址'];
    var candidates = document.querySelectorAll('a, button, span, div, em, i, p, li');
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var text = (el.textContent || '').trim();
      if (text.length > 20) continue;
      for (var j = 0; j < triggerPatterns.length; j++) {
        if (text.indexOf(triggerPatterns[j]) !== -1) {
          console.log('[AddressAutoFill] Phase3: clicking "' + text + '"');
          el.click();
          return 'clicked';
        }
      }
    }
    var classPatterns = ['.addr-add', '.add-address', '.add-addr', '[data-action="add"]', '.new-addr-btn', '.J_AddNewAddr'];
    for (var k = 0; k < classPatterns.length; k++) {
      var btn = document.querySelector(classPatterns[k]);
      if (btn && isVisible(btn)) {
        console.log('[AddressAutoFill] Phase3: clicking class=' + classPatterns[k]);
        btn.click();
        return 'clicked';
      }
    }
    return false;
  }

  // ---- 成功提示 ----
  function showSuccessToast(filled) {
    var toast = document.createElement('div');
    toast.innerHTML = '\\u2705 地址已自动填充（共' + filled + '个字段），请核对后提交订单';
    toast.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:999999;background:linear-gradient(135deg,#52c41a,#73d13d);color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:500;box-shadow:0 4px 16px rgba(82,196,26,0.4);pointer-events:none;animation:addrToastIn 0.4s ease;';
    var style = document.createElement('style');
    style.textContent = '@keyframes addrToastIn{from{opacity:0;transform:translateX(-50%) translateY(-20px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}';
    document.head.appendChild(style);
    document.body.appendChild(toast);
    setTimeout(function(){ toast.style.transition='opacity 0.5s'; toast.style.opacity='0'; }, 5000);
    setTimeout(function(){ if(toast.parentNode) toast.parentNode.removeChild(toast); }, 5500);
  }

  // ---- 失败时显示地址信息浮窗，方便用户手动复制 ----
  function showFallbackPanel() {
    console.log('[AddressAutoFill] All attempts failed, showing fallback panel');
    // 移除已有面板
    var old = document.getElementById('__addrFillPanel');
    if (old) old.parentNode.removeChild(old);

    var panel = document.createElement('div');
    panel.id = '__addrFillPanel';
    panel.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:999999;background:#fff;border:2px solid #e6a23c;border-radius:10px;padding:14px 18px;box-shadow:0 4px 20px rgba(0,0,0,0.15);font-size:13px;line-height:1.8;max-width:340px;font-family:system-ui,sans-serif;';
    var html = '<div style="font-weight:600;color:#e6a23c;margin-bottom:6px;">\\u26A0 地址未能自动填充，请手动填写：</div>';
    if (targetName) html += '<div><b>收货人：</b><span data-af="name" style="cursor:pointer;color:#409eff;border-bottom:1px dashed #409eff" title="点击复制">' + targetName + '</span></div>';
    if (targetPhone) html += '<div><b>手机号：</b><span data-af="phone" style="cursor:pointer;color:#409eff;border-bottom:1px dashed #409eff" title="点击复制">' + targetPhone + '</span></div>';
    if (targetAddr) html += '<div><b>地　址：</b><span data-af="addr" style="cursor:pointer;color:#409eff;border-bottom:1px dashed #409eff" title="点击复制">' + targetAddr + '</span></div>';
    html += '<div style="color:#909399;font-size:11px;margin-top:6px;">点击蓝色文字可复制</div>';
    html += '<div style="text-align:right;margin-top:8px;"><span data-af="close" style="cursor:pointer;color:#909399;font-size:12px;padding:4px 8px;">关闭 X</span></div>';
    panel.innerHTML = html;
    document.body.appendChild(panel);

    // 关闭按钮 - 直接用 onclick 赋值（比 addEventListener 更可靠）
    var closeBtn = panel.querySelector('[data-af="close"]');
    if (closeBtn) {
      closeBtn.onclick = function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (panel.parentNode) panel.parentNode.removeChild(panel);
      };
    }

    // 点击复制功能
    var copySpans = panel.querySelectorAll('[data-af="name"], [data-af="phone"], [data-af="addr"]');
    for (var ci = 0; ci < copySpans.length; ci++) {
      (function(span) {
        span.onclick = function() {
          var txt = span.textContent.replace(' \\u2713\\u5df2\\u590d\\u5236', '');
          navigator.clipboard.writeText(txt).then(function() {
            span.style.color = '#67c23a';
            span.textContent = txt + ' \\u2713\\u5df2\\u590d\\u5236';
            setTimeout(function() { span.style.color = '#409eff'; span.textContent = txt; }, 1500);
          }).catch(function() {});
        };
      })(copySpans[ci]);
    }
  }

  // ---- 主流程：多阶段重试 ----
  var attempts = 0;
  var maxAttempts = 15;
  var phase3Done = false;

  function tryFill() {
    attempts++;
    console.log('[AddressAutoFill] Attempt ' + attempts + '/' + maxAttempts);

    // 阶段1: 平台特定选择器
    var filled = tryPlatformSpecific();
    if (filled > 0) {
      window.__addressAutoFillDone = true;
      window.__addressAutoFillResult = filled;
      console.log('[AddressAutoFill] Success via Phase1! filled=' + filled);
      showSuccessToast(filled);
      return;
    }

    // 阶段2: 上下文文本匹配
    filled = tryContextMatch();
    if (filled > 0) {
      window.__addressAutoFillDone = true;
      window.__addressAutoFillResult = filled;
      console.log('[AddressAutoFill] Success via Phase2! filled=' + filled);
      showSuccessToast(filled);
      return;
    }

    // 阶段3: 尝试展开地址列表 / 点击"使用新地址"（前5次尝试内）
    if (!phase3Done && attempts <= 5) {
      var result = tryClickNewAddress();
      if (result === 'expanded') {
        // 展开了地址列表，等一下再找"使用新地址"
        setTimeout(tryFill, 2000);
        return;
      } else if (result === 'clicked') {
        // 点击了"使用新地址"，等表单出现
        phase3Done = true;
        setTimeout(tryFill, 2500);
        return;
      }
    }

    // 继续重试
    if (attempts < maxAttempts) {
      setTimeout(tryFill, 2000);
    } else {
      // 全部失败，显示回退面板
      window.__addressAutoFillResult = -1;
      showFallbackPanel();
    }
  }

  // 首次延迟2秒等结算页面加载完成
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

    // 从服务器加载Cookie并注入到session
    const ses = session.fromPartition(partitionName)
    try {
      const cookieRes = await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookie`, {
        method: 'GET'
      })
      if (cookieRes.statusCode === 200 && cookieRes.data) {
        const json = JSON.parse(cookieRes.data)
        if (json.code === 0 && json.data && json.data.cookie_data) {
          const cookies = typeof json.data.cookie_data === 'string'
            ? JSON.parse(json.data.cookie_data)
            : json.data.cookie_data
          if (Array.isArray(cookies) && cookies.length > 0) {
            let injected = 0
            for (const ck of cookies) {
              try {
                const cookieDetails = {
                  url: `https://${ck.domain ? ck.domain.replace(/^\./, '') : 'taobao.com'}${ck.path || '/'}`,
                  name: ck.name,
                  value: ck.value,
                  domain: ck.domain,
                  path: ck.path || '/',
                  secure: ck.secure || false,
                  httpOnly: ck.httpOnly || false
                }
                if (ck.expirationDate && ck.expirationDate > 0) {
                  cookieDetails.expirationDate = ck.expirationDate
                }
                await ses.cookies.set(cookieDetails)
                injected++
              } catch (e) { /* skip invalid cookies */ }
            }
            console.log(`[PurchaseCapture] Cookie restored: ${injected}/${cookies.length} from server`)
          }
        }
      }
    } catch (e) {
      console.warn('[PurchaseCapture] Cookie restore failed:', e.message)
    }

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
          pollAddressFillResult(win, mainWindow, purchaseNo)
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
          pollAddressFillResult(win, mainWindow, purchaseNo)
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
