const { autoUpdater } = require('electron-updater')
const https = require('https')

// 信任自签名证书的 HTTPS agent
const httpsAgent = new https.Agent({ rejectUnauthorized: false })

// 配置 autoUpdater（由 update-manager 调用）
function configureUpdater() {
  autoUpdater.logger = console
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  // 信任自签名证书（用于连接自建 HTTPS 更新服务器）
  autoUpdater.requestOptions = { agent: httpsAgent }
  autoUpdater.downloadUpdateOptions = { agent: httpsAgent }
}

// 返回 autoUpdater 实例，供 update-manager 注册事件和调用方法
function getAutoUpdater() {
  return autoUpdater
}

module.exports = {
  configureUpdater,
  getAutoUpdater
}
