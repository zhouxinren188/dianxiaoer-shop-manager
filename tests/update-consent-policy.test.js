import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const managerSource = fs.readFileSync(path.join(root, 'src/main/update-manager.js'), 'utf8')
const updaterSource = fs.readFileSync(path.join(root, 'src/main/updater.js'), 'utf8')
const preloadSource = fs.readFileSync(path.join(root, 'src/preload/index.js'), 'utf8')
const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/src/components/AppUpdater.vue'), 'utf8')
const apiSource = fs.readFileSync(path.join(root, 'server-api/index.js'), 'utf8')

describe('客户端更新必须取得用户明确同意', () => {
  it('发现更新时不自动下载', () => {
    expect(managerSource).toContain('auto_download=no')
    expect(managerSource).not.toContain('检测到全量更新，自动开始下载')
  })

  it('下载完成后不按定时器强制安装', () => {
    expect(managerSource).toContain('explicit_consent_required=yes')
    expect(managerSource).not.toContain('渲染进程未响应安装请求，自动安装重启')
  })

  it('退出应用时不静默安装', () => {
    expect(updaterSource).toContain('autoUpdater.autoInstallOnAppQuit = false')
    expect(updaterSource).not.toContain('autoUpdater.autoInstallOnAppQuit = true')
  })

  it('仍保留用户主动安装入口', () => {
    expect(managerSource).toContain("ipcMain.handle('um-download'")
    expect(managerSource).toContain("ipcMain.handle('um-install'")
    expect(managerSource).toContain('autoUpdater.quitAndInstall(true, true)')
  })

  it('renderer 挂载后会恢复可能错过的更新状态', () => {
    expect(preloadSource).toContain("'um-get-state'")
    expect(managerSource).toContain("ipcMain.handle('um-get-state'")
    expect(rendererSource).toContain("invoke('um-get-state')")
    expect(rendererSource.indexOf('registerListeners()')).toBeLessThan(rendererSource.indexOf('await restoreUpdateState()'))
  })

  it('服务端兼容未上传 appVersion 的旧基础版本', () => {
    expect(apiSource).toContain('const effectiveAppVersion = appVersion || currentVersion')
    expect(apiSource).toContain("appNum <= parseVersion('1.9.104')")
  })
})
