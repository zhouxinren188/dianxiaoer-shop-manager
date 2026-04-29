const { ipcMain, session } = require('electron')

let capturing = false
let capturedRequests = []
let activeListeners = [] // 记录已注册监听的 session，用于清理

function registerPacketCaptureIpc() {
  // 开始抓包
  ipcMain.handle('packet-capture-start', async () => {
    if (capturing) {
      return { success: false, message: '已在抓包中' }
    }

    capturedRequests = []
    capturing = true
    activeListeners = []

    // 收集请求的回调
    const onCompleted = (details) => {
      capturedRequests.push({
        url: details.url,
        method: details.method || 'GET',
        statusCode: details.statusCode,
        resourceType: details.resourceType || '',
        referrer: details.referrer || '',
        timestamp: Date.now(),
        fromCache: details.fromCache || false
      })
    }

    // 监听默认 session
    const defaultSes = session.defaultSession
    defaultSes.webRequest.onCompleted({ urls: ['*://*/*'] }, onCompleted)
    activeListeners.push(defaultSes)

    // 监听所有 persist:platform-* 分区的 session
    // 通过遍历已存在的平台窗口 session
    try {
      const { platformWindows } = require('./platform-window')
      for (const [storeId] of platformWindows) {
        const partitionName = `persist:platform-${storeId}`
        const ses = session.fromPartition(partitionName)
        ses.webRequest.onCompleted({ urls: ['*://*/*'] }, onCompleted)
        activeListeners.push(ses)
      }
    } catch {
      // platform-window 模块未加载时忽略
    }

    return { success: true, message: '抓包已开始' }
  })

  // 停止抓包
  ipcMain.handle('packet-capture-stop', async () => {
    if (!capturing) {
      return { success: false, message: '未在抓包中', data: [] }
    }

    // 移除所有监听
    for (const ses of activeListeners) {
      try {
        ses.webRequest.onCompleted(null)
      } catch {
        // 忽略清理错误
      }
    }

    capturing = false
    const result = [...capturedRequests]
    activeListeners = []

    return { success: true, data: result }
  })

  // 查询抓包状态
  ipcMain.handle('packet-capture-status', async () => {
    return { capturing, count: capturedRequests.length }
  })
}

module.exports = { registerPacketCaptureIpc }
