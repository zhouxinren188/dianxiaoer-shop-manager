/**
 * bootstrap.js — 主进程引导加载器
 *
 * 作为 Electron 入口（package.json main 字段），负责选择加载内置版本还是热更新版本的主进程。
 * 此文件不被 bytenode 编译，保持明文 JS，仅包含路径判断逻辑，零业务代码。
 */

const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// 内置主进程入口（相对于 bootstrap.js 所在目录 out/main/）
const BUILT_IN_ENTRY = './index.js'

function bootstrap() {
  // 开发模式：直接加载内置版本（electron-vite dev 会使用原始源码）
  if (!app.isPackaged) {
    require(BUILT_IN_ENTRY)
    return
  }

  // 生产模式：检查是否有主进程热更新
  const userDataPath = app.getPath('userData')
  const hotUpdateDir = path.join(userDataPath, 'hot-update')
  const versionFile = path.join(hotUpdateDir, 'version.json')

  try {
    if (!fs.existsSync(versionFile)) {
      log('[Bootstrap] 无热更新 version.json，加载内置版本')
      require(BUILT_IN_ENTRY)
      return
    }

    const versionData = JSON.parse(fs.readFileSync(versionFile, 'utf-8'))

    // 检查是否包含主进程更新
    if (!versionData.mainUpdate) {
      log('[Bootstrap] 热更新不包含主进程更新，加载内置版本')
      require(BUILT_IN_ENTRY)
      return
    }

    // 检查主进程 .jsc 文件是否存在
    const hotMainJs = path.join(hotUpdateDir, 'main', 'index.js')
    const hotMainJsc = path.join(hotUpdateDir, 'main', 'index.jsc')

    if (!fs.existsSync(hotMainJs) || !fs.existsSync(hotMainJsc)) {
      log('[Bootstrap] 主进程热更新文件不完整，加载内置版本')
      invalidateUpdate(versionFile, versionData, '主进程文件不完整')
      require(BUILT_IN_ENTRY)
      return
    }

    // 校验 electronVersion 兼容性
    if (versionData.electronVersion && versionData.electronVersion !== process.versions.electron) {
      log(`[Bootstrap] Electron 版本不匹配: 热更新=${versionData.electronVersion}, 当前=${process.versions.electron}，加载内置版本`)
      invalidateUpdate(versionFile, versionData, 'Electron版本不匹配')
      require(BUILT_IN_ENTRY)
      return
    }

    // 校验 baseVersion 兼容性
    if (versionData.baseVersion) {
      const appVersion = app.getVersion()
      if (!isVersionCompatible(appVersion, versionData.baseVersion)) {
        log(`[Bootstrap] baseVersion 不兼容: 当前app=${appVersion}, 要求base=${versionData.baseVersion}，加载内置版本`)
        invalidateUpdate(versionFile, versionData, 'baseVersion不兼容')
        require(BUILT_IN_ENTRY)
        return
      }
    }

    // 校验 mainSha256（如果 version.json 中有）
    if (versionData.mainSha256) {
      const actualHash = sha256File(hotMainJsc)
      if (actualHash !== versionData.mainSha256) {
        log('[Bootstrap] mainSha256 校验失败，可能被篡改，加载内置版本')
        invalidateUpdate(versionFile, versionData, 'mainSha256校验失败')
        require(BUILT_IN_ENTRY)
        return
      }
    }

    // 所有校验通过，加载热更新版本
    log('[Bootstrap] 加载主进程热更新: ' + hotMainJs)
    try {
      require(hotMainJs)
    } catch (loadErr) {
      // bytenode 加载不兼容的 .jsc 时会抛出 "Invalid or incompatible cached data" 等错误
      log('[Bootstrap] 热更新加载失败: ' + loadErr.message + '，降级到内置版本')
      invalidateUpdate(versionFile, versionData, '加载失败: ' + loadErr.message)
      require(BUILT_IN_ENTRY)
    }
  } catch (err) {
    log('[Bootstrap] 热更新检查异常: ' + err.message + '，加载内置版本')
    require(BUILT_IN_ENTRY)
  }
}

// 版本号比较：appVersion >= baseVersion 视为兼容
function isVersionCompatible(appVersion, baseVersion) {
  const parseV = (v) => {
    const parts = String(v || '0.0.0').split('.').map(Number)
    return parts[0] * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0)
  }
  return parseV(appVersion) >= parseV(baseVersion)
}

// 计算文件 SHA256
function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

// 标记热更新无效（不删除文件，保留用于排查）
function invalidateUpdate(versionFile, versionData, reason) {
  try {
    versionData.mainUpdate = false
    versionData.invalidationReason = reason
    versionData.invalidatedAt = new Date().toISOString()
    fs.writeFileSync(versionFile, JSON.stringify(versionData, null, 2), 'utf-8')
  } catch (e) {
    // 忽略写入失败
  }
}

// 写日志到 userData 目录
function log(msg) {
  console.log(msg)
  try {
    const logFile = path.join(app.getPath('userData'), 'hot-update-bootstrap.log')
    const line = `[${new Date().toISOString()}] ${msg}\n`
    fs.appendFileSync(logFile, line, 'utf-8')
  } catch (e) {
    // 忽略日志写入失败
  }
}

// 执行引导
bootstrap()
