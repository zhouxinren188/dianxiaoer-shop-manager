import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  buildSceneCrowdBody,
  buildSceneCategoryBody,
  buildSceneCrowdSignature,
  extractSceneCategories,
  extractSceneCrowdPage,
  defaultSceneCrowds,
  assertCrowdSettings,
  requiresCrowdSeed,
  mergeCrowdOptions,
  normalizeCrowdSettings
} = require('../src/main/jd-express-crowds')

describe('京东快车人群加载', () => {
  it('通过受控 preload 通道加载人群', () => {
    const preloadSource = readFileSync(new URL('../src/preload/index.js', import.meta.url), 'utf8')
    expect(preloadSource).toContain("'jd-express-crowds'")
  })

  it('对齐浩辰自定义的场景分类和人群请求，不再混入种子模板', () => {
    expect(buildSceneCategoryBody()).toEqual({ businessType: 2, requestFrom: 0 })
    expect(buildSceneCrowdBody(7, 2)).toEqual({
      adGroupId: null, businessType: 2, crowdName: '', firstSenceCategory: 7,
      secondSenceCategory: -1, pageIndex: 2, pageSize: 40, resources: [],
      crowdTabType: 1, adGroupSkus: [], adShopIds: [], adGroupBidPrice: 0,
      adGroupBillingType: 0, adGroupAdType: 0, isFavorite: 0, cityIds: [], requestFrom: 0
    })
  })

  it('仅加载顶层场景，保留分类 0、去重，严格识别场景响应', () => {
    expect(extractSceneCategories({ data: [
      { categoryCode: 0, categoryName: '默认', level: 0 },
      { categoryCode: 1, categoryName: '次级', level: 1 },
      { categoryCode: 0, categoryName: '重复', level: 0 }
    ] })).toEqual([{ categoryCode: 0, categoryName: '默认' }])
    expect(extractSceneCrowdPage({ data: { data: [{ crowdId: 9001 }], total: 125 } }))
      .toEqual({ crowds: [{ crowdId: 9001 }], total: 125 })
    expect(extractSceneCrowdPage({ data: { data: [] } }).total).toBeNull()
    expect(() => extractSceneCrowdPage({ data: { recommendCrowds: [] } })).toThrow('格式异常')
    expect(() => extractSceneCategories({ data: {} })).toThrow('格式异常')
  })

  it('分类、人群签名使用 8765b 和浩辰相同的有序字段，页码同步签名', () => {
    expect(buildSceneCrowdSignature(buildSceneCategoryBody())).toEqual({
      appId: '8765b', text: 'businessType:2&encryptSignApiAppId:encryptSignApiAppId',
      stk: 'businessType%2CencryptSignApiAppId'
    })
    const signature = buildSceneCrowdSignature(buildSceneCrowdBody(0, 2))
    expect(signature.appId).toBe('8765b')
    expect(signature.text).toBe('adGroupAdType:0&adGroupBidPrice:0&adGroupBillingType:0&businessType:2&crowdName:&crowdTabType:1&encryptSignApiAppId:encryptSignApiAppId&firstSenceCategory:0&isFavorite:0&pageIndex:2&pageSize:40&secondSenceCategory:-1')
    expect(decodeURIComponent(signature.stk)).toBe(signature.text.split('&').map(item => item.split(':')[0]).join(','))
  })

  it('购买、浏览均可选且不填虚假的店铺覆盖数；新选择默认 30，已设溢价不变', () => {
    expect(defaultSceneCrowds().map(item => item.crowdId)).toEqual([100, 101])
    expect(defaultSceneCrowds().every(item => !requiresCrowdSeed(item) && item.adGroupPrice === 30)).toBe(true)
    expect(defaultSceneCrowds()[0]).not.toHaveProperty('estimateUv')
    expect(normalizeCrowdSettings([{ crowdId: 123, adGroupPrice: 10 }])[0].adGroupPrice).toBe(10)
    expect(() => assertCrowdSettings([])).not.toThrow()
  })

  it.each([{ crowdType: 4 }, { recommendCrowdType: 2 }, { requiresSeed: true }])('需要种子的人群不能作为普通场景人群直接提交：%j', fields => {
    expect(() => assertCrowdSettings([{ crowdId: 762589, crowdName: '店铺或品牌相关人群', ...fields }]))
      .toThrow('按场景类型重新选择')
    try { assertCrowdSettings([{ crowdId: 762589, ...fields }]) } catch (error) {
      expect(error.code).toBe('JD_EXPRESS_CROWD_SEED_REQUIRED')
    }
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
    expect(result.map((item) => item.source)).toEqual(['default', 'default', 'scene'])
    expect(result.every((item) => item.adGroupPrice === 30 && item.isUsed === 1)).toBe(true)
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
