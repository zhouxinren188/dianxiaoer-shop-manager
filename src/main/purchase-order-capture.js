const { BrowserWindow, ipcMain, session } = require('electron')
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
  return !invalidPatterns.test(title)
}

// 验证商品图片：拒绝来自支付/登录页的图片
function isValidProductImage(image) {
  if (!image) return false
  const lower = image.toLowerCase()
  if (lower.includes('alipay.com') || lower.includes('captcha')) return false
  return true
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

// ============ API 拦截器脚本（捕获 + 实时订单号检测） ============
// 核心改进：当API响应到达时，立即检测是否包含订单号
// 通过 console.log 特殊前缀 [PURCHASE_ORDER_FOUND] 即时通知主进程
// 这样即使页面马上跳转（JS上下文销毁），主进程也能收到订单号
const PURCHASE_INTERCEPTOR = `
(function() {
  if (window.__purchaseInterceptorInstalled) return;
  window.__purchaseInterceptorInstalled = true;
  window.__capturedPurchaseResponses = [];

  // 实时检测响应中的淘宝订单号（DL系统核心方案扩展）
  // 优先级：b2c_orid > bizOrderId > orderId
  function checkForOrderNo(body) {
    if (!body || body.length < 10) return;

    // 1. b2c_orid（DL系统核心，最可靠）
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

    // 2. JSON字段检测（bizOrderId, orderId等）
    try {
      var json = JSON.parse(body);
      var fields = ['b2c_orid', 'bizOrderId', 'biz_order_id', 'orderId', 'order_id'];
      function searchObj(obj, depth) {
        if (depth > 4 || !obj || typeof obj !== 'object') return null;
        for (var key of Object.keys(obj)) {
          var val = obj[key];
          if (fields.indexOf(key) >= 0) {
            if (typeof val === 'string' && /^\\d{15,}$/.test(val)) return val;
            if (typeof val === 'number' && String(val).length >= 15) return String(val);
            if (Array.isArray(val) && val.length > 0) {
              var first = val[0];
              if (typeof first === 'string' && /^\\d{15,}$/.test(first)) return first;
              if (typeof first === 'number' && String(first).length >= 15) return String(first);
            }
          }
          if (typeof val === 'object' && val !== null) {
            var found = searchObj(val, depth + 1);
            if (found) return found;
          }
        }
        return null;
      }
      var orderNo = searchObj(json, 0);
      if (orderNo) {
        console.log('[PURCHASE_ORDER_FOUND]' + orderNo);
        return;
      }
    } catch(e) {}
  }

  // 实时从API响应中提取商品信息并缓存（关键！订单号捕获时页面可能已跳转到支付宝）
  function cacheProductInfoFromBody(body) {
    if (!body || body.length < 50 || window.__cachedProductInfo) return;
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
            // 实时检测订单号（关键！不等轮询）
            checkForOrderNo(body);
            // 实时缓存商品信息（关键！页面跳转后提取不到）
            cacheProductInfoFromBody(body);
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
          // 实时检测订单号（关键！不等轮询）
          checkForOrderNo(resp);
          // 实时缓存商品信息（关键！页面跳转后提取不到）
          cacheProductInfoFromBody(resp);
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

// ============ 地址自动填充脚本（参考dl系统） ============

// 各平台地址管理页URL
const ADDRESS_MANAGE_URLS = {
  taobao: 'https://member1.taobao.com/member/fresh/deliver_address.htm',
  '1688': 'https://wuliu.1688.com/foundation/receive_address_manager.htm'
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
      // 去掉【】及其中内容（卖家备注），以及其他淘宝不接受的特殊字符
      var cleanAddr = targetOther.replace(/【[^】]*】/g, '').replace(/\[[^\]]*\]/g, '').trim();
      if (cleanAddr !== targetOther) {
        console.log('[AddressAutoFill] Address cleaned: "' + targetOther + '" -> "' + cleanAddr + '"');
      }

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
      const pddParams = ['order_sn', 'orderSn', 'order_id', 'orderId']
      for (const name of pddParams) {
        const val = params.get(name)
        if (val && /^\d{10,}$/.test(val)) return val
      }
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
 * 支付宝：仅从URL参数提取 out_trade_no（商户外部订单号）
 * 拼多多：从URL参数提取 order_sn
 * 1688：从URL参数提取 orderId
 * 不使用：API响应拦截（容易误抓trade_no）、页面文本匹配（不可靠）、通用URL参数（太泛）
 */
const EXTRACT_ORDER_FROM_PAGE = `
(function() {
  var html = document.querySelector('html') ? document.querySelector('html').innerHTML : '';
  var url = window.location.href;
  var host = window.location.hostname.toLowerCase();
  console.log('[PurchaseCapture] Extracting order from page: ' + url.substring(0, 120));

  // === 支付宝页面: out_trade_no 是商户外部订单号（淘宝订单号） ===
  if (host.indexOf('alipay.com') >= 0) {
    try {
      var params = new URLSearchParams(window.location.search);
      var outTradeNo = params.get('out_trade_no') || params.get('outTradeNo');
      if (outTradeNo && /^\\d{10,}$/.test(outTradeNo)) {
        console.log('[PurchaseCapture] Found Alipay out_trade_no=' + outTradeNo);
        return outTradeNo;
      }
    } catch(e) {}
    console.log('[PurchaseCapture] Alipay page but no valid out_trade_no found');
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

  // === 拼多多: URL 参数 order_sn ===
  if (url.indexOf('yangkeduo.com') >= 0 || url.indexOf('pinduoduo.com') >= 0) {
    try {
      var params = new URLSearchParams(window.location.search);
      var sn = params.get('order_sn') || params.get('orderSn') || params.get('order_id');
      if (sn && /^\\d{10,}$/.test(sn)) {
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

  // 拼多多商品页
  if (!title) {
    var titlePdd = document.querySelector('[class*="goods-name"]')
                || document.querySelector('[class*="productName"]');
    if (titlePdd) title = (titlePdd.textContent || '').trim().substring(0, 200);
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

  console.log('[PurchaseCapture] Product info extracted: title=' + (title || 'EMPTY') + ', image=' + (image ? 'YES' : 'EMPTY') + ', sku=' + (sku || 'EMPTY'));

  return JSON.stringify({ title: title || '', image: image || '', sku: sku || '' });
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
    show: false,  // 默认隐藏，仅需要登录/验证时才显示
    title: `设置收货地址 - ${platform}`,
    webPreferences: {
      partition: partitionName,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

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
                        (urlLower.includes('passport') && urlLower.includes('taobao.com'))
    if (isLoginPage && (purchaseInfo.accountName || purchaseInfo.accountPassword)) {
      addrWin.show()  // 显示窗口让用户看到登录过程
      setTimeout(() => {
        if (addrWin.isDestroyed() || addrDone) return
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
                        (urlLower.includes('passport') && urlLower.includes('taobao.com'))
    if (isLoginPage && (purchaseInfo.accountName || purchaseInfo.accountPassword)) {
      addrWin.show()  // 显示窗口让用户看到登录过程
      setTimeout(() => {
        if (addrWin.isDestroyed() || addrDone) return
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

    const checkScript = 'window.__addrManagerResult || window.__addrDialogResult || window.__tbAddrResult || null'
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

    const partitionName = `persist:purchase-${accountId}`
    console.log(`[PurchaseCapture] Opening window: partition=${partitionName}, url=${purchaseUrl}`)
    console.log(`[PurchaseCapture] Account info: accountId=${accountId}, accountName="${accountName || ''}", password=${password ? 'YES' : 'NO'}`)

    // 从服务器加载Cookie并注入到session
    const ses = session.fromPartition(partitionName)
    try {
      const cookieRes = await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
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
            let skipped = 0
            const now = Date.now() / 1000
            for (const ck of cookies) {
              try {
                // 跳过已过期的Cookie
                if (ck.expirationDate && ck.expirationDate > 0 && ck.expirationDate < now) {
                  skipped++
                  continue
                }
                const cookieDetails = {
                  url: `https://${ck.domain ? ck.domain.replace(/^\./, '') : 'taobao.com'}${ck.path || '/'}`,
                  name: ck.name,
                  value: ck.value,
                  domain: ck.domain,
                  path: ck.path || '/',
                  secure: ck.secure || false,
                  httpOnly: ck.httpOnly || false,
                  sameSite: ck.sameSite || 'no_restriction'
                }
                if (ck.expirationDate && ck.expirationDate > 0) {
                  cookieDetails.expirationDate = ck.expirationDate
                }
                await ses.cookies.set(cookieDetails)
                injected++
              } catch (e) { /* skip invalid cookies */ }
            }
            console.log(`[PurchaseCapture] Cookie restored: ${injected}/${cookies.length} from server (${skipped} expired, skipped)`)
          }
        }
      }
    } catch (e) {
      console.warn('[PurchaseCapture] Cookie restore failed:', e.message)
    }

    // 提前计算地址设置需求（用于决定窗口是否隐藏）
    const hasShippingInfo = purchaseInfo.shippingName || purchaseInfo.shippingPhone || purchaseInfo.shippingAddress
    const needAddrSetup = hasShippingInfo && (platform === '1688' || platform === 'taobao')
    const parsedAddr = needAddrSetup ? parseAddress(purchaseInfo.shippingAddress) : null

    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      show: true,  // 主窗口始终立即显示，地址设置在独立后台窗口完成
      title: `采购下单 - ${platform}`,
      webPreferences: {
        partition: partitionName,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })

    // 转发采购窗口内的console.log到主进程（用于调试注入脚本）
    win.webContents.on('console-message', (event, level, message) => {
      if (message.includes('[AddressAutoFill]') || message.includes('[PurchaseCapture]') || message.includes('[LoginAutoFill]') || message.includes('[AddressRefresh]')) {
        console.log(`[PurchaseWin] ${message}`)
      }
    })

    let resolved = false
    let pollTimer = null
    let backgroundAddrWin = null  // 后台地址设置窗口引用，用于cleanup联动
    let cachedProductInfo = null  // 缓存采购商品信息（从商品详情页提前提取）
    const windowState = { win, pollTimer, resolved }
    activePurchaseWindows.set(purchaseNo, windowState)

    function cleanup() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      // 联动清理后台地址窗口
      if (backgroundAddrWin && !backgroundAddrWin.isDestroyed()) {
        backgroundAddrWin.destroy()
        backgroundAddrWin = null
      }
      windowState.pollTimer = null
      activePurchaseWindows.delete(purchaseNo)
    }

    // 保存采购窗口的Cookie到服务器（用户可能在窗口内登录了）
    async function savePurchaseWindowCookies() {
      try {
        const ses = session.fromPartition(partitionName)
        const cookies = await ses.cookies.get({})
        if (cookies && cookies.length > 0) {
          await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookies`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie_data: JSON.stringify(cookies), platform })
          })
          console.log(`[PurchaseCapture] Cookie saved on window close: ${cookies.length} cookies`)

          // 同步更新采购账号在线状态（Cookie 有效说明账号在线）
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
            // 绑定成功后写入系统备注
            if (purchaseInfo.salesOrderId) {
              try {
                const purchasePriceText = capturedAmount || purchaseInfo.purchasePrice || ''
                const sysRemark = `【${purchaseNo}】${platformOrderNo} ${purchasePriceText}（${purchaseInfo.accountName || ''}）`
                const sysRemarkRes = await httpRequest(`${BUSINESS_SERVER}/api/sales-orders/${purchaseInfo.salesOrderId}/sys-remark`, {
                  method: 'PUT',
                  body: JSON.stringify({ sys_remark: sysRemark })
                })
                const sysRemarkJson = JSON.parse(sysRemarkRes.data)
                if (sysRemarkJson.code === 0 && sysRemarkJson.data && sysRemarkJson.data.updated > 0) {
                  console.log(`[PurchaseCapture] 系统备注已写入: ${sysRemark}`)
                } else {
                  console.warn(`[PurchaseCapture] 系统备注写入可能失败: HTTP ${sysRemarkRes.statusCode}, body=${sysRemarkRes.data.substring(0, 200)}`)
                }
              } catch (e) {
                console.warn(`[PurchaseCapture] 系统备注写入失败(非关键): ${e.message}`)
              }
            } else {
              console.warn(`[PurchaseCapture] 跳过系统备注写入: salesOrderId 为空`)
            }
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
              console.log('[PurchaseCapture] No payment amount captured')
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
            } else {
              // 最后兜底：从当前页面DOM提取
              try {
                const domResult = await win.webContents.executeJavaScript(EXTRACT_PURCHASE_PRODUCT_INFO).catch(() => null)
                if (domResult) {
                  const productInfo = JSON.parse(domResult)
                  if (productInfo.title && isValidProductTitle(productInfo.title)) {
                    purchaseInfo.goodsName = productInfo.title
                    console.log(`[PurchaseCapture] 商品名已覆盖(实时DOM): ${productInfo.title}`)
                  } else if (productInfo.title) {
                    console.warn(`[PurchaseCapture] 商品名验证失败(实时DOM), 忽略: ${productInfo.title}`)
                  }
                  if (productInfo.image && isValidProductImage(productInfo.image)) {
                    purchaseInfo.image = productInfo.image
                    console.log(`[PurchaseCapture] 商品图片已覆盖(实时DOM)`)
                  }
                  if (productInfo.sku) {
                    purchaseInfo.sku = productInfo.sku
                    console.log(`[PurchaseCapture] SKU已覆盖(实时DOM): ${productInfo.sku}`)
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

      // 5秒后关闭窗口（留足时间给API调用）
      setTimeout(() => {
        if (win && !win.isDestroyed()) {
          win.destroy()
        }
      }, 5000)
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
        if (orderNo && /^\d{10,}$/.test(orderNo)) {
          console.log(`[PurchaseCapture] Order found via real-time interceptor: ${orderNo}`)
          onOrderCaptured(orderNo)
        }
      }
      // API拦截器实时缓存的商品信息（比dom-ready更快、更可靠）
      if (message.startsWith('[PURCHASE_PRODUCT_CACHED]')) {
        try {
          const info = JSON.parse(message.substring('[PURCHASE_PRODUCT_CACHED]'.length))
          if (info && (info.title || info.image)) {
            cachedProductInfo = info
            console.log(`[PurchaseCapture] 商品信息已缓存(API拦截): title=${(info.title || '').substring(0, 40)}, image=${info.image ? 'YES' : 'NO'}, sku=${(info.sku || '').substring(0, 30)}`)

            // 商品信息成功提取 = 页面确认正常加载，此时启动后台地址设置窗口
            if (needAddrSetup && parsedAddr && !backgroundAddrWin) {
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

      // 主窗口始终注入订单拦截器（地址设置已在独立后台窗口完成）
      win.webContents.executeJavaScript(PURCHASE_INTERCEPTOR).catch(() => {})
      console.log('[PurchaseCapture] Interceptor injected')

      // === 登录页自动填充 ===
      const urlLower = currentUrl.toLowerCase()
      const isLoginPage = urlLower.includes('login.taobao.com') ||
                          urlLower.includes('login.1688.com') ||
                          urlLower.includes('login.tmall.com') ||
                          (urlLower.includes('passport') && urlLower.includes('1688.com')) ||
                          (urlLower.includes('passport') && urlLower.includes('taobao.com')) ||
                          urlLower.includes('yangkeduo.com/login')

      if (isLoginPage && purchaseInfo.accountPassword && !resolved) {
        setTimeout(() => {
          if (win.isDestroyed() || resolved) return
          const script = buildLoginAutoFillScript(purchaseInfo.accountName, purchaseInfo.accountPassword)
          if (script) {
            win.webContents.executeJavaScript(script).catch(() => {})
            console.log('[PurchaseCapture] Login auto-fill script injected')
          }
        }, 1000)
      }

      // === 关键：在商品详情页/结算页提前缓存商品信息 ===
      // 订单号捕获时页面可能已跳转到支付宝，此时再提取就拿到"登录中心-支付宝"了
      // 所以必须在商品详情页/结算页时就把商品信息缓存住
      const isProductPage = urlLower.includes('item.taobao.com') ||
                            urlLower.includes('detail.tmall.com') ||
                            urlLower.includes('detail.1688.com') ||
                            urlLower.includes('item.jd.com') ||
                            urlLower.includes('yangkeduo') ||
                            urlLower.includes('mobile.yangkeduo')
      const isCheckoutUrl = urlLower.includes('buy.taobao.com') ||
                             urlLower.includes('buy.tmall.com') ||
                             urlLower.includes('order.1688.com') ||
                             urlLower.includes('trade.1688.com')

      if ((isProductPage || isCheckoutUrl) && !cachedProductInfo) {
        // 延迟提取，等页面渲染完成
        setTimeout(() => {
          if (win.isDestroyed() || resolved || cachedProductInfo) return
          win.webContents.executeJavaScript(EXTRACT_PURCHASE_PRODUCT_INFO)
            .then(result => {
              if (!result || resolved) return
              try {
                const info = JSON.parse(result)
                if ((info.title && isValidProductTitle(info.title)) || info.image) {
                  cachedProductInfo = info
                  console.log(`[PurchaseCapture] 商品信息已缓存: title=${(info.title || '').substring(0, 40)}, image=${info.image ? 'YES' : 'NO'}, sku=${(info.sku || '').substring(0, 30)}`)

                  // 商品信息成功提取 = 页面确认正常加载，此时启动后台地址设置窗口
                  if (needAddrSetup && parsedAddr && !backgroundAddrWin) {
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
            if (win.isDestroyed() || resolved || cachedProductInfo) return
            win.webContents.executeJavaScript(EXTRACT_PURCHASE_PRODUCT_INFO)
              .then(result => {
                if (!result || resolved || cachedProductInfo) return
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
            const ses = session.fromPartition(partitionName)
            const cookies = await ses.cookies.get({})
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

      // === 结算页地址面板 fallback（仅在未通过专用地址管理页设置时） ===
      const { shippingName, shippingPhone, shippingAddress } = purchaseInfo
      if (platform !== '1688' && (shippingName || shippingPhone || shippingAddress)) {
        if (isCheckoutPage(currentUrl, platform)) {
          const fillScript = buildAddressAutoFillScript(shippingName, shippingPhone, shippingAddress, platform)
          win.webContents.executeJavaScript(fillScript).catch(() => {})
          console.log(`[PurchaseCapture] Address auto-fill injected for checkout page`)
        }
      }

      // 检测是否为订单确认/支付回调页面，尝试提取订单号
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

      // === 非淘宝平台：保持原有逻辑 ===
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

      // 尝试从新页面提取订单号
      tryExtractOrderFromPage(url)

      // === 登录页自动填充（导航到登录页时注入） ===
      const navUrlLower = url.toLowerCase()
      const isLoginPageNav = navUrlLower.includes('login.taobao.com') ||
                             navUrlLower.includes('login.1688.com') ||
                             navUrlLower.includes('login.tmall.com') ||
                             (navUrlLower.includes('passport') && navUrlLower.includes('1688.com')) ||
                             (navUrlLower.includes('passport') && navUrlLower.includes('taobao.com')) ||
                             navUrlLower.includes('yangkeduo.com/login')

      if (isLoginPageNav && purchaseInfo.accountPassword && !resolved) {
        setTimeout(() => {
          if (win.isDestroyed() || resolved) return
          const script = buildLoginAutoFillScript(purchaseInfo.accountName, purchaseInfo.accountPassword)
          if (script) {
            win.webContents.executeJavaScript(script).catch(() => {})
            console.log('[PurchaseCapture] Login auto-fill script injected after navigation')
          }
        }, 1000)
      }

      // === 结算页地址面板 fallback ===
      const { shippingName, shippingPhone, shippingAddress } = purchaseInfo
      if (platform !== '1688' && (shippingName || shippingPhone || shippingAddress)) {
        if (isCheckoutPage(url, platform)) {
          setTimeout(() => {
            if (win.isDestroyed() || resolved) return
            const fillScript = buildAddressAutoFillScript(shippingName, shippingPhone, shippingAddress, platform)
            win.webContents.executeJavaScript(fillScript).catch(() => {})
            console.log(`[PurchaseCapture] Address auto-fill injected after navigation`)
          }, 3000)
        }
      }
    })

    // SPA内的hash/pushState导航
    win.webContents.on('did-navigate-in-page', (event, url) => {
      if (win.isDestroyed() || resolved) return
      console.log(`[PurchaseCapture] did-navigate-in-page: ${url.substring(0, 120)}`)

      // 尝试从新页面提取订单号
      tryExtractOrderFromPage(url)
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
    })

    // 监听重定向（支付宝URL中可能包含订单号）
    win.webContents.on('will-redirect', (event, url) => {
      if (win.isDestroyed() || resolved) return
      console.log(`[PurchaseCapture] will-redirect: ${url.substring(0, 120)}`)

      // 重定向URL中可能有订单号参数
      const urlOrderNo = extractOrderNoFromUrl(url, platform)
      if (urlOrderNo) {
        console.log(`[PurchaseCapture] Order found in redirect URL: ${urlOrderNo}`)
        onOrderCaptured(urlOrderNo)
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

    // 主窗口始终加载商品页（DL系统经验：地址设置在独立后台窗口完成，不影响客户选品）
    console.log(`[PurchaseCapture] Loading product page: ${purchaseUrl.substring(0, 120)}`)

    try {
      await win.loadURL(purchaseUrl)
    } catch (e) {
      console.error('[PurchaseCapture] loadURL failed:', e.message)
    }

    // 地址设置延迟启动：等商品信息成功提取后再启动（避免cookie过期时两个窗口同时撞上登录页）
    // 触发点：console-message 中的 [PURCHASE_PRODUCT_CACHED] 和 dom-ready 中的商品信息提取

    // 启动轮询检测订单号（1000ms频率，提高捕获率）
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
