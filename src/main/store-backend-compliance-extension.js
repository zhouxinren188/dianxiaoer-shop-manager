'use strict'

const fs = require('fs')
const path = require('path')
const { app, session, WebContentsView } = require('electron')

const EXTENSION_NAME = '店小二内置·京麦违规商品清理'
const EXTENSION_DIRECTORY = 'dxe-compliance-extension'
const PRODUCT_HOST_URL = 'https://wares-jdm.jd.com/ware/wareList?activeTab=OnsaleWare&businessModel=0'
const loadPromises = new Map()

function resolveComplianceExtensionPath(resourceRoot) {
  const candidates = []
  if (resourceRoot) candidates.push(path.join(resourceRoot, 'resources', EXTENSION_DIRECTORY))
  if (app?.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', EXTENSION_DIRECTORY))
  }
  if (app?.getAppPath) candidates.push(path.join(app.getAppPath(), 'resources', EXTENSION_DIRECTORY))
  return candidates.find(candidate => fs.existsSync(path.join(candidate, 'manifest.json'))) || candidates[0]
}

async function ensureStoreBackendComplianceExtension(partitionName, options = {}) {
  const partition = String(partitionName || '')
  if (!partition.startsWith('persist:platform-')) {
    throw new Error('违规商品清理仅允许加载到店铺独立会话')
  }
  if (loadPromises.has(partition)) return loadPromises.get(partition)

  const runtimeLog = options.runtimeLog || null
  const promise = (async () => {
    const platformSession = session.fromPartition(partition)
    const existing = platformSession.extensions.getAllExtensions()
      .find(extension => extension.name === EXTENSION_NAME)
    if (existing) return existing

    const extensionPath = resolveComplianceExtensionPath(options.resourceRoot)
    if (!extensionPath || !fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
      throw new Error('找不到内置违规商品清理模块')
    }
    let readyExtension = null
    let readyResolve
    const readyPromise = new Promise(resolve => { readyResolve = resolve })
    const handleReady = (_event, candidate) => {
      if (candidate?.name !== EXTENSION_NAME) return
      readyExtension = candidate
      readyResolve(candidate)
    }
    platformSession.extensions.on('extension-ready', handleReady)
    let extension
    try {
      extension = await platformSession.extensions.loadExtension(extensionPath)
      if (!readyExtension) {
        await Promise.race([
          readyPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('违规商品清理后台初始化超时')), 5000))
        ])
      }
    } finally {
      platformSession.extensions.removeListener('extension-ready', handleReady)
    }
    if (runtimeLog && typeof runtimeLog.writeLog === 'function') {
      runtimeLog.writeLog('COMPLIANCE_TOOL', `partition=${partition} phase=extension_load result=success extension_id=${extension.id}`)
    }
    return extension
  })()

  loadPromises.set(partition, promise)
  try {
    return await promise
  } catch (error) {
    loadPromises.delete(partition)
    if (runtimeLog && typeof runtimeLog.writeLog === 'function') {
      runtimeLog.writeLog('COMPLIANCE_TOOL', `partition=${partition} phase=extension_load result=failed error=${error.message}`)
    }
    throw error
  }
}

function isStoreBackendComplianceUrl(value) {
  try {
    const target = new URL(String(value || ''))
    if (target.protocol !== 'https:') return false
    const hostname = target.hostname.toLowerCase()
    return hostname === 'keeper-jdm.jd.com'
      || (hostname === 'illegal-jdm.shop.jd.com' && /^\/legal(?:\/|$)/i.test(target.pathname))
  } catch (_error) {
    return false
  }
}

function createStoreBackendComplianceProductHost(platformSession, options = {}) {
  if (!platformSession || !WebContentsView) throw new Error('无法创建京麦商品接口环境')
  const extensionPath = resolveComplianceExtensionPath(options.resourceRoot)
  const bridgePath = path.join(extensionPath, 'compliance-product-bridge.js')
  if (!fs.existsSync(bridgePath)) throw new Error('找不到京麦商品接口签名桥')
  const bridgeSource = `${fs.readFileSync(bridgePath, 'utf8')}\n//# sourceURL=dxe-compliance-product-bridge.js`
  const runtimeLog = options.runtimeLog || null
  const partition = String(options.partitionName || '')
  const view = new WebContentsView({
    webPreferences: {
      session: platformSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  const contents = view.webContents
  const log = message => {
    if (runtimeLog && typeof runtimeLog.writeLog === 'function') {
      runtimeLog.writeLog('COMPLIANCE_TOOL', `partition=${partition} ${message}`)
    }
  }

  contents.setWindowOpenHandler(() => ({action: 'deny'}))
  contents.on('did-finish-load', async () => {
    const currentUrl = contents.getURL()
    if (!/^https:\/\/wares-jdm\.jd\.com\/ware\/wareList/i.test(currentUrl)) {
      log(`phase=product_host_redirect result=failed url=${currentUrl}`)
      return
    }
    try {
      await contents.executeJavaScript(bridgeSource, true)
      log('phase=product_host_ready result=success')
    } catch (error) {
      log(`phase=product_host_bridge result=failed error=${error.message}`)
    }
  })
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) log(`phase=product_host_load result=failed code=${code} description=${description} url=${url}`)
  })
  contents.loadURL(PRODUCT_HOST_URL).catch(error => {
    if (!contents.isDestroyed()) log(`phase=product_host_load result=failed error=${error.message}`)
  })

  return {
    view,
    webContents: contents,
    dispose() {
      if (!contents.isDestroyed()) contents.close()
    }
  }
}

module.exports = {
  EXTENSION_NAME,
  EXTENSION_DIRECTORY,
  PRODUCT_HOST_URL,
  resolveComplianceExtensionPath,
  ensureStoreBackendComplianceExtension,
  isStoreBackendComplianceUrl,
  createStoreBackendComplianceProductHost
}
