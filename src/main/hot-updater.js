const { app, ipcMain } = require('electron')
const http = require('http')
const fs = require('fs')
const path = require('path')

const UPDATE_SERVER = 'http://150.158.54.108:3001'
const HOT_UPDATE_DIR = path.join(app.getPath('userData'), 'hot-update')
const VERSION_FILE = path.join(HOT_UPDATE_DIR, 'version.json')

// 获取当前版本（优先使用热更新版本）
function getCurrentVersion() {
  try {
    if (fs.existsSync(VERSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8'))
      if (data.version) return data.version
    }
  } catch (e) {}
  return app.getVersion()
}

// 获取热更新 renderer 路径（如存在）
function getHotUpdateRendererPath() {
  const indexHtml = path.join(HOT_UPDATE_DIR, 'renderer', 'index.html')
  if (fs.existsSync(indexHtml)) {
    return indexHtml
  }
  return null
}

// 检查服务器是否有新版本
function checkForHotUpdate() {
  const currentVersion = getCurrentVersion()
  return new Promise((resolve, reject) => {
    const url = `${UPDATE_SERVER}/api/update/check?version=${currentVersion}`
    http.get(url, { timeout: 8000 }, (res) => {
      let data = ''
      res.on('data', chunk => (data += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error('JSON parse error'))
        }
      })
    }).on('error', reject)
      .on('timeout', function () { this.destroy(); reject(new Error('timeout')) })
  })
}

// 下载并应用热更新
function downloadAndApplyUpdate(onProgress) {
  return new Promise((resolve, reject) => {
    const url = `${UPDATE_SERVER}/api/update/download`
    http.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error('Download failed: HTTP ' + res.statusCode))
      }
      const totalSize = parseInt(res.headers['content-length'] || '0', 10)
      const tmpFile = path.join(app.getPath('temp'), 'dianxiaoer-update.zip')
      const ws = fs.createWriteStream(tmpFile)
      let downloaded = 0

      res.on('data', (chunk) => {
        downloaded += chunk.length
        ws.write(chunk)
        if (onProgress && totalSize > 0) {
          onProgress(Math.round((downloaded / totalSize) * 100))
        }
      })

      res.on('end', () => {
        ws.end(() => {
          try {
            const AdmZip = require('adm-zip')
            const zip = new AdmZip(tmpFile)

            // 清除旧的热更新目录
            if (fs.existsSync(HOT_UPDATE_DIR)) {
              fs.rmSync(HOT_UPDATE_DIR, { recursive: true, force: true })
            }
            fs.mkdirSync(HOT_UPDATE_DIR, { recursive: true })

            // 解压到热更新目录
            zip.extractAllTo(HOT_UPDATE_DIR, true)

            // 删除临时文件
            try { fs.unlinkSync(tmpFile) } catch (e) {}

            console.log('[HotUpdater] 热更新已应用到:', HOT_UPDATE_DIR)
            resolve(true)
          } catch (e) {
            reject(e)
          }
        })
      })

      res.on('error', reject)
    }).on('error', reject)
      .on('timeout', function () { this.destroy(); reject(new Error('download timeout')) })
  })
}

// 注册 IPC 通道
function registerHotUpdateIpc(mainWindow) {
  ipcMain.handle('hot-update-check', async () => {
    try {
      const result = await checkForHotUpdate()
      return result
    } catch (e) {
      return { needUpdate: false, error: e.message }
    }
  })

  ipcMain.handle('hot-update-download', async () => {
    try {
      await downloadAndApplyUpdate((percent) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update-progress', { percent })
        }
      })
      return { success: true, message: '更新已下载，重启后生效' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('hot-update-restart', () => {
    app.relaunch()
    app.exit(0)
  })
}

// 自动检查热更新（后台静默）
async function autoCheckHotUpdate(mainWindow) {
  if (!app.isPackaged) {
    console.log('[HotUpdater] 开发模式，跳过热更新检查')
    return
  }
  try {
    const result = await checkForHotUpdate()
    if (result.needUpdate && mainWindow && !mainWindow.isDestroyed()) {
      console.log('[HotUpdater] 发现新版本:', result.version)
      mainWindow.webContents.send('update-available', {
        version: result.version,
        size: result.size,
        changelog: result.changelog
      })
    }
  } catch (e) {
    console.log('[HotUpdater] 检查更新失败:', e.message)
  }
}

module.exports = {
  getCurrentVersion,
  getHotUpdateRendererPath,
  registerHotUpdateIpc,
  autoCheckHotUpdate
}
