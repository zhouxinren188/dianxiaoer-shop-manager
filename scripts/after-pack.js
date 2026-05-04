const { rcedit } = require('rcedit')
const path = require('path')
const fs = require('fs')
const os = require('os')

/**
 * electron-builder afterPack 钩子
 * 在 signAndEditExecutable:false 的情况下手动设置 exe 图标
 *
 * rcedit 不支持中文路径，需要先将文件复制到临时英文路径
 */
module.exports = async function (context) {
  if (context.electronPlatformName !== 'win32') return

  const exePath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`
  )

  // 使用项目根目录的 icon.ico（复制到临时英文路径避免中文路径问题）
  const srcIcoPath = path.resolve(__dirname, '..', 'resources', 'icon.ico')
  const tmpDir = path.join(os.tmpdir(), 'dxe-build')
  const tmpIcoPath = path.join(tmpDir, 'icon.ico')
  const tmpExePath = path.join(tmpDir, 'app.exe')

  try {
    // 准备临时目录
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.copyFileSync(srcIcoPath, tmpIcoPath)
    fs.copyFileSync(exePath, tmpExePath)

    console.log('[afterPack] Setting icon (via temp path)...')
    await rcedit(tmpExePath, { icon: tmpIcoPath })

    // 复制回原路径
    fs.copyFileSync(tmpExePath, exePath)
    console.log('[afterPack] Icon set successfully!')

    // 清理临时文件
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch (e) {
    console.error('[afterPack] Failed to set icon:', e.message)
    // 清理临时文件
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
  }
}
