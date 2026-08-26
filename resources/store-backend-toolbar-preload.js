'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const allowedActions = new Set([
  'activate',
  'close',
  'back',
  'forward',
  'reload',
  'home',
  'navigate'
])

contextBridge.exposeInMainWorld('storeBackendTabs', {
  action(action, payload = {}) {
    if (!allowedActions.has(action)) return
    ipcRenderer.send('store-backend-toolbar-action', {
      action,
      tabId: typeof payload.tabId === 'string' ? payload.tabId : '',
      url: typeof payload.url === 'string' ? payload.url : ''
    })
  },
  onState(callback) {
    if (typeof callback !== 'function') return
    ipcRenderer.on('store-backend-tabs-state', (_event, state) => callback(state))
  }
})
