const { app, BrowserWindow, Menu, session, ipcMain } = require('electron')
const path = require('path')
const { initUpdater, registerIpc } = require('./updater')
const { getHotUpdateRendererPath, registerHotUpdateIpc, autoCheckHotUpdate } = require('./hot-updater')

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

  // 生产模式隐藏菜单栏
  if (app.isPackaged) {
    Menu.setApplicationMenu(null)
  }

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
  win.setSize(1280, 800)
  win.center()
  // 开发模式切换到主界面时打开 DevTools
  if (!require('electron').app.isPackaged) {
    win.webContents.openDevTools()
  }
})

// 注册更新 IPC 通道
registerIpc()

app.whenReady().then(async () => {
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
