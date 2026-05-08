/**
 * cef-embed.js - CEF 真实内嵌浏览器模块
 *
 * 通过独立 CEF 宿主进程加载 libcef.dll，创建浏览器窗口
 * 作为 WS_CHILD 子窗口嵌入到 Electron 窗口内。
 * 这是真正的进程级内嵌（与 dl 使用的 CEF 方案相同），
 * 不是窗口粘贴（SetParent）方案。
 *
 * 与 chrome-embed.js 的 API 兼容，可无缝替换。
 */

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { app } = require('electron')

// CEF 二进制包路径
const CEF_DIR = getCefDir()

function getCefDir() {
  // 1. 项目内嵌 CEF 目录
  const projectCefDir = path.join(__dirname, '..', '..', 'cef')
  if (fs.existsSync(path.join(projectCefDir, 'Release', 'libcef.dll'))) {
    return projectCefDir
  }
  // 2. 管理员目录下的 CEF 分发包
  const adminCefDir = 'C:\\Users\\Administrator\\cef-dist\\cef_binary_147.0.10+gd58e84d+chromium-147.0.7727.118_windows64_minimal'
  if (fs.existsSync(path.join(adminCefDir, 'Release', 'libcef.dll'))) {
    return adminCefDir
  }
  return ''
}

// 存储活跃的内嵌实例
const activeEmbeds = new Map()

/**
 * 启动 CEF 内嵌浏览器
 * @param {object} options
 * @param {string} options.url - 初始加载的 URL
 * @param {BrowserWindow} options.parentWindow - Electron 父窗口
 * @param {string} options.partition - 分区名（用于 Cookie 隔离）
 * @param {object} [options.cookies] - 初始 Cookie 列表
 * @param {string} [options.userDataDir] - 用户数据目录
 * @returns {Promise<object>} CEF 内嵌控制对象
 */
async function launchEmbeddedCEF({ url, parentWindow, partition, cookies, userDataDir }) {
  if (!CEF_DIR) {
    throw new Error('CEF binary directory not found. Please check CEF installation.')
  }

  // 确定缓存目录
  const path2 = path
  if (!userDataDir) {
    const chromeDataDir = path2.join(app.getPath('userData'), 'CEFData', partition.replace('persist:', ''))
    if (!fs.existsSync(chromeDataDir)) {
      fs.mkdirSync(chromeDataDir, { recursive: true })
    }
    userDataDir = chromeDataDir
  }

  // 获取 Electron 窗口的 HWND
  const hwndBuffer = parentWindow.getNativeWindowHandle()
  let parentHwnd
  if (Buffer.isBuffer(hwndBuffer)) {
    // Windows x64: HWND 是 8 字节指针
    if (hwndBuffer.length === 8) {
      parentHwnd = hwndBuffer.readBigUInt64LE()
    } else if (hwndBuffer.length === 4) {
      parentHwnd = BigInt(hwndBuffer.readUInt32LE())
    } else {
      parentHwnd = BigInt(hwndBuffer.readUInt32LE())
    }
  } else {
    throw new Error('Could not get Electron window handle')
  }

  const parentHwndStr = '0x' + parentHwnd.toString(16)

  // CEF 宿主程序路径（C# 编译的 cef-host.exe，替代 Node.js 版本）
  // Node.js 进程与 CEF Windows 消息循环不兼容，导致窗口"未响应"
  // C# 版本在主循环中添加了 PumpWindowsMessages()，窗口正常响应
  const cefHostExe = path2.join(CEF_DIR, 'Release', 'cef-host.exe')
  if (!fs.existsSync(cefHostExe)) {
    throw new Error('cef-host.exe not found: ' + cefHostExe)
  }

  // User-Agent: 模拟 Chrome 而非 Edge
  const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

  // 启动 CEF 宿主进程
  console.log(`[CEF-Embed] Spawning CEF host process...`)
  console.log(`[CEF-Embed] Parent HWND: ${parentHwndStr}`)
  console.log(`[CEF-Embed] URL: ${url}`)

  const child = spawn(cefHostExe, [
    `--hwnd=${parentHwndStr}`,
    `--url=${url}`,
    `--cef-dir=${CEF_DIR}`,
    `--cache=${userDataDir}`,
    `--user-agent=${chromeUA}`,
    `--locale=zh-CN`,
    // Chromium 命令行开关 — CEF 会解析进程命令行（command_line_args_disabled=0）
    '--single-process',
    '--disable-gpu',
    '--in-process-gpu',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--bootstrap-module-name=libcef',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CEF_BOOTSTRAP_MODULE_NAME: 'libcef',
    }
  })

  // IPC 通信
  const readline = require('readline')
  const rl = readline.createInterface({ input: child.stdout })
  const eventListeners = new Map() // event -> [callbacks]
  const pendingRequests = new Map() // id -> { resolve, reject }
  let ipcId = 0
  let ready = false

  // 处理 IPC 消息
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line)
      if (msg.type === 'event') {
        const cbs = eventListeners.get(msg.event) || []
        for (const cb of cbs) {
          try { cb(msg.params) } catch (e) {}
        }
      } else if (msg.type === 'response') {
        const pending = pendingRequests.get(msg.id)
        if (pending) {
          pendingRequests.delete(msg.id)
          if (msg.error) {
            pending.reject(new Error(msg.error))
          } else {
            pending.resolve(msg.result)
          }
        }
      } else if (msg.type === 'ready') {
        ready = true
        console.log('[CEF-Embed] CEF host process ready')
      } else if (msg.type === 'error') {
        console.error(`[CEF-Embed] CEF host error: ${msg.message}`)
      }
    } catch (e) {}
  })

  // 转发 stderr
  child.stderr.on('data', (data) => {
    if (cefExited) return
    try {
      const text = data.toString().trim()
      if (text) {
        console.log(`[CEF-Host] ${text}`)
      }
    } catch (e) {
      // EPIPE 等 I/O 错误忽略
    }
  })

  // 处理子进程退出 — 关闭父窗口（CEF 浏览器被关闭时，Electron 容器也应关闭）
  let cefExited = false
  child.on('exit', (code) => {
    cefExited = true
    console.log(`[CEF-Embed] CEF host process exited with code ${code}`)
    // 拒绝所有等待中的 IPC 请求
    for (const [id, pending] of pendingRequests) {
      pendingRequests.delete(id)
      pending.reject(new Error(`CEF host process exited (code: ${code})`))
    }
    if (parentWindow && !parentWindow.isDestroyed()) {
      parentWindow.close()
    }
  })

  child.on('error', (err) => {
    console.error(`[CEF-Embed] CEF host process error: ${err.message}`)
  })

  // 发送 IPC 命令
  function sendCommand(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (cefExited) {
        reject(new Error(`CEF host process has exited`))
        return
      }
      const id = ++ipcId
      pendingRequests.set(id, { resolve, reject })
      // 超时处理
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id)
          reject(new Error(`IPC timeout: ${method}`))
        }
      }, 30000)
      try {
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      } catch (e) {
        pendingRequests.delete(id)
        reject(e)
      }
    })
  }

  // 等待 CEF 宿主就绪
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('CEF host process timeout'))
    }, 60000)

    const checkReady = setInterval(() => {
      if (ready) {
        clearTimeout(timeout)
        clearInterval(checkReady)
        resolve()
      }
    }, 100)

    // 也监听错误
    child.on('exit', (code) => {
      if (!ready) {
        clearTimeout(timeout)
        clearInterval(checkReady)
        reject(new Error(`CEF host process exited before ready (code: ${code})`))
      }
    })
  })

  // 注入初始 Cookie（通过 JS 执行）
  if (cookies && cookies.length > 0) {
    // CEF 使用自己的 Cookie 存储，我们通过 document.cookie 来设置
    const cookieScripts = cookies.map(ck => {
      const secure = ck.secure ? ';secure' : ''
      const httpOnly = ck.httpOnly ? ';httpOnly' : ''
      const path = ck.path || '/'
      const domain = ck.domain || ''
      return `document.cookie = "${ck.name}=${ck.value};path=${path}${domain ? ';domain=' + domain : ''}${secure}";`
    }).join('\n')
    // 延迟执行，等页面加载完
    setTimeout(async () => {
      try {
        await sendCommand('evaluate', { code: cookieScripts })
        console.log(`[CEF-Embed] Injected ${cookies.length} cookies via JS`)
      } catch (e) {
        console.warn(`[CEF-Embed] Cookie injection failed: ${e.message}`)
      }
    }, 3000)
  }

  // 创建控制对象
  const embedId = Date.now().toString()
  const embedData = {
    child,
    parentWindow,
    sendCommand,
    eventListeners,
    pendingRequests,
  }
  activeEmbeds.set(embedId, embedData)

  // 监听 Electron 窗口事件，同步到 CEF 宿主
  parentWindow.on('resize', () => {
    sendCommand('resize').catch(() => {})
  })

  // 焦点恢复：仅在 BrowserWindow 从外部重新获得焦点时（如 Alt+Tab）才通知 CEF
  // ★ 不能在每次 focus 事件都发 focus 命令——用户点击 CEF 内容时也会触发
  //    BrowserWindow 的 focus 事件，此时 focus 命令会抢走 CEF 子元素焦点导致卡顿
  let wasBlurred = false
  parentWindow.on('blur', () => { wasBlurred = true })
  parentWindow.on('focus', () => {
    if (wasBlurred) {
      wasBlurred = false
      sendCommand('focus').catch(() => {})
    }
  })

  parentWindow.on('closed', () => {
    cleanupEmbed(embedId)
  })

  return {
    embedId,

    // 在页面中执行 JS 并返回结果
    // cef-host.exe 通过 console.log('__CEF_EVAL__:') 机制返回执行结果
    // on_console_message 回调捕获结果，evaluate 处理器 spin-wait 等待
    async evaluate(jsCode) {
      return sendCommand('evaluate', { code: jsCode })
    },

    // 获取当前 URL
    async getUrl() {
      return sendCommand('getUrl')
    },

    // 导航到新 URL
    async navigate(newUrl) {
      return sendCommand('navigate', { url: newUrl })
    },

    // 获取所有 Cookie（CEF 模式下通过 JS 获取）
    async getCookies() {
      try {
        const cookieStr = await sendCommand('evaluate', {
          code: 'document.cookie'
        })
        // 简单解析 document.cookie
        if (!cookieStr) return []
        return cookieStr.split(';').map(c => {
          const [name, ...rest] = c.trim().split('=')
          return { name, value: rest.join('='), domain: '', path: '/' }
        }).filter(c => c.name)
      } catch (e) {
        return []
      }
    },

    // 监听页面事件
    onPageEvent(event, callback) {
      if (event === 'load') {
        eventListeners.set('load_end', eventListeners.get('load_end') || [])
        eventListeners.get('load_end').push((params) => callback(''))
      } else if (event === 'navigate') {
        eventListeners.set('address_change', eventListeners.get('address_change') || [])
        eventListeners.get('address_change').push((params) => callback(params.url))
      } else if (event === 'close') {
        eventListeners.set('before_close', eventListeners.get('before_close') || [])
        eventListeners.get('before_close').push(() => callback())
      }
    },

    // 监听网络请求（CEF 模式下不支持，保留接口兼容）
    onNetworkRequest(urlPattern, callback) {
      // CEF 不像 Playwright 那样容易拦截网络请求
      // 可以通过 CDP (DevTools Protocol) 实现，后续添加
      console.warn('[CEF-Embed] onNetworkRequest not yet implemented in CEF mode')
    },

    // 控制台消息（通过 cef-host.exe IPC 事件转发）
    onConsoleMessage(callback) {
      const cbs = eventListeners.get('console') || []
      cbs.push((params) => {
        callback(params.message || '', parseInt(params.level) || 0)
      })
      eventListeners.set('console', cbs)
    },

    // 关闭并清理
    async close() {
      return cleanupEmbed(embedId)
    },

    // 调整大小
    resize() {
      sendCommand('resize').catch(() => {})
    },

    // 焦点恢复：将 CEF 子窗口提到 Z-order 最前并设置焦点
    // Alt+Tab 后 Electron renderer 会盖住 CEF 子窗口，需要恢复
    focus() {
      sendCommand('focus').catch(() => {})
    },
  }
}

/**
 * 清理内嵌实例
 */
async function cleanupEmbed(embedId) {
  const data = activeEmbeds.get(embedId)
  if (!data) return

  try {
    await data.sendCommand('close')
  } catch (e) {}

  try {
    data.child.kill()
  } catch (e) {}

  activeEmbeds.delete(embedId)
  console.log(`[CEF-Embed] Cleanup complete: ${embedId}`)
}

/**
 * 创建页面适配器：将 CEF API 包装为与 Electron webContents 兼容的接口
 * 这样 purchase-order-capture.js 的事件处理代码几乎不用改
 * @param {object} cefHandle - launchEmbeddedCEF 返回的控制对象
 * @param {BrowserWindow} win - Electron 宿主窗口
 * @returns {object} 模拟的 webContents 接口 + 辅助方法
 */
function createPageAdapter(cefHandle, win) {
  // 模拟 Electron webContents 的关键接口
  const adapter = {
    // 获取当前 URL
    getURL() {
      // 同步返回缓存的 URL（CEF 是异步的，这里需要处理）
      return adapter._currentUrl || ''
    },

    // 执行 JavaScript
    async executeJavaScript(code) {
      try {
        return await cefHandle.evaluate(code)
      } catch (e) {
        return undefined
      }
    },

    // 设置 User-Agent（CEF 模式下在初始化时已设置）
    setUserAgent() { /* no-op, UA set at CEF initialization */ },

    // 事件监听（模拟 webContents.on）
    _listeners: {},
    on(event, callback) {
      if (!adapter._listeners[event]) {
        adapter._listeners[event] = []
        setupCefEvent(event, adapter)
      }
      adapter._listeners[event].push(callback)
    },

    // 会话适配器（用于 Cookie 操作）
    // 通过 session 属性访问，与 Electron webContents.session 兼容
    get session() {
      return adapter._sessionAdapter
    },

    _sessionAdapter: null,
    _currentUrl: '',
  }

  // 创建 session 适配器
  adapter._sessionAdapter = {
    async getCookies() {
      const rawCookies = await cefHandle.getCookies()
      return rawCookies
    },
    webRequest: {
      onBeforeSendHeaders() { /* no-op in CEF mode */ },
    },
  }

  // 触发事件回调
  function emit(event, ...args) {
    const listeners = adapter._listeners[event] || []
    for (const cb of listeners) {
      try { cb(...args) } catch (e) { console.error('[CEF-PageAdapter] Event callback error:', e.message) }
    }
  }

  // 将 CEF 事件映射为 Electron webContents 事件
  function setupCefEvent(event, adapter) {
    switch (event) {
      case 'console-message':
      case 'console':
        // cef-host.exe 的 on_console_message 已经发送 'console' IPC 事件
        // 参数: { message, level }
        // Electron console-message 签名: (event, level, message, line, sourceId)
        // 通过 cefHandle.onConsoleMessage 注册，该方法内部操作 launchEmbeddedCEF 的 eventListeners
        cefHandle.onConsoleMessage((message, level) => {
          emit('console-message', {}, level, message, 0, '')
        })
        break

      case 'dom-ready':
        cefHandle.onPageEvent('load', () => {
          emit('dom-ready')
        })
        break

      case 'did-navigate':
        cefHandle.onPageEvent('navigate', (url) => {
          adapter._currentUrl = url
          emit('did-navigate', {}, url)
        })
        break

      case 'did-navigate-in-page':
        cefHandle.onPageEvent('navigate', (url) => {
          adapter._currentUrl = url
          emit('did-navigate-in-page', {}, url)
        })
        break

      case 'will-navigate':
        cefHandle.onPageEvent('navigate', (url) => {
          emit('will-navigate', { preventDefault: () => {} }, url)
        })
        break

      case 'will-redirect':
        // CEF 没有 will-redirect 事件，用 address_change 近似
        // 无法区分 redirect 和普通导航，保留空实现
        break
    }
  }

  return adapter
}

/**
 * 获取所有活跃的内嵌实例
 */
function getActiveEmbeds() {
  return activeEmbeds
}

/**
 * 检查 CEF 是否可用
 */
function isCefAvailable() {
  return !!CEF_DIR && fs.existsSync(path.join(CEF_DIR, 'Release', 'libcef.dll'))
}

// 控制台消息拦截器（CEF 模式下替代 Electron 的 console-message 事件）
// 在页面中拦截 console.log 调用，存储消息供主进程轮询读取
const CONSOLE_INTERCEPTOR = `
(function() {
  if (window.__consoleInterceptorInstalled) return;
  window.__consoleInterceptorInstalled = true;
  window.__cefConsoleMessages = [];
  var origLog = console.log;
  console.log = function() {
    var args = Array.prototype.slice.call(arguments);
    var msg = args.join(' ');
    window.__cefConsoleMessages.push({ message: msg, time: Date.now() });
    if (window.__cefConsoleMessages.length > 200) {
      window.__cefConsoleMessages.shift();
    }
    origLog.apply(console, args);
  };
})()
`

// 读取已拦截的控制台消息（读后清空）
const READ_CONSOLE_MESSAGES = `
(function() {
  var data = window.__cefConsoleMessages || [];
  window.__cefConsoleMessages = [];
  return data;
})()
`

module.exports = { launchEmbeddedCEF, cleanupEmbed, getActiveEmbeds, createPageAdapter, isCefAvailable, CONSOLE_INTERCEPTOR, READ_CONSOLE_MESSAGES }
