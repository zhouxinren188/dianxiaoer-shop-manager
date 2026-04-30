import { get, post } from './request'

export function fetchSalesOrders(params) {
  return get('/api/sales-orders', params)
}

export function saveSalesOrders(storeId, orders) {
  return post('/api/sales-orders/batch', { store_id: storeId, orders })
}

export function fetchSalesOrder(orderId, storeId) {
  return get(`/api/sales-orders/${orderId}`, { store_id: storeId })
}
