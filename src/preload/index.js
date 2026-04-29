const { contextBridge, ipcRenderer } = require('electron')

// 允许的 IPC 通道白名单
const validInvokeChannels = [
  'check-for-updates',
  'start-download-update',
  'quit-and-install',
  'window-minimize',
  'window-maximize',
  'window-close',
  'window-set-login-size',
  'window-set-main-size',
  'user-get-all',
  'user-register',
  'user-login',
  'hot-update-check',
  'hot-update-download',
  'hot-update-restart',
  'open-platform-window',
  'confirm-platform-login',
  'close-platform-window',
  'packet-capture-start',
  'packet-capture-stop',
  'packet-capture-status',
  'open-external-url',
  'fetch-supply-orders'
]

const validOnChannels = [
  'update-available',
  'update-not-available',
  'update-error',
  'update-progress',
  'update-downloaded',
  'hot-update-available',
  'hot-update-progress',
  'platform-login-success',
  'store-status-changed'
]

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  invoke: (channel, ...args) => {
    if (validInvokeChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args)
    }
    throw new Error(`未授权的 IPC 调用通道: ${channel}`)
  },
  onUpdate: (channel, callback) => {
    if (validOnChannels.includes(channel)) {
      const wrapper = (_event, ...args) => callback(...args)
      ipcRenderer.on(channel, wrapper)
      // 返回取消订阅函数
      return () => ipcRenderer.removeListener(channel, wrapper)
    }
    throw new Error(`未授权的 IPC 监听通道: ${channel}`)
  }
})
