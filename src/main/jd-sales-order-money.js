'use strict'

function parseJdOrderMoney(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const amount = Number(String(value).replace(/,/g, ''))
  return Number.isFinite(amount) ? amount : null
}

function normalizeJdSalesOrderAmounts(payInfo = {}) {
  const merchantReceivable = parseJdOrderMoney(payInfo.receivables)
  const shouldPayAmount = parseJdOrderMoney(payInfo.shouldPay)
  const orderSumAmount = parseJdOrderMoney(payInfo.orderSum)
  const goodsAmount = parseJdOrderMoney(payInfo.goodsAmount)
  const shippingFee = parseJdOrderMoney(payInfo.freight)

  return {
    // 京麦订单列表“商家应收”才是本软件订单金额及销售统计口径。
    // 兼容旧接口：只有 receivables 字段缺失/无效时才回退 shouldPay；0 元必须保留为 0。
    totalAmount: merchantReceivable ?? shouldPayAmount ?? 0,
    goodsAmount: orderSumAmount ?? goodsAmount ?? shouldPayAmount ?? 0,
    shippingFee: shippingFee ?? 0,
    // 同步到服务器 raw_data，保留两个京东原始口径供后续核对。
    merchantReceivable,
    shouldPayAmount
  }
}

module.exports = {
  normalizeJdSalesOrderAmounts,
  parseJdOrderMoney
}
