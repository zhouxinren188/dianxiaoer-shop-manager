import { afterEach, describe, expect, it, vi } from 'vitest'
import autoSyncModule from '../src/main/aftersale-auto-sync.js'

const {
  DEFAULT_AFTERSALE_AUTO_SYNC_INTERVAL_MS,
  createAftersaleAutoSync,
  isAuthRelatedFailure
} = autoSyncModule

afterEach(() => {
  vi.useRealTimers()
})

describe('商家售后纠纷每小时自动同步', () => {
  it('登录后等待一小时再执行，并按店铺串行同步', async () => {
    vi.useFakeTimers()
    const order = []
    const controller = createAftersaleAutoSync({
      getToken: () => 'token-a',
      listStores: async () => [{ id: 1 }, { id: 2 }],
      syncStore: async storeId => {
        order.push(storeId)
        return { success: true }
      }
    })

    controller.start()
    expect(order).toEqual([])
    expect(controller.getNextRunAt() - Date.now()).toBe(DEFAULT_AFTERSALE_AUTO_SYNC_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(DEFAULT_AFTERSALE_AUTO_SYNC_INTERVAL_MS - 1)
    expect(order).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(order).toEqual([1, 2])
    expect(controller.hasScheduledRun()).toBe(true)
  })

  it('已有同步运行时复用同一个任务，避免重复打开隐藏窗口', async () => {
    let releaseFirstStore
    const firstStoreDone = new Promise(resolve => { releaseFirstStore = resolve })
    let syncCalls = 0
    const controller = createAftersaleAutoSync({
      getToken: () => 'token-a',
      listStores: async () => [{ id: 1 }],
      syncStore: async () => {
        syncCalls++
        await firstStoreDone
        return { success: true }
      }
    })

    controller.start()
    const firstRun = controller.run('manual')
    const secondRun = controller.run('timer')
    await Promise.resolve()
    expect(syncCalls).toBe(1)
    releaseFirstStore()
    expect(await firstRun).toEqual(await secondRun)
    expect(syncCalls).toBe(1)
  })

  it('同步期间登录身份变化时停止后续店铺，防止跨账号继续同步', async () => {
    let token = 'token-a'
    const synced = []
    const controller = createAftersaleAutoSync({
      getToken: () => token,
      listStores: async () => [{ id: 1 }, { id: 2 }],
      syncStore: async storeId => {
        synced.push(storeId)
        token = 'token-b'
        return { success: true }
      }
    })

    controller.start()
    const result = await controller.run('manual')
    expect(synced).toEqual([1])
    expect(result.interrupted).toBe(true)
    expect(result.reason).toBe('auth_changed')
    expect(result.skipCount).toBe(1)
  })

  it('把 Cookie 缺失、未登录和登录过期归类为跳过', () => {
    expect(isAuthRelatedFailure({ message: '店铺没有京东Cookie' })).toBe(true)
    expect(isAuthRelatedFailure({ message: '店铺登录已过期' })).toBe(true)
    expect(isAuthRelatedFailure({ message: '服务器返回 500' })).toBe(false)
  })

  it('兼容 store_id 并记录每个店铺的同步结果', async () => {
    const logs = []
    const synced = []
    const controller = createAftersaleAutoSync({
      getToken: () => 'token-a',
      listStores: async () => [{ store_id: 8 }, { id: 9 }, {}],
      syncStore: async storeId => {
        synced.push(storeId)
        return storeId === 8
          ? { success: true }
          : { success: false, message: '服务器返回 500' }
      },
      log: message => logs.push(message)
    })

    controller.start()
    const result = await controller.run('manual')
    expect(synced).toEqual([8, 9])
    expect(result).toMatchObject({ total: 3, successCount: 1, failCount: 2 })
    expect(logs).toContain('store_completed store_id=8 result=success')
    expect(logs.some(message => message.includes('store_id=9 result=failed'))).toBe(true)
    expect(logs).toContain('store_failed store_id=missing reason=missing_store_id')
  })
})
