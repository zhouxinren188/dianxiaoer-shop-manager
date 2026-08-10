import { describe, expect, it } from 'vitest'
import {
  TAOBAO_SAME_HISTORY_MAX_ENTRIES,
  TAOBAO_SAME_HISTORY_STORAGE_KEY,
  TAOBAO_SAME_HISTORY_TTL_MS,
  buildTaobaoSameHistoryKey,
  collectTaobaoSourceItemIds,
  extractTaobaoItemId,
  readTaobaoSameHistory,
  saveTaobaoSameHistory
} from '../src/renderer/src/utils/taobaoSameHistory.js'

function createStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
  }
}

describe('淘宝同款历史记录与货源标识', () => {
  it('从淘宝、天猫及带SKU片段的链接提取商品ID', () => {
    expect(extractTaobaoItemId('https://item.taobao.com/item.htm?id=1028006926567#dxeSku=%7B%7D')).toBe('1028006926567')
    expect(extractTaobaoItemId('https://detail.tmall.com/item.htm?skuId=1&id=593649663690')).toBe('593649663690')
    expect(extractTaobaoItemId({ itemId: 123456 })).toBe('123456')
  })

  it('只收集当前SKU中淘宝和天猫货源的商品ID', () => {
    const ids = collectTaobaoSourceItemIds([
      { platform: 'taobao', purchase_link: 'https://item.taobao.com/item.htm?id=10001' },
      { platform: 'tmall', purchase_link: 'https://detail.tmall.com/item.htm?id=10002' },
      { platform: 'pinduoduo', purchase_link: 'https://mobile.yangkeduo.com/goods.html?goods_id=10003' }
    ])
    expect([...ids]).toEqual(['10001', '10002'])
  })

  it('缓存键隔离登录用户、采购账号、销售SKU和主图', () => {
    const first = buildTaobaoSameHistoryKey({ userId: 'u1', accountId: 8, skuId: 'sku-1', imageUrl: 'https://img/a.jpg?size=200' })
    const same = buildTaobaoSameHistoryKey({ userId: 'u1', accountId: 8, skuId: 'sku-1', imageUrl: 'https://img/a.jpg?size=800' })
    const otherAccount = buildTaobaoSameHistoryKey({ userId: 'u1', accountId: 9, skuId: 'sku-1', imageUrl: 'https://img/a.jpg' })
    expect(first).toBe(same)
    expect(otherAccount).not.toBe(first)
  })

  it('保存并读取最多20条结果，超过有效期后不再命中', () => {
    const storage = createStorage()
    const products = Array.from({ length: 25 }, (_, index) => ({
      itemId: String(index + 1),
      link: `https://item.taobao.com/item.htm?id=${index + 1}`,
      title: `商品${index + 1}`,
      price: index + 0.5
    }))
    expect(saveTaobaoSameHistory(storage, 'cache-key', products, 1000)).toBe(true)
    expect(readTaobaoSameHistory(storage, 'cache-key', 1001)?.products).toHaveLength(20)
    expect(readTaobaoSameHistory(storage, 'cache-key', 1000 + TAOBAO_SAME_HISTORY_TTL_MS + 1)).toBeNull()
  })

  it('按最近写入顺序限制历史记录数量', () => {
    const storage = createStorage()
    for (let index = 0; index < TAOBAO_SAME_HISTORY_MAX_ENTRIES + 3; index += 1) {
      saveTaobaoSameHistory(storage, `key-${index}`, [{ link: `https://item.taobao.com/item.htm?id=${index + 1}` }], index + 1)
    }
    const payload = JSON.parse(storage.getItem(TAOBAO_SAME_HISTORY_STORAGE_KEY))
    expect(payload.entries).toHaveLength(TAOBAO_SAME_HISTORY_MAX_ENTRIES)
    expect(payload.entries[0].key).toBe(`key-${TAOBAO_SAME_HISTORY_MAX_ENTRIES + 2}`)
    expect(payload.entries.at(-1).key).toBe('key-3')
  })
})
