/**
 * purchase-preload.js - 采购窗口反检测预加载脚本
 *
 * ★ v1.9.14 重大策略调整：
 * 经验证，不完整的指纹伪装比没有伪装更危险。之前版本伪装了 webdriver/plugins/mimeTypes/
 * hardwareConcurrency/deviceMemory/languages/platform/canvas/webGL/audioContext 等大量指纹，
 * 但遗漏了 vendor/productSub/maxTouchPoints/prototype chain 等，导致指纹不自洽，
 * 支付宝风控识别出"伪装者"比识别出"Electron"更容易触发拦截。
 *
 * 禁用所有伪装后支付宝支付反而正常通过，说明支付宝当前不检测 Electron 原生指纹。
 *
 * 新策略：最小化干预——只隐藏"自动化工具"的直接标识（webdriver、selenium 相关变量），
 * 不做任何浏览器指纹伪装（plugins/mimeTypes/canvas/webGL 等保持原生值），
 * 避免引入不一致的指纹导致风控升级。
 *
 * ★ contextIsolation=false：preload 与页面共享同一个 JS 上下文，
 * 所以对 navigator/window 的修改对页面可见。
 */

// ★★★ 启动确认日志：主进程通过 console-message 事件捕获此消息，确认 preload 已加载 ★★★
console.log('[PRELOAD_LOADED] purchase-preload.js 已执行，反检测脚本开始注入（最小化策略）')

// ====== 最小化反检测：只隐藏"自动化工具"直接标识 ======
// 这些修改不影响浏览器指纹的自洽性，因为它们是"删除/隐藏"而非"伪装"

// 1. 隐藏 webdriver 标识（最关键的自动化检测点）
Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true })

// 2. 隐藏 Automation/Selenium/PhantomJS 相关全局变量（纯删除，不引入新值）
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

// 3. 隐藏 Electron 特有的 process 引用（sandbox 模式下通常不可见，以防万一）
if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
  try {
    Object.defineProperty(process.versions, 'electron', { get: () => undefined, configurable: true })
  } catch (e) { /* sandbox 模式下可能无法修改 */ }
}

// 4. 修复 outerWidth/outerHeight（Electron 中可能为 0，暴露无头特征）
// 这是"修复异常值"而非"伪装"，不影响指纹自洽
if (window.outerWidth === 0) {
  Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth, configurable: true })
}
if (window.outerHeight === 0) {
  Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85, configurable: true })
}

// 5. 保存原生 window.open 引用（页面 JS 可能覆盖 window.open，preload 在页面 JS 之前执行）
window.__dxeOpen = window.open.bind(window)

// ====== 不再伪装的指纹（保持原生值，避免不一致） ======
// 以下项目在之前的版本中被伪装，但经验证导致支付宝风控拦截，
// 现在保持 Electron/Chromium 原生值：
//
// - navigator.plugins（原生 Electron plugins 列表，虽短但自洽）
// - navigator.mimeTypes（原生 Electron mimeTypes，同上）
// - navigator.hardwareConcurrency（原生值）
// - navigator.deviceMemory（原生值）
// - navigator.languages（原生值）
// - navigator.platform（原生值）
// - navigator.vendor（原生值）
// - navigator.productSub（原生值）
// - navigator.maxTouchPoints（原生值）
// - Canvas 指纹噪声（移除——原生 Canvas 指纹虽可能暴露 Electron，但比伪造后不一致更安全）
// - WebGL 指纹伪装（移除——同上）
// - AudioContext 指纹噪声（移除——同上）
// - chrome.runtime 伪造（移除——保持 Electron 原生 chrome 对象）
// - chrome.csi / chrome.loadTimes 伪造（移除——保持原生值）
// - permissions API 伪造（移除——保持原生行为）
