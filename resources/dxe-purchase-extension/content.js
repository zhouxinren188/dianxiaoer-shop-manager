/**
 * DXE Purchase Helper - Content Script (拼多多页面自动化)
 *
 * 在真实 Chrome 浏览器中运行，无需 CDP
 * 所有自动化逻辑（登录填充、地址选择、订单捕获）都在这里执行
 *
 * 注意：此脚本运行在 document_idle，stealth.js 已在 document_start 注入反检测代码
 */

;(function() {
  'use strict'

  // 使用 Symbol 做标记，页面 JS 无法访问（Symbol 在不同 realm 中不共享）
  const INIT_MARKER = Symbol('__dxe_init__')
  if (window[INIT_MARKER]) return
  window[INIT_MARKER] = true

  let config = null

  // ========== toString 伪装工具 ==========
  const _ts = Function.prototype.toString
  const _cache = new WeakMap()
  function _fn(fn, str) { _cache.set(fn, str || `function ${fn.name||''}() { [native code] }`); return fn }
  Function.prototype.toString = _fn(function() { return _cache.has(this) ? _cache.get(this) : _ts.call(this) }, 'function toString() { [native code] }')

  // 静默日志（不输出到 console，避免被检测）
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

  // ========== 登录页自动填充 ==========
  function handleLoginPage() {
    if (!config || !config.accountName) return

    const inputs = document.querySelectorAll('input[type="tel"], input[placeholder*="手机"], input[placeholder*="号码"]')
    for (const input of inputs) {
      if (!input.value) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, config.accountName)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }

    let lastUrl = location.href
    const checkInterval = setInterval(() => {
      const currentUrl = location.href
      if (currentUrl !== lastUrl && !currentUrl.includes('login.html')) {
        clearInterval(checkInterval)
        location.href = 'https://mobile.yangkeduo.com/personal.html'
      }
    }, 500)
    setTimeout(() => clearInterval(checkInterval), 30000)
  }

  // ========== 商品信息提取 ==========
  function extractProductInfo() {
    try {
      const info = { title: '', image: '', sku: '' }
      const titleEl = document.querySelector('.goods-name, .item-name, [class*="title"]')
      if (titleEl) info.title = titleEl.textContent.trim()
      const imgEl = document.querySelector('.goods-img img, .item-img img, [class*="goods"] img')
      if (imgEl) info.image = imgEl.src || ''
      const skuEl = document.querySelector('[class*="sku"], [class*="spec"]')
      if (skuEl) info.sku = skuEl.textContent.trim().substring(0, 100)
      if (info.title || info.image) {
        notify('product-cached', { productInfo: info })
      }
    } catch (e) {}
  }

  // ========== 结算页地址选择 ==========
  function handleCheckoutPage() {
    if (!config || !config.shippingName) return

    setTimeout(() => {
      const addrInfo = document.querySelector('.oc-address-info')
        || document.querySelector('.oc-address')
        || document.querySelector('[class*="address-info"]')
      if (addrInfo) {
        addrInfo.click()
      }
      setTimeout(() => selectMatchingAddress(), 1500)
    }, 2000)
  }

  function selectMatchingAddress() {
    if (!config) return
    const targetName = config.shippingName || ''
    const targetPhone = config.shippingPhone || ''
    const listItems = document.querySelectorAll('li, [class*="address-item"], [class*="addr-item"]')
    for (const item of listItems) {
      const text = item.textContent || ''
      if (text.includes(targetName) && text.includes(targetPhone)) {
        item.click()
        return
      }
    }
  }

  // ========== 地址管理页自动填充 ==========
  function handleAddressesPage() {
    if (!config || !config.shippingAddress) return

    setTimeout(() => {
      const addBtn = document.querySelector('.m-addr-add, [class*="add-addr"], button')
      if (addBtn && addBtn.textContent.includes('新增')) {
        addBtn.click()
      }
      setTimeout(() => fillAddressForm(), 1000)
    }, 1500)
  }

  function fillAddressForm() {
    if (!config) return
    const { shippingName, shippingPhone, shippingAddress } = config
    const addrParts = parseAddress(shippingAddress)
    fillInput('[name="name"], [placeholder*="姓名"]', shippingName)
    fillInput('[name="phone"], [placeholder*="手机"], [type="tel"]', shippingPhone)
    if (addrParts) selectRegion(addrParts)
    fillInput('[name="address"], [placeholder*="详细"], textarea', addrParts ? addrParts.other : shippingAddress)
  }

  function fillInput(selector, value) {
    if (!value) return
    const el = document.querySelector(selector)
    if (el) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }

  function parseAddress(address) {
    if (!address) return null
    const match = address.match(/^(.+?省)(.+?市)(.+?[区县市])(.+)$/)
    if (match) return { province: match[1], city: match[2], area: match[3], other: match[4] }
    return null
  }

  function selectRegion(addrParts) {
    const regionSelector = document.querySelector('.m-addr-select, [class*="region"], [class*="area-select"]')
    if (regionSelector) regionSelector.click()
    setTimeout(() => pollAndSelect('#region-selector-list-1', addrParts.province, () => {
      setTimeout(() => pollAndSelect('#region-selector-list-2', addrParts.city, () => {
        setTimeout(() => pollAndSelect('#region-selector-list-3', addrParts.area), 300)
      }), 300)
    }), 500)
  }

  function pollAndSelect(listSelector, targetName, onSelected) {
    if (!targetName) return
    let tries = 0
    const timer = setInterval(() => {
      tries++
      const list = document.querySelectorAll(listSelector + ' li')
      if (list.length > 0) {
        clearInterval(timer)
        for (const item of list) {
          if (item.textContent.includes(targetName) || targetName.includes(item.textContent.trim())) {
            item.click()
            if (onSelected) setTimeout(onSelected, 300)
            return
          }
        }
        clearInterval(timer)
      }
      if (tries >= 30) clearInterval(timer)
    }, 200)
  }

  // ========== 排队页自动重载 ==========
  function handleQueuePage() {
    const bodyText = document.body ? document.body.innerText : ''
    if (bodyText.includes('排队') || bodyText.includes('重新加载')) {
      const btns = document.querySelectorAll('button')
      for (const btn of btns) {
        if (btn.textContent.includes('重新加载') || btn.textContent.includes('加载')) {
          btn.click()
          return
        }
      }
      location.reload()
    }
  }

  // ========== 订单号捕获（URL + API 拦截） ==========
  function captureOrderFromUrl() {
    const url = location.href
    const orderMatch = url.match(/order_sn[=:]([A-Z0-9]{10,})/i)
      || url.match(/order_no[=:]([A-Z0-9]{10,})/i)
      || url.match(/tradeNo[=:]([A-Z0-9]{10,})/i)
    if (orderMatch) {
      notify('order-captured', { orderNo: orderMatch[1] })
      return true
    }
    return false
  }

  // API 响应拦截（带 toString 伪装）
  function interceptAPIResponses() {
    const origFetch = window.fetch
    window.fetch = _fn(function(...args) {
      return origFetch.apply(this, args).then(resp => {
        try {
          const url = args[0] || ''
          if (url.includes('order') || url.includes('checkout') || url.includes('trade')) {
            resp.clone().text().then(body => {
              const m = body.match(/order_sn["\s:=]+([A-Z0-9]{10,})/i)
                || body.match(/order_no["\s:=]+([A-Z0-9]{10,})/i)
                || body.match(/trade_no["\s:=]+([A-Z0-9]{10,})/i)
              if (m) notify('order-captured', { orderNo: m[1] })
            }).catch(() => {})
          }
        } catch (e) {}
        return resp
      })
    }, 'function fetch() { [native code] }')

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
          if (url.includes('order') || url.includes('checkout') || url.includes('trade')) {
            const body = this.responseText || ''
            const m = body.match(/order_sn["\s:=]+([A-Z0-9]{10,})/i)
              || body.match(/order_no["\s:=]+([A-Z0-9]{10,})/i)
              || body.match(/trade_no["\s:=]+([A-Z0-9]{10,})/i)
            if (m) notify('order-captured', { orderNo: m[1] })
          }
        } catch (e) {}
      })
      return origXHRSend.apply(this, args)
    }, 'function send() { [native code] }')
  }

  // ========== 保存 Cookie 快照 ==========
  function saveCookieSnapshot() {
    chrome.cookies.getAll({ domain: '.yangkeduo.com' }, (cookies) => {
      if (cookies && cookies.length > 0) {
        notify('cookies-snapshot', { cookies })
      }
    })
  }

  // ========== 页面路由处理 ==========
  function handlePage() {
    notify('page-event', { event: 'page-load', url: location.href })

    // 排队页检测
    setTimeout(handleQueuePage, 2000)

    const url = location.href.toLowerCase()

    if (url.includes('yangkeduo.com/login')) {
      handleLoginPage()
      return
    }
    if (url.includes('order_checkout') || url.includes('order-checkout')) {
      handleCheckoutPage()
    }
    if (url.includes('yangkeduo.com/addresses')) {
      handleAddressesPage()
    }
    if (url.includes('yangkeduo.com/goods') || url.includes('yangkeduo.com/product')) {
      setTimeout(extractProductInfo, 2000)
      setTimeout(extractProductInfo, 5000)
    }
    if (url.includes('pay') || url.includes('order_result') || url.includes('cashier')) {
      captureOrderFromUrl()
      setTimeout(captureOrderFromUrl, 2000)
    }

    setTimeout(saveCookieSnapshot, 5000)
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
