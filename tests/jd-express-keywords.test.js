import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildFixedKeywordBidList,
  fetchPrivateBusinessKeywords
} = require('../src/main/jd-express-keywords')

const unit = {
  cid2Id: '20',
  categoryId: '301'
}

describe('京东快车商智关键词来源', () => {
  it('优先使用京东商智实时结果，不读取私有缓存', async () => {
    const requestJson = vi.fn()
    const queryLiveBusinessRows = vi.fn().mockResolvedValue({
      status: 0,
      content: [
        { keyword: '实时高成交词', gmvCj: 20 },
        { keyword: '实时普通词', gmvCj: 10 }
      ]
    })

    const result = await fetchPrivateBusinessKeywords(
      {},
      unit,
      4,
      requestJson,
      queryLiveBusinessRows
    )

    expect(result).toMatchObject({
      keywords: ['实时高成交词', '实时普通词'],
      usedCidLevel: '3',
      source: 'szgateway.jd.com'
    })
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('实时结果为空时读取同类目私有缓存', async () => {
    const requestJson = vi.fn().mockResolvedValue({
      code: 0,
      data: [{ keyword: '缓存成交词', gmvCj: 8 }]
    })
    const result = await fetchPrivateBusinessKeywords(
      {},
      unit,
      4,
      requestJson,
      async () => ({ status: 0, content: [] })
    )

    expect(result).toMatchObject({
      keywords: ['缓存成交词'],
      usedCidLevel: '3',
      source: 'inner.dou-live.com/jd_brand'
    })
    expect(requestJson).toHaveBeenCalledOnce()
  })

  it('三级实时与缓存均为空时按原工具回退到二级类目', async () => {
    const liveCalls = []
    const result = await fetchPrivateBusinessKeywords(
      {},
      unit,
      4,
      async () => ({ code: 0, data: [] }),
      async (_cid2Id, categoryId) => {
        liveCalls.push(categoryId)
        return categoryId
          ? { status: 0, content: [] }
          : { status: 0, content: [{ keyword: '二级类目词', gmvCj: 6 }] }
      }
    )

    expect(liveCalls).toEqual(['301', ''])
    expect(result).toMatchObject({
      keywords: ['二级类目词'],
      usedCidLevel: '2',
      source: 'szgateway.jd.com'
    })
  })
})

describe('京东快车自定义关键词出价', () => {
  it('给每个关键词设置完全相同的固定低价', () => {
    expect(buildFixedKeywordBidList(['保温杯', '儿童水杯'], 0.3)).toEqual([
      { reqType: 6, type: 8, keywordMobilePrice: 0.3, keywordName: '保温杯' },
      { reqType: 6, type: 8, keywordMobilePrice: 0.3, keywordName: '儿童水杯' }
    ])
  })

  it('固定出价最低按 0.1 元提交', () => {
    expect(buildFixedKeywordBidList(['保温杯'], 0)).toEqual([
      { reqType: 6, type: 8, keywordMobilePrice: 0.1, keywordName: '保温杯' }
    ])
  })

  it('按选择提交精确、短语、切词匹配，无效值回退切词', () => {
    expect(buildFixedKeywordBidList(['保温杯'], 0.2, 1)[0].type).toBe(1)
    expect(buildFixedKeywordBidList(['保温杯'], 0.2, 4)[0].type).toBe(4)
    expect(buildFixedKeywordBidList(['保温杯'], 0.2, 8)[0].type).toBe(8)
    expect(buildFixedKeywordBidList(['保温杯'], 0.2, 99)[0].type).toBe(8)
  })
})
