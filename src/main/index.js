const { app, BrowserWindow, Menu, session } = require('electron')
const path = require('path')
const { initUpdater, registerIpc } = require('./updater')

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    title: '店小二网店管家',
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
    // 生产模式：加载本地构建文件
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
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

  // 开发模式打开 DevTools
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools()
  }

  return mainWindow
}

// 注册 IPC 通道
registerIpc()

app.whenReady().then(async () => {
  // 启动前清除缓存，防止旧缓存导致页面内容错误
  try {
    await session.defaultSession.clearCache()
  } catch (e) {
    // 忽略清理失败
  }

  const mainWindow = createWindow()

  // 初始化自动更新
  initUpdater(mainWindow)

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
