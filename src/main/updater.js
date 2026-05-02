const { autoUpdater } = require('electron-updater')
const http = require('http')
const https = require('https')

// HTTP 和 HTTPS agent
const httpAgent = new http.Agent()
const httpsAgent = new https.Agent({ rejectUnauthorized: false })

// 配置 autoUpdater（由 update-manager 调用）
function configureUpdater() {
  autoUpdater.logger = console
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  // 支持 HTTP 和 HTTPS（服务器使用 HTTP）
  autoUpdater.requestOptions = { 
    agent: (parsedUrl) => parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent
  }
  autoUpdater.downloadUpdateOptions = { 
    agent: (parsedUrl) => parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent
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
