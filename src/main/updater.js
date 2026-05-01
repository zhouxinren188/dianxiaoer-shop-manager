const { autoUpdater } = require('electron-updater')

// 配置 autoUpdater（由 update-manager 调用）
function configureUpdater() {
  autoUpdater.logger = console
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
}

// 返回 autoUpdater 实例，供 update-manager 注册事件和调用方法
function getAutoUpdater() {
  return autoUpdater
}

module.exports = {
  configureUpdater,
  getAutoUpdater
}
