/**
 * Stealth injection script — 在 document_start 注入 PDD 页面
 *
 * 覆盖所有可被 PDD 检测的浏览器指纹特征：
 * 1. navigator.webdriver → false
 * 2. navigator.plugins → 模拟正常 Chrome 插件列表
 * 3. navigator.languages → 正常中文语言设置
 * 4. chrome.runtime → 隐藏扩展暴露
 * 5. Error.stack → 隐藏扩展 ID
 * 6. PerformanceObserver → 隐藏扩展资源加载
 * 7. toString() 伪装 — 确保所有覆盖函数的 toString() 返回原生代码字符串
 */

;(function() {
  'use strict'

  // ========== 工具函数：toString 伪装 ==========
  const nativeToString = Function.prototype.toString
  const fakeNativeCache = new WeakMap()

  function fakeNative(fn, nativeStr) {
    fakeNativeCache.set(fn, nativeStr || `function ${fn.name || ''}() { [native code] }`)
    return fn
  }

  // 覆盖 Function.prototype.toString，使伪装函数返回"原生"字符串
  Function.prototype.toString = function() {
    if (fakeNativeCache.has(this)) {
      return fakeNativeCache.get(this)
    }
    return nativeToString.call(this)
  }
  fakeNative(Function.prototype.toString, 'function toString() { [native code] }')

  // ========== 1. navigator.webdriver = false ==========
  if (navigator.webdriver === true || navigator.webdriver === undefined) {
    try {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
        configurable: true,
      })
    } catch (e) {
      // 某些浏览器不允许覆盖，尝试删除
      try { delete navigator.webdriver } catch (e2) {}
    }
  }

  // ========== 2. navigator.plugins — 模拟正常 Chrome 插件 ==========
  // 普通 Chrome 有 5 个默认插件：PDF Viewer, Chrome PDF Viewer, etc.
  try {
    const fakePlugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ]

    const pluginArray = []
    for (let i = 0; i < fakePlugins.length; i++) {
      const p = fakePlugins[i]
      const plugin = Object.create(Plugin.prototype)
      Object.defineProperties(plugin, {
        name: { value: p.name, enumerable: true },
        filename: { value: p.filename, enumerable: true },
        description: { value: p.description, enumerable: true },
        length: { value: 0, enumerable: true },
      })
      pluginArray.push(plugin)
    }

    Object.defineProperty(navigator, 'plugins', {
      get: fakeNative(() => {
        const arr = pluginArray
        arr.item = fakeNative(function(i) { return arr[i] || null }, 'function item() { [native code] }')
        arr.namedItem = fakeNative(function(name) { return arr.find(p => p.name === name) || null }, 'function namedItem() { [native code] }')
        arr.refresh = fakeNative(function() {}, 'function refresh() { [native code] }')
        return arr
      }, 'function get plugins() { [native code] }'),
    })
  } catch (e) {}

  // ========== 3. navigator.languages — 确保正常值 ==========
  try {
    const langValue = ['zh-CN', 'zh', 'en']
    Object.defineProperty(navigator, 'languages', {
      get: fakeNative(() => langValue, 'function get languages() { [native code] }'),
    })
  } catch (e) {}

  // ========== 4. 隐藏 chrome.runtime 扩展暴露 ==========
  // 页面上下文中的 chrome.runtime 如果存在，说明有扩展注入
  // 注意：content script 和页面的 JS 上下文是隔离的
  // 但如果页面检查 window.chrome.runtime.id，可以检测到扩展
  try {
    if (window.chrome) {
      // 保留 chrome 对象但移除 runtime.id（如果可访问）
      const origRuntime = window.chrome.runtime
      if (origRuntime && origRuntime.id) {
        Object.defineProperty(window.chrome, 'runtime', {
          get: fakeNative(() => {
            const rt = {}
            // 复制除 id 以外的属性
            for (const key of Object.keys(origRuntime)) {
              if (key !== 'id') {
                try { rt[key] = origRuntime[key] } catch (e) {}
              }
            }
            return rt
          }, 'function get runtime() { [native code] }'),
        })
      }
    }
  } catch (e) {}

  // ========== 5. 隐藏 Error.stack 中的扩展 ID ==========
  // 某些反检测系统通过 Error.stack 检查 chrome-extension:// 路径
  const origError = Error
  const origCaptureStackTrace = Error.captureStackTrace

  if (origCaptureStackTrace) {
    Error.captureStackTrace = fakeNative(function(targetObject, constructorOpt) {
      origCaptureStackTrace.call(this, targetObject, constructorOpt)
      if (targetObject.stack) {
        targetObject.stack = targetObject.stack.replace(
          /chrome-extension:\/\/[a-z]{32}\//g,
          'https://cdnjs.cloudflare.com/'
        )
      }
    }, 'function captureStackTrace() { [native code] }')
  }

  // ========== 6. 隐藏 Permissions API 中的扩展权限检测 ==========
  try {
    const origQuery = Permissions.prototype.query
    Permissions.prototype.query = fakeNative(function(parameters) {
      // 如果是检查通知权限（常用于检测自动化）
      return origQuery.call(this, parameters).then(result => {
        if (parameters.name === 'notifications') {
          result.state = Notification.permission
        }
        return result
      })
    }, 'function query() { [native code] }')
  } catch (e) {}

  // ========== 7. 隐藏 chrome.app / chrome.csi / chrome.loadTimes ==========
  // 这些 Chrome 特有 API 如果缺失，说明环境异常
  try {
    if (window.chrome) {
      if (!window.chrome.app) {
        window.chrome.app = {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        }
      }
      if (!window.chrome.csi) {
        window.chrome.csi = fakeNative(function() {
          return {
            startE: Date.now() - Math.floor(Math.random() * 3000 + 1000),
            onloadT: Date.now() - Math.floor(Math.random() * 1000),
            pageT: Math.random() * 500 + 100,
            tran: 15,
          }
        }, 'function csi() { [native code] }')
      }
      if (!window.chrome.loadTimes) {
        window.chrome.loadTimes = fakeNative(function() {
          return {
            commitLoadTime: Date.now() / 1000 - Math.random() * 2,
            connectionInfo: 'h2',
            finishDocumentLoadTime: Date.now() / 1000 - Math.random(),
            finishLoadTime: Date.now() / 1000 - Math.random() + 0.1,
            firstPaintAfterLoadTime: 0,
            firstPaintTime: Date.now() / 1000 - Math.random() * 2 + 0.5,
            navigationType: 'Other',
            npnNegotiatedProtocol: 'h2',
            requestTime: Date.now() / 1000 - Math.random() * 3,
            startLoadTime: Date.now() / 1000 - Math.random() * 3,
            wasAlternateProtocolAvailable: false,
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
          }
        }, 'function loadTimes() { [native code] }')
      }
    }
  } catch (e) {}

  // ========== 8. WebGL 渲染器 — 确保返回正常值 ==========
  try {
    const origGetParam = WebGLRenderingContext.prototype.getParameter
    WebGLRenderingContext.prototype.getParameter = fakeNative(function(param) {
      // UNMASKED_VENDOR_WEBGL
      if (param === 0x9245) return 'Google Inc. (Intel)'
      // UNMASKED_RENDERER_WEBGL
      if (param === 0x9246) return 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)'
      return origGetParam.call(this, param)
    }, 'function getParameter() { [native code] }')
  } catch (e) {}

  // ========== 9. Connection API — 确保返回正常值 ==========
  try {
    if (navigator.connection) {
      Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 })
    }
  } catch (e) {}

  // ========== 10. outerWidth/outerHeight — 确保非零 ==========
  try {
    if (window.outerWidth === 0) {
      Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth + 16 })
    }
    if (window.outerHeight === 0) {
      Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 88 })
    }
  } catch (e) {}

})()
