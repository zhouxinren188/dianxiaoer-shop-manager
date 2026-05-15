/**
 * compile-bytecode.js — 将主进程和预加载脚本编译为 V8 字节码
 *
 * 用法: node scripts/compile-bytecode.js
 * 时机: 在 electron-vite build 之后、electron-builder 之前执行
 *
 * 保护范围:
 *   out/main/index.js   → out/main/index.jsc   (主进程全部代码)
 *   out/preload/index.js → out/preload/index.jsc (主窗口预加载脚本)
 *
 * 不编译:
 *   renderer/           — 需要支持热更新
 *   purchase-preload.js — sandbox:true，无法 require('bytenode')
 *   platform-login-preload.js — sandbox:true
 *
 * 主进程特殊处理:
 *   编译后 index.js 被替换为引导加载器（bootstrap），而非简单 bytenode loader stub。
 *   bootstrap 检查是否有主进程热更新，有则加载热更新版本，否则加载内置 index.jsc。
 *   开发模式下 electron-vite dev 不执行此脚本，index.js 保持为完整源码。
 */

const bytenode = require('bytenode')
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')

const COMPILE_TARGETS = [
  {
    src: path.join(ROOT, 'out', 'main', 'index.js'),
    jsc: path.join(ROOT, 'out', 'main', 'index.jsc'),
    loaderName: 'index.js',
    isMainProcess: true
  },
  {
    src: path.join(ROOT, 'out', 'preload', 'index.js'),
    jsc: path.join(ROOT, 'out', 'preload', 'index.jsc'),
    loaderName: 'index.js',
    isMainProcess: false
  }
]

async function main() {
  console.log('[compile-bytecode] 开始字节码编译...')

  // 1. 验证环境
  for (const target of COMPILE_TARGETS) {
    if (!fs.existsSync(target.src)) {
      console.error(`[compile-bytecode] 错误: 找不到 ${target.src}`)
      console.error('[compile-bytecode] 请先运行 electron-vite build')
      process.exit(1)
    }
  }

  // 2. 复制 purchase-preload.js 到输出目录
  // 修复预存 bug: 该文件在 out/ 目录中不存在，但运行时被引用
  const purchasePreloadSrc = path.join(ROOT, 'src', 'main', 'purchase-preload.js')
  const purchasePreloadDestMain = path.join(ROOT, 'out', 'main', 'purchase-preload.js')
  const purchasePreloadDestOut = path.join(ROOT, 'out', 'purchase-preload.js')

  if (fs.existsSync(purchasePreloadSrc)) {
    fs.copyFileSync(purchasePreloadSrc, purchasePreloadDestMain)
    fs.copyFileSync(purchasePreloadSrc, purchasePreloadDestOut)
    console.log('[compile-bytecode] 已复制 purchase-preload.js 到 out/ 目录')
  } else {
    console.warn('[compile-bytecode] 警告: 找不到 src/main/purchase-preload.js，跳过复制')
  }

  // 3. 编译字节码
  for (const target of COMPILE_TARGETS) {
    console.log(`[compile-bytecode] 编译 ${path.relative(ROOT, target.src)} ...`)

    try {
      await bytenode.compileFile({
        filename: target.src,
        electron: true,
        compileAsModule: true,
        createLoader: 'commonjs',
        loaderFilename: target.loaderName
      })
    } catch (err) {
      console.error(`[compile-bytecode] 编译失败: ${target.src}`)
      console.error(err)
      process.exit(1)
    }

    // 4. 验证 .jsc 文件
    if (!fs.existsSync(target.jsc)) {
      console.error(`[compile-bytecode] 错误: 编译后未生成 ${target.jsc}`)
      process.exit(1)
    }

    const jscSize = fs.statSync(target.jsc).size
    if (jscSize === 0) {
      console.error(`[compile-bytecode] 错误: ${target.jsc} 大小为 0`)
      process.exit(1)
    }

    console.log(`[compile-bytecode] ✓ ${path.relative(ROOT, target.jsc)} (${(jscSize / 1024).toFixed(1)} KB)`)

    // 5. 替换 index.js
    if (target.isMainProcess) {
      // 主进程：替换为引导加载器（支持主进程热更新）
      const bootstrapCode = generateBootstrapCode()
      fs.writeFileSync(target.src, bootstrapCode, 'utf-8')
      console.log(`[compile-bytecode] ✓ ${path.relative(ROOT, target.src)} 已替换为引导加载器`)
    } else {
      // preload：验证 bytenode 生成的 loader stub
      const loaderContent = fs.readFileSync(target.src, 'utf-8')
      if (!loaderContent.includes('bytenode') || !loaderContent.includes('.jsc')) {
        console.error(`[compile-bytecode] 错误: ${target.src} 不是有效的加载器存根`)
        process.exit(1)
      }
      console.log(`[compile-bytecode] ✓ ${path.relative(ROOT, target.src)} 已替换为加载器存根`)
    }
  }

  console.log('[compile-bytecode] 字节码编译完成!')
}

/**
 * 生成引导加载器代码
 * 此代码作为 out/main/index.js 的内容，在 Electron 启动时执行。
 * 它检查是否有主进程热更新，有则加载热更新版本，否则加载内置 index.jsc。
 * 此代码不被 bytenode 编译，保持明文，仅包含路径判断逻辑。
 */
function generateBootstrapCode() {
  return `// 引导加载器 — 由 compile-bytecode.js 自动生成
// 检查是否有主进程热更新，有则加载热更新版本，否则加载内置 index.jsc
const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// 开发模式直接不可达（此文件仅在 compile-bytecode 后存在）
// 但作为安全保护，如果 app 尚未就绪，仍然检查
if (!app.isPackaged) {
  // 开发模式不应该走到这里（electron-vite dev 使用原始源码）
  // 但如果意外到达，加载内置 .jsc
  require('bytenode')
  module.exports = require('./index.jsc')
  return
}

const userDataPath = app.getPath('userData')
const hotUpdateDir = path.join(userDataPath, 'hot-update')
const versionFile = path.join(hotUpdateDir, 'version.json')

try {
  if (!fs.existsSync(versionFile)) {
    loadBuiltIn()
    return
  }

  const versionData = JSON.parse(fs.readFileSync(versionFile, 'utf-8'))

  if (!versionData.mainUpdate) {
    loadBuiltIn()
    return
  }

  const hotMainJs = path.join(hotUpdateDir, 'main', 'index.js')
  const hotMainJsc = path.join(hotUpdateDir, 'main', 'index.jsc')

  if (!fs.existsSync(hotMainJs) || !fs.existsSync(hotMainJsc)) {
    log('[Bootstrap] 主进程热更新文件不完整，加载内置版本')
    invalidateUpdate(versionFile, versionData, '主进程文件不完整')
    loadBuiltIn()
    return
  }

  // 校验 electronVersion
  if (versionData.electronVersion && versionData.electronVersion !== process.versions.electron) {
    log('[Bootstrap] Electron 版本不匹配: 热更新=' + versionData.electronVersion + ', 当前=' + process.versions.electron)
    invalidateUpdate(versionFile, versionData, 'Electron版本不匹配')
    loadBuiltIn()
    return
  }

  // 校验 baseVersion
  if (versionData.baseVersion && !isVersionCompatible(app.getVersion(), versionData.baseVersion)) {
    log('[Bootstrap] baseVersion 不兼容: app=' + app.getVersion() + ', base=' + versionData.baseVersion)
    invalidateUpdate(versionFile, versionData, 'baseVersion不兼容')
    loadBuiltIn()
    return
  }

  // 校验 mainSha256
  if (versionData.mainSha256) {
    const actualHash = sha256File(hotMainJsc)
    if (actualHash !== versionData.mainSha256) {
      log('[Bootstrap] mainSha256 校验失败')
      invalidateUpdate(versionFile, versionData, 'mainSha256校验失败')
      loadBuiltIn()
      return
    }
  }

  // 所有校验通过，加载热更新版本
  // 关键：先加载 bytenode，注册 .jsc 扩展处理器
  // 因为 hot-update/main/index.js 在 app.asar 外部，无法自行 require('bytenode')
  // 必须由 bootstrap（在 asar 内）预先加载，这样后续 require('./index.jsc') 才能工作
  try {
    require('bytenode')
  } catch (e) {
    log('[Bootstrap] 预加载 bytenode 失败: ' + e.message)
  }
  log('[Bootstrap] 加载主进程热更新: ' + hotMainJs)
  try {
    require(hotMainJs)
  } catch (loadErr) {
    log('[Bootstrap] 热更新加载失败: ' + loadErr.message + '，降级到内置版本')
    invalidateUpdate(versionFile, versionData, '加载失败: ' + loadErr.message)
    loadBuiltIn()
  }
} catch (err) {
  log('[Bootstrap] 热更新检查异常: ' + err.message)
  loadBuiltIn()
}

function loadBuiltIn() {
  require('bytenode')
  module.exports = require('./index.jsc')
}

function isVersionCompatible(appVersion, baseVersion) {
  const parseV = (v) => {
    const parts = String(v || '0.0.0').split('.').map(Number)
    return parts[0] * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0)
  }
  return parseV(appVersion) >= parseV(baseVersion)
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function invalidateUpdate(versionFile, versionData, reason) {
  try {
    versionData.mainUpdate = false
    versionData.invalidationReason = reason
    versionData.invalidatedAt = new Date().toISOString()
    fs.writeFileSync(versionFile, JSON.stringify(versionData, null, 2), 'utf-8')
  } catch (e) {}
}

function log(msg) {
  console.log(msg)
  try {
    const logFile = path.join(app.getPath('userData'), 'hot-update-bootstrap.log')
    fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + msg + '\\n', 'utf-8')
  } catch (e) {}
}
`
}

main().catch(err => {
  console.error('[compile-bytecode] 未预期的错误:', err)
  process.exit(1)
})
