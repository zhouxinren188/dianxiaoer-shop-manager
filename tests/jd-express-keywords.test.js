import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { fetchPrivateBusinessKeywords } = require('../src/main/jd-express-keywords')

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
