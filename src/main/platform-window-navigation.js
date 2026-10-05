/**
 * BrowserWindow.loadURL 在服务端重定向或页面主动跳转时会拒绝并携带
 * ERR_ABORTED（-3）。这不是网络加载错误，后续目标页仍会继续加载。
 */
function isExpectedNavigationAbort(error) {
  const code = String(error?.code || '').toUpperCase()
  const message = String(error?.message || error || '').toUpperCase()
  return code === 'ERR_ABORTED' || /ERR_ABORTED\s*\(-?3\)/.test(message) || message.includes('ERR_ABORTED')
}

/**
 * Electron 的 loadURL 会在服务端重定向时拒绝 Promise，即使新页面仍在正常加载。
 * 统一吞掉这种预期内的 ERR_ABORTED，其他网络错误继续向上抛出。
 */
async function loadURLAllowingExpectedAbort(win, url) {
  try {
    await win.loadURL(url)
    return { redirected: false, url: win.webContents?.getURL?.() || url }
  } catch (error) {
    if (win?.isDestroyed?.() || !isExpectedNavigationAbort(error)) throw error
    return { redirected: true, url: win.webContents?.getURL?.() || url }
  }
}

function createStandardChromeIdentity(chromeVersion) {
  const version = String(chromeVersion || '134.0.0.0')
  const majorVersion = version.split('.')[0] || '134'
  return {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
    secChUa: `"Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}", "Not-A.Brand";v="99"`
  }
}

module.exports = {
  createStandardChromeIdentity,
  isExpectedNavigationAbort,
  loadURLAllowingExpectedAbort
}
