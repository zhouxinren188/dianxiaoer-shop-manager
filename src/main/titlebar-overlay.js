/**
 * titlebar-overlay.js - CEF 无边框窗口的标题栏覆盖层
 *
 * CEF 模式下 BrowserWindow 使用 frame:false + transparent:true，
 * 没有 native 标题栏和窗口控制按钮。此模块创建一个独立的小窗口
 * 浮在 CEF 内容之上，提供最小化/最大化/关闭按钮。
 *
 * 使用独立窗口而非 HTML 注入的原因：
 *   Electron renderer 被设为 WS_EX_TRANSPARENT | WS_EX_LAYERED（让鼠标事件穿透到 CEF），
 *   所以无法在 renderer 内放置可点击的按钮。
 */

const { BrowserWindow } = require('electron')

const BTN_W = 46
const BAR_H = 32
const TOTAL_W = BTN_W * 3

const TITLEBAR_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:transparent;overflow:hidden;height:${BAR_H}px;display:flex;justify-content:flex-end;-webkit-app-region:no-drag;-webkit-user-select:none}
.bar{display:flex;height:${BAR_H}px;direction:rtl}
.btn{width:${BTN_W}px;height:${BAR_H}px;border:none;background:rgba(255,255,255,0.01);
  color:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;
  cursor:pointer;transition:background 0.15s;text-decoration:none;font-size:14px;line-height:1}
.btn:hover{background:rgba(0,0,0,0.06)}
.btn-close:hover{background:#e81123;color:#fff}
svg{width:10px;height:10px;pointer-events:none}
</style></head><body>
<div class="bar">
<a class="btn btn-close" href="titlebar://close">
  <svg viewBox="0 0 10 10"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.2"/><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.2"/></svg>
</a>
<a class="btn" href="titlebar://maximize">
  <svg viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1"/></svg>
</a>
<a class="btn" href="titlebar://minimize">
  <svg viewBox="0 0 10 10"><line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" stroke-width="1"/></svg>
</a>
</div>
</body></html>`

/**
 * 创建标题栏覆盖窗口
 * @param {BrowserWindow} mainWindow - CEF 宿主窗口
 * @returns {BrowserWindow|null} 标题栏覆盖窗口
 */
function createTitleBarOverlay(mainWindow) {
  try {
    const overlay = new BrowserWindow({
      width: TOTAL_W,
      height: BAR_H,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      parent: mainWindow,
      show: false,
      focusable: false,
      alwaysOnTop: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      }
    })

    overlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TITLEBAR_HTML))

    // 按钮点击通过 setWindowOpenHandler 拦截 window.open 调用
    overlay.webContents.setWindowOpenHandler(({ url }) => {
      if (url && url.startsWith('titlebar://')) {
        const action = url.replace('titlebar://', '')
        if (mainWindow.isDestroyed()) return { action: 'deny' }
        if (action === 'minimize') {
          mainWindow.minimize()
        } else if (action === 'maximize') {
          if (mainWindow.isMaximized()) mainWindow.unmaximize()
          else mainWindow.maximize()
        } else if (action === 'close') {
          mainWindow.close()
        }
      }
      return { action: 'deny' }
    })

    // 也拦截 will-navigate 作为备用（<a> 点击可能触发导航而非 window.open）
    overlay.webContents.on('will-navigate', (event, url) => {
      if (url && url.startsWith('titlebar://')) {
        event.preventDefault()
        const action = url.replace('titlebar://', '')
        if (mainWindow.isDestroyed()) return
        if (action === 'minimize') {
          mainWindow.minimize()
        } else if (action === 'maximize') {
          if (mainWindow.isMaximized()) mainWindow.unmaximize()
          else mainWindow.maximize()
        } else if (action === 'close') {
          mainWindow.close()
        }
      }
    })

    // 同步位置：让标题栏跟随主窗口移动
    function syncPosition() {
      if (overlay.isDestroyed() || mainWindow.isDestroyed()) return
      try {
        const b = mainWindow.getBounds()
        overlay.setBounds({
          x: b.x + b.width - TOTAL_W - 2,
          y: b.y + 2,
          width: TOTAL_W,
          height: BAR_H,
        })
      } catch (e) {}
    }

    // 每次主窗口获得焦点时，重新将标题栏提到 Z-order 最前
    // CEF 的 MakeOtherChildrenTransparent 会把 CEF 子窗口提到 HWND_TOP，
    // 可能盖住标题栏覆盖窗口，需要重新提升
    function bringToTop() {
      if (overlay.isDestroyed() || mainWindow.isDestroyed()) return
      try {
        overlay.setAlwaysOnTop(true, 'screen')
        overlay.moveTop()
      } catch (e) {}
    }

    mainWindow.on('move', syncPosition)
    mainWindow.on('resize', syncPosition)
    mainWindow.on('maximize', () => { setTimeout(syncPosition, 50); setTimeout(bringToTop, 100) })
    mainWindow.on('unmaximize', () => { setTimeout(syncPosition, 50); setTimeout(bringToTop, 100) })
    mainWindow.on('focus', () => {
      bringToTop()
      syncPosition()
    })

    // 主窗口关闭时连带关闭
    mainWindow.on('closed', () => {
      if (!overlay.isDestroyed()) overlay.destroy()
    })

    // 首次显示
    overlay.once('ready-to-show', () => {
      syncPosition()
      overlay.showInactive()
      // 延迟确保 CEF 窗口已创建后再次提升
      setTimeout(bringToTop, 1000)
    })

    return overlay
  } catch (e) {
    console.error('[TitleBarOverlay] Create failed:', e.message)
    return null
  }
}

module.exports = { createTitleBarOverlay }
