'use strict'

const { adjustRoiBid } = require('./jd-express-utils')

const SUGGEST_PRICE_URL = 'https://jzt-api.jd.com/common/tcpa/suggest/price'
const VERSION_ID_URL = 'https://jzt-api.jd.com/common/get/recommendautobidding/type'
const CREATE_CAMPAIGN_URL = 'https://atoms-api.jd.com/dspad/msa/campaign/item/keyword/add'
const ADD_ADGROUP_URL = 'https://atoms-api.jd.com/dspad/msa/adgroup/item/keyword/add'

function responseMessage(payload, fallback) {
  return payload?.subMsg || payload?.message || payload?.msg || fallback
}

function resolveRoiBid(config, suggestion = {}) {
  const topPrice = Number.isFinite(Number(suggestion?.top_price_troi))
    ? Number(suggestion.top_price_troi)
    : Number.POSITIVE_INFINITY
  if (Number(config.bidType) === 4) {
    const upper = config.capCustomRoi && Number.isFinite(Number(suggestion?.recommendFloorBid))
      ? Number(suggestion.recommendFloorBid)
      : topPrice
    return Math.max(0.1, Math.min(Number(config.customRoi || 0.1), upper))
  }
  const sourceByType = {
    1: suggestion?.recommendCeilingBid,
    2: suggestion?.recommend_bid,
    3: suggestion?.recommendFloorBid
  }
  return adjustRoiBid(
    sourceByType[Number(config.bidType)] ?? suggestion?.recommendFloorBid,
    config.adjustRatio,
    config.adjustDirection,
    config.bottomLimit,
    topPrice
  )
}

function buildCreative(product, firstUnit = true) {
  const raw = product?.raw || {}
  const productName = String(product?.name || raw?.skuName || raw?.name || '').trim()
  const categoryName = String(product?.categoryName || raw?.categoryName || '商品').trim()
  const rawAdName = raw?.adName == null ? undefined : String(raw.adName)
  const adName = firstUnit
    ? rawAdName
    : (rawAdName && rawAdName.length >= 10 ? rawAdName : `${rawAdName || ''} ${categoryName}`.trim()).slice(0, 30)
  return {
    forceCategory: raw?.forceCategory,
    categoryName,
    sourceType: 1,
    ...(firstUnit ? { creativeType: 19 } : {}),
    name: adName,
    skuId: product?.skuId,
    customTitle: firstUnit ? productName : '',
    ...(firstUnit ? { defaultTitle: productName } : {}),
    imgUrl: raw?.imgUrl || product?.image || '',
    _productName: productName,
    venderColType: raw?.venderColType,
    isVenderProduct: raw?.isVenderProduct,
    swaFlag: raw?.swaFlag
  }
}

function buildAdGroupCommand(unit, config, suggestion, recommendVersionId, campaignId = null) {
  if (!unit?.keywordList?.length) throw new Error('推广单元没有可提交的关键词及出价')
  const versionId = [suggestion?.sid, recommendVersionId].filter((value) => value != null && value !== '')
  const command = {
    name: String(campaignId ? unit.unitName : unit.cid2Name || unit.unitName || '推广单元'),
    isDmp: 1,
    ...(campaignId ? { campaignId } : {}),
    businessType: 2,
    campaignType: 2,
    putType: 3,
    newAreaIds: config.areaType === 1 ? ['0'] : config.areaIds,
    tcpaBid: resolveRoiBid(config, suggestion),
    biddingTarget: config.biddingTarget,
    inSearchFee: 1,
    keywordList: unit.keywordList,
    dmpCrowdSettings: [],
    seedsList: [],
    billingType: 0,
    adList: unit.products.map((product) => buildCreative(product, !campaignId)),
    fee: 1,
    biddingType: config.automatedBiddingType,
    orientationRange: 1,
    automatedBiddingType: config.automatedBiddingType,
    deliveryTarget: 4,
    autoBiddingModuleVO: {
      biddingTarget: config.biddingTarget,
      orientationRange: 1
    },
    deliveryList: [],
    premiumOrientationRange: 0,
    versionId,
    requestFrom: 0
  }
  if (campaignId) {
    command.marketingObjective = 1
    command.marketingScenario = 1
    command.targetingType = 2
  }
  return command
}

function buildCampaignCreateBody(campaign, config, suggestion, recommendVersionId, timestamp = Date.now()) {
  const unit = campaign?.units?.[0]
  if (!unit) throw new Error('计划内没有可提交的推广单元')
  const adGroupCreateCommand = buildAdGroupCommand(unit, config, suggestion, recommendVersionId)
  if (campaign?.cid2Name) adGroupCreateCommand.name = campaign.cid2Name
  return {
    requestFrom: 0,
    campaignCreateCommand: {
      marketingObjective: 1,
      marketingScenario: 1,
      targetingType: 2,
      campaignType: 2,
      putType: 3,
      name: `${campaign.planName}_${timestamp}`.slice(0, 30),
      startTime: config.startDate,
      endTime: config.unlimitedEndDate ? null : config.endDate,
      dateRange: '',
      dayBudget: config.unlimitedBudget ? null : config.dailyBudget,
      timeRangePriceCoef: '',
      subExpType: '',
      expTarget: '',
      requestFrom: 0,
      encryptSignApiAppId: 'encryptSignApiAppId'
    },
    adGroupCreateCommand
  }
}

function buildAdditionalAdGroupBody(unit, config, suggestion, recommendVersionId, campaignId) {
  if (!campaignId) throw new Error('新增推广单元缺少计划 ID')
  return buildAdGroupCommand(unit, config, suggestion, recommendVersionId, campaignId)
}

function buildCustomCreative(product) {
  const raw = product?.raw || {}
  const productName = String(product?.name || raw?.skuName || raw?.name || '').trim()
  const categoryName = String(product?.categoryName || raw?.categoryName || '商品').trim()
  const rawAdName = raw?.adName == null ? '' : String(raw.adName)
  const adName = (rawAdName.length >= 10 ? rawAdName : `${rawAdName} ${categoryName}`.trim()).slice(0, 30)
  return {
    forceCategory: raw?.forceCategory,
    categoryName,
    sourceType: 1,
    name: adName,
    skuId: product?.skuId,
    customTitle: '',
    imgUrl: raw?.imgUrl || product?.image || '',
    _productName: productName,
    venderColType: raw?.venderColType,
    isVenderProduct: raw?.isVenderProduct,
    swaFlag: raw?.swaFlag
  }
}

function resolveCustomOrientationRange(config = {}) {
  return Array.isArray(config.orientationRangeOption) && config.orientationRangeOption.map(Number).includes(2)
    ? 3
    : 1
}

function buildCustomAdGroupCommand(unit, config, recommendVersionId, campaignId = null, firstUnitName = '') {
  if (!unit?.keywordList?.length) throw new Error('推广单元没有可提交的关键词及出价')
  const automatedBiddingType = Number(config.automatedBiddingType) === 0 ? 0 : 32768
  const orientationRange = resolveCustomOrientationRange(config)
  const premiumCoef = Number(config.premiumType) === 1 ? 0 : Number(config.premiumCoef)
  const command = {
    name: String(campaignId ? unit.unitName : firstUnitName || unit.unitName || '推广单元'),
    isDmp: 1,
    ...(campaignId ? { campaignId } : {}),
    businessType: 2,
    campaignType: 2,
    putType: 3,
    newAreaIds: config.areaType === 1 ? ['0'] : config.areaIds,
    ...(automatedBiddingType > 0 ? { premiumCoef, biddingTarget: 1 } : {}),
    inSearchFee: Number(config.inSearchFee),
    keywordList: unit.keywordList,
    dmpCrowdSettings: Array.isArray(config.dmpCrowdSettings) ? config.dmpCrowdSettings : [],
    seedsList: [],
    billingType: 0,
    adList: unit.products.map((product) => buildCustomCreative(product)),
    fee: Number(config.inSearchFee),
    biddingType: automatedBiddingType,
    orientationRange,
    automatedBiddingType,
    deliveryTarget: 1,
    autoBiddingModuleVO: automatedBiddingType === 0
      ? { biddingTarget: 0, orientationRange }
      : { biddingTarget: 1, orientationRange, premiumCoef },
    deliveryList: [],
    premiumOrientationRange: 1,
    versionId: [recommendVersionId].filter((value) => value != null && value !== ''),
    requestFrom: 0
  }
  if (campaignId) {
    command.marketingObjective = 1
    command.marketingScenario = 1
    command.targetingType = 2
  }
  return command
}

function buildCustomCampaignCreateBody(campaign, config, recommendVersionId) {
  const unit = campaign?.units?.[0]
  if (!unit) throw new Error('计划内没有可提交的推广单元')
  return {
    requestFrom: 0,
    campaignCreateCommand: {
      marketingObjective: 1,
      marketingScenario: 1,
      targetingType: 2,
      campaignType: 2,
      putType: 3,
      name: String(campaign.planName),
      startTime: config.startDate,
      endTime: config.unlimitedEndDate ? null : config.endDate,
      dateRange: '',
      dayBudget: config.unlimitedBudget ? null : config.dailyBudget,
      timeRangePriceCoef: '',
      subExpType: '',
      expTarget: '',
      requestFrom: 0,
      encryptSignApiAppId: 'encryptSignApiAppId'
    },
    adGroupCreateCommand: buildCustomAdGroupCommand(
      unit,
      config,
      recommendVersionId,
      null,
      campaign.planName
    )
  }
}

function buildCustomAdditionalAdGroupBody(unit, config, recommendVersionId, campaignId) {
  if (!campaignId) throw new Error('新增推广单元缺少计划 ID')
  return buildCustomAdGroupCommand(unit, config, recommendVersionId, campaignId)
}

async function fetchSuggestion(platformSession, unit, config, requestJson) {
  const payload = await requestJson(platformSession, SUGGEST_PRICE_URL, {
    method: 'POST',
    referer: 'https://shop.jd.com/',
    headers: { origin: 'https://shop.jd.com' },
    body: {
      adGroupId: '',
      retrievalType: 2,
      businessType: 2,
      biddingTarget: config.biddingTarget,
      campaignType: 2,
      automatedBiddingType: config.automatedBiddingType,
      skuIds: unit.products.map((product) => product.skuId),
      requestFrom: 0
    }
  })
  if (Number(payload?.code) !== 1 || !payload?.data) {
    throw new Error(`ROI控制获取建议出价失败：${responseMessage(payload, '京东未返回建议值')}`)
  }
  return payload.data
}

async function fetchRecommendVersionId(platformSession, requestJson) {
  const payload = await requestJson(platformSession, VERSION_ID_URL, {
    method: 'POST',
    referer: 'https://shop.jd.com/',
    headers: { origin: 'https://shop.jd.com' },
    body: {
      campaignType: 2,
      requestScene: 1,
      retrievalType: 2,
      businessType: 2,
      requestFrom: 0
    }
  })
  if (Number(payload?.code) !== 1 || !Array.isArray(payload?.data) || !payload.data[0]?.sid) {
    throw new Error(`获取京东提交版本失败：${responseMessage(payload, '未返回版本号')}`)
  }
  return payload.data[0].sid
}

async function submitSignedBody(options = {}) {
  const {
    platformSession,
    endpoint,
    body,
    requestJson,
    signBody,
    eid
  } = options
  const signed = await signBody(body)
  if (!signed?.h5st) throw new Error('京准通签名失败，未获得 h5st')
  const url = `${endpoint}?eid=${encodeURIComponent(eid)}&h5st=${signed.h5st}`
  const payload = await requestJson(platformSession, url, {
    method: 'POST',
    referer: 'https://jzt.jd.com/',
    headers: {
      origin: 'https://jzt.jd.com',
      loginmode: '0',
      siteid: '0'
    },
    body
  })
  if (Number(payload?.subCode) !== 1) {
    throw new Error(responseMessage(payload, '京东快车创建请求失败'))
  }
  return payload
}

async function createSingleProductTest(options = {}) {
  const {
    platformSession,
    prepared,
    requestJson,
    signBody,
    eid
  } = options
  if (!prepared || prepared.summary?.productCount !== 1 || prepared.summary?.campaignCount !== 1 || prepared.summary?.unitCount !== 1) {
    throw new Error('安全校验失败：单商品测试只能提交 1 个商品、1 个计划和 1 个单元')
  }
  if (!eid) throw new Error('京东 eid Cookie 缺失，请重新登录京准通')
  const campaign = prepared.campaigns[0]
  const unit = campaign.units[0]
  const suggestion = await fetchSuggestion(platformSession, unit, prepared.config, requestJson)
  const recommendVersionId = await fetchRecommendVersionId(platformSession, requestJson)
  const body = buildCampaignCreateBody(campaign, prepared.config, suggestion, recommendVersionId)
  const payload = await submitSignedBody({
    platformSession,
    endpoint: CREATE_CAMPAIGN_URL,
    body,
    requestJson,
    signBody,
    eid
  })
  return {
    campaignId: payload?.data?.campaignId,
    campaignName: body.campaignCreateCommand.name,
    unitName: body.adGroupCreateCommand.name,
    skuId: unit.products[0]?.skuId,
    keywordCount: unit.keywordList.length,
    tcpaBid: body.adGroupCreateCommand.tcpaBid,
    response: payload
  }
}

function buildFailure(campaign, unit, error) {
  return {
    planName: campaign?.planName || '',
    unitName: unit?.unitName || '',
    skuIds: (unit?.products || []).map((product) => product.skuId),
    message: error?.message || '创建失败'
  }
}

async function createRoiCampaigns(options = {}) {
  const {
    platformSession,
    prepared,
    requestJson,
    signBody,
    eid,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onProgress = () => {}
  } = options
  if (!prepared?.campaigns?.length) throw new Error('没有可提交的广告计划')
  if (!eid) throw new Error('京东 eid Cookie 缺失，请重新登录京准通')

  const createdCampaigns = []
  const createdUnits = []
  const failures = []
  let completedUnits = 0
  const totalUnits = prepared.campaigns.reduce((total, campaign) => total + campaign.units.length, 0)

  for (let campaignIndex = 0; campaignIndex < prepared.campaigns.length; campaignIndex += 1) {
    const campaign = prepared.campaigns[campaignIndex]
    const firstUnit = campaign.units[0]
    onProgress({
      phase: 'create_campaign_start',
      campaignIndex: campaignIndex + 1,
      totalCampaigns: prepared.campaigns.length,
      completedUnits,
      totalUnits,
      planName: campaign.planName
    })

    let campaignId
    try {
      const suggestion = await fetchSuggestion(platformSession, firstUnit, prepared.config, requestJson)
      const recommendVersionId = await fetchRecommendVersionId(platformSession, requestJson)
      const body = buildCampaignCreateBody(campaign, prepared.config, suggestion, recommendVersionId)
      const payload = await submitSignedBody({
        platformSession,
        endpoint: CREATE_CAMPAIGN_URL,
        body,
        requestJson,
        signBody,
        eid
      })
      campaignId = payload?.data?.campaignId
      if (!campaignId) throw new Error('京东返回创建成功，但未返回计划 ID')
      createdCampaigns.push({ campaignId, campaignName: body.campaignCreateCommand.name })
      createdUnits.push({
        campaignId,
        unitName: body.adGroupCreateCommand.name,
        keywordCount: firstUnit.keywordList.length,
        productCount: firstUnit.products.length,
        tcpaBid: body.adGroupCreateCommand.tcpaBid
      })
      completedUnits += 1
      onProgress({
        phase: 'create_campaign_complete',
        campaignIndex: campaignIndex + 1,
        totalCampaigns: prepared.campaigns.length,
        completedUnits,
        totalUnits,
        campaignId,
        planName: campaign.planName
      })
    } catch (error) {
      for (const unit of campaign.units) failures.push(buildFailure(campaign, unit, error))
      completedUnits += campaign.units.length
      onProgress({
        phase: 'create_campaign_failed',
        campaignIndex: campaignIndex + 1,
        totalCampaigns: prepared.campaigns.length,
        completedUnits,
        totalUnits,
        planName: campaign.planName,
        message: error?.message || '创建计划失败'
      })
      continue
    }

    for (let unitIndex = 1; unitIndex < campaign.units.length; unitIndex += 1) {
      const unit = campaign.units[unitIndex]
      onProgress({
        phase: 'create_adgroup_start',
        campaignIndex: campaignIndex + 1,
        totalCampaigns: prepared.campaigns.length,
        unitIndex: unitIndex + 1,
        unitCount: campaign.units.length,
        completedUnits,
        totalUnits,
        campaignId,
        unitName: unit.unitName
      })
      try {
        const suggestion = await fetchSuggestion(platformSession, unit, prepared.config, requestJson)
        const recommendVersionId = await fetchRecommendVersionId(platformSession, requestJson)
        const body = buildAdditionalAdGroupBody(
          unit,
          prepared.config,
          suggestion,
          recommendVersionId,
          campaignId
        )
        await submitSignedBody({
          platformSession,
          endpoint: ADD_ADGROUP_URL,
          body,
          requestJson,
          signBody,
          eid
        })
        createdUnits.push({
          campaignId,
          unitName: body.name,
          keywordCount: unit.keywordList.length,
          productCount: unit.products.length,
          tcpaBid: body.tcpaBid
        })
      } catch (error) {
        failures.push(buildFailure(campaign, unit, error))
      }
      completedUnits += 1
      onProgress({
        phase: 'create_adgroup_complete',
        campaignIndex: campaignIndex + 1,
        totalCampaigns: prepared.campaigns.length,
        unitIndex: unitIndex + 1,
        unitCount: campaign.units.length,
        completedUnits,
        totalUnits,
        campaignId,
        unitName: unit.unitName
      })
      await delay(1000)
    }
  }

  return {
    campaignCount: prepared.summary?.campaignCount || prepared.campaigns.length,
    unitCount: totalUnits,
    productCount: prepared.summary?.productCount || 0,
    successCampaignCount: createdCampaigns.length,
    successUnitCount: createdUnits.length,
    failureCount: failures.length,
    campaigns: createdCampaigns,
    units: createdUnits,
    failures
  }
}

async function createCustomCampaigns(options = {}) {
  const {
    platformSession,
    prepared,
    requestJson,
    signBody,
    eid,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onProgress = () => {}
  } = options
  if (!prepared?.campaigns?.length) throw new Error('没有可提交的广告计划')
  if (!eid) throw new Error('京东 eid Cookie 缺失，请重新登录京准通')

  const createdCampaigns = []
  const createdUnits = []
  const failures = []
  let completedUnits = 0
  const totalUnits = prepared.campaigns.reduce((total, campaign) => total + campaign.units.length, 0)

  for (let campaignIndex = 0; campaignIndex < prepared.campaigns.length; campaignIndex += 1) {
    const campaign = prepared.campaigns[campaignIndex]
    const firstUnit = campaign.units[0]
    onProgress({
      phase: 'create_campaign_start',
      campaignIndex: campaignIndex + 1,
      totalCampaigns: prepared.campaigns.length,
      completedUnits,
      totalUnits,
      planName: campaign.planName
    })

    let campaignId
    try {
      const recommendVersionId = await fetchRecommendVersionId(platformSession, requestJson)
      const body = buildCustomCampaignCreateBody(campaign, prepared.config, recommendVersionId)
      const payload = await submitSignedBody({
        platformSession,
        endpoint: CREATE_CAMPAIGN_URL,
        body,
        requestJson,
        signBody,
        eid
      })
      campaignId = payload?.data?.campaignId
      if (!campaignId) throw new Error('京东返回创建成功，但未返回计划 ID')
      createdCampaigns.push({ campaignId, campaignName: body.campaignCreateCommand.name })
      createdUnits.push({
        campaignId,
        unitName: body.adGroupCreateCommand.name,
        keywordCount: firstUnit.keywordList.length,
        productCount: firstUnit.products.length,
        inSearchFee: body.adGroupCreateCommand.inSearchFee,
        automatedBiddingType: body.adGroupCreateCommand.automatedBiddingType
      })
      completedUnits += 1
      onProgress({
        phase: 'create_campaign_complete',
        campaignIndex: campaignIndex + 1,
        totalCampaigns: prepared.campaigns.length,
        completedUnits,
        totalUnits,
        campaignId,
        planName: campaign.planName
      })
    } catch (error) {
      for (const unit of campaign.units) failures.push(buildFailure(campaign, unit, error))
      completedUnits += campaign.units.length
      onProgress({
        phase: 'create_campaign_failed',
        campaignIndex: campaignIndex + 1,
        totalCampaigns: prepared.campaigns.length,
        completedUnits,
        totalUnits,
        planName: campaign.planName,
        message: error?.message || '创建计划失败'
      })
      continue
    }

    for (let unitIndex = 1; unitIndex < campaign.units.length; unitIndex += 1) {
      const unit = campaign.units[unitIndex]
      onProgress({
        phase: 'create_adgroup_start',
        campaignIndex: campaignIndex + 1,
        totalCampaigns: prepared.campaigns.length,
        unitIndex: unitIndex + 1,
        unitCount: campaign.units.length,
        completedUnits,
        totalUnits,
        campaignId,
        unitName: unit.unitName
      })
      try {
        const recommendVersionId = await fetchRecommendVersionId(platformSession, requestJson)
        const body = buildCustomAdditionalAdGroupBody(
          unit,
          prepared.config,
          recommendVersionId,
          campaignId
        )
        await submitSignedBody({
          platformSession,
          endpoint: ADD_ADGROUP_URL,
          body,
          requestJson,
          signBody,
          eid
        })
        createdUnits.push({
          campaignId,
          unitName: body.name,
          keywordCount: unit.keywordList.length,
          productCount: unit.products.length,
          inSearchFee: body.inSearchFee,
          automatedBiddingType: body.automatedBiddingType
        })
      } catch (error) {
        failures.push(buildFailure(campaign, unit, error))
      }
      completedUnits += 1
      onProgress({
        phase: 'create_adgroup_complete',
        campaignIndex: campaignIndex + 1,
        totalCampaigns: prepared.campaigns.length,
        unitIndex: unitIndex + 1,
        unitCount: campaign.units.length,
        completedUnits,
        totalUnits,
        campaignId,
        unitName: unit.unitName
      })
      await delay(1000)
    }
  }

  return {
    campaignCount: prepared.summary?.campaignCount || prepared.campaigns.length,
    unitCount: totalUnits,
    productCount: prepared.summary?.productCount || 0,
    successCampaignCount: createdCampaigns.length,
    successUnitCount: createdUnits.length,
    failureCount: failures.length,
    campaigns: createdCampaigns,
    units: createdUnits,
    failures
  }
}

module.exports = {
  ADD_ADGROUP_URL,
  CREATE_CAMPAIGN_URL,
  buildAdditionalAdGroupBody,
  buildAdGroupCommand,
  buildCampaignCreateBody,
  buildCreative,
  buildCustomAdditionalAdGroupBody,
  buildCustomAdGroupCommand,
  buildCustomCampaignCreateBody,
  buildCustomCreative,
  createCustomCampaigns,
  createRoiCampaigns,
  createSingleProductTest,
  resolveRoiBid
}
