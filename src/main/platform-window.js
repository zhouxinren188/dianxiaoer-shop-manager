const { BrowserWindow, ipcMain, session } = require('electron')
const path = require('path')
const http = require('http')
const https = require('https')

const BUSINESS_SERVER = 'http://150.158.54.108:3002'

// 平台后台 URL 映射
const PLATFORM_URLS = {
  taobao: 'https://myseller.taobao.com/',
  tmall: 'https://myseller.taobao.com/',
  jd: 'https://shop.jd.com/',
  pdd: 'https://mms.pinduoduo.com/',
  douyin: 'https://fxg.jinritemai.com/'
}

// Cookie 提取域名映射
const PLATFORM_COOKIE_URLS = {
  taobao: 'https://taobao.com',
  tmall: 'https://taobao.com',
  jd: 'https://jd.com',
  pdd: 'https://pinduoduo.com',
  douyin: 'https://jinritemai.com'
}

// 已打开的平台窗口 Map<storeId, BrowserWindow>
const platformWindows = new Map()
// 店铺平台映射 Map<storeId, platform>
const storePlatforms = new Map()
// 暂存登录凭证 Map<storeId, {account, password}>
const storeCredentials = new Map()

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const urlObj = new URL(url)
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 10000
    }

    const req = mod.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ statusCode: res.statusCode, data }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })
    if (options.body) req.write(options.body)
    req.end()
  })
}

function registerPlatformWindowIpc(mainWindow) {
  // 平台窗口 preload 脚本路径（__dirname 构建后为 out/main/）
  const preloadPath = path.join(__dirname, '../../resources/platform-login-preload.js')
  console.log('[PlatformWindow] preload path:', preloadPath)

  // 打开平台登录窗口
  ipcMain.handle('open-platform-window', async (event, { storeId, platform }) => {
    // 检查是否已打开
    if (platformWindows.has(storeId)) {
      const existWin = platformWindows.get(storeId)
      if (!existWin.isDestroyed()) {
        existWin.focus()
        return { success: true, message: '窗口已打开' }
      }
      platformWindows.delete(storeId)
    }

    const targetUrl = PLATFORM_URLS[platform]
    if (!targetUrl) {
      return { success: false, message: `不支持的平台: ${platform}` }
    }

    // 使用独立 partition 隔离 Cookie
    const partitionName = `persist:platform-${storeId}`

    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      title: `店铺登录 - ${platform}`,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: partitionName,
        preload: preloadPath
      }
    })

    win.loadURL(targetUrl)

    platformWindows.set(storeId, win)
    storePlatforms.set(storeId, platform)
    storeCredentials.delete(storeId)

    win.on('closed', () => {
      platformWindows.delete(storeId)
      storePlatforms.delete(storeId)
      storeCredentials.delete(storeId)
    })

    return { success: true }
  })

  // 监听账号密码输入（平台窗口 preload 发送）
  ipcMain.on('platform-login-credentials', (event, { account, password }) => {
    for (const [sid, win] of platformWindows.entries()) {
      if (win.webContents === event.sender) {
        storeCredentials.set(sid, { account, password })
        break
      }
    }
  })

  // 监听自动登录成功（平台窗口 preload 发送）
  ipcMain.on('platform-auto-login-success', async (event, { account, password }) => {
    for (const [sid, win] of platformWindows.entries()) {
      if (win.webContents === event.sender) {
        const cred = storeCredentials.get(sid) || {}
        await handleAutoLoginSuccess(mainWindow, sid, account || cred.account, password || cred.password)
        break
      }
    }
  })

  // 确认登录，抓取 Cookie
  ipcMain.handle('confirm-platform-login', async (event, { storeId, platform }) => {
    const win = platformWindows.get(storeId)
    if (!win || win.isDestroyed()) {
      return { success: false, message: '平台窗口未打开或已关闭' }
    }

    const cookieUrl = PLATFORM_COOKIE_URLS[platform]
    if (!cookieUrl) {
      return { success: false, message: `不支持的平台: ${platform}` }
    }

    try {
      // 从独立 session 获取 Cookie
      const partitionName = `persist:platform-${storeId}`
      const ses = session.fromPartition(partitionName)
      const cookies = await ses.cookies.get({ url: cookieUrl })

      if (!cookies || cookies.length === 0) {
        return { success: false, message: '未获取到 Cookie，请确保已登录' }
      }

      const cookieData = JSON.stringify(cookies)
      const domain = new URL(cookieUrl).hostname

      // 保存 Cookie 到业务服务器
      await httpRequest(`${BUSINESS_SERVER}/api/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_id: storeId, cookie_data: cookieData, domain })
      })

      // 更新在线状态
      await httpRequest(`${BUSINESS_SERVER}/api/stores/${storeId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ online: true })
      })

      // 通知渲染进程
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('platform-login-success', { storeId })
      }

      // 关闭平台窗口
      win.close()

      return { success: true }
    } catch (err) {
      console.error('[PlatformWindow] confirm-platform-login error:', err.message)
      return { success: false, message: err.message }
    }
  })

  // 关闭平台窗口
  ipcMain.handle('close-platform-window', async (event, { storeId }) => {
    const win = platformWindows.get(storeId)
    if (win && !win.isDestroyed()) {
      win.close()
    }
    platformWindows.delete(storeId)
    storePlatforms.delete(storeId)
    storeCredentials.delete(storeId)
    return { success: true }
  })
}

// 自动保存登录信息（Cookie + 账号密码）
async function handleAutoLoginSuccess(mainWindow, storeId, account, password) {
  const platform = storePlatforms.get(storeId)
  const win = platformWindows.get(storeId)
  if (!platform || !win) return

  console.log('[PlatformWindow] 检测到登录成功，自动保存信息 storeId=', storeId, 'account=', account)

  const cookieUrl = PLATFORM_COOKIE_URLS[platform]

  try {
    // 1. 抓取 Cookie
    const partitionName = `persist:platform-${storeId}`
    const ses = session.fromPartition(partitionName)
    const cookies = await ses.cookies.get({ url: cookieUrl })

    if (cookies && cookies.length > 0) {
      const cookieData = JSON.stringify(cookies)
      const domain = new URL(cookieUrl).hostname

      // 2. 保存 Cookie
      await httpRequest(`${BUSINESS_SERVER}/api/cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ store_id: storeId, cookie_data: cookieData, domain })
      })
    }

    // 3. 更新店铺信息（账号、密码、在线状态）
    const updateBody = {}
    if (account) updateBody.account = account
    if (password) updateBody.password = password

    if (Object.keys(updateBody).length > 0) {
      await httpRequest(`${BUSINESS_SERVER}/api/stores/${storeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateBody)
      })
    }

    // 4. 更新在线状态
    await httpRequest(`${BUSINESS_SERVER}/api/stores/${storeId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ online: true })
    })

    // 5. 通知主窗口
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('platform-login-success', { storeId, account })
    }

    // 6. 关闭平台窗口
    if (!win.isDestroyed()) {
      win.close()
    }

    console.log('[PlatformWindow] 自动保存完成 storeId=', storeId)
  } catch (err) {
    console.error('[PlatformWindow] 自动保存失败:', err.message)
  }
}

// 导出 platformWindows 供抓包模块使用
module.exports = { registerPlatformWindowIpc, platformWindows }
