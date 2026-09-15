'use strict'

const RECOMMENDED_CROWD_URL = 'https://jzt-api.jd.com/common/dmp/recommend/crowdsandseeds'
const DMP_CROWD_URL = 'https://jzt-api.jd.com/common/dmp/searchcrowdlist'
const CROWD_PAGE_SIZE = 100
const CROWD_MAX_PAGES = 100
const CROWD_MAX_SELECTIONS = 30
const CROWD_DEFAULT_PREMIUM = 10

const SUBMISSION_FIELDS = Object.freeze([
  'id',
  'crowdId',
  'crowdName',
  'crowdType',
  'crowdGroupRefPk',
  'crowdNum',
  'crowdTypeLable',
  'senceFirstCategory',
  'senceSecondCategory',
  'estimateUv',
  'estimatePv',
  'senceCrowdDesc',
  'additionDesc',
  'crowdTabType',
  'crowdIcon',
  'isNewTagCompose',
  'tagSource',
  'crowdSubType',
  'sourceTypeCode',
  'displayTypeCode',
  'recommendCrowdType',
  'childCrowds',
  'uv',
  'pv',
  'curPrice',
  'crowdValidStatus',
  'intelligenceCrowdType',
  'expiredTime',
  'remainTime',
  'globalUv',
  'userProfileInfos',
  'crowdKeyWordDesc',
  'tagComposeType',
  'createTime',
  'UserGroupName',
  'crowdLogoType',
  'crowdPriceCoef',
  'targetingType',
  'endPrice'
])

function crowdKey(value) {
  return String(value ?? '').trim()
}

function normalizeCrowdPremium(value, fallback = CROWD_DEFAULT_PREMIUM) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.round(number), 10), 300)
}

function normalizeCrowd(item = {}, source = '') {
  const crowdId = item?.crowdId ?? item?.id
  if (!crowdKey(crowdId)) return null
  const result = {}
  for (const field of SUBMISSION_FIELDS) {
    if (item[field] !== undefined) result[field] = item[field]
  }
  result.crowdId = crowdId
  result.crowdName = String(item?.crowdName || item?.UserGroupName || `人群 ${crowdId}`).trim()
  result.adGroupPrice = normalizeCrowdPremium(item?.adGroupPrice)
  result.isUsed = 1
  if (source) result.source = source
  return result
}

function normalizeCrowdSettings(items = []) {
  const result = []
  const seen = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeCrowd(item)
    if (!normalized) continue
    const key = crowdKey(normalized.crowdId)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
    if (result.length >= CROWD_MAX_SELECTIONS) break
  }
  return result
}

function extractRecommendedCrowds(payload = {}) {
  const data = payload?.data ?? payload
  const list = data?.recommendCrowds ?? data?.crowds ?? data?.datas ?? data?.list
  return Array.isArray(list) ? list : []
}

function extractDmpCrowdPage(payload = {}) {
  const data = payload?.data ?? payload
  const list = data?.datas ?? data?.list ?? data?.rows ?? data?.result
  const totalValue = data?.paginator?.items ?? data?.paginator?.totalCount ?? data?.total ?? data?.totalCount
  const total = Number(totalValue)
  return {
    crowds: Array.isArray(list) ? list : [],
    total: Number.isFinite(total) && total >= 0 ? total : null
  }
}

function mergeCrowdOptions(recommended = [], dmp = []) {
  const result = []
  const positions = new Map()
  const append = (items, source) => {
    for (const item of items) {
      const normalized = normalizeCrowd(item, source)
      if (!normalized) continue
      const key = crowdKey(normalized.crowdId)
      if (positions.has(key)) {
        const index = positions.get(key)
        result[index] = { ...result[index], ...normalized, source: result[index].source || source }
        continue
      }
      positions.set(key, result.length)
      result.push(normalized)
    }
  }
  append(recommended, 'recommended')
  append(dmp, 'dmp')
  return result.sort((left, right) => {
    const leftId = crowdKey(left.crowdId)
    const rightId = crowdKey(right.crowdId)
    const leftPriority = leftId === '100' ? 0 : leftId === '101' ? 1 : left.source === 'recommended' ? 2 : 3
    const rightPriority = rightId === '100' ? 0 : rightId === '101' ? 1 : right.source === 'recommended' ? 2 : 3
    return leftPriority - rightPriority || String(left.crowdName).localeCompare(String(right.crowdName), 'zh-CN')
  })
}

function buildRecommendedCrowdBody() {
  return {
    adGroupId: null,
    businessType: 2,
    requestFrom: 0
  }
}

function buildDmpCrowdBody(page = 1, pageSize = CROWD_PAGE_SIZE) {
  return {
    adGroupId: null,
    businessType: 2,
    crowdName: null,
    packageIds: null,
    page,
    pageSize,
    type: 1,
    groupId: null,
    requestFrom: 0
  }
}

module.exports = {
  CROWD_DEFAULT_PREMIUM,
  CROWD_MAX_PAGES,
  CROWD_MAX_SELECTIONS,
  CROWD_PAGE_SIZE,
  DMP_CROWD_URL,
  RECOMMENDED_CROWD_URL,
  buildDmpCrowdBody,
  buildRecommendedCrowdBody,
  crowdKey,
  extractDmpCrowdPage,
  extractRecommendedCrowds,
  mergeCrowdOptions,
  normalizeCrowd,
  normalizeCrowdPremium,
  normalizeCrowdSettings
}
