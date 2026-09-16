import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 5, 12)) })
afterEach(() => vi.useRealTimers())
const {
  ADD_ADGROUP_URL,
  CREATE_CAMPAIGN_URL,
  buildAdditionalAdGroupBody,
  buildCampaignCreateBody,
  buildCustomAdditionalAdGroupBody,
  buildCustomCampaignCreateBody,
  createCustomCampaigns,
  createRoiCampaigns,
  createSingleProductTest,
  resolveRoiBid
} = require('../src/main/jd-express-create')

const config = {
  areaType: 1,
  areaIds: [],
  biddingTarget: 16,
  automatedBiddingType: 8192,
  bidType: 3,
  adjustRatio: 0,
  adjustDirection: 0,
  bottomLimit: 3,
  customRoi: 3,
  capCustomRoi: false,
  startDate: '2026-09-05',
  unlimitedEndDate: true,
  endDate: null,
  unlimitedBudget: true,
  dailyBudget: null
}

const unit = {
  unitName: '保温杯(1)_1',
  cid2Name: '杯具',
  products: [{
    skuId: '1001',
    name: '家用不锈钢保温杯',
    image: 'https://img.example/1.jpg',
    categoryName: '保温杯',
    raw: { adName: '家用不锈钢保温杯', forceCategory: 0 }
  }],
  keywordList: [{
    reqType: 6,
    type: 8,
    keywordMobilePrice: 0.5,
    keywordName: '保温杯'
  }]
}

describe('京东快车单商品创建组包', () => {
  it('按原工具建议30%竞争力及上下限生成 ROI', () => {
    expect(resolveRoiBid(config, {
      recommendFloorBid: 2.5,
      top_price_troi: 10
    })).toBe(3)
  })

  it('生成新版计划与首单元合并创建请求', () => {
    const body = buildCampaignCreateBody({
      planName: '测试_杯具_(1)_1',
      units: [unit]
    }, config, {
      sid: 'suggest-version',
      recommendFloorBid: 4,
      top_price_troi: 10
    }, 'recommend-version', 123456)

    expect(body.campaignCreateCommand).toMatchObject({
      marketingObjective: 1,
      marketingScenario: 1,
      targetingType: 2,
      campaignType: 2,
      putType: 3,
      startTime: '2026-09-05',
      endTime: null,
      dayBudget: null
    })
    expect(body.adGroupCreateCommand).toMatchObject({
      name: '杯具',
      tcpaBid: 4,
      biddingTarget: 16,
      automatedBiddingType: 8192,
      newAreaIds: ['0'],
      versionId: ['suggest-version', 'recommend-version']
    })
    expect(body.adGroupCreateCommand.adList[0]).toMatchObject({
      creativeType: 19,
      skuId: '1001',
      defaultTitle: '家用不锈钢保温杯'
    })
  })

  it('拒绝把多商品准备结果提交到单商品测试接口', async () => {
    await expect(createSingleProductTest({
      prepared: {
        summary: { productCount: 2, campaignCount: 1, unitCount: 1 }
      }
    })).rejects.toThrow('单商品测试只能提交')
  })

  it('后续单元使用原工具的新增单元字段', () => {
    const body = buildAdditionalAdGroupBody(unit, config, {
      sid: 'suggest-version',
      recommendFloorBid: 4,
      top_price_troi: 10
    }, 'recommend-version', 9001)

    expect(body).toMatchObject({
      campaignId: 9001,
      name: '保温杯(1)_1',
      marketingObjective: 1,
      marketingScenario: 1,
      targetingType: 2,
      fee: 1,
      orientationRange: 1
    })
    expect(body.adList[0]).toMatchObject({ customTitle: '', skuId: '1001' })
    expect(body.adList[0]).not.toHaveProperty('creativeType')
    expect(body.adList[0]).not.toHaveProperty('defaultTitle')
  })

  it('先创建计划首单元，再逐个追加剩余单元并继续后续计划', async () => {
    const unit2 = {
      ...unit,
      unitName: '水杯(2)_2',
      products: [{
        ...unit.products[0],
        skuId: '1002',
        raw: { ...unit.products[0].raw, adName: '玻璃杯' }
      }]
    }
    const submitted = []
    let campaignSequence = 0
    const requestJson = async (_session, url, options) => {
      if (url.includes('/common/tcpa/suggest/price')) {
        return { code: 1, data: { sid: 'suggest-version', recommendFloorBid: 4, top_price_troi: 10 } }
      }
      if (url.includes('/common/get/recommendautobidding/type')) {
        return { code: 1, data: [{ sid: 'recommend-version' }] }
      }
      submitted.push({ url, body: options.body })
      if (url.startsWith(CREATE_CAMPAIGN_URL)) {
        campaignSequence += 1
        return { subCode: 1, data: { campaignId: 9000 + campaignSequence } }
      }
      if (url.startsWith(ADD_ADGROUP_URL)) return { subCode: 1, data: {} }
      throw new Error(`未处理的请求：${url}`)
    }
    const result = await createRoiCampaigns({
      platformSession: {},
      prepared: {
        config,
        summary: { productCount: 3, campaignCount: 2, unitCount: 3 },
        campaigns: [
          { planName: '计划1', cid2Name: '杯具', units: [unit, unit2] },
          { planName: '计划2', cid2Name: '日用', units: [{ ...unit, unitName: '日用(1)_3' }] }
        ]
      },
      requestJson,
      signBody: async () => ({ h5st: 'signed' }),
      eid: 'eid-cookie',
      delay: async () => {}
    })

    expect(result).toMatchObject({
      campaignCount: 2,
      unitCount: 3,
      successCampaignCount: 2,
      successUnitCount: 3,
      failureCount: 0
    })
    expect(submitted.map((item) => item.url.split('?')[0])).toEqual([
      CREATE_CAMPAIGN_URL,
      ADD_ADGROUP_URL,
      CREATE_CAMPAIGN_URL
    ])
    expect(submitted[0].body.adGroupCreateCommand.name).toBe('杯具')
    expect(submitted[1].body).toMatchObject({ campaignId: 9001, name: '水杯(2)_2' })
    expect(submitted[2].body.adGroupCreateCommand.name).toBe('日用')
  })
})

describe('京东快车一键自定义创建组包', () => {
  const customConfig = {
    ...config,
    createMode: 'custom',
    biddingTarget: 1,
    automatedBiddingType: 32768,
    premiumType: 2,
    premiumCoef: 30,
    inSearchFee: 0.1,
    orientationRangeOption: [1],
    dmpCrowdSettings: [
      { crowdId: 100, crowdName: '默认购买人群', adGroupPrice: 30, isUsed: 1 },
      { crowdId: 101, crowdName: '默认浏览人群', adGroupPrice: 30, isUsed: 1 }
    ]
  }

  it('按原工具字段生成计划和首单元合并请求', () => {
    const body = buildCustomCampaignCreateBody({
      planName: '0905_杯具_(1)_1',
      units: [unit]
    }, customConfig, 'recommend-version')

    expect(body.campaignCreateCommand).toMatchObject({
      name: '0905_杯具_(1)_1',
      marketingObjective: 1,
      marketingScenario: 1,
      targetingType: 2,
      campaignType: 2,
      putType: 3,
      dayBudget: null
    })
    expect(body.adGroupCreateCommand).toMatchObject({
      name: '0905_杯具_(1)_1',
      biddingTarget: 1,
      automatedBiddingType: 32768,
      deliveryTarget: 1,
      orientationRange: 1,
      premiumOrientationRange: 1,
      premiumCoef: 30,
      inSearchFee: 0.1,
      fee: 0.1,
      versionId: ['recommend-version'],
      autoBiddingModuleVO: { biddingTarget: 1, orientationRange: 1, premiumCoef: 30 }
    })
    expect(body.adGroupCreateCommand.dmpCrowdSettings).toEqual(customConfig.dmpCrowdSettings)
    expect(body.adGroupCreateCommand.adList[0]).toMatchObject({
      skuId: '1001',
      customTitle: ''
    })
    expect(body.adGroupCreateCommand.adList[0]).not.toHaveProperty('creativeType')
    expect(body.adGroupCreateCommand.adList[0]).not.toHaveProperty('defaultTitle')
    expect(body.adGroupCreateCommand).not.toHaveProperty('tcpaBid')
  })

  it('关闭全能调价时对齐原工具的关闭字段并保留组合定向', () => {
    const body = buildCustomAdditionalAdGroupBody(unit, {
      ...customConfig,
      automatedBiddingType: 0,
      orientationRangeOption: [1, 2]
    }, 'recommend-version', 9001)

    expect(body).toMatchObject({
      campaignId: 9001,
      automatedBiddingType: 0,
      biddingType: 0,
      deliveryTarget: 1,
      orientationRange: 3,
      autoBiddingModuleVO: { biddingTarget: 0, orientationRange: 3 }
    })
    expect(body).not.toHaveProperty('biddingTarget')
    expect(body).not.toHaveProperty('premiumCoef')
  })

  it('自定义创建不调用 ROI 建议出价接口', async () => {
    const submitted = []
    const requestJson = async (_session, url, options) => {
      if (url.includes('/common/tcpa/suggest/price')) throw new Error('自定义模式不应调用 ROI 建议出价')
      if (url.includes('/common/get/recommendautobidding/type')) {
        return { code: 1, data: [{ sid: 'recommend-version' }] }
      }
      submitted.push({ url, body: options.body })
      if (url.startsWith(CREATE_CAMPAIGN_URL)) return { subCode: 1, data: { campaignId: 9100 } }
      if (url.startsWith(ADD_ADGROUP_URL)) return { subCode: 1, data: {} }
      throw new Error(`未处理的请求：${url}`)
    }

    const result = await createCustomCampaigns({
      platformSession: {},
      prepared: {
        config: customConfig,
        summary: { productCount: 1, campaignCount: 1, unitCount: 1 },
        campaigns: [{ planName: '0905_杯具_(1)_1', units: [unit] }]
      },
      requestJson,
      signBody: async () => ({ h5st: 'signed' }),
      eid: 'eid-cookie',
      delay: async () => {}
    })

    expect(result).toMatchObject({ successCampaignCount: 1, successUnitCount: 1, failureCount: 0 })
    expect(submitted).toHaveLength(1)
    expect(submitted[0].body.adGroupCreateCommand.automatedBiddingType).toBe(32768)
  })
})
