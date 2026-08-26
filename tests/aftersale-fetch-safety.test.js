import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

describe('售后纠纷同步安全机制', () => {
  const fetchSource = fs.readFileSync('src/main/aftersale-fetch.js', 'utf8')
  const viewSource = fs.readFileSync('src/renderer/src/views/aftersale/ReturnExchange.vue', 'utf8')
  const preloadSource = fs.readFileSync('src/preload/index.js', 'utf8')

  it('不会使用可能永久悬空的 async Promise executor', () => {
    expect(fetchSource).not.toContain('new Promise(async')
    expect(fetchSource).toContain("message: '读取店铺Cookie失败: ' + error.message")
  })

  it('同一店铺复用进行中的同步并安全清理轮询窗口', () => {
    expect(fetchSource).toContain('activeAftersaleFetches.get(key)')
    expect(fetchSource).toContain('aftersaleFetchQueue')
    expect(fetchSource).toContain('action=reuse_inflight')
    expect(fetchSource).toContain('if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }')
    expect(fetchSource).toContain('if (!win || win.isDestroyed() || resolved) return')
  })

  it('服务端 HTTP 200 仍需业务 code 为 0 才判定保存成功', () => {
    expect(fetchSource).toContain('if (result.code === 0)')
    expect(fetchSource).toContain("message: result.message || '服务器保存售后指标失败'")
  })

  it('自动同步由用户勾选控制且 IPC 仅通过白名单暴露', () => {
    expect(viewSource).toContain('v-model="autoSyncEnabled"')
    expect(viewSource).toContain('每小时自动同步')
    expect(fetchSource).toContain("ipcMain.handle('toggle-aftersale-auto-sync'")
    expect(fetchSource).toContain("ipcMain.handle('aftersale-auto-sync-status'")
    expect(fetchSource).toContain("autoSyncController.run('enabled')")
    expect(preloadSource).toContain("'toggle-aftersale-auto-sync'")
    expect(preloadSource).toContain("'aftersale-auto-sync-status'")
    expect(preloadSource).toContain("'aftersale-auto-sync-start'")
  })
})
