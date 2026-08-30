function normalizeText(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

function parseSaleAttributes(value) {
  if (!value) return []

  let parsed = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return []
    try {
      parsed = JSON.parse(text)
    } catch {
      return []
    }
  }

  if (!Array.isArray(parsed)) {
    parsed = Array.isArray(parsed?.attributes) ? parsed.attributes : [parsed]
  }

  return parsed
    .map(attribute => {
      if (!attribute || typeof attribute !== 'object') return null
      const name = normalizeText(attribute.saleName || attribute.name || attribute.attrName)
      const valueText = normalizeText(attribute.saleValue || attribute.value || attribute.attrValue)
      return valueText ? { name, value: valueText } : null
    })
    .filter(Boolean)
}

function extractJdSalesOrderSkuSpec(item = {}) {
  const attributes = parseSaleAttributes(item.saleAttributes)
  if (attributes.length === 1) return attributes[0].value.slice(0, 300)
  if (attributes.length > 1) {
    return attributes
      .map(attribute => attribute.name ? `${attribute.name}?${attribute.value}` : attribute.value)
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(' / ')
      .slice(0, 300)
  }

  const fallback = [
    item.skuSpec,
    item.specName,
    item.skuText,
    item.specification,
    item.variantName
  ].map(normalizeText).find(Boolean)

  return (fallback || '').slice(0, 300)
}

module.exports = {
  extractJdSalesOrderSkuSpec,
  parseSaleAttributes
}
