import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const mainSource = readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../src/preload/index.js', import.meta.url), 'utf8')
const layoutSource = readFileSync(new URL('../src/renderer/src/layout/AppLayout.vue', import.meta.url), 'utf8')

describe('主窗口关闭控制', () => {
  it('自绘关闭按钮保持应用内确认样式，renderer 无响应时才原生兜底', () => {
    expect(preloadSource).toContain("'window-request-close'")
    expect(preloadSource).toContain("'window-close-prompt-shown'")
    expect(mainSource).toContain("ipcMain.handle('window-request-close'")
    expect(mainSource).toContain("mainWindow.webContents.send('app-close-requested')")
    expect(mainSource).toContain('void confirmApplicationQuit(mainWindow)')
    expect(layoutSource).toContain("invoke('window-close-prompt-shown')")
    expect(layoutSource).toContain('showQuitConfirm()')
  })
})
