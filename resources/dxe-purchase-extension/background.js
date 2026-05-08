/**
 * DXE Purchase Helper - Background Service Worker
 *
 * 职责：
 * 1. 与 Electron 主进程通信（通过本地 HTTP）
 * 2. 转发配置到 content script
 * 3. 转发 content script 捕获的数据回 Electron
 */

const LOCAL_SERVER = 'http://localhost:19527'

// ========== 扩展安装/启动时 ==========
chrome.runtime.onInstalled.addListener(() => {})

// ========== 从 Electron 拉取配置 ==========
async function fetchConfig() {
  try {
    const resp = await fetch(`${LOCAL_SERVER}/dxe/config`)
    if (resp.ok) {
      const config = await resp.json()
      if (config.purchaseNo) {
        await chrome.storage.local.set({ purchaseConfig: config })

        // 如果配置中有 Cookie 数据，自动注入到浏览器
        if (config.cookies && config.cookies.length > 0) {
          injectCookies(config.cookies)
        }
        return config
      }
    }
  } catch (e) {
    // 静默失败 — 可能 Electron 还没启动
  }
  return null
}

// ========== 注入 Cookie ==========
async function injectCookies(cookies) {
  let count = 0
  for (const ck of cookies) {
    try {
      await chrome.cookies.set({
        url: `https://${(ck.domain || '').replace(/^\./, '')}${ck.path || '/'}`,
        name: ck.name,
        value: ck.value,
        domain: ck.domain,
        path: ck.path || '/',
        secure: ck.secure !== false,
        httpOnly: ck.httpOnly || false,
        sameSite: ck.sameSite === 'no_restriction' ? 'no_restriction' : (ck.sameSite || 'lax'),
        expirationDate: ck.expirationDate || ck.expires || undefined,
      })
      count++
    } catch (e) {}
  }
}

// ========== 向 Electron 推送事件 ==========
async function notifyElectron(path, data) {
  try {
    await fetch(`${LOCAL_SERVER}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
  } catch (e) {}
}

// ========== 监听 content script 消息 ==========
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'order-captured') {
    notifyElectron('/dxe/order-captured', {
      purchaseNo: msg.purchaseNo,
      orderNo: msg.orderNo,
      amount: msg.amount
    })
    sendResponse({ ok: true })
  }

  if (msg.type === 'product-cached') {
    notifyElectron('/dxe/product-cached', {
      purchaseNo: msg.purchaseNo,
      productInfo: msg.productInfo
    })
    sendResponse({ ok: true })
  }

  if (msg.type === 'page-event') {
    notifyElectron('/dxe/page-event', {
      purchaseNo: msg.purchaseNo,
      event: msg.event,
      url: msg.url
    })
    sendResponse({ ok: true })
  }

  if (msg.type === 'request-config') {
    fetchConfig().then(config => {
      sendResponse(config)
    })
    return true  // 异步响应
  }

  if (msg.type === 'cookies-snapshot') {
    notifyElectron('/dxe/cookies-snapshot', {
      purchaseNo: msg.purchaseNo,
      cookies: msg.cookies
    })
    sendResponse({ ok: true })
  }
})

// ========== Cookie 注入消息 ==========
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'set-cookies') {
    const cookies = msg.cookies || []
    let setCount = 0
    for (const ck of cookies) {
      try {
        chrome.cookies.set({
          url: `https://${(ck.domain || '').replace(/^\./, '')}${ck.path || '/'}`,
          name: ck.name,
          value: ck.value,
          domain: ck.domain,
          path: ck.path || '/',
          secure: ck.secure || false,
          httpOnly: ck.httpOnly || false,
          sameSite: ck.sameSite === 'no_restriction' ? 'no_restriction' : (ck.sameSite || 'lax'),
          expirationDate: ck.expirationDate || ck.expires || undefined,
        })
        setCount++
      } catch (e) {}
    }
    sendResponse({ ok: true, count: setCount })
  }
})

// ========== 定时拉取配置 ==========
let configPollTimer = null
function startConfigPolling() {
  if (configPollTimer) clearInterval(configPollTimer)
  configPollTimer = setInterval(fetchConfig, 3000)
}

fetchConfig()
startConfigPolling()

// 当有 PDD 标签页加载时，推送配置到 content script
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url && tab.url.includes('yangkeduo.com')) {
    chrome.storage.local.get('purchaseConfig', (data) => {
      if (data.purchaseConfig) {
        chrome.tabs.sendMessage(tabId, {
          type: 'config-update',
          config: data.purchaseConfig
        }).catch(() => {})
      }
    })
  }
})
