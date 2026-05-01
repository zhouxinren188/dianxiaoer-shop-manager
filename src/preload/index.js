const { contextBridge, ipcRenderer } = require('electron')

// 允许的 IPC 通道白名单
const validInvokeChannels = [
  'um-check',
  'um-download',
  'um-install',
  'window-minimize',
  'window-maximize',
  'window-close',
  'window-set-login-size',
  'window-set-main-size',
  'user-get-all',
  'user-register',
  'user-login',
  'open-platform-window',
  'confirm-platform-login',
  'close-platform-window',
  'open-purchase-login-window',
  'close-purchase-login-window',
  'packet-capture-start',
  'packet-capture-stop',
  'packet-capture-status',
  'open-external-url',
  'fetch-supply-orders',
  'fetch-sales-orders',
  'set-auth-token',
  'open-purchase-order-window',
  'close-purchase-order-window'
]

const validOnChannels = [
  'um-update-available',
  'um-no-update',
  'um-update-progress',
  'um-update-ready',
  'um-update-error',
  'platform-login-success',
  'purchase-account-login-success',
  'store-status-changed',
  'purchase-order-captured',
  'purchase-window-closed',
  'purchase-address-filled',
  'purchase-address-setup-done',
  'packet-capture-auto-stopped'
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
