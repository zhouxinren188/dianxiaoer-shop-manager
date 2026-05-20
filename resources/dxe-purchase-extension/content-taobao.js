/**
 * DXE Purchase Helper - Content Script (淘宝/天猫/支付宝页面自动化)
 *
 * 在真实 Chrome 浏览器中运行，完全绕过支付宝的 Electron 检测。
 * 所有自动化逻辑（商品信息提取、订单号捕获、Cookie保存）都在这里执行。
 *
 * 核心流程：
 * 1. 商品详情页 → 提取商品名/SKU/图片
 * 2. 结算确认页 → 提取 b2c_orid（淘宝订单号，DL系统核心方案）
 * 3. 支付宝页面 → 从 URL 提取 out_trade_no
 * 4. API 拦截 → 捕获 bizOrderId 等订单号
 * 5. Cookie 快照 → 保存登录态回服务器
 */

;(function() {
  'use strict'

  // 使用 Symbol 做标记，页面 JS 无法访问
  const INIT_MARKER = Symbol('__dxe_tb_init__')
  if (window[INIT_MARKER]) return
  window[INIT_MARKER] = true

  let config = null

  // ========== toString 伪装工具 ==========
  const _ts = Function.prototype.toString
  const _cache = new WeakMap()
  function _fn(fn, str) { _cache.set(fn, str || `function ${fn.name||''}() { [native code] }`); return fn }
  Function.prototype.toString = _fn(function() { return _cache.has(this) ? _cache.get(this) : _ts.call(this) }, 'function toString() { [native code] }')

  // 静默日志
  const _log = () => {}

  // ========== 从 background 获取配置 ==========
  function loadConfig() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'request-config' }, (resp) => {
        if (resp && resp.purchaseNo) {
          config = resp
        }
        resolve(config)
      })
    })
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'config-update' && msg.config) {
      config = msg.config
    }
  })

  function notify(type, data) {
    chrome.runtime.sendMessage({
      type,
      purchaseNo: config ? config.purchaseNo : '',
      ...data
    }).catch(() => {})
  }

  // ========== 淘宝/天猫：调用 asyncBought API 获取价格信息 ==========
  // 参照 DL 系统，提取 actualFee(订单金额)、postFee(运费)、goodsPrice(商品单价)
  function fetchOrderPriceInfo(orderNo) {
    if (!orderNo) return
    try {
      fetch('https://buyertrade.taobao.com/trade/itemlist/asyncBought.htm?action=itemlist/BoughtQueryAction&event_submit_do_query=1&_input_charset=utf8', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'buyerNick=&dateBegin=0&dateEnd=0&itemTitle=' + encodeURIComponent(orderNo) + '&lastStartRow=&logisticsService=&options=0&orderStatus=&pageNum=1&pageSize=15&queryBizType=&queryOrder=desc&rateStatus=&refund=&sellerNick=&auctionTitle=' + encodeURIComponent(orderNo) + '&prePageNo=1'
      }).then(function(r) { return r.text() }).then(function(text) {
        try {
          var data = JSON.parse(text);
          var mainOrders = data.mainOrders;
          if (!mainOrders || mainOrders.length === 0) return;
          var orderItem = mainOrders[0];
          var priceInfo = {};
          // 实付总额（订单金额）
          var actualFee = orderItem.payInfo && orderItem.payInfo.actualFee;
          if (actualFee && parseFloat(actualFee) > 0) {
            priceInfo.actualFee = parseFloat(actualFee);
          }
          // 运费
          var postFee = orderItem.payInfo && orderItem.payInfo.postFee;
          if (postFee && parseFloat(postFee) > 0) {
            priceInfo.postFee = parseFloat(postFee);
          }
          // 商品数量：兼容多种字段路径
          var subOrders = orderItem.subOrders;
          if (subOrders && subOrders.length > 0) {
            var goodsItem = subOrders[0];
            var buyNum = 0;
            // 路径1: goodsItem.quantity.count（对象形式）
            if (goodsItem.quantity && goodsItem.quantity.count) {
              buyNum = parseInt(goodsItem.quantity.count);
            }
            // 路径2: goodsItem.quantity 直接取值（和DL一致：可能是数字或字符串如"2"）
            if ((!buyNum || buyNum <= 0) && goodsItem.quantity) {
              buyNum = parseInt(goodsItem.quantity);
            }
            // 路径3: goodsItem.buyAmount
            if ((!buyNum || buyNum <= 0) && goodsItem.buyAmount) {
              buyNum = parseInt(goodsItem.buyAmount);
            }
            if (buyNum > 0) {
              priceInfo.quantity = buyNum;
            }
          }
          // 计算单价: (actualFee - postFee) / quantity
          if (priceInfo.actualFee && priceInfo.quantity && priceInfo.quantity > 0) {
            var goodsTotal = priceInfo.actualFee - (priceInfo.postFee || 0);
            if (goodsTotal > 0) {
              priceInfo.goodsPrice = Math.round((goodsTotal / priceInfo.quantity) * 100) / 100;
            }
          }
          if (priceInfo.actualFee) {
            notify('price-captured', { priceInfo: priceInfo });
          }
        } catch(e) {}
      }).catch(function(e) {});
    } catch(e) {}
  }

  // ========== 商品信息提取（淘宝/天猫商品详情页） ==========
  function extractProductInfo() {
    try {
      const info = { title: '', image: '', sku: '' }

      // 淘宝商品详情页标题
      const titleEl = document.querySelector('.ItemHeader--mainTitle--3I_6C7R, .ItemHeader--mainTitle--3I_6C7R span, [class*="mainTitle"], .tb-detail-hd a, .tb-item-title, h1[class*="title"], [data-spm="1000983"]')
        || document.querySelector('title')
      if (titleEl) {
        let title = titleEl.textContent.trim()
        // 去掉淘宝网前缀
        title = title.replace(/^(淘宝网|天猫|tmall|淘宝)[-_\s]*[-_]*\s*/, '')
        if (title) info.title = title
      }

      // 淘宝商品主图（优先SKU图）
      const imgEl = document.querySelector('.PicGallery--mainImage--1U7Xj42 img, .mainPic img, [class*="PicGallery"] img, #J_ImgBooth, .tb-booth-main img, [class*="mainPic"] img')
      if (imgEl) {
        info.image = imgEl.src || imgEl.dataset.src || ''
        // 去掉缩略图后缀，获取原图
        if (info.image) {
          info.image = info.image.replace(/_\d+x\d+\./, '.')
        }
      }

      // SKU 信息
      const skuEl = document.querySelector('[class*="skuItem"], [class*="skuItemName"], .tb-sku-item-name, [data-spm="1000985"]')
      if (skuEl) info.sku = skuEl.textContent.trim().substring(0, 100)

      if (info.title || info.image) {
        notify('product-cached', { productInfo: info })
      }
    } catch (e) {}
  }

  // ========== b2c_orid 提取（DL系统核心方案） ==========
  // 淘宝订单号在 confirm_order 页面 HTML 中以 b2c_orid=xxx 形式出现
  function extractB2cOrid() {
    try {
      const html = document.documentElement.outerHTML
      // b2c_orid 纯数字，>=10位
      const m = html.match(/b2c_orid[="'"\s:]+(\d{10,})/)
      if (m) {
        _log('[DXE-TB] b2c_orid found:', m[1])
        return m[1]
      }
    } catch (e) {}
    return null
  }

  // 从 confirm_order 页面 URL 和 DOM 提取订单号
  function extractOrderFromConfirmPage() {
    // 1. 先尝试 b2c_orid（DL系统核心，最可靠）
    const b2cOrid = extractB2cOrid()
    if (b2cOrid) {
      notify('order-captured', { orderNo: b2cOrid })
      fetchOrderPriceInfo(b2cOrid)
      return true
    }

    // 2. 从 URL 参数提取
    const url = location.href
    const urlMatch = url.match(/bizOrderId[=:]([A-Z0-9]{10,})/i)
      || url.match(/orderId[=:]([A-Z0-9]{10,})/i)
      || url.match(/out_trade_no[=:]([A-Z0-9]{10,})/i)
    if (urlMatch) {
      notify('order-captured', { orderNo: urlMatch[1] })
      fetchOrderPriceInfo(urlMatch[1])
      return true
    }

    return false
  }

  // ========== 支付宝页面订单号提取 ==========
  function extractOrderFromAlipay() {
    const url = location.href

    // out_trade_no 是商户外部订单号 = 淘宝订单号
    const outTradeMatch = url.match(/out_trade_no[=:]([A-Z0-9]{10,})/i)
    if (outTradeMatch) {
      notify('order-captured', { orderNo: outTradeMatch[1] })
      return true
    }

    // 从 URL 参数提取 bizOrderId
    const bizMatch = url.match(/bizOrderId[=:]([A-Z0-9]{10,})/i)
      || url.match(/orderId[=:]([A-Z0-9]{10,})/i)
    if (bizMatch) {
      notify('order-captured', { orderNo: bizMatch[1] })
      return true
    }

    // 从页面 DOM 提取
    try {
      // 支付宝收银台页面可能有订单号显示
      const orderEls = document.querySelectorAll('[class*="orderNo"], [class*="tradeNo"], .trade-no, .order-no')
      for (const el of orderEls) {
        const text = el.textContent.trim()
        const m = text.match(/\d{15,20}/)
        if (m) {
          notify('order-captured', { orderNo: m[0] })
          return true
        }
      }
    } catch (e) {}

    return false
  }

  // ========== API 响应拦截（订单号捕获） ==========
  function interceptAPIResponses() {
    // Fetch 拦截
    const origFetch = window.fetch
    window.fetch = _fn(function(...args) {
      return origFetch.apply(this, args).then(resp => {
        try {
          const url = args[0] || ''
          // 淘宝订单提交/确认接口
          if (url.includes('confirm_order') || url.includes('order/confirm') ||
              url.includes('submitOrder') || url.includes('buy.taobao.com') ||
              url.includes('asyncBought') || url.includes('order_result')) {
            resp.clone().text().then(body => {
              // b2c_orid（DL系统核心）
              let m = body.match(/b2c_orid["\s:=]+(\d{10,})/)
              if (m) { notify('order-captured', { orderNo: m[1] }); fetchOrderPriceInfo(m[1]); return }

              // bizOrderId（淘宝提交订单API常见返回字段，>=15位纯数字）
              m = body.match(/bizOrderId["\s:=]+(\d{15,})/)
              if (m) { notify('order-captured', { orderNo: m[1] }); fetchOrderPriceInfo(m[1]); return }

              // orderId（>=15位纯数字）
              m = body.match(/"orderId"\s*:\s*"(\d{15,})"/)
              if (m) { notify('order-captured', { orderNo: m[0] }); fetchOrderPriceInfo(m[0]); return }
            }).catch(() => {})
          }
        } catch (e) {}
        return resp
      })
    }, 'function fetch() { [native code] }')

    // XHR 拦截
    const origXHROpen = XMLHttpRequest.prototype.open
    const origXHRSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = _fn(function(method, url, ...rest) {
      this.__dxeUrl = url
      return origXHROpen.call(this, method, url, ...rest)
    }, 'function open() { [native code] }')

    XMLHttpRequest.prototype.send = _fn(function(...args) {
      this.addEventListener('load', function() {
        try {
          const url = this.__dxeUrl || ''
          if (url.includes('confirm_order') || url.includes('order/confirm') ||
              url.includes('submitOrder') || url.includes('asyncBought')) {
            const body = this.responseText || ''
            let m = body.match(/b2c_orid["\s:=]+(\d{10,})/)
            if (m) { notify('order-captured', { orderNo: m[1] }); fetchOrderPriceInfo(m[1]); return }
            m = body.match(/bizOrderId["\s:=]+(\d{15,})/)
            if (m) { notify('order-captured', { orderNo: m[1] }); fetchOrderPriceInfo(m[1]); return }
          }
        } catch (e) {}
      })
      return origXHRSend.apply(this, args)
    }, 'function send() { [native code] }')
  }

  // ========== 结算页地址辅助 ==========
  function handleCheckoutPage() {
    if (!config || !config.shippingName) return

    setTimeout(() => {
      // 尝试点击"使用新地址"或展开地址列表
      const expandBtn = document.querySelector('[class*="addAddr"], [class*="useNewAddr"], a[class*="add"]')
      if (expandBtn) expandBtn.click()

      // 尝试选择匹配的地址
      setTimeout(selectMatchingAddress, 1500)
    }, 2000)
  }

  function selectMatchingAddress() {
    if (!config) return
    const targetName = config.shippingName || ''
    const targetPhone = config.shippingPhone || ''
    const addrItems = document.querySelectorAll('[class*="addrItem"], [class*="address-item"], .addr-item, [class*="receiverItem"], li[class*="address"]')
    for (const item of addrItems) {
      const text = item.textContent || ''
      if (text.includes(targetName) && text.includes(targetPhone)) {
        item.click()
        return
      }
    }
  }

  // ========== Cookie 快照保存 ==========
  function saveCookieSnapshot() {
    const domains = ['.taobao.com', '.tmall.com', '.alipay.com']
    let totalCookies = []
    let pending = domains.length

    domains.forEach(domain => {
      chrome.cookies.getAll({ domain }, (cookies) => {
        if (cookies && cookies.length > 0) {
          totalCookies = totalCookies.concat(cookies)
        }
        pending--
        if (pending === 0 && totalCookies.length > 0) {
          notify('cookies-snapshot', { cookies: totalCookies })
        }
      })
    })
  }

  // ========== 页面路由处理 ==========
  function handlePage() {
    notify('page-event', { event: 'page-load', url: location.href })

    const url = location.href.toLowerCase()

    // ═══ 商品详情页 ═══
    if (url.includes('item.taobao.com') || url.includes('detail.tmall.com') || url.includes('detail.tmall.hk')) {
      setTimeout(extractProductInfo, 2000)
      setTimeout(extractProductInfo, 5000)
    }

    // ═══ 结算确认页 ═══
    if (url.includes('buy.taobao.com/auction/confirm_order') ||
        url.includes('buy.taobao.com/auction/order/confirm') ||
        url.includes('buy.tmall.com')) {
      handleCheckoutPage()
      // 提取 b2c_orid（可能页面加载后才出现）
      setTimeout(() => {
        extractOrderFromConfirmPage()
      }, 3000)
      // 持续监听 b2c_orid（DOM可能延迟渲染）
      let oridTries = 0
      const oridTimer = setInterval(() => {
        oridTries++
        if (extractB2cOrid()) {
          notify('order-captured', { orderNo: extractB2cOrid() })
          fetchOrderPriceInfo(extractB2cOrid())
          clearInterval(oridTimer)
        }
        if (oridTries >= 20) clearInterval(oridTimer)
      }, 1000)
    }

    // ═══ 支付宝页面 ═══
    if (url.includes('alipay.com')) {
      extractOrderFromAlipay()
      setTimeout(extractOrderFromAlipay, 2000)
      setTimeout(extractOrderFromAlipay, 5000)
    }

    // ═══ 订单结果页 ═══
    if (url.includes('trade.taobao.com') || url.includes('buyertrade.taobao.com')) {
      captureOrderFromUrl()
      setTimeout(captureOrderFromUrl, 2000)
    }

    // Cookie 快照
    setTimeout(saveCookieSnapshot, 5000)
  }

  function captureOrderFromUrl() {
    const url = location.href
    const orderMatch = url.match(/bizOrderId[=:]([A-Z0-9]{10,})/i)
      || url.match(/orderId[=:]([A-Z0-9]{10,})/i)
    if (orderMatch) {
      notify('order-captured', { orderNo: orderMatch[1] })
      fetchOrderPriceInfo(orderMatch[1])
      return true
    }
    return false
  }

  // ========== 初始化 ==========
  async function init() {
    await loadConfig()
    interceptAPIResponses()

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', handlePage)
    } else {
      handlePage()
    }

    // SPA 导航检测
    let lastUrl = location.href
    setInterval(() => {
      const currentUrl = location.href
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl
        handlePage()
      }
    }, 500)
  }

  init()
})()
