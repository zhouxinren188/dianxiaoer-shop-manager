'use strict'

const LIST_BASE_URL = 'https://jzt-api.jd.com/dspad/msa/promolist/item/keyword'
const VERIFY_LIST_URLS = {
  campaign: `${LIST_BASE_URL}/campaign`,
  adgroup: `${LIST_BASE_URL}/adgroup`,
  ad: `${LIST_BASE_URL}/ad`,
  keyword: `${LIST_BASE_URL}/keyword`
}
const VERIFY_LAYER_LABELS = {
  campaign: '计划',
  adgroup: '单元',
  ad: '创意',
  keyword: '关键词'
}
const DEFAULT_PAGE_SIZE = 1000
const DEFAULT_MAX_PAGES = 500

function formatDate(value) {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildVerificationListBody(layer, page = 1, pageSize = DEFAULT_PAGE_SIZE, now = Date.now()) {
  const endDate = new Date(now)
  const startDate = new Date(now)
  startDate.setDate(startDate.getDate() - 14)
  const body = {
    page,
    pageSize,
    status: '',
    filters: [],
    obys: '',
    startDay: formatDate(startDate),
    endDay: formatDate(endDate),
    orderStatusCategory: 1,
    clickOrOrderDay: 15,
    clickOrOrderCaliber: 0,
    giftFlag: 0,
    businessType: 2,
    campaignType: 2,
    putType: 3,
    marketingObjective: 1,
    marketingScenario: 1,
    targetingType: 2
  }

  if (layer === 'campaign') {
    body.customColumns = ['campaignName', 'campaignId', 'campaignType']
  } else if (layer === 'adgroup') {
    body.customColumns = ['groupName', 'groupId', 'campaignName', 'campaignId', 'campaignType']
  } else if (layer === 'ad') {
    body.creativeType = []
    body.campaignId = ''
    body.groupId = ''
    body.customColumns = ['adName', 'id', 'skuId', 'groupId', 'campaignId', 'campaignType']
  } else if (layer === 'keyword') {
    body.campaignId = null
    body.groupId = ''
    body.keywordFlag = ''
    body.nameLike = ''
    body.customColumns = ['keywordName', 'id', 'groupId', 'campaignId', 'campaignType']
  }
  return body
}

function responseMessage(payload, fallback) {
  return payload?.subMsg || payload?.message || payload?.msg || payload?.errorMessage || fallback
}

function assertListResponse(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('京东列表接口未返回数据')
  if (payload.success === false) throw new Error(responseMessage(payload, '京东列表查询失败'))
  const code = payload.code ?? payload.subCode
  if (code != null && ![0, 1, 200].includes(Number(code))) {
    throw new Error(responseMessage(payload, '京东列表查询失败'))
  }
}

function findListEnvelope(value, depth = 0, visited = new Set()) {
  if (!value || typeof value !== 'object' || depth > 5 || visited.has(value)) return null
  visited.add(value)
  if (Array.isArray(value.data) && value.paginator && typeof value.paginator === 'object') {
    return { items: value.data, paginator: value.paginator }
  }
  if (Array.isArray(value.list) && (value.paginator || value.pagination)) {
    return { items: value.list, paginator: value.paginator || value.pagination }
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== 'object' || Array.isArray(child)) continue
    const envelope = findListEnvelope(child, depth + 1, visited)
    if (envelope) return envelope
  }
  return null
}

function extractVerificationPage(payload) {
  assertListResponse(payload)
  const envelope = findListEnvelope(payload)
  if (!envelope) throw new Error('京东列表返回结构已变更')
  const total = Number(
    envelope.paginator?.items ??
    envelope.paginator?.total ??
    envelope.paginator?.totalCount
  )
  const page = Number(envelope.paginator?.page ?? envelope.paginator?.pageIndex)
  const pageSize = Number(envelope.paginator?.itemsPerPage ?? envelope.paginator?.pageSize)
  return {
    items: envelope.items,
    total: Number.isFinite(total) ? total : null,
    page: Number.isFinite(page) ? page : null,
    pageSize: Number.isFinite(pageSize) ? pageSize : null
  }
}

function normalizeId(value) {
  if (value == null || value === '') return ''
  return String(value)
}

function rowCampaignId(row) {
  return normalizeId(row?.campaignId ?? row?.campaign?.id)
}

function rowIdentity(layer, row, index) {
  if (layer === 'campaign') return rowCampaignId(row)
  if (layer === 'adgroup') {
    return normalizeId(row?.groupId ?? row?.adGroupId ?? row?.id) || `${rowCampaignId(row)}:unit:${index}`
  }
  if (layer === 'ad') {
    return normalizeId(row?.id ?? row?.adId ?? row?.creativeId) ||
      `${rowCampaignId(row)}:${normalizeId(row?.groupId ?? row?.adGroupId)}:${normalizeId(row?.skuId)}:${index}`
  }
  return normalizeId(row?.id ?? row?.keywordId) ||
    `${rowCampaignId(row)}:${normalizeId(row?.groupId ?? row?.adGroupId)}:${String(row?.keywordName || row?.Keyword || '')}:${index}`
}

function buildExpectedVerification(created = {}) {
  const campaignIds = [...new Set((created.campaigns || [])
    .map((campaign) => normalizeId(campaign?.campaignId))
    .filter(Boolean))]
  const successfulUnits = Array.isArray(created.units) ? created.units : []
  return {
    campaignIds,
    campaign: campaignIds.length,
    adgroup: successfulUnits.length,
    ad: successfulUnits.reduce((total, unit) => total + Math.max(Number(unit?.productCount) || 0, 0), 0),
    keyword: successfulUnits.reduce((total, unit) => total + Math.max(Number(unit?.keywordCount) || 0, 0), 0)
  }
}

function buildRequestOptions(body) {
  return {
    method: 'POST',
    referer: 'https://jzt.jd.com/msa/#/list/tab/plan?objective=item&scenario=normal&targetingType=keyword',
    headers: {
      origin: 'https://jzt.jd.com',
      loginmode: '0',
      siteid: '0'
    },
    body,
    timeoutMs: 30000
  }
}

async function fetchLayerCount(options = {}) {
  const {
    layer,
    expectedCount,
    campaignIds,
    platformSession,
    requestJson,
    pageSize = DEFAULT_PAGE_SIZE,
    maxPages = DEFAULT_MAX_PAGES,
    now = Date.now()
  } = options
  if (!VERIFY_LIST_URLS[layer]) throw new Error(`未知核验层级：${layer}`)
  if (!expectedCount) return 0
  const campaignIdSet = new Set((campaignIds || []).map(normalizeId).filter(Boolean))
  const matched = new Set()

  for (let page = 1; page <= maxPages; page += 1) {
    const body = buildVerificationListBody(layer, page, pageSize, now)
    const payload = await requestJson(
      platformSession,
      VERIFY_LIST_URLS[layer],
      buildRequestOptions(body)
    )
    const result = extractVerificationPage(payload)
    result.items.forEach((row, index) => {
      const campaignId = rowCampaignId(row)
      if (!campaignId || !campaignIdSet.has(campaignId)) return
      const identity = rowIdentity(layer, row, (page - 1) * pageSize + index)
      if (identity) matched.add(identity)
    })
    if (matched.size >= expectedCount) break
    if (!result.items.length) break
    const effectivePageSize = result.pageSize || pageSize
    if (result.total != null && page * effectivePageSize >= result.total) break
    if (result.total == null && result.items.length < effectivePageSize) break
  }
  return matched.size
}

async function verifyCreatedRoiCampaigns(options = {}) {
  const {
    created,
    platformSession,
    requestJson,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    initialDelayMs = 3000,
    retryDelayMs = 5000,
    maxAttempts = 3,
    onProgress = () => {}
  } = options
  if (typeof requestJson !== 'function') throw new Error('核验缺少京东请求能力')
  const expected = buildExpectedVerification(created)
  if (!expected.campaignIds.length) {
    return { success: false, status: 'unavailable', message: '创建结果未包含可核验的计划 ID' }
  }

  if (initialDelayMs > 0) await delay(initialDelayMs)
  let layersToCheck = ['campaign', 'adgroup', 'ad', 'keyword']
  const actual = { campaign: 0, adgroup: 0, ad: 0, keyword: 0 }

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      for (const layer of layersToCheck) {
        onProgress({ status: 'checking', layer, attempt, maxAttempts })
        actual[layer] = await fetchLayerCount({
          layer,
          expectedCount: expected[layer],
          campaignIds: expected.campaignIds,
          platformSession,
          requestJson
        })
      }
      layersToCheck = layersToCheck.filter((layer) => actual[layer] < expected[layer])
      if (!layersToCheck.length) {
        return { success: true, status: 'matched', expected, actual, missing: {} }
      }
      if (attempt < maxAttempts) await delay(retryDelayMs)
    }
  } catch (error) {
    return {
      success: false,
      status: 'unavailable',
      expected,
      actual,
      message: error?.message || '京准通核验暂未完成'
    }
  }

  const missing = Object.fromEntries(
    Object.keys(actual)
      .map((layer) => [layer, Math.max(expected[layer] - actual[layer], 0)])
      .filter(([, count]) => count > 0)
  )
  return { success: true, status: 'mismatch', expected, actual, missing }
}

function formatVerificationDifference(result = {}) {
  return Object.entries(result.missing || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([layer, count]) => `${VERIFY_LAYER_LABELS[layer] || layer}少 ${count} 个`)
    .join('、')
}

module.exports = {
  VERIFY_LAYER_LABELS,
  VERIFY_LIST_URLS,
  buildExpectedVerification,
  buildVerificationListBody,
  extractVerificationPage,
  fetchLayerCount,
  formatVerificationDifference,
  verifyCreatedRoiCampaigns
}
