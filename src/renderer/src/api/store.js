import { get, getThroughMain, post, put, del } from './request'

export function fetchStores(params) {
  // 店铺管理是登录后的基础页面，固定走主进程代理，避免 renderer 网络状态、
  // CORS 或热更新切换造成“接口有店铺但页面显示 0 家”。
  return getThroughMain('/api/stores', params)
}

export function fetchStore(id) {
  return get(`/api/stores/${id}`)
}

export function createStore(data) {
  return post('/api/stores', data)
}

export function updateStore(id, data) {
  return put(`/api/stores/${id}`, data)
}

export function deleteStore(id) {
  return del(`/api/stores/${id}`)
}

export function deletePendingStore(id) {
  return del(`/api/stores/${id}/pending`)
}

export function updateStoreOnline(id, online) {
  return put(`/api/stores/${id}/status`, { online })
}

export function toggleStoreStatus(id, status) {
  return put(`/api/stores/${id}/toggle`, { status })
}

export function fetchStoreCookie(storeId) {
  return get(`/api/cookies/${storeId}`)
}

export function updateStoreSyncTime(storeId) {
  return put(`/api/stores/${storeId}/sync-time`)
}

export function fetchStoreTags() {
  return get('/api/store-tags')
}
