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

module.exports = {
  taobaoRichTextToPlain,
  parseTaobaoPickupCode,
  extractTaobaoPickupInfo
}
