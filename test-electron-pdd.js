/**
 * test-electron-pdd.js - 测试 Electron-only 模式访问拼多多（无 CEF）
 * 验证：反检测指纹伪装 + UA/Sec-CH-UA 修改是否能让 PDD 正常加载
 */
const { app, BrowserWindow, session } = require('electron')
const path = require('path')

process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0) })
process.stderr.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0) })

let mainWindow

app.whenReady().then(async () => {
  const partitionName = 'persist:cef-pdd-test'
  const ses = session.fromPartition(partitionName)

  // 反爬：UA + Sec-CH-UA 伪装
  const chromeVersion = process.versions.chrome || '134.0.0.0'
  const cleanUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  const secChUa = `"Chromium";v="${chromeVersion.split('.')[0]}", "Google Chrome";v="${chromeVersion.split('.')[0]}", "Not-A.Brand";v="99"`

  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    if (details.requestHeaders) {
      details.requestHeaders['Sec-CH-UA'] = secChUa
      details.requestHeaders['Sec-CH-UA-Platform'] = '"Windows"'
      details.requestHeaders['User-Agent'] = cleanUA
    }
    callback({ requestHeaders: details.requestHeaders })
  })

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true,
    title: 'Electron-only PDD Test',
    webPreferences: {
      partition: partitionName,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'src', 'main', 'purchase-preload.js')
    }
  })

  mainWindow.webContents.setUserAgent(cleanUA)

  // 监听 console
  mainWindow.webContents.on('console-message', (event, level, message) => {
    if (message.includes('[Test]') || message.includes('Error')) {
      console.log(`[Console] ${message.substring(0, 200)}`)
    }
  })

  // 检查指纹伪装效果
  mainWindow.webContents.on('dom-ready', async () => {
    const url = mainWindow.webContents.getURL()
    console.log(`[Test] dom-ready: ${url.substring(0, 120)}`)

    // 验证指纹伪装
    try {
      const result = await mainWindow.webContents.executeJavaScript(`
        (function() {
          return JSON.stringify({
            webdriver: navigator.webdriver,
            plugins: navigator.plugins.length,
            mimeTypes: navigator.mimeTypes.length,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory,
            languages: navigator.languages,
            platform: navigator.platform,
            outerWidth: window.outerWidth,
            outerHeight: window.outerHeight,
            chromeRuntime: !!window.chrome && !!window.chrome.runtime,
            chromeLoadTimes: !!window.chrome && !!window.chrome.loadTimes,
            userAgent: navigator.userAgent.substring(0, 80)
          })
        })()
      `)
      console.log(`[Test] Fingerprint check: ${result}`)
    } catch (e) {
      console.log(`[Test] Fingerprint check error: ${e.message}`)
    }
  })

  mainWindow.webContents.on('did-navigate', (event, url) => {
    console.log(`[Test] navigated: ${url.substring(0, 120)}`)
  })

  mainWindow.webContents.on('did-finish-load', async () => {
    const url = mainWindow.webContents.getURL()
    const title = await mainWindow.webContents.executeJavaScript('document.title').catch(() => '')
    console.log(`[Test] Page loaded: title="${title}", url=${url.substring(0, 120)}`)

    // 检查是否被检测（"排队中"或其他拦截页面）
    try {
      const bodyText = await mainWindow.webContents.executeJavaScript('document.body ? document.body.innerText.substring(0, 300) : ""')
      const isBlocked = bodyText.includes('排队') || bodyText.includes('验证') || bodyText.includes('风控')
      console.log(`[Test] Blocked: ${isBlocked}, body: ${bodyText.substring(0, 150)}`)
    } catch (e) {}
  })

  // 加载拼多多
  const pddUrl = 'https://mobile.yangkeduo.com/'
  console.log(`[Test] Loading PDD: ${pddUrl}`)
  console.log(`[Test] Chrome version: ${chromeVersion}`)
  console.log(`[Test] UA: ${cleanUA}`)
  console.log(`[Test] Sec-CH-UA: ${secChUa}`)

  try {
    await mainWindow.loadURL(pddUrl)
    console.log('[Test] loadURL succeeded')
  } catch (e) {
    console.error(`[Test] loadURL failed: ${e.message}`)
  }

  mainWindow.on('closed', () => {
    app.quit()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
