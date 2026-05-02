const { app, ipcMain } = require('electron')
const http = require('http')
const { configureUpdater, getAutoUpdater } = require('./updater')
const { getCurrentVersion, clearHotUpdate, downloadAndApplyUpdate } = require('./hot-updater')

const UPDATE_SERVER = 'http://150.158.54.108:3001'

let mainWindow = null
let state = 'idle' // idle | checking | downloading | ready | error
let currentUpdateType = null // 'full' | 'hot' | null
let updateInfo = null // 服务端返回的更新信息
let retryCount = 0
const MAX_RETRY = 3

// 发送事件到渲染进程
function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

// 版本号比较
function parseVersion(v) {
  const parts = String(v || '0.0.0').split('.').map(Number)
  return parts[0] * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0)
}

// 向服务端查询更新
function checkServerForUpdate() {
  return new Promise((resolve, reject) => {
    const hotVersion = getCurrentVersion()
    const appVersion = app.getVersion()
    const url = `${UPDATE_SERVER}/api/update/check?version=${hotVersion}&appVersion=${appVersion}`

    http.get(url, { timeout: 8000 }, (res) => {
      let data = ''
      res.on('data', chunk => (data += chunk))
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error('JSON parse error')) }
      })
    }).on('error', reject)
      .on('timeout', function () { this.destroy(); reject(new Error('timeout')) })
  })
}

// 检查更新（manual=true 时为手动触发，失败会通知前端）
async function checkForUpdates(manual = false) {
  if (state === 'downloading') return // 正在下载中不重复检查

  state = 'checking'
  try {
    const result = await checkServerForUpdate()
    console.log('[UpdateManager] 检查结果:', JSON.stringify(result))

    if (!result.needUpdate || result.updateType === 'none') {
      state = 'idle'
      if (manual) send('um-no-update', {})
      return
    }

    updateInfo = result
    currentUpdateType = result.updateType
    state = 'idle'

    send('um-update-available', {
      version: result.version,
      type: result.updateType,
      size: result.size || 0,
      changelog: result.changelog || '',
      sha256: result.sha256 || '',
      force: result.force || false
    })
  } catch (e) {
    state = 'idle'
    console.log('[UpdateManager] 检查更新失败:', e.message)
    if (manual) {
      send('um-update-error', { message: '检查更新失败: ' + e.message })
    }
  }
}

// 开始下载
async function startDownload() {
  if (state === 'downloading' || !updateInfo || !currentUpdateType) return

  state = 'downloading'
  retryCount = 0

  if (currentUpdateType === 'full') {
    startFullDownload()
  } else if (currentUpdateType === 'hot') {
    startHotDownload()
  }
}

// 全量更新下载（通过 electron-updater）
function startFullDownload() {
  const autoUpdater = getAutoUpdater()

  // 先触发 electron-updater 的 checkForUpdates，它会验证 latest.yml
  // 然后自动触发 download-progress 和 update-downloaded 事件
  autoUpdater.checkForUpdates().then((result) => {
    if (result && result.updateInfo) {
      console.log('[UpdateManager] electron-updater 确认版本:', result.updateInfo.version)
      autoUpdater.downloadUpdate().catch((err) => {
        console.error('[UpdateManager] 全量下载失败:', err.message)
        state = 'error'
        send('um-update-error', { message: '全量下载失败: ' + err.message })
      })
    } else {
      state = 'error'
      send('um-update-error', { message: '全量更新包未找到' })
    }
  }).catch((err) => {
    console.error('[UpdateManager] 全量更新检查失败:', err.message)
    state = 'error'
    send('um-update-error', { message: '全量更新失败: ' + err.message })
  })
}

// 热更新下载
async function startHotDownload() {
  const downloadUrl = `${UPDATE_SERVER}/api/update/download`
  const expectedSha256 = updateInfo.sha256 || ''

  try {
    await downloadAndApplyUpdate(downloadUrl, expectedSha256, (percent) => {
      send('um-update-progress', { percent })
    })
    state = 'ready'
    send('um-update-ready', { type: 'hot' })
  } catch (e) {
    console.error('[UpdateManager] 热更新失败:', e.message)
    // 降级：尝试全量更新
    console.log('[UpdateManager] 热更新失败，尝试降级到全量更新...')
    await fallbackToFullUpdate(e.message)
  }
}

// 热更新失败 → 降级到全量更新
async function fallbackToFullUpdate(hotError) {
  try {
    const result = await checkServerForUpdate()
    // 检查是否有全量更新可用（用 appVersion 和 full.version 比较）
    // 即使服务端返回 hot，我们这里也尝试用 full
    const autoUpdater = getAutoUpdater()
    const fullResult = await autoUpdater.checkForUpdates()

    if (fullResult && fullResult.updateInfo) {
      currentUpdateType = 'full'
      updateInfo = { ...updateInfo, version: fullResult.updateInfo.version, type: 'full' }
      console.log('[UpdateManager] 降级到全量更新:', fullResult.updateInfo.version)
      send('um-update-available', {
        version: fullResult.updateInfo.version,
        type: 'full',
        size: 0,
        changelog: '快速更新失败，将使用完整更新',
        force: false
      })
      state = 'idle'
    } else {
      state = 'error'
      send('um-update-error', { message: '更新失败: ' + hotError + '（无可用的完整更新包）' })
    }
  } catch (e) {
    state = 'error'
    send('um-update-error', { message: '更新失败: ' + hotError })
  }
}

// 安装并重启
function installAndRestart() {
  if (currentUpdateType === 'full') {
    const autoUpdater = getAutoUpdater()
    autoUpdater.quitAndInstall(true, true)
  } else if (currentUpdateType === 'hot') {
    app.relaunch()
    app.exit(0)
  }
}

// 启动时清理过期热更新（全量更新安装后）
function cleanupStaleHotUpdate() {
  const hotVersion = getCurrentVersion()
  const appVersion = app.getVersion()
  if (parseVersion(appVersion) >= parseVersion(hotVersion) && hotVersion !== appVersion) {
    // app 版本已经 >= 热更新版本，说明全量更新过了，清理旧的热更新
    clearHotUpdate()
    console.log('[UpdateManager] 已清理过期热更新 (app:', appVersion, 'hot:', hotVersion, ')')
  }
}

// 初始化统一更新管理器
function initUpdateManager(win) {
  mainWindow = win

  if (!app.isPackaged) {
    console.log('[UpdateManager] 开发模式，跳过更新检查')
    registerIpc()
    return
  }

  // 允许自签名证书（用于连接自建 HTTPS 更新服务器）
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  // 配置 electron-updater
  configureUpdater()

  // 代理 electron-updater 事件到统一事件流
  const autoUpdater = getAutoUpdater()

  autoUpdater.on('download-progress', (progressObj) => {
    send('um-update-progress', { percent: Math.round(progressObj.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[UpdateManager] 全量更新下载完成:', info.version)
    state = 'ready'
    send('um-update-ready', { type: 'full' })
  })

  autoUpdater.on('error', (err) => {
    console.error('[UpdateManager] electron-updater 错误:', err.message)
    if (state === 'downloading') {
      state = 'error'
      send('um-update-error', { message: '全量更新失败: ' + err.message })
    }
  })

  // 清理过期热更新
  cleanupStaleHotUpdate()

  // 注册 IPC
  registerIpc()

  // 启动时立即检查更新（1秒后，给窗口渲染留时间）
  setTimeout(() => checkForUpdates(false), 1000)

  // 每 30 分钟检查一次
  setInterval(() => checkForUpdates(false), 30 * 60 * 1000)
}

// 注册 IPC 通道
function registerIpc() {
  ipcMain.handle('um-check', async () => {
    await checkForUpdates(true)
    return { success: true }
  })

  ipcMain.handle('um-download', async () => {
    await startDownload()
    return { success: true }
  })

  ipcMain.handle('um-install', () => {
    installAndRestart()
    return { success: true }
  })
}

module.exports = {
  initUpdateManager
}
