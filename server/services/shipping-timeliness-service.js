const fs = require('fs')
const path = require('path')

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'shipping-timeliness-defaults.json')
const DEFAULT_EXTERNAL_BASELINE_PATHS = [
  path.join(__dirname, '..', 'config', 'shipping-timeliness-kdniao-shuyang.json'),
  path.join(__dirname, '..', 'config', 'shipping-timeliness-kdniao-shanghai-outbound.json')
]
const PROVINCES = [
  '北京', '天津', '上海', '重庆',
  '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西',
  '山东', '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃',
  '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门'
]
const MUNICIPALITIES = new Set(['北京', '天津', '上海', '重庆'])
const SIGNED_PATTERN = /已签收|签收成功|已妥投|投递成功|包裹已(?:从.+)?取出|取件成功|已被.+取走|已送达(?:收件人|本人|代收点|驿站|自提点)/
const PICKED_UP_PATTERN = /已揽收|已揽件|揽收成功|揽件成功|快件已被.+揽收|已收取快件|收件成功|揽投员已取件/
const ABNORMAL_PATTERN = /拒收|退回|退件|退款|拦截成功|返件/
const SIGNED_STATUS_PATTERN = /已签收|已妥投|已取件/
const PICKED_UP_STATUS_PATTERN = /已揽件|已揽收/
const ABNORMAL_STATUS_PATTERN = /退回|拒收|退款|拦截|返件/
const NETWORK_ENTRY_STATUS_PATTERN = /运输中|转运中|已发出|已发往/
const NETWORK_ENTRY_PATTERN = /(?:快件|包裹|邮件).{0,12}(?:已发往|发往|已发出|离开|到达.{0,12}(?:转运|集散|分拨|中转))|(?:转运|集散|分拨|中转)(?:中心|站).{0,12}(?:已发出|发往|运输中)/

let cachedConfig = null
let cachedAdministrativeLookup = null
let cachedExternalRouteBaselines = null

function loadTimelinessConfig(configPath = DEFAULT_CONFIG_PATH) {
  if (cachedConfig && configPath === DEFAULT_CONFIG_PATH) return cachedConfig
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (configPath === DEFAULT_CONFIG_PATH) cachedConfig = parsed
  return parsed
}

function loadExternalRouteBaselines(filePath) {
  const useDefaultFiles = !filePath
  if (cachedExternalRouteBaselines && useDefaultFiles) {
    return cachedExternalRouteBaselines
  }
  const files = useDefaultFiles ? DEFAULT_EXTERNAL_BASELINE_PATHS : [filePath]
  const routeMap = new Map()
  const parsedFiles = []
  for (const currentPath of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(currentPath, 'utf8'))
      parsedFiles.push(parsed)
      for (const route of Array.isArray(parsed?.routes) ? parsed.routes : []) {
        const cityRouteKey = [
          normalizeDivisionName(route?.originProvince),
          normalizeDivisionName(route?.originCity),
          normalizeDivisionName(route?.destinationProvince),
          normalizeDivisionName(route?.destinationCity)
        ].join('|')
        const key = cityRouteKey.replace(/\|/g, '')
          ? cityRouteKey
          : String(route?.key || '')
        routeMap.set(key, route)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[ShippingTimeliness] 读取外部线路基线失败:', error.message)
      }
    }
  }
  const generatedAt = parsedFiles
    .map(item => String(item?.generatedAt || ''))
    .filter(Boolean)
    .sort()
    .at(-1) || ''
  const normalized = {
    version: 1,
    provider: 'kdniao',
    generatedAt,
    routes: [...routeMap.values()]
  }
  if (useDefaultFiles) cachedExternalRouteBaselines = normalized
  return normalized
}

function cleanAddressText(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\)/g, ' ')
    .replace(/1\d{10}|\d{6,}/g, ' ')
    .replace(/[，,。；;：:\s]+/g, '')
    .trim()
}

function normalizeProvinceName(value) {
  const text = cleanAddressText(value)
  const prefixMatch = PROVINCES
    .filter(name => text.startsWith(name))
    .sort((left, right) => right.length - left.length)[0]
  return prefixMatch || PROVINCES.find(name => text.includes(name)) || ''
}

function normalizeRegion(value) {
  const raw = cleanAddressText(value)
  const province = normalizeProvinceName(raw)
  if (!province) return { province: '', city: '', county: '', raw }

  if (MUNICIPALITIES.has(province)) {
    const afterProvince = raw.slice(raw.indexOf(province) + province.length).replace(/^(?:市|特别行政区)/, '')
    const countyMatch = afterProvince.match(/^([\u4e00-\u9fa5]{2,8}?)(?:区|县|旗)/)
    return {
      province,
      city: province,
      county: countyMatch ? countyMatch[1] : '',
      raw
    }
  }

  let rest = raw.slice(raw.indexOf(province) + province.length)
    .replace(/^(?:省|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)/, '')
  const lookup = getAdministrativeLookup()
  const administrativeCityMatch = lookup.cityPattern?.exec(rest)
  const administrativeCityEntry = administrativeCityMatch?.index === 0
    ? lookup.cityRegions[administrativeCityMatch[0]]
    : null
  const administrativeCityRegion = regionFromAdministrativeEntry(administrativeCityEntry, raw)
  let city = administrativeCityRegion?.province === province ? administrativeCityRegion.city : ''
  if (city) {
    rest = rest.slice(administrativeCityMatch[0].length)
  } else {
    const cityMatch = rest.match(/^([\u4e00-\u9fa5]{2,10}?)(?:市|自治州|地区|盟)/)
    city = cityMatch ? cityMatch[1] : ''
    if (cityMatch) rest = rest.slice(cityMatch[0].length)
  }

  // 货源页常只返回“河北保定”这种无行政区后缀的短文本。
  if (!city && rest && rest.length <= 8) {
    city = rest.replace(/(?:市|地区|盟).*$/, '').slice(0, 6)
    rest = ''
  }

  const countyMatch = rest.match(/^([\u4e00-\u9fa5]{2,10}?)(?:区|县|旗|市)/)
  return {
    province,
    city,
    county: countyMatch ? countyMatch[1] : '',
    raw
  }
}

function normalizeDivisionName(value) {
  return String(value || '')
    .replace(/特别行政区|自治州|自治县|自治区|地区|盟$/g, '')
    .replace(/[省市区县旗]$/g, '')
    .trim()
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function administrativeAliases(name, type) {
  const result = [name]
  const stripped = type === 'city'
    ? name.replace(/(特别行政区|自治州|地区|盟|市)$/u, '')
    : name.replace(/(自治县|县|区|市|旗)$/u, '')
  if (stripped && stripped !== name && stripped.length >= 2) result.push(stripped)
  return result
}

function buildAdministrativeRegionMaps(config) {
  if (config.cityRegions && config.countyRegions) {
    return { cityRegions: config.cityRegions, countyRegions: config.countyRegions }
  }
  const cityCandidates = new Map()
  const countyCandidates = new Map()
  const addCandidate = (map, key, value) => {
    const name = String(key || '').trim()
    if (!name) return
    if (!map.has(name)) map.set(name, new Map())
    map.get(name).set(JSON.stringify(value), value)
  }
  for (const [province, cityMap] of Object.entries(config.administrativeDivisions || {})) {
    for (const [city, counties] of Object.entries(cityMap || {})) {
      for (const alias of administrativeAliases(city, 'city')) {
        addCandidate(cityCandidates, alias, [province, city])
      }
      for (const county of counties || []) {
        for (const alias of administrativeAliases(county, 'county')) {
          addCandidate(countyCandidates, alias, [province, city, county])
        }
      }
    }
  }
  const uniqueEntries = candidates => Object.fromEntries(
    [...candidates.entries()]
      .filter(([, values]) => values.size === 1)
      .map(([key, values]) => [key, [...values.values()][0]])
  )
  return {
    cityRegions: uniqueEntries(cityCandidates),
    countyRegions: uniqueEntries(countyCandidates)
  }
}

function getAdministrativeLookup() {
  if (cachedAdministrativeLookup) return cachedAdministrativeLookup
  const config = loadTimelinessConfig()
  const { cityRegions, countyRegions } = buildAdministrativeRegionMaps(config)
  const cityKeys = Object.keys(cityRegions).sort((a, b) => b.length - a.length)
  const countyKeys = Object.keys(countyRegions).sort((a, b) => b.length - a.length)
  cachedAdministrativeLookup = {
    cityRegions,
    countyRegions,
    cityPattern: cityKeys.length ? new RegExp(cityKeys.map(escapeRegExp).join('|')) : null,
    countyPattern: countyKeys.length ? new RegExp(countyKeys.map(escapeRegExp).join('|')) : null
  }
  return cachedAdministrativeLookup
}

function regionFromAdministrativeEntry(entry, raw) {
  if (!Array.isArray(entry) || entry.length < 2) return null
  return {
    province: normalizeDivisionName(entry[0]),
    city: normalizeDivisionName(entry[1]),
    county: normalizeDivisionName(entry[2]),
    raw: String(raw || '')
  }
}

function parseSourceMetadata(url) {
  try {
    const parsed = new URL(String(url || ''))
    if (!parsed.hash.startsWith('#dxeSku=')) return null
    const metadata = JSON.parse(decodeURIComponent(parsed.hash.slice('#dxeSku='.length)))
    return metadata && typeof metadata === 'object' ? metadata : null
  } catch {
    return null
  }
}

function getSourceShipFrom(url) {
  return String(parseSourceMetadata(url)?.shipFrom || '').trim()
}

function getSourceKey(url) {
  try {
    const parsed = new URL(String(url || ''))
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (hostname.includes('taobao.com') || hostname.includes('tmall.com')) {
      const metadata = parseSourceMetadata(url) || {}
      if (metadata.sellerId) return `taobao:seller:${String(metadata.sellerId).slice(0, 120)}`
      if (metadata.shopId) return `taobao:shop:${String(metadata.shopId).slice(0, 120)}`
      if (metadata.shopName) return `taobao:shop-name:${String(metadata.shopName).trim().toLowerCase().slice(0, 120)}`
      const itemId = parsed.searchParams.get('id') || parsed.searchParams.get('itemId')
      if (itemId) return `taobao:item:${itemId}`
    }
    if (hostname.includes('pinduoduo.com') || hostname.includes('yangkeduo.com') || hostname.includes('pdd.com')) {
      const goodsId = parsed.searchParams.get('goods_id') || parsed.searchParams.get('goodsId')
      if (goodsId) return `pinduoduo:goods:${goodsId}`
    }
    if (hostname.includes('1688.com')) {
      const offerId = parsed.searchParams.get('offerId') || parsed.pathname.match(/\/offer\/(\d+)/)?.[1]
      if (offerId) return `1688:offer:${offerId}`
    }
    return `${hostname}:${parsed.pathname}`.slice(0, 180)
  } catch {
    return ''
  }
}

function dateClosestToReference(referenceDate, month, day, hour, minute, second) {
  const candidates = [-1, 0, 1].map(offset => new Date(
    referenceDate.getFullYear() + offset, month - 1, day, hour, minute, second
  ))
  return candidates.sort((a, b) =>
    Math.abs(a.getTime() - referenceDate.getTime()) - Math.abs(b.getTime() - referenceDate.getTime())
  )[0]
}

function parseTrackingTime(value, referenceDate = new Date()) {
  if (value == null || value === '') return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'number') {
    const timestamp = value < 1e12 ? value * 1000 : value
    const parsed = new Date(timestamp)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  const text = String(value).trim()
  if (!text) return null
  const normalized = text
    .replace(/[年/.]/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, ' ')
    .replace(/T/, ' ')
    .replace(/\s+/g, ' ')

  let parsed = null
  const full = normalized.match(/(20\d{2})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/)
  if (full) {
    parsed = new Date(
      Number(full[1]), Number(full[2]) - 1, Number(full[3]),
      Number(full[4] || 0), Number(full[5] || 0), Number(full[6] || 0)
    )
    // 部分淘宝物流节点缺少年份，旧解析链会把它补成 2001。
    // 以采购单时间为基准选择距离最近的自然年，避免把整条路线算成二十多年前。
    if (Number(full[1]) <= 2001 && referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())) {
      parsed = dateClosestToReference(
        referenceDate, Number(full[2]), Number(full[3]),
        Number(full[4] || 0), Number(full[5] || 0), Number(full[6] || 0)
      )
    }
  } else {
    const short = normalized.match(/(?:^|\s)(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/)
    if (short) {
      parsed = dateClosestToReference(
        referenceDate, Number(short[1]), Number(short[2]),
        Number(short[3] || 0), Number(short[4] || 0), Number(short[5] || 0)
      )
    }
  }

  if (!parsed || Number.isNaN(parsed.getTime())) return null
  return parsed
}

function normalizeTrackingEntry(item) {
  if (!item || typeof item !== 'object') return { time: '', context: '', statusTag: '' }
  const time = item.time ?? item.timeStr ?? item.odate ?? item.date ?? item.timestamp ?? item.acceptTime ?? item.scanTime ?? ''
  const context = item.context ?? item.desc ?? item.description ?? item.standardDesc ?? item.standerdDesc ?? item.message ?? item.content ?? item.action ?? item.acceptAddress ?? item.scanDesc ?? ''
  const statusTag = item.status_tag ?? item.statusTag ?? item.status ?? item.state ?? ''
  return { time, context: String(context || ''), statusTag: String(statusTag || '') }
}

function normalizeTrackingEntries(tracking) {
  let items = tracking
  if (typeof items === 'string') {
    try { items = JSON.parse(items) } catch { return [] }
  }
  return Array.isArray(items) ? items.map(normalizeTrackingEntry) : []
}

function isPickupEvent(event) {
  return PICKED_UP_STATUS_PATTERN.test(event.statusTag) || PICKED_UP_PATTERN.test(event.context)
}

function isNetworkEntryEvent(event) {
  if (/等待揽收|待揽收|仓库已接单|打印完成|商品已经下单|包裹正在打包/.test(event.context)) return false
  return isPickupEvent(event) ||
    NETWORK_ENTRY_STATUS_PATTERN.test(event.statusTag) ||
    NETWORK_ENTRY_PATTERN.test(event.context)
}

function isSignedEvent(event) {
  return SIGNED_STATUS_PATTERN.test(event.statusTag) || SIGNED_PATTERN.test(event.context)
}

function isAbnormalEvent(event) {
  return ABNORMAL_STATUS_PATTERN.test(event.statusTag) || ABNORMAL_PATTERN.test(event.context)
}

function extractRegionFromTrackingContext(context) {
  const text = String(context || '').trim()
  if (!text) return { province: '', city: '', county: '', raw: '' }
  const lookup = getAdministrativeLookup()
  const bracketParts = [...text.matchAll(/[【\[]([^】\]]{2,40})[】\]]/g)].map(match => match[1])
  const candidates = [
    ...bracketParts,
    text.replace(/[【】\[\]]/g, ' ')
  ]
  let best = null
  const consider = region => {
    if (!region?.province) return
    const score = region.county ? 3 : region.city ? 2 : 1
    if (!best || score > best.score) best = { region, score }
  }
  for (const candidate of candidates) {
    const region = normalizeRegion(candidate)
    consider(region)
    const compact = String(candidate).replace(/1\d{10}|\d{4,}/g, ' ').replace(/\s+/g, '')
    const cityKey = lookup.cityPattern?.exec(compact)?.[0]
    if (cityKey) {
      consider(regionFromAdministrativeEntry(lookup.cityRegions[cityKey], candidate))
    }
    const countyKey = lookup.countyPattern?.exec(compact)?.[0]
    if (countyKey) {
      consider(regionFromAdministrativeEntry(lookup.countyRegions[countyKey], candidate))
    }
  }
  return best?.region || { province: '', city: '', county: '', raw: '' }
}

function extractTrackingRoute(tracking, referenceDate = new Date()) {
  const events = normalizeTrackingEntries(tracking)
    .map(event => ({ ...event, parsedTime: parseTrackingTime(event.time, referenceDate) }))
    .filter(event => event.parsedTime)
    .sort((a, b) => a.parsedTime.getTime() - b.parsedTime.getTime())

  const withRegion = events
    .map(event => ({ event, region: extractRegionFromTrackingContext(event.context) }))
    .filter(item => item.region.province)
  const networkEntryRegion = withRegion.find(item => isNetworkEntryEvent(item.event))
  const signedRegions = withRegion.filter(item => isSignedEvent(item.event))
  return {
    origin: networkEntryRegion?.region || withRegion[0]?.region || null,
    destination: signedRegions.at(-1)?.region || withRegion.at(-1)?.region || null
  }
}

function extractTrackingMilestones(tracking, referenceDate = new Date()) {
  const events = normalizeTrackingEntries(tracking)
  if (events.length < 2) return null
  if (events.some(isAbnormalEvent)) return null

  const networkEntries = []
  const signed = []
  for (const event of events) {
    const time = parseTrackingTime(event.time, referenceDate)
    if (!time) continue
    if (isNetworkEntryEvent(event)) networkEntries.push(time)
    if (isSignedEvent(event)) signed.push(time)
  }
  if (!networkEntries.length || !signed.length) return null

  // 部分快递轨迹缺少明确“揽收”节点，但首个“已发往/运输中”已经能证明包裹进入物流网络。
  // 字段沿用 picked_up_at 以兼容现有数据表，语义统一为“首次有效进入物流网络时间”。
  const pickedUpAt = new Date(Math.min(...networkEntries.map(item => item.getTime())))
  const signedAt = new Date(Math.max(...signed.map(item => item.getTime())))
  const transitHours = (signedAt.getTime() - pickedUpAt.getTime()) / 3600000
  if (!Number.isFinite(transitHours) || transitHours < 2 || transitHours > 24 * 15) return null
  return { pickedUpAt, signedAt, transitHours }
}

function percentile(values, ratio) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const index = (sorted.length - 1) * ratio
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

function normalizeContextDate(value) {
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function isSameDispatchContext(orderedAt, requestedAt) {
  const ordered = normalizeContextDate(orderedAt)
  const requested = normalizeContextDate(requestedAt)
  if (!ordered || !requested) return false
  const hourDistance = Math.abs(ordered.getHours() - requested.getHours())
  return Math.min(hourDistance, 24 - hourDistance) <= 2
}

function getDispatchTimeBucket(value, config = loadTimelinessConfig()) {
  const parsed = normalizeContextDate(value)
  if (!parsed) return null
  const configuredHours = Number(config.dispatchTimeBucketHours || 2)
  const bucketHours = Math.max(1, Math.min(Number.isFinite(configuredHours) ? configuredHours : 2, 6))
  const startHour = Math.floor(parsed.getHours() / bucketHours) * bucketHours
  return {
    startHour,
    endHour: Math.min(24, startHour + bucketHours),
    dayType: 'all'
  }
}

function isSameCalendarDay(left, right) {
  const first = normalizeContextDate(left)
  const second = normalizeContextDate(right)
  if (!first || !second) return false
  return first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
}

function getRegionGroup(province, config) {
  for (const [group, provinces] of Object.entries(config.regionGroups || {})) {
    if (provinces.includes(province)) return group
  }
  return ''
}

function getFallbackEstimate(origin, destination, config) {
  if (!origin.province || !destination.province) return null
  let key = 'crossRegion'
  if (origin.city && destination.city && origin.province === destination.province && origin.city === destination.city) {
    key = 'sameCity'
  } else if (origin.province === destination.province) {
    key = 'sameProvince'
  } else {
    const originGroup = getRegionGroup(origin.province, config)
    const destinationGroup = getRegionGroup(destination.province, config)
    if (originGroup && originGroup === destinationGroup) key = 'sameRegion'
    if ((config.remoteProvinces || []).includes(origin.province) || (config.remoteProvinces || []).includes(destination.province)) {
      key = 'remote'
    }
  }
  const range = config.fallbackDays?.[key]
  if (!Array.isArray(range) || range.length !== 2) return null
  const fallbackRouteP50Hours = Number(config.fallbackTransitP50Hours?.[key])
  const expectedRouteHours = Number.isFinite(fallbackRouteP50Hours)
    ? fallbackRouteP50Hours
    : ((Number(range[0]) + Number(range[1])) / 2) * 24 - Number(config.defaultDispatchHours || 24)
  const fallbackRouteP80Hours = Math.max(
    expectedRouteHours,
    Number(range[1]) * 24 - Number(config.defaultDispatchHours || 24)
  )
  return {
    minDays: Number(range[0]),
    maxDays: Number(range[1]),
    expectedHours: expectedRouteHours + Number(config.defaultDispatchHours || 24),
    fallbackRouteP50Hours: expectedRouteHours,
    routeP50Hours: expectedRouteHours,
    routeP80Hours: fallbackRouteP80Hours,
    scoreHours: Number(range[1]) * 24,
    basis: key,
    confidence: 'default',
    sampleCount: 0
  }
}

function sameDivision(left, right) {
  const leftName = normalizeDivisionName(left)
  const rightName = normalizeDivisionName(right)
  return Boolean(leftName && rightName && leftName === rightName)
}

function buildExternalRouteEstimate(
  origin,
  destination,
  config,
  baselineData = loadExternalRouteBaselines()
) {
  if (!origin?.province || !origin?.city || !destination?.province || !destination?.city) return null
  const candidates = (baselineData?.routes || []).filter(route =>
    sameDivision(route.originProvince, origin.province) &&
    sameDivision(route.originCity, origin.city) &&
    sameDivision(route.destinationProvince, destination.province) &&
    sameDivision(route.destinationCity, destination.city)
  )
  if (!candidates.length) return null
  const exactCountyMatch = candidates.find(route =>
    route.originCounty && origin.county && sameDivision(route.originCounty, origin.county) &&
    route.destinationCounty && destination.county && sameDivision(route.destinationCounty, destination.county)
  )
  const destinationCountyMatch = candidates.find(route =>
    route.destinationCounty && destination.county && sameDivision(route.destinationCounty, destination.county)
  )
  const originCountyMatch = candidates.find(route =>
    route.originCounty && origin.county && sameDivision(route.originCounty, origin.county)
  )
  const route = exactCountyMatch || destinationCountyMatch || originCountyMatch || candidates[0]
  const routeP50Hours = Number(route.transitHours)
  if (!Number.isFinite(routeP50Hours) || routeP50Hours <= 0 || routeP50Hours > 24 * 15) return null
  const p80Buffer = Math.max(0, Number(config.externalRouteP80BufferHours || 12))
  const routeP80Hours = Math.max(routeP50Hours, Number(route.transitP80Hours) || routeP50Hours + p80Buffer)
  const defaultDispatchHours = Number(config.defaultDispatchHours || 24)
  return {
    minDays: Math.max(1, Math.floor((routeP50Hours + defaultDispatchHours) / 24)),
    maxDays: Math.max(1, Math.ceil((routeP80Hours + defaultDispatchHours) / 24)),
    expectedHours: routeP50Hours + defaultDispatchHours,
    scoreHours: routeP80Hours + defaultDispatchHours,
    routeP50Hours,
    routeP80Hours,
    basis: 'externalCityRoute',
    confidence: 'external',
    sampleCount: 0,
    externalProvider: String(baselineData.provider || 'kdniao'),
    externalCollectedAt: route.collectedAt || baselineData.generatedAt || null,
    externalDeliveryTime: route.deliveryTime || '',
    externalDeliveryDayOffset: Number.isFinite(Number(route.deliveryDayOffset))
      ? Number(route.deliveryDayOffset)
      : null
  }
}

function getDefaultDispatchPerformance(requestedAt, config) {
  const requested = normalizeContextDate(requestedAt) || new Date()
  const cutoffHour = Math.max(0, Math.min(23, Number(config.defaultDispatchCutoffHour ?? 17)))
  const cutoff = new Date(requested)
  cutoff.setHours(cutoffHour, 0, 0, 0)
  if (requested.getTime() >= cutoff.getTime()) cutoff.setDate(cutoff.getDate() + 1)
  const dispatchHours = Math.max(0, (cutoff.getTime() - requested.getTime()) / 3600000)
  return {
    basis: 'defaultCutoff',
    confidence: 'default',
    cutoffHour,
    sampleCount: 0,
    sameDayRate: isSameCalendarDay(requested, cutoff) ? 1 : 0,
    dispatchP50Hours: dispatchHours,
    dispatchP80Hours: dispatchHours
  }
}

function buildHistoryEstimate(origin, destination, observations, config) {
  const delivered = observations.filter(row => (!row.outcome || row.outcome === 'delivered') && Number(row.transit_hours) >= 2)
  const cityMatches = delivered.filter(row =>
    origin.province && destination.province && origin.city && destination.city &&
    row.origin_province === origin.province && row.origin_city === origin.city &&
    row.destination_province === destination.province && row.destination_city === destination.city
  )
  const provinceMatches = delivered.filter(row =>
    origin.province && destination.province &&
    row.origin_province === origin.province && row.destination_province === destination.province
  )

  const minimums = config.minimumSamples || {}
  let matches = []
  let basis = ''
  if (cityMatches.length >= Number(minimums.cityRoute || 3)) {
    matches = cityMatches
    basis = 'cityRoute'
  } else if (provinceMatches.length >= Number(minimums.provinceRoute || 5)) {
    matches = provinceMatches
    basis = 'provinceRoute'
  }
  if (!matches.length) return null

  const hours = matches.map(row => Number(row.transit_hours)).filter(value => value >= 2 && value <= 24 * 15)
  if (!hours.length) return null
  const p50 = percentile(hours, 0.5)
  const p80 = percentile(hours, 0.8)
  const defaultDispatchHours = Number(config.defaultDispatchHours || 24)
  return {
    minDays: Math.max(1, Math.floor((p50 + defaultDispatchHours) / 24)),
    maxDays: Math.max(1, Math.ceil((p80 + defaultDispatchHours) / 24)),
    expectedHours: p50 + defaultDispatchHours,
    scoreHours: p80 + defaultDispatchHours,
    routeP50Hours: p50,
    routeP80Hours: p80,
    basis,
    confidence: basis === 'cityRoute' ? 'high' : 'medium',
    sampleCount: hours.length
  }
}

function buildSourcePerformance(sourceKey, observations, config, requestedAt) {
  if (!sourceKey) return null
  const matches = observations.filter(row => row.source_key === sourceKey)
  if (!matches.length) return null
  const minimums = config.minimumSamples || {}
  // 不假设统一的商家截单时间，只拿下单小时相近的历史订单比较。
  const contextualMatches = matches.filter(row => isSameDispatchContext(row.ordered_at, requestedAt))
  const dispatchHours = contextualMatches
    .filter(row => (!row.outcome || row.outcome === 'delivered'))
    .map(row => Number(row.dispatch_hours))
    .filter(value => value >= 0 && value <= 24 * 10)
  const outcomeRows = contextualMatches.filter(row => row.outcome)
  const failedRows = outcomeRows.filter(row => row.outcome === 'unshipped_overdue' || row.outcome === 'unshipped_failed')

  const performance = {
    sampleCount: matches.length,
    contextSampleCount: contextualMatches.length,
    dispatchSampleCount: dispatchHours.length,
    unshippedCount: failedRows.length,
    unshippedRate: outcomeRows.length ? failedRows.length / outcomeRows.length : 0,
    dispatchP50Hours: null,
    dispatchP80Hours: null,
    dispatchRisk: ''
  }
  if (dispatchHours.length >= Number(minimums.sourceDispatch || 2)) {
    performance.dispatchP50Hours = percentile(dispatchHours, 0.5)
    performance.dispatchP80Hours = percentile(dispatchHours, 0.8)
  }
  if (outcomeRows.length >= Number(minimums.sourceRisk || 5) && performance.unshippedRate >= Number(config.riskRateThreshold || 0.3)) {
    performance.dispatchRisk = 'high'
  }
  return performance
}

function buildRegionalDispatchPerformance(origin, observations, config, requestedAt) {
  if (!origin?.province) return null
  const requestedBucket = getDispatchTimeBucket(requestedAt, config)
  if (!requestedBucket) return null
  const candidates = observations
    .filter(row => (!row.outcome || row.outcome === 'delivered'))
    .map(row => {
      const dispatchHours = Number(row.dispatch_hours)
      const orderedAt = normalizeContextDate(row.ordered_at)
      const bucket = getDispatchTimeBucket(orderedAt, config)
      if (!orderedAt || !bucket || !Number.isFinite(dispatchHours) || dispatchHours < 0 || dispatchHours > 24 * 10) return null
      if (bucket.startHour !== requestedBucket.startHour) return null
      const pickedUpAt = normalizeContextDate(row.picked_up_at) || new Date(orderedAt.getTime() + dispatchHours * 3600000)
      return { row, dispatchHours, orderedAt, pickedUpAt, bucket }
    })
    .filter(Boolean)

  const cityMatches = candidates.filter(item =>
    origin.city && item.row.origin_province === origin.province && item.row.origin_city === origin.city
  )
  const provinceMatches = candidates.filter(item => item.row.origin_province === origin.province)
  const originGroup = getRegionGroup(origin.province, config)
  const regionMatches = originGroup
    ? candidates.filter(item => getRegionGroup(item.row.origin_province, config) === originGroup)
    : []
  const minimums = config.minimumSamples || {}
  let matches = []
  let basis = ''
  if (cityMatches.length >= Number(minimums.cityDispatchTimeBucket || 5)) {
    matches = cityMatches
    basis = 'cityTimeBucket'
  } else if (provinceMatches.length >= Number(minimums.provinceDispatchTimeBucket || 10)) {
    matches = provinceMatches
    basis = 'provinceTimeBucket'
  } else if (regionMatches.length >= Number(minimums.regionDispatchTimeBucket || 20)) {
    matches = regionMatches
    basis = 'regionTimeBucket'
  }
  if (!matches.length) return null

  const dispatchHours = matches.map(item => item.dispatchHours)
  const sameDayCount = matches.filter(item => isSameCalendarDay(item.orderedAt, item.pickedUpAt)).length
  return {
    basis,
    confidence: basis === 'cityTimeBucket' ? 'high' : basis === 'provinceTimeBucket' ? 'medium' : 'low',
    regionGroup: basis === 'regionTimeBucket' ? originGroup : '',
    province: basis === 'regionTimeBucket' ? '' : origin.province,
    city: basis === 'cityTimeBucket' ? origin.city : '',
    dayType: 'all',
    startHour: requestedBucket.startHour,
    endHour: requestedBucket.endHour,
    sampleCount: matches.length,
    sameDayCount,
    sameDayRate: matches.length ? sameDayCount / matches.length : 0,
    dispatchP50Hours: percentile(dispatchHours, 0.5),
    dispatchP80Hours: percentile(dispatchHours, 0.8)
  }
}

function inferSourceOrigin(sourceKey, observations) {
  if (!sourceKey) return null
  const counts = new Map()
  for (const row of observations) {
    if (row.source_key !== sourceKey || !row.origin_province) continue
    const region = {
      province: String(row.origin_province || ''),
      city: String(row.origin_city || ''),
      county: String(row.origin_county || ''),
      raw: ''
    }
    const key = `${region.province}|${region.city}|${region.county}`
    const current = counts.get(key) || { region, count: 0 }
    current.count++
    counts.set(key, current)
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.region || null
}

function applySourcePerformance(baseEstimate, performance, config, regionalDispatchPerformance = null, requestedAt = new Date()) {
  if (!baseEstimate) return baseEstimate
  const estimate = { ...baseEstimate }
  if (performance) estimate.sourcePerformance = performance
  if (regionalDispatchPerformance) estimate.regionalDispatchPerformance = regionalDispatchPerformance
  const baselineDispatch = Number(config.defaultDispatchHours || 24)
  const learnedDispatchPerformance = Number.isFinite(performance?.dispatchP80Hours)
    ? performance
    : Number.isFinite(regionalDispatchPerformance?.dispatchP80Hours)
      ? regionalDispatchPerformance
      : null
  const dispatchPerformance = learnedDispatchPerformance || getDefaultDispatchPerformance(requestedAt, config)

  if (dispatchPerformance) {
    estimate.dispatchBasis = dispatchPerformance === performance
      ? 'source'
      : dispatchPerformance === regionalDispatchPerformance
        ? regionalDispatchPerformance.basis
        : dispatchPerformance.basis
    if (Number.isFinite(estimate.routeP80Hours)) {
      estimate.expectedHours = estimate.routeP50Hours + dispatchPerformance.dispatchP50Hours
      estimate.scoreHours = estimate.routeP80Hours + dispatchPerformance.dispatchP80Hours
      estimate.minDays = Math.max(1, Math.floor((estimate.routeP50Hours + dispatchPerformance.dispatchP50Hours) / 24))
      estimate.maxDays = Math.max(estimate.minDays, Math.ceil(estimate.scoreHours / 24))
    } else {
      const dispatchAdjustment = dispatchPerformance.dispatchP80Hours - baselineDispatch
      const expectedDispatchAdjustment = dispatchPerformance.dispatchP50Hours - baselineDispatch
      estimate.expectedHours = Math.max(24, Number(estimate.expectedHours || estimate.scoreHours) + expectedDispatchAdjustment)
      estimate.scoreHours = Math.max(24, estimate.scoreHours + dispatchAdjustment)
      const fallbackRouteMinHours = Math.max(0, estimate.minDays * 24 - baselineDispatch)
      estimate.minDays = Math.max(1, Math.floor((fallbackRouteMinHours + dispatchPerformance.dispatchP50Hours) / 24))
      estimate.maxDays = Math.max(estimate.minDays, Math.ceil(estimate.scoreHours / 24))
    }
  }

  if (performance?.dispatchRisk === 'high') {
    const riskPenalty = performance.unshippedRate * Number(config.riskPenaltyHours || 48)
    estimate.scoreHours += riskPenalty
    estimate.maxDays = Math.max(estimate.maxDays, Math.ceil(estimate.scoreHours / 24))
    estimate.dispatchRisk = 'high'
  }
  return estimate
}

function recommendSources({ destination, sources, observations = [], config = loadTimelinessConfig(), requestedAt = new Date() }) {
  const destinationRegion = normalizeRegion(destination)
  const results = (Array.isArray(sources) ? sources : []).map((source, index) => {
    const shipFrom = String(source.ship_from || source.shipFrom || '').trim()
    const purchasePrice = Number(source.purchase_price ?? source.purchasePrice)
    const sourceKey = source.source_key || getSourceKey(source.purchase_link || source.purchaseLink)
    const explicitOrigin = normalizeRegion(shipFrom)
    const origin = explicitOrigin.province ? explicitOrigin : (inferSourceOrigin(sourceKey, observations) || explicitOrigin)
    const historyEstimate = buildHistoryEstimate(origin, destinationRegion, observations, config)
    const externalEstimate = buildExternalRouteEstimate(origin, destinationRegion, config)
    const sourcePerformance = buildSourcePerformance(sourceKey, observations, config, requestedAt)
    const regionalDispatchPerformance = buildRegionalDispatchPerformance(origin, observations, config, requestedAt)
    const estimate = applySourcePerformance(
      historyEstimate || externalEstimate || getFallbackEstimate(origin, destinationRegion, config),
      sourcePerformance,
      config,
      regionalDispatchPerformance,
      requestedAt
    )
    return {
      id: source.id ?? String(index),
      index,
      ship_from: shipFrom,
      source_key: sourceKey,
      purchase_price: Number.isFinite(purchasePrice) && purchasePrice > 0 ? purchasePrice : null,
      origin,
      estimate,
      recommended: false
    }
  })

  const comparable = results.filter(result => result.estimate && Number.isFinite(result.estimate.scoreHours))
  if (comparable.length >= 2) {
    const bestScore = Math.min(...comparable.map(result => result.estimate.scoreHours))
    const fastest = comparable.filter(result => Math.abs(result.estimate.scoreHours - bestScore) < 0.01)
    const pricedFastest = fastest.filter(result => Number.isFinite(result.purchase_price))
    if (pricedFastest.length >= 2) {
      const bestPrice = Math.min(...pricedFastest.map(result => result.purchase_price))
      for (const result of pricedFastest) {
        result.recommended = Math.abs(result.purchase_price - bestPrice) < 0.001
      }
    } else {
      for (const result of fastest) result.recommended = true
    }
  }
  return { destination: destinationRegion, results }
}

async function recordTimelinessObservation(pool, order, tracking, options = {}) {
  if (!pool || !order?.id) return { recorded: false, reason: 'missing_order' }
  const sourceShipFrom = order.source_ship_from || getSourceShipFrom(order.source_url)
  const sourceKey = order.source_key || getSourceKey(order.source_url)
  const referenceDate = order.created_at ? new Date(order.created_at) : new Date()
  const trackingRoute = extractTrackingRoute(tracking, referenceDate)
  const sourceOrigin = normalizeRegion(sourceShipFrom)
  const orderDestination = normalizeRegion(order.shipping_address)
  // 历史采购链接通常没有保存发货地，实际物流的最早揽收/流转地点才是路线学习的首选。
  const origin = trackingRoute.origin?.province ? trackingRoute.origin : sourceOrigin
  // 采购单收货地址最稳定；缺失时再使用物流末端签收/流转地点兜底。
  const destination = orderDestination.province ? orderDestination : trackingRoute.destination

  const milestones = extractTrackingMilestones(tracking, referenceDate)
  const trackingEvents = normalizeTrackingEntries(tracking)
  const hasNetworkEntry = trackingEvents.some(isNetworkEntryEvent)
  const orderAgeHours = referenceDate && !Number.isNaN(referenceDate.getTime())
    ? (Date.now() - referenceDate.getTime()) / 3600000
    : 0
  const status = String(options.status || order.status || '')
  let outcome = 'delivered'
  if (!milestones) {
    if (hasNetworkEntry) return { recorded: false, reason: 'waiting_for_delivery' }
    if (options.confirmedUnshippedFailure === true) outcome = 'unshipped_failed'
    else if (
      options.verifiedByPlatformSync === true &&
      ['ordered', 'pending'].includes(status) &&
      orderAgeHours >= Number(loadTimelinessConfig().unshippedOverdueHours || 72)
    ) {
      outcome = 'unshipped_overdue'
    } else {
      return { recorded: false, reason: 'missing_milestones' }
    }
  }
  if (outcome === 'delivered' && !origin?.province) return { recorded: false, reason: 'missing_origin' }
  if (!destination?.province) return { recorded: false, reason: 'missing_destination' }
  if (outcome !== 'delivered' && !sourceKey) return { recorded: false, reason: 'missing_source_key' }
  const dispatchHours = referenceDate && !Number.isNaN(referenceDate.getTime())
    ? (milestones?.pickedUpAt.getTime() - referenceDate.getTime()) / 3600000
    : null
  const totalHours = referenceDate && !Number.isNaN(referenceDate.getTime())
    ? (milestones?.signedAt.getTime() - referenceDate.getTime()) / 3600000
    : null
  // 只保存标准行政区，绝不把可能包含快递员姓名、电话的物流原文写入样本表。
  const originRaw = origin?.province
    ? [origin.province, origin.city, origin.county].filter(Boolean).join('')
    : ''

  await pool.execute(
    `INSERT INTO shipping_timeliness_observations
      (purchase_order_id, owner_id, platform_order_no, platform, source_key, origin_raw,
       origin_province, origin_city, origin_county, destination_province,
       destination_city, destination_county, ordered_at, picked_up_at, signed_at,
       dispatch_hours, transit_hours, total_hours, outcome)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       source_key=VALUES(source_key), origin_raw=VALUES(origin_raw), origin_province=VALUES(origin_province),
       origin_city=VALUES(origin_city), origin_county=VALUES(origin_county),
       destination_province=VALUES(destination_province), destination_city=VALUES(destination_city),
       destination_county=VALUES(destination_county), ordered_at=VALUES(ordered_at),
       picked_up_at=IF(VALUES(outcome)='delivered', VALUES(picked_up_at), picked_up_at),
       signed_at=IF(VALUES(outcome)='delivered', VALUES(signed_at), signed_at),
       dispatch_hours=IF(VALUES(outcome)='delivered', VALUES(dispatch_hours), dispatch_hours),
       transit_hours=IF(VALUES(outcome)='delivered', VALUES(transit_hours), transit_hours),
       total_hours=IF(VALUES(outcome)='delivered', VALUES(total_hours), total_hours),
       outcome=IF(outcome='delivered' AND VALUES(outcome)!='delivered', outcome, VALUES(outcome)),
       updated_at=NOW()`,
    [
      order.id, order.owner_id || null, order.platform_order_no || '', order.platform || '', sourceKey,
      originRaw,
      origin?.province || '', origin?.city || '', origin?.county || '', destination.province,
      destination.city, destination.county, referenceDate, milestones?.pickedUpAt || null, milestones?.signedAt || null,
      Number.isFinite(dispatchHours) && dispatchHours >= 0 && dispatchHours <= 24 * 10 ? dispatchHours : null,
      milestones?.transitHours || null,
      Number.isFinite(totalHours) && totalHours >= 2 && totalHours <= 24 * 20 ? totalHours : null,
      outcome
    ]
  )
  return {
    recorded: true,
    outcome,
    transitHours: milestones?.transitHours || null,
    originSource: trackingRoute.origin?.province ? 'tracking' : 'source_link',
    destinationSource: orderDestination.province ? 'purchase_order' : 'tracking'
  }
}

async function backfillRecentObservations(pool, limit = 10000) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10000, 50000))
  const reasons = {}
  let scanned = 0
  let recorded = 0
  let lastId = null
  while (scanned < safeLimit) {
    const batchLimit = Math.min(1000, safeLimit - scanned)
    const cursorSql = lastId == null ? '' : 'AND po.id < ?'
    const [rows] = await pool.execute(
      `SELECT po.id, po.owner_id, po.platform_order_no, po.platform, po.source_url,
              po.shipping_address, po.created_at, po.logistics_tracking, po.status
         FROM purchase_orders po
         LEFT JOIN shipping_timeliness_observations sto ON sto.purchase_order_id = po.id
        WHERE (sto.id IS NULL OR sto.outcome != 'delivered')
          AND po.logistics_tracking IS NOT NULL
          AND po.logistics_tracking != ''
          AND po.created_at >= DATE_SUB(NOW(), INTERVAL 180 DAY)
          ${cursorSql}
        ORDER BY po.id DESC
        LIMIT ${batchLimit}`,
      lastId == null ? [] : [lastId]
    )
    if (!rows.length) break
    scanned += rows.length
    lastId = rows.at(-1).id
    for (const row of rows) {
      try {
        const result = await recordTimelinessObservation(pool, row, row.logistics_tracking, { status: row.status })
        if (result.recorded) recorded++
        else reasons[result.reason || 'unknown'] = (reasons[result.reason || 'unknown'] || 0) + 1
      } catch (error) {
        reasons.error = (reasons.error || 0) + 1
        console.warn(`[ShippingTimeliness] 回填订单 ${row.id} 失败:`, error.message)
      }
    }
    if (rows.length < batchLimit) break
  }
  return { scanned, recorded, reasons }
}

async function recommendSourcesFromDatabase(pool, payload) {
  const config = loadTimelinessConfig()
  const lookbackDays = Math.max(30, Math.min(Number(config.lookbackDays) || 90, 365))
  const destination = normalizeRegion(payload?.destination)
  const sources = Array.isArray(payload?.sources) ? payload.sources : []
  const sourceKeys = [...new Set(sources.map(source =>
    source.source_key || getSourceKey(source.purchase_link || source.purchaseLink)
  ).filter(Boolean))]
  const originProvinces = [...new Set(sources.map(source =>
    normalizeRegion(source.ship_from || source.shipFrom).province
  ).filter(Boolean))]
  // 大区时段回退需要同时读取同大区其它省份的已签收样本；路线P80仍会在内存中按真实起终点过滤。
  const queryOriginProvinces = [...new Set(originProvinces.flatMap(province => {
    const group = getRegionGroup(province, config)
    return [province, ...(group ? (config.regionGroups?.[group] || []) : [])]
  }))]
  const requestedBucket = getDispatchTimeBucket(payload?.requested_at || new Date(), config)
  const filters = []
  const params = []
  if (queryOriginProvinces.length) {
    const timeBucketSql = requestedBucket ? ' AND HOUR(ordered_at)>=? AND HOUR(ordered_at)<?' : ''
    filters.push(`(outcome='delivered' AND origin_province IN (${queryOriginProvinces.map(() => '?').join(',')})${timeBucketSql})`)
    params.push(...queryOriginProvinces)
    if (requestedBucket) params.push(requestedBucket.startHour, requestedBucket.endHour)
  }
  if (sourceKeys.length) {
    filters.push(`source_key IN (${sourceKeys.map(() => '?').join(',')})`)
    params.push(...sourceKeys)
  }
  const filterSql = filters.length ? `AND (${filters.join(' OR ')})` : 'AND 1=0'
  const [observations] = await pool.execute(
    `SELECT source_key, outcome, origin_province, origin_city, origin_county,
            destination_province, destination_city, destination_county,
            ordered_at, picked_up_at, dispatch_hours, transit_hours, total_hours
       FROM shipping_timeliness_observations
      WHERE (
        signed_at >= DATE_SUB(NOW(), INTERVAL ${lookbackDays} DAY)
        OR (signed_at IS NULL AND updated_at >= DATE_SUB(NOW(), INTERVAL ${lookbackDays} DAY))
      )
      ${filterSql}`,
    params
  )
  return recommendSources({
    destination: payload?.destination,
    sources,
    observations,
    config,
    requestedAt: payload?.requested_at || new Date()
  })
}

module.exports = {
  normalizeRegion,
  parseSourceMetadata,
  getSourceShipFrom,
  getSourceKey,
  parseTrackingTime,
  extractRegionFromTrackingContext,
  extractTrackingRoute,
  extractTrackingMilestones,
  percentile,
  isSameDispatchContext,
  getDispatchTimeBucket,
  buildRegionalDispatchPerformance,
  getDefaultDispatchPerformance,
  getFallbackEstimate,
  buildExternalRouteEstimate,
  loadExternalRouteBaselines,
  recommendSources,
  recordTimelinessObservation,
  backfillRecentObservations,
  recommendSourcesFromDatabase,
  loadTimelinessConfig
}
