const { autoUpdater } = require('electron-updater')
const https = require('https')

// 配置 autoUpdater（由 update-manager 调用）
function configureUpdater() {
  autoUpdater.logger = console
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  // 信任自签名证书（用于连接自建 HTTPS 更新服务器）
  autoUpdater.requestHeaders = {}
  autoUpdater.downloadUpdateOptions = {
    // 配置自定义 HTTPS agent 信任自签名证书
    agent: new https.Agent({ rejectUnauthorized: false })
  }
}

// 返回 autoUpdater 实例，供 update-manager 注册事件和调用方法
function getAutoUpdater() {
  return autoUpdater
}

module.exports = {
  configureUpdater,
  getAutoUpdater
}
