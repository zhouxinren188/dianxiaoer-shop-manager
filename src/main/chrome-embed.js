/**
 * chrome-embed.js - 真实 Chrome 浏览器内嵌模块
 *
 * 通过 Playwright 启动真实 Chrome，然后用 Win32 SetParent API
 * 将 Chrome 窗口嵌入到 Electron 窗口内部，实现真正的内嵌效果。
 * 和 dl（CEF 内嵌 Chromium）的视觉效果一致。
 */

const { chromium } = require('playwright')
const koffi = require('koffi')

// ========== Win32 API 定义（koffi v2 语法） ==========
const user32 = koffi.load('user32.dll')

// 定义 HWND 不透明指针类型
const HWND = koffi.opaque('HWND')
const LONG = koffi.pointer('LONG')  // SetWindowLong 返回值

const FindWindowExW = user32.func('HWND __stdcall FindWindowExW(HWND, HWND, const char *, const char *)')
const SetParent = user32.func('HWND __stdcall SetParent(HWND, HWND)')
const MoveWindow = user32.func('bool __stdcall MoveWindow(HWND, int, int, int, int, bool)')
const SetWindowLongPtrW = user32.func('LONG __stdcall SetWindowLongPtrW(HWND, int, LONG)')
const GetWindowLongPtrW = user32.func('LONG __stdcall GetWindowLongPtrW(HWND, int)')
const ShowWindow = user32.func('bool __stdcall ShowWindow(HWND, int)')
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(HWND)')
const IsWindow = user32.func('bool __stdcall IsWindow(HWND)')

// Win32 常量
const GWL_STYLE = -16
const WS_CHILD = 0x40000000
const WS_CAPTION = 0x00C00000
const WS_THICKFRAME = 0x00040000
const WS_MINIMIZEBOX = 0x00020000
const WS_MAXIMIZEBOX = 0x00010000
const WS_SYSMENU = 0x00080000
const WS_VISIBLE = 0x10000000
const SW_SHOW = 5
const SW_HIDE = 0

// 存储活跃的内嵌实例
const activeEmbeds = new Map()

/**
 * 启动 Chrome 并嵌入到 Electron 窗口
 * @param {object} options
 * @param {string} options.url - 初始加载的 URL
 * @param {BrowserWindow} options.parentWindow - Electron 父窗口
 * @param {string} options.partition - 分区名（用于 Cookie 隔离）
 * @param {object} [options.cookies] - 初始 Cookie 列表
 * @param {string} [options.userDataDir] - Chrome 用户数据目录
 * @returns {Promise<{browser, page, cleanup}>}
 */
async function launchEmbeddedChrome({ url, parentWindow, partition, cookies, userDataDir }) {
  // 1. 确定用户数据目录（用于 Cookie/LocalStorage 隔离）
  const path = require('path')
  const fs = require('fs')
  const app = require('electron').app

  if (!userDataDir) {
    const chromeDataDir = path.join(app.getPath('userData'), 'ChromeData', partition.replace('persist:', ''))
    if (!fs.existsSync(chromeDataDir)) {
      fs.mkdirSync(chromeDataDir, { recursive: true })
    }
    userDataDir = chromeDataDir
  }

  // 2. 尝试用用户已安装的 Chrome，没有则用 Playwright 自带的 Chromium
  let browser
  let usedChannel = 'chromium'

  try {
    // 优先尝试用户已安装的 Chrome
    browser = await chromium.launch({
      channel: 'chrome',
      headless: false,
      args: [
        `--user-data-dir=${userDataDir}`,
        '--disable-blink-features=AutomationControlled',  // 隐藏自动化标识
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--metrics-recording-only',
        '--safebrowsing-disable-auto-update',
      ],
    })
    usedChannel = 'chrome'
    console.log(`[ChromeEmbed] Using user-installed Chrome`)
  } catch (e) {
    // 回退到 Playwright 自带的 Chromium
    console.log(`[ChromeEmbed] Chrome not found, using Playwright Chromium: ${e.message}`)
    browser = await chromium.launch({
      headless: false,
      args: [
        `--user-data-dir=${userDataDir}`,
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--metrics-recording-only',
        '--safebrowsing-disable-auto-update',
      ],
    })
  }

  // 3. 创建页面并注入 Cookie
  const context = browser.contexts()[0] || await browser.newContext()
  const page = await context.newPage()

  // 注入 Cookie
  if (cookies && cookies.length > 0) {
    const now = Date.now() / 1000
    const playwrightCookies = cookies
      .filter(ck => !ck.expirationDate || ck.expirationDate <= 0 || ck.expirationDate >= now)
      .map(ck => ({
        name: ck.name,
        value: ck.value,
        domain: ck.domain,
        path: ck.path || '/',
        secure: ck.secure || false,
        httpOnly: ck.httpOnly || false,
        sameSite: ck.sameSite === 'no_restriction' ? 'None' : (ck.sameSite || 'Lax'),
        expires: (ck.expirationDate && ck.expirationDate > 0) ? ck.expirationDate : -1,
      }))
    await context.addCookies(playwrightCookies)
    console.log(`[ChromeEmbed] Injected ${playwrightCookies.length} cookies`)
  }

  // 隐藏 webdriver 标识
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
    // 删除 Playwright/Automation 标识
    delete window.__playwright
    delete window.__pw_manual
  })

  // 4. 导航到目标 URL
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})

  // 5. 获取 Chrome 窗口句柄并嵌入到 Electron 窗口
  const embedResult = await embedChromeInElectron(page, parentWindow)

  // 6. 返回控制接口
  const embedId = Date.now().toString()
  const embedData = {
    browser,
    page,
    context,
    chromeHwnd: embedResult.chromeHwnd,
    parentWindow,
    usedChannel,
  }
  activeEmbeds.set(embedId, embedData)

  return {
    browser,
    page,
    context,
    embedId,
    usedChannel,

    // 在页面中执行 JS
    async evaluate(jsCode) {
      return page.evaluate(jsCode)
    },

    // 获取当前 URL
    async getUrl() {
      return page.url()
    },

    // 导航到新 URL
    async navigate(newUrl) {
      return page.goto(newUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    },

    // 获取所有 Cookie
    async getCookies() {
      return context.cookies()
    },

    // 监听页面事件
    onPageEvent(event, callback) {
      if (event === 'load') {
        page.on('load', () => callback(page.url()))
      } else if (event === 'navigate') {
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) {
            callback(frame.url())
          }
        })
      } else if (event === 'close') {
        page.on('close', () => callback())
      } else if (event === 'response') {
        page.on('response', (response) => callback(response.url(), response.status()))
      }
    },

    // 监听网络请求（用于订单号捕获）
    onNetworkRequest(urlPattern, callback) {
      page.on('response', async (response) => {
        const url = response.url()
        if (url.includes(urlPattern)) {
          try {
            const body = await response.text()
            callback(url, response.status(), body)
          } catch (e) {}
        }
      })
    },

    // 控制台消息
    onConsoleMessage(callback) {
      page.on('console', (msg) => callback(msg.text()))
    },

    // 关闭并清理
    async close() {
      await cleanupEmbed(embedId)
    },

    // 调整嵌入窗口大小
    resize() {
      if (embedData.chromeHwnd) {
        repositionChrome(embedData.chromeHwnd, parentWindow)
      }
    },

    // 焦点
    focus() {
      if (embedData.chromeHwnd) {
        SetForegroundWindow(embedData.chromeHwnd)
      }
    },
  }
}

/**
 * 将 Chrome 窗口嵌入到 Electron 窗口
 */
async function embedChromeInElectron(page, parentWindow) {
  // 通过 Win32 API 查找 Chrome 窗口
  // Chrome 窗口类名是 Chrome_WidgetWin_1
  let chromeHwnd = null

  // 尝试多次查找（Chrome 窗口可能还没完全创建）
  for (let i = 0; i < 10; i++) {
    chromeHwnd = FindWindowExW(null, null, 'Chrome_WidgetWin_1', null)
    if (chromeHwnd) break
    await new Promise(r => setTimeout(r, 500))
  }

  if (!chromeHwnd) {
    console.warn('[ChromeEmbed] Could not find Chrome window handle, embedding disabled')
    return { chromeHwnd: null }
  }

  // 获取 Electron 窗口句柄
  const electronHwndBuffer = parentWindow.getNativeWindowHandle()
  // Electron 在 Windows 上返回 Buffer，包含 HWND（小端序 4 字节或 8 字节指针）
  let electronHwnd
  if (Buffer.isBuffer(electronHwndBuffer)) {
    // 将 Buffer 转为 HWND 指针
    electronHwnd = koffi.decode(electronHwndBuffer, HWND)
  } else {
    console.warn('[ChromeEmbed] Could not get Electron window handle')
    return { chromeHwnd: null }
  }

  // 嵌入！将 Chrome 窗口设为 Electron 窗口的子窗口
  console.log('[ChromeEmbed] SetParent: embedding Chrome into Electron window')
  SetParent(chromeHwnd, electronHwnd)

  // 修改 Chrome 窗口样式：去掉标题栏和边框，设为子窗口
  const currentStyle = Number(GetWindowLongPtrW(chromeHwnd, GWL_STYLE))
  const newStyle = (currentStyle | WS_CHILD | WS_VISIBLE) & ~(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU)
  SetWindowLongPtrW(chromeHwnd, GWL_STYLE, newStyle)

  // 调整 Chrome 窗口大小填满 Electron 窗口客户区
  repositionChrome(chromeHwnd, parentWindow)

  // 显示 Chrome 窗口
  ShowWindow(chromeHwnd, SW_SHOW)

  // 监听 Electron 窗口大小变化，同步调整 Chrome 窗口
  parentWindow.on('resize', () => {
    repositionChrome(chromeHwnd, parentWindow)
  })

  // 监听 Electron 窗口移动，同步调整 Chrome 窗口
  parentWindow.on('move', () => {
    repositionChrome(chromeHwnd, parentWindow)
  })

  // 监听 Electron 窗口关闭，同步关闭 Chrome
  parentWindow.on('closed', () => {
    // Chrome 会被 SetParent 影响，需要恢复
    try {
      ShowWindow(chromeHwnd, SW_HIDE)
    } catch (e) {}
  })

  // 监听 Electron 窗口显示/隐藏
  parentWindow.on('show', () => {
    try { ShowWindow(chromeHwnd, SW_SHOW) } catch (e) {}
  })
  parentWindow.on('hide', () => {
    try { ShowWindow(chromeHwnd, SW_HIDE) } catch (e) {}
  })
  parentWindow.on('minimize', () => {
    try { ShowWindow(chromeHwnd, SW_HIDE) } catch (e) {}
  })
  parentWindow.on('restore', () => {
    try { ShowWindow(chromeHwnd, SW_SHOW) } catch (e) {}
  })

  // 监听 Electron 窗口焦点
  parentWindow.on('focus', () => {
    try { SetForegroundWindow(chromeHwnd) } catch (e) {}
  })

  console.log('[ChromeEmbed] Chrome window embedded successfully')

  return { chromeHwnd }
}

/**
 * 创建页面适配器：将 Chrome/Playwright API 包装为与 Electron webContents 兼容的接口
 * 这样 purchase-order-capture.js 的事件处理代码几乎不用改
 * @param {object} chromeHandle - launchEmbeddedChrome 返回的控制对象
 * @param {BrowserWindow} win - Electron 宿主窗口
 * @returns {object} 模拟的 webContents 接口 + 辅助方法
 */
function createPageAdapter(chromeHandle, win) {
  const page = chromeHandle.page

  // 模拟 Electron webContents 的关键接口
  const adapter = {
    // 获取当前 URL
    getURL() {
      return page.url()
    },

    // 执行 JavaScript
    async executeJavaScript(code) {
      try {
        return await page.evaluate(code)
      } catch (e) {
        // 和 Electron 的 executeJavaScript 行为一致，出错返回 undefined
        return undefined
      }
    },

    // 设置 User-Agent（Chrome 模式下不需要，Chrome 自带标准 UA）
    setUserAgent() { /* no-op, Chrome has native UA */ },

    // 事件监听（模拟 webContents.on）
    _listeners: {},
    on(event, callback) {
      if (!adapter._listeners[event]) {
        adapter._listeners[event] = []
        // 注册 Playwright 侧的事件
        setupPlaywrightEvent(event, adapter)
      }
      adapter._listeners[event].push(callback)
    },

    // 会话 Cookie 操作
    _sessionAdapter: null,
  }

  // 创建 session 适配器（用于 Cookie 操作）
  adapter._sessionAdapter = {
    async getCookies() {
      const pwCookies = await chromeHandle.getCookies()
      return pwCookies.map(ck => ({
        name: ck.name,
        value: ck.value,
        domain: ck.domain,
        path: ck.path,
        secure: ck.secure,
        httpOnly: ck.httpOnly,
        sameSite: ck.sameSite === 'None' ? 'no_restriction' : (ck.sameSite || 'no_restriction'),
        expirationDate: ck.expires > 0 ? ck.expires : undefined,
      }))
    },
    webRequest: {
      onBeforeSendHeaders() { /* no-op in Chrome mode */ },
    },
  }

  // 触发事件回调
  function emit(event, ...args) {
    const listeners = adapter._listeners[event] || []
    for (const cb of listeners) {
      try { cb(...args) } catch (e) { console.error('[PageAdapter] Event callback error:', e.message) }
    }
  }

  // 将 Playwright 事件映射为 Electron webContents 事件
  function setupPlaywrightEvent(event, adapter) {
    switch (event) {
      case 'console-message':
      case 'console':  // 兼容两种写法
        page.on('console', (msg) => {
          emit('console-message', {}, msg.type() === 'warning' ? 2 : (msg.type() === 'error' ? 3 : 1), msg.text(), 0, '')
        })
        break

      case 'dom-ready':
        page.on('domcontentloaded', () => {
          emit('dom-ready')
        })
        // 页面导航也会触发
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) {
            emit('dom-ready')
          }
        })
        break

      case 'did-navigate':
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) {
            emit('did-navigate', {}, frame.url())
          }
        })
        break

      case 'did-navigate-in-page':
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) {
            // Playwright 不区分 navigate 和 navigate-in-page，都触发
            emit('did-navigate-in-page', {}, frame.url())
          }
        })
        break

      case 'will-navigate':
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) {
            emit('will-navigate', { preventDefault: () => {} }, frame.url())
          }
        })
        break

      case 'will-redirect':
        // Playwright 没有直接的 redirect 事件，忽略
        break
    }
  }

  return adapter
}

/**
 * 调整 Chrome 窗口位置和大小，填满 Electron 窗口客户区
 */
function repositionChrome(chromeHwnd, parentWindow) {
  if (!chromeHwnd) return
  if (!IsWindow(chromeHwnd)) return

  try {
    const [width, height] = parentWindow.getSize()
    const contentSize = parentWindow.getContentSize()
    // 使用客户区大小
    const w = contentSize[0] || width
    const h = contentSize[1] || height
    MoveWindow(chromeHwnd, 0, 0, w, h, true)
  } catch (e) {
    // 忽略 Win32 错误
  }
}

/**
 * 清理内嵌实例
 */
async function cleanupEmbed(embedId) {
  const data = activeEmbeds.get(embedId)
  if (!data) return

  try {
    // 恢复 Chrome 窗口为独立窗口（防止关闭 Electron 时 Chrome 卡住）
    if (data.chromeHwnd && IsWindow(data.chromeHwnd)) {
      ShowWindow(data.chromeHwnd, SW_HIDE)
      SetParent(data.chromeHwnd, null)
    }
  } catch (e) {}

  try {
    await data.browser.close()
  } catch (e) {}

  activeEmbeds.delete(embedId)
  console.log(`[ChromeEmbed] Cleanup complete: ${embedId}`)
}

/**
 * 获取所有活跃的内嵌实例
 */
function getActiveEmbeds() {
  return activeEmbeds
}

module.exports = { launchEmbeddedChrome, cleanupEmbed, getActiveEmbeds, createPageAdapter }
