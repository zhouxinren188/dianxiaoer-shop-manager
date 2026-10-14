const { rcedit } = require('rcedit')
const path = require('path')
const fs = require('fs')
const os = require('os')
const {
  assertWindowsExecutable
} = require('./validate-windows-executable')

const MIN_TEMP_FREE_RESERVE_BYTES = 512 * 1024 * 1024

function availableBytes(directory) {
  if (typeof fs.statfsSync !== 'function') return Number.POSITIVE_INFINITY
  const stat = fs.statfsSync(directory)
  return Number(stat.bavail) * Number(stat.bsize)
}

function safelyReplaceExecutable(sourcePath, destinationPath, minimumSize) {
  const stagedPath = `${destinationPath}.rcedit-staged`
  const backupPath = `${destinationPath}.rcedit-backup`
  try {
    fs.copyFileSync(sourcePath, stagedPath)
    assertWindowsExecutable(stagedPath, { minimumSize })
    fs.renameSync(destinationPath, backupPath)
    try {
      fs.renameSync(stagedPath, destinationPath)
      assertWindowsExecutable(destinationPath, { minimumSize })
      fs.rmSync(backupPath, { force: true })
    } catch (error) {
      fs.rmSync(destinationPath, { force: true })
      fs.renameSync(backupPath, destinationPath)
      throw error
    }
  } finally {
    fs.rmSync(stagedPath, { force: true })
    if (fs.existsSync(backupPath) && !fs.existsSync(destinationPath)) {
      fs.renameSync(backupPath, destinationPath)
    }
  }
}

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
  const originalSize = fs.statSync(exePath).size
  const minimumSize = Math.floor(originalSize * 0.9)
  assertWindowsExecutable(exePath, { minimumSize })

  // 检测路径是否包含非 ASCII 字符
  const hasNonAscii = /[^\x00-\x7F]/.test(exePath)

  try {
    if (hasNonAscii) {
      // 路径含中文：复制到临时英文路径操作
      const tempRoot = os.tmpdir()
      const requiredBytes = originalSize * 2 + MIN_TEMP_FREE_RESERVE_BYTES
      const freeBytes = availableBytes(tempRoot)
      if (freeBytes < requiredBytes) {
        console.warn(
          `[afterPack] Skip icon update: temp drive has ${freeBytes} bytes free, ${requiredBytes} required`
        )
        return
      }
      const tmpDir = fs.mkdtempSync(path.join(tempRoot, 'dxe-build-'))
      const tmpIcoPath = path.join(tmpDir, 'icon.ico')
      const tmpExePath = path.join(tmpDir, 'app.exe')

      try {
        fs.copyFileSync(srcIcoPath, tmpIcoPath)
        fs.copyFileSync(exePath, tmpExePath)

        console.log('[afterPack] Setting icon (via temp path for non-ASCII)...')
        await rcedit(tmpExePath, { icon: tmpIcoPath })
        assertWindowsExecutable(tmpExePath, { minimumSize })
        safelyReplaceExecutable(tmpExePath, exePath, minimumSize)
        console.log('[afterPack] Icon set and executable validation passed!')
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    } else {
      // 英文路径：直接操作
      const backupPath = `${exePath}.before-rcedit`
      fs.copyFileSync(exePath, backupPath)
      console.log('[afterPack] Setting icon (direct)...')
      try {
        await rcedit(exePath, { icon: srcIcoPath })
        assertWindowsExecutable(exePath, { minimumSize })
        console.log('[afterPack] Icon set and executable validation passed!')
      } catch (error) {
        fs.copyFileSync(backupPath, exePath)
        throw error
      } finally {
        fs.rmSync(backupPath, { force: true })
      }
    }
  } catch (e) {
    // Icon customization must never be allowed to replace a working Electron
    // executable with a truncated file. The original executable remains in use.
    assertWindowsExecutable(exePath, { minimumSize })
    console.warn('[afterPack] Icon update skipped; original executable preserved:', e.message)
  }
}
