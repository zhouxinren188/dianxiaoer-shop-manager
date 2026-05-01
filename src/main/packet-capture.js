const { ipcMain, session, BrowserWindow } = require('electron')

let capturing = false
let capturedRequests = []
let activeListeners = [] // 记录已注册监听的 session，用于清理
let captureCallback = null // 抓包回调函数（onCompleted）
let beforeRequestCallback = null // onBeforeRequest 回调（用于捕获 POST body）
let requestBodyMap = new Map() // 临时存储请求体，key 为 url+timestamp 近似匹配
let captureTimeout = null // 抓包超时定时器
const CAPTURE_MAX_DURATION_MS = 5 * 60 * 1000 // 5分钟自动停止

function isCapturing() {
  return capturing
}

function getCaptureCallback() {
  return captureCallback
}

// 解析 uploadData 为可读字符串
function parseUploadData(uploadData) {
  if (!uploadData || !Array.isArray(uploadData) || uploadData.length === 0) {
    return null
  }
  try {
    const parts = []
    for (const item of uploadData) {
      if (item.bytes) {
        // bytes 是 Buffer
        parts.push(Buffer.from(item.bytes).toString('utf-8'))
      } else if (item.file) {
        parts.push(`[file: ${item.file}]`)
      } else if (item.blobUUID) {
        parts.push(`[blob: ${item.blobUUID}]`)
      }
    }
    return parts.join('')
  } catch {
    return null
  }
}

function registerPacketCaptureIpc() {
  // 开始抓包
  ipcMain.handle('packet-capture-start', async () => {
    if (capturing) {
      return { success: false, message: '已在抓包中' }
    }

    capturedRequests = []
    requestBodyMap = new Map()
    capturing = true
    activeListeners = []

    // onBeforeRequest 回调 - 捕获 POST body (uploadData)
    beforeRequestCallback = (details, callback) => {
      if (details.uploadData && details.method && details.method.toUpperCase() === 'POST') {
        const bodyStr = parseUploadData(details.uploadData)
        if (bodyStr) {
          // 用 URL 作为 key 存储请求体（同一 URL 可能多次请求，用数组）
          const key = details.url
          if (!requestBodyMap.has(key)) {
            requestBodyMap.set(key, [])
          }
          requestBodyMap.get(key).push(bodyStr)
        }
      }
      callback({ cancel: false })
    }

    // onCompleted 回调 - 捕获响应状态
    captureCallback = (details) => {
      const entry = {
        url: details.url,
        method: details.method || 'GET',
        statusCode: details.statusCode,
        resourceType: details.resourceType || '',
        referrer: details.referrer || '',
        timestamp: Date.now(),
        fromCache: details.fromCache || false,
        postBody: null
      }

      // 尝试从 requestBodyMap 中取出对应的 POST body
      if (entry.method.toUpperCase() === 'POST') {
        const bodies = requestBodyMap.get(details.url)
        if (bodies && bodies.length > 0) {
          entry.postBody = bodies.shift() // 取最早的一个
          if (bodies.length === 0) {
            requestBodyMap.delete(details.url)
          }
        }
      }

      capturedRequests.push(entry)
    }

    // 监听默认 session
    const defaultSes = session.defaultSession
    defaultSes.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, beforeRequestCallback)
    defaultSes.webRequest.onCompleted({ urls: ['*://*/*'] }, captureCallback)
    activeListeners.push(defaultSes)

    // 监听所有 persist:platform-* 分区的 session
    // 通过遍历已存在的平台窗口 session
    try {
      const { platformWindows } = require('./platform-window')
      for (const [storeId] of platformWindows) {
        const partitionName = `persist:platform-${storeId}`
        const ses = session.fromPartition(partitionName)
        ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, beforeRequestCallback)
        ses.webRequest.onCompleted({ urls: ['*://*/*'] }, captureCallback)
        activeListeners.push(ses)
      }
    } catch {
      // platform-window 模块未加载时忽略
    }

    // 5分钟自动停止
    captureTimeout = setTimeout(() => {
      if (capturing) {
        console.log('[PacketCapture] 抓包已超时，自动停止')
        stopCaptureInternal()
        // 通知所有渲染进程
        BrowserWindow.getAllWindows().forEach(win => {
          try {
            win.webContents.send('packet-capture-auto-stopped', { reason: 'timeout', duration: CAPTURE_MAX_DURATION_MS })
          } catch {
            // 忽略通知失败
          }
        })
      }
    }, CAPTURE_MAX_DURATION_MS)

    return { success: true, message: '抓包已开始' }
  })

  // 停止抓包
  ipcMain.handle('packet-capture-stop', async () => {
    if (!capturing) {
      return { success: false, message: '未在抓包中', data: [] }
    }
    return stopCaptureInternal()
  })

  function stopCaptureInternal() {
    // 清除超时定时器
    if (captureTimeout) {
      clearTimeout(captureTimeout)
      captureTimeout = null
    }

    // 移除所有监听
    for (const ses of activeListeners) {
      try {
        ses.webRequest.onBeforeRequest(null)
        ses.webRequest.onCompleted(null)
      } catch {
        // 忽略清理错误
      }
    }

    capturing = false
    captureCallback = null
    beforeRequestCallback = null
    requestBodyMap = new Map()
    const result = [...capturedRequests]
    activeListeners = []

    return { success: true, data: result }
  }

  // 查询抓包状态
  ipcMain.handle('packet-capture-status', async () => {
    return { capturing, count: capturedRequests.length }
  })
}

module.exports = { registerPacketCaptureIpc, isCapturing, getCaptureCallback }
