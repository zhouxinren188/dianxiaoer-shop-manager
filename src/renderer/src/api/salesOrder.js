import { get, post, put, del } from './request'

export function fetchSalesOrders(params) {
  return get('/api/sales-orders', params)
}

export function fetchSalesOrderStatusCounts(params) {
  return get('/api/sales-orders/status-counts', params)
}

export function saveSalesOrders(storeId, orders) {
  return post('/api/sales-orders/batch', { store_id: storeId, orders })
}

export function fetchSalesOrder(orderId, storeId) {
  return get(`/api/sales-orders/${orderId}`, { store_id: storeId })
}

export function updateBuyerInfo(storeId, orderId, buyerInfo) {
  return put(`/api/sales-orders/${orderId}/buyer-info`, {
    store_id: storeId,
    buyerName: buyerInfo.buyerName,
    buyerPhone: buyerInfo.buyerPhone,
    buyerAddress: buyerInfo.buyerAddress
  })
}

export function updateRemark(orderId, remark) {
  return put(`/api/sales-orders/${orderId}/remark`, { remark })
}

// 提交商家备注到京东平台
export function submitVendorRemark(storeId, orderId, remark) {
  return window.electronAPI.invoke('submit-vendor-remark', { storeId, orderId, remark })
}

// 更新订单的order_remark（平台同步的备注）到本地数据库
export function updateOrderRemark(orderId, orderRemark) {
  return put(`/api/sales-orders/${orderId}/order-remark`, { order_remark: orderRemark })
}

export function updateSalesOrderPurchaseStatus(orderId, purchaseStatus) {
  return put(`/api/sales-orders/${orderId}/purchase-status`, { purchase_status: purchaseStatus })
}

// 标记/取消标记问题事件
export function updateIssueEvent(orderId, issueEvent) {
  return put(`/api/sales-orders/${orderId}/issue-event`, { issueEvent })
}

// 检查买家是否在打假人库中（解密后二次比对：账号+地址）
export function checkFraudster(buyerAccount, orderId, buyerAddress) {
  return post('/api/fraudsters/check', { buyerAccount, orderId, buyerAddress })
}

// 批量检查买家账号（订单加载后自动比对）
export function batchCheckFraudsters(orders) {
  return post('/api/fraudsters/batch-check', { orders })
}

// 采购锁定：锁定销售订单防止多人同时采购
export function lockSalesOrderForPurchase(orderId) {
  return post(`/api/sales-orders/${orderId}/purchase-lock`)
}

// 采购解锁：取消或完成采购时解锁
export function unlockSalesOrderPurchase(orderId) {
  return del(`/api/sales-orders/${orderId}/purchase-lock`)
}

// 店铺销售统计
export function fetchStoreSalesStats(params) {
  return get('/api/store-sales-stats', params)
}

// 商品销售报表
export function fetchProductSalesStats(params) {
  return get('/api/product-sales-stats', params)
}
