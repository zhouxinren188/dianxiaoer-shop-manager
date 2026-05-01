const { BrowserWindow, ipcMain, session } = require('electron')
const http = require('http')
const { getAuthToken } = require('./auth-store')
const ProvinceData = require('./province-data')

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
  const name = (receiverName || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const phone = (receiverPhone || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const province = (parsedAddr.province || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const city = (parsedAddr.city || parsedAddr.province || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const area = (parsedAddr.area || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const other = (parsedAddr.other || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")

  return `
(function() {
  if (window.__addrDialogDone) return;
  window.__addrDialogDone = true;
  console.log('[AddressAutoFill] 1688 address dialog page loaded');

  var targetName = '${name}';
  var targetPhone = '${phone}';
  var targetProvince = '${province}';
  var targetCity = '${city}';
  var targetArea = '${area}';
  var targetOther = '${other}';

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
  const name = (receiverName || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const phone = (receiverPhone || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const province = (parsedAddr.province || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const city = (parsedAddr.city || parsedAddr.province || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const area = (parsedAddr.area || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const other = (parsedAddr.other || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")

  return `
(function() {
  if (window.__tbAddrDone) return;
  window.__tbAddrDone = true;

  var targetName = '${name}';
  var targetPhone = '${phone}';
  var targetProvince = '${province}';
  var targetCity = '${city}';
  var targetArea = '${area}';
  var targetOther = '${other}';

  console.log('[AddressAutoFill] Taobao address manager page loaded');
  console.log('[AddressAutoFill] Target: name=' + targetName + ', phone=' + targetPhone + ', province=' + targetProvince + ', city=' + targetCity + ', area=' + targetArea + ', other=' + targetOther);

  var evInput = document.createEvent('HTMLEvents');
  evInput.initEvent('input', true, true);

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
              setTimeout(addReceiver, 1500);
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
    console.log('[AddressAutoFill] addReceiver starting, scanning form fields...');

    // 诊断：列出页面上所有可见的input/textarea
    var allInputs = document.querySelectorAll('input:not([type="hidden"]), textarea');
    for (var d = 0; d < allInputs.length; d++) {
      var inp = allInputs[d];
      if (inp.offsetParent !== null || getComputedStyle(inp).position === 'fixed') {
        console.log('[AddressAutoFill] Visible input[' + d + ']: id=' + inp.id + ' name=' + inp.name + ' placeholder=' + (inp.placeholder || '') + ' type=' + inp.type + ' class=' + inp.className.substring(0, 60));
      }
    }

    // 注意：姓名、手机号、勾选默认地址 移到 fillDetailAndSave 中填写
    // 因为级联选择会触发React重新渲染，导致之前填的值被清空

    // === 省市区级联选择（先做这个） ===
    startCascadeSelection();
  }

  // 级联选择器的当前步骤: 1=省, 2=市, 3=区, 4=完成
  var cascadeStep = 0;

  function startCascadeSelection() {
    console.log('[AddressAutoFill] Starting cascade selection...');

    // 检测旧版选择器是否存在
    var oldDivision = document.querySelector('.cndzk-entrance-division');
    if (oldDivision) {
      console.log('[AddressAutoFill] Found old-style .cndzk-entrance-division');
    }

    // 确保省份下拉框已打开
    var clickHeader = document.querySelector('.cndzk-entrance-division-header-click');
    if (!document.querySelector('.cndzk-entrance-division-box') && clickHeader) {
      clickHeader.click();
      console.log('[AddressAutoFill] Clicked header to open dropdown');
    }

    // 统一使用轮询方式处理（兼容旧版和新版，解决 DOMNodeInserted 事件遗漏问题）
    cascadeStep = 1;
    var pollCount = 0;
    var pollTimer = setInterval(function() {
      pollCount++;
      if (pollCount > 60) {
        clearInterval(pollTimer);
        console.log('[AddressAutoFill] Cascade selection timeout after 30s');
        return;
      }

      // 获取当前可见的列表项
      var items = getCascadeItems();
      if (pollCount <= 3 || pollCount % 10 === 0) {
        console.log('[AddressAutoFill] Poll #' + pollCount + ': found ' + items.length + ' items, cascadeStep=' + cascadeStep);
      }
      if (items.length === 0) return;

      if (cascadeStep === 1) {
        for (var i = 0; i < items.length; i++) {
          var text = (items[i].innerText || '').trim();
          if (text === targetProvince || text.indexOf(targetProvince) === 0 || targetProvince.indexOf(text) === 0) {
            items[i].click();
            cascadeStep = 2;
            console.log('[AddressAutoFill] Selected province: ' + text);
            break;
          }
        }
      } else if (cascadeStep === 2) {
        for (var i = 0; i < items.length; i++) {
          var text = (items[i].innerText || '').trim();
          if (text === targetCity || text.indexOf(targetCity) === 0 || targetCity.indexOf(text) === 0) {
            items[i].click();
            cascadeStep = targetArea ? 3 : 4;
            console.log('[AddressAutoFill] Selected city: ' + text);
            if (cascadeStep === 4) {
              clearInterval(pollTimer);
              setTimeout(fillDetailAndSave, 500);
            }
            break;
          }
        }
      } else if (cascadeStep === 3) {
        for (var i = 0; i < items.length; i++) {
          var text = (items[i].innerText || '').trim();
          if (text === targetArea || text.indexOf(targetArea) === 0 || targetArea.indexOf(text) === 0) {
            items[i].click();
            cascadeStep = 4;
            console.log('[AddressAutoFill] Selected area: ' + text);
            clearInterval(pollTimer);
            // 参考DL系统：选完区之后直接关闭下拉框、填详细地址、保存（不选街道）
            setTimeout(fillDetailAndSave, 800);
            break;
          }
        }
      } else {
        clearInterval(pollTimer);
      }
    }, 500);
  }

  // 获取级联选择器中当前可见的列表项
  function getCascadeItems() {
    var items = [];
    var box = document.querySelector('.cndzk-entrance-division-box');

    // 方式1（优先）: .cndzk-entrance-division-box 内搜索所有可点击文本元素
    // 这种方式能穿透wrapper容器，直接找到实际的省/市/区选项
    if (box) {
      var allEls = box.querySelectorAll('a, li, div[role="option"], span[class*="item"], div[class*="item"]');
      for (var i = 0; i < allEls.length; i++) {
        var txt = (allEls[i].innerText || '').trim();
        if (txt.length > 0 && txt.length < 30) {
          items.push(allEls[i]);
        }
      }
      if (items.length > 1) {
        console.log('[AddressAutoFill] getCascadeItems: found ' + items.length + ' items via box descendants');
        return items;
      }
      items = []; // 清空重试

      // 方式1b: 如果上面的选择器没匹配到，尝试box-content的直接子元素
      var content = document.querySelector('.cndzk-entrance-division-box-content');
      if (content && content.children.length > 1) {
        for (var i = 0; i < content.children.length; i++) {
          var txt = (content.children[i].innerText || '').trim();
          if (txt.length > 0 && txt.length < 30) {
            items.push(content.children[i]);
          }
        }
        if (items.length > 1) {
          console.log('[AddressAutoFill] getCascadeItems: found ' + items.length + ' items via box-content children');
          return items;
        }
        items = [];
      }

      // 方式1c: 最宽泛 — box内所有有文本的叶子节点
      var allNodes = box.querySelectorAll('*');
      for (var i = 0; i < allNodes.length; i++) {
        var el = allNodes[i];
        // 叶子节点（没有子元素或子元素都不含文本）且有短文本
        if (el.children.length === 0 || (el.children.length === 1 && el.children[0].children.length === 0)) {
          var txt = (el.innerText || '').trim();
          if (txt.length > 0 && txt.length < 20 && el.tagName !== 'STYLE' && el.tagName !== 'SCRIPT') {
            items.push(el);
          }
        }
      }
      if (items.length > 1) {
        console.log('[AddressAutoFill] getCascadeItems: found ' + items.length + ' items via box leaf nodes');
        return items;
      }

      // 诊断
      console.log('[AddressAutoFill] getCascadeItems: box exists, items=' + items.length + '. innerHTML first 500: ' + box.innerHTML.substring(0, 500));
      if (items.length > 0) return items;
      items = [];
    }

    // 方式2: overlay / popup 中的 li（新版页面结构）
    var overlays = document.querySelectorAll('.next-overlay-wrapper, [class*="overlay"], [class*="popup"], [class*="dropdown"]');
    for (var o = 0; o < overlays.length; o++) {
      var lis = overlays[o].querySelectorAll('li');
      for (var i = 0; i < lis.length; i++) {
        var txt = (lis[i].innerText || '').trim();
        if (txt.length > 0 && txt.length < 30) {
          items.push(lis[i]);
        }
      }
      if (items.length > 2) {
        console.log('[AddressAutoFill] getCascadeItems: found ' + items.length + ' items via overlay li');
        return items;
      }
    }

    // 诊断
    var division = document.querySelector('.cndzk-entrance-division');
    console.log('[AddressAutoFill] getCascadeItems EMPTY: division=' + !!division + ' box=' + !!box);

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
          }, 1000);
        } else {
          console.log('[AddressAutoFill] Save button NOT found');
        }
      }, 800);
    }, 500);
  }

  // === 主流程 ===
  if (document.querySelectorAll('.t-delete').length > 10) {
    console.log('[AddressAutoFill] Too many addresses, deleting first one');
    isDelete = true;
    document.querySelector('.t-delete').click();

    // 轮询检测删除确认弹窗并自动点击（DOMNodeInserted可能无法捕获新版弹窗）
    var delPollCount = 0;
    var delPollTimer = setInterval(function() {
      delPollCount++;
      if (delPollCount > 20) {
        clearInterval(delPollTimer);
        console.log('[AddressAutoFill] Delete confirm poll timeout, proceeding to add');
        clickAddButton();
        setTimeout(addReceiver, 1500);
        return;
      }
      // 查找所有确认弹窗
      var dialogs = document.querySelectorAll('.next-overlay-wrapper .next-dialog, .next-overlay-wrapper .next-message');
      for (var d = 0; d < dialogs.length; d++) {
        var dlg = dialogs[d];
        var dlgText = (dlg.innerText || '');
        if (dlgText.indexOf('删除') >= 0 || dlgText.indexOf('确认') >= 0) {
          var confirmBtn = dlg.querySelector('.next-btn-primary');
          if (confirmBtn) {
            clearInterval(delPollTimer);
            console.log('[AddressAutoFill] Delete confirm dialog found, clicking confirm');
            confirmBtn.click();
            // 删除完成后，点击添加按钮
            setTimeout(function() {
              clickAddButton();
              setTimeout(addReceiver, 1500);
            }, 500);
            return;
          }
        }
      }
      // 备用：查找页面上所有可见的"确认"按钮（弹窗可能不是.next-dialog结构）
      var allBtns = document.querySelectorAll('button');
      for (var b = 0; b < allBtns.length; b++) {
        var btn = allBtns[b];
        var btnText = (btn.textContent || '').trim();
        // 在弹窗中的确认按钮（旁边有"取消"按钮）
        if (btnText === '确认' && btn.parentElement) {
          var sibling = btn.parentElement.querySelector('button');
          var sibText = sibling ? (sibling.textContent || '').trim() : '';
          if (sibText === '取消' || btn.parentElement.querySelectorAll('button').length >= 2) {
            var parentText = (btn.closest('.next-overlay-wrapper') || btn.parentElement.parentElement || {}).innerText || '';
            if (parentText.indexOf('删除') >= 0) {
              clearInterval(delPollTimer);
              console.log('[AddressAutoFill] Delete confirm button found via fallback, clicking');
              btn.click();
              setTimeout(function() {
                clickAddButton();
                setTimeout(addReceiver, 1500);
              }, 500);
              return;
            }
          }
        }
      }
    }, 500);
  } else {
    clickAddButton();
    setTimeout(addReceiver, 1500);
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
  taobao: {
    urlKeywords: ['submitOrder', 'create_order', 'buy_now', 'confirmOrder', 'buyertrade', 'createOrder', 'placeOrder', 'order', 'trade'],
    fields: ['orderId', 'bizOrderId', 'tradeNo', 'orderIds', 'id', 'tradeID', 'biz_order_id', 'trade_no', 'out_trade_no'],
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
      // 支付宝付款URL: cashier.alipay.com?out_trade_no=xxx 或 trade_no=xxx
      // 淘宝交易URL: trade.taobao.com?bizOrderId=xxx
      // 注意：不使用泛化的 'id' 参数，因为商品页的 id 是商品ID，不是订单号
      const orderParamNames = [
        'bizOrderId', 'biz_order_id', 'orderId', 'order_id',
        'trade_no', 'tradeNo', 'out_trade_no', 'outTradeNo',
        'tradeID'
      ]
      for (const name of orderParamNames) {
        const val = params.get(name)
        if (val && /^\d{10,}$/.test(val)) {
          console.log(`[PurchaseCapture] Order found in URL param: ${name}=${val}, url=${url.substring(0, 120)}`)
          return val
        }
      }

      // 检查URL路径中的数字串（仅在交易/订单相关域名下）
      const orderHosts = ['trade.taobao.com', 'buyertrade.taobao.com', 'cashier.alipay.com', 'mclient.alipay.com']
      if (orderHosts.some(h => host.includes(h))) {
        const pathMatch = urlObj.pathname.match(/(\d{15,})/)
        if (pathMatch) {
          console.log(`[PurchaseCapture] Order found in URL path: ${pathMatch[1]}, url=${url.substring(0, 120)}`)
          return pathMatch[1]
        }
      }
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
 * 从页面内容中提取订单号的脚本（参考dl系统）
 * 淘宝：从HTML源码提取 b2c_orid=xxx
 * 拼多多：从URL参数提取 order_sn
 * 通用：页面文本中的"订单号"后面的数字
 */
const EXTRACT_ORDER_FROM_PAGE = `
(function() {
  var html = document.querySelector('html') ? document.querySelector('html').innerHTML : '';
  var url = window.location.href;
  console.log('[PurchaseCapture] Extracting order from page: ' + url.substring(0, 120));

  // === 淘宝/天猫: confirm_order.htm 页面中的 b2c_orid ===
  if (url.indexOf('confirm_order') >= 0 || url.indexOf('buy.taobao.com') >= 0 || url.indexOf('buy.tmall.com') >= 0) {
    // 方法1: 从HTML源码中提取 b2c_orid=xxx& (dl系统核心方案)
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
    // 方法2: 其他可能的嵌入字段
    var patterns = [/tradeID[=:]["']?(\\d{15,})/, /bizOrderId[=:]["']?(\\d{15,})/, /orderId[=:]["']?(\\d{15,})/];
    for (var p = 0; p < patterns.length; p++) {
      var m = html.match(patterns[p]);
      if (m) { console.log('[PurchaseCapture] Found in HTML: ' + m[1]); return m[1]; }
    }
  }

  // === 拼多多: 微信支付回调页面 URL 参数 order_sn ===
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

  // === 通用: URL 参数检测 ===
  try {
    var params = new URLSearchParams(window.location.search);
    var names = ['bizOrderId','biz_order_id','orderId','order_id','trade_no','tradeNo','out_trade_no','order_sn'];
    for (var j = 0; j < names.length; j++) {
      var v = params.get(names[j]);
      if (v && /^\\d{10,}$/.test(v)) {
        console.log('[PurchaseCapture] Found URL param ' + names[j] + '=' + v);
        return v;
      }
    }
  } catch(e) {}

  // === 通用: 页面文本中的订单号 ===
  var text = document.body ? (document.body.innerText || '') : '';
  var textPatterns = [
    /订单(?:号|编号)[：:\\s]*?(\\d{15,})/,
    /交易(?:号|编号)[：:\\s]*?(\\d{15,})/
  ];
  for (var i = 0; i < textPatterns.length; i++) {
    var m = text.match(textPatterns[i]);
    if (m) { console.log('[PurchaseCapture] Found in text: ' + m[1]); return m[1]; }
  }

  return null;
})()
`

// 订单确认/支付相关页面URL模式
const ORDER_CONFIRM_PATTERNS = {
  taobao: [
    'buy.taobao.com/auction/confirm_order',   // 淘宝订单确认页（核心！b2c_orid在此页）
    'buy.tmall.com/order/confirm_order',       // 天猫订单确认页
    'buy.taobao.com/auction/order/confirm',    // 备用路径
    'cashier.alipay.com',                      // 支付宝收银台
    'mclient.alipay.com',                      // 手机支付宝
    'trade.taobao.com',                        // 交易详情
    'buyertrade.taobao.com'                    // 买家交易
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

    // 转发采购窗口内的console.log到主进程（用于调试注入脚本）
    win.webContents.on('console-message', (event, level, message) => {
      if (message.includes('[AddressAutoFill]') || message.includes('[PurchaseCapture]')) {
        console.log(`[PurchaseWin] ${message}`)
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

    // 保存采购窗口的Cookie到服务器（用户可能在窗口内登录了）
    async function savePurchaseWindowCookies() {
      try {
        const ses = session.fromPartition(partitionName)
        const cookies = await ses.cookies.get({})
        if (cookies && cookies.length > 0) {
          await httpRequest(`${BUSINESS_SERVER}/api/purchase-accounts/${accountId}/cookie`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie_data: JSON.stringify(cookies), platform })
          })
          console.log(`[PurchaseCapture] Cookie saved on window close: ${cookies.length} cookies`)
        }
      } catch (e) {
        console.error('[PurchaseCapture] Save cookies failed:', e.message)
      }
    }

    function onOrderCaptured(platformOrderNo) {
      if (resolved) return
      resolved = true
      windowState.resolved = true
      cleanup()

      // 保存Cookie（用户在窗口内可能登录了，积累了新Cookie）
      savePurchaseWindowCookies()

      // 自动调用服务端API创建采购单和绑定，完成后再通知前端
      autoCreateAndBind(purchaseInfo, platformOrderNo, platform)
        .then(() => {
          console.log(`[PurchaseCapture] Auto-bind 成功: purchaseNo=${purchaseNo}, orderNo=${platformOrderNo}`)
          // 绑定成功后通知前端
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('purchase-order-captured', {
              purchaseNo,
              platformOrderNo,
              platform,
              success: true
            })
          }
        })
        .catch(err => {
          console.error(`[PurchaseCapture] Auto-bind 失败:`, err.message)
          // 绑定失败也通知前端（附带错误信息，前端可提示用户手动绑定）
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

    // 注入 API 拦截器 + 地址自动填充
    // 地址设置状态追踪（淘宝和1688都走"先设地址再采购"流程）
    let addrSetDone = false  // 地址是否已设置完成
    const hasShippingInfo = purchaseInfo.shippingName || purchaseInfo.shippingPhone || purchaseInfo.shippingAddress
    const needAddrSetup = hasShippingInfo && (platform === '1688' || platform === 'taobao')
    const parsedAddr = needAddrSetup ? parseAddress(purchaseInfo.shippingAddress) : null

    console.log(`[PurchaseCapture] Address check: platform=${platform}, hasShippingInfo=${!!hasShippingInfo}, needAddrSetup=${needAddrSetup}`)
    console.log(`[PurchaseCapture] Shipping: name="${purchaseInfo.shippingName}", phone="${purchaseInfo.shippingPhone}", addr="${(purchaseInfo.shippingAddress || '').substring(0, 50)}"`)
    if (needAddrSetup) {
      console.log(`[PurchaseCapture] Address setup needed for ${platform}, parsed:`, parsedAddr ? `${parsedAddr.province}/${parsedAddr.city}/${parsedAddr.area}/${parsedAddr.other}` : 'PARSE_FAILED')
    }

    win.webContents.on('dom-ready', () => {
      if (win.isDestroyed() || resolved) return
      win.webContents.executeJavaScript(PURCHASE_INTERCEPTOR).catch(() => {})
      console.log('[PurchaseCapture] Interceptor injected')

      const currentUrl = win.webContents.getURL()
      console.log(`[PurchaseCapture] dom-ready: ${currentUrl.substring(0, 120)}`)

      // === 地址处理（参考dl系统：先导航到地址管理页设置地址） ===
      if (needAddrSetup && !addrSetDone) {
        const urlLower = currentUrl.toLowerCase()

        // 淘宝地址管理页（排除中间跳转页 _____tmd_____ ）
        if (urlLower.includes('member1.taobao.com/member/fresh/deliver_address') && !urlLower.includes('_____tmd_____') && !urlLower.includes('login_jump')) {
          console.log('[PurchaseCapture] Taobao address manager page detected')
          if (parsedAddr) {
            setTimeout(() => {
              if (win.isDestroyed() || resolved) return
              const script = buildTaobaoAddressManagerScript(purchaseInfo.shippingName, purchaseInfo.shippingPhone, parsedAddr)
              win.webContents.executeJavaScript(script).catch(() => {})
            }, 2000)
          }
          return
        }

        // 1688地址管理页 - 点击"新增收货地址"
        if (urlLower.includes('wuliu.1688.com/foundation/receive_address_manager')) {
          console.log('[PurchaseCapture] 1688 address manager page detected')
          setTimeout(() => {
            if (win.isDestroyed() || resolved) return
            win.webContents.executeJavaScript(build1688AddressManagerScript()).catch(() => {})
          }, 1500)
          return
        }

        // 1688地址编辑弹窗页 - 填写表单+省市区级联
        if (urlLower.includes('air.1688.com/app/1688-global/address-manage/address-dialog')) {
          console.log('[PurchaseCapture] 1688 address dialog page detected')
          if (parsedAddr) {
            setTimeout(() => {
              if (win.isDestroyed() || resolved) return
              const script = build1688AddressDialogScript(purchaseInfo.shippingName, purchaseInfo.shippingPhone, parsedAddr)
              win.webContents.executeJavaScript(script).catch(() => {})
            }, 1500)
          } else {
            console.warn('[PurchaseCapture] Address parse failed, cannot auto-fill')
          }
          return
        }
      }

      // === 淘宝/通用：结算页地址面板（仅在未通过专用地址管理页设置时作为fallback） ===
      const { shippingName, shippingPhone, shippingAddress } = purchaseInfo
      if (platform !== '1688' && !addrSetDone && (shippingName || shippingPhone || shippingAddress)) {
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
    function tryExtractOrderFromPage(url) {
      if (win.isDestroyed() || resolved) return

      // 1. 先检查URL参数中是否有订单号
      const urlOrderNo = extractOrderNoFromUrl(url, platform)
      if (urlOrderNo) {
        console.log(`[PurchaseCapture] Order found in URL: ${urlOrderNo}`)
        onOrderCaptured(urlOrderNo)
        return
      }

      // 2. 检查是否是订单确认/支付相关页面
      const patterns = ORDER_CONFIRM_PATTERNS[platform] || []
      const urlLower = url.toLowerCase()
      const isOrderPage = patterns.some(p => urlLower.includes(p.toLowerCase()))
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

      // === 地址流程：检测页面导航 ===
      if (needAddrSetup && !addrSetDone) {
        const urlLower = url.toLowerCase()

        // 淘宝地址管理页（排除中间跳转页）
        if (urlLower.includes('member1.taobao.com/member/fresh/deliver_address') && !urlLower.includes('_____tmd_____') && !urlLower.includes('login_jump')) {
          if (parsedAddr) {
            setTimeout(() => {
              if (win.isDestroyed() || resolved) return
              const script = buildTaobaoAddressManagerScript(purchaseInfo.shippingName, purchaseInfo.shippingPhone, parsedAddr)
              win.webContents.executeJavaScript(script).catch(() => {})
              console.log('[PurchaseCapture] Taobao address manager script injected after navigation')
            }, 2000)
          }
          return
        }

        // 1688地址管理页
        if (urlLower.includes('wuliu.1688.com/foundation/receive_address_manager')) {
          setTimeout(() => {
            if (win.isDestroyed() || resolved) return
            win.webContents.executeJavaScript(build1688AddressManagerScript()).catch(() => {})
            console.log('[PurchaseCapture] 1688 address manager script injected after navigation')
          }, 1500)
          return
        }

        // 1688地址编辑弹窗页
        if (urlLower.includes('air.1688.com/app/1688-global/address-manage/address-dialog')) {
          if (parsedAddr) {
            setTimeout(() => {
              if (win.isDestroyed() || resolved) return
              const script = build1688AddressDialogScript(purchaseInfo.shippingName, purchaseInfo.shippingPhone, parsedAddr)
              win.webContents.executeJavaScript(script).catch(() => {})
              console.log('[PurchaseCapture] 1688 address dialog script injected after navigation')
            }, 1500)
          }
          return
        }
      }

      // === 淘宝/通用地址填充（仅在未通过专用地址管理页设置时作为fallback） ===
      const { shippingName, shippingPhone, shippingAddress } = purchaseInfo
      if (platform !== '1688' && !addrSetDone && (shippingName || shippingPhone || shippingAddress)) {
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

    // 监听重定向（支付宝URL中可能包含订单号）
    win.webContents.on('will-redirect', (event, url) => {
      if (win.isDestroyed() || resolved) return
      console.log(`[PurchaseCapture] will-redirect: ${url.substring(0, 120)}`)
      const urlOrderNo = extractOrderNoFromUrl(url, platform)
      if (urlOrderNo) {
        console.log(`[PurchaseCapture] Order found in redirect URL: ${urlOrderNo}`)
        onOrderCaptured(urlOrderNo)
      }
    })

    // 窗口关闭
    win.on('closed', () => {
      onWindowClosed()
    })

    // 加载初始URL
    // 对于淘宝/1688：如果需要设置地址，先导航到地址管理页，成功后再跳转采购URL
    // 对于其他平台：直接加载采购URL
    let initialUrl = purchaseUrl
    if (needAddrSetup && parsedAddr) {
      initialUrl = ADDRESS_MANAGE_URLS[platform] || purchaseUrl
    }
    console.log(`[PurchaseCapture] Loading initial URL: ${initialUrl.substring(0, 120)}`)

    try {
      await win.loadURL(initialUrl)
    } catch (e) {
      console.error('[PurchaseCapture] loadURL failed:', e.message)
    }

    // 地址设置结果轮询：检测地址是否添加成功，成功后跳转采购URL
    if (needAddrSetup && parsedAddr) {
      let addrCheckCount = 0
      const addrCheckTimer = setInterval(() => {
        addrCheckCount++
        if (win.isDestroyed() || resolved || addrSetDone) {
          clearInterval(addrCheckTimer)
          return
        }
        // 最多等60秒
        if (addrCheckCount > 30) {
          clearInterval(addrCheckTimer)
          console.log('[PurchaseCapture] Address setup timeout, navigating to purchase URL anyway')
          addrSetDone = true
          win.loadURL(purchaseUrl).catch(() => {})
          return
        }

        // 检测各平台的地址设置结果变量
        const checkScript = 'window.__addrManagerResult || window.__addrDialogResult || window.__tbAddrResult || null'
        win.webContents.executeJavaScript(checkScript)
          .then(result => {
            if (!result || addrSetDone) return
            console.log(`[PurchaseCapture] Address setup result: ${result}`)

            if (result === 'success' || result === 'submitted') {
              clearInterval(addrCheckTimer)
              addrSetDone = true
              // 地址设置成功，等一下让页面保存完毕，然后跳转到采购URL
              console.log(`[PurchaseCapture] Address setup done! Navigating to purchase URL in 3s...`)
              setTimeout(() => {
                if (win.isDestroyed() || resolved) return
                win.loadURL(purchaseUrl).catch(() => {})
              }, 3000)
            } else if (result === 'need_login' || result === 'need_verify') {
              // 需要登录或验证 — 不设置addrSetDone，用户完成后页面会重新导航
              // did-navigate 会再次检测并注入脚本
              console.log(`[PurchaseCapture] Address setup issue: ${result}, waiting for user to complete...`)
            } else if (result === 'no_button' || result === 'no_form') {
              // 页面异常，直接跳转采购URL
              clearInterval(addrCheckTimer)
              addrSetDone = true
              console.log(`[PurchaseCapture] Address page issue: ${result}, navigating to purchase URL`)
              win.loadURL(purchaseUrl).catch(() => {})
            }
          })
          .catch(() => {})
      }, 2000)
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
async function autoCreateAndBind(purchaseInfo, platformOrderNo, platform) {
  const { purchaseNo, salesOrderId, salesOrderNo, goodsName, sku, skuId, quantity, purchasePrice, remark, sourceUrl, purchaseType, shippingName, shippingPhone, shippingAddress } = purchaseInfo

  console.log(`[PurchaseCapture] autoCreateAndBind 开始: purchaseNo=${purchaseNo}, orderNo=${platformOrderNo}, token=${getAuthToken() ? '有效' : '无'}`)

  // 1. 创建采购单
  const createRes = await httpRequest(`${BUSINESS_SERVER}/api/purchase-orders`, {
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
}

module.exports = { registerPurchaseOrderCaptureIpc }
