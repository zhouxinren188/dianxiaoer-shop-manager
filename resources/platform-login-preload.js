const { ipcRenderer } = require('electron')

// preload 负责：
// 1. 捕获用户输入的账号密码，发送给主进程
// 2. 接收主进程的自动填充指令，填充登录表单
// 3. 在后台页面提取商家信息，发送给主进程

let lastAccount = ''
let lastPassword = ''

const ACCOUNT_INPUT_TYPES = new Set(['', 'text', 'tel', 'email'])
const APP_TITLEBAR_ID = 'dxe-platform-titlebar'
const APP_TITLEBAR_SPACER_ID = 'dxe-platform-titlebar-spacer'
const CUSTOM_TITLEBAR_ENABLED = process.argv.includes('--dxe-custom-platform-titlebar=1')
let credentialFillObserver = null
let credentialFillTimers = []

function isCredentialCapturePage() {
  const url = String(window.location.href || '').toLowerCase()
  return url.includes('login') || url.includes('passport') || url.includes('signin') || url.includes('sign-in')
}

function sendCredentials() {
  if (!lastAccount) return
  ipcRenderer.send('platform-login-credentials', {
    account: lastAccount,
    password: lastPassword
  })
}

function isAccountInput(el) {
  if (!el || el.tagName !== 'INPUT') return false
  const type = String(el.getAttribute('type') || el.type || '').toLowerCase()
  // 京东旧版登录按钮也是 input（type=button），且 class 中带 login。
  // 账号只能写入真正可编辑的文本框，不能仅凭 class 模糊匹配。
  if (!ACCOUNT_INPUT_TYPES.has(type) || el.disabled || el.readOnly) return false

  const name = String(el.name || '').toLowerCase()
  const id = String(el.id || '').toLowerCase()
  const placeholder = String(el.placeholder || '').toLowerCase()
  const cls = String(el.className || '').toLowerCase()
  const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase()

  const verificationMarker = `${name} ${id} ${placeholder} ${cls}`
  if (/(captcha|verify|verification|sms|code|otp|验证码|短信)/.test(verificationMarker)) return false

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
  if (String(el.type || '').toLowerCase() !== 'password' || el.disabled || el.readOnly) return false
  const marker = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`.toLowerCase()
  return !/(verify|captcha|code|otp|验证码|短信)/.test(marker)
}

function isVisibleInput(el) {
  if (!el || !el.isConnected) return false
  const style = window.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function inputMarker(el) {
  return `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.className || ''} ${el.getAttribute('autocomplete') || ''}`.toLowerCase()
}

function accountInputScore(el) {
  const marker = inputMarker(el)
  let score = 0
  if (/(username|loginname|login_name|user-name|account)/.test(marker)) score += 60
  if (/(phone|mobile|email|uname)/.test(marker)) score += 35
  if (/(账号|用户名|手机号|邮箱|会员名|登录名)/.test(marker)) score += 50
  if ((el.getAttribute('autocomplete') || '').toLowerCase() === 'username') score += 80
  if (isVisibleInput(el)) score += 20
  return score
}

function findBestInput(predicate, score) {
  const candidates = Array.from(document.querySelectorAll('input')).filter(predicate)
  if (!candidates.length) return null
  const visibleCandidates = candidates.filter(isVisibleInput)
  const pool = visibleCandidates.length ? visibleCandidates : candidates
  pool.sort((a, b) => score(b) - score(a))
  return pool[0]
}

function findBestAccountInput() {
  return findBestInput(isAccountInput, accountInputScore)
}

function findBestPasswordInput() {
  return findBestInput(isPasswordInput, el => isVisibleInput(el) ? 20 : 0)
}

function fillPasswordField(password) {
  if (!password) return false
  const passwordInput = findBestPasswordInput()
  if (!passwordInput) return false
  return setInputValue(passwordInput, password)
}

// 自动填充登录表单。账号触发 input 后，京东登录页可能重新渲染密码框，
// 因此密码必须重新查询 DOM 并进行短间隔补填。
function fillLoginForm(account, password) {
  const result = {
    accountProvided: !!account,
    passwordProvided: !!password,
    accountFound: false,
    passwordFound: false,
    accountFilled: !account,
    passwordFilled: !password
  }
  if (!isCredentialCapturePage()) return result

  if (account) {
    const accountInput = findBestAccountInput()
    result.accountFound = !!accountInput
    if (accountInput) result.accountFilled = setInputValue(accountInput, account)
  }

  const passwordInput = password ? findBestPasswordInput() : null
  result.passwordFound = !!passwordInput
  if (passwordInput) result.passwordFilled = setInputValue(passwordInput, password)
  return result
}

function scheduleCredentialFill(account, password) {
  credentialFillTimers.forEach(timer => clearTimeout(timer))
  credentialFillTimers = []
  if (credentialFillObserver) credentialFillObserver.disconnect()
  credentialFillObserver = null

  let latestResult = null
  const attemptFill = () => {
    latestResult = fillLoginForm(account, password)
    if (latestResult?.accountFilled && latestResult?.passwordFilled && credentialFillObserver) {
      credentialFillObserver.disconnect()
      credentialFillObserver = null
    }
    return latestResult
  }

  // 京东登录页会在账号写入后重建密码框，并且网络慢时表单可能晚于
  // DOMContentLoaded 数秒才出现，因此既做定时补填，也监听表单节点变化。
  ;[0, 150, 500, 1200, 2500, 4500].forEach(delay => {
    credentialFillTimers.push(setTimeout(attemptFill, delay))
  })

  if (document.body && window.MutationObserver) {
    credentialFillObserver = new MutationObserver(() => attemptFill())
    credentialFillObserver.observe(document.body, { childList: true, subtree: true })
  }

  credentialFillTimers.push(setTimeout(() => {
    if (credentialFillObserver) credentialFillObserver.disconnect()
    credentialFillObserver = null
    const result = latestResult || attemptFill()
    ipcRenderer.send('platform-login-fill-result', result)
  }, 6000))
}

// 模拟用户输入（触发 React/Vue 的事件绑定）
function setInputValue(el, value) {
  if (!el || el.tagName !== 'INPUT') return false
  if (el.value === value) return true
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
  const nativeInputValueSetter = descriptor && descriptor.set
  if (!nativeInputValueSetter) return false
  nativeInputValueSetter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

function installAppTitlebar() {
  // resources 文件可能先于主进程更新。只有创建窗口的主进程明确声明使用
  // 隐藏式标题栏时才注入，避免旧主进程的系统标题栏与自定义栏叠成两层。
  if (!CUSTOM_TITLEBAR_ENABLED || !document.body || document.getElementById(APP_TITLEBAR_ID)) return

  const hostname = String(window.location.hostname || '').toLowerCase()
  let platformTitle = '平台安全登录'
  if (hostname.includes('jd.com')) platformTitle = '京东官方安全登录'
  else if (hostname.includes('taobao.com') || hostname.includes('tmall.com')) platformTitle = '淘宝/天猫安全登录'
  else if (hostname.includes('pinduoduo.com') || hostname.includes('yangkeduo.com')) platformTitle = '拼多多安全登录'

  const style = document.createElement('style')
  style.textContent = `
    #${APP_TITLEBAR_ID} {
      position: fixed;
      z-index: 2147483647;
      top: 0;
      left: 0;
      right: 0;
      height: 43px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 150px 0 14px;
      color: #fff;
      background: linear-gradient(90deg, #062f52 0%, #0b4776 100%);
      box-shadow: 0 1px 6px rgba(0, 24, 48, .22);
      font-family: "Microsoft YaHei", "Segoe UI", sans-serif;
      font-size: 13px;
      line-height: 43px;
      user-select: none;
      -webkit-app-region: drag;
    }
    #${APP_TITLEBAR_ID} .dxe-titlebar-logo {
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 7px;
      color: #0b4776;
      background: #fff;
      font-size: 12px;
      font-weight: 700;
      line-height: 24px;
    }
    #${APP_TITLEBAR_ID} .dxe-titlebar-name { font-weight: 600; }
    #${APP_TITLEBAR_ID} .dxe-titlebar-subtitle { color: rgba(255, 255, 255, .72); }
    #${APP_TITLEBAR_SPACER_ID} {
      display: block !important;
      position: relative !important;
      width: 100% !important;
      height: 43px !important;
      min-height: 43px !important;
      flex: 0 0 43px !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `
  document.head.appendChild(style)

  // 固定标题栏不能直接压在京东网页上方。插入一个参与正常布局的占位块，
  // 让账号框和页面工具条从标题栏下方开始显示。
  const spacer = document.createElement('div')
  spacer.id = APP_TITLEBAR_SPACER_ID
  spacer.setAttribute('aria-hidden', 'true')
  document.body.prepend(spacer)

  const titlebar = document.createElement('div')
  titlebar.id = APP_TITLEBAR_ID
  titlebar.setAttribute('role', 'banner')
  titlebar.innerHTML = `
    <span class="dxe-titlebar-logo">店</span>
    <span class="dxe-titlebar-name">店小二网店管家</span>
    <span class="dxe-titlebar-subtitle">${platformTitle}</span>
  `
  document.body.appendChild(titlebar)
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
  installAppTitlebar()

  // 实时监听输入事件
  document.addEventListener('input', (e) => {
    if (!isCredentialCapturePage()) return
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
    if (!isCredentialCapturePage()) return
    if (lastAccount) sendCredentials()
  }, true)

  // 监听主进程发来的自动填充指令
  ipcRenderer.on('fill-credentials', (event, { account, password }) => {
    scheduleCredentialFill(account || '', password || '')
  })
  // 主进程 did-finish-load 可能早于页面脚本注册监听器。由 preload 在自身
  // 就绪后主动请求一次，避免凭据消息在首次打开窗口时丢失。
  ipcRenderer.send('platform-login-ready')

  // 延迟提取商家信息（等页面渲染完成）
  setTimeout(extractAndSendStoreInfo, 3000)
  setTimeout(extractAndSendStoreInfo, 6000)

  // 监听页面导航，当跳转到后台页面时重新提取商家信息
  let navigationCount = 0
  const maxNavigations = 5 // 最多监听 5 次导航
  const navCheckInterval = 2000 // 每次导航后等待 2 秒再提取

  window.addEventListener('popstate', handleNavigation)
  window.addEventListener('hashchange', handleNavigation)

  // 监听所有链接点击
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a')
    if (link && link.href) {
      // 延迟检查，等待导航完成
      setTimeout(() => {
        navigationCount++
        if (navigationCount <= maxNavigations) {
          handleNavigation()
        }
      }, 1500)
    }
  }, true)

  // 使用 PerformanceObserver 监听页面导航
  if (window.PerformanceObserver) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.type === 'navigate' || entry.type === 'reload') {
            navigationCount++
            if (navigationCount <= maxNavigations) {
              setTimeout(handleNavigation, navCheckInterval)
            }
          }
        }
      })
      observer.observe({ entryTypes: ['navigation'] })
    } catch (e) {
      // PerformanceObserver 不可用时静默失败
    }
  }

  function handleNavigation() {
    // 检查是否导航到了后台页面
    if (isBackendPage()) {
      console.log('[Preload] 检测到后台页面导航，重新提取商家信息')
      // 延迟提取，等待页面完全加载
      setTimeout(extractAndSendStoreInfo, 2000)
      setTimeout(extractAndSendStoreInfo, 5000)
      setTimeout(extractAndSendStoreInfo, 8000)
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
