const LEGACY_ATTRIBUTE_SEPARATOR = /(^|\s*\/\s*)(规格|尺码|颜色|型号|款式|尺寸|容量|口味|香型|数量|包装|版本|套餐|净含量)[?:：](?=\S)/g

export function normalizeSalesSkuSpec(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEGACY_ATTRIBUTE_SEPARATOR, (_match, prefix, name) => `${prefix}${name}：`)
}
