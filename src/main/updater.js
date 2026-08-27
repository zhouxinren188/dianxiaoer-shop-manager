const http = require('http')
const https = require('https')
const fs = require('fs')
const { getStoragePaths } = require('./storage-manager')

// HTTP 和 HTTPS agent
const httpAgent = new http.Agent()
const httpsAgent = new https.Agent({ rejectUnauthorized: false })

// 延迟加载 autoUpdater，避免版本号不合规时在模块加载阶段就崩溃
let _autoUpdater = null

function getAutoUpdater() {
  if (!_autoUpdater) {
    const { autoUpdater } = require('electron-updater')
    _autoUpdater = autoUpdater
  }
  return _autoUpdater
}

function configureUpdaterCacheBase(autoUpdater, updaterCacheBaseDir) {
  if (!updaterCacheBaseDir || !autoUpdater?.app) return false
  fs.mkdirSync(updaterCacheBaseDir, { recursive: true })
  Object.defineProperty(autoUpdater.app, 'baseCachePath', {
    configurable: true,
    get: () => updaterCacheBaseDir
  })
  return autoUpdater.app.baseCachePath === updaterCacheBaseDir
}

// 配置 autoUpdater（由 update-manager 调用）
function configureUpdater() {
  try {
    const autoUpdater = getAutoUpdater()
    autoUpdater.logger = console
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    // electron-updater defaults to LOCALAPPDATA on Windows. Override its app
    // adapter before the download helper is created so full installers are
    // cached on the same managed data drive as Electron sessionData.
    const updaterCacheBaseDir = getStoragePaths().updaterCacheBaseDir
    if (!configureUpdaterCacheBase(autoUpdater, updaterCacheBaseDir)) {
      console.warn('[Updater] 未能切换安装包缓存目录，将由 electron-updater 使用默认路径')
    }

    // 支持 HTTP 和 HTTPS（服务器使用 HTTP）
    autoUpdater.requestOptions = {
      agent: (parsedUrl) => parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent
    }
    autoUpdater.downloadUpdateOptions = {
      agent: (parsedUrl) => parsedUrl.protocol === 'https:' ? httpsAgent : httpAgent
    }
  } catch (err) {
    console.error('[Updater] autoUpdater 初始化失败（版本号可能不合规）:', err.message)
  }
}

module.exports = {
  configureUpdaterCacheBase,
  configureUpdater,
  getAutoUpdater
}
