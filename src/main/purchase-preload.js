/**
 * purchase-preload.js - 采购窗口反检测预加载脚本
 *
 * 在页面 JavaScript 执行前注入，覆盖 navigator/webGL/canvas 等指纹，
 * 隐藏 Electron/自动化标识，伪装为标准 Chrome 浏览器。
 *
 * ★ contextIsolation=false：preload 与页面共享同一个 JS 上下文，
 * 所以对 navigator/window 的修改对页面可见，反检测在页面 JS 之前生效。
 * 这和 dl 的 CEF ExecuteJavaScript 效果一致——在页面脚本运行前完成指纹伪装。
 */

// 1. 隐藏 webdriver 标识
Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true })

// 2. 伪造 navigator.plugins（模拟 Chrome 默认插件列表）
const fakePlugins = [
  { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
  { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
]
const pluginArray = []
pluginArray.item = function (i) { return this[i] }
pluginArray.namedItem = function (name) { for (let i = 0; i < this.length; i++) { if (this[i].name === name) return this[i] } return null }
pluginArray.refresh = function () {}
pluginArray.length = fakePlugins.length
for (let i = 0; i < fakePlugins.length; i++) {
  const p = {
    name: fakePlugins[i].name, filename: fakePlugins[i].filename, description: fakePlugins[i].description,
    length: 0, item: function () { return null }, namedItem: function () { return null }
  }
  Object.defineProperty(p, 'length', { value: 0, configurable: false })
  pluginArray[i] = p
}
Object.defineProperty(navigator, 'plugins', { get: () => pluginArray, configurable: true })

// 3. 伪造 navigator.mimeTypes
const fakeMimes = [
  { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
  { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
  { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' },
  { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' }
]
const mimeArray = []
mimeArray.item = function (i) { return this[i] }
mimeArray.namedItem = function (name) { for (let i = 0; i < this.length; i++) { if (this[i].type === name) return this[i] } return null }
mimeArray.length = fakeMimes.length
for (let i = 0; i < fakeMimes.length; i++) {
  const m = {
    type: fakeMimes[i].type, suffixes: fakeMimes[i].suffixes, description: fakeMimes[i].description,
    enabledPlugin: pluginArray[0]
  }
  mimeArray[i] = m
}
Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeArray, configurable: true })

// 4. 伪造 hardwareConcurrency / deviceMemory
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true })
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true })

// 5. 伪造 navigator.languages
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'], configurable: true })

// 6. 伪造 navigator.platform
Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true })

// 7. Canvas 指纹噪声
const origToDataURL = HTMLCanvasElement.prototype.toDataURL
HTMLCanvasElement.prototype.toDataURL = function () {
  const ctx = this.getContext('2d')
  if (ctx && this.width > 0 && this.height > 0) {
    const imgData = ctx.getImageData(0, 0, 1, 1)
    imgData.data[3] = imgData.data[3] ^ 1
    ctx.putImageData(imgData, 0, 0)
  }
  return origToDataURL.apply(this, arguments)
}
const origToBlob = HTMLCanvasElement.prototype.toBlob
HTMLCanvasElement.prototype.toBlob = function () {
  const ctx = this.getContext('2d')
  if (ctx && this.width > 0 && this.height > 0) {
    const imgData = ctx.getImageData(0, 0, 1, 1)
    imgData.data[3] = imgData.data[3] ^ 1
    ctx.putImageData(imgData, 0, 0)
  }
  return origToBlob.apply(this, arguments)
}

// 8. WebGL 指纹伪装
const origGetParam = WebGLRenderingContext.prototype.getParameter
WebGLRenderingContext.prototype.getParameter = function (param) {
  if (param === 37445) return 'Intel Inc.'           // UNMASKED_VENDOR_WEBGL
  if (param === 37446) return 'Intel Iris OpenGL Engine'  // UNMASKED_RENDERER_WEBGL
  return origGetParam.call(this, param)
}
if (typeof WebGL2RenderingContext !== 'undefined') {
  const origGetParam2 = WebGL2RenderingContext.prototype.getParameter
  WebGL2RenderingContext.prototype.getParameter = function (param) {
    if (param === 37445) return 'Intel Inc.'
    if (param === 37446) return 'Intel Iris OpenGL Engine'
    return origGetParam2.call(this, param)
  }
}

// 9. AudioContext 指纹噪声
const origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData
AnalyserNode.prototype.getFloatFrequencyData = function (arr) {
  origGetFloatFreq.call(this, arr)
  for (let i = 0; i < arr.length; i++) { arr[i] += Math.random() * 0.0001 }
}

// 10. 隐藏 Automation 相关属性
delete window.__nightmare
delete window._phantom
delete window.__phantomas
delete window.callPhantom
delete window._selenium
delete window._Selenium_IDE_Recorder
delete window.__webdriver_evaluate
delete window.__selenium_evaluate
delete window.__fxdriver_evaluate
delete window.__driver_unwrapped
delete window.__webdriver_unwrapped
delete window.__driver_evaluate
delete window.__selenium_unwrapped
delete window.__fxdriver_unwrapped

// 11. 伪造 permissions API
if (navigator.permissions && navigator.permissions.query) {
  const origQuery = navigator.permissions.query.bind(navigator.permissions)
  navigator.permissions.query = function (params) {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: 'default', onchange: null })
    }
    return origQuery(params)
  }
}

// 12. 伪造 chrome.runtime（Electron 的 chrome.runtime 与真实 Chrome 不同）
// 真实 Chrome 有 chrome.runtime.connect / sendMessage 等方法
if (window.chrome) {
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: function () { return { onMessage: { addListener: function () {} }, postMessage: function () {}, disconnect: function () {} } },
      sendMessage: function () {},
      onMessage: { addListener: function () {} },
      id: undefined
    }
  }
}

// 13. 修复 window.chrome 对象（Electron 可能缺少某些属性）
if (!window.chrome) {
  window.chrome = {}
}
if (!window.chrome.csi) {
  window.chrome.csi = function () {}
}
if (!window.chrome.loadTimes) {
  window.chrome.loadTimes = function () {
    return {
      commitLoadTime: Date.now() / 1000,
      connectionInfo: 'h2',
      finishDocumentLoadTime: 0,
      finishLoadTime: 0,
      firstPaintAfterLoadTime: 0,
      firstPaintTime: 0,
      navigationType: 'Other',
      npnNegotiatedProtocol: 'h2',
      requestTime: Date.now() / 1000 - 0.5,
      startLoadTime: Date.now() / 1000 - 0.5,
      wasAlternateProtocolAvailable: false,
      wasFetchedViaSpdy: true,
      wasNpnNegotiated: true
    }
  }
}

// 14. 隐藏 Electron 特有的 process 引用（contextIsolation 下本应不可见，以防万一）
if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
  try {
    Object.defineProperty(process.versions, 'electron', { get: () => undefined, configurable: true })
    Object.defineProperty(process.versions, 'chrome', { get: () => '134.0.0.0', configurable: true })
  } catch (e) { /* sandbox 模式下可能无法修改 */ }
}

// 15. 修复 outerWidth/outerHeight（Electron 中可能为 0，暴露无头特征）
if (window.outerWidth === 0) {
  Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth, configurable: true })
}
if (window.outerHeight === 0) {
  Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85, configurable: true })
}

// 16. PDD 地址页早期注入 — 已废弃
// 地址填写逻辑通过 executeJavaScript 在 did-navigate 中注入，
// 省市区级联通过"先绑定 DOMNodeInserted 监听器再 click"解决时序问题。
