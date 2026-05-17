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
 *   编译后 index.js 被替换为引导加载器（bootstrap），直接加载内置 index.jsc。
 *   热更新仅支持 renderer，主进程始终运行 app.asar 内置的字节码。
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
      // 主进程：替换为引导加载器（直接加载内置 index.jsc）
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
 * 它直接加载内置 index.jsc 字节码，热更新仅支持 renderer。
 * 此代码不被 bytenode 编译，保持明文，仅包含路径判断逻辑。
 */
function generateBootstrapCode() {
  return `// 引导加载器 — 由 compile-bytecode.js 自动生成
// 热更新仅支持 renderer，主进程始终加载内置 index.jsc
const { app } = require('electron')

if (!app.isPackaged) {
  require('bytenode')
  module.exports = require('./index.jsc')
  return
}

require('bytenode')
module.exports = require('./index.jsc')
`
}

main().catch(err => {
  console.error('[compile-bytecode] 未预期的错误:', err)
  process.exit(1)
})
