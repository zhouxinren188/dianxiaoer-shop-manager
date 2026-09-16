'use strict'

const {
  assembleUnitKeywords,
  assertCustomKeywordBidConfig,
  buildTitleKeywordResult,
  extractBusinessWisdomKeywords,
  mergeProductKeywordRows,
  normalizeKeyword,
  selectProductKeywordSkuIds
} = require('./jd-express-utils')

const PRIVATE_TITLE_KEYWORDS_URL = 'http://inner.dou-live.com/jdOrder/app/text'
const PRIVATE_BUSINESS_KEYWORDS_URL = 'http://inner.dou-live.com/jd_brand/jdKeywordOrderList/selectList'
const PRODUCT_KEYWORDS_URL = 'https://jzt-api.jd.com/dspad/keyword/sku/recommend'
const KEYWORD_MIN_BID_URL = 'https://jzt-api.jd.com/dspad/keyword/normal/min/bid'
const DROPDOWN_KEYWORDS_URL = 'https://dd-search.jd.com/'
const { isJdSessionExpiredPayload, isJdSessionFailure } = require('./jd-session-recovery')
const { creationResponseError } = require('./jd-express-creation-log')

function chunkText(value, size = 980) {
  const text = String(value || '')
  const chunks = []
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.substring(index, index + size))
  }
  return chunks
}

function getResponseMessage(payload, fallback) {
  return payload?.subMsg || payload?.message || payload?.msg || fallback
}

async function fetchTitleKeywords(platformSession, products, requestJson) {
  const text = (Array.isArray(products) ? products : [])
    .map((product) => `${String(product?.name || '')};`)
    .join('')
  const chunks = chunkText(text)
  const results = await Promise.allSettled(chunks.map((chunk) => requestJson(
    platformSession,
    PRIVATE_TITLE_KEYWORDS_URL,
    {
      method: 'POST',
      referer: 'http://inner.dou-live.com/',
      body: { text: chunk }
    }
  )))
  const rows = []
  const errors = []
  for (const result of results) {
    if (result.status === 'rejected') {
      errors.push(result.reason?.message || '标题分词接口请求失败')
      continue
    }
    if (Number(result.value?.code) === 1 && Array.isArray(result.value?.data)) {
      rows.push(...result.value.data)
    } else {
      errors.push(getResponseMessage(result.value, '标题分词接口返回异常'))
    }
  }
  return { ...buildTitleKeywordResult(rows), errors }
}

async function requestPrivateBusinessRows(platformSession, cid2Id, categoryId, requestJson) {
  const paramsList = [
    new URLSearchParams({ cid2: String(cid2Id || ''), categoryId: String(categoryId || ''), num: '200' }),
    new URLSearchParams({ cid2Id: String(cid2Id || ''), categoryId: String(categoryId || ''), num: '200' })
  ]
  for (const params of paramsList) {
    try {
      const payload = await requestJson(
        platformSession,
        `${PRIVATE_BUSINESS_KEYWORDS_URL}?${params.toString()}`,
        { method: 'GET', referer: 'http://inner.dou-live.com/' }
      )
      const rows = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.content)
          ? payload.content
          : []
      if ((Number(payload?.code) === 0 || Number(payload?.status) === 0) && rows.length) return rows
    } catch {
      // 原工具会继续尝试兼容参数 cid2Id。
    }
  }
  return []
}

async function fetchPrivateBusinessKeywords(
  platformSession,
  unit,
  sortType,
  requestJson,
  queryLiveBusinessRows
) {
  const queryLevel = async (categoryId, cidLevel) => {
    let liveRows = []
    let liveStatus = 0
    let liveMessage = ''
    if (typeof queryLiveBusinessRows === 'function') {
      const livePayload = await queryLiveBusinessRows(unit.cid2Id, categoryId)
      liveStatus = Number(livePayload?.status)
      liveMessage = String(livePayload?.message || '')
      if (liveStatus !== 0) {
        return {
          keywords: [],
          usedCidLevel: cidLevel,
          source: 'szgateway.jd.com',
          errorMessage: liveStatus === 100402
            ? (liveMessage || '店铺未开通京东商智')
            : (liveMessage || '京东商智接口返回异常')
        }
      }
      liveRows = Array.isArray(livePayload?.content) ? livePayload.content : []
    }

    let keywords = extractBusinessWisdomKeywords(liveRows, sortType)
    let source = 'szgateway.jd.com'
    if (!keywords.length) {
      const cachedRows = await requestPrivateBusinessRows(
        platformSession,
        unit.cid2Id,
        categoryId,
        requestJson
      )
      keywords = extractBusinessWisdomKeywords(cachedRows, sortType)
      if (keywords.length) source = 'inner.dou-live.com/jd_brand'
    }
    return { keywords, usedCidLevel: cidLevel, source, errorMessage: '' }
  }

  let result = await queryLevel(unit.categoryId || '', unit.categoryId ? '3' : '2')
  if (!result.keywords.length && !result.errorMessage && unit.categoryId) {
    result = await queryLevel('', '2')
  }
  return result
}

async function fetchDropdownKeywords(platformSession, titleKeywords, requestJson) {
  const collected = []
  const seen = new Set()
  const timestamp = Date.now()
  for (const keyword of Array.isArray(titleKeywords) ? titleKeywords : []) {
    if (collected.length >= 100) break
    try {
      const params = new URLSearchParams({
        terminal: 'pc',
        newjson: '1',
        ver: '2',
        zip: '1',
        key: keyword,
        pvid: '',
        t: String(timestamp),
        curr_url: '',
        callback: ''
      })
      const payload = await requestJson(
        platformSession,
        `${DROPDOWN_KEYWORDS_URL}?${params.toString()}`,
        {
          method: 'GET',
          referer: 'https://www.jd.com/',
          headers: { accept: 'application/json, text/plain, */*' }
        }
      )
      for (const item of Array.isArray(payload) ? payload : []) {
        const value = normalizeKeyword(item?.key)
        if (!value || value.includes('京东') || value.includes('自营') || seen.has(value)) continue
        seen.add(value)
        collected.push(value)
        if (collected.length >= 100) break
      }
    } catch {
      // 原工具单个下拉词失败时继续处理后续词。
    }
  }
  return collected
}

async function waitWithProgress(delay, onProgress, payload, totalMs) {
  let remaining = Math.ceil(totalMs / 1000)
  while (remaining > 0) {
    onProgress({ ...payload, secondsRemaining: remaining })
    await delay(Math.min(1000, totalMs))
    remaining -= 1
  }
}

async function fetchProductKeywords(
  platformSession,
  unit,
  titleTagKeywords,
  config,
  requestJson,
  delay,
  onProgress
) {
  const skuIds = selectProductKeywordSkuIds(unit.products, titleTagKeywords, 4)
  const rows = []
  const errors = []
  const sourceCount = config.keywordSources.length
  const successDelayMs = Math.max(1000, 8000 - (sourceCount - 1) * 2000)

  for (let index = 0; index < skuIds.length; index += 1) {
    const skuId = skuIds[index]
    try {
      const payload = await requestJson(platformSession, PRODUCT_KEYWORDS_URL, {
        method: 'POST',
        body: {
          adKeywordTypes: [],
          skuId: Number.parseInt(skuId, 10),
          devType: 2,
          adGroupId: null,
          competitorSkus: [skuId],
          campaignType: 2,
          requestFrom: 0
        }
      })
      if (Number(payload?.code) === -100) {
        const error = new Error('京东店铺登录已失效，请先重新登录店铺')
        error.code = 'JD_SESSION_EXPIRED'
        throw error
      }
      if (Number(payload?.code) !== 1 || payload?.success === false) {
        throw new Error(getResponseMessage(payload, `SKU ${skuId} 获取商品推词失败`))
      }
      const data = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.data?.datas)
          ? payload.data.datas
          : []
      rows.push(...data)
      await waitWithProgress(delay, onProgress, {
        phase: 'product_keyword_interval',
        skuId,
        completed: index + 1,
        total: skuIds.length
      }, successDelayMs)
    } catch (error) {
      if (error?.code === 'JD_SESSION_EXPIRED') throw error
      errors.push(`SKU ${skuId}：${error?.message || '商品推词失败'}`)
      await waitWithProgress(delay, onProgress, {
        phase: 'product_keyword_rate_limit_wait',
        skuId,
        completed: index + 1,
        total: skuIds.length
      }, 60000)
    }
  }
  return { keywords: mergeProductKeywordRows(rows), errors }
}

function normalizeMatchType(value) {
  const matchType = Number(value)
  return [1, 4, 8].includes(matchType) ? matchType : 8
}

function defaultKeywordBidList(keywords, increment, matchType = 8) {
  const price = 0.1 + Number(increment || 0)
  const type = normalizeMatchType(matchType)
  return keywords.map((keyword) => ({
    reqType: 6,
    type,
    keywordMobilePrice: price,
    keywordName: keyword
  }))
}

function buildFixedKeywordBidList(keywords, bid, matchType = 8) {
  const price = Math.round(Math.max(0.1, Number(bid) || 0.1) * 10) / 10
  const type = normalizeMatchType(matchType)
  return keywords.map((keyword) => ({
    reqType: 6,
    type,
    keywordMobilePrice: price,
    keywordName: keyword
  }))
}

// Only read floor prices here; never retry an advertising creation request.
async function fetchKeywordFloors(options = {}) {
  const { platformSession, keywords, requestJson, delay, onProgress = () => {}, context = {} } = options
  const floors = new Map()
  const requested = [...new Set(keywords)]
  for (let offset = 0; offset < requested.length; offset += 100) {
    const batch = requested.slice(offset, offset + 100)
    let payload
    for (let attempt = 0; ; attempt += 1) {
      try {
        payload = await requestJson(platformSession, KEYWORD_MIN_BID_URL, {
          method: 'POST', body: { requestFrom: 0, keywords: batch }
        })
        if (Number(payload?.code) === -100 || isJdSessionExpiredPayload(payload)) {
          throw Object.assign(creationResponseError('店铺登录已失效，请重新登录', payload, 'keyword_floor', KEYWORD_MIN_BID_URL), { code: 'JD_SESSION_EXPIRED' })
        }
        if (Number(payload?.code) === -3010) {
          throw Object.assign(creationResponseError('京东关键词底价查询限流', payload, 'keyword_floor', KEYWORD_MIN_BID_URL), { code: 'JD_RATE_LIMIT' })
        }
        if (Number(payload?.code) !== 1 || payload?.success === false || !Array.isArray(payload?.data)) {
          throw creationResponseError(getResponseMessage(payload, '获取关键词最低出价失败'), payload, 'keyword_floor', KEYWORD_MIN_BID_URL)
        }
        break
      } catch (error) {
        const retryable = error?.code === 'JD_RATE_LIMIT' ||
          /Read timed out|Operation limit exceeded|超时|次数|上限/i.test(error?.message || '')
        if (isJdSessionFailure(error) || !retryable || attempt >= 3) throw error
        await waitWithProgress(delay, onProgress, { ...context, phase: 'keyword_bid_retry_wait' }, 5000)
      }
    }
    const batchSet = new Set(batch)
    for (const item of payload.data) {
      const keyword = String(item?.keywordName || '')
      const floor = Number(item?.minBidPrice)
      if (batchSet.has(keyword) && Number.isFinite(floor) && floor >= 0.1) {
        floors.set(keyword, Math.max(floors.get(keyword) || 0, floor))
      }
    }
    await waitWithProgress(delay, onProgress, { ...context, phase: 'keyword_bid_interval' }, 3000)
  }
  return floors
}

async function applyCustomKeywordBidLimit(options = {}) {
  const { unit, config, onProgress = () => {}, context = {} } = options
  assertCustomKeywordBidConfig({ ...config, createMode: 'custom' })
  const keywords = [...new Set((unit.keywordList || []).map(row => String(row.keywordName || '').trim()).filter(Boolean))]
  const floors = await fetchKeywordFloors({ ...options, keywords })
  const keywordList = []
  const adjustedKeywords = []
  const skippedKeywords = []
  const baseBid = Number(config.customKeywordBid)
  const maxBid = Number(config.maxCustomKeywordBid)
  for (const keywordName of keywords) {
    const floorBid = floors.get(keywordName)
    // Round UP to the supported 0.1 step, never below the floor or above the user's cap.
    const submittedBid = Math.max(baseBid, Math.ceil(floorBid * 10 - 1e-8) / 10)
    if (floorBid == null || submittedBid > maxBid) {
      skippedKeywords.push({ keywordName, baseBid, floorBid, maxBid,
        reason: floorBid == null ? '京东未返回有效最低出价' : '京东最低出价超过最高出价' })
      continue
    }
    keywordList.push(...buildFixedKeywordBidList([keywordName], submittedBid, config.keywordMatchType))
    if (submittedBid > baseBid) adjustedKeywords.push({ keywordName, baseBid, floorBid, maxBid, submittedBid })
  }
  onProgress({ ...context, phase: 'keyword_bid_policy_complete', keywordCount: keywordList.length,
    adjustedKeywordCount: adjustedKeywords.length, skippedKeywordCount: skippedKeywords.length })
  return { keywordList, adjustedKeywords, skippedKeywords }
}

async function fetchKeywordMinBids(platformSession, keywords, increment, requestJson, delay, onProgress, unitIndex, totalUnits, matchType = 8) {
  if (!keywords.length) return []
  const body = { requestFrom: 0, keywords }
  let retries = 3
  while (true) {
    try {
      const payload = await requestJson(platformSession, KEYWORD_MIN_BID_URL, {
        method: 'POST',
        body
      })
      if (Number(payload?.code) === -3010) {
        const error = new Error('Operation limit exceeded')
        error.code = 'JD_RATE_LIMIT'
        throw error
      }
      if (Number(payload?.code) !== 1 || !Array.isArray(payload?.data)) {
        throw new Error(getResponseMessage(payload, '获取关键词最低出价失败'))
      }
      const type = normalizeMatchType(matchType)
      const result = payload.data.map((item) => ({
        reqType: 6,
        type,
        keywordMobilePrice: Math.floor((Number(item?.minBidPrice) + Number(increment || 0)) * 10) / 10,
        keywordName: item?.keywordName
      }))
      await waitWithProgress(delay, onProgress, {
        phase: 'keyword_bid_interval',
        unitIndex,
        totalUnits
      }, 3000)
      return result
    } catch (error) {
      const retryable = error?.code === 'JD_RATE_LIMIT' ||
        /Read timed out|Operation limit exceeded|超时|次数|上限/i.test(error?.message || '')
      if (!retryable || retries <= 0) return defaultKeywordBidList(keywords, increment, matchType)
      retries -= 1
      await waitWithProgress(delay, onProgress, {
        phase: 'keyword_bid_retry_wait',
        unitIndex,
        totalUnits
      }, 5000)
    }
  }
}

async function prepareRoiKeywords(options = {}) {
  const {
    platformSession,
    structure,
    requestJson,
    queryBusinessWisdom,
    delay,
    onProgress = () => {}
  } = options
  if (!structure?.units?.length) throw new Error('没有可处理的推广单元')
  const config = structure.config
  assertCustomKeywordBidConfig(config)
  const preparedUnits = []

  for (let index = 0; index < structure.units.length; index += 1) {
    const unit = structure.units[index]
    const errors = []
    const sourceData = {
      businessWisdomKws: [],
      productKws: [],
      titleKws: [],
      pullDownKws: []
    }
    let titleTagKeywords = []
    let businessWisdomUsedCidLevel = ''
    onProgress({
      phase: 'keyword_unit_start',
      unitIndex: index + 1,
      totalUnits: structure.units.length,
      unitName: unit.unitName
    })

    if (config.keywordSources.includes(1)) {
      try {
        const result = await fetchPrivateBusinessKeywords(
          platformSession,
          unit,
          config.keywordSortType,
          requestJson,
          queryBusinessWisdom
        )
        sourceData.businessWisdomKws = result.keywords
        businessWisdomUsedCidLevel = result.usedCidLevel
        if (result.errorMessage) errors.push(`商智关键词：${result.errorMessage}`)
        else if (!result.keywords.length) errors.push('商智关键词：实时接口与私有缓存均暂无该类目数据')
      } catch (error) {
        errors.push(`商智关键词：${error?.message || '私有缓存请求失败'}`)
      }
    }

    if (config.keywordSources.includes(3)) {
      const result = await fetchTitleKeywords(platformSession, unit.products, requestJson)
      sourceData.titleKws = result.keywords
      titleTagKeywords = result.tagKeywords
      errors.push(...result.errors.map((message) => `标题分词：${message}`))
      if (!result.keywords.length && !result.errors.length) errors.push('标题分词：未返回可用关键词')

      if (config.keywordSources.includes(4)) {
        sourceData.pullDownKws = await fetchDropdownKeywords(
          platformSession,
          sourceData.titleKws,
          requestJson
        )
        if (!sourceData.pullDownKws.length) errors.push('下拉关键词：未返回可用关键词')
      }
    }

    if (config.keywordSources.includes(2)) {
      const reportProductKeywordProgress = (progress) => onProgress({
        ...progress,
        unitIndex: index + 1,
        totalUnits: structure.units.length,
        unitName: unit.unitName
      })
      const result = await fetchProductKeywords(
        platformSession,
        unit,
        titleTagKeywords,
        config,
        requestJson,
        delay,
        reportProductKeywordProgress
      )
      sourceData.productKws = result.keywords
      errors.push(...result.errors.map((message) => `商品推词：${message}`))
      if (!result.keywords.length && !result.errors.length) errors.push('商品推词：未返回可用关键词')
    }

    const unitKws = assembleUnitKeywords(sourceData, config, structure.summary.keywordPerUnit)
    if (!unitKws.length) errors.push('单元关键词：组装结果为空')
    preparedUnits.push({
      ...unit,
      ...sourceData,
      titleTagKeywords,
      businessWisdomUsedCidLevel,
      unitKws,
      keywordErrors: errors
    })

    onProgress({
      phase: 'keyword_unit_complete',
      unitIndex: index + 1,
      totalUnits: structure.units.length,
      unitName: unit.unitName,
      keywordCount: unitKws.length,
      errorCount: errors.length
    })
    if (index < structure.units.length - 1) await delay(2000)
  }

  for (let index = 0; index < preparedUnits.length; index += 1) {
    const unit = preparedUnits[index]
    onProgress({
      phase: 'keyword_bid_start',
      unitIndex: index + 1,
      totalUnits: preparedUnits.length,
      unitName: unit.unitName
    })
    unit.keywordList = config.useMinKeywordBid
      ? await fetchKeywordMinBids(
        platformSession,
        unit.unitKws,
        config.keywordBidIncrement,
        requestJson,
        delay,
        onProgress,
        index + 1,
        preparedUnits.length,
        config.keywordMatchType
      )
      : buildFixedKeywordBidList(unit.unitKws, config.customKeywordBid, config.keywordMatchType)
  }

  const unitMap = new Map(preparedUnits.map((unit) => [unit.unitName, unit]))
  const campaigns = structure.campaigns.map((campaign) => ({
    ...campaign,
    units: campaign.units.map((unit) => unitMap.get(unit.unitName))
  }))
  const errorUnits = preparedUnits.filter((unit) => unit.keywordErrors.length)
  return {
    ...structure,
    units: preparedUnits,
    campaigns,
    keywordSummary: {
      unitCount: preparedUnits.length,
      readyUnitCount: preparedUnits.filter((unit) => unit.keywordList.length > 0).length,
      errorUnitCount: errorUnits.length,
      actualKeywordCount: preparedUnits.reduce((total, unit) => total + unit.unitKws.length, 0)
    }
  }
}

module.exports = {
  PRIVATE_BUSINESS_KEYWORDS_URL,
  PRIVATE_TITLE_KEYWORDS_URL,
  buildFixedKeywordBidList,
  applyCustomKeywordBidLimit,
  KEYWORD_MIN_BID_URL,
  fetchDropdownKeywords,
  fetchPrivateBusinessKeywords,
  fetchProductKeywords,
  fetchTitleKeywords,
  prepareRoiKeywords
}
