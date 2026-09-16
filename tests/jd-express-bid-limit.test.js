import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { applyCustomKeywordBidLimit, KEYWORD_MIN_BID_URL, prepareRoiKeywords } = require('../src/main/jd-express-keywords')
const { assertCustomKeywordBidConfig, normalizeRoiConfig } = require('../src/main/jd-express-utils')
const { createCustomCampaigns, buildCustomAdGroupCommand, CREATE_CAMPAIGN_URL, ADD_ADGROUP_URL } = require('../src/main/jd-express-create')
const { creationOutcome, createCreationLogger } = require('../src/main/jd-express-creation-log')

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 15, 12)) })
afterEach(() => vi.useRealTimers())

const config = normalizeRoiConfig({ createMode: 'custom', useMinKeywordBid: false,
  customKeywordBid: 0.1, maxCustomKeywordBid: 0.5, keywordMatchType: 4, startDate: '2026-09-15', automatedBiddingType: 0 })
const makeUnit = (name, keywords) => ({ unitName: name, products: [{ skuId: name, name: '商品' }],
  keywordList: keywords.map(keywordName => ({ reqType: 6, type: 4, keywordName, keywordMobilePrice: 0.1 })) })

function options(overrides = {}) {
  return { config, unit: makeUnit('单元1', ['低价词', '抬价词', '上限词', '超价词', '缺失词']),
    platformSession: {}, requestJson: vi.fn(async () => ({ code: 1, data: [
      { keywordName: '低价词', minBidPrice: 0.1 }, { keywordName: '抬价词', minBidPrice: 0.3 },
      { keywordName: '上限词', minBidPrice: 0.5 }, { keywordName: '超价词', minBidPrice: 0.6 }
    ] })), delay: vi.fn(async () => {}), onProgress: vi.fn(), ...overrides }
}

function creationOptions(units, floors, overrides = {}) {
  return { prepared: { config, campaigns: [{ planName: '计划1', units }], summary: { campaignCount: 1, productCount: units.length } },
    platformSession: {}, eid: 'private-eid', signBody: vi.fn(async () => ({ h5st: 'private-signature' })),
    onProgress: vi.fn(), onDiagnostic: vi.fn(), delay: vi.fn(async () => {}),
    requestJson: vi.fn(async (_session, url, request) => {
      if (url === KEYWORD_MIN_BID_URL) return { code: 1, data: request.body.keywords.map(keywordName => ({ keywordName, minBidPrice: floors[keywordName] })) }
      if (url.includes('/common/get/recommendautobidding/type')) return { code: 1, data: [{ sid: 'version' }] }
      if (url.startsWith(CREATE_CAMPAIGN_URL)) return { subCode: 1, data: { campaignId: '9001' } }
      if (url.startsWith(ADD_ADGROUP_URL)) return { subCode: 1, data: {} }
      throw new Error(`Unexpected endpoint ${url}`)
    }), ...overrides }
}

describe('自定义关键词出价上限', () => {
  it('上限由用户填写，不默认无限抬价；保存的数值在主进程保留', () => {
    expect(normalizeRoiConfig({}).maxCustomKeywordBid).toBeNull()
    expect(normalizeRoiConfig({ maxCustomKeywordBid: '0.7' }).maxCustomKeywordBid).toBe(0.7)
  })

  it.each([null, '', 0, -1, NaN, Infinity, 10000, 0.15, 0.05])('拒绝无效上限 %s', maximum => {
    expect(() => assertCustomKeywordBidConfig({ ...config, maxCustomKeywordBid: maximum })).toThrow('最高出价')
  })

  it('不能低于起始价；原来的最低价＋加价及ROI模式不受新字段影响', () => {
    expect(() => assertCustomKeywordBidConfig({ ...config, customKeywordBid: 0.6 })).toThrow('不能低于起始出价')
    expect(() => assertCustomKeywordBidConfig({ ...config, useMinKeywordBid: true, maxCustomKeywordBid: null })).not.toThrow()
    expect(() => assertCustomKeywordBidConfig({ ...config, createMode: 'roi', maxCustomKeywordBid: null })).not.toThrow()
  })

  it('在上限内抬价、等于上限保留、超价和缺失底价只跳过对应词', async () => {
    const opts = options()
    const result = await applyCustomKeywordBidLimit(opts)
    expect(result.keywordList.map(row => [row.keywordName, row.keywordMobilePrice, row.type])).toEqual([
      ['低价词', 0.1, 4], ['抬价词', 0.3, 4], ['上限词', 0.5, 4]
    ])
    expect(result.adjustedKeywords).toHaveLength(2)
    expect(result.skippedKeywords).toEqual([
      expect.objectContaining({ keywordName: '超价词', floorBid: 0.6, maxBid: 0.5, reason: '京东最低出价超过最高出价' }),
      expect.objectContaining({ keywordName: '缺失词', reason: '京东未返回有效最低出价' })
    ])
    expect(opts.unit.keywordList.every(row => row.keywordMobilePrice === 0.1)).toBe(true)
  })

  it('不向下突破底价；向上取0.1档位也不得超过上限；忽略非请求词和重复词', async () => {
    const opts = options({ unit: makeUnit('单元', ['词1', '词2', '词1']), requestJson: vi.fn(async () => ({ code: 1, data: [
      { keywordName: '词1', minBidPrice: 0.31 }, { keywordName: '词1', minBidPrice: 0.3 },
      { keywordName: '词2', minBidPrice: 0.51 }, { keywordName: '外来词', minBidPrice: 0.1 }
    ] })) })
    const result = await applyCustomKeywordBidLimit(opts)
    expect(result.keywordList).toEqual([{ reqType: 6, type: 4, keywordName: '词1', keywordMobilePrice: 0.4 }])
    expect(result.skippedKeywords).toHaveLength(1)
  })

  it('底价低于起始价时保留起始价，支持数字字符串及小数浮点误差', async () => {
    const result = await applyCustomKeywordBidLimit(options({ config: { ...config, customKeywordBid: 0.3 },
      unit: makeUnit('单元', ['词1', '词2']), requestJson: async () => ({ code: 1, data: [
        { keywordName: '词1', minBidPrice: '0.1' }, { keywordName: '词2', minBidPrice: 0.30000000000000004 }
      ] }) }))
    expect(result.keywordList.map(row => row.keywordMobilePrice)).toEqual([0.3, 0.3])
  })

  it('200个词按100个一批查询并保持请求顺序，丢弃无效底价', async () => {
    const keywords = Array.from({ length: 200 }, (_, i) => `词${i}`)
    const opts = options({ unit: makeUnit('单元', keywords), requestJson: vi.fn(async (_session, _url, req) => ({ code: 1,
      data: req.body.keywords.toReversed().map(keywordName => ({ keywordName, minBidPrice: keywordName === '词199' ? 'bad' : 0.3 })) })) })
    const result = await applyCustomKeywordBidLimit(opts)
    expect(opts.requestJson).toHaveBeenCalledTimes(2)
    expect(opts.requestJson.mock.calls.every(([, url, req]) => url === KEYWORD_MIN_BID_URL && req.body.keywords.length === 100)).toBe(true)
    expect(result.keywordList.map(row => row.keywordName)).toEqual(keywords.slice(0, 199))
    expect(result.skippedKeywords[0].keywordName).toBe('词199')
  })

  it('底价限流最多重试3次，不回退到不可靠的0.1元', async () => {
    const opts = options({ requestJson: vi.fn(async () => ({ code: -3010 })) })
    await expect(applyCustomKeywordBidLimit(opts)).rejects.toMatchObject({ code: 'JD_RATE_LIMIT' })
    expect(opts.requestJson).toHaveBeenCalledTimes(4)
  })

  it('登录失效不重试；普通接口错误也不猜底价', async () => {
    const opts = options({ requestJson: vi.fn(async () => ({ code: -100 })) })
    await expect(applyCustomKeywordBidLimit(opts)).rejects.toMatchObject({ code: 'JD_SESSION_EXPIRED' })
    expect(opts.requestJson).toHaveBeenCalledTimes(1)
    await expect(applyCustomKeywordBidLimit(options({ requestJson: async () => ({ code: -1, msg: '接口异常' }) }))).rejects.toThrow('接口异常')
  })

  it('上限未设置时在关键词获取前阻止准备和创建', async () => {
    const requestJson = vi.fn()
    await expect(prepareRoiKeywords({ structure: { config: { ...config, maxCustomKeywordBid: null }, units: [{}] }, requestJson })).rejects.toThrow('最高出价')
    const opts = creationOptions([makeUnit('单元', ['词'])], { 词: 0.3 })
    opts.prepared.config = { ...config, maxCustomKeywordBid: null }
    await expect(createCustomCampaigns(opts)).rejects.toThrow('最高出价')
    expect(requestJson).not.toHaveBeenCalled()
    expect(opts.requestJson).not.toHaveBeenCalled()
  })

  it('签名前最后校验关键词提交价，不能通过旧缓存绕过上限', () => {
    expect(() => buildCustomAdGroupCommand({ ...makeUnit('单元', ['词']), keywordList: [{ keywordMobilePrice: 0.6 }] }, config, 'version')).toThrow('超过')
  })
})

describe('上限检查与真实创建队列', () => {
  it('首个单元全超价，后续可用单元仍创建计划；追加单元亦按上限抬价', async () => {
    const opts = creationOptions([makeUnit('跳过单元', ['超价词']), makeUnit('首个可用', ['可用词']), makeUnit('追加单元', ['追加词'])],
      { 超价词: 0.6, 可用词: 0.3, 追加词: 0.5 })
    const result = await createCustomCampaigns(opts)
    expect(result).toMatchObject({ successCampaignCount: 1, successUnitCount: 2, skippedUnitCount: 1, skippedKeywordCount: 1, adjustedKeywordCount: 2, failureCount: 0 })
    const writes = opts.requestJson.mock.calls.filter(([, url]) => url.startsWith(CREATE_CAMPAIGN_URL) || url.startsWith(ADD_ADGROUP_URL))
    expect(writes).toHaveLength(2)
    expect(writes[0][2].body.adGroupCreateCommand.adList[0].skuId).toBe('首个可用')
    expect(writes[0][2].body.adGroupCreateCommand.keywordList[0].keywordMobilePrice).toBe(0.3)
    expect(writes[1][2].body).toMatchObject({ campaignId: '9001', keywordList: [{ keywordMobilePrice: 0.5 }] })
    expect(opts.onProgress.mock.calls.at(-1)[0].completedUnits).toBe(3)
    expect(creationOutcome(result)).toBe('partial')
    expect(JSON.stringify(opts.onDiagnostic.mock.calls)).not.toMatch(/private-eid|private-signature/)
  })

  it('所有单元全超价，不调用版本、签名或广告创建，明确返回跳过', async () => {
    const opts = creationOptions([makeUnit('单元1', ['词1']), makeUnit('单元2', ['词2'])], { 词1: 0.6, 词2: 0.9 })
    const result = await createCustomCampaigns(opts)
    expect(result).toMatchObject({ successCampaignCount: 0, successUnitCount: 0, failureCount: 0, skippedUnitCount: 2 })
    expect(opts.requestJson.mock.calls.every(([, url]) => url === KEYWORD_MIN_BID_URL)).toBe(true)
    expect(opts.signBody).not.toHaveBeenCalled()
    expect(creationOutcome(result)).toBe('skipped')
  })

  it('部分关键词超价，不丢弃整单元；返回实际创建关键词数量用于核验', async () => {
    const opts = creationOptions([makeUnit('单元', ['低价词', '超价词'])], { 低价词: 0.3, 超价词: 0.9 })
    const result = await createCustomCampaigns(opts)
    expect(result).toMatchObject({ successUnitCount: 1, skippedUnitCount: 0, skippedKeywordCount: 1, units: [{ keywordCount: 1 }] })
    expect(creationOutcome(result)).toBe('partial')
  })

  it('底价读取失败可继续后续单元；不使用旧出价提交失败单元', async () => {
    const opts = creationOptions([makeUnit('单元1', ['词1']), makeUnit('单元2', ['词2'])], { 词2: 0.3 })
    const original = opts.requestJson
    opts.requestJson = vi.fn((session, url, req) => url === KEYWORD_MIN_BID_URL && req.body.keywords[0] === '词1'
      ? Promise.resolve({ code: -1, msg: '底价读取失败' }) : original(session, url, req))
    const result = await createCustomCampaigns(opts)
    expect(result).toMatchObject({ successUnitCount: 1, failureCount: 1 })
    expect(result.failures[0]).toMatchObject({ unitName: '单元1', stage: 'keyword_floor' })
    expect(opts.signBody).toHaveBeenCalledTimes(1)
  })

  it('登录已失效时停止后续底价请求，避免重复使用无效Cookie', async () => {
    const opts = creationOptions([makeUnit('单元1', ['词1']), makeUnit('单元2', ['词2'])], {})
    opts.requestJson = vi.fn(async () => ({ code: -100 }))
    const result = await createCustomCampaigns(opts)
    expect(result).toMatchObject({ failureCount: 2, successUnitCount: 0 })
    expect(opts.requestJson).toHaveBeenCalledTimes(1)
    expect(opts.signBody).not.toHaveBeenCalled()
  })

  it('NotLogin文本及恢复失败的会话错误也停止队列，不反复用无效Cookie', async () => {
    for (const response of [{ code: 0, msg: 'NotLogin' }, Object.assign(new Error('店铺登录已失效，请重新登录'), { code: 'JD_SESSION_RELOGIN_REQUIRED' })]) {
      const opts = creationOptions([makeUnit('单元1', ['词1']), makeUnit('单元2', ['词2'])], {})
      opts.requestJson = vi.fn(async () => { if (response instanceof Error) throw response; return response })
      const result = await createCustomCampaigns(opts)
      expect(result.failureCount).toBe(2)
      expect(opts.requestJson).toHaveBeenCalledTimes(1)
      expect(opts.signBody).not.toHaveBeenCalled()
    }
  })

  it('底价查询跨午夜后重新校验日期，不把过去日期提交给京东', async () => {
    const opts = creationOptions([makeUnit('单元', ['词'])], { 词: 0.3 })
    const original = opts.requestJson
    opts.requestJson = vi.fn(async (session, url, req) => {
      const response = await original(session, url, req)
      if (url === KEYWORD_MIN_BID_URL) vi.setSystemTime(new Date(2026, 8, 16, 0, 1))
      return response
    })
    const result = await createCustomCampaigns(opts)
    expect(result).toMatchObject({ successCampaignCount: 0, failureCount: 1 })
    expect(result.failures[0].code).toBe('JD_EXPRESS_DATE_INVALID')
    expect(opts.requestJson.mock.calls.every(([, url]) => url === KEYWORD_MIN_BID_URL)).toBe(true)
    expect(opts.signBody).not.toHaveBeenCalled()
  })

  it.each(['timeout', 'floor'])('创建接口%s失败不自动重放真实广告请求', async failure => {
    const opts = creationOptions([makeUnit('单元1', ['词1']), makeUnit('单元2', ['词2'])], { 词1: 0.3, 词2: 0.3 })
    const original = opts.requestJson
    opts.requestJson = vi.fn((session, url, req) => {
      if (url.startsWith(CREATE_CAMPAIGN_URL)) {
        if (failure === 'timeout') throw new Error('提交超时')
        return Promise.resolve({ subCode: -1, subMsg: '关键词出价低于底价' })
      }
      return original(session, url, req)
    })
    const result = await createCustomCampaigns(opts)
    expect(result.failureCount).toBe(2)
    expect(opts.requestJson.mock.calls.filter(([, url]) => url.startsWith(CREATE_CAMPAIGN_URL))).toHaveLength(1)
    expect(result.failures[1].blockedByCampaign).toBe(true)
  })

  it('日志包含关键词、起始价、底价、上限、调整结果或跳过原因', () => {
    const writeLog = vi.fn()
    const log = createCreationLogger({ storeId: 1, runId: 'run', createMode: 'custom', writeLog })
    log({ stage: 'keyword_bid_policy', result: 'bid_raised', keywordName: '抬价词', baseBid: 0.1, floorBid: 0.3, maxBid: 0.5, submittedBid: 0.3 })
    log({ stage: 'keyword_bid_policy', result: 'keyword_skipped', keywordName: '超价词', baseBid: 0.1, floorBid: 0.8, maxBid: 0.5, reason: '京东最低出价超过最高出价' })
    expect(writeLog.mock.calls[0][1]).toContain('"submittedBid":0.3')
    expect(writeLog.mock.calls[1][1]).toContain('"floorBid":0.8')
    expect(writeLog.mock.calls[1][1]).toContain('京东最低出价超过最高出价')
  })

  it('前端起始价和最高价并排，默认不替用户指定上限，并明确说明自动抬价范围', () => {
    const view = readFileSync(new URL('../src/renderer/src/views/operations/JdExpress.vue', import.meta.url), 'utf8')
    expect(view).toMatch(/class="custom-keyword-bid-row">[\s\S]*?label="起始出价"[\s\S]*?label="最高出价"/)
    expect(view).toContain('maxCustomKeywordBid: null')
    expect(view).toContain('此上限不影响智能匹配出价')
    expect(view).toMatch(/\.custom-keyword-bid-row\s*\{\s*display: flex;/)
    expect(view).not.toContain('不查询京东最低出价')
  })
})
