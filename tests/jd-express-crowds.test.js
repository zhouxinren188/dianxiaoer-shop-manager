import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildDmpCrowdBody,
  buildRecommendedCrowdBody,
  extractDmpCrowdPage,
  extractRecommendedCrowds,
  mergeCrowdOptions,
  normalizeCrowdSettings
} = require('../src/main/jd-express-crowds')

describe('京东快车人群加载', () => {
  it('通过受控 preload 通道加载人群', () => {
    const preloadSource = readFileSync(new URL('../src/preload/index.js', import.meta.url), 'utf8')
    expect(preloadSource).toContain("'jd-express-crowds'")
  })

  it('对齐浩辰的推荐人群和 DMP 查询参数', () => {
    expect(buildRecommendedCrowdBody()).toEqual({
      adGroupId: null,
      businessType: 2,
      requestFrom: 0
    })
    expect(buildDmpCrowdBody(2, 100)).toEqual({
      adGroupId: null,
      businessType: 2,
      crowdName: null,
      packageIds: null,
      page: 2,
      pageSize: 100,
      type: 1,
      groupId: null,
      requestFrom: 0
    })
  })

  it('解析浩辰使用的两类京准通响应', () => {
    expect(extractRecommendedCrowds({ data: { recommendCrowds: [{ crowdId: 100 }] } }))
      .toEqual([{ crowdId: 100 }])
    expect(extractDmpCrowdPage({
      success: true,
      data: { datas: [{ crowdId: 9001 }], paginator: { items: 125 } }
    })).toEqual({ crowds: [{ crowdId: 9001 }], total: 125 })
  })

  it('合并去重后优先显示默认购买、默认浏览和推荐人群', () => {
    const result = mergeCrowdOptions([
      { crowdId: 101, crowdName: '默认浏览人群' },
      { crowdId: 100, crowdName: '默认购买人群' }
    ], [
      { crowdId: 9001, crowdName: '店铺人群' },
      { crowdId: 100, crowdName: '重复的人群' }
    ])
    expect(result.map((item) => item.crowdId)).toEqual([100, 101, 9001])
    expect(result.map((item) => item.source)).toEqual(['recommended', 'recommended', 'dmp'])
    expect(result.every((item) => item.adGroupPrice === 10 && item.isUsed === 1)).toBe(true)
  })

  it('提交时移除界面字段、去重并限制最多 30 个人群', () => {
    const source = Array.from({ length: 35 }, (_, index) => ({
      crowdId: index + 1,
      crowdName: `人群${index + 1}`,
      adGroupPrice: index === 0 ? 9 : 20,
      source: 'dmp',
      editing: true
    }))
    source.splice(1, 0, { crowdId: 1, crowdName: '重复' })
    const result = normalizeCrowdSettings(source)
    expect(result).toHaveLength(30)
    expect(result[0]).toEqual({ crowdId: 1, crowdName: '人群1', adGroupPrice: 10, isUsed: 1 })
    expect(result[0]).not.toHaveProperty('source')
    expect(result[0]).not.toHaveProperty('editing')
  })
})
