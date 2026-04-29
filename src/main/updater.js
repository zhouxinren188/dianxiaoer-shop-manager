const { autoUpdater } = require('electron-updater')
const { ipcMain, BrowserWindow, dialog } = require('electron')
const path = require('path')

let mainWindow = null

// 发送消息到渲染进程
function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

// 初始化自动更新
function initUpdater(win) {
  mainWindow = win

  // 开发模式下模拟更新或跳过检查
  if (!require('electron').app.isPackaged) {
    console.log('[Updater] 开发模式，跳过自动更新检查')
    return
  }

  // 配置日志
  autoUpdater.logger = console
  autoUpdater.autoDownload = false // 先不自动下载，让用户确认
  autoUpdater.autoInstallOnAppQuit = true

  // 检查更新错误
  autoUpdater.on('error', (err) => {
    console.error('[Updater] 检查更新出错:', err.message)
    sendToRenderer('update-error', { message: err.message })
  })

  // 发现可用更新
  autoUpdater.on('update-available', (info) => {
    console.log('[Updater] 发现新版本:', info.version)
    sendToRenderer('update-available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    })
  })

  // 当前已是最新版本
  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] 当前已是最新版本')
    sendToRenderer('update-not-available')
  })

  // 下载进度
  autoUpdater.on('download-progress', (progressObj) => {
    sendToRenderer('update-progress', {
      percent: Math.round(progressObj.percent),
      bytesPerSecond: progressObj.bytesPerSecond,
      transferred: progressObj.transferred,
      total: progressObj.total
    })
  })

  // 更新下载完成
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[Updater] 更新下载完成:', info.version)
    sendToRenderer('update-downloaded', {
      version: info.version
    })
  })

  // 启动时延迟检查更新（避免启动过慢）
  setTimeout(() => {
    checkForUpdates()
  }, 5000)

  // 每 30 分钟检查一次
  setInterval(() => {
    checkForUpdates()
  }, 30 * 60 * 1000)
}

// 检查更新
function checkForUpdates() {
  if (!require('electron').app.isPackaged) return
  console.log('[Updater] 正在检查更新...')
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[Updater] 检查更新失败:', err.message)
  })
}

// 开始下载更新
function startDownload() {
  autoUpdater.downloadUpdate().catch((err) => {
    console.error('[Updater] 下载更新失败:', err.message)
    sendToRenderer('update-error', { message: '下载失败: ' + err.message })
  })
}

// 安装更新并重启
function quitAndInstall() {
  autoUpdater.quitAndInstall(true, true)
}

// 注册 IPC 通道
function registerIpc() {
  ipcMain.handle('check-for-updates', () => {
    checkForUpdates()
    return { success: true }
  })

  ipcMain.handle('start-download-update', () => {
    startDownload()
    return { success: true }
  })

  ipcMain.handle('quit-and-install', () => {
    quitAndInstall()
    return { success: true }
  })
}

module.exports = {
  initUpdater,
  registerIpc
}
