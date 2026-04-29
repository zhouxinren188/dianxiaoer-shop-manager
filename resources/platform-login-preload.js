const { ipcRenderer } = require('electron')

let lastAccount = ''
let lastPassword = ''
let sentSuccess = false

function isLoginUrl(url) {
  const lower = url.toLowerCase()
  return lower.includes('login') || lower.includes('passport') || lower.includes('signin')
}

function isBackendUrl(url) {
  const lower = url.toLowerCase()
  if (lower.includes('shop.jd.com')) return !isLoginUrl(lower)
  if (lower.includes('myseller.taobao.com')) return true
  if (lower.includes('mms.pinduoduo.com')) return !lower.includes('login')
  if (lower.includes('fxg.jinritemai.com')) return !lower.includes('login')
  return false
}

function sendCredentials() {
  if (!lastAccount) return
  ipcRenderer.send('platform-login-credentials', {
    account: lastAccount,
    password: lastPassword
  })
}

function checkLoginSuccess() {
  if (sentSuccess) return false
  const currentUrl = window.location.href
  if (!isLoginUrl(currentUrl) && isBackendUrl(currentUrl)) {
    sentSuccess = true
    sendCredentials()
    ipcRenderer.send('platform-auto-login-success', {
      account: lastAccount,
      password: lastPassword,
      url: currentUrl
    })
    return true
  }
  return false
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

function isLoginButton(el) {
  if (!el) return false
  const tag = el.tagName
  const btnText = (el.innerText || el.textContent || el.value || '').trim().toLowerCase()
  const cls = (el.className || '').toLowerCase()
  const id = (el.id || '').toLowerCase()

  if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT') {
    if (btnText.includes('登录') || btnText.includes('登') || btnText.includes('login') ||
      btnText.includes('submit') || btnText.includes('确定') ||
      id.includes('login') || id.includes('submit') ||
      cls.includes('login') || cls.includes('submit')) {
      return true
    }
  }
  return false
}

function init() {
  // 实时监听输入事件
  document.addEventListener('input', (e) => {
    if (sentSuccess) return
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

  // 监听登录按钮点击
  document.addEventListener('click', (e) => {
    if (sentSuccess || !lastAccount) return
    if (isLoginButton(e.target) || isLoginButton(e.target.closest('button, a, input'))) {
      sendCredentials()
    }
  }, true)

  // 监听表单提交
  document.addEventListener('submit', () => {
    if (!sentSuccess && lastAccount) {
      sendCredentials()
    }
  }, true)

  // 定期检测是否登录成功
  const successInterval = setInterval(() => {
    if (checkLoginSuccess()) {
      clearInterval(successInterval)
    }
  }, 1500)

  // 监听 URL 变化（SPA）
  let lastUrl = location.href
  new MutationObserver(() => {
    const currentUrl = location.href
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl
      checkLoginSuccess()
    }
  }).observe(document, { subtree: true, childList: true })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}
