'use strict'

const { normalizeCrowdSettings, assertCrowdSettings } = require('./jd-express-crowds')

const JD_EXPRESS_READ_POLICY = Object.freeze({
  pageSize: 100,
  initialDelayMs: 1000,
  batchIntervalMs: 4000,
  rateLimitWaitMs: 60000,
  rateLimitRetries: 1
})

function normalizePositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

function normalizeStoreId(value) {
  const storeId = Number.parseInt(value, 10)
  if (!Number.isFinite(storeId) || storeId <= 0) {
    throw new Error('请选择有效的京东店铺')
  }
  return storeId
}

function buildProductQuery(payload = {}) {
  const minPrice = payload.minPrice === '' || payload.minPrice == null ? '' : Number(payload.minPrice)
  const maxPrice = payload.maxPrice === '' || payload.maxPrice == null ? '' : Number(payload.maxPrice)

  if (minPrice !== '' && (!Number.isFinite(minPrice) || minPrice < 0)) {
    throw new Error('最低价格格式不正确')
  }
  if (maxPrice !== '' && (!Number.isFinite(maxPrice) || maxPrice < 0)) {
    throw new Error('最高价格格式不正确')
  }
  if (minPrice !== '' && maxPrice !== '' && minPrice > maxPrice) {
    throw new Error('最低价格不能大于最高价格')
  }

  return {
    category: [],
    colType: -1,
    columns: ['jdPrice', 'stockNum', 'onlineTime'],
    filterByVenderCode: false,
    itemNum: '',
    locType: -1,
    minJdPrice: minPrice === '' ? '' : String(minPrice),
    maxJdPrice: maxPrice === '' ? '' : String(maxPrice),
    maxStockNum: '',
    minStockNum: '',
    name: String(payload.keyword || '').trim(),
    pageNo: normalizePositiveInteger(payload.pageNo, 1),
    pageSize: normalizePositiveInteger(payload.pageSize, 20, 100),
    skuIdList: [],
    spuIdList: [],
    startOnlineTime: payload.startOnlineTime || '',
    endOnlineTime: payload.endOnlineTime || '',
    status: 1,
    tyingType: 0,
    xnztType: 0,
    xpType: -1
  }
}

function extractSpuList(response) {
  const data = response?.data ?? response
  const candidates = [
    data?.dataList,
    data?.list,
    data?.result,
    data?.data,
    data?.spuList,
    data?.rows
  ]
  return candidates.find(Array.isArray) || []
}

function extractTotal(response, fallback = 0) {
  const data = response?.data ?? response
  const value = data?.total ?? data?.totalCount ?? data?.count ?? data?.recordsTotal
  const total = Number(value)
  return Number.isFinite(total) ? total : fallback
}

function selectLowestPricedSkuIds(groups = []) {
  const skuIds = []
  const selectedSkus = []
  const skuSpuMappings = []
  const invalidSpuIds = []
  const entries = Array.isArray(groups)
    ? groups.map((group) => [group?.spuId ?? group?.wareId ?? group?.id, group])
    : Object.entries(groups || {})

  for (const [entrySpuId, group] of entries) {
    const spuId = group?.spuId ?? group?.wareId ?? group?.id ?? entrySpuId
    const skus = Array.isArray(group)
      ? group
      : Array.isArray(group?.skuList)
      ? group.skuList
      : Array.isArray(group?.skuInfoList)
        ? group.skuInfoList
        : Array.isArray(group?.children)
          ? group.children
          : []

    const candidates = skus
      .map((sku) => ({
        id: sku?.skuId ?? sku?.id ?? sku?.itemId,
        price: Number(sku?.jdPrice ?? sku?.price ?? sku?.salePrice),
        raw: sku
      }))
      .filter((sku) => sku.id != null && Number.isFinite(sku.price))
      .sort((a, b) => a.price - b.price)

    for (const sku of skus) {
      const candidateSkuId = sku?.skuId ?? sku?.id ?? sku?.itemId
      const candidateSpuId = sku?.spuId ?? sku?.wareId ?? sku?.productId ?? spuId
      if (candidateSkuId != null && candidateSpuId != null) {
        skuSpuMappings.push({ skuId: String(candidateSkuId), spuId: String(candidateSpuId) })
      }
    }

    if (candidates.length) {
      const selected = candidates[0]
      const selectedSpuId = selected.raw?.spuId ?? selected.raw?.wareId ?? selected.raw?.productId ?? spuId
      skuIds.push(String(selected.id))
      selectedSkus.push({ ...selected.raw, skuId: String(selected.id), spuId: String(selectedSpuId ?? '') })
    }
    else if (spuId != null) invalidSpuIds.push(String(spuId))
  }

  const uniqueSelectedSkus = Array.from(new Map(selectedSkus.map((item) => [String(item.skuId), item])).values())
  const uniqueMappings = Array.from(new Map(skuSpuMappings.map((item) => [`${item.skuId}:${item.spuId}`, item])).values())
  return { skuIds: [...new Set(skuIds)], selectedSkus: uniqueSelectedSkus, skuSpuMappings: uniqueMappings, invalidSpuIds }
}

function normalizeImageUrl(value) {
  const url = String(value || '').trim()
  if (!url) return ''
  if (url.startsWith('//')) return `https:${url}`
  if (/^https?:\/\//i.test(url)) return url
  return `https://img10.360buyimg.com/n1/${url.replace(/^\/+/, '')}`
}

function normalizeAreaTree(data = [], parentPath = '0') {
  if (!Array.isArray(data)) return []
  return data.map((item, index) => {
    const nodePath = `${parentPath}-${index}`
    const children = normalizeAreaTree(item?.children, nodePath)
    const rawId = String(item?.id ?? '').trim()
    return {
      ...item,
      id: rawId || nodePath,
      name: String(item?.name || item?.label || '未命名区域'),
      children: children.length ? children : null
    }
  })
}

function readOptionalNumber(...values) {
  for (const value of values) {
    if (value === '' || value === null || value === undefined) continue
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return null
}

function normalizeSkuDetails(data, fallbackSkus = []) {
  const source = data?.data ?? data
  const list = Array.isArray(source?.skuDetails)
    ? source.skuDetails
    : Array.isArray(source)
    ? source
    : Array.isArray(source?.list)
      ? source.list
      : Array.isArray(source?.result)
        ? source.result
        : []

  const fallbackList = fallbackSkus.map((item) => typeof item === 'object' ? item : { skuId: item })
  const fallbackMap = new Map(fallbackList.map((item) => [String(item?.skuId ?? item?.id ?? ''), item]))
  const normalized = list.map((item) => {
    const skuId = String(item?.skuId ?? item?.id ?? '')
    const fallback = fallbackMap.get(skuId) || {}
    return {
      skuId,
      spuId: String(item?.spuId ?? item?.wareId ?? fallback?.spuId ?? fallback?.wareId ?? ''),
      name: item?.skuName ?? item?.name ?? item?.wareName ?? fallback?.skuName ?? fallback?.name ?? '',
      image: normalizeImageUrl(item?.imgUrl ?? item?.imageUrl ?? item?.image ?? fallback?.imgUrl ?? fallback?.imageUrl),
      price: readOptionalNumber(item?.jdPrice, item?.price, item?.salePrice, fallback?.jdPrice, fallback?.price, fallback?.salePrice),
      stock: readOptionalNumber(item?.stockNum, item?.stock, item?.wareStockNum, fallback?.stockNum, fallback?.stock, fallback?.wareStockNum),
      categoryId: String(item?.cid3 ?? item?.categoryId ?? item?.category3 ?? fallback?.cid3 ?? fallback?.categoryId ?? ''),
      categoryName: item?.categoryName ?? item?.category3Name ?? fallback?.categoryName ?? fallback?.category3Name ?? '',
      cid2Id: String(item?.cid2Id ?? item?.cid2 ?? item?.category2Id ?? fallback?.cid2Id ?? fallback?.cid2 ?? ''),
      cid2Name: item?.cid2Name ?? item?.category2Name ?? fallback?.cid2Name ?? fallback?.category2Name ?? '',
      raw: { ...fallback, ...item }
    }
  }).filter((item) => item.skuId)

  if (normalized.length) return normalized
  return fallbackList.map((item) => ({
    skuId: String(item?.skuId ?? item?.id ?? ''),
    spuId: String(item?.spuId ?? item?.wareId ?? ''),
    name: item?.skuName ?? item?.name ?? '',
    image: normalizeImageUrl(item?.imgUrl ?? item?.imageUrl),
    price: readOptionalNumber(item?.jdPrice, item?.price, item?.salePrice),
    stock: readOptionalNumber(item?.stockNum, item?.stock, item?.wareStockNum),
    categoryId: String(item?.cid3 ?? item?.categoryId ?? ''),
    categoryName: item?.categoryName ?? item?.category3Name ?? '',
    cid2Id: String(item?.cid2Id ?? item?.cid2 ?? ''),
    cid2Name: item?.cid2Name ?? item?.category2Name ?? '',
    raw: item
  }))
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function clampDecimal(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function normalizeKeywordMatchType(value) {
  const matchType = Number(value)
  return [1, 4, 8].includes(matchType) ? matchType : 8
}

function collectExistingPromotionIds(rows = []) {
  const skuIds = new Set()
  const spuIds = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const skuId = String(row?.skuId ?? row?.sku?.id ?? '').trim()
    const spuId = String(row?.spuId ?? row?.wareId ?? row?.productId ?? '').trim()
    if (skuId) skuIds.add(skuId)
    if (spuId) spuIds.add(spuId)
  }
  return { skuIds: [...skuIds], spuIds: [...spuIds] }
}

function filterExistingPromotionProducts(products = [], existing = {}, mode = 'sku') {
  const source = Array.isArray(products) ? products : []
  const filterMode = mode === 'spu' ? 'spu' : 'sku'
  const existingSkuIds = new Set((existing.skuIds || []).map((value) => String(value)).filter(Boolean))
  const existingSpuIds = new Set((existing.spuIds || []).map((value) => String(value)).filter(Boolean))

  // 部分京准通返回只带 SKU。若该 SKU 正好在本批商品内，补出其 SPU，
  // 保证“按 SPU 过滤”不会因为返回字段缺失而漏掉同款商品。
  if (filterMode === 'spu') {
    for (const product of source) {
      const skuId = String(product?.skuId ?? '').trim()
      const spuId = String(product?.spuId ?? '').trim()
      if (skuId && spuId && existingSkuIds.has(skuId)) existingSpuIds.add(spuId)
    }
  }

  const filteredIds = []
  const keptProducts = source.filter((product) => {
    const skuId = String(product?.skuId ?? '').trim()
    const spuId = String(product?.spuId ?? '').trim()
    const matched = filterMode === 'spu'
      ? Boolean(spuId && existingSpuIds.has(spuId))
      : Boolean(skuId && existingSkuIds.has(skuId))
    if (matched && skuId) filteredIds.push(skuId)
    return !matched
  })
  return {
    products: keptProducts,
    filteredIds,
    mode: filterMode
  }
}

function formatPlanDate(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-')
}

function isValidPlanDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    formatPlanDate(new Date(`${value}T00:00:00`)) === value
}

function assertCreationDates(config = {}, now = new Date()) {
  const today = formatPlanDate(now)
  const startDate = config.startDate == null || config.startDate === '' ? today : config.startDate
  let message = ''
  if (!isValidPlanDate(startDate)) message = '请选择有效的开始日期'
  else if (startDate < today) message = '开始日期不能早于今天，请选择今天或未来日期'
  else if (config.unlimitedEndDate === false) {
    if (!isValidPlanDate(config.endDate)) message = '请选择有效的结束日期'
    else if (config.endDate < startDate) message = '结束日期不能早于开始日期'
  }
  if (message) {
    const error = new Error(message)
    error.code = 'JD_EXPRESS_DATE_INVALID'
    error.creationStage = 'date_validation'
    throw error
  }
  return startDate
}

const CREATION_DATE_FIELDS = Object.freeze(['startDate', 'endDate', 'unlimitedEndDate'])

function withPreparedCreationDates(prepared, dates = {}) {
  const config = { ...prepared.config }
  // 日期不参与关键词准备；只能覆盖日期，不能借恢复令牌更改出价或商品。
  for (const field of CREATION_DATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(dates, field)) config[field] = dates[field]
  }
  config.startDate = assertCreationDates(config)
  return { ...prepared, config }
}

function assertPreparedInputsMatch(prepared, payload = {}) {
  const configSignature = (input) => {
    const normalized = normalizeRoiConfig(input)
    for (const field of CREATION_DATE_FIELDS) delete normalized[field]
    return JSON.stringify(normalized)
  }
  const skuSignature = (products) => JSON.stringify([...new Set(products
    .map((product) => String(product?.skuId || '').trim()).filter(Boolean))].sort())
  const mode = prepared.config?.createMode === 'custom' ? 'custom' : 'roi'
  const mismatch = (payload.createMode != null && payload.createMode !== mode) ||
    (payload.config && configSignature({ ...prepared.config, ...payload.config }) !== configSignature(prepared.config)) ||
    (Array.isArray(payload.products) && skuSignature(payload.products) !== skuSignature(prepared.products || []))
  if (mismatch) {
    const error = new Error('已准备的关键词与当前商品或投放配置不匹配，请重新准备')
    error.code = 'JD_EXPRESS_PREPARATION_MISMATCH'
    error.creationStage = 'preparation_validation'
    throw error
  }
}

function normalizeRoiConfig(input = {}) {
  const createMode = input.createMode === 'custom' ? 'custom' : 'roi'
  if (createMode === 'custom') assertCrowdSettings(input.dmpCrowdSettings)
  const bidType = [1, 2, 3, 4].includes(Number(input.bidType)) ? Number(input.bidType) : 3
  const adjustDirection = [-1, 0, 1].includes(Number(input.adjustDirection))
    ? Number(input.adjustDirection)
    : 0
  const planGroupMode = input.planGroupMode === 'quantity' ? 'quantity' : 'category'
  const unlimitedBudget = input.unlimitedBudget !== false
  const unlimitedEndDate = input.unlimitedEndDate !== false
  const keywordSources = [...new Set((Array.isArray(input.keywordSources) ? input.keywordSources : [])
    .map((value) => Number(value))
    .filter((value) => [1, 2, 3, 4].includes(value)))]
  if (!keywordSources.includes(3)) {
    const dropdownIndex = keywordSources.indexOf(4)
    if (dropdownIndex >= 0) keywordSources.splice(dropdownIndex, 1)
  }
  const areaType = Number(input.areaType) === 2 ? 2 : 1
  const areaIds = areaType === 2 && Array.isArray(input.areaIds)
    ? [...new Set(input.areaIds.map((value) => String(value)).filter(Boolean))]
    : []
  const hasKeywordTotalUsage = input.keywordTotalUsage !== '' && input.keywordTotalUsage != null
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.startDate || ''))
    ? String(input.startDate)
    : formatPlanDate()

  return {
    namePrefix: String(input.namePrefix || '店小二_ROI').trim().slice(0, 20),
    createMode,
    skuPerUnit: clampInteger(input.skuPerUnit, 1, 100, 50),
    unitsPerCampaign: clampInteger(input.unitsPerCampaign, 1, 100, 100),
    keywordsPerUnit: clampInteger(input.keywordsPerUnit, 1, 200, 10),
    keywordTotalUsage: hasKeywordTotalUsage
      ? clampInteger(input.keywordTotalUsage, 1, Number.MAX_SAFE_INTEGER, 1)
      : null,
    keywordBidIncrement: clampDecimal(input.keywordBidIncrement, 0, 100, 0),
    customKeywordBid: clampDecimal(input.customKeywordBid, 0.1, 9999, 0.1),
    maxCustomKeywordBid: input.maxCustomKeywordBid == null || input.maxCustomKeywordBid === ''
      ? null : Number(input.maxCustomKeywordBid),
    useMinKeywordBid: input.useMinKeywordBid !== false,
    keywordMatchType: normalizeKeywordMatchType(input.keywordMatchType),
    keywordSources,
    keywordSortType: clampInteger(input.keywordSortType, 1, 7, 4),
    businessWisdomPercent: clampInteger(input.businessWisdomPercent, 0, 100, 0),
    productPercent: clampInteger(input.productPercent, 0, 100, 0),
    titlePercent: clampInteger(input.titlePercent, 0, 100, 0),
    pullDownPercent: clampInteger(input.pullDownPercent, 0, 100, 0),
    supplementKeywords: input.supplementKeywords !== false,
    planGroupMode,
    unitGroupMode: 'category3',
    planMode: 1,
    biddingTarget: createMode === 'custom' ? 1 : 16,
    automatedBiddingType: createMode === 'custom'
      ? (Number(input.automatedBiddingType) === 0 ? 0 : 32768)
      : 8192,
    orientationRangeOption: createMode === 'custom' && Array.isArray(input.orientationRangeOption) && input.orientationRangeOption.map(Number).includes(2)
      ? [1, 2]
      : [1],
    premiumType: createMode === 'custom' ? 2 : ([1, 2].includes(Number(input.premiumType)) ? Number(input.premiumType) : 2),
    premiumCoef: clampInteger(input.premiumCoef, 30, 300, 30),
    inSearchFee: clampDecimal(input.inSearchFee, 0.1, 9999, 0.1),
    dmpCrowdSettings: createMode === 'custom' ? normalizeCrowdSettings(input.dmpCrowdSettings) : [],
    areaType,
    areaIds,
    bidType,
    adjustDirection,
    adjustRatio: clampInteger(input.adjustRatio, 0, 100, 0),
    bottomLimit: clampDecimal(input.bottomLimit, 0.1, 1000, 3),
    customRoi: clampDecimal(input.customRoi, 0.1, 1000, 3),
    capCustomRoi: input.capCustomRoi === true,
    unlimitedBudget,
    dailyBudget: unlimitedBudget ? null : clampInteger(input.dailyBudget, 50, 999999, 50),
    startDate,
    unlimitedEndDate,
    endDate: unlimitedEndDate ? null : String(input.endDate || '')
  }
}

function assertCustomKeywordBidConfig(config = {}) {
  if (config.createMode !== 'custom' || config.useMinKeywordBid !== false) return
  const base = Number(config.customKeywordBid)
  const maximum = Number(config.maxCustomKeywordBid)
  if (!Number.isFinite(base) || base < 0.1 || base > 9999 ||
      !Number.isFinite(maximum) || maximum < 0.1 || maximum > 9999 ||
      Math.abs(maximum * 10 - Math.round(maximum * 10)) > 1e-8 || maximum < base) {
    const error = new Error('请设置关键词最高出价（0.1～9999 元，保留一位小数），且不能低于起始出价')
    error.code = 'JD_EXPRESS_KEYWORD_BID_INVALID'
    error.creationStage = 'preparation_validation'
    throw error
  }
}

function chunkList(list, size) {
  const chunks = []
  for (let index = 0; index < list.length; index += size) chunks.push(list.slice(index, index + size))
  return chunks
}

function cleanName(value, fallback) {
  return String(value || fallback || '未分类').replace(/[\r\n\t]+/g, ' ').trim() || fallback || '未分类'
}

function buildRoiPlanStructure(products = [], inputConfig = {}) {
  const config = normalizeRoiConfig(inputConfig)
  const uniqueProducts = []
  const seenSkuIds = new Set()
  for (const product of products) {
    const skuId = String(product?.skuId || '').trim()
    if (!skuId || seenSkuIds.has(skuId)) continue
    seenSkuIds.add(skuId)
    uniqueProducts.push({ ...product, skuId })
  }

  const categoryGroups = new Map()
  for (const product of uniqueProducts) {
    const categoryId = String(product.categoryId || product.raw?.categoryId || product.raw?.cid3 || 'uncategorized')
    const categoryName = cleanName(product.categoryName || product.raw?.categoryName, categoryId === 'uncategorized' ? '未分类' : categoryId)
    if (!categoryGroups.has(categoryId)) categoryGroups.set(categoryId, { categoryId, categoryName, products: [] })
    categoryGroups.get(categoryId).products.push(product)
  }

  const units = []
  for (const category of categoryGroups.values()) {
    const productChunks = chunkList(category.products, config.skuPerUnit)
    productChunks.forEach((unitProducts, index) => {
      const first = unitProducts[0] || {}
      const cid2Id = String(first.cid2Id || first.raw?.cid2Id || first.raw?.cid2 || category.categoryId)
      const cid2Name = cleanName(first.cid2Name || first.raw?.cid2Name, category.categoryName)
      units.push({
        unitName: `${category.categoryName}(${index + 1})_${units.length + 1}`,
        categoryId: category.categoryId,
        categoryName: category.categoryName,
        cid2Id,
        cid2Name,
        products: unitProducts
      })
    })
  }

  const campaigns = []
  if (config.planGroupMode === 'quantity') {
    chunkList(units, config.unitsPerCampaign).forEach((campaignUnits, index) => {
      campaigns.push({
        planName: `${config.namePrefix}_${index + 1}`,
        categoryName: '按数量',
        units: campaignUnits
      })
    })
  } else {
    const secondCategoryGroups = new Map()
    for (const unit of units) {
      if (!secondCategoryGroups.has(unit.cid2Id)) {
        secondCategoryGroups.set(unit.cid2Id, { cid2Name: unit.cid2Name, units: [] })
      }
      secondCategoryGroups.get(unit.cid2Id).units.push(unit)
    }
    for (const group of secondCategoryGroups.values()) {
      chunkList(group.units, config.unitsPerCampaign).forEach((campaignUnits, index) => {
        campaigns.push({
          planName: `${config.namePrefix}_${group.cid2Name}_(${index + 1})_${campaigns.length + 1}`,
          cid2Id: campaignUnits[0]?.cid2Id,
          cid2Name: group.cid2Name,
          categoryName: group.cid2Name,
          units: campaignUnits
        })
      })
    }
  }

  const keywordPerUnit = units.length
    ? config.keywordTotalUsage == null
      ? config.keywordsPerUnit
      : Math.min(Math.floor(config.keywordTotalUsage / units.length), 200)
    : 0

  return {
    config,
    products: uniqueProducts,
    units,
    campaigns,
    summary: {
      productCount: uniqueProducts.length,
      campaignCount: campaigns.length,
      unitCount: units.length,
      creativeCount: uniqueProducts.length,
      keywordPerUnit,
      keywordCount: units.length * keywordPerUnit
    }
  }
}

function buildScopedRoiPlanStructure(products = [], inputConfig = {}, scope = 'full') {
  const fullStructure = buildRoiPlanStructure(products, inputConfig)
  if (scope === 'full') return fullStructure

  // A single-product smoke test must use the per-unit allocation calculated for
  // the complete preview. Recalculating the total quota against one unit would
  // inflate that unit to the 200-keyword platform cap.
  return buildRoiPlanStructure(products.slice(0, 1), {
    ...inputConfig,
    keywordTotalUsage: fullStructure.summary.keywordPerUnit
  })
}

function adjustRoiBid(value, adjustRatio, adjustDirection, bottomLimit, topLimit) {
  const base = Number(value)
  if (!Number.isFinite(base)) throw new Error('京东未返回有效的建议 ROI')
  const direction = Number(adjustDirection)
  const ratio = Number(adjustRatio) || 0
  const adjusted = Math.round((base + (direction > 0 ? 1 : direction < 0 ? -1 : 0) * base * ratio / 100) * 10) / 10
  const bottom = Number.isFinite(Number(bottomLimit)) ? Number(bottomLimit) : 0.1
  const top = Number.isFinite(Number(topLimit)) ? Number(topLimit) : Number.POSITIVE_INFINITY
  return Math.max(bottom, Math.min(top, adjusted))
}

const TITLE_KEYWORD_TAGS = Object.freeze(['品类', '品类修饰词', '型号', '修饰'])

function normalizeKeyword(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function isUsableKeyword(value) {
  const keyword = normalizeKeyword(value)
  return Boolean(keyword) && !keyword.includes('京东') && !keyword.includes('自营')
}

function buildTitleKeywordResult(rows = []) {
  const keywordCountMap = new Map()
  for (const item of Array.isArray(rows) ? rows : []) {
    const word = normalizeKeyword(item?.word)
    const tag = String(item?.tag || '')
    if (word.length <= 1 || !TITLE_KEYWORD_TAGS.includes(tag)) continue
    const current = keywordCountMap.get(word)
    keywordCountMap.set(word, {
      count: (current?.count || 0) + 1,
      tag: current?.tag || tag
    })
  }

  const grouped = Object.fromEntries(TITLE_KEYWORD_TAGS.map((tag) => [tag, []]))
  for (const [word, value] of keywordCountMap.entries()) {
    grouped[value.tag].push({ word, count: value.count })
  }
  for (const tag of TITLE_KEYWORD_TAGS) grouped[tag].sort((a, b) => b.count - a.count)

  const selected = new Set()
  const tagKeywords = []
  for (const tag of TITLE_KEYWORD_TAGS) {
    const match = grouped[tag].find((item) => !selected.has(item.word))
    if (!match) continue
    selected.add(match.word)
    tagKeywords.push(match.word)
  }

  let keywords
  if (grouped['品类修饰词'].length) {
    keywords = []
    for (const modifier of grouped['品类修饰词']) {
      for (const category of grouped['品类']) {
        keywords.push(`${modifier.word}${category.word}`)
        if (keywords.length >= 200) break
      }
      if (keywords.length >= 200) break
    }
  } else {
    keywords = Array.from(keywordCountMap.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .map(([word]) => word)
  }

  return {
    // 原工具的标题分词结果不在最终组装前再次过滤“京东/自营”，
    // 仅做空值和重复值清理，保持提交词集合一致。
    keywords: [...new Set(keywords.map(normalizeKeyword).filter(Boolean))].slice(0, 200),
    tagKeywords
  }
}

function sortBusinessWisdomRows(rows = [], sortType = 4) {
  const metricByType = {
    1: 'uv',
    2: 'clickUv',
    3: 'clickRate',
    4: 'gmvCj',
    5: 'orderNumCj',
    6: 'cvrCj',
    7: 'blueOcean'
  }
  const metric = metricByType[Number(sortType)] || 'gmvCj'
  return [...(Array.isArray(rows) ? rows : [])]
    .sort((a, b) => Number(b?.[metric] || 0) - Number(a?.[metric] || 0))
}

function extractBusinessWisdomKeywords(rows = [], sortType = 4) {
  return [...new Set(sortBusinessWisdomRows(rows, sortType)
    .map((item) => normalizeKeyword(item?.keyword))
    .filter(isUsableKeyword))]
}

function mergeProductKeywordRows(rows = []) {
  const unique = new Map()
  for (const item of Array.isArray(rows) ? rows : []) {
    const keyword = normalizeKeyword(item?.keyWord)
    if (!isUsableKeyword(keyword) || unique.has(keyword)) continue
    unique.set(keyword, { ...item, keyWord: keyword })
  }
  return Array.from(unique.values())
    .sort((a, b) => {
      const aPreferred = Number(a?.sourceType) === 4 || Number(a?.sourceType) === 64
      const bPreferred = Number(b?.sourceType) === 4 || Number(b?.sourceType) === 64
      if (aPreferred !== bPreferred) return aPreferred ? -1 : 1
      return Number(b?.pv || 0) - Number(a?.pv || 0)
    })
    .map((item) => item.keyWord)
}

function selectProductKeywordSkuIds(products = [], titleTagKeywords = [], maxCount = 4, random = Math.random) {
  const list = Array.isArray(products) ? products.filter((item) => item?.skuId) : []
  const tags = (Array.isArray(titleTagKeywords) ? titleTagKeywords : []).map(normalizeKeyword).filter(Boolean)
  if (tags.length) {
    const matched = list
      .map((item) => ({
        skuId: String(item.skuId),
        matchCount: tags.filter((tag) => String(item.name || '').includes(tag)).length
      }))
      .filter((item) => item.matchCount > 0)
      .sort((a, b) => b.matchCount - a.matchCount)
      .slice(0, maxCount)
      .map((item) => item.skuId)
    return matched
  }

  // 对齐原工具 getRandomSkuList：使用随机排序后截取最多 4 个 SKU。
  const shuffled = [...list].sort(() => 0.5 - random())
  return shuffled.slice(0, maxCount).map((item) => String(item.skuId))
}

function assembleUnitKeywords(sources = {}, inputConfig = {}, limit = 0) {
  const config = normalizeRoiConfig(inputConfig)
  const upperLimit = clampInteger(limit, 0, 200, 0)
  if (!upperLimit) return []
  const sourceEntries = [
    ['businessWisdomKws', config.businessWisdomPercent],
    ['productKws', config.productPercent],
    ['titleKws', config.titlePercent],
    ['pullDownKws', config.pullDownPercent]
  ]
  const target = []
  const seen = new Set()
  const append = (items, maxLength = Number.POSITIVE_INFINITY) => {
    if (maxLength <= 0) return
    let added = 0
    for (const value of Array.isArray(items) ? items : []) {
      const keyword = normalizeKeyword(value)
      if (!keyword || seen.has(keyword)) continue
      target.push(keyword)
      seen.add(keyword)
      added += 1
      if (added >= maxLength || target.length >= upperLimit) break
    }
  }

  for (const [key, percentage] of sourceEntries) {
    append(sources[key], Math.floor(Number(percentage || 0) / 100 * upperLimit))
  }
  if (config.supplementKeywords && target.length < upperLimit) {
    for (const [key] of sourceEntries) {
      append(sources[key])
      if (target.length >= upperLimit) break
    }
  }
  return target
}

module.exports = {
  JD_EXPRESS_READ_POLICY,
  adjustRoiBid,
  assertCreationDates,
  assertCustomKeywordBidConfig,
  assertPreparedInputsMatch,
  withPreparedCreationDates,
  assembleUnitKeywords,
  buildTitleKeywordResult,
  buildProductQuery,
  buildRoiPlanStructure,
  buildScopedRoiPlanStructure,
  collectExistingPromotionIds,
  extractBusinessWisdomKeywords,
  extractSpuList,
  extractTotal,
  isUsableKeyword,
  mergeProductKeywordRows,
  normalizeAreaTree,
  normalizeImageUrl,
  normalizeKeyword,
  normalizeKeywordMatchType,
  normalizePositiveInteger,
  normalizeRoiConfig,
  normalizeSkuDetails,
  normalizeStoreId,
  filterExistingPromotionProducts,
  formatPlanDate,
  isValidPlanDate,
  selectProductKeywordSkuIds,
  selectLowestPricedSkuIds
}
