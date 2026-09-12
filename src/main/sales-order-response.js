'use strict'

/**
 * 京东 queryOrderPage 在没有订单时不会始终返回 results: []，有时只返回
 * totalItem: 0。只要接口本身成功且任一可信总数字段明确为 0，就应把它视为
 * 一次成功的空结果，不能继续轮询到超时。
 */
function isSuccessfulEmptySalesOrderResponse(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false

  const code = Number(json.code)
  if (code !== 0 && code !== 200) return false

  const data = json.data && typeof json.data === 'object' ? json.data : {}
  const totalCandidates = [
    json.totalItem,
    json.totalCount,
    json.total,
    data.totalItem,
    data.totalCount,
    data.total
  ]

  return totalCandidates.some(value => value !== null && value !== undefined && Number(value) === 0)
}

module.exports = {
  isSuccessfulEmptySalesOrderResponse
}
