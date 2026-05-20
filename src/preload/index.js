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
  'get-app-version',
  'open-platform-window',
  'confirm-platform-login',
  'close-platform-window',
  'open-purchase-login-window',
  'close-purchase-login-window',
  'packet-capture-start',
  'packet-capture-stop',
  'packet-capture-status',
  'open-external-url',
  'open-product-url',
  'fetch-supply-orders',
  'fetch-sales-orders',
  'set-auth-token',
  'open-purchase-order-window',
  'close-purchase-order-window',
  'refresh-purchase-cookies',
  'sync-purchase-order-browser',
  'sync-purchase-orders-browser',
  'fetch-buyer-sensitive-info',
  'save-buyer-info-to-server',
  'clear-purchase-cookies',
  'toggle-jd-auto-sync',
  'jd-auto-sync-status',
  'open-pdd-browsing-window',
  'export-purchase-cookies',
  'import-purchase-cookies',
  'fetch-aftersale-metrics',
  'check-aftersale-sync-stores',
  'open-store-backend-url',
  'open-jd-outbound',
  'open-jd-order-detail',
  'submit-vendor-remark',
  'open-purchase-url'
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
  'purchase-address-setup-start',
  'packet-capture-auto-stopped',
  'auto-sync-start',
  'auto-sync-result',
  'auto-sync-progress',
  'batch-sync-progress',
  'pdd-product-link-update'
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
