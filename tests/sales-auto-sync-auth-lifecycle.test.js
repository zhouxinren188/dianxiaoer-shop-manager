import fs from 'fs'
import { describe, expect, it } from 'vitest'

const mainSource = fs.readFileSync('src/main/index.js', 'utf8')
const loginSource = fs.readFileSync('src/renderer/src/views/login/LoginPage.vue', 'utf8')
const userApiSource = fs.readFileSync('src/renderer/src/api/user.js', 'utf8')

describe('销售订单自动同步登录生命周期', () => {
  it('登录成功后按本机已保存的开关直接恢复同步', () => {
    const tokenSync = loginSource.indexOf("invoke('set-auth-token', token)")
    const preferenceCheck = loginSource.indexOf("localStorage.getItem('jdAutoSyncEnabled') === 'true'", tokenSync)
    const autoSyncStart = loginSource.indexOf("invoke('toggle-jd-auto-sync', { enabled: true })", preferenceCheck)

    expect(tokenSync).toBeGreaterThan(-1)
    expect(preferenceCheck).toBeGreaterThan(tokenSync)
    expect(autoSyncStart).toBeGreaterThan(preferenceCheck)
  })

  it('清除鉴权时由主进程停止销售订单同步', () => {
    expect(mainSource).toContain("const { registerSalesOrderIpc, startAutoSync, stopAutoSync } = require('./sales-order-fetch')")
    const authHandler = mainSource.slice(
      mainSource.indexOf("ipcMain.handle('set-auth-token'"),
      mainSource.indexOf('// ★ 主进程代理 HTTP 请求')
    )
    expect(authHandler).toContain('if (!token)')
    expect(authHandler).toContain('stopAutoSync()')
  })

  it('主动退出时先通知主进程停止同步，再等待远程退出', () => {
    const logoutStart = userApiSource.indexOf('export async function logout()')
    const clearMain = userApiSource.indexOf("invoke('set-auth-token', null)", logoutStart)
    const remoteLogout = userApiSource.indexOf("await post('/api/auth/logout')", logoutStart)

    expect(clearMain).toBeGreaterThan(logoutStart)
    expect(remoteLogout).toBeGreaterThan(clearMain)
  })
})
