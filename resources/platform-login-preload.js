const { ipcRenderer } = require('electron')

// preload 负责：
// 1. 捕获用户输入的账号密码，发送给主进程
// 2. 接收主进程的自动填充指令，填充登录表单
// 3. 在后台页面提取商家信息，发送给主进程

let lastAccount = ''
let lastPassword = ''

function sendCredentials() {
  if (!lastAccount) return
  ipcRenderer.send('platform-login-credentials', {
    account: lastAccount,
    password: lastPassword
  })
}

function isAccountInput(el) {
  if (!el || el.tagName !== 'INPUT') return false
  const type = (el.type || '').toLowerCase()
  if (type === 'password' || type === 'hidden' || type === 'submit') return false

  const name = (el.name || '').toLowerCase()
  const id = (el.id || '').toLowerCase()
  const placeholder = (el.placeholder || '').toLowerCase()
  const cls = (el.className || '').toLowerCase()
  const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase()

  return name.includes('login') || name.includes('user') || name.includes('account') ||
    name.includes('phone') || name.includes('mobile') || name.includes('uname') ||
    id.includes('login') || id.includes('user') || id.includes('account') ||
    id.includes('phone') || id.includes('mobile') || id.includes('uname') ||
    placeholder.includes('账号') || placeholder.includes('用户名') ||
    placeholder.includes('手机号') || placeholder.includes('邮箱') || placeholder.includes('会员名') ||
    placeholder.includes('登录名') ||
    cls.includes('login') || cls.includes('user') || cls.includes('account') ||
    autocomplete.includes('username') || autocomplete.includes('email')
}

function isPasswordInput(el) {
  if (!el || el.tagName !== 'INPUT') return false
  if (el.type !== 'password') return false
  const name = (el.name || '').toLowerCase()
  return !name.includes('verify') && !name.includes('captcha') && !name.includes('code')
}

// 自动填充登录表单
function fillLoginForm(account, password) {
  const inputs = document.querySelectorAll('input')
  inputs.forEach(el => {
    if (account && isAccountInput(el)) {
      setInputValue(el, account)
    }
    if (password && isPasswordInput(el)) {
      setInputValue(el, password)
    }
  })
}

// 模拟用户输入（触发 React/Vue 的事件绑定）
function setInputValue(el, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set
  nativeInputValueSetter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

// 检测是否在后台页面（非登录页）
function isBackendPage() {
  const url = window.location.href
  if (url.includes('passport') || url.includes('login')) return false
  return url.includes('shop.jd.com') || url.includes('sz.jd.com') || url.includes('jd.com/index')
}

// 从页面 DOM 提取商家信息并发送给主进程
function extractAndSendStoreInfo() {
  if (!isBackendPage()) return

  const info = {}

  // 1. 从 DOM 提取店铺名称
  const nameSelectors = [
    '.shop-name', '.store-name', '.shopName', '.J_shopName',
    '[class*="shopName"]', '[class*="shop-name"]',
    '.header .name', '.nav-shop-name'
  ]
  for (const sel of nameSelectors) {
    try {
      const el = document.querySelector(sel)
      if (el && el.textContent && el.textContent.trim().length > 1) {
        info.storeName = el.textContent.trim()
        break
      }
    } catch (e) { /* ignore */ }
  }

  // 2. 如果 DOM 没找到店铺名，尝试从 document.title 提取
  if (!info.storeName && document.title) {
    const title = document.title
    if (!title.includes('登录') && !title.toLowerCase().includes('login')) {
      const filterWords = ['首页', '京麦', '京东', '后台', 'JD', '商家后台', 'shop', 'loading', 'index']
      const parts = title.split(/[-_|–—]/).map(s => s.trim())
      for (const part of parts) {
        if (part && part.length > 1 && part.length < 30 &&
            !filterWords.some(w => part.toLowerCase() === w.toLowerCase())) {
          info.storeName = part
          break
        }
      }
    }
  }

  // 3. 扫描页面内嵌 <script> 标签（配对优先：同一块包含 venderId+shopId）
  try {
    const scripts = document.querySelectorAll('script:not([src])')
    // 第一轮：找同时包含 venderId 和 shopId 的脚本块
    for (const script of scripts) {
      const txt = script.textContent || ''
      if (txt.length < 20 || txt.length > 500000) continue
      const vm = txt.match(/venderId['":\s=]+(\d{5,})/)
      const sm = txt.match(/shopId['":\s=]+(\d{5,})/)
      if (vm && sm) {
        info.venderId = vm[1]
        info.shopId = sm[1]
        break
      }
    }
    // 第二轮降级：单独提取缺失的
    if (!info.venderId || !info.shopId) {
      for (const script of scripts) {
        const txt = script.textContent || ''
        if (txt.length < 20 || txt.length > 500000) continue
        if (!info.venderId) {
          const vm = txt.match(/venderId['":\s=]+(\d{5,})/)
          if (vm) info.venderId = vm[1]
        }
        if (!info.shopId) {
          const sm = txt.match(/shopId['":\s=]+(\d{5,})/)
          if (sm) info.shopId = sm[1]
        }
        if (info.venderId && info.shopId) break
      }
    }
  } catch (e) { /* ignore */ }

  // 4. 从 URL 参数提取
  try {
    const urlParams = new URLSearchParams(window.location.search)
    if (!info.venderId) {
      const uv = urlParams.get('venderId') || urlParams.get('venderid') || urlParams.get('vender_id')
      if (uv) info.venderId = uv
    }
    if (!info.shopId) {
      const us = urlParams.get('shopId') || urlParams.get('shopid') || urlParams.get('shop_id')
      if (us) info.shopId = us
    }
  } catch (e) { /* ignore */ }

  if (Object.keys(info).length > 0) {
    ipcRenderer.send('platform-store-info', info)
  }
}

function init() {
  // 实时监听输入事件
  document.addEventListener('input', (e) => {
    const target = e.target
    if (isAccountInput(target)) {
      lastAccount = target.value || ''
      sendCredentials()
    }
    if (isPasswordInput(target)) {
      lastPassword = target.value || ''
      sendCredentials()
    }
  }, true)

  // 监听表单提交时也发送一次
  document.addEventListener('submit', () => {
    if (lastAccount) sendCredentials()
  }, true)

  // 监听主进程发来的自动填充指令
  ipcRenderer.on('fill-credentials', (event, { account, password }) => {
    // 延迟执行，等页面 DOM 加载完成
    setTimeout(() => fillLoginForm(account, password), 1000)
    setTimeout(() => fillLoginForm(account, password), 2500)
  })

  // 延迟提取商家信息（等页面渲染完成）
  setTimeout(extractAndSendStoreInfo, 3000)
  setTimeout(extractAndSendStoreInfo, 6000)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
