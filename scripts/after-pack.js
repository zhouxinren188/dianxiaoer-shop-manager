const { rcedit } = require('rcedit')
const path = require('path')
const fs = require('fs')
const os = require('os')

/**
 * electron-builder afterPack 钩子
 * 兜底确保 exe 图标正确嵌入
 *
 * 如果 exe 路径含中文，rcedit 不支持，需要先复制到临时英文路径
 */
module.exports = async function (context) {
  if (context.electronPlatformName !== 'win32') return

  const exePath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`
  )

  const srcIcoPath = path.resolve(__dirname, '..', 'resources', 'icon.ico')

  // 检测路径是否包含非 ASCII 字符
  const hasNonAscii = /[^\x00-\x7F]/.test(exePath)

  try {
    if (hasNonAscii) {
      // 路径含中文：复制到临时英文路径操作
      const tmpDir = path.join(os.tmpdir(), 'dxe-build')
      const tmpIcoPath = path.join(tmpDir, 'icon.ico')
      const tmpExePath = path.join(tmpDir, 'app.exe')

      fs.mkdirSync(tmpDir, { recursive: true })
      fs.copyFileSync(srcIcoPath, tmpIcoPath)
      fs.copyFileSync(exePath, tmpExePath)

      console.log('[afterPack] Setting icon (via temp path for non-ASCII)...')
      await rcedit(tmpExePath, { icon: tmpIcoPath })

      fs.copyFileSync(tmpExePath, exePath)
      console.log('[afterPack] Icon set successfully!')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    } else {
      // 英文路径：直接操作
      console.log('[afterPack] Setting icon (direct)...')
      await rcedit(exePath, { icon: srcIcoPath })
      console.log('[afterPack] Icon set successfully!')
    }
  } catch (e) {
    console.error('[afterPack] Failed to set icon:', e.message)
    try { fs.rmSync(path.join(os.tmpdir(), 'dxe-build'), { recursive: true, force: true }) } catch (_) {}
  }
}
