import { get, post, put, del } from './request'

export function fetchWarehouses() {
  return get('/api/warehouses')
}

export function fetchWarehouse(id) {
  return get(`/api/warehouses/${id}`)
}

export function createWarehouse(data) {
  return post('/api/warehouses', data)
}

export function updateWarehouse(id, data) {
  return put(`/api/warehouses/${id}`, data)
}

export function deleteWarehouse(id) {
  return del(`/api/warehouses/${id}`)
}

// 库存列表
export function fetchInventoryList(params) {
  return get('/api/inventory', params)
}

// 创建库存项
export function createInventory(data) {
  return post('/api/inventory', data)
}

// 更新库存项
export function updateInventory(id, data) {
  return put(`/api/inventory/${id}`, data)
}

// 获取库存项绑定的销售商品
export function fetchBoundProducts(inventoryId) {
  return get(`/api/inventory/${inventoryId}/bound-products`)
}

// 搜索未绑定的销售 SKU
export function searchUnboundSalesSkus(params) {
  return get('/api/sales-skus/unbound', params)
}

// 库存搜索（绑定用）
export function searchInventory(params) {
  return get('/api/inventory/search', params)
}

// SKU绑定
export function createSkuBinding(data) {
  return post('/api/sku-bindings', data)
}

// SKU解绑
export function deleteSkuBinding(params) {
  return del('/api/sku-bindings', params)
}

// 快速新建库存并绑定
export function quickCreateInventory(data) {
  return post('/api/inventory/quick-create', data)
}
