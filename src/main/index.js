const { app, BrowserWindow, Menu, session, ipcMain } = require('electron')
const path = require('path')
const { initUpdater, registerIpc } = require('./updater')
const { getHotUpdateRendererPath, registerHotUpdateIpc, autoCheckHotUpdate } = require('./hot-updater')
const { registerPlatformWindowIpc } = require('./platform-window')
const { registerPacketCaptureIpc } = require('./packet-capture')
const { registerSupplyOrderIpc } = require('./supply-order-fetch')
const { registerSalesOrderIpc } = require('./sales-order-fetch')
const { startHeartbeat } = require('./cookie-heartbeat')
const { startServer } = require('./server')

// 允许自签名证书（仅用于连接内部服务器API）
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (url.includes('150.158.54.108')) {
    event.preventDefault()
    callback(true)
  } else {
    callback(false)
  }
})

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 620,
    height: 400,
    resizable: false,
    title: '店小二网店管家',
    frame: false,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 生产模式隐藏菜单栏 & 禁用 DevTools 快捷键
  if (app.isPackaged) {
    Menu.setApplicationMenu(null)
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' ||
        (input.control && input.shift && (input.key === 'I' || input.key === 'i' || input.key === 'J' || input.key === 'j' || input.key === 'C' || input.key === 'c')) ||
        (input.control && (input.key === 'U' || input.key === 'u'))) {
        event.preventDefault()
      }
    })
  }

  // 右键菜单（剪切/复制/粘贴/全选/刷新）
  mainWindow.webContents.on('context-menu', (event, params) => {
    const menu = Menu.buildFromTemplate([
      { label: '剪切', role: 'cut', enabled: params.editFlags.canCut },
      { label: '复制', role: 'copy', enabled: params.editFlags.canCopy },
      { label: '粘贴', role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: '全选', role: 'selectAll' },
      { type: 'separator' },
      { label: '刷新页面', role: 'reload' }
    ])
    menu.popup()
  })

  // 加载页面
  if (app.isPackaged) {
    // 生产模式：优先加载热更新目录，否则加载内置文件
    const hotRendererPath = getHotUpdateRendererPath()
    if (hotRendererPath) {
      console.log('[Main] 从热更新目录加载:', hotRendererPath)
      mainWindow.loadFile(hotRendererPath)
    } else {
      mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
    }
  } else {
    // 开发模式：加载 vite 开发服务器
    const devUrl = process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173'
    mainWindow.loadURL(devUrl).catch(err => {
      console.error('loadURL failed:', err.message)
      const altUrl = devUrl.replace('5173', '5174')
      mainWindow.loadURL(altUrl).catch(err2 => {
        console.error('Alternate URL also failed:', err2.message)
      })
    })
  }

  return mainWindow
}

// 注册窗口控制 IPC
ipcMain.handle('window-minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize()
})
ipcMain.handle('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) win.isMaximized() ? win.unmaximize() : win.maximize()
})
ipcMain.handle('window-close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close()
})
ipcMain.handle('open-external-url', (event, { url }) => {
  if (!url) return { success: false, message: '网址为空' }

  const urlWin = new BrowserWindow({
    width: 1200,
    height: 800,
    title: new URL(url).hostname,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  urlWin.loadURL(url).catch(err => {
    console.error('[OpenURL] loadURL failed:', err.message)
  })

  // 如果正在抓包，立即监听此窗口的 session
  try {
    const { isCapturing, getCaptureCallback } = require('./packet-capture')
    if (isCapturing()) {
      urlWin.webContents.session.webRequest.onCompleted({ urls: ['*://*/*'] }, getCaptureCallback())
    }
  } catch {
    // packet-capture 模块未加载时忽略
  }

  return { success: true }
})

// 窗口尺寸切换：登录页 <-> 主页
ipcMain.handle('window-set-login-size', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  win.webContents.closeDevTools()
  win.setResizable(true)
  win.setMinimumSize(620, 400)
  win.setSize(620, 400)
  win.setResizable(false)
  win.center()
})
ipcMain.handle('window-set-main-size', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  win.setResizable(true)
  win.setMinimumSize(1024, 680)
  win.maximize()
})

// 注册更新 IPC 通道
registerIpc()

// 注册抓包 IPC（使用 ipcMain.handle，需在 app.whenReady 前注册）
registerPacketCaptureIpc()

// 注册供销订单获取 IPC
registerSupplyOrderIpc()

// 注册销售订单获取 IPC
registerSalesOrderIpc()

app.whenReady().then(async () => {
  // 启动本地后端服务
  startServer(3002)

  // 允许 renderer 进程 fetch 访问自签名 HTTPS API
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (request.hostname === '150.158.54.108') {
      callback(0)
    } else {
      callback(-3)
    }
  })

  // 启动前清除缓存，防止旧缓存导致页面内容错误
  try {
    await session.defaultSession.clearCache()
  } catch (e) {
    // 忽略清理失败
  }

  const mainWindow = createWindow()

  // 初始化自动更新（electron-updater，GitHub Release 全量更新）
  initUpdater(mainWindow)

  // 注册热更新 IPC 通道
  registerHotUpdateIpc(mainWindow)

  // 启动后延迟检查热更新
  setTimeout(() => autoCheckHotUpdate(mainWindow), 6000)

  // 注册平台窗口 IPC（需要 mainWindow 引用）
  registerPlatformWindowIpc(mainWindow)

  // 启动心跳检测
  startHeartbeat(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
