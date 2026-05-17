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
  if (state === 'downloading' || state === 'ready') return // 下载中或已就绪不重复检查

  // 从 error 状态恢复，允许重试
  if (state === 'error') {
    console.log('[UpdateManager] 从 error 状态恢复，重新检查更新')
    state = 'idle'
  }

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

    // 全量更新：主进程自动下载，不依赖渲染进程
    // 渲染进程可能因热更新损坏导致 electronAPI 不可用，无法手动触发下载
    if (result.updateType === 'full') {
      console.log('[UpdateManager] 检测到全量更新，自动开始下载...')
      startDownload()
    }
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
  let autoUpdater
  try {
    autoUpdater = getAutoUpdater()
  } catch (err) {
    state = 'error'
    send('um-update-error', { message: '全量更新不可用: ' + err.message })
    return
  }

  // 先触发 electron-updater 的 checkForUpdates，它会验证 latest.yml
  // 然后自动触发 download-progress 和 update-downloaded 事件
  autoUpdater.checkForUpdates().then((result) => {
    if (result && result.updateInfo) {
      const fullVersion = result.updateInfo.version
      const appVersion = app.getVersion()
      // 防止下载同版本或更低版本的全量包（热更新版本可能高于全量版本）
      if (parseVersion(fullVersion) <= parseVersion(appVersion)) {
        console.log('[UpdateManager] 全量版本', fullVersion, '<= 当前版本', appVersion, '，跳过下载')
        state = 'error'
        send('um-update-error', { message: '当前已是最新版本' })
        return
      }
      console.log('[UpdateManager] electron-updater 确认版本:', fullVersion)
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
    console.log('[UpdateManager] 热更新已就绪，重启后生效')
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
    let autoUpdater
    try {
      autoUpdater = getAutoUpdater()
    } catch (err) {
      state = 'error'
      send('um-update-error', { message: '更新失败: ' + hotError })
      return
    }
    const fullResult = await autoUpdater.checkForUpdates()

    if (fullResult && fullResult.updateInfo) {
      const fullVersion = fullResult.updateInfo.version
      const appVersion = app.getVersion()
      // 只有全量版本 > 当前 appVersion 才降级，否则会下载同版本导致死循环
      if (parseVersion(fullVersion) > parseVersion(appVersion)) {
        currentUpdateType = 'full'
        updateInfo = { ...updateInfo, version: fullVersion, type: 'full' }
        console.log('[UpdateManager] 降级到全量更新:', fullVersion)
        send('um-update-available', {
          version: fullVersion,
          type: 'full',
          size: 0,
          changelog: '快速更新失败，将使用完整更新',
          force: false
        })
        state = 'idle'
      } else {
        console.log('[UpdateManager] 全量版本', fullVersion, '<= 当前版本', appVersion, '，不降级')
        state = 'error'
        send('um-update-error', { message: '更新失败: ' + hotError })
      }
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
  state = 'installing' // 防止定时器重复触发
  if (currentUpdateType === 'full') {
    try {
      const autoUpdater = getAutoUpdater()
      autoUpdater.quitAndInstall(true, true)
    } catch (err) {
      console.error('[UpdateManager] 全量更新安装失败:', err.message)
      app.relaunch()
      app.exit(0)
    }
  } else if (currentUpdateType === 'hot') {
    // 先启动新实例，延迟退出当前实例，确保新进程成功启动
    app.relaunch()
    setTimeout(() => {
      app.exit(0)
    }, 500)
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

  // 代理 electron-updater 事件到统一事件流（autoUpdater 初始化失败则跳过）
  let autoUpdater = null
  try {
    autoUpdater = getAutoUpdater()
  } catch (err) {
    console.error('[UpdateManager] autoUpdater 不可用，全量更新功能禁用:', err.message)
  }

  if (autoUpdater) {
    autoUpdater.on('download-progress', (progressObj) => {
      send('um-update-progress', { percent: Math.round(progressObj.percent) })
    })

    autoUpdater.on('update-downloaded', (info) => {
      console.log('[UpdateManager] 全量更新下载完成:', info.version)
      state = 'ready'
      send('um-update-ready', { type: 'full' })
      // 自救：15 秒后如果渲染进程未触发安装，主进程自动安装重启
      // 应对 electronAPI 损坏导致渲染进程无法调用 um-install 的场景
      setTimeout(() => {
        if (state === 'ready' && currentUpdateType === 'full') {
          console.log('[UpdateManager] 渲染进程未响应安装请求，自动安装重启...')
          installAndRestart()
        }
      }, 15000)
    })

    autoUpdater.on('error', (err) => {
      console.error('[UpdateManager] electron-updater 错误:', err.message)
      if (state === 'downloading') {
        state = 'error'
        send('um-update-error', { message: '全量更新失败: ' + err.message })
      }
    })
  }

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
