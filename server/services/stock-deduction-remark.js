function normalizePositiveInteger(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return Math.floor(number)
}

function buildStockDeductionRemark(items = []) {
  const locationQuantities = new Map()

  for (const item of Array.isArray(items) ? items : []) {
    const orderQuantity = normalizePositiveInteger(item?.quantity)
    const packageNum = normalizePositiveInteger(item?.package_num) || 1
    const deductQuantity = orderQuantity * packageNum
    if (!deductQuantity) continue

    const location = String(item?.location || '').trim() || '未设置'
    locationQuantities.set(location, (locationQuantities.get(location) || 0) + deductQuantity)
  }

  return Array.from(locationQuantities.entries())
    .map(([location, quantity]) => `货位号：${location} 数量：${quantity}`)
    .join('\n')
}

module.exports = {
  buildStockDeductionRemark,
  normalizePositiveInteger
}
