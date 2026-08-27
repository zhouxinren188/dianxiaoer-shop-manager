'use strict'

const path = require('path')
const { app, BrowserWindow, WebContentsView, Menu, clipboard, dialog, ipcMain, session, shell } = require('electron')
const {
  isHttpUrl,
  normalizeTabUrl,
  isLikelyLoginUrl,
  selectOldestInactiveTab
} = require('./store-backend-browser-helpers')
const {
  isStoreBackendComplianceUrl,
  createStoreBackendComplianceProductHost
} = require('./store-backend-compliance-extension')

const TOOLBAR_HEIGHT = 84
const DEFAULT_MAX_TABS = 10
const backendBrowsers = new Map()
const toolbarOwners = new Map()
let tabSequence = 0
let toolbarIpcRegistered = false

function storeKey(storeId) {
  return String(storeId || '')
}

function registerToolbarIpc() {
  if (toolbarIpcRegistered) return
  toolbarIpcRegistered = true
  ipcMain.on('store-backend-toolbar-action', (event, payload = {}) => {
    const owner = toolbarOwners.get(event.sender.id)
    if (!owner || owner.isDestroyed()) return
    owner.handleToolbarAction(payload)
  })
}

class StoreBackendBrowser {
  constructor(options) {
    this.storeId = storeKey(options.storeId)
    this.homeUrl = options.url
    this.baseTitle = options.title || '店铺后台'
    this.partitionName = options.partitionName || `persist:platform-${this.storeId}`
    this.platformSession = session.fromPartition(this.partitionName)
    this.onWebContentsCreated = typeof options.onWebContentsCreated === 'function'
      ? options.onWebContentsCreated
      : null
    this.runtimeLog = options.runtimeLog || null
    this.confirmBeforeUnload = typeof options.confirmBeforeUnload === 'function'
      ? options.confirmBeforeUnload
      : () => dialog.showMessageBoxSync(this.window, {
          type: 'warning',
          title: '离开此网站？',
          message: '离开此网站？',
          detail: '系统可能不会保存您所做的更改。',
          buttons: ['离开', '取消'],
          defaultId: 0,
          cancelId: 1,
          noLink: true
        }) === 0
    this.maxTabs = Math.max(2, Number(options.maxTabs) || DEFAULT_MAX_TABS)
    this.showWindow = options.show !== false
    this.tabs = []
    this.activeTabId = null
    this.closing = false
    this.complianceProductHost = null

    const appPath = options.resourceRoot || app.getAppPath()
    this.resourceRoot = options.resourceRoot
    this.window = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: this.baseTitle,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#e8edf5',
        symbolColor: '#303133',
        height: 43
      },
      backgroundColor: '#f5f7fa',
      icon: path.join(appPath, 'resources', 'icon.ico'),
      webPreferences: {
        preload: path.join(appPath, 'resources', 'store-backend-toolbar-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    this.window.setMenuBarVisibility(false)
    this.toolbarWebContentsId = this.window.webContents.id
    toolbarOwners.set(this.toolbarWebContentsId, this)

    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.on('did-finish-load', () => this.syncToolbarState())
    this.window.on('resize', () => this.layoutActiveTab())
    this.window.on('maximize', () => this.layoutActiveTab())
    this.window.on('unmaximize', () => this.layoutActiveTab())
    this.window.on('closed', () => this.dispose())
    this.window.once('ready-to-show', () => {
      if (this.isDestroyed() || !this.showWindow) return
      this.window.show()
      this.window.focus()
    })

    this.window.loadFile(path.join(appPath, 'resources', 'store-backend-toolbar.html')).catch(error => {
      this.log(`toolbar_load_failed reason=${error.message}`)
    })

    this.createTab({
      url: options.url,
      title: options.title || '店铺后台',
      activate: true,
      autoLoad: true
    })
  }

  log(message) {
    if (this.runtimeLog && typeof this.runtimeLog.writeLog === 'function') {
      this.runtimeLog.writeLog('BACKEND_TABS', `store_id=${this.storeId} ${message}`)
    }
  }

  isDestroyed() {
    return !this.window || this.window.isDestroyed()
  }

  focus() {
    if (this.isDestroyed()) return
    if (this.window.isMinimized()) this.window.restore()
    this.window.show()
    this.window.focus()
  }

  findTab(tabId) {
    return this.tabs.find(tab => tab.id === String(tabId || '')) || null
  }

  activeTab() {
    return this.findTab(this.activeTabId)
  }

  reusableTab(url) {
    const key = normalizeTabUrl(url)
    return this.tabs.find(tab => normalizeTabUrl(tab.url || tab.requestedUrl) === key) || null
  }

  openUrl(url, title, options = {}) {
    this.focus()
    if (options.focusExisting) return this.activeTab()

    const reusable = this.reusableTab(url)
    if (reusable) {
      this.activateTab(reusable.id)
      return reusable
    }

    return this.createTab({ url, title, activate: true, autoLoad: true })
  }

  ensureTabCapacity() {
    if (this.tabs.length < this.maxTabs) return
    const oldest = selectOldestInactiveTab(this.tabs, this.activeTabId)
    if (oldest) {
      this.log(`tab_limit_close tab_id=${oldest.id} max=${this.maxTabs}`)
      this.closeTab(oldest.id)
    }
  }

  createTab(options = {}) {
    this.ensureTabCapacity()

    let view
    if (options.webContents && !options.webContents.isDestroyed()) {
      // Electron pre-creates this webContents for window.open(). It must be
      // adopted by the returned view instead of replacing it with a new one.
      view = new WebContentsView({ webContents: options.webContents })
    } else {
      const inheritedPreferences = { ...(options.webPreferences || {}) }
      delete inheritedPreferences.partition
      delete inheritedPreferences.session
      delete inheritedPreferences.preload

      view = new WebContentsView({
        webPreferences: {
          ...inheritedPreferences,
          session: this.platformSession,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: true
        }
      })
    }

    const tab = {
      id: `${this.storeId}-${++tabSequence}`,
      view,
      title: options.title || '新标签页',
      url: options.url || 'about:blank',
      requestedUrl: options.url || 'about:blank',
      loading: false,
      crashed: false,
      lastActiveAt: Date.now()
    }
    this.tabs.push(tab)
    view.webContents.__storeBackendRequestedUrl = tab.requestedUrl
    this.attachTabEvents(tab)

    if (this.onWebContentsCreated) {
      this.onWebContentsCreated(view.webContents, tab)
    }

    if (options.activate !== false) this.activateTab(tab.id)
    if (options.autoLoad !== false && isHttpUrl(options.url)) {
      view.webContents.loadURL(options.url).catch(error => {
        if (!view.webContents.isDestroyed()) {
          tab.loading = false
          tab.title = '页面加载失败'
          this.log(`tab_load_failed tab_id=${tab.id} reason=${error.message}`)
          this.syncToolbarState()
        }
      })
    }

    this.log(`tab_created tab_id=${tab.id} count=${this.tabs.length}`)
    this.syncToolbarState()
    return tab
  }

  attachTabEvents(tab) {
    const contents = tab.view.webContents

    contents.setWindowOpenHandler(details => {
      if (isHttpUrl(details.url) || details.url === 'about:blank') {
        const openerUrl = contents.getURL() || tab.url || tab.requestedUrl || ''
        this.log(
          `popup_requested opener_tab=${tab.id} disposition=${details.disposition || 'unknown'}` +
          ` opener_url=${JSON.stringify(openerUrl)} target_url=${JSON.stringify(details.url || '')}` +
          ` frame_name=${JSON.stringify(details.frameName || '')}`
        )

        return {
          action: 'allow',
          outlivesOpener: true,
          createWindow: browserWindowOptions => {
            this.log(`popup_create_start opener_tab=${tab.id}`)
            const childTab = this.createTab({
              url: details.url || 'about:blank',
              title: details.frameName || '新标签页',
              webContents: browserWindowOptions.webContents,
              webPreferences: browserWindowOptions.webPreferences,
              activate: true,
              autoLoad: false
            })
            this.log(`popup_merged opener_tab=${tab.id} child_tab=${childTab.id}`)
            return childTab.view.webContents
          }
        }
      }

      if (details.url && /^(mailto:|tel:)/i.test(details.url)) {
        shell.openExternal(details.url).catch(() => {})
      }
      this.log(`popup_denied tab_id=${tab.id} scheme=${String(details.url || '').split(':')[0] || 'empty'}`)
      return { action: 'deny' }
    })

    contents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
      if (isHttpUrl(url)) this.ensureComplianceProductHost(url)
      if (!isMainFrame || !isHttpUrl(url) || isLikelyLoginUrl(url)) return
      tab.requestedUrl = url
      contents.__storeBackendRequestedUrl = url
    })
    contents.on('did-navigate', (_event, url) => {
      tab.url = url
      if (!isLikelyLoginUrl(url)) {
        tab.requestedUrl = url
        contents.__storeBackendRequestedUrl = url
      }
      this.syncToolbarState()
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isHttpUrl(url)) this.ensureComplianceProductHost(url)
      if (!isMainFrame) return
      tab.url = url
      if (!isLikelyLoginUrl(url)) {
        tab.requestedUrl = url
        contents.__storeBackendRequestedUrl = url
      }
      this.syncToolbarState()
    })
    contents.on('page-title-updated', (event, title) => {
      event.preventDefault()
      tab.title = String(title || '').trim() || '店铺后台'
      if (tab.id === this.activeTabId && !this.isDestroyed()) {
        this.window.setTitle(this.baseTitle)
      }
      this.syncToolbarState()
    })
    contents.on('did-start-loading', () => {
      tab.loading = true
      this.syncToolbarState()
    })
    contents.on('did-stop-loading', () => {
      tab.loading = false
      tab.url = contents.getURL() || tab.url
      this.syncToolbarState()
    })
    contents.on('render-process-gone', (_event, details) => {
      tab.crashed = true
      tab.loading = false
      this.log(`tab_process_gone tab_id=${tab.id} reason=${details.reason}`)
      this.syncToolbarState()
    })
    contents.on('will-prevent-unload', event => {
      let shouldLeave = false
      try {
        shouldLeave = this.confirmBeforeUnload({
          tabId: tab.id,
          title: tab.title,
          url: contents.getURL() || tab.url || tab.requestedUrl || ''
        }) === true
      } catch (error) {
        this.log(`before_unload_prompt_failed tab_id=${tab.id} reason=${error.message}`)
      }
      this.log(`before_unload_decision tab_id=${tab.id} action=${shouldLeave ? 'leave' : 'cancel'}`)
      // Electron 与浏览器提示框的语义相反：preventDefault 表示忽略页面的
      // beforeunload 阻止并继续离开；不调用则留在当前页面。
      if (shouldLeave) event.preventDefault()
    })
    contents.on('destroyed', () => this.removeDestroyedTab(tab.id))
    contents.on('before-input-event', (event, input) => this.handleTabShortcut(event, input))
    contents.on('context-menu', (_event, params) => this.showPageContextMenu(contents, params))
  }

  ensureComplianceProductHost(url) {
    if (!isStoreBackendComplianceUrl(url) || this.isDestroyed()) return
    if (this.complianceProductHost && !this.complianceProductHost.webContents.isDestroyed()) return
    try {
      this.complianceProductHost = createStoreBackendComplianceProductHost(this.platformSession, {
        partitionName: this.partitionName,
        resourceRoot: this.resourceRoot,
        runtimeLog: this.runtimeLog
      })
      this.window.contentView.addChildView(this.complianceProductHost.view)
      this.complianceProductHost.view.setBounds({x: -100, y: -100, width: 1, height: 1})
      this.log('compliance_product_host_created')
    } catch (error) {
      this.complianceProductHost = null
      this.log(`compliance_product_host_failed reason=${error.message}`)
    }
  }

  showPageContextMenu(contents, params = {}) {
    if (!contents || contents.isDestroyed() || this.isDestroyed()) return
    const template = []
    const appendSeparator = () => {
      if (template.length && template[template.length - 1].type !== 'separator') {
        template.push({ type: 'separator' })
      }
    }
    const editFlags = params.editFlags || {}

    if (params.isEditable) {
      template.push(
        { label: '撤销', enabled: !!editFlags.canUndo, click: () => contents.undo() },
        { label: '重做', enabled: !!editFlags.canRedo, click: () => contents.redo() },
        { type: 'separator' },
        { label: '剪切', enabled: !!editFlags.canCut, click: () => contents.cut() },
        { label: '复制', enabled: !!editFlags.canCopy, click: () => contents.copy() },
        { label: '粘贴', enabled: !!editFlags.canPaste, click: () => contents.paste() },
        { label: '粘贴为纯文本', enabled: !!editFlags.canPaste, click: () => contents.pasteAndMatchStyle() },
        { label: '全选', enabled: !!editFlags.canSelectAll, click: () => contents.selectAll() }
      )
    } else if (params.selectionText || editFlags.canCopy) {
      template.push({ label: '复制', enabled: !!editFlags.canCopy, click: () => contents.copy() })
    }

    if (isHttpUrl(params.linkURL)) {
      appendSeparator()
      template.push(
        {
          label: '在新标签页中打开链接',
          click: () => this.createTab({
            url: params.linkURL,
            title: params.linkText || '新标签页',
            activate: true,
            autoLoad: true
          })
        },
        { label: '复制链接地址', click: () => clipboard.writeText(params.linkURL) }
      )
    }

    appendSeparator()
    const history = contents.navigationHistory
    template.push(
      { label: '后退', enabled: !!(history && history.canGoBack()), click: () => history.goBack() },
      { label: '前进', enabled: !!(history && history.canGoForward()), click: () => history.goForward() },
      { label: '重新加载', click: () => contents.reload() }
    )

    const currentUrl = contents.getURL()
    if (isHttpUrl(currentUrl)) {
      appendSeparator()
      template.push({ label: '查看网页源代码', click: () => this.openViewSource(currentUrl) })
    }
    template.push(
      {
        label: contents.isDevToolsOpened() ? '关闭开发者工具（F12）' : '打开开发者工具（F12）',
        click: () => this.toggleDevTools(contents)
      },
      {
        label: '检查',
        click: () => {
          if (!contents.isDestroyed()) contents.inspectElement(params.x, params.y)
        }
      }
    )

    while (template[0]?.type === 'separator') template.shift()
    while (template[template.length - 1]?.type === 'separator') template.pop()
    Menu.buildFromTemplate(template).popup({ window: this.window })
  }

  openViewSource(url) {
    if (!isHttpUrl(url) || this.isDestroyed()) return
    const sourceUrl = `view-source:${url}`
    const tab = this.createTab({
      url: sourceUrl,
      title: '网页源代码',
      activate: true,
      autoLoad: false
    })
    tab.view.webContents.loadURL(sourceUrl).catch(error => {
      this.log(`view_source_load_failed reason=${error.message}`)
    })
  }

  handleTabShortcut(event, input) {
    if (input.type !== 'keyDown') return
    const key = String(input.key || '').toLowerCase()
    if (input.control && key === 'w') {
      event.preventDefault()
      this.closeTab(this.activeTabId)
    } else if (input.control && key === 'tab') {
      event.preventDefault()
      this.activateRelativeTab(input.shift ? -1 : 1)
    } else if (input.alt && key === 'left') {
      event.preventDefault()
      this.goBack()
    } else if (input.alt && key === 'right') {
      event.preventDefault()
      this.goForward()
    } else if (key === 'f5' || (input.control && key === 'r')) {
      event.preventDefault()
      this.reload()
    } else if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      event.preventDefault()
      this.toggleDevTools()
    }
  }

  toggleDevTools(contents = this.activeContents()) {
    if (!contents || contents.isDestroyed()) return
    if (contents.isDevToolsOpened()) {
      contents.closeDevTools()
    } else {
      contents.openDevTools({ mode: 'detach', activate: true })
    }
  }

  activateRelativeTab(direction) {
    if (this.tabs.length < 2) return
    const currentIndex = Math.max(0, this.tabs.findIndex(tab => tab.id === this.activeTabId))
    const nextIndex = (currentIndex + direction + this.tabs.length) % this.tabs.length
    this.activateTab(this.tabs[nextIndex].id)
  }

  activateTab(tabId) {
    const tab = this.findTab(tabId)
    if (!tab || tab.view.webContents.isDestroyed() || this.isDestroyed()) return

    const current = this.activeTab()
    if (current && current.id !== tab.id) {
      this.window.contentView.removeChildView(current.view)
    }
    this.window.contentView.addChildView(tab.view)
    this.activeTabId = tab.id
    tab.lastActiveAt = Date.now()
    this.layoutActiveTab()
    this.window.setTitle(this.baseTitle)
    tab.view.webContents.focus()
    this.syncToolbarState()
  }

  layoutActiveTab() {
    const active = this.activeTab()
    if (!active || this.isDestroyed()) return
    const bounds = this.window.getContentBounds()
    active.view.setBounds({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height - TOOLBAR_HEIGHT)
    })
  }

  closeTab(tabId) {
    const tab = this.findTab(tabId)
    if (!tab) return
    const closingIndex = this.tabs.indexOf(tab)
    const wasActive = tab.id === this.activeTabId

    if (!this.isDestroyed()) this.window.contentView.removeChildView(tab.view)
    this.tabs.splice(closingIndex, 1)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()

    if (!this.tabs.length) {
      if (!this.isDestroyed()) this.window.close()
      return
    }

    if (wasActive) {
      const next = this.tabs[Math.min(closingIndex, this.tabs.length - 1)]
      this.activeTabId = null
      this.activateTab(next.id)
    } else {
      this.syncToolbarState()
    }
    this.log(`tab_closed tab_id=${tab.id} count=${this.tabs.length}`)
  }

  removeDestroyedTab(tabId) {
    const tab = this.findTab(tabId)
    if (!tab) return
    const wasActive = tab.id === this.activeTabId
    const index = this.tabs.indexOf(tab)
    this.tabs.splice(index, 1)
    if (this.closing) return
    if (!this.tabs.length) {
      if (!this.isDestroyed()) this.window.close()
      return
    }
    if (wasActive) {
      this.activeTabId = null
      this.activateTab(this.tabs[Math.min(index, this.tabs.length - 1)].id)
    } else {
      this.syncToolbarState()
    }
  }

  activeContents() {
    const active = this.activeTab()
    if (!active || active.view.webContents.isDestroyed()) return null
    return active.view.webContents
  }

  goBack() {
    const contents = this.activeContents()
    if (!contents) return
    const history = contents.navigationHistory
    if (history && history.canGoBack()) history.goBack()
  }

  goForward() {
    const contents = this.activeContents()
    if (!contents) return
    const history = contents.navigationHistory
    if (history && history.canGoForward()) history.goForward()
  }

  reload() {
    const contents = this.activeContents()
    if (contents) contents.reload()
  }

  navigateActive(url) {
    const contents = this.activeContents()
    if (!contents || !isHttpUrl(url)) return
    const tab = this.activeTab()
    tab.requestedUrl = url
    contents.__storeBackendRequestedUrl = url
    contents.loadURL(url).catch(error => this.log(`toolbar_navigate_failed reason=${error.message}`))
  }

  handleToolbarAction(payload = {}) {
    switch (payload.action) {
      case 'activate':
        this.activateTab(payload.tabId)
        break
      case 'close':
        this.closeTab(payload.tabId)
        break
      case 'back':
        this.goBack()
        break
      case 'forward':
        this.goForward()
        break
      case 'reload':
        this.reload()
        break
      case 'home':
        this.navigateActive(this.homeUrl)
        break
      case 'navigate':
        this.navigateActive(payload.url)
        break
    }
  }

  syncToolbarState() {
    if (this.isDestroyed() || this.window.webContents.isDestroyed()) return
    const active = this.activeTab()
    const activeContents = this.activeContents()
    const history = activeContents && activeContents.navigationHistory
    try {
      this.window.webContents.send('store-backend-tabs-state', {
        storeId: this.storeId,
        baseTitle: this.baseTitle,
        activeTabId: this.activeTabId,
        activeUrl: active ? (activeContents.getURL() || active.url || '') : '',
        canGoBack: !!(history && history.canGoBack()),
        canGoForward: !!(history && history.canGoForward()),
        tabs: this.tabs.map(tab => ({
          id: tab.id,
          title: tab.title,
          url: tab.view.webContents.isDestroyed() ? tab.url : (tab.view.webContents.getURL() || tab.url),
          loading: tab.loading,
          crashed: tab.crashed
        }))
      })
    } catch (error) {
      this.log(`toolbar_sync_skipped reason=${error.message}`)
    }
  }

  dispose() {
    if (this.closing) return
    this.closing = true
    toolbarOwners.delete(this.toolbarWebContentsId)
    backendBrowsers.delete(this.storeId)
    for (const tab of this.tabs) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
    if (this.complianceProductHost) {
      if (!this.isDestroyed()) this.window.contentView.removeChildView(this.complianceProductHost.view)
      this.complianceProductHost.dispose()
      this.complianceProductHost = null
    }
    this.tabs = []
    this.activeTabId = null
    this.log('browser_closed')
  }
}

function openStoreBackendBrowser(options) {
  registerToolbarIpc()
  const key = storeKey(options.storeId)
  const existing = backendBrowsers.get(key)
  if (existing && !existing.isDestroyed()) {
    const tab = existing.openUrl(options.url, options.title, {
      focusExisting: !!options.focusExisting
    })
    return {
      browser: existing,
      reused: true,
      tabId: tab ? tab.id : existing.activeTabId
    }
  }

  if (existing) backendBrowsers.delete(key)
  const browser = new StoreBackendBrowser(options)
  backendBrowsers.set(key, browser)
  return {
    browser,
    reused: false,
    tabId: browser.activeTabId
  }
}

function closeAllStoreBackendBrowsers() {
  for (const browser of backendBrowsers.values()) {
    if (!browser.isDestroyed()) browser.window.close()
  }
}

module.exports = {
  openStoreBackendBrowser,
  closeAllStoreBackendBrowsers,
  normalizeTabUrl,
  isHttpUrl,
  DEFAULT_MAX_TABS
}
