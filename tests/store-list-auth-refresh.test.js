import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const storeManageSource = readFileSync(
  new URL('../src/renderer/src/views/user/StoreManage.vue', import.meta.url),
  'utf8'
)
const storeApiSource = readFileSync(
  new URL('../src/renderer/src/api/store.js', import.meta.url),
  'utf8'
)
const appLayoutSource = readFileSync(
  new URL('../src/renderer/src/layout/AppLayout.vue', import.meta.url),
  'utf8'
)
const mainSource = readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8')
const heartbeatSource = readFileSync(new URL('../src/main/cookie-heartbeat.js', import.meta.url), 'utf8')

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('店铺列表登录切换恢复', () => {
  let values
  let dispatchEvent

  beforeEach(() => {
    vi.resetModules()
    values = new Map([['accessToken', 'old-token']])
    dispatchEvent = vi.fn()
    vi.stubGlobal('localStorage', {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key)
    })
    vi.stubGlobal('window', {
      dispatchEvent,
      location: { hash: '' },
      electronAPI: { invoke: vi.fn().mockResolvedValue(undefined) }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('GET 请求期间令牌切换时使用新令牌重试并返回新会话数据', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (_url, options) => {
        expect(options.headers.Authorization).toBe('Bearer old-token')
        values.set('accessToken', 'new-token')
        return jsonResponse({ code: 0, data: { list: [], total: 0 } })
      })
      .mockImplementationOnce(async (_url, options) => {
        expect(options.headers.Authorization).toBe('Bearer new-token')
        return jsonResponse({ code: 0, data: { list: [{ id: 21 }], total: 1 } })
      })
    vi.stubGlobal('fetch', fetchMock)

    const { request } = await import('../src/renderer/src/api/request.js')
    const result = await request('/api/stores', { method: 'GET' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.total).toBe(1)
    expect(values.get('accessToken')).toBe('new-token')
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('旧 GET 请求返回 401 时不会清除刚登录的新令牌', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        values.set('accessToken', 'new-token')
        return jsonResponse({ code: 1, message: '当前端登录已失效，请重新登录' }, 401)
      })
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { list: [{ id: 52 }], total: 1 } }))
    vi.stubGlobal('fetch', fetchMock)

    const { request } = await import('../src/renderer/src/api/request.js')
    const result = await request('/api/stores', { method: 'GET' })

    expect(result.list).toEqual([{ id: 52 }])
    expect(values.get('accessToken')).toBe('new-token')
    expect(window.location.hash).toBe('')
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('店铺管理页面每次从 keep-alive 恢复时重新拉取列表', () => {
    expect(storeManageSource).toContain('onActivated(() => {')
    expect(storeManageSource).toContain('scheduleStoreRefresh()')
    expect(storeManageSource).toContain('不能继续展示旧登录会话留下的空列表')
  })

  it('单个可选 IPC 通道不兼容时不会中断页面挂载', () => {
    expect(storeManageSource).toContain('function listenForUpdate(channel, handler)')
    expect(storeManageSource).toContain('IPC 监听不可用: ${channel}')
    expect(storeManageSource).toContain("listenForUpdate('platform-login-risk'")
  })

  it('店铺列表固定通过主进程代理加载，绕过 renderer 请求异常', () => {
    expect(storeApiSource).toContain("getThroughMain('/api/stores', params)")
  })

  it('主界面恢复时把当前令牌重新同步给主进程', () => {
    expect(appLayoutSource).toContain("const activeToken = localStorage.getItem('accessToken')")
    expect(appLayoutSource).toContain("invoke('set-auth-token', activeToken)")
  })

  it('恢复有效登录态时由主进程兜底恢复主页窗口尺寸', () => {
    expect(mainSource).toContain('function normalizeMainWindowSize(win)')
    expect(mainSource).toContain('normalizeMainWindowSize(BrowserWindow.fromWebContents(event.sender))')
  })

  it('店铺灯优先展示当前电脑的 Cookie 状态并在刷新后保留', () => {
    expect(storeManageSource).toContain('const localOnlineOverrides = new Map()')
    expect(storeManageSource).toContain("listenForUpdate('auto-sync-result'")
    expect(storeManageSource).toContain("typeof localOnline === 'boolean' ? localOnline : !!online")
    expect(storeManageSource).toContain('localOnlineOverrides.get(String(row.id))')
    expect(heartbeatSource).toContain('localOnline,')
    expect(heartbeatSource).toContain('overallOnline: online')
  })

  it('主进程代理请求沿用认证解析并返回数据', async () => {
    const invoke = vi.fn().mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      data: JSON.stringify({ code: 0, data: { list: [{ id: 21 }], total: 1 } })
    })
    window.electronAPI.invoke = invoke

    const { getThroughMain } = await import('../src/renderer/src/api/request.js')
    const result = await getThroughMain('/api/stores', { page: 1 })

    expect(result.total).toBe(1)
    expect(invoke).toHaveBeenCalledWith('proxy-fetch', expect.objectContaining({
      url: expect.stringContaining('/api/stores?page=1'),
      headers: expect.objectContaining({ Authorization: 'Bearer old-token' })
    }))
  })
})
