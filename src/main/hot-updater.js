const { app } = require('electron')
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const HOT_UPDATE_DIR = path.join(app.getPath('userData'), 'hot-update')
const VERSION_FILE = path.join(HOT_UPDATE_DIR, 'version.json')

// 获取当前热更新版本（优先使用热更新版本，否则返回 app 内置版本）
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
// 开发模式不使用热更新 renderer
function getHotUpdateRendererPath() {
  if (!app.isPackaged) return null
  const indexHtml = path.join(HOT_UPDATE_DIR, 'renderer', 'index.html')
  if (fs.existsSync(indexHtml)) {
    return indexHtml
  }
  return null
}

// 获取热更新 preload 路径（如存在）
// 开发模式不使用热更新 preload
// 拒绝 bytenode 存根（包含 require('bytenode') 的文件），因为在热更新目录中无法解析
function getHotUpdatePreloadPath() {
  if (!app.isPackaged) return null
  const preloadJs = path.join(HOT_UPDATE_DIR, 'preload', 'index.js')
  if (!fs.existsSync(preloadJs)) return null
  // 安全检查：拒绝 bytenode 存根
  try {
    const content = fs.readFileSync(preloadJs, 'utf-8')
    if (content.includes('bytenode')) {
      console.warn('[HotUpdater] 跳过 bytenode 存根 preload，回退到内置版本')
      return null
    }
  } catch (e) {
    return null
  }
  return preloadJs
}

// 解析应用资源路径：优先从热更新目录查找，否则从 app.asar 内查找
// relativePath: 相对于 app 根目录的路径，如 'out/main/purchase-preload.js'
function resolveAppPath(relativePath) {
  // 开发模式不使用热更新
  if (!app.isPackaged) {
    return path.join(app.getAppPath(), relativePath)
  }
  // 优先从热更新目录查找
  const hotPath = path.join(HOT_UPDATE_DIR, relativePath)
  if (fs.existsSync(hotPath)) {
    return hotPath
  }
  // 回退到 app.asar 内路径
  return path.join(app.getAppPath(), relativePath)
}

// 检查主进程热更新是否存在且有效
// 开发模式下不使用热更新
function hasMainProcessUpdate() {
  if (!app.isPackaged) return false
  try {
    if (!fs.existsSync(VERSION_FILE)) return false
    const data = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8'))
    if (!data.mainUpdate) return false
    const mainJsc = path.join(HOT_UPDATE_DIR, 'main', 'index.jsc')
    const mainJs = path.join(HOT_UPDATE_DIR, 'main', 'index.js')
    return fs.existsSync(mainJsc) && fs.existsSync(mainJs)
  } catch (e) {
    return false
  }
}

// 标记主进程热更新无效（不删除文件，保留用于排查）
function invalidateMainProcessUpdate(reason) {
  try {
    if (!fs.existsSync(VERSION_FILE)) return
    const data = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8'))
    data.mainUpdate = false
    data.invalidationReason = reason
    data.invalidatedAt = new Date().toISOString()
    fs.writeFileSync(VERSION_FILE, JSON.stringify(data, null, 2), 'utf-8')
    console.log('[HotUpdater] 主进程热更新已标记无效:', reason)
  } catch (e) {
    console.error('[HotUpdater] 标记主进程热更新无效失败:', e.message)
  }
}

// 清除热更新目录（全量更新安装后首次启动时调用）
function clearHotUpdate() {
  try {
    if (fs.existsSync(HOT_UPDATE_DIR)) {
      fs.rmSync(HOT_UPDATE_DIR, { recursive: true, force: true })
      console.log('[HotUpdater] 已清除热更新目录')
    }
  } catch (e) {
    console.error('[HotUpdater] 清除热更新目录失败:', e.message)
  }
}

// 下载并应用热更新
// url: 下载地址
// expectedSha256: 期望的 SHA256 哈希值（为空则跳过校验）
// onProgress: 进度回调 (percent)
function downloadAndApplyUpdate(url, expectedSha256, onProgress) {
  return new Promise((resolve, reject) => {
    // 根据URL协议选择正确的模块（http或https）
    const requestModule = url.startsWith('https') ? https : http
    requestModule.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error('下载失败: HTTP ' + res.statusCode))
      }
      const totalSize = parseInt(res.headers['content-length'] || '0', 10)
      const tmpFile = path.join(app.getPath('temp'), 'dianxiaoer-update.zip')
      const ws = fs.createWriteStream(tmpFile)
      let downloaded = 0

      res.on('data', (chunk) => {
        downloaded += chunk.length
        if (onProgress && totalSize > 0) {
          onProgress(Math.round((downloaded / totalSize) * 100))
        }
      })

      res.pipe(ws)

      ws.on('finish', () => {
        try {
          // SHA256 校验
          if (expectedSha256) {
            const hash = crypto.createHash('sha256')
            hash.update(fs.readFileSync(tmpFile))
            const actualSha256 = hash.digest('hex')
            if (actualSha256 !== expectedSha256) {
              try { fs.unlinkSync(tmpFile) } catch (e) {}
              return reject(new Error('SHA256 校验失败，文件可能已损坏'))
            }
          }

          const AdmZip = require('adm-zip')
          const zip = new AdmZip(tmpFile)

          // 清除旧的热更新目录（使用临时目录实现原子性）
          // 先解压到临时目录，成功后再替换，避免解压失败导致旧数据丢失
          const stagingDir = HOT_UPDATE_DIR + '-staging'
          try {
            if (fs.existsSync(stagingDir)) {
              fs.rmSync(stagingDir, { recursive: true, force: true })
            }
            fs.mkdirSync(stagingDir, { recursive: true })

            // 解压到临时目录
            zip.extractAllTo(stagingDir, true)

            // 解压成功后，替换旧目录
            if (fs.existsSync(HOT_UPDATE_DIR)) {
              fs.rmSync(HOT_UPDATE_DIR, { recursive: true, force: true })
            }
            fs.renameSync(stagingDir, HOT_UPDATE_DIR)
          } catch (extractErr) {
            // 解压或替换失败，清理临时目录
            try { fs.rmSync(stagingDir, { recursive: true, force: true }) } catch (e2) {}
            throw extractErr
          }

          // 删除临时文件
          try { fs.unlinkSync(tmpFile) } catch (e) {}

          console.log('[HotUpdater] 热更新已应用到:', HOT_UPDATE_DIR)
          resolve(true)
        } catch (e) {
          try { fs.unlinkSync(tmpFile) } catch (e2) {}
          reject(e)
        }
      })

      ws.on('error', (err) => {
        try { fs.unlinkSync(tmpFile) } catch (e) {}
        reject(err)
      })
      res.on('error', (err) => {
        try { fs.unlinkSync(tmpFile) } catch (e) {}
        reject(err)
      })
    }).on('error', (err) => {
      try { fs.unlinkSync(path.join(app.getPath('temp'), 'dianxiaoer-update.zip')) } catch (e) {}
      reject(err)
    })
      .on('timeout', function () { this.destroy(); reject(new Error('下载超时')) })
  })
}

module.exports = {
  getCurrentVersion,
  getHotUpdateRendererPath,
  getHotUpdatePreloadPath,
  resolveAppPath,
  hasMainProcessUpdate,
  invalidateMainProcessUpdate,
  clearHotUpdate,
  downloadAndApplyUpdate
}
