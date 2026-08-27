'use strict'

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const WAREHOUSE_MANAGE_HOST = 'shop.jd.com'
const WAREHOUSE_MANAGE_PATH = '/jdm/trade/warehousing/warehouse-manage'
const TOOL_RESOURCE = path.join('resources', 'store-backend-warehouse-tool.js')
const TOOL_LOGO_RESOURCE = path.join('resources', 'store-backend-wolf-logo.png')
const TOOL_LOGO_PLACEHOLDER = '__DXE_WAREHOUSE_LOGO_URL__'

let cachedToolSource = null

function isWarehouseManageUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' &&
      parsed.hostname.toLowerCase() === WAREHOUSE_MANAGE_HOST &&
      parsed.pathname.startsWith(WAREHOUSE_MANAGE_PATH)
  } catch {
    return false
  }
}

function loadWarehouseToolSource(resourceRoot = app.getAppPath()) {
  if (cachedToolSource) return cachedToolSource
  const resourcePath = path.join(resourceRoot, TOOL_RESOURCE)
  const logoPath = path.join(resourceRoot, TOOL_LOGO_RESOURCE)
  const source = fs.readFileSync(resourcePath, 'utf8')
  const logoDataUrl = `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`
  cachedToolSource = source.replace(TOOL_LOGO_PLACEHOLDER, logoDataUrl)
  return cachedToolSource
}

function attachWarehouseRegionTool(webContents, options = {}) {
  if (!webContents || webContents.isDestroyed() || webContents.__dxeWarehouseToolAttached) return
  webContents.__dxeWarehouseToolAttached = true

  const runtimeLog = options.runtimeLog || null
  const storeId = String(options.storeId || '')
  const resourceRoot = options.resourceRoot || app.getAppPath()
  let injectionTimer = null

  const log = message => {
    if (runtimeLog && typeof runtimeLog.writeLog === 'function') {
      runtimeLog.writeLog('WAREHOUSE_TOOL', `store_id=${storeId} ${message}`)
    }
  }

  const inject = async reason => {
    if (webContents.isDestroyed()) return false
    const url = webContents.getURL()
    if (!isWarehouseManageUrl(url)) return false
    try {
      const result = await webContents.executeJavaScript(loadWarehouseToolSource(resourceRoot), true)
      log(`phase=inject reason=${reason} result=success`)
      return result
    } catch (error) {
      log(`phase=inject reason=${reason} result=failed error=${error.message}`)
      return false
    }
  }

  const scheduleInject = reason => {
    if (injectionTimer) clearTimeout(injectionTimer)
    injectionTimer = setTimeout(() => {
      injectionTimer = null
      inject(reason).catch(() => {})
    }, 250)
  }

  webContents.on('did-finish-load', () => scheduleInject('did-finish-load'))
  webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame !== false && isWarehouseManageUrl(url)) scheduleInject('did-navigate-in-page')
  })
  webContents.once('destroyed', () => {
    if (injectionTimer) clearTimeout(injectionTimer)
    injectionTimer = null
  })
}

module.exports = {
  WAREHOUSE_MANAGE_HOST,
  WAREHOUSE_MANAGE_PATH,
  isWarehouseManageUrl,
  loadWarehouseToolSource,
  attachWarehouseRegionTool
}
