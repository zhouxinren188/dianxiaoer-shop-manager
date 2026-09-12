'use strict'

// 普通资源响应只保留少量正文，避免页面脚本、样式等占用过多内存。
const DEFAULT_RESPONSE_CAPTURE_LIMIT = 200000

// 京东 queryOrderPage 单页 50 条时实际响应可超过 300KB。
// 该接口必须保留完整 JSON，否则截断后 JSON.parse 会失败并被误判成同步超时。
const ORDER_PAGE_RESPONSE_CAPTURE_LIMIT = 2 * 1024 * 1024

function getSalesResponseCaptureLimit(url) {
  const normalizedUrl = String(url || '').toLowerCase()
  return normalizedUrl.includes('queryorderpage')
    ? ORDER_PAGE_RESPONSE_CAPTURE_LIMIT
    : DEFAULT_RESPONSE_CAPTURE_LIMIT
}

function limitSalesResponseBody(url, body) {
  const text = String(body || '')
  return text.substring(0, getSalesResponseCaptureLimit(url))
}

module.exports = {
  DEFAULT_RESPONSE_CAPTURE_LIMIT,
  ORDER_PAGE_RESPONSE_CAPTURE_LIMIT,
  getSalesResponseCaptureLimit,
  limitSalesResponseBody
}
