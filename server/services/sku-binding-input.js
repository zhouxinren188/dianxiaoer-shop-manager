function invalidInput(message) {
  const error = new Error(message)
  error.code = 'INVALID_SKU_BINDING_INPUT'
  return error
}

function normalizePositiveInteger(value, fieldName) {
  const normalized = Number.parseInt(value, 10)
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw invalidInput(`${fieldName}无效`)
  }
  return normalized
}

function normalizeSkuId(value) {
  const normalized = value === undefined || value === null ? '' : String(value).trim()
  if (!normalized) throw invalidInput('销售SKU不能为空')
  if (normalized.length > 100) throw invalidInput('销售SKU不能超过100个字符')
  return normalized
}

function normalizeSkuBindingInput(body = {}) {
  const hasStoreId = body.store_id !== undefined && body.store_id !== null && body.store_id !== ''
  return {
    storeId: hasStoreId ? normalizePositiveInteger(body.store_id, '店铺') : null,
    inventoryId: normalizePositiveInteger(body.inventory_id, '仓库商品'),
    skuId: normalizeSkuId(body.sku_id),
    packageNum: body.package_num === undefined || body.package_num === null || body.package_num === ''
      ? 1
      : normalizePositiveInteger(body.package_num, '包装规格')
  }
}

module.exports = {
  normalizeSkuBindingInput
}
