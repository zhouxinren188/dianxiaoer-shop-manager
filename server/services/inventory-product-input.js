function invalidInput(message) {
  const error = new Error(message)
  error.code = 'INVALID_INVENTORY_INPUT'
  return error
}

function normalizePositiveInteger(value, fieldName) {
  const normalized = Number.parseInt(value, 10)
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw invalidInput(`${fieldName}无效`)
  }
  return normalized
}

function normalizeNonNegativeInteger(value, fallback, fieldName) {
  if (value === undefined || value === null || value === '') return fallback
  const normalized = Number(value)
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw invalidInput(`${fieldName}必须是大于等于0的整数`)
  }
  return normalized
}

function normalizeNonNegativeNumber(value, fallback, fieldName) {
  if (value === undefined || value === null || value === '') return fallback
  const normalized = Number(value)
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw invalidInput(`${fieldName}必须是大于等于0的数字`)
  }
  return Math.round(normalized * 100) / 100
}

function normalizeText(value, { fieldName, required = false, maxLength }) {
  const normalized = value === undefined || value === null ? '' : String(value).trim()
  if (required && !normalized) throw invalidInput(`${fieldName}不能为空`)
  if (normalized.length > maxLength) throw invalidInput(`${fieldName}不能超过${maxLength}个字符`)
  return normalized
}

function normalizeInventoryCreateInput(body = {}) {
  return {
    warehouseId: normalizePositiveInteger(body.warehouse_id, '仓库'),
    productName: normalizeText(body.product_name, { fieldName: '商品名称', required: true, maxLength: 300 }),
    price: normalizeNonNegativeNumber(body.price, 0, '成本价'),
    image: normalizeText(body.image, { fieldName: '商品图片地址', maxLength: 2000 }),
    warnQuantity: normalizeNonNegativeInteger(body.warn_quantity, 10, '库存预警值'),
    quantity: normalizeNonNegativeInteger(body.quantity, 0, '当前库存'),
    location: normalizeText(body.location, { fieldName: '货位号', maxLength: 100 }),
    batchNo: normalizeText(body.batch_no, { fieldName: '批次号', maxLength: 50 }),
    supplier: normalizeText(body.supplier, { fieldName: '供应商', maxLength: 100 })
  }
}

function normalizeInventoryUpdateInput(body = {}) {
  const fields = {}
  if (body.warehouse_id !== undefined) fields.warehouseId = normalizePositiveInteger(body.warehouse_id, '仓库')
  if (body.product_name !== undefined) fields.productName = normalizeText(body.product_name, { fieldName: '商品名称', required: true, maxLength: 300 })
  if (body.price !== undefined) fields.price = normalizeNonNegativeNumber(body.price, 0, '成本价')
  if (body.image !== undefined) fields.image = normalizeText(body.image, { fieldName: '商品图片地址', maxLength: 2000 })
  if (body.warn_quantity !== undefined) fields.warnQuantity = normalizeNonNegativeInteger(body.warn_quantity, 10, '库存预警值')
  if (body.quantity !== undefined) fields.quantity = normalizeNonNegativeInteger(body.quantity, 0, '当前库存')
  if (body.location !== undefined) fields.location = normalizeText(body.location, { fieldName: '货位号', maxLength: 100 })
  if (body.batch_no !== undefined) fields.batchNo = normalizeText(body.batch_no, { fieldName: '批次号', maxLength: 50 })
  if (body.supplier !== undefined) fields.supplier = normalizeText(body.supplier, { fieldName: '供应商', maxLength: 100 })
  return fields
}

module.exports = {
  normalizeInventoryCreateInput,
  normalizeInventoryUpdateInput
}
