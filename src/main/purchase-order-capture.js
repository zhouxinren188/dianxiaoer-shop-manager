const { BrowserWindow, ipcMain, session } = require('electron')
const path = require('path')
const http = require('http')
const { getAuthToken } = require('./auth-store')
const ProvinceData = require('./province-data')

const BUSINESS_SERVER = 'http://150.158.54.108:3002'

// 活跃的采购下单窗口 Map<purchaseNo, { win, pollTimer, resolved }>
const activePurchaseWindows = new Map()

// 验证商品标题：拒绝明显来自非商品页的标题
function isValidProductTitle(title) {
  if (!title || title.length < 2) return false
  const invalidPatterns = /^(登录|支付宝|收银台|安全验证|付款|验证码|ALIPAY|LOGIN|PAYMENT|CAPTCHA)/i
  if (invalidPatterns.test(title)) return false
  // 标题过短（<=3字符）且不含连续中文，不太可能是真实商品名
  if (title.length <= 3 && !/[\u4e00-\u9fff]{2,}/.test(title)) return false
  return true
}

// 验证商品图片：拒绝来自支付/登录页的图片
function isValidProductImage(image) {
  if (!image) return false
  const lower = image.toLowerCase()
  if (lower.includes('alipay.com') || lower.includes('captcha')) return false
  return true
}

// 非阻塞版 flushStorageData：后台执行刷盘，不阻塞窗口创建和页面加载
// cookie 已通过 ses.cookies.set() 写入内存，即使刷盘未完成也能被后续请求使用
function flushStorageDataAsync(ses) {
  ses.flushStorageData(() => {
    console.log('[PurchaseCapture] flushStorageData completed (async)')
  })
}

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

// ============ 反检测指纹伪装脚本（注入到页面主世界） ============
// contextIsolation=true 下 preload 的 window 修改对页面不可见
// ★ 已废弃：反检测现在由 purchase-preload.js 在页面 JS 之前注入（contextIsolation=false）
// 此常量保留但不再在 dom-ready 中使用
const ANTI_DETECT_SCRIPT = `
(function() {
  if (window.__antiDetectInstalled) return;
  window.__antiDetectInstalled = true;

  // 1. 隐藏 webdriver
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });

  // 2. 伪造 plugins
  var fakePlugins = [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
  ];
  var pluginArray = [];
  pluginArray.item = function(i) { return this[i] };
  pluginArray.namedItem = function(name) { for (var i = 0; i < this.length; i++) { if (this[i].name === name) return this[i] } return null };
  pluginArray.refresh = function() {};
  pluginArray.length = fakePlugins.length;
  for (var i = 0; i < fakePlugins.length; i++) {
    var p = { name: fakePlugins[i].name, filename: fakePlugins[i].filename, description: fakePlugins[i].description, length: 0, item: function() { return null }, namedItem: function() { return null } };
    Object.defineProperty(p, 'length', { value: 0, configurable: false });
    pluginArray[i] = p;
  }
  Object.defineProperty(navigator, 'plugins', { get: function() { return pluginArray }, configurable: true });

  // 3. 伪造 mimeTypes
  var fakeMimes = [
    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
    { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' }
  ];
  var mimeArray = [];
  mimeArray.item = function(i) { return this[i] };
  mimeArray.namedItem = function(name) { for (var i = 0; i < this.length; i++) { if (this[i].type === name) return this[i] } return null };
  mimeArray.length = fakeMimes.length;
  for (var i = 0; i < fakeMimes.length; i++) {
    var m = { type: fakeMimes[i].type, suffixes: fakeMimes[i].suffixes, description: fakeMimes[i].description, enabledPlugin: pluginArray[0] };
    mimeArray[i] = m;
  }
  Object.defineProperty(navigator, 'mimeTypes', { get: function() { return mimeArray }, configurable: true });

  // 4. 伪造 hardwareConcurrency / deviceMemory
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: function() { return 8 }, configurable: true });
  Object.defineProperty(navigator, 'deviceMemory', { get: function() { return 8 }, configurable: true });

  // 5. 伪造 languages
  Object.defineProperty(navigator, 'languages', { get: function() { return ['zh-CN', 'zh', 'en-US', 'en'] }, configurable: true });

  // 6. 伪造 platform
  Object.defineProperty(navigator, 'platform', { get: function() { return 'Win32' }, configurable: true });

  // 7. Canvas 指纹噪声
  var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function() {
    var ctx = this.getContext('2d');
    if (ctx && this.width > 0 && this.height > 0) { var imgData = ctx.getImageData(0, 0, 1, 1); imgData.data[3] = imgData.data[3] ^ 1; ctx.putImageData(imgData, 0, 0); }
    return origToDataURL.apply(this, arguments);
  };
  var origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function() {
    var ctx = this.getContext('2d');
    if (ctx && this.width > 0 && this.height > 0) { var imgData = ctx.getImageData(0, 0, 1, 1); imgData.data[3] = imgData.data[3] ^ 1; ctx.putImageData(imgData, 0, 0); }
    return origToBlob.apply(this, arguments);
  };

  // 8. WebGL 指纹伪装
  var origGetParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Intel Inc.';
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return origGetParam.call(this, param);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    var origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return origGetParam2.call(this, param);
    };
  }

  // 9. AudioContext 指纹噪声
  var origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
  AnalyserNode.prototype.getFloatFrequencyData = function(arr) {
    origGetFloatFreq.call(this, arr);
    for (var i = 0; i < arr.length; i++) { arr[i] += Math.random() * 0.0001; }
  };

  // 10. 隐藏 Automation 属性
  delete window.__nightmare; delete window._phantom; delete window.__phantomas;
  delete window.callPhantom; delete window._selenium; delete window._Selenium_IDE_Recorder;
  delete window.__webdriver_evaluate; delete window.__selenium_evaluate; delete window.__fxdriver_evaluate;
  delete window.__driver_unwrapped; delete window.__webdriver_unwrapped;
  delete window.__driver_evaluate; delete window.__selenium_unwrapped; delete window.__fxdriver_unwrapped;

  // 11. permissions API
  if (navigator.permissions && navigator.permissions.query) {
    var origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = function(params) {
      if (params.name === 'notifications') return Promise.resolve({ state: 'default', onchange: null });
      return origQuery(params);
    };
  }

  // 12. chrome.runtime
  if (window.chrome && !window.chrome.runtime) {
    window.chrome.runtime = { connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {}, disconnect: function() {} } }, sendMessage: function() {}, onMessage: { addListener: function() {} }, id: undefined };
  }

  // 13. chrome.csi / loadTimes
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.csi) window.chrome.csi = function() {};
  if (!window.chrome.loadTimes) window.chrome.loadTimes = function() {
    var now = Date.now() / 1000;
    return { commitLoadTime: now, connectionInfo: 'h2', finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintAfterLoadTime: 0, firstPaintTime: 0, navigationType: 'Other', npnNegotiatedProtocol: 'h2', requestTime: now - 0.5, startLoadTime: now - 0.5, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true };
  };

  // 14. outerWidth/outerHeight
  if (window.outerWidth === 0) Object.defineProperty(window, 'outerWidth', { get: function() { return window.innerWidth }, configurable: true });
  if (window.outerHeight === 0) Object.defineProperty(window, 'outerHeight', { get: function() { return window.innerHeight + 85 }, configurable: true });
})()
`

// ============ API 拦截器脚本（捕获 + 实时订单号检测） ============
// 核心改进：当API响应到达时，立即检测是否包含订单号
// 通过 console.log 特殊前缀 [PURCHASE_ORDER_FOUND] 即时通知主进程
// 这样即使页面马上跳转（JS上下文销毁），主进程也能收到订单号
const PURCHASE_INTERCEPTOR = `
(function() {
  if (window.__purchaseInterceptorInstalled) return;
  window.__purchaseInterceptorInstalled = true;
  window.__capturedPurchaseResponses = [];

  // 实时检测响应中的订单号（淘宝DL系统方案 + 拼多多扩展）
  // 淘宝优先级：b2c_orid > bizOrderId > orderId（最小15位，避免误抓trade_no）
  // 拼多多优先级：order_sn > orderSn（最小10位，对齐DL系统）
  function checkForOrderNo(body) {
    if (!body || body.length < 10) return;

    // 1. b2c_orid（淘宝DL系统核心，最可靠）
    var pos = body.indexOf('b2c_orid=');
    if (pos >= 0) {
      var start = pos + 9;
      var end = body.indexOf('&', start);
      if (end < 0) end = body.indexOf('"', start);
      if (end < 0) end = body.indexOf("'", start);
      if (end < 0) end = body.indexOf(';', start);
      if (end > start) {
        var orid = body.substring(start, end).trim();
        if (/^\\d{10,}$/.test(orid)) {
          console.log('[PURCHASE_ORDER_FOUND]' + orid);
          return;
        }
      }
    }

    // 2. JSON字段检测
    try {
      var json = JSON.parse(body);

      // 通用搜索函数（支持不同最小长度和正则，避免动态构造正则）
      function searchFields(obj, targetFields, minLen, depth, pattern) {
        if (depth > 4 || !obj || typeof obj !== 'object') return null;
        for (var key of Object.keys(obj)) {
          var val = obj[key];
          if (targetFields.indexOf(key) >= 0) {
            if (typeof val === 'string' && pattern.test(val) && val.length >= minLen) return val;
            if (typeof val === 'number' && String(val).length >= minLen) return String(val);
            if (Array.isArray(val) && val.length > 0) {
              var first = val[0];
              if (typeof first === 'string' && pattern.test(first) && first.length >= minLen) return first;
              if (typeof first === 'number' && String(first).length >= minLen) return String(first);
            }
          }
          if (typeof val === 'object' && val !== null) {
            var found = searchFields(val, targetFields, minLen, depth + 1, pattern);
            if (found) return found;
          }
        }
        return null;
      }

      // 2a. 淘宝/天猫字段（最小15位，纯数字，避免误抓trade_no）
      var tbFields = ['b2c_orid', 'bizOrderId', 'biz_order_id', 'orderId', 'order_id'];
      var tbOrder = searchFields(json, tbFields, 15, 0, /^\\d+$/);
      if (tbOrder) {
        console.log('[PURCHASE_ORDER_FOUND]' + tbOrder);
        return;
      }

      // 2b. 拼多多字段（最小10位，字母数字+连字符，如"260506-070338506260381"）
      var pddFields = ['order_sn', 'orderSn'];
      var pddOrder = searchFields(json, pddFields, 10, 0, /^[A-Za-z0-9\-]+$/);
      if (pddOrder) {
        console.log('[PURCHASE_ORDER_FOUND]' + pddOrder);
        return;
      }
    } catch(e) {}
  }

  // 实时从API响应中提取商品信息并缓存（关键！订单号捕获时页面可能已跳转到支付宝）
  // ★ PDD页面跳过此函数：PDD的API响应（如faas-leo）会返回"商城"等错误数据
  //   PDD商品信息改由结算页DOM提取 + 订单搜索API获取
  function cacheProductInfoFromBody(body, url) {
    if (!body || body.length < 50 || window.__cachedProductInfo) return;
    // ★ PDD页面跳过：yangkeduo/pinduoduo域名的API响应不含可靠商品信息
    if (url && (url.indexOf('yangkeduo') >= 0 || url.indexOf('pinduoduo') >= 0)) return;
    try {
      var json = JSON.parse(body);
      // 淘宝/天猫订单确认/提交接口
      var items = json.data && (json.data.orderDatas || json.data.cartInfo || json.data.itemList || json.data.items || json.data.cartItems);
      if (items && items.length > 0) {
        var item = items[0];
        var title = item.title || item.itemTitle || item.productName || '';
        var image = item.pic || item.picPath || item.itemPic || item.productImage || item.imageUrl || '';
        var sku = item.skuText || item.skuInfo || item.specValues || '';
        if (title || image) {
          window.__cachedProductInfo = { title: title, image: image, sku: sku };
          console.log('[PURCHASE_PRODUCT_CACHED]' + JSON.stringify(window.__cachedProductInfo));
        }
      }
      // 1688订单接口
      if (!window.__cachedProductInfo && json.data && json.data.product) {
        var p = json.data.product;
        var pTitle = p.subject || p.title || '';
        var pImage = p.imageUrl || p.picUrl || '';
        if (pTitle || pImage) {
          window.__cachedProductInfo = { title: pTitle, image: pImage, sku: '' };
          console.log('[PURCHASE_PRODUCT_CACHED]' + JSON.stringify(window.__cachedProductInfo));
        }
      }
    } catch(e) {}
  }

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
            // PDD域名响应日志：搞清楚PDD实际API路径
            if (urlStr.indexOf('yangkeduo') >= 0 || urlStr.indexOf('pinduoduo') >= 0) {
              console.log('[PDD_API_CAPTURED]fetch ' + urlStr.substring(0, 150) + ' bodyLen=' + body.length);
              // ★ PDD订单相关API：打印响应体前500字符，确认order_sn和商品信息
              if (urlStr.indexOf('/proxy/api/order') >= 0 || urlStr.indexOf('order/prepay') >= 0) {
                console.log('[PDD_ORDER_API]fetch ' + urlStr.substring(0, 100) + ' body=' + body.substring(0, 500));
              }
            }
            // 实时检测订单号（关键！不等轮询）
            checkForOrderNo(body);
            // 实时缓存商品信息（传入URL，PDD页面跳过）
            cacheProductInfoFromBody(body, urlStr);
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
          // PDD域名响应日志：搞清楚PDD实际API路径
          if (xhr.__capUrl && (xhr.__capUrl.indexOf('yangkeduo') >= 0 || xhr.__capUrl.indexOf('pinduoduo') >= 0)) {
            console.log('[PDD_API_CAPTURED]xhr ' + xhr.__capUrl.substring(0, 150) + ' bodyLen=' + resp.length);
            // ★ PDD订单相关API：打印完整响应体，确认order_sn和商品信息字段
            if (xhr.__capUrl.indexOf('/proxy/api/order') >= 0 || xhr.__capUrl.indexOf('order/prepay') >= 0) {
              console.log('[PDD_ORDER_API] ' + xhr.__capUrl.substring(0, 100) + ' body=' + resp);
            }
          }
          // 实时检测订单号（关键！不等轮询）
          checkForOrderNo(resp);
          // 实时缓存商品信息（传入URL，PDD页面跳过）
          cacheProductInfoFromBody(resp, xhr.__capUrl);
        }
      } catch(e) {}
    });
    return origSend.call(this, body);
  };
})()
`

// ============ 采购页面商品信息浮层 ============
// 商品详情页：显示完整商品信息（名称、图片、SKU、价格、收货地址）
// 结算页：只显示收货地址信息，方便核对地址是否修改正确
const PRODUCT_INFO_OVERLAY = `
(function() {
  var old = document.getElementById('jd-product-overlay');
  if (old) old.remove();

  var info = window.__jdProductInfo;
  if (!info) return '[OVERLAY] skipped: no __jdProductInfo';

  var url = (location.href || '').toLowerCase();

  // === PDD 严格页面过滤（参考 dl：只在商品详情页创建浮层 DOM） ===
  var isPdd = (info.platform || '').indexOf('pinduoduo') >= 0;
  if (isPdd) {
    var isPddGoods = /yangkeduo\\.com\\/goods/.test(url) || /pinduoduo\\.com\\/goods/.test(url);
    if (!isPddGoods) return '[OVERLAY] PDD skipped: not goods page';
  }

  // === 判断是否是结算页 ===
  var isCheckout = url.indexOf('buy.taobao.com') >= 0 ||
                   url.indexOf('buyertrade.taobao.com') >= 0 ||
                   url.indexOf('buy.tmall.com') >= 0 ||
                   url.indexOf('yangkeduo.com/order') >= 0 ||
                   url.indexOf('yangkeduo.com/checkout') >= 0 ||
                   url.indexOf('trade.1688.com') >= 0 ||
                   url.indexOf('buyer.trade.1688.com') >= 0;

  // === PDD结算页不显示浮层（PDD不是隐藏改地址，不需要核对地址） ===
  if (isPdd && isCheckout) return;

  // === DOM 未就绪时延迟重试 ===
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', function() {
      window.__rebuildOverlay && window.__rebuildOverlay();
    });
    return '[OVERLAY] waiting for DOM';
  }

  function buildOverlay() {

  // === 淘宝浮窗左侧，PDD浮窗右侧 ===
  var overlayPos = isPdd ? 'right:20px' : 'left:20px';

  // === 创建浮层容器 ===
  var overlay = document.createElement('div');
  overlay.id = 'jd-product-overlay';
  overlay.style.cssText = 'position:fixed;top:80px;' + overlayPos + ';width:220px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:13px;line-height:1.5;color:#333;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.12);user-select:none;background:#fff;border:1px solid #ebeef5;';

  // === 标题栏 ===
  var header = document.createElement('div');
  header.style.cssText = 'padding:10px 12px;display:flex;align-items:center;justify-content:space-between;cursor:move;border-bottom:1px solid #f0f0f0;background:#fafafa;';

  var titleSpan = document.createElement('span');
  titleSpan.style.cssText = 'font-weight:600;font-size:13px;color:#303133;flex:1;';
  titleSpan.textContent = isCheckout ? '\\u6536\\u8d27\\u5730\\u5740' : '\\u5546\\u54c1\\u4fe1\\u606f';

  var btnGroup = document.createElement('div');
  btnGroup.style.cssText = 'display:flex;gap:8px;';

  var toggleBtn = document.createElement('span');
  toggleBtn.style.cssText = 'cursor:pointer;color:#909399;font-size:12px;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:4px;transition:background .2s;';
  toggleBtn.textContent = '\\u25b2';
  toggleBtn.title = '\\u6536\\u8d77/\\u5c55\\u5f00';

  var closeBtn = document.createElement('span');
  closeBtn.style.cssText = 'cursor:pointer;color:#909399;font-size:16px;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:4px;transition:background .2s;';
  closeBtn.textContent = '\\u00d7';
  closeBtn.title = '\\u5173\\u95ed';

  btnGroup.appendChild(toggleBtn);
  btnGroup.appendChild(closeBtn);
  header.appendChild(titleSpan);
  header.appendChild(btnGroup);

  // === 内容区 ===
  var body = document.createElement('div');
  body.style.cssText = 'padding:12px;max-height:500px;overflow-y:auto;background:#fff;';

  if (isCheckout) {
    // === 结算页模式：只显示收货地址 ===
    if (info.shippingName || info.shippingPhone) {
      var contactRow = document.createElement('div');
      contactRow.style.cssText = 'display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px;';

      if (info.shippingName) {
        var nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'color:#303133;font-weight:500;';
        nameSpan.textContent = info.shippingName;
        contactRow.appendChild(nameSpan);
      }
      if (info.shippingPhone) {
        var phoneSpan = document.createElement('span');
        phoneSpan.style.cssText = 'color:#409eff;font-weight:500;';
        phoneSpan.textContent = info.shippingPhone;
        contactRow.appendChild(phoneSpan);
      }
      body.appendChild(contactRow);
    }

    if (info.shippingAddress) {
      var addrEl = document.createElement('div');
      addrEl.style.cssText = 'font-size:12px;color:#606266;line-height:1.5;word-break:break-all;padding:8px 10px;background:#f5f7fa;border-radius:6px;border:1px solid #ebeef5;';
      addrEl.textContent = info.shippingAddress;
      body.appendChild(addrEl);
    }

    // 如果没有收货信息，显示提示
    if (!info.shippingName && !info.shippingPhone && !info.shippingAddress) {
      var emptyEl = document.createElement('div');
      emptyEl.style.cssText = 'font-size:12px;color:#909399;text-align:center;padding:8px;';
      emptyEl.textContent = '\\u65e0\\u6536\\u8d27\\u5730\\u5740\\u4fe1\\u606f';
      body.appendChild(emptyEl);
    }
  } else {
    // === 商品详情页模式：显示完整商品信息 ===
    // 商品图片（180x180）
    if (info.image) {
      var imgWrap = document.createElement('div');
      imgWrap.style.cssText = 'text-align:center;margin-bottom:10px;';
      var img = document.createElement('img');
      img.src = info.image;
      img.style.cssText = 'width:180px;height:180px;border-radius:6px;object-fit:contain;';
      img.onerror = function() { imgWrap.style.display = 'none'; };
      imgWrap.appendChild(img);
      body.appendChild(imgWrap);
    }

    // 商品名称
    if (info.goodsName) {
      var nameEl = document.createElement('div');
      nameEl.style.cssText = 'font-weight:600;font-size:13px;color:#303133;margin-bottom:4px;word-break:break-all;line-height:1.4;';
      nameEl.textContent = info.goodsName;
      body.appendChild(nameEl);
    }

    // SKU
    if (info.sku) {
      var skuEl = document.createElement('div');
      skuEl.style.cssText = 'font-size:12px;color:#909399;margin-bottom:8px;word-break:break-all;';
      skuEl.textContent = info.sku;
      body.appendChild(skuEl);
    }

    // 数量 + 销售单价
    var priceRow = document.createElement('div');
    priceRow.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:4px;font-size:12px;';

    var qtySpan = document.createElement('span');
    qtySpan.style.color = '#606266';
    qtySpan.textContent = '\\u6570\\u91cf: ' + (info.quantity || 0);

    var priceSpan = document.createElement('span');
    priceSpan.style.color = '#e6a23c';
    priceSpan.style.fontWeight = '500';
    priceSpan.textContent = '\\u5355\\u4ef7: \\u00a5' + (Number(info.price || 0).toFixed(2));

    priceRow.appendChild(qtySpan);
    priceRow.appendChild(priceSpan);
    body.appendChild(priceRow);

    // 采购价
    if (info.purchasePrice) {
      var purchaseRow = document.createElement('div');
      purchaseRow.style.cssText = 'font-size:12px;color:#67c23a;margin-bottom:8px;';
      purchaseRow.textContent = '\\u91c7\\u8d2d\\u4ef7: \\u00a5' + Number(info.purchasePrice).toFixed(2);
      body.appendChild(purchaseRow);
    }

    // 分割线 + 收货信息
    if (info.shippingName || info.shippingPhone || info.shippingAddress) {
      var divider = document.createElement('div');
      divider.style.cssText = 'border-top:1px solid #f0f0f0;margin:8px 0;';
      body.appendChild(divider);

      if (info.shippingName || info.shippingPhone) {
        var contactRow = document.createElement('div');
        contactRow.style.cssText = 'display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;';

        if (info.shippingName) {
          var nameSpan = document.createElement('span');
          nameSpan.style.color = '#606266';
          nameSpan.textContent = info.shippingName;
          contactRow.appendChild(nameSpan);
        }
        if (info.shippingPhone) {
          var phoneSpan = document.createElement('span');
          phoneSpan.style.color = '#606266';
          phoneSpan.textContent = info.shippingPhone;
          contactRow.appendChild(phoneSpan);
        }
        body.appendChild(contactRow);
      }

      if (info.shippingAddress) {
        var addrEl = document.createElement('div');
        addrEl.style.cssText = 'font-size:11px;color:#909399;line-height:1.4;word-break:break-all;';
        addrEl.textContent = info.shippingAddress;
        body.appendChild(addrEl);
      }
    }
  }

  overlay.appendChild(header);
  overlay.appendChild(body);
  document.body.appendChild(overlay);

  // === 收起/展开 ===
  var collapsed = false;
  toggleBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : 'block';
    toggleBtn.textContent = collapsed ? '\\u25bc' : '\\u25b2';
  });

  // === 关闭 ===
  closeBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    overlay.style.display = 'none';
  });

  // === 拖拽 ===
  var dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

  header.addEventListener('mousedown', function(e) {
    if (e.target === toggleBtn || e.target === closeBtn) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    var rect = overlay.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    var dx = e.clientX - startX;
    var dy = e.clientY - startY;
    overlay.style.left = (startLeft + dx) + 'px';
    overlay.style.top = (startTop + dy) + 'px';
    overlay.style.right = 'auto';
  });

  document.addEventListener('mouseup', function() {
    dragging = false;
  });
  }

  // 注册全局重建函数（DOMContentLoaded 回调用）
  window.__rebuildOverlay = function() {
    var old2 = document.getElementById('jd-product-overlay');
    if (old2) old2.remove();
    buildOverlay();
  };

  // 立即构建浮层
  buildOverlay();
})()
`

// ============ 商品链接提取按钮（PDD 浏览窗口专用） ============
const PRODUCT_LINK_EXTRACTOR = `
(function() {
  // ★ 返回按钮（所有页面都显示）
  var oldBack = document.getElementById('dxe-back-btn');
  if (oldBack) oldBack.remove();
  var backBtn = document.createElement('div');
  backBtn.id = 'dxe-back-btn';
  backBtn.innerHTML = '← 返回';
  backBtn.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483647;' +
    'padding:6px 14px;background:rgba(0,0,0,0.55);color:#fff;border-radius:16px;' +
    'font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.2);' +
    'user-select:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif;' +
    'transition:background 0.2s;backdrop-filter:blur(4px);';
  backBtn.addEventListener('mouseenter', function() { this.style.background = 'rgba(0,0,0,0.75)'; });
  backBtn.addEventListener('mouseleave', function() { this.style.background = 'rgba(0,0,0,0.55)'; });
  backBtn.addEventListener('click', function() { history.back(); });
  document.body.appendChild(backBtn);

  // ★ 提取链接按钮（仅商品页显示）
  var old = document.getElementById('dxe-extract-link-btn');
  if (old) old.remove();

  var url = (location.href || '').toLowerCase();
  var isPddGoods = /yangkeduo\\.com\\/goods/.test(url) || /pinduoduo\\.com\\/goods/.test(url);
  if (!isPddGoods) return;

  var btn = document.createElement('div');
  btn.id = 'dxe-extract-link-btn';
  btn.textContent = '提取链接';
  btn.style.cssText = 'position:fixed;bottom:60px;right:20px;z-index:2147483647;' +
    'padding:8px 16px;background:#409eff;color:#fff;border-radius:20px;' +
    'font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.15);' +
    'user-select:none;font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
  document.body.appendChild(btn);

  btn.addEventListener('click', function() {
    var productUrl = location.href;
    // 1. 复制到剪贴板（最可靠，参考 dl 的"复制链接"按钮）
    try { navigator.clipboard.writeText(productUrl); } catch(e) {}
    // 2. 通过原生 window.open 触发主进程 setWindowOpenHandler（自动回填货源链接）
    var openFn = window.__dxeOpen || window.open;
    try { openFn('dxe://product-link?url=' + encodeURIComponent(productUrl)); } catch(e) {}
    // 视觉反馈
    btn.textContent = '已复制链接 ✓';
    btn.style.background = '#67c23a';
    setTimeout(function() {
      btn.textContent = '提取链接';
      btn.style.background = '#409eff';
    }, 1500);
  });
})();
`

// 读取捕获的响应（读后清空）
const READ_CAPTURED_PURCHASES = `
(function() {
  var data = window.__capturedPurchaseResponses || [];
  window.__capturedPurchaseResponses = [];
  return data;
})()
`

// ============ 地址自动填充脚本（参考dl系统） ============

// 各平台地址管理页URL
const ADDRESS_MANAGE_URLS = {
  taobao: 'https://member1.taobao.com/member/fresh/deliver_address.htm',
  '1688': 'https://wuliu.1688.com/foundation/receive_address_manager.htm',
  pinduoduo: 'https://mobile.yangkeduo.com/addresses.html'
}

/**
 * 解析完整地址字符串为省/市/区/详细地址
 * 参考dl系统的Util.parseAddress
 */
function parseAddress(address) {
  if (!address) return null
  address = address.replace(/\s/g, '')
  address = address.replace('其他区', '')

  for (const province in ProvinceData) {
    const cities = ProvinceData[province]
    if (address.indexOf(province) !== 0) continue

    // 去掉省名
    let rest = address.substr(province.length)
    if (rest.startsWith('省') || rest.startsWith('市')) rest = rest.substr(1)
    else if (rest.startsWith('自治区')) rest = rest.substr(3)
    else if (rest.startsWith('壮族自治区') || rest.startsWith('回族自治区')) rest = rest.substr(5)
    else if (rest.startsWith('维吾尔自治区')) rest = rest.substr(6)

    // 匹配城市
    for (const city in cities) {
      const areas = cities[city]
      if (rest.indexOf(city) !== 0) continue
      rest = rest.substr(city.length)
      // 去掉"市"后缀（有些地址写法带市有些不带）
      if (rest.startsWith('市')) rest = rest.substr(1)
      // 匹配区/县
      for (const area of areas) {
        if (rest.indexOf(area) === 0) {
          rest = rest.substr(area.length)
          return { province, city, area, other: rest }
        }
      }
      return { province, city, area: '', other: rest }
    }

    // 没匹配到城市，尝试直接匹配区/县
    for (const city in cities) {
      const areas = cities[city]
      for (const area of areas) {
        if (rest.indexOf(area) === 0) {
          rest = rest.substr(area.length)
          return { province, city, area, other: rest }
        }
      }
    }
    return { province, city: '', area: '', other: rest }
  }
  return null
}

/**
 * 1688地址管理页脚本 (wuliu.1688.com/foundation/receive_address_manager.htm)
 * 参考dl系统：如果地址>=10条先删除，然后点击"新增收货地址"按钮
 * 点击后1688会跳转到 air.1688.com 的地址编辑页面
 */
function build1688AddressManagerScript() {
  return `
(function() {
  if (window.__addrManagerDone) return;
  window.__addrManagerDone = true;
  console.log('[AddressAutoFill] 1688 address manager page loaded');

  if (document.body.innerHTML.indexOf('请重新登录') > 0) {
    console.log('[AddressAutoFill] Need re-login');
    window.__addrManagerResult = 'need_login';
    return;
  }

  // 检查地址数量，>=10则先删除第一个
  var addressList = document.querySelectorAll('.single-address');
  console.log('[AddressAutoFill] Current address count: ' + addressList.length);

  if (addressList.length >= 10) {
    console.log('[AddressAutoFill] Addresses >= 10, deleting first one');
    var delBtn = addressList[0].querySelector('.btn-del-address');
    if (delBtn) {
      delBtn.click();
      // 等确认弹窗出现后点确认
      setTimeout(function() {
        var dialog = document.querySelector('.ui-dialog');
        if (dialog) {
          var okBtn = dialog.querySelector('.ok');
          if (okBtn) okBtn.click();
        }
        // 删除后再点新增
        setTimeout(function() {
          var addBtn = document.querySelector('.btn-add-new-address');
          if (addBtn) {
            console.log('[AddressAutoFill] Clicking add new address after delete');
            addBtn.click();
          }
        }, 1000);
      }, 500);
      return;
    }
  }

  // 监听DOM变化，处理确认弹窗
  document.body.addEventListener('DOMNodeInserted', function(event) {
    var target = event.target;
    if (target.classList && target.classList.contains('ui-dialog')) {
      setTimeout(function() {
        if (target.querySelector('.button-important')) {
          target.querySelector('.button-important').click();
        }
      }, 0);
    }
  });

  // 监听地址表格变化 = 添加成功
  var tableAddr = document.querySelector('#table-address');
  if (tableAddr) {
    var tbody = tableAddr.querySelector('tbody');
    if (tbody) {
      tbody.addEventListener('DOMNodeInserted', function() {
        console.log('[AddressAutoFill] Address added successfully!');
        window.__addrManagerResult = 'success';
      });
    }
  }

  // 直接点击"新增收货地址"
  var addBtn = document.querySelector('.btn-add-new-address');
  if (addBtn) {
    console.log('[AddressAutoFill] Clicking add new address button');
    addBtn.click();
  } else {
    console.log('[AddressAutoFill] Add button not found, retrying...');
    var retryCount = 0;
    var retryTimer = setInterval(function() {
      retryCount++;
      var btn = document.querySelector('.btn-add-new-address');
      if (btn) {
        clearInterval(retryTimer);
        console.log('[AddressAutoFill] Clicking add new address button (retry ' + retryCount + ')');
        btn.click();
      } else if (retryCount > 10) {
        clearInterval(retryTimer);
        console.log('[AddressAutoFill] Add button not found after retries');
        window.__addrManagerResult = 'no_button';
      }
    }, 1000);
  }
})()
`
}

/**
 * 1688地址编辑弹窗页脚本 (air.1688.com/app/1688-global/address-manage/address-dialog.html)
 * 参考dl系统：填写收货人/手机/地址，选择省市区级联，勾选默认，提交
 */
function build1688AddressDialogScript(receiverName, receiverPhone, parsedAddr) {
  // 使用 JSON.stringify 安全转义，防止代码注入
  const name = JSON.stringify(receiverName || '')
  const phone = JSON.stringify(receiverPhone || '')
  const province = JSON.stringify(parsedAddr.province || '')
  const city = JSON.stringify(parsedAddr.city || parsedAddr.province || '')
  const area = JSON.stringify(parsedAddr.area || '')
  const other = JSON.stringify(parsedAddr.other || '')

  return `
(function() {
  if (window.__addrDialogDone) return;
  window.__addrDialogDone = true;
  console.log('[AddressAutoFill] 1688 address dialog page loaded');

  var targetName = ${name};
  var targetPhone = ${phone};
  var targetProvince = ${province};
  var targetCity = ${city};
  var targetArea = ${area};
  var targetOther = ${other};

  // React兼容的输入函数（参考dl系统的inputFunc）
  function inputFunc(el, value) {
    if (!el || !value) return;
    var lastValue = el.value;
    el.value = value;
    var tracker = el._valueTracker;
    if (tracker) tracker.setValue(lastValue);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // 等待页面加载完成后填写
  var waitCount = 0;
  var waitTimer = setInterval(function() {
    waitCount++;
    var nameInput = document.querySelector('#recipient-name');
    if (!nameInput && waitCount < 20) return;
    clearInterval(waitTimer);

    if (!nameInput) {
      console.log('[AddressAutoFill] Address dialog form not found');
      window.__addrDialogResult = 'no_form';
      return;
    }

    console.log('[AddressAutoFill] Filling address form...');

    // 填写收货人姓名
    inputFunc(nameInput, targetName);
    console.log('[AddressAutoFill] Filled recipient name: ' + targetName);

    // 填写详细地址
    var addrInput = document.querySelector('#detailed-address');
    if (addrInput) {
      inputFunc(addrInput, targetOther);
      console.log('[AddressAutoFill] Filled detailed address: ' + targetOther);
    }

    // 填写手机号
    var phoneInput = document.querySelector('input[name=phone-number]');
    if (phoneInput) {
      inputFunc(phoneInput, targetPhone);
      console.log('[AddressAutoFill] Filled phone: ' + targetPhone);
    }

    // 点击区号选择器（参考dl系统）
    var areaCodeInput = document.querySelector('input[name=phone-area-code]');
    if (areaCodeInput) areaCodeInput.click();

    var areaCodeTimer = setInterval(function() {
      var popup = document.querySelector('.next-overlay-wrapper .phone-area-code-select-popup li');
      if (!popup) return;
      popup.click();
      clearInterval(areaCodeTimer);

      // 勾选默认地址
      var checkbox = document.querySelector('.next-checkbox-input');
      if (checkbox) {
        checkbox.click();
        console.log('[AddressAutoFill] Checked default address');
      }

      // 开始处理省市区级联选择
      var step = 1;
      document.body.addEventListener('DOMNodeInserted', function(event) {
        if (event.target.classList && event.target.classList.contains('next-overlay-wrapper')) {
          var target = event.target;
          setTimeout(function() {
            // 检测地址级联下拉框
            if (target.querySelector('.address-cascader-dropdown')) {
              console.log('[AddressAutoFill] Address cascader dropdown detected');
              step = 1;

              var tabContent = target.querySelector('.next-tabs-content .next-tabs-content');
              if (tabContent) {
                tabContent.addEventListener('DOMNodeInserted', function(evt) {
                  if (evt.target.classList && evt.target.classList.contains('next-tabs-tabpane')) {
                    var pane = evt.target;
                    var times = 0;
                    var selectTimer = setInterval(function() {
                      times++;
                      var nodes = pane.querySelectorAll('li.division-item-wrapper');
                      if (step == 2) {
                        if (nodes.length == 0) return;
                        clearInterval(selectTimer);
                        for (var node of nodes) {
                          if (node.innerText.indexOf(targetCity) == 0) {
                            step = 3;
                            node.click();
                            console.log('[AddressAutoFill] Selected city: ' + targetCity);
                            break;
                          }
                        }
                      } else if (step == 3) {
                        if (nodes.length == 0) return;
                        clearInterval(selectTimer);
                        var isFind = false;
                        for (var node of nodes) {
                          if (node.innerText.indexOf(targetArea) == 0) {
                            step = 4;
                            node.click();
                            console.log('[AddressAutoFill] Selected area: ' + targetArea);
                            isFind = true;
                            break;
                          }
                        }
                        if (!isFind) {
                          // 没找到区，直接确认
                          var confirmBtn = pane.querySelector('.next-btn');
                          if (confirmBtn && !confirmBtn.disabled) {
                            confirmBtn.click();
                            setTimeout(function() {
                              var submitBtn = document.querySelector('.add-address-action-group .next-btn-primary');
                              if (submitBtn) submitBtn.click();
                            }, 500);
                          }
                        }
                      } else if (step == 4) {
                        if (nodes.length == 0 && times < 50) return;
                        clearInterval(selectTimer);
                        // 选完区后，可能还有街道级别，直接确认
                        var confirmBtn = pane.querySelector('.next-btn');
                        if (confirmBtn && !confirmBtn.disabled) {
                          confirmBtn.click();
                          setTimeout(function() {
                            var submitBtn = document.querySelector('.add-address-action-group .next-btn-primary');
                            if (submitBtn) {
                              console.log('[AddressAutoFill] Clicking submit button');
                              submitBtn.click();
                              window.__addrDialogResult = 'submitted';
                            }
                          }, 500);
                        }
                      }
                    }, 100);
                  }
                });
              }

              // 选择省份
              var provinceNodes = target.querySelectorAll('.next-tabs-content .next-tabs-content .next-tabs-tabpane li.division-item-wrapper');
              for (var node of provinceNodes) {
                if (node.innerText.indexOf(targetProvince) == 0) {
                  step = 2;
                  node.click();
                  console.log('[AddressAutoFill] Selected province: ' + targetProvince);
                  break;
                }
              }
            }
          }, 0);
        }
      });

      // 点击地址选择器触发级联
      var addressBtn = document.querySelector('#address');
      if (addressBtn) {
        console.log('[AddressAutoFill] Clicking address cascader');
        addressBtn.click();
      }

    }, 100);

  }, 500);
})()
`
}

/**
 * 拼多多地址管理页脚本 (mobile.yangkeduo.com/addresses.html)
 * 参考dl系统：在拼多多地址页面自动填写收货地址
 * 流程：检查地址列表→删除溢出→点击新增→填写表单→省市区级联→保存
 */
function buildPddAddressScript(receiverName, receiverPhone, parsedAddr) {
  if (!parsedAddr) return null  // 地址解析失败则不注入脚本
  const name = JSON.stringify(receiverName || '')
  const phone = JSON.stringify(receiverPhone || '')
  const province = JSON.stringify(parsedAddr.province || '')
  const city = JSON.stringify(parsedAddr.city || parsedAddr.province || '')
  const area = JSON.stringify(parsedAddr.area || '')
  const other = JSON.stringify(parsedAddr.other || '')

  // ★ 对齐 dl.js 5838-5929 行实现，逐行对应，不做创新
  return `
(function() {
  if (window.__pddAddrDone) return;
  window.__pddAddrDone = true;
  console.log('[PddAddress] Pinduoduo addresses page loaded');

  var targetName = ${name};
  var targetPhone = ${phone};
  var targetProvince = ${province};
  var targetCity = ${city};
  var targetArea = ${area};
  var targetOther = ${other};

  if (!targetName && !targetPhone && !targetOther) {
    console.log('[PddAddress] No receiver info provided, skipping');
    return;
  }

  // ★ 对齐 dl：清除 ua 和 transac_batch_cart cookie（防止风控追踪）
  function delCookie(name, domain) {
    document.cookie = name + '=;path=/;' + (domain ? 'domain=' + domain + ';' : '') + 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
  }
  delCookie('ua', 'mobile.yangkeduo.com');
  delCookie('transac_batch_cart', 'mobile.yangkeduo.com');
  delCookie('ua', '');
  delCookie('transac_batch_cart', '');

  // 检查是否需要登录
  if (document.querySelector('.login-container') && !document.querySelector('#name')) {
    console.log('[PddAddress] Need login, showing window');
    window.__pddAddrResult = 'need_login';
    return;
  }

  // ★ 对齐 dl：从 rawData 获取地址列表
  var addressList = null;
  try {
    if (window.rawData && window.rawData["stores"] && window.rawData["stores"]["store"]) {
      addressList = window.rawData["stores"]["store"]["addressList"];
    } else if (window.rawData && window.rawData["store"]) {
      addressList = window.rawData["store"]["addressList"];
    }
  } catch(e) {}

  var addrCount = addressList ? addressList.length : 0;
  console.log('[PddAddress] Current address count: ' + addrCount);

  // ★ 对齐 dl：地址>=20 先删除第一个
  // 关键修复：删除操作会触发DOM变化（确认弹窗、"删除成功"提示等），
  // 这些DOM变化会干扰省市区级联的DOMNodeInserted监听器，
  // 所以必须等删除完成后再执行新增+填写+级联操作
  if (addrCount >= 20) {
    console.log('[PddAddress] Addresses >= 20, deleting first one');
    try {
      var span = document.querySelector("li").querySelectorAll(":scope > div")[0].querySelectorAll(":scope > div")[2].querySelectorAll(":scope > div")[1];
      if (span) {
        span.click();
        // 等删除确认弹窗出现后点确认
        setTimeout(function() {
          var sureDiv = document.querySelector("body").lastChild.querySelectorAll("div");
          if (sureDiv.length > 0) {
            sureDiv[sureDiv.length - 1].click();
          }
          // 等删除完成后（弹窗消失、"删除成功"提示消失），再执行新增+填写
          setTimeout(function() { addAndFillAddress(); }, 2000);
        }, 500);
      } else {
        // 没找到删除按钮，直接新增
        addAndFillAddress();
      }
    } catch(e) {
      console.log('[PddAddress] Delete address failed: ' + e.message);
      addAndFillAddress();
    }
  } else {
    addAndFillAddress();
  }

  function addAndFillAddress() {

  // ★ 对齐 dl：点击"新增收货地址"按钮后立即填写表单，无延时
  var clickDiv = document.querySelector("#main").querySelector("div").lastChild.previousSibling;
  if (clickDiv && clickDiv.childNodes.length != 1) {
    clickDiv = clickDiv.previousSibling;
  }
  if (clickDiv) {
    clickDiv.querySelector("div").click();
    console.log('[PddAddress] Clicked add address button');
  }

  // ★ 对齐 dl 5843-5852：填写顺序 address → name → phone，只用 input 事件
  var evInput = document.createEvent("HTMLEvents");
  evInput.initEvent("input", true, true);

  // 1. 详细地址（innerHTML，和 dl 一致）
  if (targetOther) {
    document.querySelector("#address").innerHTML = targetOther;
    document.querySelector("#address").dispatchEvent(evInput);
    console.log('[PddAddress] Filled address: ' + targetOther);
  }

  // 2. 收货人（setAttribute，和 dl 一致）
  if (targetName) {
    document.querySelector("#name").setAttribute('value', targetName);
    document.querySelector("#name").dispatchEvent(evInput);
    console.log('[PddAddress] Filled name: ' + targetName);
  }

  // 3. 手机号（setAttribute，和 dl 一致）
  if (targetPhone) {
    document.querySelector("#mobile").setAttribute('value', targetPhone);
    document.querySelector("#mobile").dispatchEvent(evInput);
    console.log('[PddAddress] Filled phone: ' + targetPhone);
  }

  // ★ 省市区级联选择：使用轮询方式
  // DL 用 DOMNodeInserted，但我们的 Electron 环境下 DOMNodeInserted 对 region-selector-list-2/3
  // 事件经常丢失（PDD 某些版本复用 list-1 容器、或事件未冒泡），导致省选完后市/区卡住。
  // 改用 setInterval 轮询，每 300ms 检查当前步骤的列表是否出现，更可靠。
  document.querySelector(".m-addr-select").click();
  console.log('[PddAddress] Opened region selector, starting cascade polling');

  var cascadeStep = 0; // 0=省, 1=市, 2=区
  var cascadeDone = false;
  var cascadeAttempts = 0;
  var cascadeTimer = setInterval(function() {
    if (cascadeDone) { clearInterval(cascadeTimer); return; }
    cascadeAttempts++;

    // 根据步骤确定目标值
    var target;
    if (cascadeStep == 0) target = targetProvince;
    else if (cascadeStep == 1) target = targetCity;
    else target = targetArea;

    // 依次尝试多种选择器查找列表项
    var list = [];
    var selectors = [];
    if (cascadeStep == 0) {
      selectors = ['#region-selector-list-1 li'];
    } else if (cascadeStep == 1) {
      selectors = ['#region-selector-list-2 li', '#region-selector-list-1 li', 'div.mars-regions li'];
    } else {
      selectors = ['#region-selector-list-3 li', '#region-selector-list-1 li', 'div.mars-regions li'];
    }
    for (var s = 0; s < selectors.length && list.length == 0; s++) {
      list = document.querySelectorAll(selectors[s]);
    }

    // 省份步骤且列表为空时，尝试点击 .mars-ph-province 占位符
    if (list.length == 0 && cascadeStep == 0) {
      var ph = document.querySelector('.mars-ph-province');
      if (ph) ph.click();
      if (cascadeAttempts % 5 == 1) {
        console.log('[PddAddress] Cascade step ' + cascadeStep + ': no list yet, tried .mars-ph-province');
      }
      return;
    }

    if (list.length == 0) {
      if (cascadeAttempts % 5 == 1) {
        console.log('[PddAddress] Cascade step ' + cascadeStep + ': no list items found (attempt ' + cascadeAttempts + ')');
      }
      return;
    }

    // 首次找到列表时打印前几项，方便调试
    if (cascadeAttempts <= 2) {
      var sample = [];
      for (var k = 0; k < Math.min(3, list.length); k++) sample.push(list[k].innerText);
      console.log('[PddAddress] Cascade step ' + cascadeStep + ': found ' + list.length + ' items, target="' + target + '", sample=' + JSON.stringify(sample));
    }

    for (var i = 0; i < list.length; i++) {
      var matched = false;
      if (cascadeStep == 2 && (!target || target == '')) {
        matched = targetOther.indexOf(list[i].innerText) == 0;
      } else {
        matched = list[i].innerText.indexOf(target) == 0 || target.indexOf(list[i].innerText) == 0;
      }

      if (matched) {
        console.log('[PddAddress] Cascade step ' + cascadeStep + ': MATCHED "' + list[i].innerText + '" for target "' + target + '"');

        if (cascadeStep == 2) {
          // 区选择：点击后处理子列表（街道/小区），然后保存
          try {
            document.querySelector("ul").addEventListener("DOMNodeInserted", function(event) {
              var subTarget = event.target;
              setTimeout(function() {
                try { subTarget.querySelector("div").querySelector("div").click(); } catch(e) {}
              }, 0);
            });
          } catch(e) {}
          list[i].click();
          setTimeout(function() {
            document.querySelector(".m-addr-save-new").click();
            window.__pddAddrResult = 'success';
            console.log('[PddAddress] Address saved, navigating back to checkout in 2s');
            // 保存成功后返回结算页（PDD不会自动跳回，需要手动history.back）
            setTimeout(function() {
              window.history.back();
            }, 2000);
          }, 300);
          cascadeDone = true;
          clearInterval(cascadeTimer);
        } else {
          list[i].click();
          console.log('[PddAddress] Cascade: advancing to step ' + (cascadeStep + 1));
          cascadeStep++;
          cascadeAttempts = 0;
        }
        return;
      }
    }

    // 没有匹配项：每10次轮询打印一次调试信息
    if (cascadeAttempts % 10 == 0) {
      var first3 = [];
      for (var k = 0; k < Math.min(3, list.length); k++) first3.push(list[k].innerText);
      console.log('[PddAddress] Cascade step ' + cascadeStep + ': no match in ' + list.length + ' items after ' + cascadeAttempts + ' attempts, first3=' + JSON.stringify(first3));
    }
  }, 300);

  // 15秒超时
  setTimeout(function() {
    if (!cascadeDone) {
      clearInterval(cascadeTimer);
      console.log('[PddAddress] Cascade timed out after 15s, step=' + cascadeStep + ', attempts=' + cascadeAttempts);
    }
  }, 15000);
  } // end of addAndFillAddress

})()
`
}

/**
 * 拼多多结算页地址选择脚本
 * 在 order_checkout.html 页面点击地址区域，选择匹配的收货地址
 * 参考 dl 系统：结算页点击 .oc-address-info 打开地址选择，选择匹配地址
 */
function buildPddCheckoutAddressSelectScript(shippingName, shippingPhone) {
  const name = JSON.stringify(shippingName || '')
  const phone = JSON.stringify(shippingPhone || '')
  return `
(function() {
  var targetName = ${name};
  var targetPhone = ${phone};
  if (!targetName && !targetPhone) return;
  if (window.__pddCheckoutAddrDone) return;
  window.__pddCheckoutAddrDone = true;

  console.log('[PddCheckout] Starting address selection, name=' + targetName + ', phone=' + targetPhone);

  // 点击地址区域打开地址选择器
  function clickAddressSection() {
    var addrInfo = document.querySelector(".oc-address-info");
    if (addrInfo) {
      console.log('[PddCheckout] Clicking .oc-address-info');
      addrInfo.click();
      return true;
    }
    var ocAddr = document.querySelector(".oc-address");
    if (ocAddr) {
      var divs = ocAddr.querySelectorAll("div");
      if (divs.length > 1) {
        console.log('[PddCheckout] Clicking .oc-address div[1]');
        divs[1].click();
        return true;
      }
    }
    console.log('[PddCheckout] Address section not found');
    return false;
  }

  // 在地址列表中查找匹配的地址并点击
  function selectMatchingAddress() {
    var items = document.querySelectorAll("li");
    for (var i = 0; i < items.length; i++) {
      var text = items[i].innerText || '';
      var nameMatch = !targetName || text.indexOf(targetName) >= 0;
      var phoneMatch = !targetPhone || text.indexOf(targetPhone) >= 0;
      if (nameMatch && phoneMatch) {
        console.log('[PddCheckout] Found matching address, clicking');
        items[i].click();
        return true;
      }
    }
    console.log('[PddCheckout] No matching address found in list');
    return false;
  }

  // 执行步骤：先点击地址区域，等地址列表出现后选择
  clickAddressSection();

  // 轮询等待地址列表出现（最多5秒）
  var tries = 0;
  var timer = setInterval(function() {
    tries++;
    var items = document.querySelectorAll("li");
    if (items.length > 0) {
      clearInterval(timer);
      selectMatchingAddress();
    } else if (tries > 25) {
      clearInterval(timer);
      console.log('[PddCheckout] Address list did not appear');
    }
  }, 200);
})()
`
}

/**
 * 淘宝地址管理页脚本 (member1.taobao.com/member/fresh/deliver_address.htm)
 * 参考dl系统：在地址管理页面添加新的收货地址
 * 选择器: #fullName(姓名), #mobile(手机), .cndzk-entrance-division(省市区), .cndzk-entrance-associate-area-textarea(详细地址)
 */
function buildTaobaoAddressManagerScript(receiverName, receiverPhone, parsedAddr) {
  // 使用 JSON.stringify 安全转义，防止代码注入
  const name = JSON.stringify(receiverName || '')
  const phone = JSON.stringify(receiverPhone || '')
  const province = JSON.stringify(parsedAddr.province || '')
  const city = JSON.stringify(parsedAddr.city || parsedAddr.province || '')
  const area = JSON.stringify(parsedAddr.area || '')
  const other = JSON.stringify(parsedAddr.other || '')

  return `
(function() {
  if (window.__tbAddrDone) return;
  window.__tbAddrDone = true;

  var targetName = ${name};
  var targetPhone = ${phone};
  var targetProvince = ${province};
  var targetCity = ${city};
  var targetArea = ${area};
  var targetOther = ${other};

  console.log('[AddressAutoFill] Taobao address manager page loaded');

  // 检查是否需要验证（滑块等）
  var addressListEl = document.querySelector('.addressList');
  if (!addressListEl) {
    console.log('[AddressAutoFill] .addressList not found, may need verification');
    window.__tbAddrResult = 'need_verify';
    return;
  }

  var isDelete = false;

  // === 先注册DOMNodeInserted监听器，再执行删除/新增操作 ===
  document.body.addEventListener('DOMNodeInserted', function(event) {
    var target = event.target;
    if (!target.classList) return;

    if (target.classList.contains('next-overlay-wrapper')) {
      // 检测"保存成功"提示
      if (target.innerText && target.innerText.indexOf('保存成功') >= 0) {
        console.log('[AddressAutoFill] Taobao address saved successfully!');
        window.__tbAddrResult = 'success';
        return;
      }

      // 确认弹窗（删除确认等）- 自动点击确认按钮
      var nextBtn = target.querySelector('.next-btn-primary');
      if (nextBtn) {
        console.log('[AddressAutoFill] Confirm dialog detected, clicking confirm button');
        setTimeout(function() {
          nextBtn.click();
          if (isDelete) {
            isDelete = false;
            console.log('[AddressAutoFill] Delete confirmed, clicking add button');
            setTimeout(function() {
              clickAddButton();
              setTimeout(addReceiver, 300);
            }, 500);
          }
        }, 0);
      }
    }

    // 检测滑块验证弹窗
    if (target.classList.contains('J_MIDDLEWARE_FRAME_WIDGET')) {
      console.log('[AddressAutoFill] Slider verification detected');
      window.__tbAddrResult = 'need_verify';
      target.addEventListener('DOMNodeRemoved', function() {
        console.log('[AddressAutoFill] Verification completed, reloading...');
        window.location.reload();
      });
    }
  });

  function clickAddButton() {
    // 尝试多种选择器找到"添加地址"按钮
    var addBtn = document.querySelector('.h-btn')
      || document.querySelector('button[class*="add"]')
      || document.querySelector('.addAddress');
    if (!addBtn) {
      // 通过文本内容查找
      var btns = document.querySelectorAll('button, a, div[role="button"]');
      for (var i = 0; i < btns.length; i++) {
        var txt = (btns[i].textContent || '').trim();
        if (txt === '添加地址' || txt === '添加收货地址' || txt === '新增收货地址') {
          addBtn = btns[i];
          break;
        }
      }
    }
    if (addBtn) {
      addBtn.click();
      console.log('[AddressAutoFill] Clicked add button: ' + addBtn.textContent.trim());
    } else {
      console.log('[AddressAutoFill] Add button NOT found');
    }
  }

  function addReceiver() {
    console.log('[AddressAutoFill] addReceiver starting...');

    // 注意：姓名、手机号、勾选默认地址 移到 fillDetailAndSave 中填写
    // 因为级联选择会触发React重新渲染，导致之前填的值被清空

    // === 省市区级联选择（先做这个） ===
    startCascadeSelection();
  }

  // 级联选择器的当前步骤: 1=省, 2=市, 3=区, 4=完成
  var cascadeStep = 0;

  function startCascadeSelection() {
    console.log('[AddressAutoFill] Starting cascade selection (event-driven + fallback)...');

    // 确保省份下拉框已打开
    var clickHeader = document.querySelector('.cndzk-entrance-division-header-click');
    if (!document.querySelector('.cndzk-entrance-division-box') && clickHeader) {
      clickHeader.click();
      console.log('[AddressAutoFill] Clicked header to open dropdown');
    }

    cascadeStep = 1;

    // === 主逻辑：DOMNodeInserted 事件驱动（参考DL系统） ===
    // 在 .cndzk-entrance-division-box 出现时，监听 .cndzk-entrance-division-box-content 的 DOMNodeInserted
    // 选项 DOM 一插入就立刻匹配点击，比轮询快得多
    function setupDOMListener() {
      var box = document.querySelector('.cndzk-entrance-division-box');
      if (!box) {
        // box 还没出现，等一下再试
        setTimeout(setupDOMListener, 100);
        return;
      }
      var content = document.querySelector('.cndzk-entrance-division-box-content');
      if (!content) {
        // 有些版本的 box 没有 content 子容器，直接监听 box
        content = box;
      }

      content.addEventListener('DOMNodeInserted', function(event) {
        if (cascadeStep === 0 || cascadeStep === 4) return;
        tryMatchAndClick();
      });
      console.log('[AddressAutoFill] DOMNodeInserted listener installed on ' + (content.className || 'box'));

      // 首次也尝试匹配一次
      setTimeout(function() { tryMatchAndClick(); }, 50);
    }

    function tryMatchAndClick() {
      if (cascadeStep === 0 || cascadeStep === 4) return;
      var items = getCascadeItems();
      if (items.length === 0) return;

      if (cascadeStep === 1) {
        for (var i = 0; i < items.length; i++) {
          var text = (items[i].innerText || '').trim();
          if (text === targetProvince || text.indexOf(targetProvince) === 0 || targetProvince.indexOf(text) === 0) {
            items[i].click();
            // 直辖市（北京/天津/上海/重庆）选完省后直接到区，跳过市
            var municipalities = ['北京', '天津', '上海', '重庆'];
            if (municipalities.indexOf(targetProvince) >= 0 || municipalities.indexOf(text) >= 0) {
              cascadeStep = targetArea ? 3 : 4;
              console.log('[AddressAutoFill] [Event] Selected province (municipality, skip city): ' + text);
              if (cascadeStep === 4) {
                setTimeout(fillDetailAndSave, 150);
              }
            } else {
              cascadeStep = 2;
              console.log('[AddressAutoFill] [Event] Selected province: ' + text);
            }
            return;
          }
        }
      } else if (cascadeStep === 2) {
        for (var i = 0; i < items.length; i++) {
          var text = (items[i].innerText || '').trim();
          if (text === targetCity || text.indexOf(targetCity) === 0 || targetCity.indexOf(text) === 0) {
            items[i].click();
            cascadeStep = targetArea ? 3 : 4;
            console.log('[AddressAutoFill] [Event] Selected city: ' + text);
            if (cascadeStep === 4) {
              setTimeout(fillDetailAndSave, 150);
            }
            return;
          }
        }
      } else if (cascadeStep === 3) {
        for (var i = 0; i < items.length; i++) {
          var text = (items[i].innerText || '').trim();
          if (text === targetArea || text.indexOf(targetArea) === 0 || targetArea.indexOf(text) === 0) {
            items[i].click();
            cascadeStep = 4;
            console.log('[AddressAutoFill] [Event] Selected area: ' + text);
            // 参考DL系统：选完区之后直接关闭下拉框、填详细地址、保存（不选街道）
            setTimeout(fillDetailAndSave, 150);
            return;
          }
        }
      }
    }

    setupDOMListener();

    // === 兜底：100ms 轮询，防止事件遗漏 ===
    var fallbackCount = 0;
    var fallbackTimer = setInterval(function() {
      fallbackCount++;
      if (cascadeStep === 4 || fallbackCount > 150) {
        clearInterval(fallbackTimer);
        if (fallbackCount > 150) {
          console.log('[AddressAutoFill] Cascade fallback timeout');
        }
        return;
      }
      tryMatchAndClick();
    }, 100);
  }

  // 获取级联选择器中当前步骤的选项（参考DL系统：找最后一个可见面板中的选项）
  function getCascadeItems() {
    var box = document.querySelector('.cndzk-entrance-division-box');
    if (!box) return [];

    // 找最后一个可见的面板（当前步骤）
    var panels = box.querySelectorAll('.cndzk-entrance-division-box-content');
    var activePanel = null;
    for (var i = panels.length - 1; i >= 0; i--) {
      var rect = panels[i].getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        activePanel = panels[i];
        break;
      }
    }

    var container = activePanel || box;
    var items = [];
    var els = container.querySelectorAll('a, li, div[role="option"], span[class*="item"]');
    for (var j = 0; j < els.length; j++) {
      var txt = (els[j].innerText || '').trim();
      if (txt.length > 0 && txt.length < 30) {
        items.push(els[j]);
      }
    }
    return items;
  }

  function fillDetailAndSave() {
    console.log('[AddressAutoFill] fillDetailAndSave starting...');
    setTimeout(function() {
      // 关闭地区选择器下拉框
      var clickHeader = document.querySelector('.cndzk-entrance-division-header-click');
      if (clickHeader) clickHeader.click();

      // React兼容的值设置方法：使用原生setter绕过React内部状态追踪
      var nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      var nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;

      function setInputValue(el, val) {
        nativeInputSetter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      function setTextareaValue(el, val) {
        nativeTextareaSetter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // === 填写姓名 ===
      var nameEl = document.querySelector('#fullName')
        || document.querySelector('input[placeholder*="收货人"]')
        || document.querySelector('input[placeholder*="姓名"]')
        || document.querySelector('input[name="fullName"]');
      if (nameEl) {
        setInputValue(nameEl, targetName);
        console.log('[AddressAutoFill] Filled name: ' + targetName);
      } else {
        console.log('[AddressAutoFill] Name field NOT found');
      }

      // === 填写手机号 ===
      var phoneEl = document.querySelector('#mobile')
        || document.querySelector('input[placeholder*="手机"]')
        || document.querySelector('input[placeholder*="电话"]')
        || document.querySelector('input[name="mobile"]');
      if (phoneEl) {
        setInputValue(phoneEl, targetPhone);
        console.log('[AddressAutoFill] Filled phone: ' + targetPhone);
      } else {
        console.log('[AddressAutoFill] Phone field NOT found');
      }

      // === 勾选默认地址 ===
      var defaultAddr = document.querySelector('#defaultAddress')
        || document.querySelector('input[name="defaultAddress"]');
      if (defaultAddr && !defaultAddr.checked) {
        defaultAddr.click();
        console.log('[AddressAutoFill] Clicked default address checkbox');
      }

      // === 填写详细地址 ===
      // 保留完整地址（包括【采购编号】等后缀），不再移除方括号内容
      var cleanAddr = targetOther;

      var textarea = document.querySelector('.cndzk-entrance-associate-area-textarea')
        || document.querySelector('textarea[placeholder*="详细地址"]')
        || document.querySelector('textarea[placeholder*="街道"]')
        || document.querySelector('textarea[placeholder*="门牌号"]');

      if (!textarea) {
        var textareas = document.querySelectorAll('textarea');
        for (var t = 0; t < textareas.length; t++) {
          if (textareas[t].offsetParent !== null) {
            textarea = textareas[t];
            break;
          }
        }
      }

      if (textarea) {
        setTextareaValue(textarea, cleanAddr);
        console.log('[AddressAutoFill] Filled detailed address: ' + cleanAddr);
      } else {
        console.log('[AddressAutoFill] Detail address textarea NOT found');
      }

      // 点击保存按钮
      setTimeout(function() {
        var saveBtn = document.querySelector('.next-overlay-wrapper .next-btn-primary')
          || document.querySelector('.next-dialog-footer .next-btn-primary')
          || document.querySelector('[class*="dialog"] [class*="btn-primary"]');

        if (!saveBtn) {
          var btns = document.querySelectorAll('button');
          for (var b = 0; b < btns.length; b++) {
            var txt = (btns[b].textContent || '').trim();
            if (txt === '保存' || txt === '确定' || txt === '确认' || txt === '提交') {
              saveBtn = btns[b];
              break;
            }
          }
        }

        if (saveBtn) {
          saveBtn.click();
          console.log('[AddressAutoFill] Clicked save button: ' + saveBtn.textContent.trim());
          // 保存后轮询：检测确认弹窗（如街道确认）并自动点击，同时检测保存成功
          var checkCount = 0;
          var checkTimer = setInterval(function() {
            checkCount++;
            if (window.__tbAddrResult === 'success') {
              clearInterval(checkTimer);
              return;
            }

            // 检查是否有新的确认弹窗（如"系统检测到您的地址属于XX街道"）
            // 查找所有可见的 .next-dialog 中的确认按钮
            var dialogs = document.querySelectorAll('.next-overlay-wrapper .next-dialog');
            for (var d = 0; d < dialogs.length; d++) {
              var dlg = dialogs[d];
              var dlgText = (dlg.innerText || '');
              // 排除地址添加表单本身的对话框（含"收货地址"标题）
              if (dlgText.indexOf('添加收货地址') >= 0) continue;
              // 这是一个新弹出的确认对话框，自动点击确认
              var confirmBtn = dlg.querySelector('.next-btn-primary');
              if (confirmBtn) {
                console.log('[AddressAutoFill] Auto-clicking confirm dialog: ' + dlgText.substring(0, 60));
                confirmBtn.click();
              }
            }

            // 检查地址添加对话框是否已消失（保存成功）
            var addDialog = null;
            var allDialogs = document.querySelectorAll('.next-overlay-wrapper .next-dialog');
            for (var d = 0; d < allDialogs.length; d++) {
              if ((allDialogs[d].innerText || '').indexOf('添加收货地址') >= 0) {
                addDialog = allDialogs[d];
                break;
              }
            }
            if (!addDialog && checkCount > 3) {
              clearInterval(checkTimer);
              console.log('[AddressAutoFill] Add address dialog disappeared, save successful');
              window.__tbAddrResult = 'success';
              return;
            }

            // 检查页面上的成功提示文本
            var bodyText = document.body.innerText || '';
            if (bodyText.indexOf('保存成功') >= 0 || bodyText.indexOf('添加成功') >= 0) {
              clearInterval(checkTimer);
              console.log('[AddressAutoFill] Success text detected on page');
              window.__tbAddrResult = 'success';
              return;
            }
            if (checkCount > 15) {
              clearInterval(checkTimer);
              console.log('[AddressAutoFill] Save result check timeout');
            }
          }, 500);
        } else {
          console.log('[AddressAutoFill] Save button NOT found');
        }
      }, 150);
    }, 100);
  }

  // === 主流程 ===
  if (document.querySelectorAll('.t-delete').length > 10) {
    console.log('[AddressAutoFill] Too many addresses, deleting first one');
    isDelete = true;
    document.querySelector('.t-delete').click();
    // DOMNodeInserted handler 会尝试自动处理删除确认弹窗
    // 简单轮询兜底：500ms检测确认弹窗，最多5秒
    var delCount = 0;
    var delTimer = setInterval(function() {
      delCount++;
      if (!isDelete || delCount > 10) {
        clearInterval(delTimer);
        if (isDelete) {
          isDelete = false;
          console.log('[AddressAutoFill] Delete confirm timeout, proceeding to add');
          clickAddButton();
          setTimeout(addReceiver, 300);
        }
        return;
      }
      var confirmBtn = document.querySelector('.next-overlay-wrapper .next-btn-primary');
      if (confirmBtn) {
        clearInterval(delTimer);
        console.log('[AddressAutoFill] Delete confirm dialog found, clicking confirm');
        confirmBtn.click();
        isDelete = false;
        setTimeout(function() {
          clickAddButton();
          setTimeout(addReceiver, 300);
        }, 300);
      }
    }, 300);
  } else {
    clickAddButton();
    setTimeout(addReceiver, 300);
  }
})()
`
}

// 结算页面URL关键词（各平台）
const CHECKOUT_URL_PATTERNS = {
  taobao: ['buy.taobao.com', 'buyertrade.taobao.com', 'buy.tmall.com'],
  pinduoduo: ['yangkeduo.com/order', 'yangkeduo.com/checkout', 'mobile.yangkeduo.com/order', 'mms.pinduoduo.com/order'],
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
  // 使用 JSON.stringify 安全转义，防止代码注入
  const name = JSON.stringify(shippingName || '')
  const phone = JSON.stringify(shippingPhone || '')
  const addr = JSON.stringify(shippingAddress || '')

  return `
(function() {
  if (window.__addressAutoFillDone) return;
  var targetName = ${name};
  var targetPhone = ${phone};
  var targetAddr = ${addr};
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
    // 淘宝/天猫 - 旧版ID选择器 + 新版弹窗placeholder选择器
    var tbNameSelectors = '#J_Name, #consignee-name, input[name="receiverName"], input[name="consigneeName"], input[placeholder*="不超过25个字符"], input[aria-label*="收货人"]';
    var tbPhoneSelectors = '#J_Phone, #J_Mobile, input[name="receiverMobile"], input[name="receiverPhone"], input[placeholder*="电话号码"], input[placeholder*="手机号码"], input[aria-label*="手机"]';
    var tbAddrSelectors = '#J_DetailAddr, #J_Addr, textarea[name="receiverAddress"], textarea[name="detailAddress"], textarea[placeholder*="详细地址信息"], textarea[placeholder*="门牌号"], input[aria-label*="地址"]';

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
    console.log('[AddressAutoFill] Showing address info panel');
    // 移除已有面板
    var old = document.getElementById('__addrFillPanel');
    if (old) old.parentNode.removeChild(old);

    var panel = document.createElement('div');
    panel.id = '__addrFillPanel';
    panel.style.cssText = 'position:fixed;top:12px;right:12px;z-index:999999;background:#fff;border:2px solid #409eff;border-radius:10px;padding:14px 18px;box-shadow:0 4px 20px rgba(0,0,0,0.15);font-size:13px;line-height:1.8;max-width:360px;font-family:system-ui,sans-serif;';
    var html = '<div style="font-weight:600;color:#409eff;margin-bottom:6px;font-size:14px;">\\ud83d\\udce6 \\u91c7\\u8d2d\\u6536\\u8d27\\u5730\\u5740</div>';
    html += '<div style="color:#666;font-size:11px;margin-bottom:8px;">\\u8bf7\\u786e\\u4fdd\\u9009\\u62e9\\u4e86\\u6b63\\u786e\\u7684\\u6536\\u8d27\\u5730\\u5740\\uff0c\\u70b9\\u51fb\\u84dd\\u8272\\u6587\\u5b57\\u53ef\\u590d\\u5236</div>';
    if (targetName) html += '<div><b>\\u6536\\u8d27\\u4eba\\uff1a</b><span data-af="name" style="cursor:pointer;color:#409eff;border-bottom:1px dashed #409eff;padding:0 2px;" title="\\u70b9\\u51fb\\u590d\\u5236">' + targetName + '</span></div>';
    if (targetPhone) html += '<div><b>\\u624b\\u673a\\u53f7\\uff1a</b><span data-af="phone" style="cursor:pointer;color:#409eff;border-bottom:1px dashed #409eff;padding:0 2px;" title="\\u70b9\\u51fb\\u590d\\u5236">' + targetPhone + '</span></div>';
    if (targetAddr) html += '<div><b>\\u5730\\u3000\\u5740\\uff1a</b><span data-af="addr" style="cursor:pointer;color:#409eff;border-bottom:1px dashed #409eff;padding:0 2px;" title="\\u70b9\\u51fb\\u590d\\u5236">' + targetAddr + '</span></div>';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;border-top:1px solid #eee;padding-top:8px;">';
    html += '<span data-af="copyall" style="cursor:pointer;color:#fff;background:#409eff;padding:4px 12px;border-radius:4px;font-size:12px;">\\u4e00\\u952e\\u590d\\u5236\\u5168\\u90e8</span>';
    html += '<span data-af="close" style="cursor:pointer;color:#909399;font-size:12px;padding:4px 8px;">\\u6536\\u8d77 X</span>';
    html += '</div>';
    panel.innerHTML = html;
    document.body.appendChild(panel);

    // 关闭/收起按钮
    var closeBtn = panel.querySelector('[data-af="close"]');
    if (closeBtn) {
      closeBtn.onclick = function(e) {
        e.preventDefault();
        e.stopPropagation();
        // 收起为小图标而不是完全移除
        panel.style.maxWidth = 'auto';
        panel.style.padding = '8px 12px';
        panel.innerHTML = '<span data-af="expand" style="cursor:pointer;color:#409eff;font-size:13px;font-weight:500;">\\ud83d\\udce6 \\u663e\\u793a\\u5730\\u5740</span>';
        panel.querySelector('[data-af="expand"]').onclick = function() { showFallbackPanel(); };
      };
    }

    // 一键复制全部
    var copyAllBtn = panel.querySelector('[data-af="copyall"]');
    if (copyAllBtn) {
      copyAllBtn.onclick = function() {
        var all = '';
        if (targetName) all += '\\u6536\\u8d27\\u4eba: ' + targetName + '\\n';
        if (targetPhone) all += '\\u624b\\u673a: ' + targetPhone + '\\n';
        if (targetAddr) all += '\\u5730\\u5740: ' + targetAddr;
        navigator.clipboard.writeText(all.trim()).then(function() {
          copyAllBtn.textContent = '\\u2713 \\u5df2\\u590d\\u5236';
          copyAllBtn.style.background = '#67c23a';
          setTimeout(function() { copyAllBtn.textContent = '\\u4e00\\u952e\\u590d\\u5236\\u5168\\u90e8'; copyAllBtn.style.background = '#409eff'; }, 2000);
        }).catch(function() {});
      };
    }

    // 单项点击复制
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

  // ---- 主流程：先立即显示地址面板，同时尝试自动填充 ----
  var attempts = 0;
  var maxAttempts = 5;
  var phase3Done = false;

  // 淘宝结算页通常没有地址输入框（只有地址列表选择），所以立即显示地址面板
  showFallbackPanel();

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
        setTimeout(tryFill, 1000);
        return;
      } else if (result === 'clicked') {
        // 点击了"使用新地址"，等表单出现
        phase3Done = true;
        setTimeout(tryFill, 1500);
        return;
      }
    }

    // 继续重试
    if (attempts < maxAttempts) {
      setTimeout(tryFill, 1000);
    } else {
      // 全部失败，显示回退面板
      window.__addressAutoFillResult = -1;
      showFallbackPanel();
    }
  }

  // 首次延迟1秒等结算页面加载完成
  setTimeout(tryFill, 1000);

  // ---- MutationObserver：持续监听DOM变化，检测新出现的输入框 ----
  // 即使15次重试都失败，用户手动点击"使用新地址"打开弹窗时也能自动填充
  var fillObserver = new MutationObserver(function(mutations) {
    if (window.__addressAutoFillDone) { fillObserver.disconnect(); return; }
    var hasNewInputs = false;
    for (var m = 0; m < mutations.length; m++) {
      var nodes = mutations[m].addedNodes;
      for (var n = 0; n < nodes.length; n++) {
        var nd = nodes[n];
        if (nd.nodeType !== 1) continue;
        if (nd.tagName === 'INPUT' || nd.tagName === 'TEXTAREA') { hasNewInputs = true; break; }
        if (nd.querySelector && nd.querySelector('input, textarea')) { hasNewInputs = true; break; }
      }
      if (hasNewInputs) break;
    }
    if (!hasNewInputs) return;
    console.log('[AddressAutoFill] Observer: new inputs detected in DOM');
    // 等待弹窗完全渲染
    setTimeout(function() {
      if (window.__addressAutoFillDone) return;
      var filled = tryPlatformSpecific();
      if (filled === 0) filled = tryContextMatch();
      if (filled > 0) {
        window.__addressAutoFillDone = true;
        window.__addressAutoFillResult = filled;
        console.log('[AddressAutoFill] Observer: filled ' + filled + ' fields!');
        showSuccessToast(filled);
        // 移除回退面板
        var oldPanel = document.getElementById('__addrFillPanel');
        if (oldPanel && oldPanel.parentNode) oldPanel.parentNode.removeChild(oldPanel);
        fillObserver.disconnect();
      }
    }, 800);
  });
  fillObserver.observe(document.body, { childList: true, subtree: true });
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
  // 淘宝/天猫：不使用API拦截检测订单号，改用DL方法（confirm_order页提取b2c_orid）
  // 原因：API响应中容易误抓trade_no（支付宝交易号），DL方法更可靠
  pinduoduo: {
    // PDD 下单 API 路径：checkout 提交、订单创建、支付回调等
    // 关键：加入 yangkeduo/pinduoduo 宽泛匹配，因为不知道 PDD 实际 API 路径
    // deepSearch 会按 fields 精确搜索 order_sn，宽泛 URL 匹配不会导致误判
    urlKeywords: ['yangkeduo', 'pinduoduo', 'order/submit', 'order_confirm', 'create_order', 'order/create', 'bg_order',
                  'origenes/order', 'origenes/checkout', 'transac_order', 'order_pre'],
    fields: ['order_sn', 'order_id', 'orderSn', 'orderId', 'orderNo'],
    minLength: 10
  },
  '1688': {
    urlKeywords: ['trade/create', 'order/create', 'fastCreate', 'trademanager', 'createOrder'],
    fields: ['orderId', 'orderNo', 'tradeId'],
    minLength: 10
  }
}

// ============ URL中的订单号检测 ============

/**
 * 从URL参数和路径中提取平台订单号
 * 淘宝提交订单后跳转到支付宝，URL中包含订单号
 */
function extractOrderNoFromUrl(url, platform) {
  if (!url) return null
  try {
    const urlObj = new URL(url)
    const host = urlObj.hostname.toLowerCase()
    const params = urlObj.searchParams

    // 排除商品详情页、搜索页等非订单页面（避免把商品ID误判为订单号）
    const NON_ORDER_HOSTS = ['item.taobao.com', 'detail.tmall.com', 'item.jd.com', 'detail.1688.com']
    if (NON_ORDER_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
      return null
    }
    const NON_ORDER_PATHS = ['/item.htm', '/item/', '/detail/', '/search', '/list']
    if (NON_ORDER_PATHS.some(p => urlObj.pathname.toLowerCase().includes(p))) {
      return null
    }

    if (platform === 'taobao') {
      // 淘宝订单号提取（DL系统方案）：
      // 仅从支付宝页面提取 out_trade_no（商户外部订单号 = 淘宝订单号）
      // 不从淘宝页面URL参数提取，因为容易误抓（b2c_orid在HTML中，不在URL中）
      const isAlipayPage = host.includes('alipay.com')

      if (isAlipayPage) {
        const outTradeNo = params.get('out_trade_no') || params.get('outTradeNo')
        if (outTradeNo && /^\d{10,}$/.test(outTradeNo)) {
          console.log(`[PurchaseCapture] Order found in Alipay out_trade_no: ${outTradeNo}, url=${url.substring(0, 120)}`)
          return outTradeNo
        }
      }
      // 淘宝页面的订单号（b2c_orid）在HTML中，由EXTRACT_ORDER_FROM_PAGE脚本提取，不走URL参数
    }

    if (platform === 'pinduoduo') {
      // PDD支付回调URL中的order_sn（含连字符，如260506-070338506260381）
      const pddParams = ['order_sn', 'orderSn', 'order_id', 'orderId']
      for (const name of pddParams) {
        const val = params.get(name)
        if (val && /^[A-Za-z0-9\-]{10,}$/.test(val)) {
          console.log(`[PurchaseCapture] PDD extractOrderNoFromUrl: found ${name}=${val} in URL params`)
          return val
        } else if (val) {
          console.log(`[PurchaseCapture] PDD extractOrderNoFromUrl: ${name}=${val} but doesn't match /^[A-Za-z0-9\\-]{10,}$/`)
        }
      }
      // ★ 支付宝页面out_trade_no（仅作兜底，不是PDD订单号）
      // 注意：out_trade_no是支付宝商户单号（如"XP..."），不是PDD的order_sn
      // 优先从API拦截器获取order_sn，这里仅当API未捕获时使用
      const isAlipayPage = host.includes('alipay.com')
      if (isAlipayPage) {
        const outTradeNo = params.get('out_trade_no') || params.get('outTradeNo')
        if (outTradeNo && /^[A-Za-z0-9]{10,}$/.test(outTradeNo)) {
          console.log(`[PurchaseCapture] PDD extractOrderNoFromUrl: found out_trade_no=${outTradeNo} on Alipay page (FALLBACK - not PDD order_sn)`)
          return outTradeNo
        } else if (outTradeNo) {
          console.log(`[PurchaseCapture] PDD extractOrderNoFromUrl: out_trade_no=${outTradeNo} but doesn't match /^[A-Za-z0-9]{10,}$/`)
        }
      }
      console.log(`[PurchaseCapture] PDD extractOrderNoFromUrl: no valid order param in URL, all params: ${[...params.keys()].join(',')}`)
    }

    if (platform === '1688') {
      const aliParams = ['orderId', 'orderNo', 'tradeId']
      for (const name of aliParams) {
        const val = params.get(name)
        if (val && /^\d{10,}$/.test(val)) return val
      }
    }
  } catch (e) {
    // URL 解析失败，忽略
  }
  return null
}

/**
 * 从页面内容中提取订单号的脚本（DL系统方案）
 * 淘宝/天猫：仅从HTML源码提取 b2c_orid=xxx（DL系统核心方案，最可靠）
 * 支付宝：从URL参数+DOM+hidden input提取 out_trade_no（商户外部订单号）
 *         淘宝为纯数字，拼多多为字母数字混合（如"XP..."），等价于DL的dlBindPddOrder()
 * 拼多多：从URL参数提取 order_sn
 * 1688：从URL参数提取 orderId
 */
const EXTRACT_ORDER_FROM_PAGE = `
(function() {
  var html = document.querySelector('html') ? document.querySelector('html').innerHTML : '';
  var url = window.location.href;
  var host = window.location.hostname.toLowerCase();
  console.log('[PurchaseCapture] Extracting order from page: ' + url.substring(0, 120));

  // === 支付宝页面: out_trade_no 是商户外部订单号 ===
  // 淘宝out_trade_no为纯数字（≥10位），拼多多为字母数字混合（如"XP..."，≥10位）
  // 对齐DL：DL在检测到mclient.alipay.com后调用dlBindPddOrder()提取订单号
  if (host.indexOf('alipay.com') >= 0) {
    // 1. 从URL参数提取out_trade_no
    try {
      var params = new URLSearchParams(window.location.search);
      var outTradeNo = params.get('out_trade_no') || params.get('outTradeNo');
      if (outTradeNo && /^[A-Za-z0-9]{10,}$/.test(outTradeNo)) {
        console.log('[PurchaseCapture] Found Alipay out_trade_no=' + outTradeNo);
        return outTradeNo;
      } else if (outTradeNo) {
        console.log('[PurchaseCapture] Alipay out_trade_no=' + outTradeNo + ' but not valid format');
      }
    } catch(e) {}
    // 2. 从DOM提取"商户单号"（PDD支付宝页面可能在DOM中显示）
    try {
      var bodyText = document.body ? document.body.innerText : '';
      var merchantMatch = bodyText.match(/商户单号[：:\\s]*([A-Za-z0-9]{10,})/);
      if (merchantMatch && merchantMatch[1]) {
        console.log('[PurchaseCapture] Found merchant order from Alipay DOM: ' + merchantMatch[1]);
        return merchantMatch[1];
      }
    } catch(e) {}
    // 3. 从hidden input提取out_trade_no（form POST方式可能将参数放在hidden字段）
    try {
      var inputs = document.querySelectorAll('input[type="hidden"]');
      for (var i = 0; i < inputs.length; i++) {
        var name = (inputs[i].name || '').toLowerCase();
        if (name === 'out_trade_no' || name === 'outtradeno') {
          var val = (inputs[i].value || '').trim();
          if (val && /^[A-Za-z0-9]{10,}$/.test(val)) {
            console.log('[PurchaseCapture] Found out_trade_no from hidden input: ' + val);
            return val;
          }
        }
      }
    } catch(e) {}
    console.log('[PurchaseCapture] Alipay page but no valid out_trade_no found (URL/DOM/hidden)');
    return null;
  }

  // === 淘宝/天猫: DL系统核心方案 - 从HTML提取 b2c_orid ===
  // b2c_orid 是淘宝订单号，在 confirm_order 页面HTML中最可靠
  {
    var startPos = html.indexOf('b2c_orid=');
    if (startPos >= 0) {
      startPos += 9;
      var endPos = html.indexOf('&', startPos);
      if (endPos < 0) endPos = html.indexOf('"', startPos);
      if (endPos < 0) endPos = html.indexOf("'", startPos);
      if (endPos > startPos) {
        var orid = html.substring(startPos, endPos).trim();
        if (/^\\d{10,}$/.test(orid)) {
          console.log('[PurchaseCapture] Found b2c_orid=' + orid);
          return orid;
        }
      }
    }
  }

  // === 拼多多: URL 参数 order_sn（含连字符，如260506-070338506260381）===
  if (url.indexOf('yangkeduo.com') >= 0 || url.indexOf('pinduoduo.com') >= 0) {
    try {
      var params = new URLSearchParams(window.location.search);
      var sn = params.get('order_sn') || params.get('orderSn') || params.get('order_id');
      if (sn && /^[A-Za-z0-9\\-]{10,}$/.test(sn)) {
        console.log('[PurchaseCapture] Found PDD order_sn=' + sn);
        return sn;
      }
    } catch(e) {}
  }

  // === 1688: URL 参数 ===
  if (url.indexOf('1688.com') >= 0) {
    try {
      var params = new URLSearchParams(window.location.search);
      var oid = params.get('orderId') || params.get('orderNo') || params.get('tradeId');
      if (oid && /^\\d{10,}$/.test(oid)) {
        console.log('[PurchaseCapture] Found 1688 orderId=' + oid);
        return oid;
      }
    } catch(e) {}
  }

  return null;
})()
`

// 从页面中提取实际支付金额的注入脚本
const EXTRACT_PAYMENT_AMOUNT = `
(function() {
  var url = window.location.href;
  var html = document.querySelector('html') ? document.querySelector('html').innerHTML : '';
  var text = document.body ? (document.body.innerText || '') : '';

  console.log('[PurchaseCapture] Extracting payment amount from: ' + url.substring(0, 120));

  // 辅助：将匹配到的金额字符串转为浮点数
  function parseAmount(str) {
    if (!str) return 0;
    var n = parseFloat(str.replace(/[,，]/g, ''));
    return (n > 0 && n < 1000000) ? n : 0;
  }

  // === 1. 从已拦截的API响应中提取（最可靠） ===
  if (window.__capturedPurchaseResponses) {
    for (var i = window.__capturedPurchaseResponses.length - 1; i >= 0; i--) {
      var resp = window.__capturedPurchaseResponses[i];
      try {
        var json = JSON.parse(resp.body);
        // 淘宝/天猫常见字段
        var fields = ['totalActualPay','actualPayFee','actualTotalFee','realPay','totalPayFee','payAmount','totalAmount','orderAmount'];
        for (var f = 0; f < fields.length; f++) {
          var val = json[fields[f]] || (json.data && json.data[fields[f]]);
          if (val) {
            var amt = parseAmount(String(val));
            if (amt > 0) {
              console.log('[PurchaseCapture] Amount from API (' + fields[f] + '): ' + amt);
              return amt;
            }
          }
        }
      } catch(e) {}
    }
  }

  // === 2. 从HTML中提取JSON字段 ===
  var htmlPatterns = [
    /totalActualPay["']?\\s*[:=]\\s*["']?([\\d,.]+)/,
    /actualPayFee["']?\\s*[:=]\\s*["']?([\\d,.]+)/,
    /actualTotalFee["']?\\s*[:=]\\s*["']?([\\d,.]+)/,
    /realPay["']?\\s*[:=]\\s*["']?([\\d,.]+)/,
    /totalPayFee["']?\\s*[:=]\\s*["']?([\\d,.]+)/,
    /payAmount["']?\\s*[:=]\\s*["']?([\\d,.]+)/
  ];
  for (var h = 0; h < htmlPatterns.length; h++) {
    var m = html.match(htmlPatterns[h]);
    if (m) {
      var amt = parseAmount(m[1]);
      if (amt > 0) {
        console.log('[PurchaseCapture] Amount from HTML (' + htmlPatterns[h].source.substring(0, 20) + '): ' + amt);
        return amt;
      }
    }
  }

  // === 3. 从页面可见文本中提取 ===
  var textPatterns = [
    /实付[款金额]*[：:\\s]*[¥￥]?\\s*([\\d,.]+)/,
    /应付[总金额]*[：:\\s]*[¥￥]?\\s*([\\d,.]+)/,
    /合\\s*计[：:\\s]*[¥￥]?\\s*([\\d,.]+)/,
    /总\\s*价[：:\\s]*[¥￥]?\\s*([\\d,.]+)/,
    /需付款[：:\\s]*[¥￥]?\\s*([\\d,.]+)/,
    /订单金额[：:\\s]*[¥￥]?\\s*([\\d,.]+)/
  ];
  for (var t = 0; t < textPatterns.length; t++) {
    var m = text.match(textPatterns[t]);
    if (m) {
      var amt = parseAmount(m[1]);
      if (amt > 0) {
        console.log('[PurchaseCapture] Amount from text (' + textPatterns[t].source.substring(0, 20) + '): ' + amt);
        return amt;
      }
    }
  }

  // === 4. 从DOM元素中提取（金额通常在特定class的元素中） ===
  var selectors = [
    '.pay-amount', '.total-amount', '.real-pay', '.actual-pay',
    '.price-total', '[class*="totalPay"]', '[class*="actualPay"]',
    '.price-highlight', '.pay-price'
  ];
  for (var s = 0; s < selectors.length; s++) {
    var el = document.querySelector(selectors[s]);
    if (el) {
      var elText = (el.innerText || '').replace(/[¥￥元]/g, '').trim();
      var amt = parseAmount(elText);
      if (amt > 0) {
        console.log('[PurchaseCapture] Amount from DOM (' + selectors[s] + '): ' + amt);
        return amt;
      }
    }
  }

  console.log('[PurchaseCapture] No payment amount found');
  return null;
})()
`

// 从采购页面提取实际商品信息的注入脚本（商品名、图片、SKU规格）
const EXTRACT_PURCHASE_PRODUCT_INFO = `
(function() {
  var title = '', image = '', sku = '';
  var url = window.location.href;

  console.log('[PurchaseCapture] Extracting product info from: ' + url.substring(0, 120));

  // === 1. 从已拦截的API响应中提取（最可靠，订单确认/提交接口通常包含商品信息） ===
  if (window.__capturedPurchaseResponses) {
    for (var i = window.__capturedPurchaseResponses.length - 1; i >= 0; i--) {
      var resp = window.__capturedPurchaseResponses[i];
      try {
        var json = JSON.parse(resp.body);
        // 淘宝/天猫订单接口中的商品信息
        var items = json.data && (json.data.orderDatas || json.data.cartInfo || json.data.itemList || json.data.items);
        if (items && items.length > 0) {
          var item = items[0];
          if (!title) title = item.title || item.itemTitle || item.productName || '';
          if (!image) image = item.pic || item.picPath || item.itemPic || item.productImage || item.imageUrl || '';
          if (!sku) sku = item.skuText || item.skuInfo || item.specValues || '';
          if (title) break;
        }
        // 1688订单接口
        if (json.data && json.data.product) {
          var p = json.data.product;
          if (!title) title = p.subject || p.title || '';
          if (!image) image = p.imageUrl || p.picUrl || '';
        }
      } catch(e) {}
    }
  }

  // === 2. 从页面DOM提取（商品详情页/确认页通用） ===
  if (!title) {
    // og:title meta标签（大多数电商页面都有）
    var ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) title = (ogTitle.getAttribute('content') || '').substring(0, 200);
  }
  if (!image) {
    var ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage) image = ogImage.getAttribute('content') || '';
  }

  // 淘宝/天猫商品详情页
  if (!title) {
    var el = document.querySelector('.ItemHeader--mainTitle')
          || document.querySelector('[class*="Title--mainTitle"]')
          || document.querySelector('[class*="title--mainText"]')
          || document.querySelector('h1[class*="title"]');
    if (el) title = (el.textContent || '').trim().substring(0, 200);
  }
  if (!image) {
    var img = document.querySelector('.MainPic--mainPic img')
          || document.querySelector('[class*="MainPic"] img')
          || document.querySelector('[class*="mainPic"] img');
    if (img) image = img.src || img.dataset.src || '';
  }
  if (!sku) {
    var skuEl = document.querySelector('.ItemHeader--skuText')
            || document.querySelector('[class*="skuText"]');
    if (skuEl) sku = (skuEl.textContent || '').trim().substring(0, 200);
  }

  // 淘宝/天猫订单确认页（buy.taobao.com）
  if (!title) {
    var checkoutTitle = document.querySelector('[class*="item-title"]')
                     || document.querySelector('[class*="itemTitle"]')
                     || document.querySelector('.order-biz-item .title');
    if (checkoutTitle) title = (checkoutTitle.textContent || '').trim().substring(0, 200);
  }
  if (!image) {
    var checkoutImg = document.querySelector('[class*="item-pic"] img')
                   || document.querySelector('[class*="itemPic"] img')
                   || document.querySelector('.order-biz-item img');
    if (checkoutImg) image = checkoutImg.src || checkoutImg.dataset.src || '';
  }

  // 1688商品详情页
  if (!title) {
    var title1688 = document.querySelector('.d-title')
                 || document.querySelector('[class*="subject-desc"]');
    if (title1688) title = (title1688.textContent || '').trim().substring(0, 200);
  }
  if (!image) {
    var img1688 = document.querySelector('.horizontal-view img')
               || document.querySelector('[class*="slider"] img')
               || document.querySelector('.obj-fluid img');
    if (img1688) image = img1688.src || img1688.dataset.src || '';
  }

  // 拼多多结算页（order_checkout.html，oc-前缀的DOM类名）
  var isPddCheckout = window.location.href.indexOf('order_checkout') >= 0;
  if (!title && isPddCheckout) {
    // 诊断：输出#main下直接子元素的class，帮助定位选择器
    var mainEl = document.querySelector('#main');
    if (mainEl) {
      var childClasses = [];
      var children = mainEl.querySelectorAll(':scope > div > div');
      for (var ci = 0; ci < Math.min(children.length, 10); ci++) {
        childClasses.push(children[ci].className ? children[ci].className.substring(0, 60) : '(no-class)');
      }
      console.log('[PurchaseCapture] PDD结算页DOM诊断: children=' + childClasses.join(' | '));
    }
    // 标题选择器
    var titlePdd = document.querySelector('[class*="oc-goods"] [class*="name"]')
                || document.querySelector('[class*="oc-item"] [class*="name"]')
                || document.querySelector('[class*="goods-name"]')
                || document.querySelector('[class*="productName"]')
                || document.querySelector('[class*="goodsName"]');
    if (titlePdd) title = (titlePdd.textContent || '').trim().substring(0, 200);
    // 诊断：输出goods区域的所有文本
    var goodsArea = document.querySelector('[class*="oc-goods"]') || document.querySelector('[class*="oc-item"]');
    if (goodsArea && !title) {
      console.log('[PurchaseCapture] PDD结算页goods区文本: ' + (goodsArea.innerText || '').substring(0, 200));
    }
  }
  if (!image && isPddCheckout) {
    var imgPdd = document.querySelector('[class*="oc-goods"] img')
              || document.querySelector('[class*="oc-item"] img')
              || document.querySelector('[class*="goods-img"] img')
              || document.querySelector('[class*="goodsImage"] img');
    if (imgPdd) image = imgPdd.src || imgPdd.dataset.src || '';
    // 兜底：从#main中查找第一个商品图
    if (!image && mainEl) {
      var mainImgs = mainEl.querySelectorAll('img');
      for (var mi = 0; mi < mainImgs.length; mi++) {
        var src = mainImgs[mi].src || mainImgs[mi].dataset.src || '';
        if (src && src.indexOf('http') === 0 && mainImgs[mi].width > 50) {
          image = src;
          break;
        }
      }
    }
  }
  // PDD结算页数量提取
  var quantity = '';
  if (isPddCheckout) {
    var qtyEl = document.querySelector('[class*="oc-goods"] [class*="num"]')
             || document.querySelector('[class*="oc-goods"] [class*="count"]')
             || document.querySelector('[class*="oc-item"] [class*="num"]')
             || document.querySelector('[class*="oc-item"] [class*="count"]')
             || document.querySelector('[class*="goods-number"]')
             || document.querySelector('[class*="goodsNumber"]');
    if (qtyEl) quantity = (qtyEl.textContent || '').trim().replace(/[^0-9]/g, '');
    if (!quantity && goodsArea) {
      // 尝试从goods区域文本中提取 x2、×3 等数量模式
      var goodsText = goodsArea.innerText || '';
      var qtyMatch = goodsText.match(/[x×X]\s*(\d+)/);
      if (qtyMatch) quantity = qtyMatch[1];
    }
  }

  // 通用兜底：页面标题
  if (!title) {
    title = (document.title || '').replace(/[-_|].*$/, '').trim().substring(0, 200);
  }

  // 验证标题：拒绝明显来自非商品页的标题（登录页、支付页等）
  if (title) {
    var invalidTitlePattern = /^(登录|支付宝|收银台|安全验证|付款|验证码|ALIPAY|LOGIN|PAYMENT|CAPTCHA)/i;
    if (invalidTitlePattern.test(title)) {
      console.log('[PurchaseCapture] Title rejected (non-product page): ' + title);
      title = '';
    }
  }

  // 过滤掉淘宝的"淘宝网 - "前缀
  if (title) title = title.replace(/^(淘宝网|天猫|1688|拼多多)[\-_\s]*[-_]*\s*/, '');

  // 过滤过小的图片（图标等）
  if (image && image.match(/[\\?&]size=(\\d+)/)) {
    var sizeMatch = image.match(/[\\?&]size=(\\d+)/);
    if (sizeMatch && parseInt(sizeMatch[1]) < 100) image = '';
  }

  console.log('[PurchaseCapture] Product info extracted: title=' + (title || 'EMPTY') + ', image=' + (image ? 'YES' : 'EMPTY') + ', sku=' + (sku || 'EMPTY') + ', qty=' + (quantity || 'EMPTY'));

  return JSON.stringify({ title: title || '', image: image || '', sku: sku || '', quantity: quantity || '' });
})()
`

// 订单确认/支付相关页面URL模式
const ORDER_CONFIRM_PATTERNS = {
  taobao: [
    'buy.taobao.com/auction/confirm_order',   // 淘宝订单确认页（核心！b2c_orid在此页）
    'buy.tmall.com/order/confirm_order',       // 天猫订单确认页
    'buy.taobao.com/auction/order/confirm',    // 备用路径
    'cashier.alipay.com',                      // 支付宝收银台（out_trade_no）
    'mclient.alipay.com'                       // 手机支付宝（out_trade_no）
    // 注意：不再包含 trade.taobao.com / buyertrade.taobao.com
    // 这些页面含有 trade_no（支付宝交易号），容易误抓，DL方法不需要这些页面
  ],
  pinduoduo: [
    'transac_wechat_wapcallback',              // 拼多多微信支付回调（核心！order_sn在此URL）
    'transac_alipay_wapcallback',              // 支付宝回调
    'pay_success',                             // 支付成功
    'order_result'                             // 订单结果
  ],
  '1688': [
    'trade.1688.com/order',                    // 1688交易
    'cashier.alipay.com',                      // 支付宝
    'order/confirm'                            // 订单确认
  ]
}

/**
 * 递归搜索 JSON 对象中的目标字段
 * @param {object} obj - JSON对象
 * @param {string[]} targetFields - 要查找的字段名
 * @param {number} minLen - 值的最小长度
 * @param {number} depth - 当前深度
 * @returns {string|null} 找到的订单号
 */
function deepSearch(obj, targetFields, minLen, depth, pattern) {
  if (depth > 4 || !obj || typeof obj !== 'object') return null
  var regex = pattern || /^\d+$/

  for (const key of Object.keys(obj)) {
    const val = obj[key]

    // 检查是否是目标字段
    if (targetFields.includes(key)) {
      // 值是字符串或数字
      if (typeof val === 'string' && regex.test(val) && val.length >= minLen) {
        return val
      }
      if (typeof val === 'number' && String(val).length >= minLen) {
        return String(val)
      }
      // 值是数组（如 orderIds）
      if (Array.isArray(val) && val.length > 0) {
        const first = val[0]
        if (typeof first === 'string' && regex.test(first) && first.length >= minLen) {
          return first
        }
        if (typeof first === 'number' && String(first).length >= minLen) {
          return String(first)
        }
      }
    }

    // 递归搜索子对象
    if (typeof val === 'object' && val !== null) {
      const found = deepSearch(val, targetFields, minLen, depth + 1, pattern)
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

  // PDD order_sn格式含连字符（如260506-070338506260381），需专用正则
  const pddPattern = /^[A-Za-z0-9\-]+$/

  let matchedUrls = 0
  for (const r of responses) {
    // 先检查 URL 是否匹配关键词（收窄范围，减少误判）
    const urlLower = (r.url || '').toLowerCase()
    const urlMatch = config.urlKeywords.some(kw => urlLower.includes(kw.toLowerCase()))
    if (!urlMatch) continue

    matchedUrls++
    // 尝试解析 JSON
    try {
      const json = JSON.parse(r.body)
      const pattern = platform === 'pinduoduo' ? pddPattern : undefined
      const orderNo = deepSearch(json, config.fields, config.minLength, 0, pattern)
      if (orderNo) {
        console.log(`[PurchaseCapture] Order detected! platform=${platform}, orderNo=${orderNo}, url=${r.url.substring(0, 100)}`)
        return orderNo
      } else if (platform === 'pinduoduo') {
        console.log(`[PurchaseCapture] PDD detectOrderNo: URL matched but no order_sn found, url=${r.url.substring(0, 80)}`)
      }
    } catch (e) {
      if (platform === 'pinduoduo') {
        console.log(`[PurchaseCapture] PDD detectOrderNo: URL matched but response not JSON, url=${r.url.substring(0, 80)}`)
      }
    }
  }
  if (platform === 'pinduoduo') {
    console.log(`[PurchaseCapture] PDD detectOrderNo: scanned ${responses.length} responses, ${matchedUrls} URL-matched, no order found`)
  }
  return null
}

/**
 * 淘宝专用订单号检测（DL系统核心方案 + 扩展）
 * 搜索优先级：
 * 1. b2c_orid（DL系统核心，最可靠的淘宝订单号）
 * 2. bizOrderId（淘宝提交订单API常见返回字段）
 * 3. orderId（通用订单号字段）
 * 注意：不搜索 trade_no/tradeNo（支付宝交易号，不是淘宝订单号）
 */
function detectTaobaoOrderFromResponses(responses) {
  for (const r of responses) {
    const body = r.body || ''

    // 方法1: 从原始响应文本中搜索 b2c_orid=xxx（DL的getMidString方式）
    const b2cPos = body.indexOf('b2c_orid=')
    if (b2cPos >= 0) {
      let pos = b2cPos + 9
      let endPos = body.indexOf('&', pos)
      if (endPos < 0) endPos = body.indexOf('"', pos)
      if (endPos < 0) endPos = body.indexOf("'", pos)
      if (endPos < 0) endPos = body.indexOf(';', pos)
      if (endPos > pos) {
        const orid = body.substring(pos, endPos).trim()
        if (/^\d{10,}$/.test(orid)) {
          console.log(`[PurchaseCapture] Found b2c_orid in API response: ${orid}, url=${(r.url || '').substring(0, 100)}`)
          return orid
        }
      }
    }

    // 方法2: 在JSON中搜索订单号字段（按优先级：b2c_orid > bizOrderId > orderId）
    try {
      const json = JSON.parse(body)
      // 优先搜索 b2c_orid
      let orderNo = deepSearch(json, ['b2c_orid'], 10, 0)
      if (orderNo) {
        console.log(`[PurchaseCapture] Found b2c_orid in JSON: ${orderNo}, url=${(r.url || '').substring(0, 100)}`)
        return orderNo
      }
      // 其次搜索 bizOrderId（淘宝提交订单API最常见的返回字段）
      orderNo = deepSearch(json, ['bizOrderId', 'biz_order_id'], 15, 0)
      if (orderNo) {
        console.log(`[PurchaseCapture] Found bizOrderId in JSON: ${orderNo}, url=${(r.url || '').substring(0, 100)}`)
        return orderNo
      }
      // 最后搜索 orderId（通用字段，需要更长校验避免误匹配）
      orderNo = deepSearch(json, ['orderId', 'order_id'], 15, 0)
      if (orderNo) {
        console.log(`[PurchaseCapture] Found orderId in JSON: ${orderNo}, url=${(r.url || '').substring(0, 100)}`)
        return orderNo
      }
    } catch (e) {
      // 非 JSON，跳过
    }
  }
  return null
}

// ============ 地址修改成功提示（注入到采购小窗） ============

const ADDRESS_SUCCESS_TOAST = `
(function() {
  var id = '__addrSuccessToast';
  if (document.getElementById(id)) return;
  var toast = document.createElement('div');
  toast.id = id;
  toast.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M20 6L9 17l-5-5"/></svg><span style="margin-left:10px;font-size:16px;font-weight:500">\\u5730\\u5740\\u5df2\\u4fee\\u6539\\u6210\\u529f\\uff0c\\u8bf7\\u653e\\u5fc3\\u91c7\\u8d2d</span>';
  toast.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:99999;display:flex;align-items:center;background:#f0f9eb;color:#67c23a;padding:18px 36px;border-radius:10px;box-shadow:0 4px 20px rgba(103,194,58,0.35);font-family:system-ui,-apple-system,sans-serif;animation:addrToastIn .35s ease;pointer-events:none';
  var style = document.createElement('style');
  style.textContent = '@keyframes addrToastIn{from{opacity:0;transform:translate(-50%,-50%) scale(.9)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}';
  document.head.appendChild(style);
  document.body.appendChild(toast);
  setTimeout(function() {
    toast.style.transition = 'opacity .4s';
    toast.style.opacity = '0';
    setTimeout(function() { toast.remove(); style.remove(); }, 400);
  }, 3000);
})()
`

// ============ 地址刷新脚本（注入到采购窗口，在结算页刷新地址列表） ============

const ADDRESS_REFRESH_SCRIPT = `
(function() {
  var url = window.location.href.toLowerCase();
  console.log('[AddressRefresh] Refreshing address on: ' + url.substring(0, 100));

  // 淘宝/天猫结算页：刷新地址列表并选中新地址
  if (url.includes('buy.taobao.com') || url.includes('buy.tmall.com')) {
    // 方案1：找到地址列表中最后一个地址（新添加的）并点击选中
    var addrItems = document.querySelectorAll('[class*="address"] [class*="item"], [class*="addrItem"], [data-value]');
    if (addrItems && addrItems.length > 0) {
      var lastItem = addrItems[addrItems.length - 1];
      lastItem.click();
      console.log('[AddressRefresh] Clicked last address item (total: ' + addrItems.length + ')');
    }
    // 方案2：尝试点击地址选择器下拉触发重新加载
    var addrSelector = document.querySelector('[class*="addressSelect"], [class*="addrSelect"], [class*="address-list"]');
    if (addrSelector && !addrItems.length) {
      addrSelector.click();
      console.log('[AddressRefresh] Clicked address selector');
    }
  }

  // 1688结算页：刷新地址列表
  if (url.includes('order.1688.com') || url.includes('trade.1688.com')) {
    var addrItems1688 = document.querySelectorAll('[class*="address"] [class*="item"], [class*="receiver-item"], [class*="addr-item"]');
    if (addrItems1688 && addrItems1688.length > 0) {
      addrItems1688[addrItems1688.length - 1].click();
      console.log('[AddressRefresh] Clicked last 1688 address item (total: ' + addrItems1688.length + ')');
    }
  }

  window.__addrRefreshDone = true;
})()
`

// ============ 登录页自动填充脚本 ============

/**
 * 生成登录表单自动填充脚本（注入到采购窗口）
 * 参考 platform-login-preload.js 的 fillLoginForm / setInputValue 实现
 * 使用 React 兼容的 nativeInputValueSetter 方式填充
 * 改进：属性匹配失败时回退到位置匹配（密码框前的文本输入框）
 */
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

// ============ 拼多多登录：不自动填充（和 dl 一致，用户手动登录） ============
// dl 不会自动填充 PDD 登录页的手机号，用户手动输入即可
// 自动填充可能被 PDD 反爬系统检测到

// ============ 后台地址设置窗口（独立隐藏窗口，共享session） ============

/**
 * 创建独立的后台隐藏窗口来设置收货地址
 * 参考DL系统：后台静默改地址，不影响主窗口（客户选品），节约时间
 *
 * - 共享同一 session（persist:purchase-{accountId}），地址改好后主窗口下单时自动使用
 * - 地址设置成功后自动关闭，通知主窗口
 * - 仅在需要登录/验证时才显示窗口
 * - 最长 120 秒自动关闭，防止泄漏
 */
function startBackgroundAddressSetup({ purchaseInfo, platform, parsedAddr, mainWindow, purchaseNo, partitionName, purchaseWin }) {
  const addrUrl = ADDRESS_MANAGE_URLS[platform]
  if (!addrUrl) return null

  // 通知前端：正在自动设置收货地址
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('purchase-address-setup-start', { purchaseNo })
  }

  const addrWin = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,  // 隐藏窗口，仅用于后台设置地址（需要登录/验证时再显示）
    title: `设置收货地址 - ${platform}`,
    webPreferences: {
      partition: partitionName,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // 注意：dl 不做 UA 伪装，Electron 默认 UA 对各平台正常工作

  // 120秒最大生存期，防止窗口泄漏
  const maxLifetime = setTimeout(() => {
    if (!addrWin.isDestroyed()) {
      console.log('[AddrSetupWin] Max lifetime reached, closing')
      addrWin.destroy()
    }
  }, 120000)

  // 转发后台窗口的console.log
  addrWin.webContents.on('console-message', (event, level, message) => {
    if (message.includes('[AddressAutoFill]') || message.includes('[PurchaseCapture]')) {
      console.log(`[AddrSetupWin] ${message}`)
    }
  })

  let addrDone = false

  // 注入地址脚本的统一入口
  function injectAddressScripts(url) {
    if (addrDone) return
    const urlLower = url.toLowerCase()

    // 淘宝地址管理页（排除中间跳转页）
    if (urlLower.includes('member1.taobao.com/member/fresh/deliver_address') && !urlLower.includes('_____tmd_____') && !urlLower.includes('login_jump')) {
      console.log('[AddrSetupWin] Taobao address manager page detected')
      if (parsedAddr) {
        setTimeout(() => {
          if (addrWin.isDestroyed() || addrDone) return
          const script = buildTaobaoAddressManagerScript(purchaseInfo.shippingName, purchaseInfo.shippingPhone, parsedAddr)
          addrWin.webContents.executeJavaScript(script).catch(() => {})
        }, 500)
      }
      return
    }

    // 1688地址管理页 - 点击"新增收货地址"
    if (urlLower.includes('wuliu.1688.com/foundation/receive_address_manager')) {
      console.log('[AddrSetupWin] 1688 address manager page detected')
      setTimeout(() => {
        if (addrWin.isDestroyed() || addrDone) return
        addrWin.webContents.executeJavaScript(build1688AddressManagerScript()).catch(() => {})
      }, 400)
      return
    }

    // 1688地址编辑弹窗页 - 填写表单+省市区级联
    if (urlLower.includes('air.1688.com/app/1688-global/address-manage/address-dialog')) {
      console.log('[AddrSetupWin] 1688 address dialog page detected')
      if (parsedAddr) {
        setTimeout(() => {
          if (addrWin.isDestroyed() || addrDone) return
          const script = build1688AddressDialogScript(purchaseInfo.shippingName, purchaseInfo.shippingPhone, parsedAddr)
          addrWin.webContents.executeJavaScript(script).catch(() => {})
        }, 400)
      }
      return
    }

    // 拼多多地址管理页 - 自动填写收货地址+省市区级联
    if (urlLower.includes('mobile.yangkeduo.com/addresses')) {
      console.log('[AddrSetupWin] Pinduoduo addresses page detected')
      if (parsedAddr) {
        setTimeout(() => {
          if (addrWin.isDestroyed() || addrDone) return
          const script = buildPddAddressScript(purchaseInfo.shippingName, purchaseInfo.shippingPhone, parsedAddr || parseAddress(purchaseInfo.shippingAddress))
          addrWin.webContents.executeJavaScript(script).catch(() => {})
        }, 1000)
      }
      return
    }
  }

  addrWin.webContents.on('dom-ready', () => {
    if (addrWin.isDestroyed() || addrDone) return
    const currentUrl = addrWin.webContents.getURL()
    console.log(`[AddrSetupWin] dom-ready: ${currentUrl.substring(0, 120)}`)
    injectAddressScripts(currentUrl)

    // 登录页自动填充：cookie 过期时地址管理页会重定向到登录页
    const urlLower = currentUrl.toLowerCase()
    const isLoginPage = urlLower.includes('login.taobao.com') ||
                        urlLower.includes('login.1688.com') ||
                        urlLower.includes('login.tmall.com') ||
                        (urlLower.includes('passport') && urlLower.includes('1688.com')) ||
                        (urlLower.includes('passport') && urlLower.includes('taobao.com')) ||
                        urlLower.includes('yangkeduo.com/login')
    if (isLoginPage && purchaseInfo.accountPassword && platform !== 'pinduoduo') {
      addrWin.show()  // 显示窗口让用户看到登录过程
      setTimeout(() => {
        if (addrWin.isDestroyed() || addrDone) return
        // 和 dl 一致：非 PDD 平台使用通用登录脚本（PDD 反爬严格，程序化 input 事件易被检测）
        const script = buildLoginAutoFillScript(purchaseInfo.accountName, purchaseInfo.accountPassword)
        if (script) {
          addrWin.webContents.executeJavaScript(script).catch(() => {})
          console.log('[AddrSetupWin] Login auto-fill injected (dom-ready) for expired cookie')
        }
      }, 1000)
    }
  })

  addrWin.webContents.on('did-navigate', (event, url) => {
    if (addrWin.isDestroyed() || addrDone) return
    console.log(`[AddrSetupWin] did-navigate: ${url.substring(0, 120)}`)
    injectAddressScripts(url)

    // 登录页自动填充：cookie 过期时地址管理页会重定向到登录页
    const urlLower = url.toLowerCase()
    const isLoginPage = urlLower.includes('login.taobao.com') ||
                        urlLower.includes('login.1688.com') ||
                        urlLower.includes('login.tmall.com') ||
                        (urlLower.includes('passport') && urlLower.includes('1688.com')) ||
                        (urlLower.includes('passport') && urlLower.includes('taobao.com')) ||
                        urlLower.includes('yangkeduo.com/login')
    if (isLoginPage && purchaseInfo.accountPassword && platform !== 'pinduoduo') {
      addrWin.show()  // 显示窗口让用户看到登录过程
      setTimeout(() => {
        if (addrWin.isDestroyed() || addrDone) return
        // 和 dl 一致：非 PDD 平台使用通用登录脚本（PDD 反爬严格，程序化 input 事件易被检测）
        const script = buildLoginAutoFillScript(purchaseInfo.accountName, purchaseInfo.accountPassword)
        if (script) {
          addrWin.webContents.executeJavaScript(script).catch(() => {})
          console.log('[AddrSetupWin] Login auto-fill injected for expired cookie')
        }
      }, 1000)
    }
  })

  // 地址设置结果轮询
  let checkCount = 0
  const checkTimer = setInterval(() => {
    checkCount++
    if (addrWin.isDestroyed() || addrDone) {
      clearInterval(checkTimer)
      return
    }
    // 最多等60秒
    if (checkCount > 60) {
      clearInterval(checkTimer)
      console.log('[AddrSetupWin] Address setup timeout')
      addrDone = true
      clearTimeout(maxLifetime)
      // 超时也通知完成，不阻塞主流程
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('purchase-address-setup-done', { purchaseNo })
      }
      if (!addrWin.isDestroyed()) addrWin.destroy()
      return
    }

    const checkScript = 'window.__addrManagerResult || window.__addrDialogResult || window.__tbAddrResult || window.__pddAddrResult || null'
    addrWin.webContents.executeJavaScript(checkScript)
      .then(result => {
        if (!result || addrDone) return
        console.log(`[AddrSetupWin] Address setup result: ${result}`)

        if (result === 'success' || result === 'submitted') {
          clearInterval(checkTimer)
          addrDone = true
          clearTimeout(maxLifetime)
          // 通知前端：地址设置完成
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('purchase-address-setup-done', { purchaseNo })
          }
          // 在采购小窗中显示绿色居中提示
          if (purchaseWin && !purchaseWin.isDestroyed()) {
            purchaseWin.webContents.executeJavaScript(ADDRESS_SUCCESS_TOAST).catch(() => {})
            // 延迟2秒后刷新结算页地址（等服务端地址数据传播完成）
            setTimeout(() => {
              if (purchaseWin.isDestroyed()) return
              const purchaseUrl = purchaseWin.webContents.getURL().toLowerCase()
              const isCheckout = purchaseUrl.includes('buy.taobao.com') ||
                                 purchaseUrl.includes('buy.tmall.com') ||
                                 purchaseUrl.includes('order.1688.com') ||
                                 purchaseUrl.includes('trade.1688.com')
              if (isCheckout) {
                purchaseWin.webContents.executeJavaScript(ADDRESS_REFRESH_SCRIPT).catch(() => {})
                console.log('[AddrSetupWin] Address refresh script injected to purchase window')
              }
            }, 2000)
          }
          // 延迟关闭，等保存完成
          setTimeout(() => {
            if (!addrWin.isDestroyed()) addrWin.destroy()
          }, 1500)
        } else if (result === 'need_login' || result === 'need_verify') {
          // 需要登录或验证 — 显示窗口让用户手动操作
          if (!addrWin.isDestroyed() && !addrWin.isVisible()) addrWin.show()
          console.log(`[AddrSetupWin] Address setup issue: ${result}, showing window`)
        } else if (result === 'no_button' || result === 'no_form') {
          clearInterval(checkTimer)
          addrDone = true
          clearTimeout(maxLifetime)
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('purchase-address-setup-done', { purchaseNo })
          }
          if (!addrWin.isDestroyed()) addrWin.destroy()
        }
      })
      .catch(() => {})
  }, 1000)

  // 加载地址管理页
  console.log(`[AddrSetupWin] Loading address management: ${addrUrl}`)
  addrWin.loadURL(addrUrl).catch(() => {})

  return addrWin
}

// ============ IPC 注册 ============

function registerPurchaseOrderCaptureIpc(mainWindow) {
  // 打开采购下单窗口
  ipcMain.handle('open-purchase-order-window', async (event, params) => {
    const { accountId, accountName, password, purchaseUrl, platform, purchaseInfo } = params
    const { purchaseNo } = purchaseInfo

    // 将 accountId 和 accountName 注入 purchaseInfo，供 autoCreateAndBind 使用
    purchaseInfo.accountId = accountId
    purchaseInfo.accountName = accountName || ''
    purchaseInfo.accountPassword = password || ''

    // 防重复
    if (activePurchaseWindows.has(purchaseNo)) {
      const existing = activePurchaseWindows.get(purchaseNo)
      if (existing.win && !existing.win.isDestroyed()) {
        existing.win.focus()
        return { success: true, message: '窗口已打开' }
      }
    }
    // ========== 所有平台：使用内嵌真实 Chrome（和 dl 内嵌 Chromium 一致） ==========
    const partitionName = `persist:purchase-${accountId}`
    console.log(`[PurchaseCapture] Opening window: partition=${partitionName}, url=${purchaseUrl}`)
    console.log(`[PurchaseCapture] Account info: accountId=${accountId}, accountName="${accountName || ''}", password=${password ? 'YES' : 'NO'}`)

    // ========== Cookie 恢复策略 ==========
    // 优先使用 partition 中已有的 cookie（来自登录窗口，最新鲜）
    // 只在 partition 无 PDD cookie 时才从服务器恢复（服务器 cookie 可能过时）
    const ses = session.fromPartition(partitionName)
    let partitionCookieCount = 0
    let needServerRestore = true
    try {
      const partitionCookies = await ses.cookies.get({})
      const pddCookies = partitionCookies.filter(c =>
        c.domain && (c.domain.includes('pinduoduo.com') || c.domain.includes('yangkeduo.com'))
      )
      partitionCookieCount = pddCookies.length
      if (platform === 'pinduoduo' && pddCookies.length > 0) {
        // PDD：partition 已有 cookie，跳过服务器恢复（避免用过时 cookie 覆盖新鲜 cookie）
        needServerRestore = false
        console.log(`[PurchaseCapture] Partition已有 ${pddCookies.length} 条PDD cookie，跳过服务器恢复`)
        // 刷盘确保持久化（非阻塞：cookie已在内存中，不阻塞窗口创建）
        flushStorageDataAsync(ses)
      }
    } catch (e) {
      console.warn('[PurchaseCapture] Partition cookie检查失败:', e.message)
    }

    // 从服务器加载 Cookie（仅在 partition 无 PDD cookie 时）
    let serverCookies = []
    if (needServerRestore) {
      try {
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
              const now = Date.now() / 1000
              let skipped = 0
              serverCookies = raw.filter(ck => {
                if (ck.expirationDate && ck.expirationDate > 0 && ck.expirationDate < now) {
                  skipped++
                  return false
                }
                return true
              })
              console.log(`[PurchaseCapture] Cookies loaded from server: ${serverCookies.length}/${raw.length} (${skipped} expired, skipped)`)
            }
          }
        }
      } catch (e) {
        console.warn('[PurchaseCapture] Cookie load failed:', e.message)
      }

      // 将服务器加载的 Cookie 写入 partition session
      if (serverCookies.length > 0) {
        try {
          let setOk = 0, setFail = 0
          for (const ck of serverCookies) {
            try {
              await ses.cookies.set({
                url: (ck.secure ? 'https://' : 'http://') + (ck.domain || '').replace(/^\./, '') + (ck.path || '/'),
                name: ck.name,
                value: ck.value || '',
                domain: ck.domain,
                path: ck.path || '/',
                secure: ck.secure || false,
                httpOnly: ck.httpOnly || false,
                expirationDate: ck.expirationDate || undefined,
                sameSite: ck.sameSite || undefined
              })
              setOk++
            } catch (e2) {
              setFail++
            }
          }
          console.log(`[PurchaseCapture] Cookies restored to session: ${setOk} ok, ${setFail} failed`)
          // 刷盘确保持久化（非阻塞：cookie已在内存中，不阻塞窗口创建）
          flushStorageDataAsync(ses)
        } catch (e) {
          console.warn('[PurchaseCapture] Cookie restore to session failed:', e.message)
        }
      }
    }

    // 提前计算地址设置需求
    const hasShippingInfo = purchaseInfo.shippingName || purchaseInfo.shippingPhone || purchaseInfo.shippingAddress
    const needAddrSetup = hasShippingInfo && (platform === '1688' || platform === 'taobao' || platform === 'pinduoduo')
    const parsedAddr = needAddrSetup ? parseAddress(purchaseInfo.shippingAddress) : null

    // 构建京东商品信息，供采购窗口浮层显示
    const jdInfo = JSON.stringify({
      goodsName: purchaseInfo.goodsName || '',
      image: purchaseInfo.image || '',
      sku: purchaseInfo.sku || '',
      quantity: purchaseInfo.quantity || 0,
      price: purchaseInfo.price || 0,
      purchasePrice: purchaseInfo.purchasePrice || 0,
      shippingName: purchaseInfo.shippingName || '',
      shippingPhone: purchaseInfo.shippingPhone || '',
      shippingAddress: purchaseInfo.shippingAddress || '',
      salesOrderNo: purchaseInfo.salesOrderNo || '',
      platform: platform || ''
    })

    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      show: true,
      title: `采购下单 - ${platform}`,
      webPreferences: {
        partition: partitionName,
        // ★ contextIsolation 必须为 false：反检测脚本需要在页面 JS 之前修改 navigator/webgl 等
        // contextIsolation=true 下 preload 修改的是隔离上下文，页面不可见，反检测完全无效
        // dl 的 CEF ExecuteJavaScript 在页面 JS 之前执行，我们通过 preload 实现同等效果
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'purchase-preload.js')
      }
    })

    // ========== 反爬指纹伪装（复用上方已获取的 ses 对象） ==========
    const chromeVersion = process.versions.chrome || '134.0.0.0'
    const cleanUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
    win.webContents.setUserAgent(cleanUA)
    const secChUa = `"Chromium";v="${chromeVersion.split('.')[0]}", "Google Chrome";v="${chromeVersion.split('.')[0]}", "Not-A.Brand";v="99"`
    ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
      if (details.requestHeaders) {
        details.requestHeaders['Sec-CH-UA'] = secChUa
        details.requestHeaders['Sec-CH-UA-Platform'] = '"Windows"'
        details.requestHeaders['User-Agent'] = cleanUA
      }
      callback({ requestHeaders: details.requestHeaders })
    })

    let resolved = false
    let pollTimer = null
    let backgroundAddrWin = null  // 后台地址设置窗口引用，用于cleanup联动
    let cachedProductInfo = null  // 缓存采购商品信息（从商品详情页提前提取）
    let pddAddrDone = false       // PDD地址是否已处理（参考dl的dlSetReceiver机制，防止结算页无限循环点击地址）
    let pddPayClicked = false     // PDD结算页是否已选择支付宝支付（防止dom-ready和did-navigate重复触发）
    let pddAddrAreaClicked = false // PDD结算页是否已点击地址区域（防止dom-ready和did-navigate重复触发）
    let pddCookieSaveTimer = null // PDD cookie 定期保存定时器
    const windowState = { win, pollTimer, resolved }
    activePurchaseWindows.set(purchaseNo, windowState)

    function cleanup() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      if (pddCookieSaveTimer) { clearInterval(pddCookieSaveTimer); pddCookieSaveTimer = null }
      // 联动清理后台地址窗口
      if (backgroundAddrWin && !backgroundAddrWin.isDestroyed()) {
        backgroundAddrWin.destroy()
        backgroundAddrWin = null
      }
      // 清理 session 上的 onBeforeSendHeaders 监听器（防止泄漏到其他窗口）
      try {
        const ses = session.fromPartition(partitionName)
        ses.webRequest.onBeforeSendHeaders(null)
      } catch (e) {}
      windowState.pollTimer = null
      activePurchaseWindows.delete(purchaseNo)
    }

    // 保存采购窗口的Cookie到服务器（用户可能在窗口内登录了）
    async function savePurchaseWindowCookies() {
      try {
        let cookies
        const ses = session.fromPartition(partitionName)
        cookies = await ses.cookies.get({})
        if (cookies && cookies.length > 0) {
          await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie_data: JSON.stringify(cookies), platform })
          })
          console.log(`[PurchaseCapture] Cookie saved on window close: ${cookies.length} cookies`)

          // 同步更新采购账号在线状态
          try {
            await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ online: true })
            })
            console.log(`[PurchaseCapture] 采购账号 ${accountId} 状态已更新为在线`)
          } catch (statusErr) {
            console.warn('[PurchaseCapture] 更新采购账号在线状态失败:', statusErr.message)
          }
        }
      } catch (e) {
        console.error('[PurchaseCapture] Save cookies failed:', e.message)
      }

      // 刷盘确保 persist:partition 数据持久化到磁盘（关键！否则重启后cookie丢失）
      try {
        const ses = session.fromPartition(partitionName)
        ses.flushStorageData(() => {
          console.log('[PurchaseCapture] Purchase partition数据已刷盘')
        })
      } catch (e) {
        console.error('[PurchaseCapture] Purchase partition刷盘失败:', e.message)
      }
    }

    function onOrderCaptured(platformOrderNo) {
      if (resolved) return
      resolved = true
      windowState.resolved = true
      console.log(`[PurchaseCapture] onOrderCaptured called: orderNo=${platformOrderNo}, winExists=${!!win}, winDestroyed=${win ? win.isDestroyed() : 'N/A'}`)
      cleanup()

      // 保存Cookie（用户在窗口内可能登录了，积累了新Cookie）
      savePurchaseWindowCookies()

      // 先提取实际支付金额和采购商品信息，再执行绑定
      let capturedAmount = null
      const doBindAndNotify = () => {
        console.log(`[PurchaseCapture] doBindAndNotify called, starting autoCreateAndBind...`)
        autoCreateAndBind(purchaseInfo, platformOrderNo, platform, capturedAmount)
          .then(async () => {
            console.log(`[PurchaseCapture] Auto-bind 成功: purchaseNo=${purchaseNo}, orderNo=${platformOrderNo}`)
            // 系统备注已在 autoCreateAndBind 内部写入，这里只发送通知事件
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('purchase-order-captured', {
                purchaseNo,
                platformOrderNo,
                platform,
                success: true,
                sysRemark: `【${purchaseNo}】${platformOrderNo} ${capturedAmount || purchaseInfo.purchasePrice || ''}（${purchaseInfo.accountName || ''}）`,
                salesOrderId: purchaseInfo.salesOrderId || null
              })
            }
          })
          .catch(err => {
            console.error(`[PurchaseCapture] Auto-bind 失败:`, err.message)
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('purchase-order-captured', {
                purchaseNo,
                platformOrderNo,
                platform,
                success: false,
                error: err.message
              })
            }
          })
      }

      // 从当前页面提取实际支付金额；商品信息优先使用缓存（从商品详情页/API拦截器提前提取）
      // 订单号捕获时页面可能已跳转到支付宝，直接从当前页面提取会拿到"登录中心-支付宝"等错误信息
      if (win && !win.isDestroyed()) {
        // 提取支付金额（当前页面仍可提取）；如果无缓存则也尝试从渲染进程API缓存提取商品信息
        const extractPromises = [
          win.webContents.executeJavaScript(EXTRACT_PAYMENT_AMOUNT).catch(() => null)
        ]
        if (!cachedProductInfo) {
          // 先尝试从渲染进程的API拦截器缓存中提取（window.__cachedProductInfo）
          // 如果有，就不需要再从当前页面DOM提取了
          extractPromises.push(
            win.webContents.executeJavaScript('window.__cachedProductInfo ? JSON.stringify(window.__cachedProductInfo) : null')
              .then(result => {
                if (result) {
                  try {
                    const info = JSON.parse(result)
                    if (info && (info.title || info.image)) {
                      cachedProductInfo = info
                      console.log(`[PurchaseCapture] 商品信息从渲染进程API缓存获取: title=${(info.title || '').substring(0, 40)}`)
                      return result  // 返回非null表示已获取
                    }
                  } catch (e) {}
                }
                return null
              })
              .catch(() => null)
          )
        }

        Promise.all(extractPromises).then(async (results) => {
            const amount = results[0]
            const rendererCachedStr = results[1]  // 渲染进程API缓存（可能为undefined/null）

            if (amount && amount > 0) {
              capturedAmount = amount
              console.log(`[PurchaseCapture] Payment amount captured: ¥${amount}`)
            } else {
              console.log('[PurchaseCapture] No payment amount captured from page/API cache')

              // 淘宝/天猫：参照DL系统，直接调用 asyncBought.htm API 获取支付金额
              // DL做法：在confirm_order页面提取b2c_orid后，立即POST asyncBought获取actualFee
              if ((platform === 'taobao' || platform === 'tmall') && platformOrderNo && win && !win.isDestroyed()) {
                try {
                  console.log(`[PurchaseCapture] 淘宝：尝试调用asyncBought API获取支付金额, orderID=${platformOrderNo}`)
                  const tbAmountScript = `
                    (function() {
                      return fetch('https://buyertrade.taobao.com/trade/itemlist/asyncBought.htm?action=itemlist/BoughtQueryAction&event_submit_do_query=1&_input_charset=utf8', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: 'buyerNick=&dateBegin=0&dateEnd=0&itemTitle=${encodeURIComponent(platformOrderNo)}&lastStartRow=&logisticsService=&options=0&orderStatus=&pageNum=1&pageSize=15&queryBizType=&queryOrder=desc&rateStatus=&refund=&sellerNick=&auctionTitle=${encodeURIComponent(platformOrderNo)}&prePageNo=1'
                      }).then(function(r) { return r.text() }).then(function(text) {
                        try {
                          var data = JSON.parse(text);
                          var mainOrders = data.mainOrders;
                          if (!mainOrders || mainOrders.length === 0) return JSON.stringify({error: 'no_orders'});
                          var orderItem = mainOrders[0];
                          var actualFee = orderItem.payInfo && orderItem.payInfo.actualFee;
                          if (actualFee && parseFloat(actualFee) > 0) {
                            return JSON.stringify({actualFee: parseFloat(actualFee)});
                          }
                          return JSON.stringify({error: 'no_fee', payInfo: JSON.stringify(orderItem.payInfo || {})});
                        } catch(e) {
                          return JSON.stringify({error: e.message});
                        }
                      }).catch(function(e) {
                        return JSON.stringify({error: e.message});
                      });
                    })()
                  `
                  const tbAmountResult = await win.webContents.executeJavaScript(tbAmountScript).catch(() => null)
                  if (tbAmountResult) {
                    try {
                      const tbData = JSON.parse(tbAmountResult)
                      if (tbData.actualFee && tbData.actualFee > 0) {
                        capturedAmount = tbData.actualFee
                        console.log(`[PurchaseCapture] 淘宝asyncBought获取支付金额: ¥${capturedAmount}`)
                      } else {
                        console.log(`[PurchaseCapture] 淘宝asyncBought未获取到金额: ${tbAmountResult.substring(0, 200)}`)
                      }
                    } catch (e) {
                      console.log(`[PurchaseCapture] 淘宝asyncBought解析失败: ${e.message}`)
                    }
                  }
                } catch (e) {
                  console.log(`[PurchaseCapture] 淘宝asyncBought调用失败: ${e.message}`)
                }
              }
            }

            // 应用商品信息缓存（已有主进程缓存 或 渲染进程API缓存）
            if (!cachedProductInfo && rendererCachedStr) {
              try {
                const info = JSON.parse(rendererCachedStr)
                if (info && (info.title || info.image)) {
                  cachedProductInfo = info
                }
              } catch (e) {}
            }

            if (cachedProductInfo) {
              if (cachedProductInfo.title && isValidProductTitle(cachedProductInfo.title)) {
                purchaseInfo.goodsName = cachedProductInfo.title
                console.log(`[PurchaseCapture] 商品名已覆盖(缓存): ${cachedProductInfo.title}`)
              } else if (cachedProductInfo.title) {
                console.warn(`[PurchaseCapture] 商品名验证失败(缓存), 忽略: ${cachedProductInfo.title}`)
              }
              if (cachedProductInfo.image && isValidProductImage(cachedProductInfo.image)) {
                purchaseInfo.image = cachedProductInfo.image
                console.log(`[PurchaseCapture] 商品图片已覆盖(缓存)`)
              }
              if (cachedProductInfo.sku) {
                purchaseInfo.sku = cachedProductInfo.sku
                console.log(`[PurchaseCapture] SKU已覆盖(缓存): ${cachedProductInfo.sku}`)
              }
              if (cachedProductInfo.quantity && !purchaseInfo.quantity) {
                purchaseInfo.quantity = parseInt(cachedProductInfo.quantity) || 0
                console.log(`[PurchaseCapture] 数量已覆盖(缓存): ${cachedProductInfo.quantity}`)
              }
            }

            // ★ 如果缓存标题无效，尝试DOM提取兜底
            // ★★ PDD特殊：优先使用PDD订单搜索API获取商品信息（跟DL一样）
            const hasGoodTitle = purchaseInfo.goodsName && purchaseInfo.goodsName.length > 4
            const hasGoodImage = purchaseInfo.image && isValidProductImage(purchaseInfo.image)
            if ((!hasGoodTitle || !hasGoodImage) && platform === 'pinduoduo' && platformOrderNo) {
              // PDD订单搜索API：跟DL一样，加载搜索结果页面，解析window.rawData中的orderGoods
              try {
                console.log(`[PurchaseCapture] PDD缓存标题无效，尝试订单搜索API: orderSn=${platformOrderNo}`)
                const pddSearchResult = await win.webContents.executeJavaScript(`
                  (function() {
                    return fetch('https://mobile.yangkeduo.com/transac_orders_search_results.html?keyWord=${encodeURIComponent(platformOrderNo)}&type=1&refer_page_name=transac_orders_search_results', {
                      credentials: 'include'
                    }).then(function(r) { return r.text() }).then(function(html) {
                      // 从SSR HTML中提取window.rawData（跟DL一样的方式）
                      var start = html.indexOf('window.rawData=');
                      if (start < 0) return JSON.stringify({error: 'no_rawData'});
                      var dataStr = html.substring(start + 'window.rawData='.length);
                      // DL方式：找到"}};"截止，然后补回"}}"
                      var endIdx = dataStr.indexOf('}};');
                      if (endIdx < 0) return JSON.stringify({error: 'no_end'});
                      dataStr = dataStr.substring(0, endIdx + 2);
                      // DL方式：去掉嵌套JSON字符串（,"msg":"{...},"style":）避免解析失败
                      var pos1 = dataStr.indexOf(',"msg":"{');
                      var pos2 = dataStr.indexOf('},"style":');
                      if (pos1 >= 0 && pos2 >= 0 && pos2 > pos1) {
                        dataStr = dataStr.substring(0, pos1) + dataStr.substring(pos2);
                      }
                      try {
                        var data = JSON.parse(dataStr);
                        var orders = data.resultStore && data.resultStore.orders;
                        if (!orders || orders.length === 0) return JSON.stringify({error: 'no_orders', rawKeys: Object.keys(data)});
                        var order = orders[0];
                        var goods = order.orderGoods && order.orderGoods[0];
                        if (!goods) return JSON.stringify({error: 'no_orderGoods', orderKeys: orderKeys});
                        return JSON.stringify({
                          goodsName: goods.goodsName || '',
                          goodsPrice: goods.goodsPrice || '',
                          goodsNumber: goods.goodsNumber || 1,
                          spec: goods.spec || '',
                          goodsImage: goods.thumbUrl || goods.goodsImage || goods.imageUrl || '',
                          orderAmount: order.orderAmount || '',
                          orderSn: order.orderSn || '',
                          trackingNumber: order.trackingNumber || '',
                          combinedOrderStatus: order.combinedOrderStatus || 0,
                          shippingTime: order.shippingTime || 0,
                          receiveTime: order.receiveTime || 0
                        });
                      } catch(e) {
                        return JSON.stringify({error: 'parse_error', msg: e.message, sample: dataStr.substring(0, 300)});
                      }
                    }).catch(function(e) {
                      return JSON.stringify({error: 'fetch_error', msg: e.message});
                    });
                  })()
                `).catch(() => null)

                if (pddSearchResult) {
                  console.log(`[PurchaseCapture] PDD订单搜索API结果: ${pddSearchResult.substring(0, 300)}`)
                  try {
                    const pddInfo = JSON.parse(pddSearchResult)
                    if (pddInfo.goodsName) {
                      purchaseInfo.goodsName = pddInfo.goodsName
                      console.log(`[PurchaseCapture] 商品名已覆盖(PDD订单搜索API): ${pddInfo.goodsName}`)
                    }
                    if (pddInfo.goodsImage && isValidProductImage(pddInfo.goodsImage)) {
                      purchaseInfo.image = pddInfo.goodsImage
                      console.log(`[PurchaseCapture] 商品图片已覆盖(PDD订单搜索API): ${pddInfo.goodsImage.substring(0, 80)}`)
                    }
                    if (pddInfo.spec) {
                      purchaseInfo.sku = pddInfo.spec
                      console.log(`[PurchaseCapture] SKU已覆盖(PDD订单搜索API): ${pddInfo.spec}`)
                    }
                    if (pddInfo.goodsNumber) {
                      purchaseInfo.quantity = pddInfo.goodsNumber
                      console.log(`[PurchaseCapture] 数量已覆盖(PDD订单搜索API): ${pddInfo.goodsNumber}`)
                    }
                    if (pddInfo.goodsPrice) {
                      purchaseInfo.unitPrice = pddInfo.goodsPrice
                      console.log(`[PurchaseCapture] 单价已覆盖(PDD订单搜索API): ${pddInfo.goodsPrice}`)
                    }
                    if (pddInfo.trackingNumber) {
                      purchaseInfo.trackingNumber = pddInfo.trackingNumber
                      console.log(`[PurchaseCapture] 快递单号已提取(PDD订单搜索API): ${pddInfo.trackingNumber}`)
                    }
                    if (pddInfo.shippingTime) {
                      purchaseInfo.shippingTime = pddInfo.shippingTime
                      console.log(`[PurchaseCapture] 发货时间已提取(PDD订单搜索API): ${pddInfo.shippingTime}`)
                    }
                    if (pddInfo.error) {
                      console.warn(`[PurchaseCapture] PDD订单搜索API错误: ${pddInfo.error}`, pddInfo.msg || pddInfo.rawKeys || '')
                    }
                  } catch (e) {
                    console.warn('[PurchaseCapture] PDD订单搜索API解析失败:', e.message)
                  }
                }
              } catch (e) {
                console.warn('[PurchaseCapture] PDD订单搜索API调用失败:', e.message)
              }
            } else if (!hasGoodTitle) {
              try {
                const domResult = await win.webContents.executeJavaScript(EXTRACT_PURCHASE_PRODUCT_INFO).catch(() => null)
                if (domResult) {
                  const productInfo = JSON.parse(domResult)
                  if (productInfo.title && isValidProductTitle(productInfo.title) && productInfo.title.length > (purchaseInfo.goodsName || '').length) {
                    purchaseInfo.goodsName = productInfo.title
                    console.log(`[PurchaseCapture] 商品名已覆盖(实时DOM,覆盖弱缓存): ${productInfo.title}`)
                  } else if (productInfo.title) {
                    console.log(`[PurchaseCapture] 实时DOM标题不优于缓存: DOM=${productInfo.title}, 缓存=${purchaseInfo.goodsName || '空'}`)
                  }
                  if (productInfo.image && isValidProductImage(productInfo.image) && !purchaseInfo.image) {
                    purchaseInfo.image = productInfo.image
                    console.log(`[PurchaseCapture] 商品图片已覆盖(实时DOM)`)
                  }
                  if (productInfo.sku && !purchaseInfo.sku) {
                    purchaseInfo.sku = productInfo.sku
                    console.log(`[PurchaseCapture] SKU已覆盖(实时DOM): ${productInfo.sku}`)
                  }
                  if (productInfo.quantity && !purchaseInfo.quantity) {
                    purchaseInfo.quantity = parseInt(productInfo.quantity) || 0
                    console.log(`[PurchaseCapture] 数量已覆盖(实时DOM): ${productInfo.quantity}`)
                  }
                }
              } catch (e) {
                console.warn('[PurchaseCapture] DOM商品信息提取失败:', e.message)
              }
            }

            // 同步实际支付金额到采购价（覆盖初始值）
            if (capturedAmount && capturedAmount > 0) {
              purchaseInfo.purchasePrice = capturedAmount
              console.log(`[PurchaseCapture] 采购价已更新: ¥${capturedAmount}`)
            }

            doBindAndNotify()
          }).catch(() => {
            console.log('[PurchaseCapture] Payment amount & product info extraction failed')
            doBindAndNotify()
          })
      } else {
        doBindAndNotify()
      }

      // 淘宝平台不自动关闭窗口（用户需要在支付宝页面完成支付后手动关闭）
      // 其他平台5秒后自动关闭窗口
      if (platform !== 'taobao') {
        setTimeout(() => {
          if (win && !win.isDestroyed()) {
            win.destroy()
          }
        }, 5000)
      }
    }

    function onWindowClosed() {
      // 无论是否捕获到订单号，都保存Cookie（用户可能在窗口内登录了）
      savePurchaseWindowCookies()

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

    // 注入 API 拦截器（地址设置已移到独立后台窗口，主窗口不处理地址逻辑）

    // 核心：监听拦截器的实时订单号通知
    // 拦截器在API响应到达时立即通过 console.log('[PURCHASE_ORDER_FOUND]xxx') 通知
    // 这比轮询快得多，即使页面马上跳转也能捕获到
    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
      if (!message || resolved) return
      if (message.startsWith('[PURCHASE_ORDER_FOUND]')) {
        const orderNo = message.substring('[PURCHASE_ORDER_FOUND]'.length).trim()
        // 淘宝纯数字（≥10位），拼多多字母数字+连字符（如260506-070338506260381）
        if (orderNo && /^[A-Za-z0-9\-]{10,}$/.test(orderNo)) {
          console.log(`[PurchaseCapture] Order found via real-time interceptor: ${orderNo} (platform=${platform})`)
          onOrderCaptured(orderNo)
        } else {
          console.log(`[PurchaseCapture] Interceptor found candidate but invalid: "${orderNo}"`)
        }
      }
      // PDD API 响应日志转发（搞清楚 PDD 实际 API 路径）
      if (platform === 'pinduoduo' && message.startsWith('[PDD_API_CAPTURED]')) {
        console.log(`[PurchaseCapture] ${message}`)
      }
      // PDD订单API响应体内容（确认order_sn字段格式）
      if (platform === 'pinduoduo' && message.startsWith('[PDD_ORDER_API]')) {
        console.log(`[PurchaseCapture] ${message}`)
      }
      // API拦截器实时缓存的商品信息（比dom-ready更快、更可靠）
      // ★ PDD跳过：PDD的cacheProductInfoFromBody已被禁用，不应有此消息
      if (message.startsWith('[PURCHASE_PRODUCT_CACHED]') && platform !== 'pinduoduo') {
        try {
          const info = JSON.parse(message.substring('[PURCHASE_PRODUCT_CACHED]'.length))
          if (info && (info.title || info.image)) {
            cachedProductInfo = info
            console.log(`[PurchaseCapture] 商品信息已缓存(API拦截): title=${(info.title || '').substring(0, 40)}, image=${info.image ? 'YES' : 'NO'}, sku=${(info.sku || '').substring(0, 30)}`)

            // 商品信息成功提取 = 页面确认正常加载
            // PDD 不使用后台地址窗口：dl的流程是在结算页点击地址区域跳转到地址管理页，在同一窗口内完成
            // 淘宝/1688 仍使用后台地址窗口（独立页面流程）
            if (needAddrSetup && parsedAddr && !backgroundAddrWin && platform !== 'pinduoduo') {
              backgroundAddrWin = startBackgroundAddressSetup({
                purchaseInfo, platform, parsedAddr, mainWindow, purchaseNo, partitionName, purchaseWin: win
              })
            }
          }
        } catch (e) {}
      }
    })

    console.log(`[PurchaseCapture] Address check: platform=${platform}, hasShippingInfo=${!!hasShippingInfo}, needAddrSetup=${needAddrSetup}`)
    console.log(`[PurchaseCapture] Shipping: name="${purchaseInfo.shippingName}", phone="${purchaseInfo.shippingPhone}", addr="${(purchaseInfo.shippingAddress || '').substring(0, 50)}"`)
    if (needAddrSetup) {
      console.log(`[PurchaseCapture] Address setup needed for ${platform}, parsed:`, parsedAddr ? `${parsedAddr.province}/${parsedAddr.city}/${parsedAddr.area}/${parsedAddr.other}` : 'PARSE_FAILED')
    }

    win.webContents.on('dom-ready', () => {
      if (win.isDestroyed() || resolved) return

      const currentUrl = win.webContents.getURL()
      console.log(`[PurchaseCapture] dom-ready: ${currentUrl.substring(0, 120)}`)

      // ★ 反检测由 preload 在页面 JS 之前注入（contextIsolation=false 下 preload 直接修改页面 navigator 等）
      // 不再需要 executeJavaScript 注入 ANTI_DETECT_SCRIPT

      // 主窗口始终注入订单拦截器（和 dl 一致）
      win.webContents.executeJavaScript(PURCHASE_INTERCEPTOR).catch(() => {})
      console.log('[PurchaseCapture] Interceptor injected (anti-detect handled by preload)')

      // 注入商品信息浮层（采购页面右上角显示销售订单商品信息，方便对比）
      // ★ PDD 安全策略（参考 dl）：脚本内部通过 URL 正则判断只在商品详情页创建浮层 DOM
      //   登录页/结算页/支付页等一律跳过，和 dl 的 pddBuyer 行为一致
      // ★ 合并为单次 executeJavaScript：确保 __jdProductInfo 在 overlay 脚本执行前已设置
      win.webContents.executeJavaScript(`window.__jdProductInfo = ${jdInfo}; ${PRODUCT_INFO_OVERLAY}`)
        .then(result => {
          if (result) console.log(`[PurchaseCapture] Overlay result: ${result}`)
        })
        .catch(() => {})

      // === 登录页自动填充 ===
      const urlLower = currentUrl.toLowerCase()
      const isLoginPage = urlLower.includes('login.taobao.com') ||
                          urlLower.includes('login.1688.com') ||
                          urlLower.includes('login.tmall.com') ||
                          (urlLower.includes('passport') && urlLower.includes('1688.com')) ||
                          (urlLower.includes('passport') && urlLower.includes('taobao.com')) ||
                          urlLower.includes('yangkeduo.com/login')

      if (isLoginPage && purchaseInfo.accountPassword && !resolved && platform !== 'pinduoduo') {
        // ★ PDD 不自动填充：PDD 反爬严格，程序化 input 事件（无 keyboard 事件）容易被检测
        //   且 dl 也不会自动填充 PDD 登录页，用户手动输入即可
        setTimeout(() => {
          if (win.isDestroyed() || resolved) return
          // 和 dl 一致：非 PDD 平台使用通用登录脚本
          const script = buildLoginAutoFillScript(purchaseInfo.accountName, purchaseInfo.accountPassword)
          if (script) {
            win.webContents.executeJavaScript(script).catch(() => {})
            console.log('[PurchaseCapture] Login auto-fill script injected')
          }
        }, 1000)
      }

      // 注意：不再注入 PDD 排队页自动重载脚本
      // 原因：dl 没有此逻辑，说明清理 partition 后不应出现"排队中"
      // 且每次 dom-ready 注入额外 JS 脚本可能被 PDD 反爬系统检测到
      // 如果仍然出现排队，用户可以手动刷新页面

      // === 关键：在商品详情页/结算页提前缓存商品信息 ===
      // 订单号捕获时页面可能已跳转到支付宝，此时再提取就拿到"登录中心-支付宝"了
      // 所以必须在商品详情页/结算页时就把商品信息缓存住
      // ★ PDD不用DOM提取：PDD的商品信息完全由订单搜索API提供（goodsName/goodsPrice/goodsNumber/spec）
      //   结算页DOM提取标题不准（如"商城"），反而干扰。PDD的图片暂缺也不影响核心功能。
      const isProductPage = urlLower.includes('item.taobao.com') ||
                            urlLower.includes('detail.tmall.com') ||
                            urlLower.includes('detail.1688.com') ||
                            urlLower.includes('item.jd.com')
      const isCheckoutUrl = urlLower.includes('buy.taobao.com') ||
                             urlLower.includes('buy.tmall.com') ||
                             urlLower.includes('order.1688.com') ||
                             urlLower.includes('trade.1688.com')

      if ((isProductPage || isCheckoutUrl) && !cachedProductInfo) {
        // 延迟提取，等页面渲染完成
        setTimeout(() => {
          if (win.isDestroyed() || resolved) return
          if (cachedProductInfo) return
          win.webContents.executeJavaScript(EXTRACT_PURCHASE_PRODUCT_INFO)
            .then(result => {
              if (!result || resolved) return
              try {
                const info = JSON.parse(result)
                if ((info.title && isValidProductTitle(info.title)) || info.image) {
                  cachedProductInfo = info
                  console.log(`[PurchaseCapture] 商品信息已缓存: title=${(info.title || '').substring(0, 40)}, image=${info.image ? 'YES' : 'NO'}, sku=${(info.sku || '').substring(0, 30)}`)

                  // 商品信息成功提取 = 页面确认正常加载
                  // PDD 不使用后台地址窗口：dl的流程是在结算页点击地址区域跳转到地址管理页
                  if (needAddrSetup && parsedAddr && !backgroundAddrWin && platform !== 'pinduoduo') {
                    backgroundAddrWin = startBackgroundAddressSetup({
                      purchaseInfo, platform, parsedAddr, mainWindow, purchaseNo, partitionName, purchaseWin: win
                    })
                  }
                }
              } catch (e) {
                console.warn('[PurchaseCapture] 商品信息缓存解析失败:', e.message)
              }
            })
            .catch(() => {})
        }, isProductPage ? 2000 : 1000)  // 商品详情页多等一会儿

        // 二次提取尝试（针对慢加载页面）
        if (isProductPage) {
          setTimeout(() => {
            if (win.isDestroyed() || resolved) return
            if (cachedProductInfo) return
            win.webContents.executeJavaScript(EXTRACT_PURCHASE_PRODUCT_INFO)
              .then(result => {
                if (!result || resolved) return
                if (cachedProductInfo) return
                try {
                  const info = JSON.parse(result)
                  if ((info.title && isValidProductTitle(info.title)) || info.image) {
                    cachedProductInfo = info
                    console.log(`[PurchaseCapture] 商品信息二次缓存: title=${(info.title || '').substring(0, 40)}, image=${info.image ? 'YES' : 'NO'}`)
                  }
                } catch (e) {}
              })
              .catch(() => {})
          }, 5000)
        }
      }

      // 页面加载后延迟自动保存 cookies 到服务器（获取 _m_h5_tk 等 token）
      if (platform === 'taobao') {
        setTimeout(async () => {
          if (win.isDestroyed() || resolved) return
          try {
            let cookies
            const ses = session.fromPartition(partitionName)
            cookies = await ses.cookies.get({})
            if (cookies && cookies.length > 0) {
              const hasH5Tk = cookies.some(c => c.name === '_m_h5_tk')
              if (hasH5Tk) {
                await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ cookie_data: JSON.stringify(cookies), platform })
                })
                console.log(`[PurchaseCapture] 自动保存 cookies: ${cookies.length} 条, _m_h5_tk=有`)
              } else {
                console.log('[PurchaseCapture] 页面加载后仍未获取到 _m_h5_tk，跳过自动保存')
              }
            }
          } catch (e) {
            console.warn('[PurchaseCapture] 自动保存 cookies 失败:', e.message)
          }
        }, 6000)
      }

      // ★ PDD 定期保存 cookies 到服务器（PDD 的 token 频繁轮换，必须定期刷新服务器端缓存）
      // 首次保存：页面加载 5 秒后；之后每 60 秒保存一次
      if (platform === 'pinduoduo') {
        const pddSaveCookies = async () => {
          if (win.isDestroyed() || resolved) {
            if (pddCookieSaveTimer) { clearInterval(pddCookieSaveTimer); pddCookieSaveTimer = null }
            return
          }
          try {
            const ses = session.fromPartition(partitionName)
            const cookies = await ses.cookies.get({})
            if (cookies && cookies.length > 0) {
              await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cookie_data: JSON.stringify(cookies), platform })
              })
              console.log(`[PurchaseCapture] PDD 定期保存 cookies: ${cookies.length} 条`)
            }
          } catch (e) {
            console.warn('[PurchaseCapture] PDD 定期保存 cookies 失败:', e.message)
          }
        }
        // 首次保存：5秒后
        setTimeout(pddSaveCookies, 5000)
        // 之后每 60 秒保存一次
        pddCookieSaveTimer = setInterval(pddSaveCookies, 60000)
      }

      // === 结算页地址处理 ===
      const { shippingName, shippingPhone, shippingAddress } = purchaseInfo
      if ((shippingName || shippingPhone || shippingAddress)) {
        if (isCheckoutPage(currentUrl, platform)) {
          if (platform === 'pinduoduo') {
            // PDD 结算页：参考 dl 的 dlSetReceiver 机制
            // pddAddrDone=false → 需要设置地址，点击地址区域
            // pddAddrDone=true  → 地址已设置完成，选择支付宝支付方式（对齐 dl：默认微信，切支付宝才能抓订单号）
            if (!pddAddrDone && !pddAddrAreaClicked) {
              pddAddrAreaClicked = true
              setTimeout(() => {
                if (win.isDestroyed() || resolved || pddAddrDone) return
                const clickAddrScript = `
                  (function() {
                    if (document.querySelector(".oc-address-info")) {
                      document.querySelector(".oc-address-info").click();
                    } else if (document.querySelector(".oc-address")) {
                      document.querySelector(".oc-address").querySelectorAll("div")[1].click();
                    }
                  })()
                `
                win.webContents.executeJavaScript(clickAddrScript).catch(() => {})
                console.log('[PurchaseCapture] PDD: clicked address selector on checkout page (dom-ready)')
              }, 1500)
            } else if (pddAddrDone && !pddPayClicked) {
              // ★ 对齐DL：点击支付宝支付（DL line 5755-5756）
              // PDD默认微信支付，DL自动切支付宝，支付宝页面检测到后提取订单号绑定
              pddPayClicked = true
              setTimeout(() => {
                if (win.isDestroyed() || resolved) return
                const clickAlipayScript = `
                  (function() {
                    function simClick(el) {
                      var rect = el.getBoundingClientRect();
                      var x = rect.left + rect.width / 2;
                      var y = rect.top + rect.height / 2;
                      ['mousedown','mouseup','click'].forEach(function(type) {
                        var evt = document.createEvent('MouseEvents');
                        evt.initMouseEvent(type, true, true, window, 1, x, y, x, y, false, false, false, false, 0, null);
                        el.dispatchEvent(evt);
                      });
                    }
                    var mainEl = document.querySelector("#main");
                    if (!mainEl) return '#main not found';
                    var mainDiv = mainEl.querySelector("div");
                    if (!mainDiv) return '#main > div not found';
                    var divs = mainDiv.querySelectorAll(":scope > div");
                    for (var d = 0; d < divs.length; d++) {
                      var sectionText = divs[d].innerText || '';
                      if (sectionText.indexOf('微信') >= 0 && sectionText.indexOf('支付宝') >= 0) {
                        var subDivs = divs[d].querySelectorAll(':scope > div');
                        for (var s = 0; s < subDivs.length; s++) {
                          var subText = subDivs[s].innerText || '';
                          if (subText.indexOf('支付宝') >= 0 && subText.indexOf('微信') < 0) {
                            simClick(subDivs[s]);
                            return 'simClicked section[' + d + ']>div[' + s + ']: ' + subText.substring(0, 20);
                          }
                        }
                        var candidates = divs[d].querySelectorAll('*');
                        for (var i = 0; i < candidates.length; i++) {
                          if (candidates[i].innerText === '支付宝' || candidates[i].textContent.trim() === '支付宝') {
                            var target = candidates[i];
                            for (var j = 0; j < 2; j++) {
                              if (target.parentElement && target.parentElement.children.length <= 3) {
                                target = target.parentElement;
                              }
                            }
                            simClick(target);
                            return 'simClicked text-match in section[' + d + ']';
                          }
                        }
                      }
                    }
                    return 'alipay not found at all';
                  })()
                `
                win.webContents.executeJavaScript(clickAlipayScript).then(result => {
                  console.log(`[PurchaseCapture] PDD Alipay result: ${result}`)
                }).catch(() => {})
              }, 2000)
            }
          } else if (platform !== '1688' && platform !== 'taobao' && platform !== 'tmall') {
            // 淘宝/天猫的地址设置在后台窗口 startBackgroundAddressSetup 中完成，不在采购窗口注入
            // buildAddressAutoFillScript 的 Phase 3 会点击"管理收货地址"导致采购窗口跳转到地址管理页
            const fillScript = buildAddressAutoFillScript(shippingName, shippingPhone, shippingAddress, platform)
            win.webContents.executeJavaScript(fillScript).catch(() => {})
            console.log(`[PurchaseCapture] Address auto-fill injected for checkout page`)
          }
        }
        // 拼多多：地址管理页自动填写只在 did-navigate 中注入（避免双重注入）
        // dom-ready 和 did-navigate 事件时序可能导致同一脚本执行两次
      }

      // 检测是否为订单确认/支付回调页面，尝试提取订单号（和 dl 一致）
      tryExtractOrderFromPage(currentUrl)
    })

    // 从URL和页面内容中提取订单号的核心函数
    // 淘宝：DL系统方案 - 三重检测：
    //   1. API响应轮询搜索 b2c_orid（最可靠，不依赖页面跳转时序）
    //   2. confirm_order页提取 b2c_orid（页面HTML提取）
    //   3. 支付宝页提取 out_trade_no（备用）
    // 其他平台：保持原有逻辑
    function tryExtractOrderFromPage(url) {
      if (win.isDestroyed() || resolved) return

      const urlLower = url.toLowerCase()

      // === 淘宝/天猫：DL系统方案 ===
      if (platform === 'taobao') {
        // 仅在两个关键页面检测：
        // 1. confirm_order 页面 - 从HTML提取 b2c_orid（最可靠）
        // 2. 支付宝页面 - 从URL提取 out_trade_no（备用）
        const isConfirmOrderPage = urlLower.indexOf('confirm_order') >= 0 ||
                                   urlLower.indexOf('buy.taobao.com/auction/order') >= 0 ||
                                   urlLower.indexOf('buy.tmall.com/order') >= 0
        const isAlipayPage = urlLower.indexOf('alipay.com') >= 0

        if (!isConfirmOrderPage && !isAlipayPage) return

        // 支付宝页面：先检查URL参数
        if (isAlipayPage) {
          const urlOrderNo = extractOrderNoFromUrl(url, platform)
          if (urlOrderNo) {
            console.log(`[PurchaseCapture] Order found in Alipay URL: ${urlOrderNo}`)
            onOrderCaptured(urlOrderNo)
            return
          }
          // 支付宝页面也尝试从HTML提取 out_trade_no
          console.log(`[PurchaseCapture] Alipay page detected, extracting from page...`)
          win.webContents.executeJavaScript(EXTRACT_ORDER_FROM_PAGE)
            .then(orderNo => {
              if (orderNo && !resolved) {
                console.log(`[PurchaseCapture] Order extracted from Alipay page: ${orderNo}`)
                onOrderCaptured(orderNo)
              }
            })
            .catch(() => {})
          return
        }

        // confirm_order 页面：从HTML提取 b2c_orid
        // 注意：confirm_order页面可能很快跳转到支付宝，需要快速提取
        if (isConfirmOrderPage) {
          console.log(`[PurchaseCapture] confirm_order page detected (DL method): ${url.substring(0, 120)}`)
          const extractWithDelay = (delay) => {
            setTimeout(() => {
              if (win.isDestroyed() || resolved) return
              win.webContents.executeJavaScript(EXTRACT_ORDER_FROM_PAGE)
                .then(orderNo => {
                  if (orderNo && !resolved) {
                    console.log(`[PurchaseCapture] Order extracted from page (b2c_orid): ${orderNo}`)
                    onOrderCaptured(orderNo)
                  }
                })
                .catch(() => {})
            }, delay)
          }
          // 快速重试策略：confirm_order页面可能很快跳走，所以首次0ms、后续500ms、2s
          extractWithDelay(0)
          extractWithDelay(500)
          extractWithDelay(2000)
        }
        return
      }

      // === 拼多多：DL系统方案 ===
      // 核心思路：对齐DL，多层订单号捕获
      // 1. 支付宝支付页（mclient.alipay.com）：提取out_trade_no，等价于DL的dlBindPddOrder()
      // 2. 支付回调页（transac_wechat/alipay_wapcallback）：从URL参数提取order_sn
      // 3. 订单结果页（pay_success, order_result）：从URL和页面内容提取
      // 4. 结算页：API拦截器实时检测 + 轮询备用
      if (platform === 'pinduoduo') {
        const isAlipayPage = urlLower.includes('mclient.alipay.com') ||
                             urlLower.includes('alipay.com/h5pay') ||
                             urlLower.includes('alipay.com/home/exterfaceAssign')
        const isPaymentCallback = urlLower.includes('transac_wechat_wapcallback') ||
                                  urlLower.includes('transac_alipay_wapcallback')
        const isOrderResult = urlLower.includes('pay_success') ||
                              urlLower.includes('order_result')
        const isPddCheckout = urlLower.includes('yangkeduo.com/checkout') ||
                              urlLower.includes('yangkeduo.com/order')

        console.log(`[PurchaseCapture] PDD tryExtractOrderFromPage: url=${url.substring(0, 150)}, alipay=${isAlipayPage}, callback=${isPaymentCallback}, result=${isOrderResult}, checkout=${isPddCheckout}`)

        if (!isAlipayPage && !isPaymentCallback && !isOrderResult && !isPddCheckout) return

        // 1. 支付宝支付页：out_trade_no仅作兜底（对齐DL的dlBindPddOrder思路）
        // 注意：out_trade_no是支付宝商户单号（如"XP..."），不是PDD的order_sn
        // 优先让API拦截器从/proxy/api/order响应中捕获真正的order_sn
        // 这里只在API拦截器未捕获时，延迟使用out_trade_no
        if (isAlipayPage) {
          console.log(`[PurchaseCapture] PDD Alipay payment page detected (DL method: dlBindPddOrder equivalent, out_trade_no as FALLBACK)`)
          // 先从URL参数提取out_trade_no
          const urlOrderNo = extractOrderNoFromUrl(url, platform)
          if (urlOrderNo) {
            // ★ 延迟使用out_trade_no，给API拦截器优先捕获order_sn的机会
            console.log(`[PurchaseCapture] PDD Alipay: out_trade_no=${urlOrderNo} found, delaying 500ms for API interceptor order_sn...`)
            setTimeout(() => {
              if (win.isDestroyed() || resolved) return
              console.log(`[PurchaseCapture] PDD Alipay fallback: using out_trade_no=${urlOrderNo} (no order_sn from API)`)
              onOrderCaptured(urlOrderNo)
            }, 500)
            // 同时也尝试从DOM提取（可能找到order_sn）
          }
          // 从页面DOM提取（支付宝页面可能通过form POST加载，out_trade_no在DOM中）
          console.log(`[PurchaseCapture] PDD Alipay: also extracting from page DOM...`)
          const extractWithDelay = (delay) => {
            setTimeout(() => {
              if (win.isDestroyed() || resolved) return
              win.webContents.executeJavaScript(EXTRACT_ORDER_FROM_PAGE)
                .then(orderNo => {
                  if (orderNo && !resolved) {
                    console.log(`[PurchaseCapture] PDD order extracted from Alipay DOM (delay=${delay}): ${orderNo}`)
                    onOrderCaptured(orderNo)
                  } else if (!resolved) {
                    console.log(`[PurchaseCapture] PDD Alipay DOM extraction (delay=${delay}): no order found yet`)
                  }
                })
                .catch(() => {})
            }, delay)
          }
          // 支付宝页面需要加载时间，多次重试
          extractWithDelay(1000)
          extractWithDelay(3000)
          extractWithDelay(6000)
          return
        }

        // 2. 支付回调页：从URL提取order_sn（DL核心方案，最可靠）
        if (isPaymentCallback) {
          console.log(`[PurchaseCapture] PDD payment callback page detected (DL method)`)
          const urlOrderNo = extractOrderNoFromUrl(url, platform)
          if (urlOrderNo) {
            console.log(`[PurchaseCapture] PDD order found in payment callback URL: ${urlOrderNo}`)
            onOrderCaptured(urlOrderNo)
            return
          }
          // URL中没有order_sn，从页面内容提取（兜底）
          console.log(`[PurchaseCapture] PDD payment callback: no order_sn in URL params, extracting from page content...`)
          win.webContents.executeJavaScript(EXTRACT_ORDER_FROM_PAGE)
            .then(orderNo => {
              if (orderNo && !resolved) {
                console.log(`[PurchaseCapture] PDD order extracted from callback page: ${orderNo}`)
                onOrderCaptured(orderNo)
              } else {
                console.log(`[PurchaseCapture] PDD payment callback: page extraction returned ${orderNo}, no order found`)
              }
            })
            .catch(() => {})
          return
        }

        // 2. 订单结果/支付成功页：从URL和页面内容提取
        if (isOrderResult) {
          console.log(`[PurchaseCapture] PDD order result page detected`)
          const urlOrderNo = extractOrderNoFromUrl(url, platform)
          if (urlOrderNo) {
            console.log(`[PurchaseCapture] PDD order found in result page URL: ${urlOrderNo}`)
            onOrderCaptured(urlOrderNo)
            return
          }
          console.log(`[PurchaseCapture] PDD order result: no order_sn in URL, extracting from page content...`)
          // 从页面内容提取
          const extractWithDelay = (delay) => {
            setTimeout(() => {
              if (win.isDestroyed() || resolved) return
              win.webContents.executeJavaScript(EXTRACT_ORDER_FROM_PAGE)
                .then(orderNo => {
                  if (orderNo && !resolved) {
                    console.log(`[PurchaseCapture] PDD order extracted from result page: ${orderNo}`)
                    onOrderCaptured(orderNo)
                  }
                })
                .catch(() => {})
            }, delay)
          }
          extractWithDelay(500)
          extractWithDelay(2000)
          return
        }

        // 3. 结算页：API拦截器已实时检测，这里用轮询作为备用
        if (isPddCheckout) {
          console.log(`[PurchaseCapture] PDD checkout page: checking captured API responses for order_sn...`)
          win.webContents.executeJavaScript(READ_CAPTURED_PURCHASES)
            .then(responses => {
              if (responses && responses.length > 0 && !resolved) {
                console.log(`[PurchaseCapture] PDD: checking ${responses.length} captured API responses`)
                const orderNo = detectOrderNo(responses, platform)
                if (orderNo) {
                  console.log(`[PurchaseCapture] PDD order found in captured responses: ${orderNo}`)
                  onOrderCaptured(orderNo)
                } else {
                  console.log(`[PurchaseCapture] PDD: no order_sn found in ${responses.length} captured responses (will be caught by real-time interceptor or callback page)`)
                }
              } else {
                console.log(`[PurchaseCapture] PDD checkout: no captured API responses yet`)
              }
            })
            .catch(() => {})
        }
        return
      }

      // === 非淘宝/非拼多多平台：保持原有逻辑 ===
      const checkoutPatterns = CHECKOUT_URL_PATTERNS[platform] || []
      const confirmPatterns = ORDER_CONFIRM_PATTERNS[platform] || []
      const isRelevantPage = checkoutPatterns.some(p => urlLower.includes(p.toLowerCase())) ||
                             confirmPatterns.some(p => urlLower.includes(p.toLowerCase())) ||
                             urlLower.includes('alipay.com')
      if (!isRelevantPage) return

      // 1. 先检查URL参数中是否有订单号
      const urlOrderNo = extractOrderNoFromUrl(url, platform)
      if (urlOrderNo) {
        console.log(`[PurchaseCapture] Order found in URL: ${urlOrderNo}`)
        onOrderCaptured(urlOrderNo)
        return
      }

      // 2. 检查是否是订单确认/支付相关页面，尝试从页面内容提取
      const isOrderPage = confirmPatterns.some(p => urlLower.includes(p.toLowerCase()))
      if (!isOrderPage) return

      console.log(`[PurchaseCapture] Order-related page detected: ${url.substring(0, 120)}`)

      // 3. 延迟后注入页面内容提取脚本（等页面渲染完成）
      const extractWithDelay = (delay) => {
        setTimeout(() => {
          if (win.isDestroyed() || resolved) return
          win.webContents.executeJavaScript(EXTRACT_ORDER_FROM_PAGE)
            .then(orderNo => {
              if (orderNo && !resolved) {
                console.log(`[PurchaseCapture] Order extracted from page: ${orderNo}`)
                onOrderCaptured(orderNo)
              }
            })
            .catch(() => {})
        }, delay)
      }

      // 多次尝试（页面可能还在加载中）
      extractWithDelay(1000)
      extractWithDelay(3000)
      extractWithDelay(6000)
    }

    // 页面导航后检测（核心：淘宝提交订单后会跳转到confirm_order.htm）
    win.webContents.on('did-navigate', (event, url) => {
      if (win.isDestroyed() || resolved) return
      console.log(`[PurchaseCapture] did-navigate: ${url.substring(0, 120)}`)

      // 尝试从新页面提取订单号（和 dl 一致）
      tryExtractOrderFromPage(url)

      // === 登录页自动填充（导航到登录页时注入） ===
      const navUrlLower = url.toLowerCase()
      const isLoginPageNav = navUrlLower.includes('login.taobao.com') ||
                             navUrlLower.includes('login.1688.com') ||
                             navUrlLower.includes('login.tmall.com') ||
                             (navUrlLower.includes('passport') && navUrlLower.includes('1688.com')) ||
                             (navUrlLower.includes('passport') && navUrlLower.includes('taobao.com')) ||
                             navUrlLower.includes('yangkeduo.com/login')

      if (isLoginPageNav && purchaseInfo.accountPassword && !resolved && platform !== 'pinduoduo') {
        // ★ PDD 不自动填充：PDD 反爬严格，程序化 input 事件（无 keyboard 事件）容易被检测
        setTimeout(() => {
          if (win.isDestroyed() || resolved) return
          // 和 dl 一致：非 PDD 平台使用通用登录脚本
          const script = buildLoginAutoFillScript(purchaseInfo.accountName, purchaseInfo.accountPassword)
          if (script) {
            win.webContents.executeJavaScript(script).catch(() => {})
            console.log('[PurchaseCapture] Login auto-fill script injected after navigation')
          }
        }, 1000)
      }

      // === 结算页地址处理 ===
      const { shippingName, shippingPhone, shippingAddress } = purchaseInfo
      if ((shippingName || shippingPhone || shippingAddress)) {
        if (isCheckoutPage(url, platform)) {
          if (platform === 'pinduoduo') {
            // PDD 结算页：参考 dl 的 dlSetReceiver 机制
            // pddAddrDone=false → 需要设置地址，点击地址区域
            // pddAddrDone=true  → 地址已设置完成，选择支付宝支付方式（对齐 dl：默认微信，切支付宝才能抓订单号）
            if (!pddAddrDone && !pddAddrAreaClicked) {
              pddAddrAreaClicked = true
              setTimeout(() => {
                if (win.isDestroyed() || resolved || pddAddrDone) return
                const clickAddrScript = `
                  (function() {
                    if (document.querySelector(".oc-address-info")) {
                      document.querySelector(".oc-address-info").click();
                    } else if (document.querySelector(".oc-address")) {
                      document.querySelector(".oc-address").querySelectorAll("div")[1].click();
                    }
                  })()
                `
                win.webContents.executeJavaScript(clickAddrScript).catch(() => {})
                console.log('[PurchaseCapture] PDD: clicked address selector on checkout page')
              }, 1500)
            } else if (pddAddrDone && !pddPayClicked) {
              // ★ 地址已设置完成，选择支付宝支付方式（对齐 dl：!dlSetReceiver → 点击支付宝）
              // PDD 默认微信支付，但只有支付宝支付才能拦截到订单号
              pddPayClicked = true
              setTimeout(() => {
                if (win.isDestroyed() || resolved) return
                const clickAlipayScript = `
                  (function() {
                    function simClick(el) {
                      var rect = el.getBoundingClientRect();
                      var x = rect.left + rect.width / 2;
                      var y = rect.top + rect.height / 2;
                      ['mousedown','mouseup','click'].forEach(function(type) {
                        var evt = document.createEvent('MouseEvents');
                        evt.initMouseEvent(type, true, true, window, 1, x, y, x, y, false, false, false, false, 0, null);
                        el.dispatchEvent(evt);
                      });
                    }
                    var mainEl = document.querySelector("#main");
                    if (!mainEl) return '#main not found';
                    var mainDiv = mainEl.querySelector("div");
                    if (!mainDiv) return '#main > div not found';
                    var divs = mainDiv.querySelectorAll(":scope > div");
                    for (var d = 0; d < divs.length; d++) {
                      var sectionText = divs[d].innerText || '';
                      if (sectionText.indexOf('微信') >= 0 && sectionText.indexOf('支付宝') >= 0) {
                        var subDivs = divs[d].querySelectorAll(':scope > div');
                        for (var s = 0; s < subDivs.length; s++) {
                          var subText = subDivs[s].innerText || '';
                          if (subText.indexOf('支付宝') >= 0 && subText.indexOf('微信') < 0) {
                            simClick(subDivs[s]);
                            return 'simClicked section[' + d + ']>div[' + s + ']';
                          }
                        }
                        var candidates = divs[d].querySelectorAll('*');
                        for (var i = 0; i < candidates.length; i++) {
                          if (candidates[i].innerText === '支付宝' || candidates[i].textContent.trim() === '支付宝') {
                            var target = candidates[i];
                            for (var j = 0; j < 2; j++) {
                              if (target.parentElement && target.parentElement.children.length <= 3) {
                                target = target.parentElement;
                              }
                            }
                            simClick(target);
                            return 'simClicked text-match in section[' + d + ']';
                          }
                        }
                      }
                    }
                    return 'alipay not found at all';
                  })()
                `
                win.webContents.executeJavaScript(clickAlipayScript).then(result => {
                  console.log(`[PurchaseCapture] PDD Alipay result: ${result}`)
                }).catch(() => {})
              }, 2000)
            }
          } else if (platform !== '1688' && platform !== 'taobao' && platform !== 'tmall') {
            // 淘宝/天猫的地址设置在后台窗口中完成，不在采购窗口注入
            setTimeout(() => {
              if (win.isDestroyed() || resolved) return
              const fillScript = buildAddressAutoFillScript(shippingName, shippingPhone, shippingAddress, platform)
              win.webContents.executeJavaScript(fillScript).catch(() => {})
              console.log(`[PurchaseCapture] Address auto-fill injected after navigation`)
            }, 3000)
          }
        }
        // 拼多多：地址管理页自动填写（参考 dl）
        // ★ 关键：检测到地址页时设置 pddAddrDone=true（对齐 dl 的 delCookie("dlSetReceiver") 时机）
        // 这意味着一旦进入地址页，回到结算页后就会自动点击支付
        if (platform === 'pinduoduo' && url.toLowerCase().includes('yangkeduo.com/addresses')) {
          pddAddrDone = true
          console.log('[PurchaseCapture] PDD: entered address page, pddAddrDone=true (like dl delCookie)')
          setTimeout(() => {
            if (win.isDestroyed() || resolved) return
            const addrScript = buildPddAddressScript(shippingName, shippingPhone, parsedAddr || parseAddress(shippingAddress))
            if (addrScript) {
              win.webContents.executeJavaScript(addrScript).catch(() => {})
              console.log('[PurchaseCapture] PDD: address script injected')
            }
          }, 1000)
        }
      }

      // 页面导航后重新注入商品信息浮层（脚本内部按 URL 过滤，PDD 只在商品页创建 DOM）
      // ★ 合并为单次 executeJavaScript：确保 __jdProductInfo 在 overlay 脚本执行前已设置
      win.webContents.executeJavaScript(`window.__jdProductInfo = ${jdInfo}; ${PRODUCT_INFO_OVERLAY}`)
        .then(result => { if (result) console.log(`[PurchaseCapture] Overlay(nav) result: ${result}`) })
        .catch(() => {})
    })

    // SPA内的hash/pushState导航
    win.webContents.on('did-navigate-in-page', (event, url) => {
      if (win.isDestroyed() || resolved) return
      console.log(`[PurchaseCapture] did-navigate-in-page: ${url.substring(0, 120)}`)

      tryExtractOrderFromPage(url)

      // ★ PDD地址页SPA导航支持：如果PDD的结算页→地址页使用pushState，did-navigate不会触发
      // 加 pddAddrDone 防护：避免页面已跳走后延迟事件仍触发误注入
      if (platform === 'pinduoduo' && url.toLowerCase().includes('yangkeduo.com/addresses') && !pddAddrDone) {
        pddAddrDone = true
        console.log('[PurchaseCapture] PDD: entered address page (in-page nav), pddAddrDone=true')
        const { shippingName, shippingPhone, shippingAddress } = purchaseInfo
        setTimeout(() => {
          if (win.isDestroyed() || resolved) return
          const addrScript = buildPddAddressScript(shippingName, shippingPhone, parsedAddr || parseAddress(shippingAddress))
          if (addrScript) {
            win.webContents.executeJavaScript(addrScript).catch(() => {})
            console.log('[PurchaseCapture] PDD: address script injected (in-page nav)')
          }
        }, 1000)
      }

      // ★ PDD结算页SPA导航支持：history.back()返回结算页时可能触发did-navigate-in-page
      // 需要在这里也处理支付宝选择，否则回到结算页后不会自动选支付宝
      if (platform === 'pinduoduo' && isCheckoutPage(url, platform)) {
        const { shippingName, shippingPhone, shippingAddress } = purchaseInfo
        if ((shippingName || shippingPhone || shippingAddress) && pddAddrDone && !pddPayClicked) {
          pddPayClicked = true
          setTimeout(() => {
            if (win.isDestroyed() || resolved) return
            const clickAlipayScript = `
              (function() {
                function simClick(el) {
                  var rect = el.getBoundingClientRect();
                  var x = rect.left + rect.width / 2;
                  var y = rect.top + rect.height / 2;
                  ['mousedown','mouseup','click'].forEach(function(type) {
                    var evt = document.createEvent('MouseEvents');
                    evt.initMouseEvent(type, true, true, window, 1, x, y, x, y, false, false, false, false, 0, null);
                    el.dispatchEvent(evt);
                  });
                }
                var mainEl = document.querySelector("#main");
                if (!mainEl) return '#main not found';
                var mainDiv = mainEl.querySelector("div");
                if (!mainDiv) return '#main > div not found';
                var divs = mainDiv.querySelectorAll(":scope > div");
                for (var d = 0; d < divs.length; d++) {
                  var sectionText = divs[d].innerText || '';
                  if (sectionText.indexOf('微信') >= 0 && sectionText.indexOf('支付宝') >= 0) {
                    var subDivs = divs[d].querySelectorAll(':scope > div');
                    for (var s = 0; s < subDivs.length; s++) {
                      var subText = subDivs[s].innerText || '';
                      if (subText.indexOf('支付宝') >= 0 && subText.indexOf('微信') < 0) {
                        simClick(subDivs[s]);
                        return 'simClicked section[' + d + ']>div[' + s + ']';
                      }
                    }
                    var candidates = divs[d].querySelectorAll('*');
                    for (var i = 0; i < candidates.length; i++) {
                      if (candidates[i].innerText === '支付宝' || candidates[i].textContent.trim() === '支付宝') {
                        var target = candidates[i];
                        for (var j = 0; j < 2; j++) {
                          if (target.parentElement && target.parentElement.children.length <= 3) {
                            target = target.parentElement;
                          }
                        }
                        simClick(target);
                        return 'simClicked text-match in section[' + d + ']';
                      }
                    }
                  }
                }
                return 'alipay not found at all';
              })()
            `
            win.webContents.executeJavaScript(clickAlipayScript).then(result => {
              console.log(`[PurchaseCapture] PDD Alipay result (in-page nav): ${result}`)
            }).catch(() => {})
          }, 2000)
        }
      }

      // SPA导航后重新注入商品信息浮层（脚本内部按 URL 过滤，PDD 只在商品页创建 DOM）
      // ★ 合并为单次 executeJavaScript：确保 __jdProductInfo 在 overlay 脚本执行前已设置
      win.webContents.executeJavaScript(`window.__jdProductInfo = ${jdInfo}; ${PRODUCT_INFO_OVERLAY}`)
        .then(result => { if (result) console.log(`[PurchaseCapture] Overlay(spa) result: ${result}`) })
        .catch(() => {})
    })

    // 页面即将导航前 — 关键时机！在跳走之前：
    // 1. 从当前页面HTML提取 b2c_orid
    // 2. 刷新已拦截的API响应（页面跳转后JS上下文会销毁，响应丢失）
    win.webContents.on('will-navigate', (event, url) => {
      if (win.isDestroyed() || resolved) return
      console.log(`[PurchaseCapture] will-navigate: ${url.substring(0, 120)}`)

      if (platform === 'taobao' && !resolved) {
        // 1. 尝试从当前页面HTML提取 b2c_orid
        win.webContents.executeJavaScript(EXTRACT_ORDER_FROM_PAGE)
          .then(orderNo => {
            if (orderNo && !resolved) {
              console.log(`[PurchaseCapture] Order extracted before navigation (b2c_orid): ${orderNo}`)
              onOrderCaptured(orderNo)
            }
          })
          .catch(() => {})

        // 2. 刷新已拦截的API响应（关键！页面跳转后JS上下文销毁，之前拦截的响应会丢失）
        win.webContents.executeJavaScript(READ_CAPTURED_PURCHASES)
          .then(responses => {
            if (responses && responses.length > 0 && !resolved) {
              console.log(`[PurchaseCapture] Flushed ${responses.length} responses before navigation`)
              const orderNo = detectTaobaoOrderFromResponses(responses)
              if (orderNo) {
                console.log(`[PurchaseCapture] Order found in flushed responses: ${orderNo}`)
                onOrderCaptured(orderNo)
              }
            }
          })
          .catch(() => {})
      }

      // 拼多多：页面跳转前刷新已拦截的API响应（PDD结算页→支付页跳转会销毁JS上下文）
      if (platform === 'pinduoduo' && !resolved) {
        console.log(`[PurchaseCapture] PDD will-navigate: leaving current page for ${url.substring(0, 120)}, flushing captured responses...`)
        win.webContents.executeJavaScript(READ_CAPTURED_PURCHASES)
          .then(responses => {
            if (responses && responses.length > 0 && !resolved) {
              console.log(`[PurchaseCapture] PDD: Flushed ${responses.length} responses before navigation:`)
              for (const r of responses) {
                const rUrl = (r.url || '').substring(0, 120)
                const isPdd = rUrl.includes('yangkeduo') || rUrl.includes('pinduoduo')
                console.log(`[PurchaseCapture]   ${isPdd ? '★ PDD' : '   other'}: ${rUrl} bodyLen=${(r.body || '').length}`)
              }
              const orderNo = detectOrderNo(responses, platform)
              if (orderNo) {
                console.log(`[PurchaseCapture] PDD order found in flushed responses: ${orderNo}`)
                onOrderCaptured(orderNo)
              } else {
                console.log(`[PurchaseCapture] PDD: no order_sn in flushed responses, will detect on target page`)
              }
            } else {
              console.log(`[PurchaseCapture] PDD will-navigate: no captured responses to flush`)
            }
          })
          .catch(() => {})
      }
    })

    // 监听重定向（支付宝URL中可能包含订单号 / PDD支付回调重定向）
    win.webContents.on('will-redirect', (event, url) => {
      if (win.isDestroyed() || resolved) return
      console.log(`[PurchaseCapture] will-redirect: ${url.substring(0, 150)}`)

      // PDD专用：支付回调重定向中可能带order_sn，支付宝页面重定向中可能带out_trade_no
      if (platform === 'pinduoduo') {
        const urlLower = url.toLowerCase()
        if (urlLower.includes('transac_wechat_wapcallback') || urlLower.includes('transac_alipay_wapcallback')) {
          console.log(`[PurchaseCapture] PDD will-redirect: payment callback detected!`)
        }
        if (urlLower.includes('mclient.alipay.com') || urlLower.includes('alipay.com/h5pay')) {
          console.log(`[PurchaseCapture] PDD will-redirect: Alipay page detected, will extract out_trade_no`)
        }
      }

      // 重定向URL中可能有订单号参数
      const urlOrderNo = extractOrderNoFromUrl(url, platform)
      if (urlOrderNo) {
        // ★ PDD+Alipay: out_trade_no仅作兜底（不是PDD订单号，是支付宝商户单号）
        // 优先让API拦截器从/proxy/api/order响应中捕获真正的order_sn
        // 延迟500ms，给console-message处理器时间处理[PURCHASE_ORDER_FOUND]
        const isPddAlipayFallback = platform === 'pinduoduo' && url.toLowerCase().includes('alipay.com')
        if (isPddAlipayFallback) {
          console.log(`[PurchaseCapture] PDD Alipay out_trade_no found: ${urlOrderNo} (delaying 500ms, waiting for order_sn from API interceptor)`)
          setTimeout(() => {
            if (win.isDestroyed() || resolved) {
              console.log(`[PurchaseCapture] PDD Alipay fallback skipped: resolved=${resolved}, destroyed=${win.isDestroyed()}`)
              return
            }
            console.log(`[PurchaseCapture] PDD Alipay fallback: using out_trade_no=${urlOrderNo} (no order_sn from API)`)
            onOrderCaptured(urlOrderNo)
          }, 500)
        } else {
          console.log(`[PurchaseCapture] Order found in redirect URL: ${urlOrderNo}`)
          onOrderCaptured(urlOrderNo)
        }
      }

      // 重定向到的新页面也可能是订单相关页面
      tryExtractOrderFromPage(url)
    })

    // 拦截新窗口打开 — 淘宝结算可能在新窗口中打开
    win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
      console.log(`[PurchaseCapture] window-open: ${openUrl.substring(0, 120)}`)
      // 在同一窗口中打开，而不是创建新窗口
      return { action: 'allow' }
    })

    // 窗口关闭
    win.on('closed', () => {
      onWindowClosed()
    })

    // 页面加载失败处理
    win.webContents.on('did-fail-load', (event, errorCode, errorDesc, validatedURL, isMainFrame) => {
      if (!isMainFrame) return  // 只关心主框架加载失败
      if (errorCode === -3) return  // ERR_ABORTED：用户导航或重定向导致，非真正错误
      console.error(`[PurchaseCapture] Page load failed: ${errorCode} ${errorDesc} url=${validatedURL}`)
    })

    // 渲染进程崩溃处理
    win.webContents.on('render-process-gone', (event, details) => {
      console.error(`[PurchaseCapture] Render process gone: ${details.reason} ${details.exitCode}`)
      if (!resolved) {
        onWindowClosed()
      }
    })

    // 主窗口始终加载商品页（DL系统经验：地址设置在独立后台窗口完成，不影响客户选品）
    console.log(`[PurchaseCapture] Loading product page: ${purchaseUrl.substring(0, 120)}`)

    // 拼多多：不再需要清除缓存（dl 不做缓存清理，Electron 默认 UA 正常工作）

    try {
      await win.loadURL(purchaseUrl)
    } catch (e) {
      console.error('[PurchaseCapture] loadURL failed:', e.message)
    }

    // 地址设置延迟启动：等商品信息成功提取后再启动（避免cookie过期时两个窗口同时撞上登录页）
    // 触发点：console-message 中的 [PURCHASE_PRODUCT_CACHED] 和 dom-ready 中的商品信息提取

    // 启动轮询检测订单号（1000ms频率，提高捕获率）（和 dl 一致）
    pollTimer = setInterval(() => {
      if (win.isDestroyed() || resolved) {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        return
      }

      win.webContents.executeJavaScript(READ_CAPTURED_PURCHASES)
        .then(responses => {
          if (!responses || responses.length === 0) return
          console.log(`[PurchaseCapture] Poll: ${responses.length} new responses`)

          // 诊断日志：显示每个响应的URL（帮助定位订单号在哪个API响应中）
          for (const r of responses) {
            console.log(`[PurchaseCapture]   Response: ${(r.url || '').substring(0, 200)} bodyLen=${(r.body || '').length}`)
          }

          // 淘宝：DL方法，从API响应中搜索 b2c_orid / bizOrderId / orderId
          if (platform === 'taobao') {
            const orderNo = detectTaobaoOrderFromResponses(responses)
            if (orderNo) {
              onOrderCaptured(orderNo)
            }
            return
          }

          // 其他平台：通用字段搜索
          const orderNo = detectOrderNo(responses, platform)
          if (orderNo) {
            onOrderCaptured(orderNo)
          }
        })
        .catch(() => {})
    }, 1000)

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

  // ============ 拼多多选品浏览窗口 ============
  const activePddBrowsingWindows = new Map() // accountId -> win

  ipcMain.handle('open-pdd-browsing-window', async (event, params) => {
    const { accountId } = params

    // 防重复：同 accountId 窗口已打开则聚焦
    if (activePddBrowsingWindows.has(accountId)) {
      const existing = activePddBrowsingWindows.get(accountId)
      if (existing && !existing.isDestroyed()) {
        existing.focus()
        return { success: true, message: '窗口已打开' }
      }
      activePddBrowsingWindows.delete(accountId)
    }

    // session partition（复用采购下单的同一 partition，共享登录态）
    const partitionName = `persist:purchase-${accountId}`
    const ses = session.fromPartition(partitionName)

    // Cookie 恢复（同采购下单窗口逻辑：优先 partition 已有，必要时从服务器恢复）
    let needServerRestore = true
    try {
      const partitionCookies = await ses.cookies.get({})
      const pddCookies = partitionCookies.filter(c =>
        c.domain && (c.domain.includes('pinduoduo.com') || c.domain.includes('yangkeduo.com'))
      )
      if (pddCookies.length > 0) {
        needServerRestore = false
        console.log(`[PddBrowsing] Partition已有 ${pddCookies.length} 条PDD cookie，跳过服务器恢复`)
        flushStorageDataAsync(ses)
      }
    } catch (e) {
      console.warn('[PddBrowsing] Partition cookie检查失败:', e.message)
    }

    if (needServerRestore) {
      try {
        const cookieRes = await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, { method: 'GET' })
        if (cookieRes.statusCode === 200 && cookieRes.data) {
          const json = JSON.parse(cookieRes.data)
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
              console.log(`[PddBrowsing] Cookies loaded from server: ${serverCookies.length}/${raw.length}`)
              let setOk = 0, setFail = 0
              for (const ck of serverCookies) {
                try {
                  await ses.cookies.set({
                    url: (ck.secure ? 'https://' : 'http://') + (ck.domain || '').replace(/^\./, '') + (ck.path || '/'),
                    name: ck.name, value: ck.value || '', domain: ck.domain, path: ck.path || '/',
                    secure: ck.secure || false, httpOnly: ck.httpOnly || false,
                    expirationDate: ck.expirationDate || undefined, sameSite: ck.sameSite || undefined
                  })
                  setOk++
                } catch (e2) { setFail++ }
              }
              console.log(`[PddBrowsing] Cookies restored: ${setOk} ok, ${setFail} failed`)
              flushStorageDataAsync(ses)
            }
          }
        }
      } catch (e) {
        console.warn('[PddBrowsing] Cookie load failed:', e.message)
      }
    }

    // 创建 BrowserWindow（竖屏手机比例，模拟移动端浏览体验）
    const win = new BrowserWindow({
      width: 770,
      height: 960,
      show: true,
      title: '拼多多选品',
      webPreferences: {
        partition: partitionName,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'purchase-preload.js')
      }
    })

    // 反检测
    const chromeVersion = process.versions.chrome || '134.0.0.0'
    const cleanUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
    win.webContents.setUserAgent(cleanUA)
    const secChUa = `"Chromium";v="${chromeVersion.split('.')[0]}", "Google Chrome";v="${chromeVersion.split('.')[0]}", "Not-A.Brand";v="99"`
    ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
      if (details.requestHeaders) {
        details.requestHeaders['Sec-CH-UA'] = secChUa
        details.requestHeaders['Sec-CH-UA-Platform'] = '"Windows"'
        details.requestHeaders['User-Agent'] = cleanUA
      }
      callback({ requestHeaders: details.requestHeaders })
    })

    // 拦截页面 window.open 调用，提取商品链接
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url && url.startsWith('dxe://product-link?url=')) {
        try {
          const productUrl = decodeURIComponent(url.replace('dxe://product-link?url=', ''))
          console.log(`[PddBrowsing] 商品链接提取: ${productUrl}`)
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('pdd-product-link-update', { url: productUrl })
          }
        } catch (e) {
          console.warn('[PddBrowsing] 商品链接解析失败:', e.message)
        }
        return { action: 'deny' } // 阻止打开新窗口
      }
      return { action: 'allow' } // 其他 window.open 正常放行
    })

    // 注入商品链接提取按钮（dom-ready + SPA 导航）
    win.webContents.on('dom-ready', () => {
      win.webContents.executeJavaScript(PRODUCT_LINK_EXTRACTOR).catch(() => {})
    })
    win.webContents.on('did-navigate', () => {
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.webContents.executeJavaScript(PRODUCT_LINK_EXTRACTOR).catch(() => {})
        }
      }, 500)
    })
    win.webContents.on('did-navigate-in-page', () => {
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.webContents.executeJavaScript(PRODUCT_LINK_EXTRACTOR).catch(() => {})
        }
      }, 500)
    })

    activePddBrowsingWindows.set(accountId, win)

    // 窗口关闭时：保存cookie到服务器 + 刷盘持久化，然后才销毁窗口
    win.on('close', (e) => {
      if (win._pddBrowsingSaveDone) return
      e.preventDefault()  // 阻止立即关闭，等异步保存完成
      win._pddBrowsingSaveDone = true

      const doSaveAndDestroy = async () => {
        console.log(`[PddBrowsing] 窗口关闭，保存cookie accountId=${accountId}`)

        // 1. 保存cookie到服务器
        try {
          const cookies = await ses.cookies.get({})
          if (cookies && cookies.length > 0) {
            await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cookie_data: JSON.stringify(cookies), platform: 'pinduoduo' })
            })
            console.log(`[PddBrowsing] Cookie已保存到服务器: ${cookies.length} 条`)
          }
        } catch (err) {
          console.error('[PddBrowsing] Cookie保存失败:', err.message)
        }

        // 2. 刷盘确保持久化到磁盘（关键！persist:分区的数据必须flush才能在重启后保留）
        try {
          await new Promise(resolve => ses.flushStorageData(resolve))
          console.log('[PddBrowsing] Session数据已刷盘')
        } catch (err) {
          console.error('[PddBrowsing] 刷盘失败:', err.message)
        }

        // 3. 清理
        try { ses.webRequest.onBeforeSendHeaders(null) } catch (e) {}
        activePddBrowsingWindows.delete(accountId)

        // 4. 清除定时保存
        if (win._pddCookieSaveTimer) {
          clearInterval(win._pddCookieSaveTimer)
          win._pddCookieSaveTimer = null
        }

        // 5. 销毁窗口
        win.destroy()
      }

      doSaveAndDestroy()
    })

    // 定时保存cookie到服务器（每3分钟，防止崩溃丢失）
    win._pddCookieSaveTimer = setInterval(async () => {
      if (win.isDestroyed()) {
        clearInterval(win._pddCookieSaveTimer)
        win._pddCookieSaveTimer = null
        return
      }
      try {
        const cookies = await ses.cookies.get({})
        if (cookies && cookies.length > 0) {
          await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie_data: JSON.stringify(cookies), platform: 'pinduoduo' })
          })
          console.log(`[PddBrowsing] 定时cookie保存: ${cookies.length} 条`)
        }
      } catch (err) {
        // 静默失败，不影响用户体验
      }
    }, 3 * 60 * 1000)

    // 加载拼多多首页
    win.loadURL('https://mobile.yangkeduo.com')

    return { success: true }
  })
}

/**
 * 检查 API 响应，失败时抛出错误
 */
function checkApiResponse(res, label) {
  const { statusCode, data } = res
  if (statusCode >= 400) {
    throw new Error(`${label} HTTP ${statusCode}: ${data}`)
  }
  try {
    const json = JSON.parse(data)
    if (json.code !== 0) {
      throw new Error(`${label} 业务错误: ${json.message || JSON.stringify(json)}`)
    }
    return json
  } catch (e) {
    if (e.message.startsWith(label)) throw e
    // 无法解析 JSON，但 HTTP 状态码正常，视为成功
    console.warn(`[PurchaseCapture] ${label} 响应非JSON: ${data.substring(0, 200)}`)
    return null
  }
}

/**
 * 自动调用服务端 API 创建采购单并绑定
 */
async function autoCreateAndBind(purchaseInfo, platformOrderNo, platform, capturedAmount) {
  const { purchaseNo, salesOrderId, salesOrderNo, goodsName, image, sku, skuId, quantity, purchasePrice, remark, sourceUrl, purchaseType, shippingName, shippingPhone, shippingAddress, accountId } = purchaseInfo

  console.log(`[PurchaseCapture] autoCreateAndBind 开始: purchaseNo=${purchaseNo}, orderNo=${platformOrderNo}, token=${getAuthToken() ? '有效' : '无'}`)

  // 1. 创建采购单
  const createRes = await httpRequest(`${BUSINESS_SERVER}/api/purchase-orders`, {
    method: 'POST',
    body: JSON.stringify({
      purchase_no: purchaseNo,
      sales_order_id: salesOrderId,
      sales_order_no: salesOrderNo,
      goods_name: goodsName,
      goods_image: image || '',
      sku: sku,
      quantity: quantity,
      source_url: sourceUrl,
      platform: platform,
      purchase_price: purchasePrice,
      remark: remark,
      purchase_type: purchaseType || 'dropship',
      shipping_name: shippingName || '',
      shipping_phone: shippingPhone || '',
      shipping_address: shippingAddress || '',
      account_id: accountId || null
    })
  })
  console.log(`[PurchaseCapture] 创建采购单响应: HTTP ${createRes.statusCode}, body=${createRes.data.substring(0, 500)}`)
  checkApiResponse(createRes, '创建采购单')

  // 2. 绑定平台订单号
  const bindRes = await httpRequest(`${BUSINESS_SERVER}/api/purchase-orders/${purchaseNo}/bind`, {
    method: 'PUT',
    body: JSON.stringify({
      platform_order_no: platformOrderNo
    })
  })
  console.log(`[PurchaseCapture] 绑定订单号响应: HTTP ${bindRes.statusCode}, body=${bindRes.data.substring(0, 500)}`)
  checkApiResponse(bindRes, '绑定订单号')

  // 2.1 绑定成功后立即写入系统备注（覆盖旧备注）
  if (salesOrderId) {
    try {
      const purchasePriceText = capturedAmount || purchasePrice || ''
      const sysRemark = `【${purchaseNo}】${platformOrderNo} ${purchasePriceText}（${purchaseInfo.accountName || ''}）`
      const sysRemarkRes = await httpRequest(`${BUSINESS_SERVER}/api/sales-orders/${salesOrderId}/sys-remark`, {
        method: 'PUT',
        body: JSON.stringify({ sys_remark: sysRemark })
      })
      const sysRemarkJson = JSON.parse(sysRemarkRes.data)
      if (sysRemarkJson.code === 0 && sysRemarkJson.data && sysRemarkJson.data.updated > 0) {
        console.log(`[PurchaseCapture] 系统备注已写入(覆盖): ${sysRemark}`)
      }
    } catch (e) {
      console.warn(`[PurchaseCapture] 系统备注写入失败(非关键): ${e.message}`)
    }
  }

  // 2.5 验证订单是否确实存入数据库（查询最近订单，匹配 purchaseNo）
  try {
    const verifyRes = await httpRequest(`${BUSINESS_SERVER}/api/purchase-orders?pageSize=10`)
    const verifyJson = JSON.parse(verifyRes.data)
    if (verifyJson.code === 0 && verifyJson.data && verifyJson.data.list) {
      const found = verifyJson.data.list.find(r => r.purchase_no === purchaseNo)
      if (found) {
        console.log(`[PurchaseCapture] 验证成功: 采购单已存入数据库, id=${found.id}, purchase_no=${found.purchase_no}, platform_order_no=${found.platform_order_no}, status=${found.status}, account_id=${found.account_id}`)
      } else {
        console.warn(`[PurchaseCapture] 验证警告: 采购单 purchaseNo=${purchaseNo} 未在最近10条记录中找到! 可能存入失败或 owner_id 不匹配`)
      }
    }
  } catch (e) {
    console.warn(`[PurchaseCapture] 验证查询失败(非关键): ${e.message}`)
  }

  // 3. 更新货源采购价（如果抓取到了实际支付金额）
  if (capturedAmount && capturedAmount > 0 && skuId && sourceUrl) {
    try {
      const priceRes = await httpRequest(`${BUSINESS_SERVER}/api/sku-purchase-config/update-price`, {
        method: 'PUT',
        body: JSON.stringify({
          sku_id: skuId,
          purchase_link: sourceUrl,
          purchase_price: capturedAmount,
          platform: platform
        })
      })
      console.log(`[PurchaseCapture] 更新货源采购价响应: HTTP ${priceRes.statusCode}, body=${priceRes.data.substring(0, 500)}`)
      checkApiResponse(priceRes, '更新货源采购价')
    } catch (e) {
      // 更新采购价失败不影响主流程
      console.warn(`[PurchaseCapture] 更新货源采购价失败(非关键): ${e.message}`)
    }
  } else {
    console.log(`[PurchaseCapture] 跳过更新货源采购价: amount=${capturedAmount}, skuId=${skuId}, sourceUrl=${sourceUrl ? '有' : '无'}`)
  }
}

module.exports = { registerPurchaseOrderCaptureIpc }
