/**
 * runtime-logger.js — 运行日志写入模块
 *
 * 将关键运行日志写入桌面上的 "店小二运行日志.txt" 文件，
 * 方便用户版出现问题时导出日志给开发者排查。
 *
 * 日志文件位置: 用户桌面 / 店小二运行日志.txt
 * 每次启动自动追加，不清空旧日志（保留历史上下文）
 * 日志超过 2MB 自动截断保留尾部
 */

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const LOG_FILE_NAME = '店小二运行日志.txt'
const MAX_LOG_SIZE = 2 * 1024 * 1024 // 2MB

let logFilePath = null

function getLogFilePath() {
  if (logFilePath) return logFilePath
  // 用户桌面路径
  logFilePath = path.join(require('os').homedir(), 'Desktop', LOG_FILE_NAME)
  return logFilePath
}

function truncateLogIfNeeded() {
  try {
    const stats = fs.statSync(getLogFilePath())
    if (stats.size > MAX_LOG_SIZE) {
      // 截断：保留最后 1MB 的内容
      const content = fs.readFileSync(getLogFilePath(), 'utf-8')
      const keepSize = 1024 * 1024
      const truncated = content.slice(content.length - keepSize)
      fs.writeFileSync(getLogFilePath(), truncated, 'utf-8')
    }
  } catch (e) {
    // 文件不存在，无需截断
  }
}

function writeLog(tag, message) {
  try {
    const timestamp = new Date().toLocaleString('zh-CN', { hour12: false })
    const line = `[${timestamp}] [${tag}] ${message}\n`
    fs.appendFileSync(getLogFilePath(), line, 'utf-8')
  } catch (e) {
    // 写日志失败不应该影响主流程
    console.error('[RuntimeLogger] 写日志失败:', e.message)
  }
}

// 启动时写入分隔线
function logStartup(version) {
  truncateLogIfNeeded()
  writeLog('START', `========== 店小二 v${version} 启动 ==========`)
  writeLog('START', `appPath: ${app.getAppPath()}`)
  writeLog('START', `userData: ${app.getPath('userData')}`)
  writeLog('START', `日志文件: ${getLogFilePath()}`)
  try {
    // 检查 purchase-preload.js 是否存在于 asar.unpacked 目录
    const asarUnpackedPath = path.join(
      path.dirname(app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')),
      'app.asar.unpacked',
      'out', 'main', 'purchase-preload.js'
    )
    // 更简单的方式：直接从 app.asar.unpacked 的父目录查找
    const resourcesDir = path.dirname(app.getAppPath())
    const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked')
    const preloadInUnpacked = path.join(unpackedDir, 'out', 'main', 'purchase-preload.js')
    const loginPreloadInUnpacked = path.join(unpackedDir, 'resources', 'platform-login-preload.js')
    writeLog('START', `preload在asar.unpacked: ${fs.existsSync(preloadInUnpacked) ? 'YES ✓' : 'NO ✗'} (${preloadInUnpacked})`)
    writeLog('START', `loginPreload在asar.unpacked: ${fs.existsSync(loginPreloadInUnpacked) ? 'YES ✓' : 'NO ✗'} (${loginPreloadInUnpacked})`)
  } catch (e) {
    writeLog('START', `检查asar.unpacked失败: ${e.message}`)
  }
}

module.exports = {
  writeLog,
  logStartup,
  getLogFilePath
}