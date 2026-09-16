'use strict'

// 浩辰一键自定义使用场景人群查询；推荐接口还会返回需要种子的模板人群。
const SCENE_CATEGORY_URL = 'https://jzt-api.jd.com/dmp/common/sencecrowdcategory/get'
const SCENE_CROWD_URL = 'https://jzt-api.jd.com/dmp/common/crowd/query'
const SCENE_CROWD_PAGE_SIZE = 40
const CROWD_MAX_PAGES = 100
const CROWD_MAX_SELECTIONS = 30
const CROWD_DEFAULT_PREMIUM = 30

function requiresCrowdSeed(item = {}) {
  return Number(item?.crowdType) === 4 || Number(item?.recommendCrowdType) === 2 || item?.requiresSeed === true
}

function assertCrowdSettings(items = []) {
  const selections = Array.isArray(items) ? items : []
  const unsupported = selections.filter(requiresCrowdSeed)
  if (unsupported.length) {
    const names = unsupported.map(item => String(item.crowdName || item.crowdId || '未知人群')).join('、')
    const error = new Error(`人群“${names}”需要配置种子，不适用于一键自定义。请取消这些旧人群，按场景类型重新选择后创建`)
    error.code = 'JD_EXPRESS_CROWD_SEED_REQUIRED'
    throw error
  }
}

function buildSceneCategoryBody() {
  return { businessType: 2, requestFrom: 0 }
}

function buildSceneCrowdBody(categoryCode, pageIndex = 1) {
  return {
    adGroupId: null, businessType: 2, crowdName: '', firstSenceCategory: categoryCode,
    secondSenceCategory: -1, pageIndex, pageSize: SCENE_CROWD_PAGE_SIZE,
    resources: [], crowdTabType: 1, adGroupSkus: [], adShopIds: [],
    adGroupBidPrice: 0, adGroupBillingType: 0, adGroupAdType: 0,
    isFavorite: 0, cityIds: [], requestFrom: 0
  }
}

function buildSceneCrowdSignature(body) {
  const keys = ['adGroupAdType', 'adGroupBidPrice', 'adGroupBillingType', 'businessType',
    'crowdName', 'crowdTabType', 'encryptSignApiAppId', 'firstSenceCategory',
    'isFavorite', 'pageIndex', 'pageSize', 'secondSenceCategory']
  const fields = body.firstSenceCategory === undefined
    ? ['businessType', 'encryptSignApiAppId'] : keys
  const values = { ...body, encryptSignApiAppId: 'encryptSignApiAppId' }
  return {
    appId: '8765b',
    text: fields.map(key => `${key}:${values[key]}`).join('&'),
    stk: encodeURIComponent(fields.join(','))
  }
}

function extractSceneCategories(payload = {}) {
  if (!Array.isArray(payload.data)) throw new Error('京东场景人群分类响应格式异常')
  const seen = new Set()
  return payload.data.filter(item => {
    const key = crowdKey(item?.categoryCode)
    if (Number(item?.level) !== 0 || !key || seen.has(key)) return false
    seen.add(key)
    return true
  }).map(item => ({ categoryCode: item.categoryCode, categoryName: String(item.categoryName || item.categoryCode) }))
}

function extractSceneCrowdPage(payload = {}) {
  const data = payload.data
  if (!Array.isArray(data?.data)) throw new Error('京东场景人群列表响应格式异常')
  const value = data.total ?? data.totalCount ?? data.paginator?.items
  const total = value == null ? null : Number(value)
  return { crowds: data.data, total: Number.isFinite(total) && total >= 0 ? total : null }
}

function defaultSceneCrowds() {
  return [
    { crowdId: 100, crowdName: '默认购买人群', senceSecondCategory: '默认购买人群' },
    { crowdId: 101, crowdName: '默认浏览人群', senceSecondCategory: '默认浏览人群' }
  ].map(item => ({ ...item, crowdType: 1, crowdTabType: 3, recommendCrowdType: 0,
    senceFirstCategory: '默认推荐人群', adGroupPrice: CROWD_DEFAULT_PREMIUM, isUsed: 1 }))
}

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
  if (value == null || value === '') return fallback
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
  if (source) {
    result.source = source
    if (item.sceneCategoryName) result.sceneCategoryName = String(item.sceneCategoryName)
  }
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

function mergeCrowdOptions(defaults = [], scenes = []) {
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
  append(defaults, 'default')
  append(scenes, 'scene')
  return result.sort((left, right) => {
    const leftId = crowdKey(left.crowdId)
    const rightId = crowdKey(right.crowdId)
    const leftPriority = leftId === '100' ? 0 : leftId === '101' ? 1 : 2
    const rightPriority = rightId === '100' ? 0 : rightId === '101' ? 1 : 2
    return leftPriority - rightPriority || String(left.crowdName).localeCompare(String(right.crowdName), 'zh-CN')
  })
}

module.exports = {
  SCENE_CATEGORY_URL,
  SCENE_CROWD_URL,
  SCENE_CROWD_PAGE_SIZE,
  assertCrowdSettings,
  buildSceneCategoryBody,
  buildSceneCrowdBody,
  buildSceneCrowdSignature,
  defaultSceneCrowds,
  extractSceneCategories,
  extractSceneCrowdPage,
  requiresCrowdSeed,
  CROWD_DEFAULT_PREMIUM,
  CROWD_MAX_PAGES,
  CROWD_MAX_SELECTIONS,
  crowdKey,
  mergeCrowdOptions,
  normalizeCrowd,
  normalizeCrowdPremium,
  normalizeCrowdSettings
}
