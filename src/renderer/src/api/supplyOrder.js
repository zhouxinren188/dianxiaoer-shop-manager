import { get, post } from './request'

export function fetchSupplyOrders(params) {
  return get('/api/supply-orders', params)
}

export function saveSupplyOrders(storeId, orders) {
  return post('/api/supply-orders/batch', { store_id: storeId, orders })
}

export function fetchSupplyOrder(orderId, storeId) {
  return get(`/api/supply-orders/${orderId}`, { store_id: storeId })
}
