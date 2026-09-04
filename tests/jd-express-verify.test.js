import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  VERIFY_LIST_URLS,
  buildExpectedVerification,
  buildVerificationListBody,
  extractVerificationPage,
  formatVerificationDifference,
  verifyCreatedRoiCampaigns
} = require('../src/main/jd-express-verify')

const created = {
  campaigns: [
    { campaignId: 9001, campaignName: '计划1' },
    { campaignId: 9002, campaignName: '计划2' }
  ],
  units: [
    { campaignId: 9001, productCount: 2, keywordCount: 3 },
    { campaignId: 9001, productCount: 1, keywordCount: 2 },
    { campaignId: 9002, productCount: 1, keywordCount: 4 }
  ]
}

function envelope(data) {
  return { data, paginator: { items: data.length, page: 1, itemsPerPage: 1000 } }
}

describe('京东快车创建后四层核验', () => {
  it('只构造京准通关键词推广列表的只读查询参数', () => {
    const body = buildVerificationListBody('keyword', 2, 500, new Date('2026-09-05T00:00:00+08:00').getTime())
    expect(body).toMatchObject({
      page: 2,
      pageSize: 500,
      orderStatusCategory: 1,
      businessType: 2,
      campaignType: 2,
      putType: 3,
      marketingObjective: 1,
      marketingScenario: 1,
      targetingType: 2
    })
    expect(body).not.toHaveProperty('ids')
    expect(body).not.toHaveProperty('statusList')
  })

  it('兼容计划、单元和创意列表的嵌套返回结构', () => {
    expect(extractVerificationPage({ code: 1, data: envelope([{ campaignId: 1 }]) }).items).toHaveLength(1)
    expect(extractVerificationPage({ code: 1, data: { result: envelope([{ groupId: 2 }]) } }).items).toHaveLength(1)
    expect(extractVerificationPage({ code: 1, data: { msaNormalAdReport: envelope([{ id: 3 }]) } }).items).toHaveLength(1)
  })

  it('按本次返回的计划 ID 核对四层数量并忽略旧计划', async () => {
    const responses = {
      [VERIFY_LIST_URLS.campaign]: envelope([
        { campaignId: 8000 },
        { campaignId: 9001 },
        { campaignId: 9002 }
      ]),
      [VERIFY_LIST_URLS.adgroup]: envelope([
        { campaignId: 9001, groupId: 1 },
        { campaignId: 9001, groupId: 2 },
        { campaignId: 9002, groupId: 3 }
      ]),
      [VERIFY_LIST_URLS.ad]: { msaNormalAdReport: envelope([
        { campaignId: 9001, id: 11 },
        { campaignId: 9001, id: 12 },
        { campaignId: 9001, id: 13 },
        { campaignId: 9002, id: 14 }
      ]) },
      [VERIFY_LIST_URLS.keyword]: envelope([
        ...Array.from({ length: 5 }, (_, index) => ({ campaignId: 9001, id: 100 + index })),
        ...Array.from({ length: 4 }, (_, index) => ({ campaignId: 9002, id: 200 + index }))
      ])
    }
    const requestJson = vi.fn(async (_session, url) => ({ code: 1, data: responses[url] }))
    const result = await verifyCreatedRoiCampaigns({
      created,
      platformSession: {},
      requestJson,
      delay: async () => {},
      initialDelayMs: 0
    })

    expect(buildExpectedVerification(created)).toMatchObject({ campaign: 2, adgroup: 3, ad: 4, keyword: 9 })
    expect(result).toMatchObject({
      success: true,
      status: 'matched',
      actual: { campaign: 2, adgroup: 3, ad: 4, keyword: 9 }
    })
    expect(requestJson).toHaveBeenCalledTimes(4)
  })

  it('数据缺少时只返回差异，不执行任何补建动作', async () => {
    const requestJson = vi.fn(async (_session, url) => {
      if (url === VERIFY_LIST_URLS.campaign) return { code: 1, data: envelope(created.campaigns) }
      if (url === VERIFY_LIST_URLS.adgroup) return { code: 1, data: envelope([
        { campaignId: 9001, groupId: 1 },
        { campaignId: 9002, groupId: 2 }
      ]) }
      if (url === VERIFY_LIST_URLS.ad) return { code: 1, data: { msaNormalAdReport: envelope([]) } }
      return { code: 1, data: envelope([]) }
    })
    const result = await verifyCreatedRoiCampaigns({
      created,
      platformSession: {},
      requestJson,
      delay: async () => {},
      initialDelayMs: 0,
      maxAttempts: 2
    })

    expect(result.status).toBe('mismatch')
    expect(result.missing).toEqual({ adgroup: 1, ad: 4, keyword: 9 })
    expect(formatVerificationDifference(result)).toBe('单元少 1 个、创意少 4 个、关键词少 9 个')
    expect([...new Set(requestJson.mock.calls.map(([, url]) => url))]).toEqual(Object.values(VERIFY_LIST_URLS))
  })

  it('核验接口异常时返回暂未完成，不影响创建结果', async () => {
    const result = await verifyCreatedRoiCampaigns({
      created,
      platformSession: {},
      requestJson: async () => { throw new Error('临时网络异常') },
      delay: async () => {},
      initialDelayMs: 0
    })
    expect(result).toMatchObject({
      success: false,
      status: 'unavailable',
      message: '临时网络异常'
    })
  })
})
