function parseTaobaoMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0
  const text = String(value ?? '').replace(/[,，]/g, '').trim()
  const match = text.match(/-?\d+(?:\.\d+)?/)
  if (!match) return 0
  const amount = Number(match[0])
  return Number.isFinite(amount) && amount > 0 ? amount : 0
}

function parseTaobaoQuantity(value) {
  const raw = value && typeof value === 'object' ? value.count : value
  const quantity = Number.parseInt(String(raw ?? ''), 10)
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 0
}

function firstPositive(values) {
  for (const value of values) {
    const amount = parseTaobaoMoney(value)
    if (amount > 0) return amount
  }
  return 0
}

function getSubOrderQuantity(subOrder) {
  if (!subOrder || typeof subOrder !== 'object') return 0
  return parseTaobaoQuantity(
    subOrder.quantity ??
    subOrder.buyAmount ??
    subOrder.amount ??
    subOrder.itemInfo?.quantity ??
    subOrder.itemInfo?.buyAmount
  )
}

function extractTaobaoOrderAmount(order) {
  if (!order || typeof order !== 'object') {
    return { total_amount: 0, shipping_fee: 0, purchase_price: 0, quantity: 0 }
  }

  const payInfo = order.payInfo || {}
  const totalAmount = firstPositive([
    payInfo.actualFee,
    payInfo.shouldPay,
    payInfo.actualTotalFee,
    payInfo.totalFee,
    order.actualFee,
    order.shouldPay,
    order.actualTotalFee,
    order.totalFee
  ])
  const shippingFee = firstPositive([
    payInfo.postFee,
    payInfo.shippingFee,
    payInfo.freight,
    order.postFee,
    order.shippingFee,
    order.freight
  ])

  const subOrders = Array.isArray(order.subOrders) ? order.subOrders.filter(Boolean) : []
  const quantity = subOrders.reduce((sum, subOrder) => sum + getSubOrderQuantity(subOrder), 0)

  let purchasePrice = 0
  // 一个淘宝主订单可能包含多个不同商品。只有单一子商品时，整单实付
  // 才能安全地折算为该采购单的商品单价；多子商品只回填整单实付总额。
  if (totalAmount > 0 && quantity > 0 && subOrders.length === 1) {
    const goodsAmount = totalAmount - shippingFee
    purchasePrice = Math.round(((goodsAmount > 0 ? goodsAmount : totalAmount) / quantity) * 100) / 100
  }

  if (!(purchasePrice > 0) && subOrders.length === 1) {
    const subOrder = subOrders[0]
    const itemInfo = subOrder.itemInfo || {}
    const priceInfo = subOrder.priceInfo || itemInfo.priceInfo || {}
    purchasePrice = firstPositive([
      itemInfo.unitPrice,
      itemInfo.price,
      priceInfo.unitPrice,
      priceInfo.price,
      priceInfo.realTotal,
      priceInfo.actualTotalFee,
      subOrder.unitPrice,
      subOrder.price
    ])
  }

  return {
    total_amount: totalAmount,
    shipping_fee: shippingFee,
    purchase_price: purchasePrice,
    quantity
  }
}

function applyTaobaoOrderAmount(target, order) {
  if (!target || typeof target !== 'object') return target
  const amount = extractTaobaoOrderAmount(order)
  if (amount.total_amount > 0) target.total_amount = String(amount.total_amount)
  if (amount.shipping_fee > 0) target.shipping_fee = String(amount.shipping_fee)
  if (amount.purchase_price > 0) target.purchase_price = String(amount.purchase_price)
  if (amount.quantity > 0) target.quantity = amount.quantity
  return target
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  return value !== false
}

function mergeTaobaoOrderInfo(existing, incoming) {
  if (!existing) return incoming ? { ...incoming } : existing
  if (!incoming) return { ...existing }

  const merged = { ...existing }
  for (const [key, value] of Object.entries(incoming)) {
    if (!hasValue(merged[key]) && hasValue(value)) merged[key] = value
  }

  for (const key of ['purchase_price', 'total_amount', 'shipping_fee', 'quantity']) {
    if (Number(merged[key] || 0) <= 0 && Number(incoming[key] || 0) > 0) {
      merged[key] = incoming[key]
    }
  }
  return merged
}

module.exports = {
  parseTaobaoMoney,
  extractTaobaoOrderAmount,
  applyTaobaoOrderAmount,
  mergeTaobaoOrderInfo
}
