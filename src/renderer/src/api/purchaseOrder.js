import { get, post, put } from './request'

// 创建采购单（生成采购编号，关联销售订单商品）
export function createPurchaseOrder(data) {
  return post('/api/purchase-orders', data)
}

// 绑定平台订单号到采购单
export function bindPlatformOrderNo(purchaseId, data) {
  return put(`/api/purchase-orders/${purchaseId}/bind`, data)
}

// 查询采购订单列表
export function fetchPurchaseOrders(params) {
  return get('/api/purchase-orders', params)
}

// 获取采购订单详情
export function fetchPurchaseOrder(id) {
  return get(`/api/purchase-orders/${id}`)
}

// 更新采购订单状态（如：确认入库）
export function updatePurchaseStatus(id, data) {
  return put(`/api/purchase-orders/${id}/status`, data)
}

// 更新采购订单信息
export function updatePurchaseOrder(id, data) {
  return put(`/api/purchase-orders/${id}`, data)
}

// 同步平台采购订单（通过cookie抓取并匹配）
export function syncPlatformOrders(data) {
  return post('/api/purchase-orders/sync', data)
}

// 同步单个采购订单的状态和物流（需要较长超时，淘宝API可能需要20秒）
export function syncSinglePurchaseOrder(data) {
  return post('/api/purchase-orders/sync-single', data, 30000)
}

// 获取下一个采购编号
export function fetchNextPurchaseNo() {
  return get('/api/purchase-orders/next-no')
}

// 查询物流轨迹
export function fetchLogisticsTracking(id) {
  return get(`/api/purchase-orders/${id}/logistics`)
}
