'use strict'

const { adjustRoiBid, assertCreationDates, assertCustomKeywordBidConfig } = require('./jd-express-utils')
const { applyCustomKeywordBidLimit, KEYWORD_MIN_BID_URL } = require('./jd-express-keywords')
const { isJdSessionExpiredPayload, isJdSessionFailure } = require('./jd-session-recovery')
const { assertCrowdSettings, normalizeCrowdSettings } = require('./jd-express-crowds')
const { normalizeTimeRangeConfig } = require('./jd-express-time-range')
const {
  creationErrorDetails, creationResponseError, creationUnitContext, creationBodySummary,
  emitCreationDiagnostic, runCreationStage
} = require('./jd-express-creation-log')

const SUGGEST_PRICE_URL = 'https://jzt-api.jd.com/common/tcpa/suggest/price'
const VERSION_ID_URL = 'https://jzt-api.jd.com/common/get/recommendautobidding/type'
const CREATE_CAMPAIGN_URL = 'https://atoms-api.jd.com/dspad/msa/campaign/item/keyword/add'
const ADD_ADGROUP_URL = 'https://atoms-api.jd.com/dspad/msa/adgroup/item/keyword/add'
const TIME_RANGE_UPDATE_URL = 'https://atoms-api.jd.com/dspad/material/center/task/batchUpdate/timerange'

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
      // 京东的计划创建接口不接受这里直接携带 7x24 分时系数。计划创建成功并
      // 获得 campaignId 后，再通过 batchUpdate/timerange 独立设置。
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
  assertCrowdSettings(config.dmpCrowdSettings)
  if (!unit?.keywordList?.length) throw new Error('推广单元没有可提交的关键词及出价')
  assertCustomKeywordBidConfig({ ...config, createMode: 'custom' })
  if (config.useMinKeywordBid === false && unit.keywordList.some(row =>
    !Number.isFinite(Number(row.keywordMobilePrice)) || Number(row.keywordMobilePrice) < 0.1 ||
    Number(row.keywordMobilePrice) > Number(config.maxCustomKeywordBid))) {
    throw new Error('关键词提交出价无效或超过用户设置的最高出价')
  }
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
    dmpCrowdSettings: normalizeCrowdSettings(config.dmpCrowdSettings),
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
    throw creationResponseError(`ROI控制获取建议出价失败：${responseMessage(payload, '京东未返回建议值')}`, payload, 'suggestion', SUGGEST_PRICE_URL)
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
    throw creationResponseError(`获取京东提交版本失败：${responseMessage(payload, '未返回版本号')}`, payload, 'version', VERSION_ID_URL)
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
    eid,
    onDiagnostic,
    context = {}
  } = options
  emitCreationDiagnostic(onDiagnostic, {
    ...context, ...creationBodySummary(body), stage: 'request_summary', result: 'prepared'
  })
  const signed = await runCreationStage(onDiagnostic, context, 'sign', endpoint, async () => {
    const result = await signBody(body)
    if (!result?.h5st) throw new Error('京准通签名失败，未获得 h5st')
    return result
  })
  const url = `${endpoint}?eid=${encodeURIComponent(eid)}&h5st=${signed.h5st}`
  return runCreationStage(onDiagnostic, context, 'submit', endpoint, async () => {
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
      const error = creationResponseError(responseMessage(payload, '京东快车创建请求失败'), payload, 'submit', endpoint)
      if (isJdSessionExpiredPayload(payload)) error.code = 'JD_SESSION_EXPIRED'
      throw error
    }
    return payload
  })
}

async function createSingleProductTest(options = {}) {
  const {
    platformSession,
    prepared,
    requestJson,
    signBody,
    eid,
    onDiagnostic,
    resumeState: inputResumeState,
    onCheckpoint
  } = options
  if (!prepared || prepared.summary?.productCount !== 1 || prepared.summary?.campaignCount !== 1 || prepared.summary?.unitCount !== 1) {
    throw new Error('安全校验失败：单商品测试只能提交 1 个商品、1 个计划和 1 个单元')
  }
  if (!eid) throw new Error('京东 eid Cookie 缺失，请重新登录京准通')
  assertCreationDates(prepared.config || {})
  normalizeTimeRangeConfig(prepared.config || {})
  const campaign = prepared.campaigns[0]
  const unit = campaign.units[0]
  const resumeState = cloneResumeState(inputResumeState)
  const resumedEntry = resumeState.campaigns['0']
  let campaignId = resumedEntry?.campaignId
  let campaignName = resumedEntry?.campaignName || campaign.planName
  let unitName = unit.unitName
  let tcpaBid
  let response = null
  if (!campaignId) {
    const context = creationUnitContext(campaign, unit, 0, 0)
    const suggestion = await runCreationStage(onDiagnostic, context, 'suggestion', SUGGEST_PRICE_URL,
      () => fetchSuggestion(platformSession, unit, prepared.config, requestJson))
    const recommendVersionId = await runCreationStage(onDiagnostic, context, 'version', VERSION_ID_URL,
      () => fetchRecommendVersionId(platformSession, requestJson))
    const body = await runCreationStage(onDiagnostic, context, 'build_body', CREATE_CAMPAIGN_URL,
      () => buildCampaignCreateBody(campaign, prepared.config, suggestion, recommendVersionId))
    response = await submitSignedBody({
      platformSession,
      endpoint: CREATE_CAMPAIGN_URL,
      body,
      requestJson,
      signBody,
      eid,
      onDiagnostic,
      context
    })
    campaignId = response?.data?.campaignId
    if (!campaignId) {
      throw creationResponseError(
        '京东返回创建成功，但未返回计划 ID', response, 'validate_response', CREATE_CAMPAIGN_URL)
    }
    campaignName = body.campaignCreateCommand.name
    unitName = body.adGroupCreateCommand.name
    tcpaBid = body.adGroupCreateCommand.tcpaBid
    await markCreatedUnit(resumeState, 0, campaignId, campaignName, 0, onCheckpoint)
  }
  const timeRangeResult = await applyCreatedCampaignTimeRanges({
    platformSession,
    prepared,
    requestJson,
    resumeState,
    delay: async () => {},
    onDiagnostic,
    onCheckpoint
  })
  return {
    campaignId,
    campaignName,
    unitName,
    skuId: unit.products[0]?.skuId,
    keywordCount: unit.keywordList.length,
    tcpaBid,
    response,
    resumeState,
    ...timeRangeResult
  }
}

function buildFailure(campaign, unit, error) {
  return {
    planName: campaign?.planName || '',
    unitName: unit?.unitName || '',
    skuIds: (unit?.products || []).map((product) => product.skuId),
    ...creationErrorDetails(error)
  }
}

function cloneResumeState(resumeState = {}) {
  const campaigns = {}
  for (const [key, value] of Object.entries(resumeState?.campaigns || {})) {
    if (!value || typeof value !== 'object') continue
    campaigns[key] = {
      campaignId: value.campaignId,
      campaignName: value.campaignName || '',
      completedUnitIndexes: [...new Set((value.completedUnitIndexes || []).map(Number)
        .filter((index) => Number.isInteger(index) && index >= 0))],
      timeRangeApplied: value.timeRangeApplied === true,
      timeRangeSignature: typeof value.timeRangeSignature === 'string' ? value.timeRangeSignature : ''
    }
  }
  return { campaigns }
}

function campaignResumeEntry(resumeState, campaignIndex) {
  const key = String(campaignIndex)
  if (!resumeState.campaigns[key]) {
    resumeState.campaigns[key] = {
      campaignId: null,
      campaignName: '',
      completedUnitIndexes: [],
      timeRangeApplied: false,
      timeRangeSignature: ''
    }
  }
  return resumeState.campaigns[key]
}

async function saveCreationCheckpoint(onCheckpoint, resumeState) {
  if (!onCheckpoint) return
  try {
    await onCheckpoint(cloneResumeState(resumeState))
  } catch (cause) {
    const error = new Error('计划已提交成功，但无法保存续传进度；为避免重复创建，本轮已停止，请先到京准通核对')
    error.code = 'JD_EXPRESS_CHECKPOINT_FAILED'
    error.creationStage = 'checkpoint'
    error.cause = cause
    throw error
  }
}

async function markCreatedUnit(resumeState, campaignIndex, campaignId, campaignName, unitIndex, onCheckpoint) {
  const entry = campaignResumeEntry(resumeState, campaignIndex)
  entry.campaignId = campaignId
  entry.campaignName = campaignName || entry.campaignName
  if (!entry.completedUnitIndexes.includes(unitIndex)) entry.completedUnitIndexes.push(unitIndex)
  await saveCreationCheckpoint(onCheckpoint, resumeState)
}

function restoredCreationRows(prepared, resumeState) {
  const campaigns = []
  const units = []
  for (let campaignIndex = 0; campaignIndex < prepared.campaigns.length; campaignIndex += 1) {
    const campaign = prepared.campaigns[campaignIndex]
    const entry = resumeState.campaigns[String(campaignIndex)]
    if (!entry?.campaignId) continue
    campaigns.push({
      campaignId: entry.campaignId,
      campaignName: entry.campaignName || campaign.planName,
      campaignIndex,
      resumed: true
    })
    for (const unitIndex of entry.completedUnitIndexes) {
      const unit = campaign.units[unitIndex]
      if (!unit) continue
      units.push({
        campaignId: entry.campaignId,
        unitName: unit.unitName,
        keywordCount: unit.keywordList?.length || 0,
        productCount: unit.products?.length || 0,
        campaignIndex,
        unitIndex,
        resumed: true
      })
    }
  }
  return { campaigns, units }
}

function timeRangeResponseError(payload) {
  const nested = payload?.data?.data ?? payload?.data ?? payload
  const responseCode = nested?.code ?? payload?.code ?? nested?.subCode ?? payload?.subCode
  const normalizedCode = responseCode == null ? '' : String(responseCode).trim().toLowerCase()
  const sessionExpired = isJdSessionExpiredPayload(payload) || isJdSessionExpiredPayload(nested) ||
    normalizedCode.includes('301')
  const explicitFailure = payload?.success === false || nested?.success === false
  const explicitSuccess = payload?.success === true || nested?.success === true
  const acceptedCode = ['0', '1', '200', '0000', 'success', 'ok'].includes(normalizedCode)
  const rejectedCode = Boolean(normalizedCode) && !acceptedCode
  if (!sessionExpired && !explicitFailure && !rejectedCode && (explicitSuccess || acceptedCode)) return null
  const responsePayload = nested?.code != null || nested?.subCode != null ? nested : payload
  const error = creationResponseError(
    responseMessage(nested, responseMessage(payload, '修改投放时段失败')),
    responsePayload,
    'time_range_apply',
    TIME_RANGE_UPDATE_URL
  )
  if (sessionExpired) error.code = 'JD_SESSION_EXPIRED'
  // 设置同一份分时表是幂等操作，重新登录后重复设置不会创建计划或单元。
  error.retrySafe = true
  return error
}

async function applyCreatedCampaignTimeRanges(options = {}) {
  const {
    platformSession,
    prepared,
    requestJson,
    resumeState,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onProgress = () => {},
    onDiagnostic,
    onCheckpoint
  } = options
  const normalized = normalizeTimeRangeConfig(prepared.config || {})
  const available = prepared.campaigns.map((campaign, campaignIndex) => ({
    campaign,
    campaignIndex,
    entry: resumeState.campaigns[String(campaignIndex)]
  })).filter(({ entry }) => entry?.campaignId)
  const targetSignature = JSON.stringify(normalized.timeRangeSchedule)
  const requiresUpdate = ({ entry }) => normalized.timeRangeMode === 'custom'
    ? entry.timeRangeSignature !== targetSignature
    : Boolean(entry.timeRangeSignature && entry.timeRangeSignature !== targetSignature)
  const pending = available.filter(requiresUpdate)
  if (!pending.length) {
    return { timeRangeCampaignCount: 0, timeRangeSuccessCount: 0, timeRangeFailureCount: 0, timeRangeFailures: [] }
  }

  const failures = []
  let successCount = available.length - pending.length
  for (let index = 0; index < pending.length; index += 1) {
    const { campaign, campaignIndex, entry } = pending[index]
    const context = {
      campaignId: entry.campaignId,
      campaignIndex: campaignIndex + 1,
      planName: campaign.planName
    }
    onProgress({
      phase: 'time_range_apply_start',
      campaignId: entry.campaignId,
      campaignIndex: campaignIndex + 1,
      totalCampaigns: available.length
    })
    try {
      const payload = await runCreationStage(onDiagnostic, context, 'time_range_apply', TIME_RANGE_UPDATE_URL,
        () => requestJson(platformSession, TIME_RANGE_UPDATE_URL, {
          method: 'POST',
          referer: 'https://jzt.jd.com/',
          headers: { origin: 'https://jzt.jd.com', loginmode: '0', siteid: '0' },
          body: {
            campaignSettings: [{
              campaignId: Number(entry.campaignId),
              timeRangeCoefSettings: normalized.timeRangeSchedule
            }],
            requestFrom: 0
          }
        }))
      const responseError = timeRangeResponseError(payload)
      if (responseError) throw responseError
      entry.timeRangeApplied = true
      entry.timeRangeSignature = targetSignature
      await saveCreationCheckpoint(onCheckpoint, resumeState)
      successCount += 1
      onProgress({
        phase: 'time_range_apply_complete',
        campaignId: entry.campaignId,
        campaignIndex: campaignIndex + 1,
        totalCampaigns: available.length
      })
    } catch (error) {
      if (error?.code === 'JD_EXPRESS_CHECKPOINT_FAILED') throw error
      failures.push({
        campaignId: entry.campaignId,
        campaignIndex: campaignIndex + 1,
        planName: campaign.planName,
        // 分时接口只修改已有计划；网络超时后重放相同设置也不会重复建计划。
        retrySafe: true,
        ...creationErrorDetails(error)
      })
      onProgress({
        phase: 'time_range_apply_failed',
        campaignId: entry.campaignId,
        campaignIndex: campaignIndex + 1,
        totalCampaigns: available.length,
        message: error?.message || '修改投放时段失败'
      })
    }
    if (index < pending.length - 1) await delay(1000)
  }
  return {
    timeRangeCampaignCount: available.length,
    timeRangeSuccessCount: successCount,
    timeRangeFailureCount: failures.length,
    timeRangeFailures: failures
  }
}

function recordCreationFailure(failures, campaign, unit, error, onDiagnostic, context, blockedByCampaign = false) {
  const failure = { ...buildFailure(campaign, unit, error),
    campaignIndex: context.campaignIndex, unitIndex: context.unitIndex, blockedByCampaign }
  failures.push(failure)
  emitCreationDiagnostic(onDiagnostic, {
    ...context, ...creationErrorDetails(error), result: 'unit_failed', blockedByCampaign
  })
}

const DEFINITIVE_NO_WRITE_STAGES = new Set([
  'suggestion', 'version', 'build_body', 'keyword_floor', 'sign', 'date_validation'
])

function isSafeAnchorFailure(error) {
  if (isJdSessionFailure(error)) return false
  if (DEFINITIVE_NO_WRITE_STAGES.has(error?.creationStage)) return true
  return error?.creationStage === 'submit' &&
    error?.code === 'JD_EXPRESS_RESPONSE_FAILED' && error?.jdCode != null
}

async function createRoiCampaigns(options = {}) {
  const {
    platformSession,
    prepared,
    requestJson,
    signBody,
    eid,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onProgress = () => {},
    onDiagnostic,
    resumeState: inputResumeState,
    onCheckpoint
  } = options
  if (!prepared?.campaigns?.length) throw new Error('没有可提交的广告计划')
  if (!eid) throw new Error('京东 eid Cookie 缺失，请重新登录京准通')
  assertCreationDates(prepared.config || {})
  normalizeTimeRangeConfig(prepared.config || {})

  const resumeState = cloneResumeState(inputResumeState)
  const restored = restoredCreationRows(prepared, resumeState)
  const createdCampaigns = restored.campaigns
  const createdUnits = restored.units
  const failures = []
  let completedUnits = createdUnits.length
  const totalUnits = prepared.campaigns.reduce((total, campaign) => total + campaign.units.length, 0)

  for (let campaignIndex = 0; campaignIndex < prepared.campaigns.length; campaignIndex += 1) {
    const campaign = prepared.campaigns[campaignIndex]
    let campaignId = resumeState.campaigns[String(campaignIndex)]?.campaignId
    const completedUnitIndexes = new Set(
      resumeState.campaigns[String(campaignIndex)]?.completedUnitIndexes || [])
    const unitQueue = campaign.units.map((_, index) => index)
      .filter(index => !completedUnitIndexes.has(index))
    const deferredAnchorFailures = new Map()

    while (unitQueue.length) {
      const unitIndex = unitQueue.shift()
      if (completedUnitIndexes.has(unitIndex)) continue
      const unit = campaign.units[unitIndex]
      const creatingCampaign = !campaignId
      const context = creationUnitContext(campaign, unit, campaignIndex, unitIndex, campaignId)
      const progress = {
        campaignIndex: campaignIndex + 1,
        totalCampaigns: prepared.campaigns.length,
        unitIndex: unitIndex + 1,
        unitCount: campaign.units.length,
        completedUnits,
        totalUnits,
        campaignId,
        planName: campaign.planName,
        unitName: unit.unitName
      }
      onProgress({ ...progress, phase: creatingCampaign ? 'create_campaign_start' : 'create_adgroup_start' })

      let body
      let unitFailed = false
      try {
        const suggestion = await runCreationStage(onDiagnostic, context, 'suggestion', SUGGEST_PRICE_URL,
          () => fetchSuggestion(platformSession, unit, prepared.config, requestJson))
        const recommendVersionId = await runCreationStage(onDiagnostic, context, 'version', VERSION_ID_URL,
          () => fetchRecommendVersionId(platformSession, requestJson))
        const endpoint = creatingCampaign ? CREATE_CAMPAIGN_URL : ADD_ADGROUP_URL
        body = await runCreationStage(onDiagnostic, context, 'build_body', endpoint, () => creatingCampaign
          ? buildCampaignCreateBody({ ...campaign, units: [unit] }, prepared.config, suggestion, recommendVersionId)
          : buildAdditionalAdGroupBody(unit, prepared.config, suggestion, recommendVersionId, campaignId))
        const payload = await submitSignedBody({
          platformSession, endpoint, body, requestJson, signBody, eid, onDiagnostic, context
        })
        if (creatingCampaign) {
          campaignId = payload?.data?.campaignId
          if (!campaignId) {
            throw creationResponseError(
              '京东返回创建成功，但未返回计划 ID', payload, 'validate_response', endpoint)
          }
          await markCreatedUnit(
            resumeState, campaignIndex, campaignId, body.campaignCreateCommand.name, unitIndex, onCheckpoint)
          createdCampaigns.push({ campaignId, campaignName: body.campaignCreateCommand.name, campaignIndex })
          emitCreationDiagnostic(onDiagnostic, {
            ...context, campaignId, stage: 'campaign_complete', result: 'success'
          })
          if (deferredAnchorFailures.size) {
            unitQueue.push(...deferredAnchorFailures.keys())
            deferredAnchorFailures.clear()
          }
        } else {
          await markCreatedUnit(
            resumeState,
            campaignIndex,
            campaignId,
            resumeState.campaigns[String(campaignIndex)]?.campaignName || campaign.planName,
            unitIndex,
            onCheckpoint
          )
        }
        completedUnitIndexes.add(unitIndex)
        const group = body.adGroupCreateCommand || body
        createdUnits.push({
          campaignId,
          unitName: group.name,
          keywordCount: unit.keywordList.length,
          productCount: unit.products.length,
          tcpaBid: group.tcpaBid,
          campaignIndex,
          unitIndex
        })
      } catch (error) {
        if (error?.code === 'JD_EXPRESS_CHECKPOINT_FAILED') throw error
        const safeAnchorFailure = creatingCampaign && isSafeAnchorFailure(error)
        if (safeAnchorFailure && unitQueue.length) {
          deferredAnchorFailures.set(unitIndex, error)
          onProgress({
            ...progress,
            phase: 'create_campaign_anchor_failed',
            message: `${error?.message || '当前单元无法建立计划'}，正在尝试下一单元`
          })
          await delay(1000)
          continue
        }

        unitFailed = true
        recordCreationFailure(failures, campaign, unit, error, onDiagnostic, context)
        completedUnits += 1
        if (creatingCampaign) {
          for (const [deferredIndex, deferredError] of deferredAnchorFailures.entries()) {
            const deferredUnit = campaign.units[deferredIndex]
            recordCreationFailure(
              failures,
              campaign,
              deferredUnit,
              deferredError,
              onDiagnostic,
              creationUnitContext(campaign, deferredUnit, campaignIndex, deferredIndex)
            )
            completedUnits += 1
          }
          deferredAnchorFailures.clear()
          for (const blockedIndex of unitQueue.splice(0)) {
            const blockedUnit = campaign.units[blockedIndex]
            recordCreationFailure(
              failures,
              campaign,
              blockedUnit,
              error,
              onDiagnostic,
              creationUnitContext(campaign, blockedUnit, campaignIndex, blockedIndex),
              !safeAnchorFailure
            )
            completedUnits += 1
          }
        }
      }

      if (!unitFailed) completedUnits += 1
      onProgress({
        ...progress,
        completedUnits,
        campaignId,
        phase: creatingCampaign
          ? (unitFailed ? 'create_campaign_failed' : 'create_campaign_complete')
          : (unitFailed ? 'create_adgroup_failed' : 'create_adgroup_complete')
      })
      await delay(1000)
    }
    if (!campaignId && deferredAnchorFailures.size) {
      for (const [deferredIndex, deferredError] of deferredAnchorFailures.entries()) {
        const deferredUnit = campaign.units[deferredIndex]
        recordCreationFailure(
          failures,
          campaign,
          deferredUnit,
          deferredError,
          onDiagnostic,
          creationUnitContext(campaign, deferredUnit, campaignIndex, deferredIndex)
        )
        completedUnits += 1
      }
    }
  }

  const timeRangeResult = await applyCreatedCampaignTimeRanges({
    platformSession,
    prepared,
    requestJson,
    resumeState,
    delay,
    onProgress,
    onDiagnostic,
    onCheckpoint
  })

  return {
    campaignCount: prepared.summary?.campaignCount || prepared.campaigns.length,
    unitCount: totalUnits,
    productCount: prepared.summary?.productCount || 0,
    successCampaignCount: createdCampaigns.length,
    successUnitCount: createdUnits.length,
    failureCount: failures.length,
    campaigns: createdCampaigns,
    units: createdUnits,
    failures,
    resumeState,
    ...timeRangeResult
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
    onProgress = () => {},
    onDiagnostic,
    resumeState: inputResumeState,
    onCheckpoint
  } = options
  if (!prepared?.campaigns?.length) throw new Error('没有可提交的广告计划')
  if (!eid) throw new Error('京东 eid Cookie 缺失，请重新登录京准通')
  assertCreationDates(prepared.config || {})
  normalizeTimeRangeConfig(prepared.config || {})
  assertCustomKeywordBidConfig({ ...prepared.config, createMode: 'custom' })
  assertCrowdSettings(prepared.config.dmpCrowdSettings)

  const resumeState = cloneResumeState(inputResumeState)
  const restored = restoredCreationRows(prepared, resumeState)
  const createdCampaigns = restored.campaigns
  const createdUnits = restored.units
  const failures = []
  const skips = []
  let adjustedKeywordCount = 0
  let skippedKeywordCount = 0
  let sessionError = null
  let completedUnits = createdUnits.length
  const totalUnits = prepared.campaigns.reduce((total, campaign) => total + campaign.units.length, 0)

  for (let campaignIndex = 0; campaignIndex < prepared.campaigns.length; campaignIndex += 1) {
    const campaign = prepared.campaigns[campaignIndex]
    let campaignId = resumeState.campaigns[String(campaignIndex)]?.campaignId
    const completedUnitIndexes = new Set(
      resumeState.campaigns[String(campaignIndex)]?.completedUnitIndexes || [])
    let blockedError = null
    const unitQueue = campaign.units.map((_, index) => index)
      .filter(index => !completedUnitIndexes.has(index))
    const deferredAnchorFailures = new Map()
    while (unitQueue.length) {
      const unitIndex = unitQueue.shift()
      if (completedUnitIndexes.has(unitIndex)) continue
      let unit = campaign.units[unitIndex]
      const context = creationUnitContext(campaign, unit, campaignIndex, unitIndex, campaignId)
      const creatingCampaign = !campaignId
      const progress = { ...context, totalCampaigns: prepared.campaigns.length,
        unitCount: campaign.units.length, completedUnits, totalUnits }
      if (sessionError || blockedError) {
        recordCreationFailure(failures, campaign, unit, sessionError || blockedError, onDiagnostic, context, true)
        completedUnits += 1
        onProgress({ ...progress, completedUnits, phase: 'create_adgroup_failed', message: (sessionError || blockedError).message })
        continue
      }
      onProgress({
        ...progress, phase: creatingCampaign ? 'create_campaign_start' : 'create_adgroup_start'
      })
      let unitFailed = false
      let passedFloorCheck = false
      try {
        if (prepared.config.useMinKeywordBid === false) {
          const reportFloorProgress = event => onProgress({ ...event,
            phase: event.phase.replace('keyword_bid_', 'create_keyword_bid_') })
          reportFloorProgress({ ...progress, phase: 'keyword_bid_start' })
          const pricing = await runCreationStage(onDiagnostic, context, 'keyword_floor', KEYWORD_MIN_BID_URL, () => applyCustomKeywordBidLimit({
            platformSession, unit, config: prepared.config, requestJson, delay, onProgress: reportFloorProgress,
            context: { ...progress, totalUnits }
          }))
          adjustedKeywordCount += pricing.adjustedKeywords.length
          skippedKeywordCount += pricing.skippedKeywords.length
          for (const adjustment of pricing.adjustedKeywords) emitCreationDiagnostic(onDiagnostic, {
            ...context, ...adjustment, stage: 'keyword_bid_policy', result: 'bid_raised'
          })
          for (const skipped of pricing.skippedKeywords) emitCreationDiagnostic(onDiagnostic, {
            ...context, ...skipped, stage: 'keyword_bid_policy', result: 'keyword_skipped'
          })
          unit = { ...unit, keywordList: pricing.keywordList }
          context.keywordCount = unit.keywordList.length
          if (!unit.keywordList.length) {
            const skip = { ...context, code: 'JD_EXPRESS_NO_AFFORDABLE_KEYWORDS',
              message: '没有底价有效且不超过最高出价的关键词，已跳过该推广单元',
              keywords: pricing.skippedKeywords }
            skips.push(skip)
            emitCreationDiagnostic(onDiagnostic, { ...skip, stage: 'keyword_bid_policy', result: 'unit_skipped' })
            completedUnits += 1
            onProgress({ ...progress, phase: 'create_adgroup_skipped', completedUnits, message: skip.message })
            continue
          }
        }
        passedFloorCheck = true
        // A run may cross midnight while reading floors. Check again before any write.
        assertCreationDates(prepared.config)
        const recommendVersionId = await runCreationStage(onDiagnostic, context, 'version', VERSION_ID_URL,
          () => fetchRecommendVersionId(platformSession, requestJson))
        const endpoint = creatingCampaign ? CREATE_CAMPAIGN_URL : ADD_ADGROUP_URL
        const body = await runCreationStage(onDiagnostic, context, 'build_body', endpoint, () => creatingCampaign
          ? buildCustomCampaignCreateBody({ ...campaign, units: [unit] }, prepared.config, recommendVersionId)
          : buildCustomAdditionalAdGroupBody(unit, prepared.config, recommendVersionId, campaignId))
        const payload = await submitSignedBody({ platformSession, endpoint, body, requestJson, signBody, eid, onDiagnostic, context })
        if (creatingCampaign) {
          campaignId = payload?.data?.campaignId
          if (!campaignId) throw creationResponseError('京东返回创建成功，但未返回计划 ID', payload, 'validate_response', endpoint)
          await markCreatedUnit(
            resumeState, campaignIndex, campaignId, body.campaignCreateCommand.name, unitIndex, onCheckpoint)
          completedUnitIndexes.add(unitIndex)
          createdCampaigns.push({
            campaignId,
            campaignName: body.campaignCreateCommand.name,
            campaignIndex
          })
          emitCreationDiagnostic(onDiagnostic, { ...context, campaignId, stage: 'campaign_complete', result: 'success' })
          if (deferredAnchorFailures.size) {
            unitQueue.push(...deferredAnchorFailures.keys())
            deferredAnchorFailures.clear()
          }
        } else {
          await markCreatedUnit(
            resumeState,
            campaignIndex,
            campaignId,
            resumeState.campaigns[String(campaignIndex)]?.campaignName || campaign.planName,
            unitIndex,
            onCheckpoint
          )
          completedUnitIndexes.add(unitIndex)
        }
        const group = body.adGroupCreateCommand || body
        createdUnits.push({
          campaignId, unitName: group.name, keywordCount: unit.keywordList.length,
          productCount: unit.products.length, inSearchFee: group.inSearchFee,
          automatedBiddingType: group.automatedBiddingType,
          campaignIndex,
          unitIndex
        })
      } catch (error) {
        if (error?.code === 'JD_EXPRESS_CHECKPOINT_FAILED') throw error
        const safeAnchorFailure = creatingCampaign && passedFloorCheck && isSafeAnchorFailure(error)
        if (safeAnchorFailure && unitQueue.length) {
          deferredAnchorFailures.set(unitIndex, error)
          onProgress({
            ...progress,
            phase: 'create_campaign_anchor_failed',
            message: `${error?.message || '当前单元无法建立计划'}，正在尝试下一单元`
          })
          await delay(1000)
          continue
        }
        unitFailed = true
        recordCreationFailure(failures, campaign, unit, error, onDiagnostic, context)
        if (creatingCampaign) {
          for (const [deferredIndex, deferredError] of deferredAnchorFailures.entries()) {
            const deferredUnit = campaign.units[deferredIndex]
            recordCreationFailure(
              failures,
              campaign,
              deferredUnit,
              deferredError,
              onDiagnostic,
              creationUnitContext(campaign, deferredUnit, campaignIndex, deferredIndex)
            )
            completedUnits += 1
          }
          deferredAnchorFailures.clear()
        }
        if (creatingCampaign && passedFloorCheck && !safeAnchorFailure) blockedError = error
        if (isJdSessionFailure(error)) sessionError = error
      }
      completedUnits += 1
      onProgress({
        ...progress, completedUnits, campaignId,
        phase: creatingCampaign ? (unitFailed ? 'create_campaign_failed' : 'create_campaign_complete')
          : (unitFailed ? 'create_adgroup_failed' : 'create_adgroup_complete')
      })
      await delay(1000)
    }
    // All remaining candidates may have been skipped by keyword-floor policy after an
    // earlier anchor failed. Surface that deferred failure instead of silently losing it.
    if (!campaignId && deferredAnchorFailures.size) {
      for (const [deferredIndex, deferredError] of deferredAnchorFailures.entries()) {
        const deferredUnit = campaign.units[deferredIndex]
        recordCreationFailure(
          failures,
          campaign,
          deferredUnit,
          deferredError,
          onDiagnostic,
          creationUnitContext(campaign, deferredUnit, campaignIndex, deferredIndex)
        )
        completedUnits += 1
      }
    }
  }

  const timeRangeResult = await applyCreatedCampaignTimeRanges({
    platformSession,
    prepared,
    requestJson,
    resumeState,
    delay,
    onProgress,
    onDiagnostic,
    onCheckpoint
  })

  return {
    campaignCount: prepared.summary?.campaignCount || prepared.campaigns.length,
    unitCount: totalUnits,
    productCount: prepared.summary?.productCount || 0,
    successCampaignCount: createdCampaigns.length,
    successUnitCount: createdUnits.length,
    failureCount: failures.length,
    skippedUnitCount: skips.length,
    adjustedKeywordCount,
    skippedKeywordCount,
    campaigns: createdCampaigns,
    units: createdUnits,
    failures,
    skips,
    resumeState,
    ...timeRangeResult
  }
}

module.exports = {
  ADD_ADGROUP_URL,
  CREATE_CAMPAIGN_URL,
  TIME_RANGE_UPDATE_URL,
  applyCreatedCampaignTimeRanges,
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
