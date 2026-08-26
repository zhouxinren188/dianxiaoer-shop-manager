import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import prefetchModule from '../src/main/taobao-rebate-prefetch.js'

const { createTaobaoRebatePrefetchCache } = prefetchModule

describe('淘宝返利链接预取', () => {
  it('同一货源复用进行中的请求和已完成结果', async () => {
    let finish
    const resolveUrl = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const cache = createTaobaoRebatePrefetchCache({ resolveUrl })
    const url = 'https://detail.tmall.com/item.htm?id=1'

    const first = cache.prepare(url)
    const second = cache.prepare(url)
    await Promise.resolve()
    expect(first.state).toBe('miss')
    expect(second.state).toBe('inflight')
    expect(second.promise).toBe(first.promise)
    expect(resolveUrl).toHaveBeenCalledTimes(1)

    finish({ url: 'https://s.click.taobao.com/first', converted: true })
    await first.promise

    const ready = cache.prepare(url)
    expect(ready.state).toBe('ready')
    await expect(ready.promise).resolves.toMatchObject({ converted: true })
    expect(resolveUrl).toHaveBeenCalledTimes(1)
  })

  it('不同货源各自预取，返回顺序不会互相覆盖', async () => {
    const pending = new Map()
    const resolveUrl = vi.fn(url => new Promise(resolve => pending.set(url, resolve)))
    const cache = createTaobaoRebatePrefetchCache({ resolveUrl })
    const firstUrl = 'https://item.taobao.com/item.htm?id=1'
    const secondUrl = 'https://item.taobao.com/item.htm?id=2'

    const first = cache.prepare(firstUrl)
    const second = cache.prepare(secondUrl)
    await Promise.resolve()
    expect(first.state).toBe('miss')
    expect(second.state).toBe('miss')
    expect(resolveUrl).toHaveBeenCalledTimes(2)

    pending.get(secondUrl)({ url: 'https://s.click.taobao.com/second', converted: true })
    pending.get(firstUrl)({ url: 'https://s.click.taobao.com/first', converted: true })

    await expect(second.promise).resolves.toMatchObject({ url: 'https://s.click.taobao.com/second' })
    await expect(first.promise).resolves.toMatchObject({ url: 'https://s.click.taobao.com/first' })
    await expect(cache.prepare(secondUrl).promise).resolves.toMatchObject({ url: 'https://s.click.taobao.com/second' })
  })

  it('短期缓存过期后重新转链，失败请求不残留', async () => {
    let currentTime = 1000
    const resolveUrl = vi.fn()
      .mockResolvedValueOnce({ url: 'https://s.click.taobao.com/one', converted: true })
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ url: 'https://s.click.taobao.com/two', converted: true })
    const cache = createTaobaoRebatePrefetchCache({
      resolveUrl,
      now: () => currentTime,
      readyTtlMs: 100,
      fallbackTtlMs: 20
    })
    const url = 'https://detail.tmall.com/item.htm?id=3'

    await cache.prepare(url).promise
    currentTime += 101
    await expect(cache.prepare(url).promise).rejects.toThrow('network')
    await expect(cache.prepare(url).promise).resolves.toMatchObject({ url: 'https://s.click.taobao.com/two' })
    expect(resolveUrl).toHaveBeenCalledTimes(3)
  })

  it('采购弹窗、预加载白名单和主进程使用同一个预取通道', () => {
    const preloadSource = readFileSync(new URL('../src/preload/index.js', import.meta.url), 'utf8')
    const mainSource = readFileSync(new URL('../src/main/purchase-order-capture.js', import.meta.url), 'utf8')
    const salesSource = readFileSync(new URL('../src/renderer/src/views/sales/OrderList.vue', import.meta.url), 'utf8')
    const warehouseSource = readFileSync(new URL('../src/renderer/src/views/warehouse/GoodsManage.vue', import.meta.url), 'utf8')

    expect(preloadSource).toContain("'prepare-purchase-order-url'")
    expect(mainSource).toContain("ipcMain.handle('prepare-purchase-order-url'")
    expect(mainSource).toContain("prepareTaobaoRebatePurchaseUrl(decodedTaobaoSource.url, 'open_window')")
    expect(mainSource).toContain("reason: 'prefetch_failed'")
    expect(salesSource).toContain("invoke('prepare-purchase-order-url'")
    expect(warehouseSource).toContain("invoke('prepare-purchase-order-url'")
  })
})
