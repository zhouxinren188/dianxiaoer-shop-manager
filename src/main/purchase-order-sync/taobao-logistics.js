'use strict'

function taobaoRichTextToPlain(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  if (Array.isArray(value)) {
    return value.map(taobaoRichTextToPlain).filter(Boolean).join('').trim()
  }
  if (typeof value === 'object') {
    if (value.text !== undefined) return taobaoRichTextToPlain(value.text)
    if (value.content !== undefined) return taobaoRichTextToPlain(value.content)
    if (value.value !== undefined) return taobaoRichTextToPlain(value.value)
  }
  return ''
}

function parseTaobaoPickupCode(title, toPlain = taobaoRichTextToPlain) {
  const text = String(toPlain(title) || '').replace(/\s+/g, ' ').trim()
  if (!text.includes('待取件')) return ''
  return text.replace('待取件', '').trim() || '待取件'
}

/**
 * 淘宝物流详情组件中的取件信息结构与 DL 保持一致：
 * - package.fields.title: “待取件 + 取件码”
 * - 第一条 logisticsDetailLine_*.fields.desc: 取件地址/取件提示
 */
function extractTaobaoPickupInfo(input, toPlain = taobaoRichTextToPlain) {
  const components = input && input.data && typeof input.data === 'object' ? input.data : input
  if (!components || typeof components !== 'object') {
    return { pickup_code: '', pickup_address: '' }
  }

  let pickupCode = ''
  let pickupAddress = ''

  for (const [key, component] of Object.entries(components)) {
    if (!component || typeof component !== 'object') continue
    const fields = component.fields || component
    const tag = String(component.tag || key || '')
    const type = String(component.type || '')

    if (!pickupCode && (tag === 'package' || tag === 'pakcage' || type.includes('package'))) {
      pickupCode = parseTaobaoPickupCode(fields.title, toPlain)
    }

    const isLogisticsDetailLine = key.startsWith('logisticsDetailLine_') ||
      tag === 'logisticsDetailLine' || type.includes('logisticsinfo_step')
    if (!pickupAddress && isLogisticsDetailLine) {
      pickupAddress = String(toPlain(fields.desc || fields.description || fields.content || '') || '')
        .replace(/\s+/g, ' ')
        .trim()
    }
  }

  return {
    pickup_code: pickupCode,
    pickup_address: pickupAddress
  }
}

/**
 * 只要订单已经出现运单号，就应进入物流页补齐轨迹。
 * 淘宝列表偶尔会把已发货订单的步骤状态仍显示为“拍下宝贝/已下单”，
 * 不能只依赖订单状态判断是否需要读取物流详情。
 */
function shouldFetchTaobaoLogisticsDetails(orderInfo, mappedStatus = '') {
  if (!orderInfo || typeof orderInfo !== 'object') return false

  const hasTrackingNo = Boolean(String(orderInfo.logistics_no || '').trim())
  const isShippingStatus = mappedStatus === 'shipped' || mappedStatus === 'in_transit'
  if (!hasTrackingNo && !isShippingStatus) return false

  const hasTracking = Array.isArray(orderInfo.logistics_tracking) && orderInfo.logistics_tracking.length > 0
  return !hasTracking || !orderInfo.pickup_code || !orderInfo.pickup_address
}

/**
 * 淘宝新版物流详情响应通常不再携带平台订单号。当前窗口已经固定打开
 * 目标订单的物流页，因此可通过订单号、预期运单号或真实轨迹/取件信息确认响应。
 */
function isRelevantTaobaoLogisticsResult(parsed, rawData, targetOrderNo, expectedTrackingNo = '') {
  if (!parsed || typeof parsed !== 'object') return false

  let rawText = ''
  try {
    rawText = typeof rawData === 'string' ? rawData : JSON.stringify(rawData || {})
  } catch (_) {}

  if (targetOrderNo && rawText.includes(String(targetOrderNo))) return true

  const actualTrackingNo = String(parsed.logistics_no || '').trim()
  const normalizedExpectedNo = String(expectedTrackingNo || '').trim()
  if (normalizedExpectedNo && actualTrackingNo === normalizedExpectedNo) return true

  const hasTracking = Array.isArray(parsed.logistics_tracking) && parsed.logistics_tracking.length > 0
  return hasTracking || Boolean(parsed.pickup_code || parsed.pickup_address)
}

module.exports = {
  taobaoRichTextToPlain,
  parseTaobaoPickupCode,
  extractTaobaoPickupInfo,
  shouldFetchTaobaoLogisticsDetails,
  isRelevantTaobaoLogisticsResult
}
