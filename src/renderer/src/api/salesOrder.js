import { get, post, put } from './request'

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

export function updateSalesOrderPurchaseStatus(orderId, purchaseStatus) {
  return put(`/api/sales-orders/${orderId}/purchase-status`, { purchase_status: purchaseStatus })
}
